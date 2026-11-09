import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrange,
  bestEnterable,
  bestNetAprPct,
  checkLines,
  failedScan,
  inTab,
  isBelow,
  isEmpty,
  pickSelection,
  rowStatus,
  sortWindows,
  stepSelection,
  totalCosts,
  untradableVenues,
  venuePair,
  watchOnlyVenues,
} from './model.ts';
import { net, win } from './testing.ts';

const ids = (rows: { symbol: string }[]) => rows.map((w) => w.symbol);

test('rows sort by net APR, highest first, and equal rows keep a stable order', () => {
  const rows = sortWindows([net('LTC', 6.9), net('ZRO', 35.2), net('BTC', 2.1), net('AAA', 6.9), net('ETH', -2.4)]);
  assert.deepEqual(ids(rows), ['ZRO', 'AAA', 'LTC', 'BTC', 'ETH']);
});

test('windows without a 7-day spread rank after the others, and are never the best', () => {
  // A new listing's hour stated as a year can be far above every real window; the engine does not enter it.
  const fresh = net('NEW', 480, { grossApr7dPct: null });
  const rows = [net('LTC', 6.9), fresh, net('ZRO', 35.2), net('OLD', 2, { grossApr7dPct: null })];
  assert.deepEqual(ids(sortWindows(rows)), ['ZRO', 'LTC', 'NEW', 'OLD']);
  assert.deepEqual(ids(arrange(rows, 'tradable', 5, null).rows), ['ZRO', 'LTC', 'NEW', 'OLD']);
  assert.equal(bestEnterable(rows.slice(0, 2).reverse())?.symbol, 'LTC');
  assert.equal(bestEnterable([fresh]), null);
  assert.equal(bestNetAprPct(rows), 35.2);
  assert.equal(bestNetAprPct([fresh]), null);
  assert.equal(bestNetAprPct(null), null);
  assert.equal(bestNetAprPct([]), null);
});

test('the tabs split tradable from watch-only, and watch-only rows rank by gross', () => {
  const windows = [
    net('SOL', 8.6),
    win({ symbol: 'XMR', tradable: false, grossAprPct: 55.1, netAprPct: 55.1 }),
    win({ symbol: 'WIF', tradable: false, grossAprPct: 27.8, netAprPct: 99 }),
  ];
  assert.deepEqual(ids(inTab(windows, 'tradable')), ['SOL']);
  assert.deepEqual(ids(sortWindows(inTab(windows, 'watch'))), ['XMR', 'WIF']);
});

test('rows under the minimum sit below the rule; the rule is drawn before the first of them', () => {
  const windows = [net('BTC', 2.1), net('SOL', 8.6), net('ETH', -2.4), net('DOGE', 13.8), net('EDGE', 5)];
  const a = arrange(windows, 'tradable', 5);
  assert.deepEqual(ids(a.rows), ['DOGE', 'SOL', 'EDGE', 'BTC', 'ETH']); // exactly at the minimum clears it
  assert.equal(a.ruleAt, 3);
  assert.equal(isBelow(net('X', 4.99), 5), true);
  assert.equal(isBelow(net('X', 5), 5), false);
});

test('no rule on the watch-only tab, none without a minimum, and one at the end when everything clears it', () => {
  const windows = [net('SOL', 8.6), win({ symbol: 'XMR', tradable: false })];
  assert.equal(arrange(windows, 'watch', 5).ruleAt, null);
  assert.equal(arrange(windows, 'tradable', null).ruleAt, null);
  assert.equal(arrange(windows, 'tradable', 5).ruleAt, 1);
  assert.equal(arrange([], 'tradable', 5).ruleAt, null);
});

test('a pinned row keeps its place while the others re-sort around it', () => {
  const before = arrange([net('A', 12), net('B', 10), net('C', 8), net('D', 6)], 'tradable', 5);
  assert.deepEqual(ids(before.rows), ['A', 'B', 'C', 'D']);
  // C is selected under the pointer, in slot 2; then D overtakes everything
  const later = [net('A', 12), net('B', 10), net('C', 8), net('D', 15)];
  const pinned = arrange(later, 'tradable', 5, { id: 'c-phoenix-orderly', slot: 2 });
  assert.deepEqual(ids(pinned.rows), ['D', 'A', 'C', 'B']);
  assert.equal(pinned.rows.indexOf(later[2]!), 2);
  // without the pointer the list settles into its sort order
  assert.deepEqual(ids(arrange(later, 'tradable', 5).rows), ['D', 'A', 'B', 'C']);
});

