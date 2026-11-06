import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { REFUSAL_CODES } from './src/security/refusals.ts';
import { findRefusalTests, readContractSources } from './src/security/scan.ts';

// The engine's HTTP API (docs/interfaces.md §2). The dashboard talks to it through this proxy, in development and
// in `vite preview` alike, so the browser only ever sees one origin.
//
// The engine answers only its own dashboard: it refuses a Host that is not this machine and an Origin other than
// localhost:5190, and takes JSON bodies only. `changeOrigin` rewrites Host to the engine's, which it accepts; Origin
// is left as the browser sent it (http://localhost:5190), which it also accepts. Open the page on localhost or 127.0.0.1.
// A dashboard on another port (`vite --port <n>`) needs the engine started with `--web-port <n>`; `npm run demo --
// --web-port <n>` sets both.
const engine = process.env.GIMBAL_ENGINE_URL ?? `http://localhost:${process.env.ENGINE_PORT ?? '8790'}`;
const engineRoutes = [
  '/events',
  '/state',
  '/stress',
  '/policy',
  '/strategy',
  '/setup',
  '/windows',
  '/journal',
  '/rotate',
  '/close',
];
// A fresh object for each of `server` and `preview`: Vite may adjust the options it is given.
//
// `configure` ends the browser's side of a stream when the engine's side dies. The proxy pipes the engine's response to
// the browser and, left alone, never ends it when the engine stops in the middle (a killed process, a crash), so the
// page's `/events` would hang open and never notice. Destroying the response makes the browser see the stream fail,
// which is what the page's reconnect waits for.
const proxy = (): Record<string, ProxyOptions> =>
  Object.fromEntries(
    engineRoutes.map((route): [string, ProxyOptions] => [
      route,
      {
        target: engine,
        changeOrigin: true,
        configure: (server) => {
          server.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!res.writableEnded) res.destroy();
            });
          });
        },
      },
    ]),
  );

// The Security screen links every refusal code to the contract tests that assert it. The lines are read from
// `contract/` when the page is built (or the dev server starts), so a link never points at a line that moved.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFUSAL_TESTS = 'virtual:refusal-tests';
const refusalTests = (): Plugin => ({
  name: 'gimbal-refusal-tests',
  resolveId: (id) => (id === REFUSAL_TESTS ? `\0${REFUSAL_TESTS}` : null),
  load: (id) =>
    id === `\0${REFUSAL_TESTS}` ? `export default ${JSON.stringify(findRefusalTests(readContractSources(repoRoot), REFUSAL_CODES))};` : null,
});

// The hosted replay's build (Dockerfile.replay, VITE_HOSTED_REPLAY=1) marks its index.html, so the host
// (engine/src/cli/replay-host.ts) can tell it from the normal build. So does the public live view's build
// (engine/src/cli/live-host.ts, VITE_HOSTED_LIVE=1), with its own marker. Every other build is left as it was.
const hostedMarker = (): Plugin => ({
  name: 'gimbal-hosted-marker',
  transformIndexHtml: (html) =>
    process.env.VITE_HOSTED_LIVE === '1'
      ? html.replace('<head>', '<head>\n<meta name="gimbal-build" content="hosted-live">')
      : process.env.VITE_HOSTED_REPLAY === '1' ? html.replace('<head>', '<head>\n<meta name="gimbal-build" content="hosted-replay">') : html,
});

export default defineConfig({
  plugins: [react(), refusalTests(), hostedMarker()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: proxy(),
  },
  preview: {
    port: 5190,
    strictPort: true,
    proxy: proxy(),
  },
});
