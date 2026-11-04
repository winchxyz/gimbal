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
  (`PUT /strategy`), the strategy loop's counters, the journal (`journal-mainnet-<contract>-<desk>.jsonl`, the newest
  5 000 entries within 30 days) and the locks all live there and survive a redeploy.
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
4. Variables (Raw Editor accepts a pasted env file). The names, values never in the repo. Each variable is its own
   `NAME=value` line; check that every value sits under its own name (a value pasted under the wrong name is a common
   mistake). Most such mistakes do not stop serve, they quietly turn a part off:
   - `GIMBAL_TRADE` and `GIMBAL_RESCUE` act only when the value is exactly `1`: anything else (a key pasted there)
     leaves the pair alert only and the rescue detect only, and the start lines say so
     (`rescue: detect only on mainnet ...`);
   - an `OPERATOR_PRIVATE_KEY` that is not an `ed25519:` key keeps the pair alert only (its NEAR start read fails
     and is retried) and the rescue detect only (its live start retried in the background);
   - a `RELAYER_EVM_PRIVATE_KEY` that is not `0x` + 64 hex keeps the rescue detect only the same way;
   - a `GIMBAL_TRADER_FRESH` or `GIMBAL_RESCUE_FRESH` that does not name this contract and desk exactly is ignored,
     with a start line;
   - an empty value counts as not set.

   Read the start lines after every deploy. The variables:
   - from `.keys/engine-mainnet-<contract>.env` (written by `tools/mainnet/desk.mjs`): `GIMBAL_MODE`,
     `NEAR_NETWORK`, `GIMBAL_CONTRACT_ID`, `DESK_ID`, `OWNER_ACCOUNT_ID`, `OPERATOR_ACCOUNT_ID`,
     `OPERATOR_PRIVATE_KEY`, `OPERATOR_ALLOWANCE_NEAR`, `ORDERLY_BROKER_ID`, `HL_API_URL`, `ORDERLY_API_URL`,
     `PHOENIX_API_URL`, `SOLANA_RPC_URL`;
   - `ONECLICK_API_KEY` (rescues and transfers), `NEAR_AI_API_KEY` (the NEAR AI risk check; without it windows pass with
     "no NEAR AI risk check");
   - `GIMBAL_TRADE=1`, `GIMBAL_RESCUE=1`;
   - `RELAYER_EVM_PRIVATE_KEY`, required with `GIMBAL_RESCUE=1`: the Arbitrum gas wallet that submits
     `evm_usdc_to_intents`; without it serve exits at start with a configuration error;
   - `ARBITRUM_RPC_URL` (optional): the Arbitrum RPC the rescue uses; without it, viem's public Arbitrum One RPC;
   - `GIMBAL_TRADER_FRESH=<contract>/<desk>` on the first start whenever the volume holds no trader state file yet,
     even with both legs flat: a missing file is not a fresh start, so without it the pair stays alert only and the
     strategy loop gets no hands (it can never open). Check both legs on the venues first (`docs/interfaces.md`,
     "The pair in serve"); remove it after that start (a later start restores the file and ignores it);
   - `GIMBAL_RESCUE_FRESH=<contract>/<desk>` for the rescuer's first run (step 5);
   - optional, the read-only view: `GIMBAL_VIEW_TOKEN`, `GIMBAL_VIEW_PORT` (or Railway's own `PORT`),
     `GIMBAL_VIEW_ORIGINS` (below).
5. Deploy. The log shows the start lines: mode, contract, which legs are live, which protections trade, the
   rescue routes, `strategy: off` until the owner turns `auto` on, and `view: off` or
   `view: read-only on :<port> for origins ...`.

   **The rescuer's first run.** With no rescuer state file on the volume (`/data/gimbal/rescue-mainnet-<contract>-<desk>-<evm>.json`)
   the start line says `rescuer state missing`: every rescue transfer is held and only reduces run. A missing file is
   never taken as a first run, so the first run is asked for with `GIMBAL_RESCUE_FRESH=<contract>/<desk>`:
   - the first start with it, on a volume with no trace of this desk's rescuers, is refused once by design: it writes
     the marker `rescue-mainnet-<contract>-<desk>.fresh` next to where the state file goes and logs
     `GIMBAL_RESCUE_FRESH is refused: ... start again with GIMBAL_RESCUE_FRESH=<contract>/<desk> after <time>`
     (65 min later; a NEAR call of a rescuer that ran elsewhere may still land until then). Serve keeps running,
     transfers still held. Run no other rescuer of this desk anywhere meanwhile;
   - it is also refused while the contract counted a rescue or a `fund_venue` of this desk in the last 65 min, while
     the desk's counters on NEAR cannot be read, or while any file of this desk's rescuers in that directory is under
     65 min old; the log line says which, and when to try again;
   - after the time in that line, redeploy (or restart) with the variable still set: the rescuer writes an empty
     state file (`rescuer first run (GIMBAL_RESCUE_FRESH)`), removes the marker, and counts the rescue cap as used in
     full for its first hour;
   - then remove `GIMBAL_RESCUE_FRESH`. Over an existing state file it is ignored anyway (the start line says so).

## Operate

```
railway ssh                                   # a shell in the running container
node -e "fetch('http://127.0.0.1:8790/state').then(r=>r.json()).then(s=>console.log(s.decision, s.desk?.health))"
node -e "fetch('http://127.0.0.1:8790/strategy').then(r=>r.json()).then(console.log)"
```

`PUT /strategy` with the same body and `"auto": true` turns the loop on; `POST /close` closes both legs. Both
need `content-type: application/json` and a localhost Host, which a request from inside the container has.

### Rolling back past #106

#106 made `enterAfterChecks` and `exitAfterChecks` strategy settings. Every `PUT /strategy` after it saves both
fields in `/data/gimbal/strategy-mainnet-<desk>.json`. Code from before #106 refuses unknown strategy fields, so it
cannot load that file. That code then starts with auto off. On a held pair, decide() answers `off` before the
drawdown stop and the time stop, so neither stop protects the pair.

Before you deploy code older than #106, delete the two keys in the running container:

```
railway ssh
node -e "const fs=require('fs');for(const f of fs.readdirSync('/data/gimbal').filter((n)=>/^strategy-mainnet-.*\.json$/.test(n))){const p='/data/gimbal/'+f;const s=JSON.parse(fs.readFileSync(p,'utf8'));delete s.enterAfterChecks;delete s.exitAfterChecks;fs.writeFileSync(p,JSON.stringify(s));console.log('cleaned',p)}"
```

Then deploy, and make no `PUT /strategy` in between. After the deploy, the log must read
`engine rules from /data/gimbal/strategy-mainnet-<desk>.json`, not `engine rules not loaded, starting from the
defaults (auto off): ...`. `GET /strategy` must also show the auto you expect. The older code runs on its own fixed
counts (enter 3, exit 3).

## Bringing USDC back from Orderly

Once the desk's Orderly key is limited to the engine's static IPs (`set_orderly_ips`, then the `ip_restriction`),
Orderly takes the key only from this service. No laptop can post a withdrawal, `railway ssh` does not work with
static IPs, and the control routes are loopback only. So the engine runs the withdrawal itself, once, when two
variables are set. The USDC goes to the desk's own EVM address on Arbitrum. The contract signs no other
receiver. From there the laptop brings it to NEAR and pays the owner.

**What it does.** The run starts when serve starts with `GIMBAL_SETUP=1` and
`GIMBAL_ORDERLY_WITHDRAW=<contract>/<desk>/<amount USDC | all>/<run-id>` (`engine/src/setup/orderly-withdraw.ts`). It
runs in the background, so serve's start does not wait for it. Serve's shutdown does wait for it (within the 180 s
drain). Every line starts with `orderly withdraw:`:

1. A marker `/data/gimbal/orderly-withdraw-<contract>-<desk>-<run-id>.json` (in `GIMBAL_STATE_DIR`) already
   exists: it logs what the marker says and does nothing. A run-id runs at most once, across restarts.
2. No trading loop: with `GIMBAL_TRADE=1` and `auto` on, the strategy loop could open an Orderly leg between the
   flat check and the withdrawal, so the run refuses. `auto` cannot be turned off from outside the container (PUT
   /strategy is loopback only), so unset `GIMBAL_TRADE` for the withdrawal instead. `get_desk`: the contract and desk must be the engine's own (`GIMBAL_CONTRACT_ID`,
   `DESK_ID`), and the operator key must act for the desk. A paused or closing desk is refused: the operator's
   `orderly_withdraw` needs a running desk.
