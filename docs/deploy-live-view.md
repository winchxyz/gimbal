# The public live view on Railway

The public site (https://gimbal-production-1b10.up.railway.app) shows the **real mainnet desk, read-only**: the live
engine that trades on Railway (docs/deploy-railway.md), as its own dashboard shows it, for anyone with a browser and
nothing to enter. It used to show the hosted replay (docs/deploy-replay.md); the replay stays available, locally with
`npm run demo` or as an optional service of its own, but it is no longer what the public URL serves.

When the desk holds no pair, the site shows a flat desk (no legs, the reserve, the realized P&L so far), the
strategy's latest decision ("waiting for ...") and the scanner's funding windows. That is the truth: the engine only
enters when a window clears the owner's minimum and the checks pass. The page never makes up activity.

## What runs

`node engine/src/cli/live-host.ts` (the public service's Custom Start Command), on one public port, `$PORT` (default
8080):

- the dashboard (`web/dist-live`), built with `VITE_HOSTED_LIVE=1` into a folder of its own, so it and the replay's
  `web/dist` never overwrite each other. The live image has neither, so on every container start the host builds it
  once (about a second; the log says `web/dist-live is missing: building the hosted-live dashboard once`), then
  serves. The build gets neither the token nor the engine address;
- a read-only proxy, on the same origin, to the live engine's **read-only view** (`engine/src/view/`, docs/deploy-railway.md
  "The read-only view"): `GIMBAL_LIVE_URL` is the view's public address, `GIMBAL_VIEW_TOKEN` its bearer token. The
  host adds the token to its own requests, server-side. It is never sent to a browser, never put in a URL, a response
  or a log line (tests check each);
- `GET /healthz`: 200 once the host listens, with the upstream's state:
  `{"ok":true,"live":"connected"|"connecting"|"down"|"not-configured","visitors":N}`.

Without `GIMBAL_LIVE_URL` or `GIMBAL_VIEW_TOKEN` the host still serves the page, and the page says **Live engine not
configured** ("This site is not connected to the live engine yet ..., so there is no desk to show"). The log says
`live engine not configured: GIMBAL_LIVE_URL and GIMBAL_VIEW_TOKEN are not set` (variable names only).

## Read-only for visitors

