# The hosted replay on Railway

A public page that shows what `npm run demo` shows, with nothing to install: the recorded mainnet hour of
2026-10-31 (16:15 to 17:19 UTC) played x10 through the real scanner, strategy loop and risk engine, on the simulated
40 USD replay desk. The replay script opens a pair (SOL) within the first minute, holds it through the 17:00
funding, closes it at 17:05 (about 5 minutes in), and the desk shows its realized P&L. About 7 minutes after it started
the replay starts over, so a visitor arriving at any
time sees the whole cycle within a few minutes. The header shows the replay clock (the recording's time, UTC).

It runs as a **second Railway service** from the same repo, next to the live engine and independent of it.

## What runs

`node engine/src/cli/replay-host.ts` (`Dockerfile.replay` builds the dashboard and starts it):

- one public port, `$PORT`: the production build of the dashboard (`web/dist`) and the engine's read routes on the
  same origin;
- the engine is `serve` in replay mode, as `npm run demo` runs it (the final mainnet policy,
  `tools/demo-strategy.json`, a fresh temp state folder per run), listening on `127.0.0.1` only;
- when a run's recording has played (385 s at x10) and the flat desk has been up 45 s more, a fresh engine starts on
  the other internal port, takes over, and the old one stops; the page's stream reconnects to the new run by itself;
- `GET /healthz` answers 200 once a run serves: `{"ok":true,"run":N,"servingS":...,"runS":430}`.

**Nothing live.** The engine gets none of the host's variables (only the system's own, such as `PATH`), so no key,
token or account can reach it even if one were set on the service. Every outbound connection in its process is
refused before any DNS lookup (`engine/src/cli/no-egress.ts`); a line `outbound connection to <host> refused` in the
log would mean a replay path tried the network and was stopped. Nothing is signed or sent: replay has no contract
client, and its 1Click steps play recorded answers.

**Read-only for visitors.** The page is built with `VITE_HOSTED_REPLAY=1` (only `Dockerfile.replay` sets it): it
leaves out Close position, Change my minimum, the owner's status buttons, rotating, Exit replay, Connect wallet and the
set-up flow, keeps Run a stress test on Rescue, and says "Public replay: read-only. Run it yourself with npm run demo."
under the header. Every other build (`npm run demo`, the live dashboard) is unchanged. The public port refuses, before they reach the engine, `PUT /strategy`, `POST /rotate`,
`POST /close`, `POST /policy/draft`, `POST /setup` and every other write, with a reason the page shows
("This is the hosted replay ... read-only"). The replay script drives entry and close inside the engine. `POST /stress`
(the Rescue screen's "Run a stress test") stays open: one at a time, at most one a minute for all visitors, never while
a rescue runs, and only while a pair is held; otherwise it answers why (409 or 429).

## Why the live engine is unaffected

- The live service keeps building `Dockerfile` with `railway.json`; neither file changes. The new files
  (`Dockerfile.replay`, `engine/src/cli/replay-host*.ts`, `no-egress*.ts`, `tools/demo-strategy.json`) are copied into
  the live image like any other file, and nothing there runs them: its start command is still
  `node engine/src/cli/serve.ts`.
- The replay service has its own settings, no volume and no variables but one. It cannot reach the live engine:
  that one listens on `127.0.0.1` inside its own container.
- Until its auto-deploy is turned off (step 9), a merge to `main` redeploys the replay too, next to the live one; the
  replay simply starts over at run 1.

## Config as code: why there is no `railway.replay.json`

Railway's config-as-code page (checked 2026-11-05) says Config as Code is deprecated: "Existing files keep working
for legacy services until 2026-12-01", and its Infrastructure as Code page says "New services cannot opt into Config as
Code" and that existing files "stop being read on 2026-12-01 (hard cutoff)". So:

- a second config file would not be read by a service created now: the replay service is set up in its dashboard
  settings below (a Dockerfile path variable, a start command, a healthcheck path);
- **the live service is affected after 2026-12-01**, not by this change: its `railway.json` stops being read then, and
  with it `restartPolicyType: ALWAYS`, `drainingSeconds: 180` and `overlapSeconds: 0`. Before that date set those in the
  live service's dashboard settings, or migrate it to Infrastructure as Code (`.railway/railway.ts`). The hosted
  replay is planned to stop by 2026-11-25, before the cutoff.

## Set up (the owner, in the Railway dashboard)

1. Create a **separate Railway project** for it (**New Project → Deploy from GitHub repo → winchxyz/gimbal**), not a
   service inside the live engine's project: no shared variable, volume or setting of the live project can reach it
   (the host would not pass a variable on anyway), and deleting it later cannot touch the live service.
2. The new service → **Variables**: add exactly one, `RAILWAY_DOCKERFILE_PATH` = `Dockerfile.replay`. Nothing else: no
   `GIMBAL_*`, no key, no token. Railway sets `PORT` itself.
3. **Settings → Deploy → Custom Start Command**: `node engine/src/cli/replay-host.ts`. It is the image's own `CMD`;
   set here too, it keeps the service right even if the variable in step 2 were missed (with the plain `Dockerfile` the
   host builds the dashboard once at start, about a minute, then serves).
4. **Settings → Deploy → Healthcheck Path**: `/healthz` (the default 300 s timeout is plenty; the first run serves
   about 5 s after the container starts).
5. **Settings → Networking → Public Networking → Generate Domain**, on the port Railway offers (the one in `$PORT`).
   That URL is the hosted demo.
6. No volume, one replica, any region (it calls no venue). The default restart policy (on failure) is right: the host
   exits after five runs in a row fail, and Railway starts it again.
7. Deploy, then read the log: `recording engine/fixtures/replay/scan-mainnet-2026-10-31T16.jsonl.gz: ... one run plays
   385 s`, `engine environment: N system variables kept, the host's other M not passed on`, `hosted replay on
   http://0.0.0.0:<port>`, `run 1: serving; the next run starts in 430 s`, and every 430 s `run N: serving` followed by
   `run N-1: stopped`. No line should say `outbound connection ... refused`.
8. Open the domain: the header says Replay with the replay clock, the line under it "Public replay: read-only";
   within a minute the Desk shows two SOL legs, with no Close position button.
9. **Once the hackathon submission is in, turn off auto-deploy** for the replay service (**Settings → Source**: disconnect
   the branch trigger, or turn off automatic deploys), so the judging days run one fixed build and no merge to `main`
   restarts it. The live service keeps its own auto-deploy.

Memory (measured locally): the host about 80 MB, one engine about 250 MB, so about 600 MB for the few seconds of
each switch when two engines run; leave the service at least 1 GB.

## Stop it (after 2026-11-25)

The replay project → **Settings → Danger → Delete Project** (or, to keep its settings, the replay service →
**Deployments → the active deployment → Remove**). It is a project of its own, so this touches nothing of the live
service. Then remove the "Hosted demo" line from the README.

## Run it locally

```bash
npm ci --no-audit --no-fund && npm run build
VITE_HOSTED_REPLAY=1 npm run build -w web         # the hosted page (without it, web/dist is the normal page)
PORT=8080 node engine/src/cli/replay-host.ts      # open http://localhost:8080
# or as Railway builds it:
docker build -f Dockerfile.replay -t gimbal-replay . && docker run --rm -p 8080:8080 -e PORT=8080 gimbal-replay
```

Options: `--speed <x>` (default 10), `--pause <s>` on the finished desk (default 45), `--engine-ports a,b` (the two
internal ports, default 18790,18791), `--replay <file>` (default the newest `scan-*.jsonl.gz`), `--host` (default
0.0.0.0).