3. The checks:
   - The amount must be at least the operator's minimum, max(10 × `max_transfer_cost_flat_e6`, 10 USDC). The
     refusal names the minimum.
   - `get_desk_counters`: the amount must fit what is left of the hourly rescue cap, and Orderly's 1 USDC fee what
     is left of the hourly cost budget.
   - Two signed reads. Every Orderly position must be flat. The amount must be at most what can leave Orderly after
     `settle_pnl`: holding − frozen, less any unsettled loss, and at most Orderly's `free_collateral`. With `all`,
     the amount is exactly that.
4. The trading loop is checked again. Then it writes the marker `started` (amount, desk EVM, time), created exclusively and
   fsynced.
5. It runs `settle_pnl`, then `withdraw_request` (`OrderlyDeskClient.withdraw`).
6. It writes the marker `done` with the report (settle and withdraw answers, the NEAR transactions), or `failed`
   with the error and what Orderly got.

A refusal in steps 1 to 4 writes no marker, except when another run of the same run-id holds it. Fix the cause and
restart, and the same run-id runs. A shutdown before step 4 stops the run the same way. Nothing is ever retried by
itself. A failed run tells you what Orderly got:

- `never went to Orderly`: for example the contract refused `orderly_withdraw` (`E_RESCUE_CAP`). No USDC left
  Orderly, and a new run-id may try again.
