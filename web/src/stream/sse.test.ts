// The stream client against a stand-in for the browser's EventSource: it reads /state after each open, holds the events
// that arrive meanwhile, and reconnects with a growing wait.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineState, StreamEvent } from '@gimbal/shared';
import { backoffMs, connectSse, type EventSourceLike } from './sse.ts';
import { initialStreamState, reduceStream, type StreamAction } from './store.ts';

class FakeSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  send(event: StreamEvent | string): void {
    this.onmessage?.({ data: typeof event === 'string' ? event : JSON.stringify(event) } as MessageEvent<unknown>);
  }
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

const state = (overrides: Partial<EngineState> = {}): EngineState => ({
  mode: 'replay',
  windows: null,
  scan: null,
  strategy: null,
  desk: null,
  journal: [],
  rescue: null,
  setup: null,
  health: null,
  at: 1,
  ...overrides,
});

const scan = (at: number): StreamEvent => ({ type: 'scan', data: { venues: 3, failed: [], at } });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(readState: () => Promise<EngineState>) {
  const sources: FakeSource[] = [];
  const actions: StreamAction[] = [];
  const stop = connectSse((a) => actions.push(a), {
    readState,
    open: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
  });
  const connections = () => actions.flatMap((a) => (a.kind === 'connection' ? [a.error === undefined ? a.connection : `${a.connection}: ${a.error}`] : []));
  return { sources, actions, stop, connections, final: () => actions.reduce(reduceStream, initialStreamState()) };
}

test('the waits grow from a second and stop at fifteen', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(backoffMs(-1), 1000);
});

test('the state is read once the stream is open, and the connection is open only after it is in', async () => {
  let release: (s: EngineState) => void = () => {};
  const h = harness(() => new Promise<EngineState>((resolve) => (release = resolve)));
  const [stream] = h.sources;
  assert.equal(stream?.url, '/events');
  assert.deepEqual(h.connections(), ['connecting']);

  stream?.open();
  // events that arrive while /state is on its way wait for it
  stream?.send(scan(40));
  stream?.send('not an event');
  assert.equal(h.final().scan, null);
  assert.deepEqual(h.connections(), ['connecting']);
  assert.equal(h.final().rejected, 1);

  release(state({ scan: { venues: 3, failed: [], at: 30 }, at: 31 }));
  await flush();
  assert.deepEqual(h.connections(), ['connecting', 'open']);
  const s = h.final();
  assert.equal(s.mode, 'replay');
  assert.equal(s.scan?.at, 40, 'the waiting event is applied after the state, so the newer scan wins');
  assert.equal(s.connection, 'open');

  // from here on events go straight to the store
  stream?.send(scan(50));
  assert.equal(h.final().scan?.at, 50);
  h.stop();
});

test('a dropped stream is reopened after a wait that grows, and the state is read again each time', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let reads = 0;
    const h = harness(async () => {
      reads += 1;
      return state({ at: reads });
    });
    h.sources[0]?.open();
    await flush();
    assert.deepEqual(h.connections(), ['connecting', 'open']);

    h.sources[0]?.fail();
    assert.equal(h.sources[0]?.closed, true, 'the browser’s own retry is not used');
    assert.equal(h.sources.length, 1);
    mock.timers.tick(999);
    assert.equal(h.sources.length, 1);
    mock.timers.tick(1);
    assert.equal(h.sources.length, 2);

    // still down: the wait doubles
    h.sources[1]?.fail();
    mock.timers.tick(1999);
    assert.equal(h.sources.length, 2);
    mock.timers.tick(1);
    assert.equal(h.sources.length, 3);

    // back: the state is read again and the connection is open; the count of failures starts over
    h.sources[2]?.open();
    await flush();
    assert.equal(reads, 2);
    assert.deepEqual(h.connections().slice(-2), ['retrying', 'open']);
    h.sources[2]?.fail();
    mock.timers.tick(1000);
    assert.equal(h.sources.length, 4);
    h.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a stream that opens but whose state cannot be read is a failure too, and says why', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness(async () => {
      throw new Error('GET /state: 500');
    });
    h.sources[0]?.open();
    await flush();
    assert.equal(h.sources[0]?.closed, true);
    assert.deepEqual(h.connections(), ['connecting', 'retrying: GET /state: 500']);
    assert.equal(h.final().error, 'GET /state: 500');
    mock.timers.tick(1000);
    assert.equal(h.sources.length, 2);
    h.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a late answer from a stream that was dropped is ignored', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let release: (s: EngineState) => void = () => {};
    const h = harness(() => new Promise<EngineState>((resolve) => (release = resolve)));
    h.sources[0]?.open();
    h.sources[0]?.fail();
    release(state({ mode: 'mainnet' }));
    await flush();
    assert.equal(h.final().mode, null);
    assert.equal(h.final().connection, 'retrying');
    h.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stopping closes the stream, ends the retries and leaves the connection idle', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness(async () => state());
    h.sources[0]?.open();
    await flush();
    h.sources[0]?.fail();
    h.stop();
    mock.timers.tick(60_000);
    assert.equal(h.sources.length, 1);
    assert.equal(h.final().connection, 'idle');
  } finally {
    mock.timers.reset();
  }
});
