# Running the engine on Railway

The engine (`serve`) has to run without a break while a pair is open: it holds the pair, rescues a leg near
liquidation and, with `strategy.auto`, enters, exits and rotates. A laptop that sleeps or restarts for an update
leaves the pair unguarded, so the engine runs as one container on Railway. `Dockerfile` and `railway.json` at the
repo root are all it needs.

## What runs where

- **One service, one replica, one volume.** Railway never runs two deployments of a service with a volume at the
  same time, and a service with a volume cannot have replicas. That matters: two engines on one desk would send
  every order twice. The per-desk trader lock is a file, so it only stops a second engine on the same disk. After an
  OOM kill or a SIGKILL the lock stays on the volume naming pid 1. The running engine touches its lock every 30 s;
  the next container (pid 1 again) waits about 90 s after the last touch before it takes the lock over (and journals
  that), alert only meanwhile, so a restart never sticks on its own lock and an overlapping container never trades
  next to a live one. Expect the pair to go live about 90 s to 3 min after a kill (the start retries back off up to 60 s).
  **While the Railway engine runs, run nothing that trades this desk anywhere else**: no local `serve` with
  `GIMBAL_TRADE=1`, no `pair-mainnet --send`, no `fund.mjs --send`. Read-only commands are fine.
- **The volume is mounted on `/data`.** The image sets `XDG_STATE_HOME=/data` and `GIMBAL_STATE_DIR=/data/gimbal`:
  the trader state (the legs' baselines the ADL watch compares against), the confirmed engine rules
  (`PUT /strategy`), the strategy loop's counters and the locks all live there and survive a redeploy.
- **Region: EU West (Amsterdam).** Hyperliquid refuses US IP addresses.
- **Shutdown: `drainingSeconds` 180.** On SIGTERM serve starts nothing new and waits up to 180 s for an order, a
  close or a rescue already under way. Railway's default is 0 s, which would kill it mid-order.
- **The control API is never public.** The engine's HTTP API listens on `127.0.0.1:8790` only and has no login:
  anyone who could reach it could close the pair or turn `auto` on. Reach it from inside the container with
  `railway ssh` (below). Never point a domain, a TCP proxy or `GIMBAL_HOST` at it.
- **A public domain only for the read-only view.** The one port that may have a Railway public domain is the
  view's: a second listener, off by default, that serves the GET routes and the event stream behind a bearer token
  and refuses every write (below, "The read-only view"). No `GIMBAL_VIEW_TOKEN`, no public domain.

## Set up

1. New project → Deploy from GitHub repo (or `railway up` from a clean checkout). Railway reads `railway.json`
   and builds the `Dockerfile`.
2. Settings → Region: EU West. Settings → Networking: no public domain, unless the read-only view is set up
   (step 4 and "The read-only view"); then one domain, its target port the view's port and nothing else.
3. Add a volume to the service, mount path `/data`.
4. Variables (Raw Editor accepts a pasted env file). The names, values never in the repo:
   - from `.keys/engine-mainnet-<contract>.env` (written by `tools/mainnet/desk.mjs`): `GIMBAL_MODE`,
     `NEAR_NETWORK`, `GIMBAL_CONTRACT_ID`, `DESK_ID`, `OWNER_ACCOUNT_ID`, `OPERATOR_ACCOUNT_ID`,
     `OPERATOR_PRIVATE_KEY`, `OPERATOR_ALLOWANCE_NEAR`, `ORDERLY_BROKER_ID`, `HL_API_URL`, `ORDERLY_API_URL`,
     `PHOENIX_API_URL`, `SOLANA_RPC_URL`;
   - `ONECLICK_API_KEY` (rescues and transfers), `NEAR_AI_API_KEY` (the NEAR AI risk check; without it windows pass with
     "no NEAR AI risk check");
   - `GIMBAL_TRADE=1`, `GIMBAL_RESCUE=1`;
   - `GIMBAL_TRADER_FRESH=<contract>/<desk>` for the first start only when a pair is already open and its legs
     were checked on the venues (`docs/interfaces.md`, "The pair in serve"); remove it after that start;
   - optional, the read-only view: `GIMBAL_VIEW_TOKEN`, `GIMBAL_VIEW_PORT` (or Railway's own `PORT`),
     `GIMBAL_VIEW_ORIGINS` (below).
5. Deploy. The log shows the start lines: mode, contract, which legs are live, which protections trade, the
   rescue routes, `strategy: off` until the owner turns `auto` on, and `view: off` or
   `view: read-only on :<port> for origins ...`.

## Operate

```
railway ssh                                   # a shell in the running container
node -e "fetch('http://127.0.0.1:8790/state').then(r=>r.json()).then(s=>console.log(s.decision, s.desk?.health))"
node -e "fetch('http://127.0.0.1:8790/strategy').then(r=>r.json()).then(console.log)"
```

`PUT /strategy` with the same body and `"auto": true` turns the loop on; `POST /close` closes both legs. Both
need `content-type: application/json` and a localhost Host, which a request from inside the container has.

## The read-only view

For the dashboard on another machine (the demo video, the owner watching the desk), serve can open a second
listener, `engine/src/view/`. It is built on read functions only (`EngineServer.viewSource`), never on the control
server, so no request to it can reach `PUT /strategy`, `POST /rotate` or `POST /close`.

**Variables:**

| Name | What |
|---|---|
| `GIMBAL_VIEW_TOKEN` | The bearer token. Unset = the view is off. At least 32 characters, no whitespace: `openssl rand -hex 32`. Shorter, and the view stays off and says why. |
| `GIMBAL_VIEW_PORT` | The port it listens on, on `0.0.0.0`. Default: `PORT`, which Railway sets for the service. Must differ from `ENGINE_PORT` (8790). |
| `GIMBAL_VIEW_ORIGINS` | The dashboard origins allowed to call it from a browser, comma separated, e.g. `https://gimbal.example`: scheme, host and port only, no path, no `*`. A request with any other `Origin` is refused (403). Empty: no browser page can call it; `curl` still can. |

Then Settings → Networking → Generate Domain, with the target port set to the view's port. The start line reads
`view: read-only on :<port> for origins <list>`.

**What it serves:** `GET /state`, `/journal?before=`, `/strategy`, `/windows/history?id=` and `/events` (SSE), each
the same as the engine's, plus `GET /view-ticket` and an unauthenticated `GET /healthz` (`{ "ok": true }`). Any
other path is 404; any other method (PUT, POST, DELETE, ...) is 405, answered before the body is read.

**Auth:**

- `Authorization: Bearer <GIMBAL_VIEW_TOKEN>` on every route but `/healthz`, compared in constant time.
- `EventSource` cannot send headers, so `/events` also takes `?ticket=<t>`: `GET /view-ticket` (bearer) answers
  `{ "ticket", "expiresAt" }`, an HMAC under a key the engine makes at start, good for 30 s and for one connection.
  The token itself never goes in a URL; a ticket in an edge log is spent or expired by the time anyone reads it.
  A restart voids every ticket; the dashboard asks for a new one whenever it reconnects.
- A client with 10 failed tries in a minute gets 429 until the minute is over (the client is the last
  `X-Forwarded-For` entry, which Railway's proxy adds). Refusals are logged with method and path only, one line a
  minute per kind.

**Redaction:** every string in every payload is cut before it leaves: the value of every variable named
`…_KEY`, `…_SECRET`, `…_TOKEN` or `…PRIVATE…` (`OPERATOR_PRIVATE_KEY`, `RELAYER_EVM_PRIVATE_KEY`, `ONECLICK_API_KEY`,
`NEAR_AI_API_KEY`, `GIMBAL_VIEW_TOKEN`), the key-bearing parts of every URL in the environment (RPC URLs are shown as
their origin plus `/…`), NEAR ed25519 secret keys by shape, and `?api-key=`-style query values in any URL. None of
these is meant to be in the state, journal or events in the first place; a test greps the served payloads for each
value to prove they are not.

**If the view token leaks:** whoever has it can read what the dashboard shows, and nothing more: the desk's state
(legs, sizes, margins, P&L, health, the desk's venue addresses, which are public on chain anyway), the journal (every
entry, with its transaction links), the strategy rules (`auto`, the minimum net APR, leg size, leverage, rotation and
risk thresholds), the funding windows and the event stream. They cannot change the rules, enter, rotate, close or
move money, and they get no key. Rotate it: set a new `GIMBAL_VIEW_TOKEN` and redeploy (the engine restarts, which
the trader lock handles as above), or remove it to turn the view off.

## What the server holds, and what it cannot do

The service holds the engine's **operator key**, not the owner's key. On NEAR it is a FunctionCall access key on
the owner's account:

- it can call only the 21 operator methods of the Gimbal contract (`set_paused`, `fund_venue`, the venue order and
  signing methods, `panic_close`; the list `desk.mjs` prints when it adds the key), and nothing on any other
  contract;
- `withdraw_to_owner`, `set_policy`, `create_desk` and resuming a desk the owner paused are not on that list, so
  this key cannot call them;
- it can spend at most its allowance (5 NEAR on the mainnet desk) of the owner's NEAR on gas.

Every transfer the operator can start goes to the desk's own addresses only, and every order is held to the
policy: README "What cannot be stolen" lists each path and the contract check behind it. So a stolen operator key
can burn up to the allowance in gas and trade badly within the policy's caps, but it cannot send the desk's money
anywhere else. The 1Click and NEAR AI keys on the service are API keys for those services; neither can sign for
the desk.
