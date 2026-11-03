// The owner's words -> a PolicyDraft: the recorded reply to the fixed sentence, and every way a model answer is kept
// out of the policy (invented symbols, out-of-range numbers, wrong types, unpriced symbols nobody asked for).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContractPolicy, PolicyDraft, StrategyConfig } from '@gimbal/shared';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import { NearAiClient, NearAiUnavailable } from './client.ts';
import { PolicyDrafter, deskMarkets } from './draft-route.ts';
import type { DeskMarkets } from './policy-draft.ts';
import {
  MIN_ORACLE_AGE_S, ORACLE_ASSETS, SYSTEM_PROMPT, asksUnpriced, buildPolicyDraft, normalizeSymbol, parseDraftAnswer,
} from './policy-draft.ts';
import { ETH_BTC_SENTENCE, SYNTHETIC_ETH_BTC, ethBtcReplies } from './recorded.ts';
import { ALL_MARKETS, BTC_BOOK, ETH_BOOK, MARKET_LISTS, completion, fixedFetch, fixtureBody, marketReaders } from './test-helpers.ts';

const MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';

/** A draft from a model answer (the JSON object the model would return), on the full market lists. */
function draftOf(answer: Record<string, unknown>, ownerText = 'test', markets: DeskMarkets = ALL_MARKETS): PolicyDraft {
  return buildPolicyDraft(parseDraftAnswer(answer), { ownerText, markets, model: MODEL });
}

const ETH_BTC_POLICY: ContractPolicy = {
  hl_assets: [{ index: 1, symbol: 'ETH', sz_decimals: 4 }, { index: 0, symbol: 'BTC', sz_decimals: 5 }],
  phoenix_markets: [
    { symbol: 'ETH', orderbook: ETH_BOOK, base_lot_e8: 100_000, tick_e8: 10_000_000 },
    { symbol: 'BTC', orderbook: BTC_BOOK, base_lot_e8: 10_000, tick_e8: 100_000_000 },
  ],
  orderly_symbols: ['PERP_ETH_USDC', 'PERP_BTC_USDC'],
  max_notional_usd: 500,
  price_band_bps: 100,
  oracle_max_age_s: 900,
  rescue_cap_usd_per_hour: 500,
  unpriced: [],
  unpriced_max_notional_usd: 100,
  max_transfer_cost_bps: 100,
  max_transfer_cost_flat_e6: 500_000,
};

const ETH_BTC_STRATEGY: StrategyConfig = {
  ...DEFAULT_STRATEGY, minNetAprPct: 15, legUsd: 500, maxLeverage: 3, stopDrawdownPct: 10,
};

test('the fixed sentence, against its recorded reply, becomes the ETH/BTC draft (the synthetic reply has no notes)', async () => {
  const replies = ethBtcReplies();
  assert.equal(replies[0]!.synthetic, true);
  assert.ok(replies[0]!.file.endsWith(SYNTHETIC_ETH_BTC));
  const synthetic = fixtureBody(replies[0]!.file);
  assert.match(String(synthetic._comment), /^SYNTHETIC: .*NOT a recorded reply/);
  for (const { file, synthetic: isSynthetic } of replies) {
    const { fetch, sent } = fixedFetch(fixtureBody(file));
    const drafter = new PolicyDrafter({
      client: new NearAiClient({ apiKey: 'test-key-0123456789', fetch }),
      markets: deskMarkets(marketReaders().readers),
    });
    const draft = await drafter.draft(ETH_BTC_SENTENCE);
    assert.deepEqual(draft.policy, ETH_BTC_POLICY, file);
    assert.deepEqual(draft.strategy, ETH_BTC_STRATEGY, file);
    assert.equal(draft.model, MODEL);
    if (isSynthetic) assert.deepEqual(draft.notes, []);
    // The engine's own prompt, then the owner's words exactly.
    assert.deepEqual(sent[0]!.body.messages, [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: ETH_BTC_SENTENCE }]);
  }
});

test('only the contract\'s oracle assets can be priced', () => {
  assert.deepEqual(ORACLE_ASSETS, {
    ETH: 'eth.bridge.near', BTC: 'nbtc.bridge.near', SOL: '22.contract.portalbridge.near', DOGE: 'doge.omft.near', LTC: 'ltc.omft.near',
    XLM: 'xlm', ZEC: 'zec.omft.near',
  });
  // The prompt names the same seven (contract/core/src/oracle.rs ORACLE_ASSETS).
  assert.ok(SYSTEM_PROMPT.includes('Only ETH, BTC, SOL, DOGE, LTC, XLM and ZEC have an oracle price.'));
  assert.equal(normalizeSymbol('Stellar'), 'XLM');
  assert.equal(normalizeSymbol('zcash'), 'ZEC');
  assert.equal(normalizeSymbol(' $eth '), 'ETH');
  assert.equal(normalizeSymbol('Bitcoin'), 'BTC');
  assert.equal(normalizeSymbol('PERP_SOL_USDC'), 'SOL');
  assert.equal(normalizeSymbol('ETH-PERP'), 'ETH');
  assert.equal(normalizeSymbol('ETH; drop table'), null);
});

