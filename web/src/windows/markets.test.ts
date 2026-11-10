import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksSummary, closedGroups, coinsText, isOpenToDesk, marketsAnswer, marketsText, nettedFunding } from './markets.ts';
import { net, win } from './testing.ts';

const refused = (symbol: string, code: string, netAprPct = 30) => net(symbol, netAprPct, { refused: { code, reason: 'x' } });

test('open to the desk: tradable, not refused, not held back by the NEAR AI risk check; no desk yet and old numbers stay', () => {
  assert.equal(isOpenToDesk(net('MON', 28)), true);
  assert.equal(isOpenToDesk(net('MON', 28, { stale: true })), true, 'the list never drops a row for being from an earlier scan');
  assert.equal(isOpenToDesk(refused('MON', 'E_NO_DESK')), true);
  assert.equal(isOpenToDesk(refused('BONK', 'E_ASSET')), false);
  assert.equal(isOpenToDesk(net('X', 9, { veto: { verdict: 'veto', reasons: ['one-off spike'] } } as never)), false);
  assert.equal(isOpenToDesk(win({ symbol: 'XMR', tradable: false })), false);
  // The held pair stays in the list even when a new entry into it would be refused: its detail and Close stay reachable.
  assert.equal(isOpenToDesk(refused('MON', 'E_ORACLE_STALE', 30)), false);
  assert.equal(isOpenToDesk({ ...refused('MON', 'E_ORACLE_STALE', 30), held: { since: 1 } }), true);
  assert.ok(closedGroups([{ ...refused('MON', 'E_ORACLE_STALE', 30), held: { since: 1 } }]).every((g) => g.windows.length === 0));
});

test('everything else is grouped by a plain reason: your policy first, watch-only last, best first inside', () => {
  const groups = closedGroups([
    net('MON', 28),
    win({ symbol: 'XMR', tradable: false, grossAprPct: 40 }),
    refused('BONK', 'E_ASSET', 12),
    refused('PEPE', 'E_ASSET', 40),
    net('X', 9, { veto: { verdict: 'veto', reasons: [] } } as never),
    refused('WIF', 'E_ORACLE_STALE'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.reason, g.windows.map((w) => w.symbol)]),
    [
      ['Not allowed by your policy', ['PEPE', 'BONK']],
      ['No trusted price right now', ['WIF']],
      ['Held back by the NEAR AI risk check', ['X']],
      ['Watch-only: venues the desk cannot trade', ['XMR']],
    ],
  );
  assert.ok(groups.every((g) => !/E_|Refused ·|stale/.test(g.reason)), 'no codes, no internal words');
});

test('the sentence: the best open market after costs, or why there is none', () => {
  const best = marketsAnswer([net('MON', 28.4), net('ETH', 12), refused('PEPE', 'E_ASSET', 400)], 5);
  assert.equal(marketsText(best), 'MON pays the most: 28% a year after costs.');
  assert.equal(best.tone, 'up');
  assert.equal(marketsText(marketsAnswer([net('ETH', 3.2)], 5)), 'None pays your 5% minimum. The best, ETH, pays 3.2% a year.');
  // Open but too new to judge (the minutes after a restart): the sentence does not say none is open.
  assert.equal(marketsText(marketsAnswer([net('XPL', 95.6, { grossApr7dPct: null }), net('MORPHO', 50.6, { grossApr7dPct: null })], 5)), '2 markets are open to the desk, but their 7 days of funding are not read yet.');
  assert.equal(marketsText(marketsAnswer([net('XPL', 95.6, { grossApr7dPct: null })], 5)), 'One market is open to the desk, but its 7 days of funding are not read yet.');
  assert.equal(marketsText(marketsAnswer([net('ETH', -2)], null)), 'Every market costs more than it pays. ETH loses least: 2.0% a year.');
  // A loss is never said as pay, with a minimum set or not: the rate is printed without its sign.
  assert.equal(marketsText(marketsAnswer([net('DOGE', -10.2)], 5)), 'Every market costs more than it pays. DOGE loses least: 10% a year.');
  assert.equal(marketsAnswer([net('ETH', -2)], null).tone, 'down');
  assert.equal(marketsText(marketsAnswer([refused('PEPE', 'E_ASSET')], 5)), 'No market is open to the desk right now.');
  // Without a 7-day spread the engine never enters a window, so it is never the best.
  assert.equal(marketsText(marketsAnswer([net('NEW', 400, { grossApr7dPct: null }), net('ETH', 12)], 5)), 'ETH pays the most: 12% a year after costs.');
});

test('coins and checks in words', () => {
  assert.equal(coinsText([net('A', 1), net('B', 1), net('C', 1)]), 'A, B and C');
  assert.equal(coinsText([net('A', 1)]), 'A');
  assert.equal(coinsText(['A', 'B', 'C', 'D'].map((s) => net(s, 1)), 2), 'A, B and 2 more');
  assert.equal(checksSummary([{ ok: true }, { ok: true }, { ok: false }]), '2 of 3 checks passed');
  assert.equal(checksSummary([]), 'Not checked yet');
  assert.equal(checksSummary([{ ok: true }, { ok: false, text: '14-day history loading: the 7-day spread is in' }]), '1 of 2 checks passed · one waits for history');
  assert.equal(checksSummary([{ ok: false, text: '14-day history loading' }, { ok: false, text: 'Too small' }]), '0 of 2 checks passed');
});

test('with a pair held, the sentence is about what comes next to it', () => {
  const held = net('MON', 43, { id: 'mon-ph-hl', longVenue: 'phoenix', shortVenue: 'hyperliquid', held: { since: 1 } });
  const xpl = net('XPL', 40, { id: 'xpl-ph-hl' });
  assert.equal(marketsText(marketsAnswer([held, xpl], 5)), 'Next best is XPL at 40% a year. MON, held, still leads.');
  const mon2 = net('MON', 20, { id: 'mon-ph-or', longVenue: 'phoenix', shortVenue: 'orderly' });
  assert.equal(marketsText(marketsAnswer([held, mon2], 5)), 'Next best is MON on Phoenix and Orderly at 20% a year. MON, held, still leads.');
  assert.equal(marketsText(marketsAnswer([held, net('CAKE', 2, { id: 'c' })], 5)), 'MON, held, pays the most: 43% a year after costs.');
  assert.equal(marketsText(marketsAnswer([{ ...held, netAprPct: 30 }, xpl], 5)), 'XPL pays the most: 40% a year after costs. MON, held, pays 30%.');
});

test('the funding line is what the net was worked out on, so the three lines add up', () => {
  const w = net('MON', 43.8, { grossAprPct: 67, grossApr7dPct: 70, costs: { feesPct: 10, slippagePct: 5, basisPct: 4.3, rescueReservePct: 0 } });
  const f = nettedFunding(w);
  assert.ok(Math.abs(f.pct - 63.1) < 1e-9, 'net 43.8 plus 19.3 of costs, not the 7-day 70 nor this hour 67');
  assert.equal(f.multiDay, true);
  assert.equal(nettedFunding({ ...w, grossApr7dPct: null }).multiDay, false);
});
