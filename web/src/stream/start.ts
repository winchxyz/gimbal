import { stream } from './hub.ts';
import { connectSse } from './sse.ts';
import { httpApi, type EngineApi } from './api.ts';
import { pickFakeDrift, pickFakeMode, pickFakeScenario, pickSource } from './source.ts';

/** Starts the app's one stream. The fake is behind `import.meta.env.DEV`, so production builds drop it. */
export async function startStream(): Promise<() => void> {
  const search = window.location.search;
  if (import.meta.env.DEV && pickSource(search, true) === 'fake') {
    const { startFakeStream } = await import('./fake.ts');
    return startFakeStream(stream.dispatch, {
      mode: pickFakeMode(search),
      scenario: pickFakeScenario(search),
      drift: pickFakeDrift(search),
    });
  }
  return connectSse(stream.dispatch, { url: '/events' });
}

let api: Promise<EngineApi> | null = null;

/**
 * The engine's HTTP reads (`GET /strategy`, `GET /windows/history`), from the same source as the stream: the
 * fake in development by default, the engine otherwise. This is the one place the live-data task changes.
 */
export function engineApi(): Promise<EngineApi> {
  api ??=
    import.meta.env.DEV && pickSource(window.location.search, true) === 'fake'
      ? import('./fake-windows.ts').then((m) => m.fakeApi())
      : Promise.resolve(httpApi());
  return api;
}
