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
  `railway ssh` (below), or, with static outbound IPs on (where `railway ssh` does not work), through
  `GIMBAL_CONTROL` ("Control without a shell", below). Never point a domain, a TCP proxy or `GIMBAL_HOST` at it.
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

## Control without a shell (GIMBAL_CONTROL)

`railway ssh` does not work while the service has static outbound IPs, and those must stay on: Orderly takes the
desk key only from them. So `POST /rotate`, `POST /close` and `PUT /strategy` can be sent once through a variable
instead (`engine/src/cli/serve-control.ts`):

```
GIMBAL_CONTROL={"id":"<run-id>","method":"POST|PUT","path":"/rotate|/close|/strategy","body":{...},"until":"<ISO time>"}
```

Serve sends that request to its own loopback server, so the route's handler, its checks and its answer are the same
as for a request from inside the container. Nothing is added and nothing is skipped. Only `POST /rotate`, `POST /close`
and `PUT /strategy` are allowed; anything else is refused with a `control: refused: ...` line and nothing is called.
The run-id is letters, digits, `-` and `_`, up to 40 characters. Pick a new one for every action. `until` is
optional: an ISO time with a zone (`2026-11-06T18:00:00Z`). Past it the run is refused with no marker. Always set it a
few hours ahead: a variable left set then never acts on a later deploy, not even on a new volume with no markers.

What it does (every line starts with `control:`):

1. A marker `/data/gimbal/control-<run-id>.json` already exists: it logs what the marker says and does nothing. A
   run-id runs at most once, across restarts and redeploys. The marker keeps the request (method, path, body). If the
   variable now asks a **different** request under that run-id, the line reads
   `control: DIFFERENT request under used run-id <id>: NOT run. ...` and nothing runs: use a new run-id.
2. `POST /rotate` and `POST /close` need `GIMBAL_TRADE=1`. Without it the run is refused at once, with no marker, and
   the same run-id runs once `GIMBAL_TRADE=1` is back. Past `until`: refused, no marker.
3. It waits until the engine is ready, at most 10 min: the first scan, and for `/rotate` and `/close` also the
   pair's confirmed start and the strategy loop's first check of a scan (so `/rotate` sees the window and the free
   margin). The `waiting for ...` lines say what for. Past 10 min it writes the marker `failed` and calls nothing; that
   run-id is not tried again. `PUT /strategy` waits for the first scan only: it does not touch the pair, and restoring
   the rescue line must not hang on a pair whose start is not confirmed.

   `POST /rotate` then also waits, within the same 10 min, until its window is in the last scan and passes every
   check the request cannot waive: tradable, not refused, not stale, and every check ok, or with `demo` every check
   but the profit checks (a demo request never waits on those). Every restart, so every variable change, reads the
   funding history again, and for about its first minute a window fails `No 7-day funding history on both legs yet`:
   without this wait the call would race it. It is checked again after each scan and logs
   `control: waiting for <window id> to pass its checks (<the first failing check>)` each time the reason changes.
   Past 10 min it calls the route anyway (`... still does not pass its checks after 600 s ...: calling the route
   anyway`): the route's own `409` and its reason are what the log and the marker keep. A NEAR AI refusal is not
   waited on; the route answers it.
4. It logs the engine rules as `GET /strategy` answers them (`control: engine rules before the call ...`), then
   writes the marker `started`, created exclusively and fsynced.
5. It sends the request and logs the route's answer, and the marker becomes `done` with that status and body. A
   request that fails with no answer leaves `failed` (unknown outcome).
   - `PUT /strategy` answered `200` has taken effect (and is saved).
   - `POST /rotate` or `POST /close` answered `200 {"ok":true}` is only **accepted**: the line says
     `ACCEPTED, not yet carried out`. The act runs in the strategy loop after that, and its result is a
     `journal   enter: ...` / `journal   rotate: ...` / `journal   exit: ...` line, or `journal   error: ...` /
     `journal   refused: ...`. **Wait for that result line before any redeploy.**
   - `409` is the route's own refusal, for example `{"ok":false,"reason":"auto is off: ..."}`. The run-id is spent.

Serve's start does not wait for the run; serve's shutdown does (within the 180 s drain). A shutdown while it still
waits stops it with no marker, so the next start runs it. A marker that says `started` with no outcome (the
container died during the call) is logged as an unknown outcome and never run again: check the journal, the desk and
the engine rules before you pick a new run-id.

**Setting it.** Each `railway variable set` or `railway variable delete` redeploys the engine: a build, up to 180 s
of the old engine's drain, then 90 s to 3 min until the new one is live (above). Setting a new value over the old one
is one redeploy, so go from one action to the next by setting the next value. `railway variable set` has
`--skip-deploys`: use it on all but the last of several variables you change together, so they cost one redeploy.
`railway variable delete` has no such flag (CLI 5.71): it always redeploys. Piping the JSON with `--stdin` works the
same in bash and in every PowerShell, with no quoting to get wrong:

```
'{"id":"close-1","method":"POST","path":"/close","until":"2026-11-06T18:00:00Z"}' | railway variable set GIMBAL_CONTROL --stdin
```

(in bash, `echo '...' | railway variable set GIMBAL_CONTROL --stdin`). As an argument, single quotes work in bash
and PowerShell 7.3 or later: `railway variable set 'GIMBAL_CONTROL={"id":...}'`. Windows PowerShell 5.1 and
PowerShell 7.2 or older strip the double quotes from an argument to a native program, so there escape each one as
`\"` inside the single quotes. The service's Variables tab (Raw Editor) takes the JSON as is.

**Watching it.** `railway logs | grep control:` (bash) or `railway logs | Select-String 'control:'` (PowerShell).
The first line, `control: run <run-id>: POST /close ...`, echoes what serve read; `control: refused: GIMBAL_CONTROL
is not JSON` means the quotes were lost. Then `waiting for ...`, `engine rules before the call ...`,
`started: marker ...` and `done: ...` (or `failed: ...`). For the act's result, also watch `journal   ` lines; a
rescue shows as `rescue trigger ...` in the log and in full in the dashboard's Rescue view and Journal.

**At the end.** With `until` passed, a variable left set does nothing. Remove it with the next redeploy you make
anyway (`railway variable delete GIMBAL_CONTROL`, which redeploys).

**Window ids.** A window id is `<base>-<long venue>-<short venue>` in lower case: `eth-hyperliquid-phoenix` holds
ETH long on Hyperliquid and short on Phoenix. The log names them in the scan line
(`scan N: ... best <window id> 12.34 % net`, on the first scan and every 12th after, about once a minute) and in the
strategy loop's `decision  <action>: ...` and `journal   ...` lines. The dashboard's Windows view and the read-only
view's `GET /state` (`windows[].id`) list every window of the last scan. A rotate only takes a window in the last
scan.

### The routes