- **The page.** The hosted-live build opens straight into the live view: no Settings step, and an engine address a
  visitor once saved in Settings is ignored. Under the header one line says what the engine itself reports: on
  mainnet "Live mainnet desk, read-only: the real desk as it trades now. Nothing on this page can change it. For the
  recorded replay, run npm run demo." (An engine in replay mode would be labelled "Replay, read-only ... It is not the
  live desk"; live data is never called a replay, nor a replay live.) Every control that acts is left out, as in the
  remote read-only mode: Close position, rotate, Run a stress test, the owner's status buttons (auto, pause, resume,
  add margin), Add funds, Withdraw, Connect wallet and the set-up flow (which shows "Read-only view. This page shows
  the desk and cannot change anything on it."). The page's API refuses those calls itself, without a request.
- **The host.** Only these reach the engine, and only as GET: `/state`, `/strategy`, `/journal?before=<id>`,
  `/windows/history?id=<id>`, `/events`. The host builds each request itself: the path, the one query parameter that
  route takes (checked, then encoded again), `accept` and its own `authorization`. No visitor header (cookie,
  authorization, origin, referer, forwarded-for) and no other query parameter is forwarded. Every other method is
  refused at the host, before the body is read, and never forwarded: `POST /rotate`, `/close`, `/stress`, `/pause`,
  `/resume`, `/setup`, `/policy/draft`, `PUT /strategy` and the rest answer 403 ("This is the public view of the
  live mainnet desk, and it is read-only ..."); writes to any other path 405. A GET of any other API path
  (`/policy`, `/setup`, `/view-ticket`, `/rotate`, ...) is 404 at the host. Static files are `/` and the files of
  `web/dist-live`; anything else 404.
- **The engine.** Its view answers GET only, built on read functions (no route there can reach the control API), so
  even a forwarded write would be refused there too.

## Protecting the live engine from public traffic

- **One upstream stream.** The host keeps ONE `/events` connection to the engine and fans it out to every visitor;
  each event is shaped, cut and encoded once, and the same bytes go to every visitor. A new visitor's stream starts
  with the latest of each type (scan, windows, desk, health, setup, rescue, decision) from the host's memory, then
  follows the live events. Visitor streams are capped at 300 in all (503; the page retries) and 16 per client address
  (429). The address is the replay host's rule (`X-Real-IP`, which Railway's edge sets, else the last
  `X-Forwarded-For` entry, else the socket), with an IPv6 address taken as its /64 (one home or phone gets a whole
  /64, so picking another address in it does not open more streams) and an IPv4-mapped one as its IPv4.
- **Slow readers.** A visitor that leaves more than 512 KiB unread (a few of the largest events, the windows list) is
  dropped; its page reconnects and reads `/state` again. All visitors together may leave at most 32 MiB unread: past
  that the one holding most is dropped first, then the next, until the total is under it. So slow readers can park at
  most 32 MiB in the host, however many there are.
- **Reconnect with backoff.** When the upstream stream ends (an engine deploy, a network blip, no byte for 45 s while
  the engine pings every 15 s), every visitor stream ends too, so each page reconnects and reads `/state` again
  (nothing is missed); while the engine is down a visitor's `/events` is answered 503 by the host at once. The host
  tries again after about 1 s, 2 s, 4 s ... up to 30 s, each wait shifted at random by up to a quarter, so hosts
  restarted together do not knock in step. If the engine refuses the host's token (401) or origin (403), the
  host asks nothing for a minute and logs `live: the engine refused the host's view token (401): check
  GIMBAL_VIEW_TOKEN on this service`, so it never runs into the view's failed-try limit (10 a minute).
- **Cached reads, stale kept.** `GET /state`, `/strategy` and the newest journal page are fresh in the host's cache
  for 3 s, older journal pages and window histories for 30 s; one request per key is in flight at a time however many
  visitors ask. A journal event or a reconnect marks the cached `/state` and newest journal page stale (they are not
  deleted), and a read already in flight then is not taken as fresh, so the next page reads what came after. A failed
  read (the engine down, a 5xx, a refusal) never replaces the last good answer: the host serves that answer, stale,
  and asks the engine again only after 2 s (a minute after a 401 or 403). Only with no good answer at all does a
  visitor see the failure (502 or 503).
- **Reads by id are held to what the engine listed.** `GET /windows/history?id=` is answered only for a window in the
  engine's latest list (the stream's windows, or the last `/state`); any other id is 404 at the host and never asked.
  `GET /journal?before=` is asked only before an entry the host has served (in `/state`, an event or a page); any
  other id is answered `[]`, as the engine answers for an id it does not hold. So no visitor can make the host ask the
  engine for an unbounded set of keys.
- **The read budget.** The core reads (`/state`, `/strategy`, the newest journal page) are one key each and fetched
  at most once per 3 s, so they are outside any budget and always get through. The reads by id share a budget on
  cache misses: 80 at once per client address (the same /64 rule), then 1 a second, and 120 at once for the whole
  host, then 5 a second. A cold page on a desk with 40 tradable windows (one history each) loads without a refusal,
  and the next visitors' histories come from the cache. Past a budget the last answer is served even if old, else
  503 with `Retry-After: 2`. A crowd of visitors therefore costs the engine one stream, the core reads every 3 s, and
  a few reads a second at most. Answers over 8 MiB are refused; the cache holds at most 32 MiB.

## What the public sees (exposure audit, 2026-11-06)