test('a symbol the model invents goes to the notes, never to the policy', () => {
  const draft = draftOf({ symbols: ['ETH', 'PEPE', 'eth', 'not a coin!'], max_notional_usd: 200 }, 'Trade ETH');
  assert.deepEqual(draft.policy.hl_assets.map((a) => a.symbol), ['ETH']);
  assert.deepEqual(draft.policy.phoenix_markets.map((m) => m.symbol), ['ETH']);
  assert.deepEqual(draft.policy.orderly_symbols, ['PERP_ETH_USDC']);
  assert.deepEqual(draft.policy.unpriced, []);
  assert.ok(!JSON.stringify(draft.policy).includes('PEPE'));
  assert.ok(draft.notes.some((n) => /^PEPE has no oracle price, so it is not in the policy/.test(n)), draft.notes.join('\n'));
  assert.ok(draft.notes.some((n) => /"not a coin!", which is not a ticker: left out/.test(n)));
  // An unpriced symbol the owner's words never asked for stays out too, whatever the model says.
  const sneaky = draftOf({ symbols: ['ETH'], unpriced: [{ symbol: 'HYPE', max_usd: 50 }] }, 'Trade ETH and HYPE');
  assert.deepEqual(sneaky.policy.unpriced, []);
  assert.ok(!sneaky.policy.hl_assets.some((a) => a.symbol === 'HYPE'));
  assert.ok(sneaky.notes.some((n) => /^HYPE: not added as unpriced, because your words do not ask for it without price protection/.test(n)));
});

test('an unpriced symbol enters only when the owner asks in so many words, with max_sz 0 and its USD cap in the notes', () => {
  const text = 'Trade ETH, and also HYPE without price protection, up to $50 per order';
  assert.equal(asksUnpriced(text, 'HYPE'), true);
  assert.equal(asksUnpriced(text, 'PEPE'), false);
  assert.equal(asksUnpriced('Trade HYPE', 'HYPE'), false);
  const draft = draftOf({ symbols: ['ETH', 'HYPE'], unpriced: [{ symbol: 'hype', max_usd: 50 }], max_notional_usd: 500 }, text);
  assert.deepEqual(draft.policy.unpriced, [{ symbol: 'HYPE', max_sz: '0' }]);
  assert.deepEqual(draft.policy.hl_assets.map((a) => a.symbol), ['ETH', 'HYPE']);
  // Phoenix and Orderly list no HYPE: said, not invented.
  assert.deepEqual(draft.policy.phoenix_markets.map((m) => m.symbol), ['ETH']);
  assert.ok(draft.notes.some((n) => /^HYPE has no oracle price: it is in policy\.unpriced with no price protection, capped at \$50 per order/.test(n)), draft.notes.join('\n'));
  assert.ok(draft.notes.some((n) => /^Phoenix lists no HYPE market/.test(n)));
  assert.ok(!draft.notes.some((n) => /^HYPE has no oracle price, so it is not in the policy/.test(n)));
  // A cap over the unpriced cap per leg is lowered to it; a priced symbol never becomes unpriced.
  const over = draftOf({ symbols: [], unpriced: [{ symbol: 'HYPE', max_usd: 5000 }, { symbol: 'ETH', max_usd: 10 }] }, 'HYPE and ETH unpriced');
  assert.deepEqual(over.policy.unpriced, [{ symbol: 'HYPE', max_sz: '0' }]);
  assert.ok(over.notes.some((n) => /HYPE: the cap of \$5000 is over the unpriced cap of \$100 per leg; lowered to \$100/.test(n)));
  assert.ok(over.notes.some((n) => /^ETH has an oracle price: it stays price-protected/.test(n)));
  assert.deepEqual(over.policy.hl_assets.map((a) => a.symbol), ['ETH', 'HYPE']);
});