test('a pinned row stays on its side of the rule: when it falls under the minimum it sits next to the rule', () => {
  const windows = [net('A', 12), net('B', 9), net('C', 3), net('D', 2)];
  const out = arrange(windows, 'tradable', 5, { id: 'b-phoenix-orderly', slot: 1 });
  assert.deepEqual(ids(out.rows), ['A', 'B', 'C', 'D']);
  const dropped = [net('A', 12), net('B', 1), net('C', 3), net('D', 2)]; // B fell under the minimum while pinned at slot 1
  const next = arrange(dropped, 'tradable', 5, { id: 'b-phoenix-orderly', slot: 1 });
  assert.deepEqual(ids(next.rows), ['A', 'B', 'C', 'D']);
  assert.equal(next.ruleAt, 1);
  // pinned slot past the end is clamped, and an unknown id is ignored
  assert.deepEqual(ids(arrange(windows, 'tradable', 5, { id: 'a-phoenix-orderly', slot: 99 }).rows), ['B', 'A', 'C', 'D']);
  assert.deepEqual(ids(arrange(windows, 'tradable', 5, { id: 'nope', slot: 0 }).rows), ['A', 'B', 'C', 'D']);
});

test('status word: held wins, then the contract refusal, then the NEAR AI risk check, then watch-only', () => {
  const veto = { verdict: 'veto' as const, reasons: ['one-off spike', 'second'], model: 'm', at: 1 };
  const pass = { verdict: 'pass' as const, reasons: ['fine'], model: 'm', at: 1 };
  const refused = { code: 'E_ORACLE_STALE', reason: 'no trusted price' };
  assert.deepEqual(rowStatus(win({ held: { since: 1 }, refused, veto })), { kind: 'held', text: 'Held', compact: 'Held' });
  assert.deepEqual(rowStatus(win({ refused, veto })), {
    kind: 'refused',
    text: 'Refused · no trusted price',
    compact: 'Refused · no price', // a known code has a short name for the phone
  });
  assert.equal(rowStatus(win({ refused: { code: 'E_NEW', reason: 'something else' } })).compact, 'Refused · something else');
  assert.deepEqual(rowStatus(win({ veto })), { kind: 'veto', text: 'Risk check · one-off spike', compact: 'Risk check · one-off spike' });
  assert.deepEqual(rowStatus(win({ veto: pass })), { kind: 'none', text: '', compact: '' });
  assert.deepEqual(rowStatus(win({ tradable: false })), { kind: 'watch', text: 'Watch-only', compact: 'Watch-only' });
  assert.equal(rowStatus(win({ veto: { ...veto, reasons: [] } })).text, 'Risk check');
});

test('a stored price the open refreshes is a note on an enterable row, never a refusal', () => {
  const note = 'stored ETH price stale: refreshed at open';
  const w = win({ note });
  assert.deepEqual(rowStatus(w), { kind: 'note', text: 'Price is read again when it opens', compact: 'Price at open' });
  assert.equal(bestEnterable([w]), w, 'still the first window auto would open');
  // A refusal or the desk holding it still wins over the note.
  assert.equal(rowStatus(win({ note, refused: { code: 'E_SIZE', reason: 'leg over the cap' } })).kind, 'refused');
  assert.equal(rowStatus(win({ note, held: { since: 1 } })).kind, 'held');
});

test('empty: nothing open to the desk clears the minimum, however high a refused or risk-checked row is', () => {
  const refused = { code: 'E_ORACLE_STALE', reason: 'no trusted price' };
  const veto = { verdict: 'veto' as const, reasons: ['spike'], model: 'm', at: 1 };
  const rows = [net('ZRO', 35.2, { refused }), net('AVAX', 9.1, { veto }), net('BTC', 2.1), net('ETH', -2.4)];
  assert.equal(isEmpty(rows, 5), true);
  assert.equal(bestEnterable(rows)?.symbol, 'BTC');
  assert.equal(isEmpty([...rows, net('SOL', 8.6)], 5), false);
  assert.equal(isEmpty(rows, null), false); // without a minimum there is no judging
  assert.equal(isEmpty([net('LOW', 1, { held: { since: 1 } }), ...rows], 5), false); // holding something is not "nothing"
  assert.equal(isEmpty([], 5), true);
  assert.equal(isEmpty([win({ symbol: 'XMR', tradable: false, netAprPct: 50 })], 5), true);
  assert.equal(bestEnterable([]), null);
});

