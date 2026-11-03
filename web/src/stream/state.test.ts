// What the page holds after `GET /state`: the engine's word replaces the page's copy, and a replay keeps its own clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, EngineState, JournalEntry, ScanStatus, StreamEvent } from '@gimbal/shared';
import { initialStreamState, reduceStream, replaySkew, type StreamState } from './store.ts';

const entry = (id: string, t: number): JournalEntry => ({ id, t, kind: 'funding', summary: id, numbers: {}, tx: [] });
const scan = (at: number): ScanStatus => ({ venues: 3, failed: [], at });
const desk = (equityUsd: number): DeskState => ({
  deskId: 'd1',
  owner: '(test owner)',
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
const engine = (overrides: Partial<EngineState> = {}): EngineState => ({
  mode: 'testnet',
  windows: null,
  scan: null,
  strategy: null,
  desk: null,
  journal: [],
  rescue: null,
  setup: null,
  health: null,
  decision: null,
  at: 1,
  ...overrides,
});
const event = (e: StreamEvent, at: number) => ({ kind: 'event', event: e, at }) as const;
const seed = (state: EngineState, at = 1000, from: StreamState = initialStreamState()): StreamState => reduceStream(from, { kind: 'state', state, at });

test('the state fills the page: the mode before any desk, the latest of each type, the journal newest first', () => {
  const s = seed(engine({ mode: 'replay', windows: [], scan: scan(5), journal: [entry('b', 20), entry('a', 10)] }), 1234);
  assert.equal(s.mode, 'replay');
  assert.deepEqual(s.windows, []);
  assert.equal(s.scan?.at, 5);
  assert.equal(s.desk, null);
  assert.deepEqual(s.journal.map((e) => e.id), ['b', 'a']);
  assert.equal(s.heardAt, 1234);
  assert.equal(s.received, 0, 'the state is not an event');
});

test('a new state replaces the old one: a restarted engine does not leave the old run behind', () => {
  let s = seed(engine({ desk: desk(100), windows: [], journal: [entry('old', 5)] }));
  s = reduceStream(s, event({ type: 'journal', data: entry('live', 6) }, 2000));
  assert.deepEqual(s.journal.map((e) => e.id), ['live', 'old']);

  s = seed(engine({ mode: 'replay', desk: null, windows: null, journal: [] }), 3000, s);
  assert.equal(s.desk, null);
  assert.equal(s.windows, null);
  assert.deepEqual(s.journal, []);
  assert.equal(s.mode, 'replay');
});

test('events after the state apply on top of it', () => {
  let s = seed(engine({ scan: scan(5), journal: [entry('a', 10)] }));
  s = reduceStream(s, event({ type: 'journal', data: entry('b', 20) }, 2000));
  s = reduceStream(s, event({ type: 'journal', data: entry('a', 10) }, 2001)); // resent: replaced, not doubled
  assert.deepEqual(s.journal.map((e) => e.id), ['b', 'a']);
  assert.equal(s.heardAt, 2001);
});

test('a replay’s clock is the recording’s: the skew is how far its stamps run behind the page', () => {
  assert.equal(replaySkew('replay', 1_000, 61_000), 60_000);
  assert.equal(replaySkew('testnet', 1_000, 61_000), 0);
  assert.equal(replaySkew('replay', null, 61_000), 0);

  let s = seed(engine({ mode: 'replay', scan: scan(1_000) }), 61_000);
  assert.equal(s.skewMs, 60_000);
  // the next scan is newer: the skew follows it
  s = reduceStream(s, event({ type: 'scan', data: scan(6_000) }, 66_500));
  assert.equal(s.skewMs, 60_500);
  // the recording ended: scans repeat the last stamp, and the skew stays, so the data is shown getting older
  s = reduceStream(s, event({ type: 'scan', data: scan(6_000) }, 71_500));
  assert.equal(s.skewMs, 60_500);
});

test('a live engine has no skew, and a replay with no scan yet waits for the first one', () => {
  assert.equal(seed(engine({ mode: 'testnet', scan: scan(1_000) }), 61_000).skewMs, 0);
  const s = seed(engine({ mode: 'replay', scan: null }), 61_000);
  assert.equal(s.skewMs, 0);
  assert.equal(reduceStream(s, event({ type: 'scan', data: scan(2_000) }, 63_000)).skewMs, 61_000);
  // the fake has no state action and no mode: its clock is the page’s
  assert.equal(reduceStream(initialStreamState(), event({ type: 'scan', data: scan(2_000) }, 63_000)).skewMs, 0);
});

test('a connection keeps why it failed until it works again', () => {
  let s = reduceStream(initialStreamState(), { kind: 'connection', source: 'sse', connection: 'retrying', error: 'GET /state: 500' });
  assert.equal(s.error, 'GET /state: 500');
  // the same word with a different reason is a change
  assert.notEqual(reduceStream(s, { kind: 'connection', source: 'sse', connection: 'retrying', error: 'other' }), s);
  s = reduceStream(s, { kind: 'connection', source: 'sse', connection: 'open' });
  assert.equal(s.error, null);
});

test('GET /state seeds the strategy decision, and a restarted engine without one clears it', () => {
  const decision = { action: 'hold', reason: 'XLM stays above 10 %', windowId: 'w1', heldId: 'w1', at: 7 } as const;
  let s = seed(engine({ decision }));
  assert.deepEqual(s.decision, decision);
  s = seed(engine({ decision: null }), 2000, s);
  assert.equal(s.decision, null);
});
