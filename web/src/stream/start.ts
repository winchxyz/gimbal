import { stream } from './hub.ts';
import { connectSse } from './sse.ts';
import { httpApi, type EngineApi } from './api.ts';
import { pickFakeDesk, pickFakeDrift, pickFakeMode, pickFakeScenario, pickSource } from './source.ts';

/** Starts the app's one stream. The fake is behind `import.meta.env.DEV`, so production builds drop it. */
export async function startStream(): Promise<() => void> {
  const search = window.location.search;
  if (import.meta.env.DEV && pickSource(search, true) === 'fake') {
    const { startFakeStream } = await import('./fake.ts');
    const scenario = pickFakeScenario(search);
    return startFakeStream(stream.dispatch, {
      mode: pickFakeMode(search),
      scenario,
      desk: pickFakeDesk(search, scenario),
      drift: pickFakeDrift(search),
    });
  }
  return connectSse(stream.dispatch, { url: '/events' });
}

let api: Promise<EngineApi> | null = null;

/** The development fake: strategy and history from fake-windows.ts, the journal's backlog for the `?state=` scenario. */
async function fakeEngineApi(search: string): Promise<EngineApi> {
  const [{ fakeApi }, { fakeJournalRead }] = await Promise.all([import('./fake-windows.ts'), import('./fake-journal.ts')]);
  return fakeApi(fakeJournalRead(pickFakeScenario(search), pickFakeMode(search)));
}

/**
 * The engine's HTTP reads (`GET /strategy`, `GET /windows/history`, `GET /state`), from the same source as the stream: the
 * fake in development by default, the engine otherwise. This is the one place the live-data task changes.
 */
export function engineApi(): Promise<EngineApi> {
  api ??=
    import.meta.env.DEV && pickSource(window.location.search, true) === 'fake'
      ? fakeEngineApi(window.location.search)
      : Promise.resolve(httpApi());
  return api;
}