test('selection: the one asked for, else the held one, else the first; arrows stop at the ends', () => {
  const rows = [net('A', 12), net('B', 10, { held: { since: 1 } }), net('C', 8)];
  assert.equal(pickSelection(rows, 'c-phoenix-orderly'), 'c-phoenix-orderly');
  assert.equal(pickSelection(rows, 'gone'), 'b-phoenix-orderly');
  assert.equal(pickSelection(rows, null), 'b-phoenix-orderly');
  assert.equal(pickSelection([net('A', 1), net('B', 2)], null), 'a-phoenix-orderly');
  assert.equal(pickSelection([], null), null);

  assert.equal(stepSelection(rows, 'b-phoenix-orderly', 1), 'c-phoenix-orderly');
  assert.equal(stepSelection(rows, 'c-phoenix-orderly', 1), 'c-phoenix-orderly');
  assert.equal(stepSelection(rows, 'a-phoenix-orderly', -1), 'a-phoenix-orderly');
  assert.equal(stepSelection(rows, null, 1), 'a-phoenix-orderly');
  assert.equal(stepSelection(rows, 'gone', -1), 'c-phoenix-orderly');
  assert.equal(stepSelection([], null, 1), null);
});

test('venues: names, the ones the desk cannot trade, and the watch-only count', () => {
  const w = win({ longVenue: 'lighter', shortVenue: 'hyperliquid' });
  assert.equal(venuePair(w), 'Lighter / Hyperliquid');
  assert.deepEqual(untradableVenues(w), ['Lighter']);
  assert.deepEqual(untradableVenues(win({ longVenue: 'gmx', shortVenue: 'dydx' })), ['GMX', 'dYdX']);
  assert.deepEqual(untradableVenues(win()), []);
  assert.equal(watchOnlyVenues({ venues: 32, failed: [], at: 1 }), 29);
  assert.equal(watchOnlyVenues(null), null);
});

test('costs add up the way the row shows them', () => {
  assert.ok(Math.abs(totalCosts(win()) - 3.3) < 1e-9);
});

test('a failed scan names the venues and the oldest stale read; a clean scan says nothing', () => {
  const windows = [win({ stale: true, updatedAt: 500 }), win({ symbol: 'B', stale: true, updatedAt: 300 }), win({ symbol: 'C', updatedAt: 900 })];
  const f = failedScan({ venues: 32, failed: ['phoenix', 'lighter', 'paradex'], at: 1000 }, windows);
  assert.equal(f?.headline, '3 of 32 venues didn’t answer');
  assert.deepEqual(f?.venues, ['Phoenix', 'Lighter', 'Paradex']);
  assert.equal(f?.since, 300);
  assert.equal(failedScan({ venues: 32, failed: ['x'], at: 1000 }, [])?.since, 1000);
  assert.equal(failedScan({ venues: 32, failed: [], at: 1 }, windows), null);
  assert.equal(failedScan(null, windows), null);
});

test('checks: NEAR AI first, then the refusal, then the engine; the first failing line is the reason', () => {
  const lines = checkLines(
    win({
      veto: { verdict: 'veto', reasons: ['one-off spike', 'The median gap is 1.2%'], model: 'm', at: 1 },
      refused: { code: 'E_ASSET', reason: 'not in your policy' },
      checks: [{ ok: true, text: 'Oracle price 9 s old' }, { ok: false, text: 'Rescue path is down' }],
    }),
  );
  assert.deepEqual(lines.map((l) => l.ok), [false, false, true, false]);
  assert.deepEqual(lines.map((l) => l.blocking), [true, false, false, false]);
  assert.equal(lines[0]?.text, 'The NEAR AI risk check refused it. One-off spike. The median gap is 1.2%.');
  assert.equal(lines[1]?.text, 'The contract would refuse it (E_ASSET): Not in your policy');

  const passing = checkLines(win({ veto: { verdict: 'pass', reasons: ['Deepest window on the list.'], model: 'm', at: 1 }, checks: [{ ok: true, text: 'Fine' }] }));
  assert.equal(passing[0]?.text, 'NEAR AI: Deepest window on the list.');
  assert.ok(passing.every((l) => l.ok && !l.blocking));
  assert.deepEqual(checkLines(win()), []);
});
