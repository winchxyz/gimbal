// The engine refuses every desk window with E_NO_DESK while no desk (no policy) is loaded. The Windows screen says that
// once, in plain words, and never offers to enter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLines, deskMissing, isEmpty, isEnterable, rowStatus } from './model.ts';
import { net } from './testing.ts';

const REFUSED = { code: 'E_NO_DESK', reason: 'no desk policy loaded yet' } as const;
const CHECK = { ok: false, text: 'No desk policy loaded yet: nothing can be entered' } as const;
const noDesk = (symbol: string, netAprPct: number) => net(symbol, netAprPct, { refused: REFUSED, checks: [CHECK] });

test('the rows say "No desk yet" in a calm word, not "Refused"', () => {
  const row = rowStatus(noDesk('SOL', 8.6));
  assert.deepEqual(row, { kind: 'nodesk', text: 'No desk yet', compact: 'No desk' });
  // another refusal keeps its own word
  assert.equal(rowStatus(net('ZRO', 35, { refused: { code: 'E_ORACLE_STALE', reason: 'no trusted price' } })).kind, 'refused');
  // a held window is held, whatever else the engine says about it
  assert.equal(rowStatus(net('DOGE', 13, { held: { since: 1 }, refused: REFUSED })).kind, 'held');
});

test('no desk means nothing is enterable, and the empty state is not shown: its reason would be wrong', () => {
  const windows = [noDesk('SOL', 8.6), noDesk('NEAR', 12)];
  assert.equal(windows.some(isEnterable), false);
  assert.equal(deskMissing(windows), true);
  assert.equal(isEmpty(windows, 5), false);
  // the same windows with a desk, all under the minimum, are the empty state
  const withDesk = [net('SOL', 2), net('NEAR', 3)];
  assert.equal(deskMissing(withDesk), false);
  assert.equal(isEmpty(withDesk, 5), true);
});

test('nothing scanned yet says nothing about a desk', () => {
  assert.equal(deskMissing(null), false);
  assert.equal(deskMissing([]), false);
});

test('the checks show the engine’s own line once, and not a contract refusal that was never made', () => {
  const lines = checkLines(noDesk('SOL', 8.6));
  assert.deepEqual(lines, [{ ...CHECK, blocking: true }]);
  assert.equal(lines.some((l) => /contract would refuse/i.test(l.text)), false);

  // an engine that sent no check lines still gets the reason
  const bare = checkLines(net('SOL', 8.6, { refused: REFUSED }));
  assert.equal(bare.length, 1);
  assert.match(bare[0]?.text ?? '', /no desk to trade it with yet/);
  assert.equal(bare[0]?.blocking, true);
});