test('out-of-range numbers are clamped or refused, and each says so in the notes', () => {
  const draft = draftOf({
    symbols: ['SOL'],
    max_notional_usd: 1e21,              // over 2^53 - 1: refused
    leg_usd: 500_000,                    // over the engine's 100 000, then over the policy cap
    max_leverage: 50,                    // over 10
    price_band_pct: 250,                 // over 100 %
    oracle_max_age_s: 86_400,            // over an hour
    stop_drawdown_pct: -5,               // not a loss: refused
    min_net_apr_pct: 5_000,              // over 1 000
    rescue_cap_usd_per_hour: 12.7,       // not whole: rounded down
    max_transfer_cost_flat_usd: -1,      // negative: refused
    watch_distance_pct: 5,               // inside the rescue distance: both back to the defaults
  });
  const p = draft.policy;
  const s = draft.strategy;
  assert.equal(p.max_notional_usd, 1000);
  assert.equal(p.price_band_bps, 10_000);
  assert.equal(p.oracle_max_age_s, 3_600);
  assert.equal(p.rescue_cap_usd_per_hour, 12);
  assert.equal(p.max_transfer_cost_flat_e6, 500_000);
  assert.equal(s.legUsd, 1000);
  assert.equal(s.maxLeverage, 10);
  assert.equal(s.stopDrawdownPct, 10);
  assert.equal(s.minNetAprPct, 1_000);
  assert.deepEqual(s.risk, DEFAULT_STRATEGY.risk);
  const expected = [
    /^policy\.max_notional_usd: 1e\+21 is over 2\^53 − 1, the largest number the contract takes; kept the default 1000\.$/,
    /^strategy\.legUsd: 500000 is over 100000, the most allowed; lowered to 100000\.$/,
    /^strategy\.legUsd: 100000 is over policy\.max_notional_usd 1000, the contract's cap per leg; lowered to 1000\.$/,
    /^strategy\.maxLeverage: 50 is over 10/,
    /^policy\.price_band_bps: 250 % is over 100 %, the most allowed; lowered to 10000 bps\.$/,
    /^policy\.oracle_max_age_s: 86400 is over 3600/,
    /^strategy\.stopDrawdownPct: -5 is not above 0 %; kept the default 10\.$/,
    /^strategy\.minNetAprPct: 5000 is over 1000/,
    /^policy\.rescue_cap_usd_per_hour: 12\.7 is not a whole number; rounded down to 12\.$/,
    /^policy\.max_transfer_cost_flat_e6: -1 USD is negative; kept the default 500000\.$/,
    /^strategy\.risk: a rescue at 8 % is not inside the watch at 5 %/,
  ];
  for (const re of expected) assert.ok(draft.notes.some((n) => re.test(n)), `${re}\n${draft.notes.join('\n')}`);
  assert.equal(draft.notes.length, expected.length, draft.notes.join('\n'));
  // Every u64 a draft holds is one JavaScript reads exactly.
  for (const v of [p.max_notional_usd, p.rescue_cap_usd_per_hour, p.max_transfer_cost_flat_e6, p.unpriced_max_notional_usd]) assert.ok(Number.isSafeInteger(v));
});

test('the oracle age: 900 s when unsaid, and a shorter one is raised to 900 s, since the oracle\'s own window is 10 min', () => {
  assert.equal(MIN_ORACLE_AGE_S, 900);
  assert.equal(draftOf({ symbols: ['ETH'] }).policy.oracle_max_age_s, 900);
  for (const asked of [1, 60, 120, 599.6, 899]) {
    const draft = draftOf({ symbols: ['ETH'], oracle_max_age_s: asked });
    assert.equal(draft.policy.oracle_max_age_s, 900, `asked ${asked}`);
    assert.deepEqual(draft.notes, [
      `policy.oracle_max_age_s: ${asked} s is under 900 s, and the oracle's own window is 10 min: a stored price is already that old, `
        + 'so every priced order would be refused; raised to 900.',
    ]);
  }
  for (const asked of [900, 1_800, 3_600]) {
    const draft = draftOf({ symbols: ['ETH'], oracle_max_age_s: asked });
    assert.deepEqual([draft.policy.oracle_max_age_s, draft.notes], [asked, []]);
  }
  const zero = draftOf({ symbols: ['ETH'], oracle_max_age_s: 0 });
  assert.deepEqual([zero.policy.oracle_max_age_s, zero.notes], [900, ['policy.oracle_max_age_s: 0 is not above 0 s; kept the default 900.']]);
});

test('small caps: a per-leg cap under the smallest order is raised, and the leg follows the cap', () => {
  const tiny = draftOf({ symbols: ['ETH'], max_notional_usd: 5 });
  assert.equal(tiny.policy.max_notional_usd, 10);
  assert.equal(tiny.strategy.legUsd, 10);
  assert.ok(tiny.notes.some((n) => /^policy\.max_notional_usd: 5 is under \$10/.test(n)));
  // The canary's cap: no leg size said, so the leg is the cap, without a note.
  const canary = draftOf({ symbols: ['ETH'], max_notional_usd: 20 });
  assert.equal(canary.strategy.legUsd, 20);
  assert.deepEqual(canary.notes, []);
  // "never stop" is no drawdown stop at all.
  assert.equal(draftOf({ symbols: ['ETH'], stop_drawdown_pct: 'none' }).strategy.stopDrawdownPct, null);
});

