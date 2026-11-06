# The hosted replay on Railway

A public page that shows what `npm run demo` shows, with nothing to install: the recorded mainnet hour of
2026-10-31 (16:15 to 17:19 UTC) played x10 through the real scanner, strategy loop and risk engine, on the simulated
40 USD replay desk. The replay script opens a pair (SOL) within the first minute, holds it through the 17:00
funding, closes it at 17:05 (about 5 minutes in), and the desk shows its realized P&L. About 7 minutes after it started
the replay starts over, so a visitor arriving at any
time sees the whole cycle within a few minutes. The header shows the replay clock (the recording's time, UTC).

It runs as a **second Railway service** from the same repo, next to the live engine and independent of it.

## What runs

`node engine/src/cli/replay-host.ts` (the service's Custom Start Command; on Railway the image is the live `Dockerfile`,
see [Config as code](#config-as-code-the-root-railwayjson-decides-the-dockerfile)):

- one public port, `$PORT`: the production build of the dashboard (`web/dist`) and the engine's read routes on the
  same origin;
- the engine is `serve` in replay mode, as `npm run demo` runs it (the final mainnet policy,
  `tools/demo-strategy.json`, a fresh temp state folder per run), listening on `127.0.0.1` only;
- when a run's recording has played (385 s at x10) and the flat desk has been up 45 s more, a fresh engine starts on
  the other internal port, takes over, and the old one stops; the page's stream reconnects to the new run by itself;
- `GET /healthz` answers 200 once a run serves: `{"ok":true,"run":N,"servingS":...,"runS":430}`.

**Nothing live.** The engine gets none of the host's variables (only the system's own, such as `PATH`), so no key,
token or account can reach it even if one were set on the service. Its process is preloaded with
`engine/src/cli/no-egress.ts`, which refuses:

- every TCP or TLS connect (fetch, WebSocket, `http.request`, `tls.connect`) to a host that is not this machine,
  before any DNS lookup; a loopback name that a custom `lookup` resolves elsewhere is stopped when the lookup answers,
  before it connects, and checked again on connect;
- `dns.lookup`, `dns.lookupService` and every resolver query (`dns.resolve*`, `reverse`, `dns.promises`,
  `dns.Resolver`) for a name or address that is not this machine;
- UDP (`dgram`) send and connect to an address that is not loopback.

A refusal never crashes the engine (a socket with no error listener gets a quiet one). A line `hosted replay: ...
refused` in the log would mean a replay path tried the network and was stopped. Not covered: a child process the
engine might spawn (it spawns none in replay) and native addons (it loads none). Nothing is signed or sent: replay has
no contract client, and its 1Click steps play recorded answers.

**Read-only for visitors.** The page is built with `VITE_HOSTED_REPLAY=1` (only `Dockerfile.replay` sets it): it
leaves out Close position, Change my minimum, the owner's status buttons, rotating, Exit replay, Connect wallet and the
set-up flow, keeps Run a stress test on Rescue, and says "Public replay: read-only. Run it yourself with npm run demo."
under the header. Every other build (`npm run demo`, the live dashboard) is unchanged. The public port refuses, before they reach the engine, `PUT /strategy`, `POST /rotate`,
`POST /close`, `POST /policy/draft`, `POST /setup` and every other write, with a reason the page shows
("This is the hosted replay ... read-only"). The replay script drives entry and close inside the engine. `POST /stress`
(the Rescue screen's "Run a stress test") stays open: one at a time, **one per run** for all visitors (so the realized
P&L stays the recorded hour's plus at most one rescue), never while a rescue runs, and only while a pair is held;
otherwise it answers 409 with why (a second one in the same run also says when the replay starts over, with
`Retry-After`). Its body must be empty, `{}` (what the page sends) or `{"on":true}`; anything else is answered 400
and does not use up the run's stress test. The engine always receives `{"on":true}`.

**Built for many visitors.** Every proxied response is written with backpressure: a client that stops reading stops
the read from the engine (whose own 1 MiB SSE cap then drops that stream), and a client that leaves more than 1 MiB
unread is dropped. Event streams are capped at 500 in all (503, the page retries) and 16 per client address (429;
room for several judges' tabs behind one office or venue address), the address being `X-Real-IP`, else the last
`X-Forwarded-For` entry, else the socket's (set-up step 9 checks this behind Railway's edge). A GET or HEAD that carries a
body (`Content-Length` above 0, or `Transfer-Encoding`) is answered 400 and its connection closed, and each request
to the engine uses a connection of its own, so nothing a client sends can be read as a second request. `HEAD` on an
API path is a GET without the body: `HEAD /events` is answered by the host (200, `text/event-stream`, no stream
opened), every other API path with the engine's headers; `HEAD` on a page or asset gives its headers.

## Why the live engine is unaffected

- The live service keeps building `Dockerfile` with `railway.json`; neither file changes. The new files
  (`Dockerfile.replay`, `engine/src/cli/replay-host*.ts`, `no-egress*.ts`, `tools/demo-strategy.json`) are copied into
  the live image like any other file, and nothing there runs them: its start command is still
  `node engine/src/cli/serve.ts`.
- The replay service has its own settings, no volume and no variables but one (which does not take effect, see
  below). It cannot reach the live engine:
  that one listens on `127.0.0.1` inside its own container.
- Until its auto-deploy is turned off (step 10), a merge to `main` redeploys the replay too, next to the live one; the
  replay simply starts over at run 1.

## Config as code: the root `railway.json` decides the Dockerfile

Railway's config-as-code page (checked 2026-11-05) says Config as Code is deprecated: "Existing files keep working
for legacy services until 2026-12-01", and its
[Infrastructure as Code page](https://docs.railway.com/infrastructure-as-code) says "New services cannot opt into Config as
Code" and that existing files "stop being read on 2026-12-01 (hard cutoff)". In practice (set up 2026-11-06) the new
replay service **did** read the repo's root `railway.json`, and Railway says "Configuration defined in code will always
override values from the dashboard". So:

- `build.dockerfilePath: "Dockerfile"` in `railway.json` overrides the `RAILWAY_DOCKERFILE_PATH` variable: the replay
  service builds the live `Dockerfile`, whose `CMD` is `serve.ts`. Left at that, the domain answers 502;
- `railway.json` sets no `startCommand`, so the dashboard's **Custom Start Command** applies, and it is what makes the
  service the hosted replay (step 3). On the live image the host finds no hosted `web/dist` and builds the hosted
  dashboard once at start (about a minute), then serves;
- the `deploy` block applies to the replay service too: `restartPolicyType: ALWAYS` (also right for it),
  `drainingSeconds: 180`, `overlapSeconds: 0`;
- there is no `railway.replay.json`: Config as Code is deprecated, and the start command needs no change to
  `railway.json` or the Dockerfiles. After 2026-12-01 the root file stops being read and the variable from step 2
  would take effect (`Dockerfile.replay`, same start command); the replay is planned to stop before that;
- **the live service is affected after 2026-12-01**, not by this change: its `railway.json` stops being read then, and
  with it `restartPolicyType: ALWAYS`, `drainingSeconds: 180` and `overlapSeconds: 0`. Before that date set those in the
  live service's dashboard settings, or migrate it to Infrastructure as Code (`.railway/railway.ts`). The hosted
  replay is planned to stop by 2026-11-25, before the cutoff.

## Set up (the owner, in the Railway dashboard)

1. Create a **separate Railway project** for it (**New Project → Deploy from GitHub repo → winchxyz/gimbal**), not a
   service inside the live engine's project: no shared variable, volume or setting of the live project can reach it
   (the host would not pass a variable on anyway), and deleting it later cannot touch the live service.
2. The new service → **Variables**: add exactly one, `RAILWAY_DOCKERFILE_PATH` = `Dockerfile.replay`. Nothing else: no
   `GIMBAL_*`, no key, no token. Railway sets `PORT` itself. The variable is harmless but does not take effect while
   the root `railway.json` sets `dockerfilePath` (see [Config as code](#config-as-code-the-root-railwayjson-decides-the-dockerfile));
   step 3 is what matters.
3. **Settings → Deploy → Custom Start Command**: `node engine/src/cli/replay-host.ts`. **This is the step that makes
   it the hosted replay.** Without it the service runs the live image's `CMD` (`serve.ts`) and the domain answers 502.
   The host serves `web/dist` only when it is the hosted build (its `index.html` carries
   `<meta name="gimbal-build" content="hosted-replay">`); the live image has none, so the first start logs
   `web/dist is missing: building the hosted dashboard once (production build)` and serves about a minute later.
4. **Settings → Deploy → Healthcheck Path**: `/healthz` (the default 300 s timeout is plenty for the one-minute
   dashboard build; the first run serves about 5 s after that).
5. **Settings → Networking → Public Networking → Generate Domain**. That URL is the hosted demo.
6. No volume, one replica, any region (it calls no venue). The restart policy comes from `railway.json`
   (`ALWAYS`), which is right: the host exits after five runs in a row fail, and Railway starts it again.
7. Deploy, then read the log: `recording engine/fixtures/replay/scan-mainnet-2026-10-31T16.jsonl.gz: ... one run plays
   385 s`, `engine environment: N system variables kept, the host's other M not passed on` (2 system variables on
   Railway), `hosted replay on http://0.0.0.0:<port>`, `run 1: serving; the next run starts in 430 s`,
   the engine's `hosted replay: outbound connections refused in this process (loopback only)` (the guard is on), and
   every 430 s `run N: serving` followed by `run N-1: stopped`. No line should say `hosted replay: ... refused (the
   replay reads fixtures only)`: that one would mean a replay path tried the network.
8. **Check the domain's port**, then open it. **Settings → Networking → Public Networking**: the domain's target port
   must be the port in the log line `hosted replay on http://0.0.0.0:<port>` (Railway sets `PORT`; it was 8080 on
   2026-11-06, but read it from the log). A domain generated while another program ran (for example before step 3 took
   effect) can point at a different port and keeps answering 502 ("Application failed to respond") even after the
   host serves: edit the domain's port to the one in the log.
   Open the domain: the header says Replay with the replay clock, the line under it "Public replay: read-only";
   within a minute the Desk shows two SOL legs, with no Close position button. Quick checks from a shell:
   `GET /healthz` is 200 with `{"ok":true,...}`; the page carries `<meta name="gimbal-build" content="hosted-replay">`;
   `POST /close`, `POST /rotate`, `POST /setup` and `PUT /strategy` answer 403; `POST /stress` with body
   `{"on":false}` answers 400 (and does not use up the run's stress test).
9. Check that the per-client stream cap is real behind Railway's edge. From one machine, open 17 streams (the cap is
   16), each with a different forged `X-Real-IP`:

   ```bash
   for i in $(seq 1 17); do curl -sN -m 5 -o /dev/null -w "%{http_code}\n" -H "X-Real-IP: 10.0.0.$i" https://<domain>/events & done; wait
   ```

   A page tab open on the domain from the same address already holds one of the 16 slots, so expect 16 minus your
   open tabs `200` and the rest `429` (no tab open: sixteen `200` and one `429`; on 2026-11-06, with one tab open,
   15 `200` and 2 `429`). The edge replaced the forged header with your real address, so all 17
   counted as one client. If all 17 answer `200`, the edge passes `X-Real-IP` through and the per-client cap can be dodged.
   There is no code change to ship for that: the global cap (500 streams) and the 1 MiB unread limit still bound
   memory. Leave the service running and report it to the maintainer, with the output.
10. **Once the hackathon submission is in, turn off auto-deploy** for the replay service (**Settings → Source**: disconnect
   the branch trigger, or turn off automatic deploys), so the judging days run one fixed build and no merge to `main`
   restarts it. The live service keeps its own auto-deploy.

Memory (measured locally): the host about 80 MB; one engine about 240 MB when its run starts and about 440 MB near
its end. At a switch the old engine (near its end) and the new one (starting) run together for a few seconds: about
750 MB. **Give the service 2 GB** (Settings → Deploy → Resource limits) to leave room for visitors' streams.

## Stop it (after 2026-11-25)

The replay project → **Settings → Danger → Delete Project** (or, to keep its settings, the replay service →
**Deployments → the active deployment → Remove**). It is a project of its own, so this touches nothing of the live
service. Then remove the "Hosted demo" line from the README.

## Run it locally

```bash
npm ci --no-audit --no-fund && npm run build
PORT=8080 node engine/src/cli/replay-host.ts      # open http://localhost:8080
# web/dist from `npm run build` is the normal page: the host sees no hosted marker and rebuilds it as the hosted one
# first (VITE_HOSTED_REPLAY=1 npm run build -w web does the same by hand).
# or as Railway builds it:
docker build -f Dockerfile.replay -t gimbal-replay . && docker run --rm -p 8080:8080 -e PORT=8080 gimbal-replay
```

Options: `--speed <x>` (default 10), `--pause <s>` on the finished desk (default 45), `--engine-ports a,b` (the two
internal ports, default 18790,18791), `--replay <file>` (default the newest `scan-*.jsonl.gz`), `--host` (default
0.0.0.0).
