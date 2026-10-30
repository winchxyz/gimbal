import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The engine's HTTP API (docs/interfaces.md §2). In development the dashboard talks to it through
// this proxy, so the browser only ever sees one origin.
const engine = process.env.GIMBAL_ENGINE_URL ?? `http://localhost:${process.env.ENGINE_PORT ?? '8790'}`;
const engineRoutes = ['/events', '/state', '/stress', '/policy', '/strategy', '/setup'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: Object.fromEntries(engineRoutes.map((route) => [route, { target: engine, changeOrigin: true }])),
  },
  preview: {
    port: 5190,
    strictPort: true,
  },
});