test('wrong types, unknown fields and the model\'s unmapped phrases are notes; nothing of them reaches the draft', () => {
  const draft = draftOf({
    symbols: ['ETH', 7],
    max_leverage: '3x',
    auto: 'yes',
    venues: ['hyperliquid', 'binance'],
    secret_field: { max_notional_usd: 1e9 },
    unmapped: ['only trade on weekdays', 42, 'x'.repeat(300)],
  });
  assert.equal(draft.strategy.maxLeverage, DEFAULT_STRATEGY.maxLeverage);
  assert.equal(draft.strategy.auto, false);
  assert.equal(draft.policy.max_notional_usd, 1000);
  assert.deepEqual(draft.policy.orderly_symbols, []);
  assert.deepEqual(draft.policy.phoenix_markets, []);
  assert.deepEqual(draft.policy.hl_assets.map((a) => a.symbol), ['ETH']);
  const expected = [
    /^The model returned fields a draft has no place for \(secret_field\): ignored\.$/,
    /^The model's symbols held entries that are not text: ignored\.$/,
    /^The model's max_leverage was "3x", not a number: ignored\.$/,
    /^The model's auto was "yes", not true or false: ignored\.$/,
    /^The model's unmapped held entries that are not text: ignored\.$/,
    /^Not a desk venue: "binance"/,
    /^Only Hyperliquid is allowed: a window needs a long and a short on two venues/,
    /^Not mapped: only trade on weekdays$/,
    /^Not mapped: x{200}…$/,
  ];
  for (const re of expected) assert.ok(draft.notes.some((n) => re.test(n)), `${re}\n${draft.notes.join('\n')}`);
  assert.equal(draft.notes.length, expected.length, draft.notes.join('\n'));
});

test('a reply with none of the draft\'s fields is not a draft: unavailable', () => {
  assert.throws(() => parseDraftAnswer({ answer: 'Sure! ETH and BTC.' }), (err: unknown) => err instanceof NearAiUnavailable && /not a draft/.test(err.message));
  assert.throws(() => parseDraftAnswer({}), NearAiUnavailable);
});

test('venue entries come only from the market lists: a list that cannot be read, or a market that is not listed, is a note', async () => {
  const { readers, count } = marketReaders(['phoenix']);
  const markets = deskMarkets(readers);
  const read = await markets();
  assert.equal(read.failed.phoenix, 'phoenix is down');
  const draft = draftOf({ symbols: ['ETH', 'DOGE', 'LTC'] }, 'test', read);
  assert.deepEqual(draft.policy.hl_assets, [{ index: 1, symbol: 'ETH', sz_decimals: 4 }, { index: 12, symbol: 'DOGE', sz_decimals: 0 }]);
  assert.deepEqual(draft.policy.phoenix_markets, []);
  assert.deepEqual(draft.policy.orderly_symbols, ['PERP_ETH_USDC', 'PERP_DOGE_USDC']);
  assert.ok(draft.notes.some((n) => /^Phoenix's market list could not be read \(phoenix is down\): its entries are left out/.test(n)), draft.notes.join('\n'));
  // LTC is delisted on Hyperliquid and missing on Orderly in these lists.
  assert.ok(draft.notes.some((n) => n === 'Hyperliquid lists no LTC market the desk can trade: left out there.'));
  assert.ok(draft.notes.some((n) => n === 'Orderly lists no LTC market the desk can trade: left out there.'));
  // Good lists are kept for the next draft; the failed one is read again.
  await markets();
  assert.deepEqual(count, { hyperliquid: 1, phoenix: 2, orderly: 1 });
  assert.equal(MARKET_LISTS.hyperliquid.length, 6);
});

test('the drafter asks nothing without a key', async () => {
  const { fetch, sent } = fixedFetch(completion({ symbols: ['ETH'] }));
  const { readers, count } = marketReaders();
  const drafter = new PolicyDrafter({ client: new NearAiClient({ apiKey: undefined, fetch }), markets: deskMarkets(readers) });
  await assert.rejects(drafter.draft('Trade ETH'), (err: unknown) => err instanceof NearAiUnavailable && /NEAR_AI_API_KEY is not set/.test(err.message));
  assert.equal(sent.length, 0);
  assert.deepEqual(count, {});
});