- `Orderly rejected the withdraw_request`: a definite refusal. Nothing left Orderly, and a new run-id may try again.
- `no definite answer`, or a marker that says `started` with no outcome (the container died in step 5): the log
  reads `unknown outcome, check the desk EVM on Arbitrum and nearblocks; set a new run-id only after checking`.
  Wait about 30 min. Then look at the desk EVM's USDC on arbiscan and the desk's `orderly_withdraw` calls on
  nearblocks before you choose a new run-id.

**Before you start.**

- The desk must be running, not paused, and every Orderly position flat.
- `GIMBAL_TRADE` must be unset for the withdrawal (step 1), unless the engine's `auto` is off. With the trade loop
  off nothing can open in the window. The pair is alert only meanwhile: the engine does not close or unwind it, so
  keep the window short and set `GIMBAL_TRADE=1` back right after (step 3).
- Orderly's 1 USDC fee comes out of the amount: a withdrawal of 100 delivers 99. So at least 10 USDC on Orderly is
  enough for this path (at the default flat bound).
- Withdraw everything in one run: use `all`. Anything under the operator's minimum (10 USDC) left on Orderly is
  stuck behind the owner's path, and that path too works only from the engine's IPs. The `checks passed` line says
  how much stays, and warns when it is under the minimum.
- The amount counts against `rescue_cap_usd_per_hour`, and Orderly's 1 USDC fee counts against the hourly rescue
  cost budget. A rescue in the last hour uses both. The run reads what is left and refuses before signing when it is
  short.

**A paused desk.** Unpause it first, with `GIMBAL_TRADE` unset so nothing opens. The owner calls `set_paused(<desk>, false)` with exactly 1 yoctoNEAR from their own wallet, since
the operator key cannot unpause. Then run the steps below.

**Steps** (the owner runs each command):

1. Unset `GIMBAL_TRADE`, then set both variables. Each change redeploys the engine, which takes about 90 s to 3 min
   to go live again (above):

   ```
   railway variable delete GIMBAL_TRADE
   railway variable set GIMBAL_SETUP=1 GIMBAL_ORDERLY_WITHDRAW=gimbal_dex.near/carry/all/2026-11-05a
   ```

   Pick a new run-id for every withdrawal: letters, digits, `-` and `_`, up to 40 characters. The amount is `all`
   or USDC with at most 6 decimals.
2. Watch `railway logs` for the `orderly withdraw:` lines: `run ...: ... checking`, `desk ... is running`,
   `checks passed: ...`, `started: marker ...`, then `done: ...` or `failed: ...` (or one `refused: ...`). The run
   takes about a minute: 8 operator calls on NEAR at about 6 s each, plus Orderly. Do not redeploy before the
   `done` or `failed` line. A container killed in step 5 leaves `started`, an unknown outcome.
