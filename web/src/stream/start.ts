import { stream } from './hub.ts';
import { connectSse } from './sse.ts';
import { pickFakeMode, pickSource } from './source.ts';

/** Starts the app's one stream. The fake is behind `import.meta.env.DEV`, so production builds drop it. */
export async function startStream(): Promise<() => void> {
  const search = window.location.search;
  if (import.meta.env.DEV && pickSource(search, true) === 'fake') {
    const { startFakeStream } = await import('./fake.ts');
    return startFakeStream(stream.dispatch, { mode: pickFakeMode(search) });
  }
  return connectSse(stream.dispatch, { url: '/events' });
}
