import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The engine's HTTP API (docs/interfaces.md §2). The dashboard talks to it through this proxy, in development and
// in `vite preview` alike, so the browser only ever sees one origin.
//
// The engine answers only its own dashboard: it refuses a Host that is not this machine and an Origin other than
// localhost:5190, and takes JSON bodies only. `changeOrigin` rewrites Host to the engine's, which it accepts; Origin
// is left as the browser sent it (http://localhost:5190), which it also accepts. Open the page on localhost or 127.0.0.1.
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

export default defineConfig({
  plugins: [react()],
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