- **`POST /rotate {"windowId": ...}`, a manual enter.** It skips the entry streak (`enterAfterChecks`) and
  `minNetAprPct` and keeps every other check: the window must be in the last scan, tradable and not stale, pass its
  checks, not be held out by the NEAR AI risk check (a hold-out the loop's own auto acts set), be in a direction the
  pair trader opens, and size within the free margin and the policy. It is checked and sized again when it runs, and
  the NEAR AI risk check runs as for any enter; its prompt says the trade was asked by hand and the owner's minimum is
  waived, with no streak (an auto enter's prompt carries both). A risk check refusal holds a window out for 6 h only
  when the loop's own (auto) act asked it. On a manual `POST /rotate`, plain or demo, a refusal refuses that one
  request and sets no hold-out (its `veto` journal line and the window's verdict on the dashboard still read 6 h):
  rotate into another window, or ask again with a new request. With a pair held it closes that pair first. The route
  needs `auto` on and answers `409 auto is off` otherwise.
- **`POST /rotate {"windowId": ..., "demo": {"maxLossUsd": <USD>}}`, an owner demo entry.** As above, and it also
  waives the window's **profit checks** only: the owner minimum, a positive expected spread paying back the round trip,
  and break-even within a year. Every other check stays, and so does funding against the position: a window without
  7 days of funding history, whose 7- and 14-day spreads disagree, or whose expected spread over the hold is 0 or less
  is refused as without demo. `maxLossUsd` is required, above 0 and at most 1 USD, and the window's estimated round
  trip in USD (fees, slippage, basis buffer) must be known and at most `maxLossUsd`; the refusal says the number.
  `maxLossUsd` bounds that round-trip cost estimate only: funding during the hold is expected positive (the spread
  must be) and is not part of the bound. The pair trader checks both again on its own books. It opens
  from flat only (`POST /close` first). The NEAR AI risk check runs as for any manual enter, and its prompt says this
  is an owner-requested demonstration entry with the profit checks waived and the cost the owner accepted. The
  journal's `enter` line, the book and the risk ledger mark it as an owner demo entry (`demo: true`).
- **`POST /close`**: both legs, reduce-only. It works with `auto` on or off and answers `409 no pair is held` when
  there is none.
- **`PUT /strategy <the whole config>`**: every engine rule, the rescue and watch lines included (there is no
  separate risk route). Copy the last `control: engine rules before the call` line (every run logs it; also
  `GET /strategy` on the read-only view) and change only what you mean to. **Send every field**: a config without
  `enterAfterChecks` or `exitAfterChecks` resets them to 3 and 6, and any other missing field is refused (400).
  **It persists**: serve saves it in `/data/gimbal/strategy-mainnet-<desk>.json` before it takes effect, and every
  later start loads it, until another `PUT /strategy` changes it back. Deleting `GIMBAL_CONTROL` does not undo it.
  A `PUT` also runs a strategy check at once.

### The rescue line

The settings are `risk.rescueDistancePct` and `risk.watchDistancePct` (defaults 8 and 15; the route refuses
anything but `0 < rescueDistancePct < watchDistancePct < 100`). They apply to **every leg alike**: the engine has no
per-leg or per-venue line (`POST /stress`, which targets one leg, is refused on mainnet).

- A leg is in rescue when its distance to liquidation is under the rescue line, `max(rescueDistancePct, the
  volatility term)` (`engine/src/risk/thresholds.ts`). The risk engine reads the desk every 5 s.
- The rescue moves the margin that brings the leg back to its watch line, `max(watchDistancePct, rescue line +
  (watchDistancePct − rescueDistancePct))` (`marginToReach`, `engine/src/risk/margin.ts`). For one position on the
  account that is **amount ≈ (watch − live distance) / 100 × notional × (1 + maintenance fraction)**: on a 12 USD leg,
  each point of distance is about 0.12 USD.
- It pays from the reserve first (the desk's `idle_usdc` on NEAR, `fund_venue`), then from the free margin on the
  other leg's venue, else it reduces both legs (`engine/src/rescue/plan.ts`). A route whose fees would be over 10 %
  of what it sends is skipped, so each route has a smallest rescue. At the final policy, with a 1Click key:

  | Target leg on | Smallest rescue (margin the leg needs) | On a 12 USD leg |
  |---|---|---|
  | Hyperliquid | 2.86 USD (reserve or Phoenix → Hyperliquid) | watch ≈ 24 points above the live distance |
  | Phoenix | 0.44 USD (reserve → Phoenix) | watch ≈ 4 points above |
  | Orderly | any amount, but it sends at least 6.20 USD (under 5 USDC the Orderly receiver loses it) | — |

  Under the smallest amount, or over what is left of `rescue_cap_usd_per_hour`, the rescue **reduces both legs**
  instead of moving margin, and a reduce of a 12 USD leg can run into Hyperliquid's 10 USD order minimum. The
  `rescue routes` start lines say which routes run on this deployment.
- **Worked example**, a 12 USD Hyperliquid short at 3x, counted as if isolated (4 USD margin, maintenance about
  2 %): its distance is (4/12 − 0.02) / 1.02 ≈ 30.7 %. The desk's Hyperliquid account is cross margin: all its
  USDC backs the leg, so the live distance is higher than this whenever the account holds more than the leg's own
  margin, and each point then costs more. Use these numbers for the shape only and read both legs' live distances
  before you pick the lines. For at least 2.86 USD to move, the watch line must be at least about 54.1 %: with
  `"watchDistancePct":56` the rescue moves (0.56 × 1.02 + 0.02 − 0.333) × 12 ≈ 3.10 USD (it sends about 3.45 with
  1Click's fee and slippage room). With the old rule of thumb, watch 36 against 30 %, it would be about 0.72 USD:
  under the minimum, so it would reduce both legs instead.

**Both legs.** A hedged pair at equal leverage has both legs at nearly the same distance: the 3x Phoenix long next
to that short sits near (4/12 − m) / (1 − m) ≈ 32 %, about one point away. Both legs fire when both are under the
line, nearest first, and a rescue paid from the other leg's free margin lowers that leg's distance by about the
amount ÷ its notional (≈ 25 points here), which puts it under the line too: the two legs then rescue each other in
turn. So:

- Put `rescueDistancePct` **between** the two legs' distances, so only the target leg is under it, with at least
  1.5 points to the other leg (1 point of hysteresis plus a few seconds of price move). Read both from the
  `monitor   <venue> <symbol> ... D % from liquidation` lines (every 30 min) or the dashboard's Desk, right before.
- Have the reserve cover the whole rescue (the amount plus about 0.5 USD of fees and slippage room), so the plan pays from NEAR and never
  takes the other leg's margin.
- **If the legs are less than about 2 points apart, the demo cannot be done safely**: no single line puts one leg
  under and the other above, and the engine has no per-leg line. A price move separates them (a 2 % move shifts each
  by about 2 points, in opposite directions); wait for that, with the nearer leg being the one you mean to rescue.

**The restore window.** The restore is a redeploy too: it applies only after the build, the old engine's drain (up
to 180 s) and the new engine's first scan. Until then the raised line is live, and the new engine does not remember
the old one's rescue. So:

- Restore only after the rescue's **end**, whatever it is: `rescue <id> landed in N s`, a reduce, or a failure
  (`rescue <id> failed at <step>: ...` in the log; all of them in the Rescue view and Journal).
- The residual risk, stated plainly: from the new engine's first desk read until the restore takes effect (the first
  scan, usually seconds), any leg still under the raised line (the target after a reduce or a failure, or the other
  leg if it paid) gets a new rescue, against the reserve, the hourly cap and its fees. Restoring sooner does not
  shorten this. Check on the Desk that every leg is above the raised rescue line before you set the restore; if one
  is not, expect one more rescue.

### The demo sequence

Run each step only after the previous one's result line. Every body is an example: build each from the rules the
log printed. `<rules>` below stands for every field of that line, with the changes listed.

1. **Demo rules** (`PUT /strategy`): `auto` true, `minNetAprPct` 1000 (the loop then enters nothing under 1000 % net
   by itself, which in practice is nothing; step 2's `/rotate` with `demo` waives it), `rotate.minGainPts` 1000 (no rotation by itself), `exitAfterChecks` 24, and
   `legUsd` the size you want. With `auto` true and this minimum the held pair counts as compressed at every hourly
   check, so the loop exits it by itself after 24 hourly checks: finish the demo within a day. The drawdown and time
   stops still act. Without the high minimum, the check a `PUT` runs at once could enter the top window by itself
   before your `/rotate` (paying fees twice), and re-enter after your `/close` once the 6 h cooldown is over.

   ```
   '{"id":"demo-rules","method":"PUT","path":"/strategy","until":"2026-11-06T18:00:00Z","body":{"auto":true,"minNetAprPct":1000,"legUsd":12,"maxLeverage":3,"stopDrawdownPct":10,"rotate":{"minGainPts":1000,"forHours":4},"risk":{"watchDistancePct":15,"rescueDistancePct":8},"enterAfterChecks":3,"exitAfterChecks":24}}' | railway variable set GIMBAL_CONTROL --stdin
   ```

   Wait for `control: done: PUT /strategy answered 200`. Keep its `engine rules before the call` line: it holds your
   own rules for step 6.
2. **Enter** (`POST /rotate` with `demo`). Pick the window and a backup from the scan lines or the Windows view
   first. The body carries `"demo":{"maxLossUsd":0.25}`: under the step 1 rules every window fails its profit checks
   (nothing earns 1000 % net), so a plain `/rotate` is refused with `fails a check`. The demo flag waives those profit
   checks only; the safety checks (tradable, not stale, not refused, the risk check, the policy, the size, and a
   positive spread over at least 7 days of history) all stay, so pick a window whose 7-day spread pays in its
   direction. `maxLossUsd` bounds the estimated round-trip cost, at most 1 USD; a 12 USD ZEC Orderly/Hyperliquid leg
   costs about 0.04 USD. Funding during the hold is expected positive and is not part of that bound. Wait for `journal   enter: enter <window id>, ...; owner demo entry: ...` (or `error` / `refused`). A
   `veto` / `refused ... NEAR AI risk check` line means the model refused that window: send the same step with the
   backup window. **Every attempt needs a new run-id**, a refused one included: a used run-id never runs again.

   ```
   '{"id":"demo-enter","method":"POST","path":"/rotate","until":"2026-11-06T18:00:00Z","body":{"windowId":"eth-phoenix-hyperliquid","demo":{"maxLossUsd":0.25}}}' | railway variable set GIMBAL_CONTROL --stdin
   '{"id":"demo-enter-2","method":"POST","path":"/rotate","until":"2026-11-06T18:00:00Z","body":{"windowId":"sol-phoenix-hyperliquid","demo":{"maxLossUsd":0.25}}}' | railway variable set GIMBAL_CONTROL --stdin
   ```

   (the second line only after a refusal of the first). The held demo pair then counts as compressed at every hourly
   check under the 1000 % minimum and the loop exits it by itself at the 24th hourly check in a row, about a day
   after the entry (no rotation: nothing gains 1000 points); the drawdown and time stops still act.

3. **Raise the rescue line** (`PUT /strategy`, the step 1 rules with the new `risk`), once the legs are far enough
   apart and the reserve covers the rescue (above). For a 12 USD Hyperliquid short that reads 30.7 % live, with the
   long at 33 % or more: `"risk":{"watchDistancePct":56,"rescueDistancePct":31.5}`. Wait for the rescue's end line.
4. **Restore** (`PUT /strategy`, the step 1 rules as they were: `"risk":{"watchDistancePct":15,"rescueDistancePct":8}`),
   set straight over step 3. Wait for `control: done: PUT /strategy answered 200`.
5. **Close** (`POST /close`). Wait for `journal   exit: exit <window id>: ...`.
6. **Your own rules back, `auto` off** (`PUT /strategy` with the rules from step 1's `engine rules before the call`
   line and `"auto":false`). Wait for `control: done: PUT /strategy answered 200`.

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
