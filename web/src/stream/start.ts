import { stream } from './hub.ts';
import { connectSse } from './sse.ts';
import { httpApi, readEngineState, type EngineApi } from './api.ts';
import { pickFakeDesk, pickFakeDrift, pickFakeMode, pickFakeRescue, pickFakeScenario, resolveSource } from './source.ts';
import type { Source } from './store.ts';
import { reportProblem } from '../remote/problem.ts';
import { remoteSettings } from '../remote/readonly.ts';
import { lockedApi, remoteApi, startRemoteStream } from '../remote/stream.ts';
import { ViewError } from '../remote/view.ts';

/** How long the page waits for the engine to answer before it falls back to the fake (development only). */
const PROBE_MS = 2000;

/** Whether `GET /state` answers: through the dev proxy a stopped engine comes back as an error status, not a hang. */
async function engineAnswers(): Promise<boolean> {
  try {
    const response = await fetch('/state', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PROBE_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

let source: Promise<Source> | null = null;

/**
 * Where this page reads from, settled once: production reads the engine; development reads it when it answers, else the
 * fake, unless the address asks for one (source.ts). A page that fell back to the fake stays on it until it is reloaded.
 */
function pageSource(): Promise<Source> {
  source ??= resolveSource(window.location.search, import.meta.env.DEV, engineAnswers);
  return source;
}

/** Starts the app's one stream. The fake is behind `import.meta.env.DEV`, so production builds drop it. */
export async function startStream(): Promise<() => void> {
  // A remote engine is chosen by the address saved in Settings (remote/settings.ts), never by the page address.
  const remote = remoteSettings();
  if (remote.base !== null) {
    if (remote.token === null) {
      reportProblem(new ViewError('needs-token', 'no view token entered'));
      stream.dispatch({ kind: 'connection', source: 'sse', connection: 'idle' });
      return () => undefined;
    }
    return startRemoteStream(stream.dispatch, { base: remote.base, token: remote.token });
  }
  const search = window.location.search;
  if (import.meta.env.DEV && (await pageSource()) === 'fake') {
    const { startFakeStream } = await import('./fake.ts');
    const scenario = pickFakeScenario(search);
    return startFakeStream(stream.dispatch, {
      mode: pickFakeMode(search),
      scenario,
      // Only when asked for by name: otherwise the desk follows `?state=` and the rescue (fake.ts).
      ...(new URLSearchParams(search).has('desk') ? { desk: pickFakeDesk(search, scenario) } : {}),
      drift: pickFakeDrift(search),
      // A desk with nothing yet has no rescues either, unless the address asks for one: the Journal's empty state needs an empty feed.
      ...(scenario === 'empty' && !new URLSearchParams(search).has('rescue') ? {} : { rescue: pickFakeRescue(search) }),
    });
  }
  return connectSse(stream.dispatch, { url: '/events', readState: () => readEngineState() });
}

let api: Promise<EngineApi> | null = null;

/** The development fake: strategy and history from fake-windows.ts, the journal's backlog for the `?state=` scenario. */
async function fakeEngineApi(search: string): Promise<EngineApi> {
  const [{ fakeApi }, { fakeJournalRead }] = await Promise.all([import('./fake-windows.ts'), import('./fake-journal.ts')]);
  return fakeApi(fakeJournalRead(pickFakeScenario(search), pickFakeMode(search)));
}

/**
 * The engine's HTTP side (`GET /strategy`, `GET /windows/history`, `GET /state`, `GET /journal`, `POST /rotate`,
 * `POST /close`), from the same source as the stream: the engine, a remote engine's read-only view, or the fake in
 * development. This is the one place that chooses.
 */
export function engineApi(): Promise<EngineApi> {
  const remote = remoteSettings();
  if (remote.base !== null) {
    api ??= Promise.resolve(remote.token === null ? lockedApi() : remoteApi({ base: remote.base, token: remote.token }));
    return api;
  }
  api ??= pageSource().then((picked) =>
    import.meta.env.DEV && picked === 'fake' ? fakeEngineApi(window.location.search) : httpApi(),
  );
  return api;
}
