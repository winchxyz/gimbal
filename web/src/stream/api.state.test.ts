// The parts of the engine's HTTP side the stream and the manual buttons depend on: `GET /state`, `GET /journal?before=`,
// `POST /rotate` and `POST /close`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActionResult, parseEngineState, parseJournalPage } from './api.ts';
import { FAKE_STRATEGY } from './fake-windows.ts';

const entry = { id: 'e1', t: 1_000, kind: 'funding', summary: 'Funding paid', numbers: { usd: '0.03' }, tx: [] };

// What the engine sends before a desk exists: the scanner's windows and scan, the rules, an empty journal.
const bare = {
  mode: 'replay',
  windows: [],
  scan: { venues: 3, failed: [], at: 5 },
  strategy: FAKE_STRATEGY,
  desk: null,
  journal: [],
  rescue: null,
  setup: null,
  health: null,
  at: 9,
};

test('the engine’s state is read whole: its mode, the latest of each type, the rules and the journal', () => {
  const state = parseEngineState({ ...bare, journal: [entry] });
  assert.equal(state.mode, 'replay');
  assert.equal(state.at, 9);
  assert.deepEqual(state.windows, []);
  assert.equal(state.scan?.venues, 3);
  assert.equal(state.desk, null);
  assert.equal(state.strategy?.minNetAprPct, 5);
  assert.deepEqual(state.journal, [entry]);
  // null is "not produced yet", and a missing key reads the same
  const { setup: _setup, ...withoutSetup } = bare;
  assert.equal(parseEngineState({ ...withoutSetup, windows: null, strategy: null }).setup, null);
  assert.equal(parseEngineState({ ...bare, windows: null, strategy: null }).windows, null);
});

test('a state that cannot be drawn is refused with what is wrong', () => {
  assert.throws(() => parseEngineState(null), /not an object/);
  assert.throws(() => parseEngineState({ ...bare, mode: 'paper' }), /mode is not replay, testnet or mainnet/);
  assert.throws(() => parseEngineState({ ...bare, at: 'now' }), /at is not a number/);
  assert.throws(() => parseEngineState({ ...bare, windows: {} }), /windows is not a list/);
  assert.throws(() => parseEngineState({ ...bare, desk: [] }), /desk is not an object/);
  assert.throws(() => parseEngineState({ ...bare, strategy: { auto: 1 } }), /auto is not a boolean/);
  assert.throws(() => parseEngineState({ ...bare, journal: undefined }), /journal is not an array/);
  assert.throws(() => parseEngineState({ ...bare, journal: [{ ...entry, kind: 'teleport' }] }), /journal\[0\] has an unknown kind/);
});

test('an older page is a list of entries, and an empty one is the end', () => {
  assert.deepEqual(parseJournalPage([entry]), [entry]);
  assert.deepEqual(parseJournalPage([]), []);
  assert.throws(() => parseJournalPage({ journal: [] }), /GET \/journal: not an array/);
  assert.throws(() => parseJournalPage([{ ...entry, id: '' }]), /GET \/journal: entry\[0\] has no id/);
});

test('the engine’s answer to Rotate and Close is ok, or the reason a check refused', () => {
  assert.deepEqual(parseActionResult(200, { ok: true }, '/close'), { ok: true });
  assert.deepEqual(parseActionResult(200, { ok: false, reason: ' NEAR is vetoed ' }, '/rotate'), { ok: false, reason: 'NEAR is vetoed' });
  // today's engine answers 501 with the same shape while the strategy engine is not built
  assert.deepEqual(parseActionResult(501, { ok: false, reason: 'the strategy engine is not running yet' }, '/rotate'), {
    ok: false,
    reason: 'the strategy engine is not running yet',
  });
  assert.deepEqual(parseActionResult(200, { ok: false }, '/close'), { ok: false, reason: 'the engine did not say why' });
  // the engine’s refusal of the request itself: a foreign origin, a body that is not JSON
  assert.deepEqual(parseActionResult(403, { error: 'origin is not the dashboard’s' }, '/close'), { ok: false, reason: 'origin is not the dashboard’s' });
});

test('anything that is not an answer is an error, and an ok on a failed request is not trusted', () => {
  assert.throws(() => parseActionResult(502, null, '/close'), /POST \/close: 502 and no \{ ok \}/);
  assert.throws(() => parseActionResult(200, 'ok', '/close'), /no \{ ok \}/);
  assert.throws(() => parseActionResult(500, { ok: true }, '/rotate'), /POST \/rotate: 500/);
  assert.throws(() => parseActionResult(200, { ok: 'yes' }, '/rotate'), /no \{ ok \}/);
});