Everything the page shows comes from the engine's view, which already runs every string through its redactor
(engine/src/view/view-redact.ts): the value of every variable named like a secret (`…_KEY`, `…_SECRET`, `…_TOKEN`,
`…PRIVATE…`), the key-bearing parts of every URL in its environment, NEAR keys and `?api-key=`-style values by shape,
and the owner's and operator's accounts masked to first 4 + "…" + last 4. This change adds the platform's own ids
(`RAILWAY_…_ID`) and `GIMBAL_PUBLIC_IP` to the engine's cut list. On top of that the host:

- **drops** every venue set-up step's `detail` (GET `/state` `setup` and the `setup` event): those lines name the
  desk's referral codes ("referrer set: …", "bound …"), its Orderly IP allow-list ("key limited to …"), its venue
  account ids and its Orderly key's expiry. The step names, statuses and transactions stay;
- **cuts**, in every string it serves: IPv4 and IPv6 addresses, e-mail addresses, local paths (`/app/…`, `/data/…`,
  `/home/…`, `C:\…`, `file://…`), Railway private host names (`*.railway.internal`), referral codes where text names
  one, and its own token and the engine view's host name, should any of these ever appear in an error text;
- **publishes only the fields the page reads**, at every depth: one field allowlist per shared type
  (`shared/src/types.ts`: the state, the desk and its legs, accounts and P&L, each window with its costs, checks and
  NEAR AI risk check, journal entries, rescue progress, the set-up steps, venue health, the strategy's decision, the
  strategy rules, the scan status, window histories), applied to `GET /state`, `/strategy`, journal pages, histories
  and each of the eight event types the page reads. A field the type does not have, or a value of the wrong kind (an
  object where a number belongs), is not published; the build fails when a type gains a field the list does not name,
  so it is added on purpose. A test runs the page's own fixtures (the web's fake stream, every desk and rescue
  scenario) through the allowlist and finds them unchanged.