3. Remove both variables, one key per call (each call redeploys), or in the service's Variables tab, and set
   `GIMBAL_TRADE` back:

   ```
   railway variable delete GIMBAL_ORDERLY_WITHDRAW
   railway variable delete GIMBAL_SETUP
   railway variable set GIMBAL_TRADE=1
   ```

   Left set, they do nothing more for a run-id that has a marker, but `GIMBAL_SETUP=1` keeps the operator key's
   signing part of serve on.
4. On the laptop, once the USDC is on Arbitrum (the amount less Orderly's 1 USDC; small amounts take about a minute),
   bring it to the contract. Do a dry run first:

   ```
   node tools/mainnet/hl-return.mjs gimbal_dex.near carry bridge all
   node tools/mainnet/hl-return.mjs gimbal_dex.near carry bridge all --send
   ```

   The bridge counts against the same hourly cap. If the withdrawal plus the bridge are over it, the dry run says
   so: bridge an hour later, or in parts. Its lock check sees only rescuers on the laptop, not the one on
   Railway. Both use the desk's EIP-3009 counter and Arbitrum USDC, so make sure no rescue is under way in
   `railway logs`.
5. Pay the owner from `idle_usdc`:

   ```
   node tools/mainnet/withdraw.mjs gimbal_dex.near carry all
   node tools/mainnet/withdraw.mjs gimbal_dex.near carry all --key-file <owner key json> --send
   ```

**Costs.**

- Orderly's 1 USDC fee per withdrawal, taken out of the amount (about the amount − 1 USDC lands on Arbitrum), gone
  for good.
- NEAR gas for 8 operator calls (2 reads, settle and withdraw), about 0.001 NEAR each. 0.3 NEAR of the key's
  allowance is held while each call is in flight.
- The 1Click fee on the bridge, at most `amountIn` − `minAmountOut`, shown by the dry run.
- The relayer's Arbitrum gas for one transfer.
- NEAR gas for `withdraw.mjs`, and the treasury's fee when there is profit (its dry run shows the split).

**What cannot be undone.**

- Once Orderly accepts `withdraw_request`, the USDC leaves Orderly for the desk EVM on Arbitrum. It cannot be
  cancelled, but it stays the desk's money.
- Once the bridge's authorization is used, the USDC is with 1Click. A failed swap is refunded to the desk EVM on
  Arbitrum.
- `withdraw.mjs --send` pays the owner and is final.
- `settle_pnl` only books profit and loss inside the Orderly account.

## The read-only view

For the dashboard on another machine (the demo video, the owner watching the desk), serve can open a second
listener, `engine/src/view/`. It is built on read functions only (`EngineServer.viewSource`), never on the control
server, so no request to it can reach `PUT /strategy`, `POST /rotate` or `POST /close`.

**Variables:**

| Name | What |
|---|---|
| `GIMBAL_VIEW_TOKEN` | The bearer token. Unset = the view is off. At least 32 characters, no whitespace, and not guessable: 16 distinct characters or about 128 bits by the characters' own frequencies, no repeated piece (`abcabc…`) and no run of 6 in sequence (`012345`, `zyxwvu`). It is the only guard against guessing, so make it with `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, never by hand. Otherwise the view stays off and says why. |
| `GIMBAL_VIEW_PORT` | The port it listens on, on `0.0.0.0`. Default: `PORT`, which Railway sets for the service. Must differ from `ENGINE_PORT` (8790). |
| `GIMBAL_VIEW_ORIGINS` | The dashboard origins allowed to call it from a browser, comma separated, e.g. `https://gimbal.example`: scheme, host and port only, no path, no `*`. A request with any other `Origin` is refused (403). Empty: no browser page can call it; `curl` still can. |

Then Settings → Networking → Generate Domain, with the target port set to the view's port. The start line reads
`view: read-only on :<port> for origins <list>`. The view starts only while the control API is on loopback (the
default `GIMBAL_HOST`): with the engine on `0.0.0.0`, port 8790 would answer on Railway's private network, where a
request with `Host: localhost` passes its checks, so serve logs `view: off: the control API is not on loopback`.

**What it serves:** `GET /state`, `/journal?before=`, `/strategy`, `/windows/history?id=` and `/events` (SSE), each
the same as the engine's, plus `GET /view-ticket` and an unauthenticated `GET /healthz` (`{ "ok": true }`). Any
other path is 404; any other method (PUT, POST, DELETE, ...) is 405, answered before the body is read.

**Auth:**

- `Authorization: Bearer <GIMBAL_VIEW_TOKEN>` on every route but `/healthz`, compared in constant time.
- `EventSource` cannot send headers, so `/events` also takes `?ticket=<t>`: `GET /view-ticket` (bearer) answers
  `{ "ticket", "expiresAt" }`, an HMAC under a key the engine makes at start, good for 30 s and for one connection.
  The token itself never goes in a URL; a ticket in an edge log is spent or expired by the time anyone reads it.
  A restart voids every ticket; the dashboard asks for a new one whenever it reconnects. At most 8 tickets are
  outstanding: a new one retires the oldest, so someone asking for tickets can never lock the owner out.
- The credentials are checked first, and a right token or ticket is always served. A client with 10 failed tries
  in a minute gets 429 instead of 401 on each further failure until the minute is over. The client is the last
  `X-Forwarded-For` entry: that assumes exactly one proxy appends to the header in front of the view (Railway's
  edge). Behind a second proxy, the last entry would be that proxy and all its clients would share one budget.
  Refusals are logged with method and path only, one line a minute per kind.
- No client can hold the engine's shutdown: a request has 10 s to arrive in full (headers and body; a stream's
  response may then run on), and on SIGTERM the view closes every connection and is done within 3 s.

