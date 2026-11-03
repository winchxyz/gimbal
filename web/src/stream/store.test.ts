import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, JournalEntry, StreamEvent } from '@gimbal/shared';
import {
  JOURNAL_LIMIT,
  initialStreamState,
  parseStreamEvent,
  reduceStream,
  type StreamAction,
  type StreamState,
} from './store.ts';
import { pickFakeDrift, pickFakeMode, pickFakeScenario, pickSource } from './source.ts';
import { startFakeStream } from './fake.ts';

const desk = (equityUsd: number): DeskState => ({
  deskId: 'd1',
  owner: 'owner.testnet',
  contract: '(test contract)',
  mode: 'testnet',
  legs: [],
  netDelta: 0,
  equityUsd,
  reserveUsd: 0,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 },
  health: 'level',
  paused: null,
  rescueFailure: null,
  updatedAt: 1,
});

const entry = (id: string, t: number): JournalEntry => ({ id, t, kind: 'funding', summary: id, numbers: {}, tx: [] });

const apply = (events: StreamEvent[], from: StreamState = initialStreamState()): StreamState =>
  events.reduce<StreamState>((s, event, i) => reduceStream(s, { kind: 'event', event, at: 1000 + i }), from);

test('events count per type and keep the latest of each', () => {
  const s = apply([
    { type: 'desk', data: desk(100) },
    { type: 'desk', data: desk(101) },
    { type: 'windows', data: [] },
    { type: 'health', data: { hyperliquid: 'ok', phoenix: 'slow', orderly: 'ok', intents: 'ok', near: 'down' } },
  ]);
  assert.equal(s.received, 4);
  assert.deepEqual(s.counts, { windows: 1, scan: 0, desk: 2, journal: 0, rescue: 0, setup: 0, health: 1, decision: 0 });
  assert.equal(s.desk?.equityUsd, 101);
  assert.deepEqual(s.windows, []);
  assert.equal(s.health?.near, 'down');
  assert.deepEqual(s.last, { type: 'health', at: 1003 });
});

test('the reducer never mutates the previous state', () => {
  const before = initialStreamState();
  const after = reduceStream(before, { kind: 'event', event: { type: 'desk', data: desk(5) }, at: 1 });
  assert.equal(before.received, 0);
  assert.equal(before.counts.desk, 0);
  assert.equal(before.desk, null);
  assert.notEqual(after, before);
});

test('journal is newest first, replaces by id and stays bounded', () => {
  let s = apply([
    { type: 'journal', data: entry('a', 10) },
    { type: 'journal', data: entry('c', 30) },
    { type: 'journal', data: entry('b', 20) },
  ]);
  assert.deepEqual(s.journal.map((e) => e.id), ['c', 'b', 'a']);

  s = apply([{ type: 'journal', data: { ...entry('b', 20), summary: 'resent' } }], s);
  assert.deepEqual(s.journal.map((e) => e.id), ['c', 'b', 'a']);
  assert.equal(s.journal[1]?.summary, 'resent');

  const many: StreamEvent[] = Array.from({ length: JOURNAL_LIMIT + 5 }, (_, i) => ({
    type: 'journal',
    data: entry(`e${i}`, 100 + i),
  }));
  s = apply(many, s);
  assert.equal(s.journal.length, JOURNAL_LIMIT);
  assert.equal(s.journal[0]?.id, `e${JOURNAL_LIMIT + 4}`);
});

test('connection changes are recorded; repeating one keeps the same state object', () => {
  const open: StreamAction = { kind: 'connection', source: 'sse', connection: 'open' };
  const s1 = reduceStream(initialStreamState(), open);
  assert.equal(s1.source, 'sse');
  assert.equal(s1.connection, 'open');
  assert.equal(reduceStream(s1, open), s1);
  const s2 = reduceStream(s1, { kind: 'connection', source: 'sse', connection: 'retrying' });
  assert.equal(s2.connection, 'retrying');
});

test('rejected messages are counted but change nothing else', () => {
  const s = reduceStream(initialStreamState(), { kind: 'rejected', at: 1 });
  assert.equal(s.rejected, 1);
  assert.equal(s.received, 0);
  assert.equal(s.last, null);
});

test('parseStreamEvent accepts StreamEvent envelopes only', () => {
  assert.deepEqual(parseStreamEvent('{"type":"windows","data":[]}'), { type: 'windows', data: [] });
  assert.equal(parseStreamEvent(JSON.stringify({ type: 'desk', data: desk(1) }))?.type, 'desk');

  for (const bad of [
    'not json',
    'null',
    '42',
    '{"data":{}}',
    '{"type":"prices","data":{}}',
    '{"type":"desk"}',
    '{"type":"desk","data":null}',
    '{"type":"desk","data":[]}',
    '{"type":"windows","data":{}}',
  ]) {
    assert.equal(parseStreamEvent(bad), null, bad);
  }
});

test('production always reads the engine; development reads it when it answers, and the design states ask for the fake', () => {
  assert.equal(pickSource('', false), 'sse');
  assert.equal(pickSource('?stream=fake', false), 'sse');
  assert.equal(pickSource('?desk=watch', false), 'sse');
  assert.equal(pickSource('', true), 'auto');
  assert.equal(pickSource('?stream=sse', true), 'sse');
  assert.equal(pickSource('?stream=fake', true), 'fake');
  for (const search of ['?desk=watch', '?state=empty', '?net=replay', '?drift=off', '?stream=other&desk=level']) {
    assert.equal(pickSource(search, true), 'fake', search);
  }
  assert.equal(pickSource('?stream=sse&desk=watch', true), 'sse');
  assert.equal(pickFakeMode(''), 'testnet');
  assert.equal(pickFakeMode('?net=replay'), 'replay');
  assert.equal(pickFakeMode('?net=mainnet'), 'mainnet');
  assert.equal(pickFakeMode('?net=other'), 'testnet');
});

test('?state= picks the Windows scenario in the fake, and ?drift=off freezes the rates', () => {
  assert.equal(pickFakeScenario(''), 'normal');
  assert.equal(pickFakeScenario('?state=loading'), 'loading');
  assert.equal(pickFakeScenario('?state=empty&net=replay'), 'empty');
  assert.equal(pickFakeScenario('?state=error'), 'error');
  assert.equal(pickFakeScenario('?state=other'), 'normal');
  assert.equal(pickFakeDrift(''), true);
  assert.equal(pickFakeDrift('?drift=off'), false);
});

test('the fake stream emits valid StreamEvents into the store', () => {
  const actions: StreamAction[] = [];
  const stop = startFakeStream((a) => actions.push(a), { mode: 'replay', intervalMs: 60_000 });
  stop();

  assert.deepEqual(actions[0], { kind: 'connection', source: 'fake', connection: 'open' });
  assert.deepEqual(actions.at(-1), { kind: 'connection', source: 'fake', connection: 'idle' });
  assert.equal(actions.filter((a) => a.kind === 'rejected').length, 0);

  const s = actions.reduce(reduceStream, initialStreamState());
  // the three events the Desk's "Latest" shows come with the first tick
  assert.deepEqual(s.counts, { windows: 1, scan: 1, desk: 1, journal: 3, rescue: 0, setup: 1, health: 1, decision: 0 });
  assert.equal(s.desk?.mode, 'replay');
  assert.equal(s.desk?.legs.length, 2);
  assert.equal(s.windows?.length, 13);
  assert.equal(s.scan?.venues, 32);
});
