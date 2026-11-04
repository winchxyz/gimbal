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
- **No public port.** The engine's HTTP API listens on `127.0.0.1:8790` only and has no login: anyone who could
  reach it could close the pair or turn `auto` on. Do not add a public domain to the service. Reach it from
  inside the container with `railway ssh` (below).

## Set up

1. New project → Deploy from GitHub repo (or `railway up` from a clean checkout). Railway reads `railway.json`
   and builds the `Dockerfile`.
2. Settings → Region: EU West. Settings → Networking: no public domain.
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
   - `GIMBAL_RESCUE_FRESH=<contract>/<desk>` for the rescuer's first run (step 5).
5. Deploy. The log shows the start lines: mode, contract, which legs are live, which protections trade, the
   rescue routes, and `strategy: off` until the owner turns `auto` on.

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