**Redaction:** every string in every payload is cut before it leaves:

- the value of every variable named `…_KEY`, `…_SECRET`, `…_TOKEN` or `…PRIVATE…` (`OPERATOR_PRIVATE_KEY`,
  `RELAYER_EVM_PRIVATE_KEY`, `ONECLICK_API_KEY`, `NEAR_AI_API_KEY`, `GIMBAL_VIEW_TOKEN`), also without an
  `ed25519:` prefix, a hex key with or without `0x` in any case, and each URL-encoded or JSON-escaped;
- the key-bearing parts of every URL in the environment (RPC URLs are shown as their origin plus `/…`);
- by shape: `ed25519:` with 43 or more base58 characters (secret keys, seeds, and public keys too), and
  `?api-key=`-style query values in any URL.

None of these is meant to be in the state, journal or events in the first place; a test greps the served
payloads, as sent and as decoded, for each value and each variant to prove they are not.

**Masked accounts:** the owner's and the operator's NEAR accounts (`OWNER_ACCOUNT_ID`, `OPERATOR_ACCOUNT_ID`) and
any 64-hex implicit account are shown as their first 4 and last 4 characters (`gimb…near`) wherever they stand as a
whole account id: `desk.owner`, `desk.paused.by`, journal and decision text, explorer URLs that name an account. The
contract id (even a sub-account of the owner) and the desk id stay as they are, and so do transaction hashes and
their explorer links: they are the proof of what the desk did.

**If the view token leaks,** whoever has it can read exactly what the dashboard shows, and nothing more:

- the mode, and the funding windows: every window's rates, costs, net APR, depth, checks, NEAR AI verdict and
  hourly history, and the scan status;
- the desk (`DeskState`): desk id, contract id, the masked owner, every leg (venue, symbol, side, size, entry,
  mark, liquidation price, margin, margin ratio, distance to liquidation, funding, fees), net delta, equity,
  reserve, P&L, health, paused (masked account and time), a rescue failure's reason;
- the journal, every entry still in memory (up to 5 000, loaded from the volume at start): its summary, the NEAR AI text, its numbers, and its
  transaction links, which name the desk's own venue addresses (EVM, Solana) as any block explorer does;
- rescue and venue-setup progress (amounts, steps, transaction links), the venue health map, and the strategy
  loop's latest decision;
- the strategy rules (`auto`, the minimum net APR, leg size, leverage, stop drawdown, rotation and risk thresholds);
- the live event stream of all of the above.

They cannot change the rules, enter, rotate, close, stress or move money, they get no key, and they cannot read
the owner's or the operator's account in full. Rotate it: set a new `GIMBAL_VIEW_TOKEN` and redeploy (the engine
restarts, which the trader lock handles as above), or remove it to turn the view off.

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
