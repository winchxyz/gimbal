import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDraft } from './fakes.ts';
import { applyEdit, contractRows, countText, draftOf, editText, engineRows, setAuto, sourceLine, unpricedLine } from './rules.ts';

const WORDS = 'I want steady income from funding, nothing fancy. Big coins plus DOGE and NEAR are fine. Never more than $1,500 a side and never more than 3x. If prices look weird, don’t trade. Money only ever comes back to me.';
const draft = () => draftOf(fakeDraft(WORDS));

test('numbers are edited as the owner reads them and stored as the contract wants them', () => {
  const d = draft();
  const set = (id: Parameters<typeof applyEdit>[1], raw: string) => {
    const r = applyEdit(d, id, raw);
    assert.ok('draft' in r, `${id} ${raw}`);
    return 'draft' in r ? r.draft : d;
  };
  assert.equal(set('size', '2,000').policy.max_notional_usd, 2000);
  assert.equal(set('band', '1.5').policy.price_band_bps, 150, 'a percent is stored as basis points');
  assert.equal(set('age', '30').policy.oracle_max_age_s, 30);
  assert.equal(set('transfer', '0.5').policy.max_transfer_cost_bps, 50);
  assert.equal(set('transfer-flat', '0.75').policy.max_transfer_cost_flat_e6, 750_000, 'dollars are stored as 1e-6');
  assert.equal(set('leverage', '2.5').strategy.maxLeverage, 2.5);
  assert.equal(set('rotate-gain', '4').strategy.rotate.minGainPts, 4);
  assert.equal(set('watch-distance', '20').strategy.risk.watchDistancePct, 20);
  assert.equal(set('stop', '25').strategy.stopDrawdownPct, 25);
  assert.equal(set('stop', '').strategy.stopDrawdownPct, null, 'an empty stop is off');
});

test('text that is not a number, or a fraction where the contract wants a whole number, changes nothing', () => {
  const d = draft();
  for (const [id, raw] of [['size', 'lots'], ['size', '12.5'], ['size', '-3'], ['size', ''], ['leg', '1e3'], ['age', '1.5']] as const) {
    const r = applyEdit(d, id, raw);
    assert.ok('error' in r, `${id} ${raw}`);
  }
  const r = applyEdit(d, 'size', 'lots');
  assert.ok('error' in r && /not a number/.test(r.error));
  assert.equal(d.policy.max_notional_usd, 1500, 'the draft is not touched');
});

test('editText shows a number as it was typed, with no trailing zeros', () => {
  const d = draft();
  assert.equal(editText(d, 'size'), '1500');
  assert.equal(editText(d, 'band'), '1');
  assert.equal(editText(d, 'transfer-flat'), '0.5');
  assert.equal(editText(d, 'stop'), '');
});

test('the contract part says where each number came from: the owner’s words, or NEAR AI', () => {
  const rows = contractRows(draft(), WORDS, 'demo-owner.near');
  const row = (id: string) => rows.find((r) => r.id === id)!;
  assert.equal(row('assets').value, 'BTC, ETH, SOL, DOGE, NEAR');
  assert.deepEqual(sourceLine(row('assets').source), { text: 'From “Big coins plus DOGE and NEAR are fine”', ai: false });
  assert.equal(row('venues').value, 'Hyperliquid, Orderly');
  assert.equal(sourceLine(row('venues').source).ai, true);
  assert.equal(row('size').value, 'up to $1,500');
  assert.equal(sourceLine(row('size').source).text, 'From “Never more than $1,500 a side and never more than 3x”');
  assert.equal(row('band').value, 'within 1% of the oracle, oracle under 900 s old');
  assert.equal(row('unpriced').value, 'not allowed');
  assert.equal(row('out').value, 'only to demo-owner.near');
  assert.match(sourceLine(row('out').source).text, /always/);
  assert.equal(rows.length, 9);
});

test('the engine part is separate and says the same about its numbers', () => {
  const rows = engineRows(draft(), WORDS);
  const row = (id: string) => rows.find((r) => r.id === id)!;
  assert.match(row('auto').value, /enters, exits and rotates by itself/);
  assert.equal(row('leverage').value, 'up to 3×');
  assert.equal(sourceLine(row('leverage').source).text, 'From “Never more than $1,500 a side and never more than 3x”');
  assert.equal(row('min-apr').value, '5% net a year after costs');
  assert.equal(sourceLine(row('min-apr').source).ai, true, '5% is not in the words');
  assert.equal(row('stop').value, 'off');
  assert.match(row('risk').value, /watch below 15%, rescue below 8%/);
  assert.match(engineRows(setAuto(draft(), false), WORDS)[0]!.value, /you act by hand/);
});

test('a form filled by hand credits nothing to NEAR AI or to words', () => {
  const hand = { ...draft(), model: null };
  for (const r of [...contractRows(hand, '', 'a.near'), ...engineRows(hand, '')]) assert.equal(sourceLine(r.source).ai, false, r.id);
  assert.equal(sourceLine(contractRows(hand, '', 'a.near')[2]!.source).text, 'Set by you');
});

test('unpriced assets are listed with the size cap and what it is worth', () => {
  const d = draft();
  d.policy.unpriced = [{ symbol: 'kPEPE', max_sz: '200000' }];
  d.policy.unpriced_max_notional_usd = 1500;
  assert.equal(unpricedLine(d.policy.unpriced[0]!, 0.0075), 'up to 200000 kPEPE (about $1,500)');
  assert.equal(unpricedLine(d.policy.unpriced[0]!, undefined), 'up to 200000 kPEPE');
  assert.equal(contractRows(d, WORDS, 'a.near').find((r) => r.id === 'unpriced')!.value, 'kPEPE, up to $1,500 an order');
  assert.equal(countText(1), '1 rule');
  assert.equal(countText(9), '9 rules');
});