What stays public, on purpose: the funding windows and their checks; the desk (desk id, contract id, the masked
owner, every leg with size, prices, liquidation price, margin, funding and fees, equity, reserve, P&L, health, pause
state); the journal with its transaction links (which name the desk's venue addresses, public on chain); rescue
progress; venue health; the strategy rules (auto, minimum net APR, leg size, leverage, stops); the strategy's latest
decision. All of it is either on chain already or what the dashboard is for. Notes:

- the masked owner is a display mask, not a secret: the contract's own `get_desk` names the owner in full, and the
  Security screen (which reads the chain from the visitor's browser) masks it the same way, but anyone can read the
  chain;
- the contract id stays in full (it is the proof) and may be a sub-account that names the owner;
- the desk's EVM, Solana and Orderly addresses are in transaction links and venue explorers anyway.

## Set up (the owner, in the Railway dashboard)

The public service is the one that serves https://gimbal-production-1b10.up.railway.app today (it ran the replay).
Nothing on the live engine's service changes, as long as its read-only view is on.

1. **The live engine's view is on.** On the live engine's service: `GIMBAL_VIEW_TOKEN` set (made with
   `openssl rand -hex 32`), `GIMBAL_VIEW_PORT` (or Railway's `PORT`), and a public domain whose target port is the view's.
   Its start line says `view: read-only on :<port> for origins ...`. `GIMBAL_VIEW_ORIGINS` needs no change: the host
   calls the view server to server, with no `Origin`, which the view lets through to the token check. The two
   services are in different Railway projects, so the host uses the view's public domain (not the private network).
2. **The public service → Variables:** add `GIMBAL_LIVE_URL` (the live engine view's public address, `https://` and
   the host name, no path) and `GIMBAL_VIEW_TOKEN` (the same value as on the live engine's service; the owner pastes
   it, it is never in the repo). Nothing else is needed; `RAILWAY_DOCKERFILE_PATH`, if still set, is harmless.
3. **The public service → Settings → Deploy → Custom Start Command:** `node engine/src/cli/live-host.ts` (it was
   `node engine/src/cli/replay-host.ts`). The root `railway.json` still builds the live `Dockerfile` for this service
   (see docs/deploy-replay.md, "Config as code"); the host builds the hosted-live page at start.
4. **Settings → Deploy → Healthcheck Path:** `/healthz` (unchanged; it answers 200 whether or not the engine is
   configured or up).
5. **Settings → Networking → Public Networking:** the domain's target port is **8080**, the port in the log line
   `live view on http://0.0.0.0:8080`. Keep the same domain, so the public URL does not change.
6. Resources: **512 MB** of memory, no volume (the 2 GB the replay needed can come down). The reason: the host is one
   Node process, under 100 MB when idle; on top of that its cache holds at most 32 MiB, slow readers at most 32 MiB
   all together, and each open visitor stream a few KiB besides; even 300 visitors stay well under 256 MB, which
   leaves room for the one-off web build at start.
7. Deploy, then read the log: `live engine: <view host> (the read-only view; token from GIMBAL_VIEW_TOKEN, added
   server-side)`, `live view on http://0.0.0.0:8080: ...`, `live: event stream open`. On the live engine's log
   there is no `view: refused` line for the host.
8. Open the domain: the header badge says Mainnet with the desk id, the line under it "Live mainnet desk, read-only";
   Desk, Windows, Journal, Rescue and Security show the live desk; there is no Close position button. Quick checks
   from a shell: `GET /healthz` is 200 with `"live":"connected"`; `POST /close`, `POST /rotate`, `POST /stress`,
   `POST /pause` and `PUT /strategy` answer 403; `GET /view-ticket` and `GET /policy` answer 404.
9. **Check that the per-address cap counts the real address**, once after the first deploy (and after any change to
   the domain or the edge): the caps trust `X-Real-IP`, which only holds if the edge sets it and drops one a visitor
   sends. From one machine, open 17 streams that all send the same made-up address (one from the documentation range,
   so it is no one's):

   ```bash
   for i in $(seq 17); do curl -sN -H 'X-Real-IP: 192.0.2.77' -o /dev/null -w '%{http_code}\n' --max-time 5 https://<public domain>/events & done; wait
   ```

   Sixteen print 200 (cut by `--max-time`) and one 429, and the public service's log has a line
   `visitor streams: 16 open from <address>, the cap of 16; refused (429)`. The address there must be this machine's
   public address, not `192.0.2.77`. If it says `192.0.2.77`, the edge passes the visitor's header through and anyone
   can open a fresh set of streams by sending another value: stop here and report it. (Without any of these headers,
   locally, the host falls back to the last `X-Forwarded-For` entry, then the socket.)

**If the view token changes** on the live engine, set the same value on the public service and redeploy it; until
then the page says the engine is not answering and the host logs the 401 line once a minute. **To show the replay
again** set the Custom Start Command back to `node engine/src/cli/replay-host.ts` (docs/deploy-replay.md); the two
variables above are not read by it (the replay engine gets none of the host's variables).

## Run it locally

```bash
npm ci --no-audit --no-fund && npm run build
PORT=8080 node engine/src/cli/live-host.ts      # open http://localhost:8080: "Live engine not configured"
# Against an engine of your own: start serve with GIMBAL_VIEW_TOKEN and GIMBAL_VIEW_PORT (docs/deploy-railway.md,
# "The read-only view"), then
GIMBAL_LIVE_URL=http://127.0.0.1:<view port> GIMBAL_VIEW_TOKEN=<that token> PORT=8080 node engine/src/cli/live-host.ts
```

The host serves `web/dist-live`, never `web/dist` (the normal page from `npm run build`, or the replay's): when
`web/dist-live` is missing or has no hosted-live marker (`<meta name="gimbal-build" content="hosted-live">`), the host
builds it as the hosted-live page first. Plain `http` is
accepted for `GIMBAL_LIVE_URL` only on this machine (`localhost`, `127.0.0.1`); anywhere else it must be `https`.
Option: `--host` (default 0.0.0.0).
