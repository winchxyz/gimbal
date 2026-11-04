// Live mainnet market data for the canary and final policies: Hyperliquid's perp meta (asset index, szDecimals),
// Phoenix's market configs (orderbook, base lot, tick) and Orderly's symbol list. Public reads, no keys. The policy
// the contract stores is checked against them here, so a wrong index or orderbook is refused before it is signed.

/** The canary contract's oracle assets (its deployed code's ORACLE_ASSETS), in the canary policy's order. */
export const CANARY_SYMBOLS = ['BTC', 'ETH', 'SOL', 'DOGE', 'LTC'];
/** The final contract's oracle assets (contract/core/src/oracle.rs ORACLE_ASSETS), in the final policy's order. */
export const FINAL_SYMBOLS = [...CANARY_SYMBOLS, 'XLM', 'ZEC'];

export const HL_API = 'https://api.hyperliquid.xyz';
export const PHOENIX_API = 'https://perp-api.phoenix.trade';
export const ORDERLY_API = 'https://api.orderly.org';

/**
 * The Orderly broker a mainnet contract must be created with: the engine's mainnet broker
 * (engine/src/scanner/config.ts ORDERLY_BROKERS.mainnet; a test checks they are the same). new() fixes it for the
 * contract's life, so any other id is refused.
 */
export const MAINNET_ORDERLY_BROKER = 'gimbal_dex';
/** Orderly's testnet broker (ORDERLY_BROKERS.testnet): refused by name on mainnet. */
const TESTNET_ORDERLY_BROKER = 'woofi_dex';

/** null when `id` is the mainnet broker; otherwise why it is refused. */
export function brokerIdProblem(id) {
  if (id === TESTNET_ORDERLY_BROKER) return `ORDERLY_BROKER_ID is ${TESTNET_ORDERLY_BROKER}, the testnet broker: a mainnet contract must use the engine's mainnet broker`;
  if (id !== MAINNET_ORDERLY_BROKER) {
    return `ORDERLY_BROKER_ID ${JSON.stringify(id)} is not the engine's mainnet broker ${MAINNET_ORDERLY_BROKER} (engine/src/scanner/config.ts ORDERLY_BROKERS.mainnet)`;
  }
  return null;
}

/**
 * The canary's limits (CLAUDE.md: a capped canary, at most 20 USDC notional per leg).
 *
 * Transfer cost: every quoted transfer must have minAmountOut >= amountIn - max(amountIn x bps, flat)
 * (contract/core/src/oneclick.rs check_cost), and fund_venue also needs >= 0.5 % between amountOut and
 * minAmountOut. The cost the check counts is therefore 1Click's fee plus the slippage room. Measured on
 * mainnet 2026-10-31 (oneclick-live.json, keyed, 100 bps slippage): 20 USDC from NEAR to HyperCore 0.519 USDC,
 * 10 USDC to the Orderly receiver 0.107; without an API key 1Click takes 0.2 % more. The old 100 bps / 0.5 USDC
 * refuses the 20 USDC transfer (oneclick.rs test the_cost_bound). 1 USDC flat covers every canary-size transfer
 * with room to spare (the bps share decides only above 33 USDC), and 300 bps bounds larger ones at 3 %.
 * The hourly budgets follow: fund_venue 4 x max(20 x 3 %, 1) = 4 USD, rescues max(20 x 3 %, 2 x 1) = 2 USD.
 */
export const CANARY_LIMITS = {
  max_notional_usd: 20,
  price_band_bps: 100,
  oracle_max_age_s: 900,
  rescue_cap_usd_per_hour: 20,
  max_transfer_cost_bps: 300,
  max_transfer_cost_flat_e6: 1_000_000,
};

/**
 * The final contract's limits: the canary's with rescue_cap_usd_per_hour 50. The contract counts both a Hyperliquid
 * rescue's hl_withdraw and its bridge against the cap, so at 20 no rescue out of Hyperliquid fits: its 1 USDC
 * withdraw fee needs about 10.5 USDC sent to stay within the engine's 10 % fee share, which weighs about 21 USD.
 * Every rescue pays only the desk's own pinned addresses, so the cap bounds what rescues may cost in fees, not what
 * could be taken. The engine's rescue sizes per route at these limits are in engine/src/rescue/plan.ts (out of
 * Hyperliquid 10.39 to 24.31 USD). The hourly rescue cost budget is 2 + 4 x 1 = 6 USD after C10 round 2:
 * max(50 x 3 %, 2 x 1) = 2, plus RESCUE_VENUE_FEES_PER_HOUR (4) fees of 1 USD each.
 */
export const FINAL_LIMITS = { ...CANARY_LIMITS, rescue_cap_usd_per_hour: 50 };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const POLICY_KEYS = [
  'hl_assets', 'phoenix_markets', 'orderly_symbols', 'max_notional_usd', 'price_band_bps', 'oracle_max_age_s',
  'rescue_cap_usd_per_hour', 'max_transfer_cost_bps', 'max_transfer_cost_flat_e6', 'unpriced', 'unpriced_max_notional_usd',
];

async function getJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * The three venues' market lists: { hl: [{ index, symbol, szDecimals, delisted }], phoenix: [{ symbol, orderbook,
 * baseLotsDecimals, tickSize, active }], orderly: [symbol] }.
 */
export async function readLive({ fetch: fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const [meta, markets, info] = await Promise.all([
    getJson(fetchImpl, `${HL_API}/info`, { method: 'POST', body: JSON.stringify({ type: 'meta' }) }),
    getJson(fetchImpl, `${PHOENIX_API}/v1/view/exchange/markets`),
    getJson(fetchImpl, `${ORDERLY_API}/v1/public/info`),
  ]);
  if (!Array.isArray(meta?.universe)) throw new Error('hyperliquid meta: no universe');
  if (!Array.isArray(markets)) throw new Error('phoenix markets: not a list');
  if (!Array.isArray(info?.data?.rows)) throw new Error('orderly public/info: no rows');
  return {
    hl: meta.universe.map((a, index) => ({ index, symbol: a.name, szDecimals: a.szDecimals, delisted: a.isDelisted === true })),
    phoenix: markets.map((m) => ({
      symbol: m.symbol, orderbook: m.marketPubkey, baseLotsDecimals: m.baseLotsDecimals, tickSize: m.tickSize, active: m.marketStatus === 'active',
    })),
    orderly: info.data.rows.map((r) => r.symbol),
  };
}

/**
 * A Phoenix market's units as the policy holds them: base_lot_e8 = base units per lot x 1e8
 * (10^(8 - baseLotsDecimals)), tick_e8 = USD per base unit per tick x 1e8 (tickSize quote lots of 1e-6 USDC per
 * base lot, so tickSize x 10^(baseLotsDecimals + 2)). Throws when either is not a whole number.
 */
export function phoenixUnits(baseLotsDecimals, tickSize) {
  if (!Number.isInteger(baseLotsDecimals) || Math.abs(baseLotsDecimals) > 18) throw new Error(`baseLotsDecimals ${baseLotsDecimals}`);
  if (!Number.isSafeInteger(tickSize) || tickSize <= 0) throw new Error(`tickSize ${tickSize}`);
  if (baseLotsDecimals > 8) throw new Error(`a base lot of 1e-${baseLotsDecimals} is under 1e-8 base units`);
  const base = 10n ** BigInt(8 - baseLotsDecimals);
  const e = baseLotsDecimals + 2;
  let tick;
  if (e >= 0) {
    tick = BigInt(tickSize) * 10n ** BigInt(e);
  } else {
    const div = 10n ** BigInt(-e);
    if (BigInt(tickSize) % div !== 0n) throw new Error(`a tick of ${tickSize} x 1e${e} is not a whole number of 1e-8 USD`);
    tick = BigInt(tickSize) / div;
  }
  if (base > BigInt(MAX_SAFE) || tick > BigInt(MAX_SAFE)) throw new Error('lot or tick over 2^53 - 1');
  return { base_lot_e8: Number(base), tick_e8: Number(tick) };
}

/**
 * A policy from live data with `limits` (the canary's by default): every one of `symbols` (oracle assets) on
 * Hyperliquid, and on Phoenix and Orderly where listed (Orderly as PERP_<X>_USDC exactly).
 */
export function buildPolicy(live, symbols = CANARY_SYMBOLS, limits = CANARY_LIMITS) {
  const hl_assets = symbols.map((s) => {
    const a = live.hl.find((x) => x.symbol === s && !x.delisted);
    if (a === undefined) throw new Error(`hyperliquid mainnet lists no active ${s} perp`);
    return { index: a.index, symbol: s, sz_decimals: a.szDecimals };
  });
  const phoenix_markets = symbols.flatMap((s) => {
    const m = live.phoenix.find((x) => x.symbol === s && x.active);
    return m === undefined ? [] : [{ symbol: s, orderbook: m.orderbook, ...phoenixUnits(m.baseLotsDecimals, m.tickSize) }];
  });
  const orderly_symbols = symbols.map((s) => `PERP_${s}_USDC`).filter((s) => live.orderly.includes(s));
  return {
    hl_assets,
    phoenix_markets,
    orderly_symbols,
    ...limits,
    unpriced: [],
    unpriced_max_notional_usd: 20,
  };
}

/** The policy as the repo keeps it: one line per asset, like tools/testnet-policy.json. */
export function formatPolicy(p) {
  const row = (o) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  const list = (xs) => (xs.length === 0 ? '[]' : `[\n${xs.map((x) => `    ${row(x)}`).join(',\n')}\n  ]`);
  const lines = POLICY_KEYS.map((k) => {
    const v = p[k];
    if (k === 'hl_assets' || k === 'phoenix_markets' || k === 'unpriced') return `  ${JSON.stringify(k)}: ${list(v)}`;
    if (Array.isArray(v)) return `  ${JSON.stringify(k)}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

const isUint = (v, max = MAX_SAFE) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const isSymbol = (s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 32 && /^[\x21-\x7e]+$/.test(s);
const B58_32 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function exactKeys(o, keys, where, out) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    out.push(`${where} is not an object`);
    return false;
  }
  for (const k of keys) if (!(k in o)) out.push(`${where}.${k} is missing`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) out.push(`${where}.${k} is not a policy field`);
  return true;
}

/** What the contract's Policy::validate would refuse, plus mainnet's oracle age floor; [] when none. */
export function policyShapeProblems(p) {
  const out = [];
  if (!exactKeys(p, POLICY_KEYS, 'policy', out)) return out;
  const list = (k) => {
    if (!Array.isArray(p[k])) {
      out.push(`${k} is not a list`);
      return [];
    }
    if (p[k].length > 32) out.push(`${k} has ${p[k].length} entries, over 32`);
    return p[k];
  };
  const unique = (k, xs, field) => {
    const seen = xs.map((x) => (field === null ? x : x?.[field]));
    if (new Set(seen).size !== seen.length) out.push(`${k}: two entries share the ${field ?? 'symbol'}`);
  };

  const hl = list('hl_assets');
  hl.forEach((a, i) => {
    if (!exactKeys(a, ['index', 'symbol', 'sz_decimals'], `hl_assets[${i}]`, out)) return;
    if (!isUint(a.index, 0xffffffff)) out.push(`hl_assets[${i}].index is not a u32`);
    if (!isSymbol(a.symbol)) out.push(`hl_assets[${i}].symbol is not a symbol`);
    if (!isUint(a.sz_decimals, 6)) out.push(`hl_assets[${i}].sz_decimals is not 0 to 6`);
  });
  unique('hl_assets', hl, 'index');
  unique('hl_assets', hl, 'symbol');

  const phx = list('phoenix_markets');
  phx.forEach((m, i) => {
    if (!exactKeys(m, ['symbol', 'orderbook', 'base_lot_e8', 'tick_e8'], `phoenix_markets[${i}]`, out)) return;
    if (!isSymbol(m.symbol)) out.push(`phoenix_markets[${i}].symbol is not a symbol`);
    if (typeof m.orderbook !== 'string' || !B58_32.test(m.orderbook)) out.push(`phoenix_markets[${i}].orderbook is not a base58 address`);
    if (!isUint(m.base_lot_e8) || m.base_lot_e8 === 0) out.push(`phoenix_markets[${i}].base_lot_e8 is not 1 to 2^53 - 1`);
    if (!isUint(m.tick_e8) || m.tick_e8 === 0) out.push(`phoenix_markets[${i}].tick_e8 is not 1 to 2^53 - 1`);
  });
  unique('phoenix_markets', phx, 'symbol');
  unique('phoenix_markets', phx, 'orderbook');

  const ord = list('orderly_symbols');
  ord.forEach((s, i) => {
    if (typeof s !== 'string' || !/^PERP_[A-Z0-9]+_USDC$/.test(s)) out.push(`orderly_symbols[${i}] is not PERP_<BASE>_USDC`);
  });
  unique('orderly_symbols', ord, null);

  const unp = list('unpriced');
  unp.forEach((u, i) => {
    if (!exactKeys(u, ['symbol', 'max_sz'], `unpriced[${i}]`, out)) return;
    if (!isSymbol(u.symbol)) out.push(`unpriced[${i}].symbol is not a symbol`);
    if (typeof u.max_sz !== 'string' || !/^(0|[1-9]\d*)(\.\d{0,7}[1-9])?$/.test(u.max_sz)) out.push(`unpriced[${i}].max_sz is not a canonical decimal`);
  });
  unique('unpriced', unp, 'symbol');

  if (!isUint(p.price_band_bps, 10_000) || p.price_band_bps === 0) out.push('price_band_bps is not 1 to 10000');
  if (!isUint(p.oracle_max_age_s, 3600) || p.oracle_max_age_s === 0) out.push('oracle_max_age_s is not 1 to 3600');
  else if (p.oracle_max_age_s < 900) out.push('oracle_max_age_s is under 900: on mainnet a fresh oracle price is up to 600 s old already');
  if (!isUint(p.max_transfer_cost_bps, 10_000)) out.push('max_transfer_cost_bps is not 0 to 10000');
  for (const k of ['max_notional_usd', 'rescue_cap_usd_per_hour', 'max_transfer_cost_flat_e6', 'unpriced_max_notional_usd']) {
    if (!isUint(p[k])) out.push(`${k} is not 0 to 2^53 - 1`);
  }
  return out;
}

/**
 * Where the policy disagrees with live mainnet data: a Hyperliquid index or szDecimals, a Phoenix orderbook, lot
 * or tick, an Orderly symbol that is not listed, or a market that is delisted. [] when none. A name listed twice
 * (an old delisted market and a new one) is checked against the active one, as buildPolicy picks it.
 */
export function livePolicyProblems(p, live) {
  const out = [];
  for (const a of p.hl_assets ?? []) {
    const l = live.hl.find((x) => x.symbol === a.symbol && !x.delisted) ?? live.hl.find((x) => x.symbol === a.symbol);
    if (l === undefined) {
      out.push(`hl_assets ${a.symbol}: Hyperliquid mainnet lists no such perp`);
      continue;
    }
    if (l.index !== a.index) out.push(`hl_assets ${a.symbol}: index ${a.index}, Hyperliquid says ${l.index}`);
    if (l.szDecimals !== a.sz_decimals) out.push(`hl_assets ${a.symbol}: sz_decimals ${a.sz_decimals}, Hyperliquid says ${l.szDecimals}`);
    if (l.delisted) out.push(`hl_assets ${a.symbol}: delisted on Hyperliquid`);
  }
  for (const m of p.phoenix_markets ?? []) {
    const l = live.phoenix.find((x) => x.symbol === m.symbol && x.active) ?? live.phoenix.find((x) => x.symbol === m.symbol);
    if (l === undefined) {
      out.push(`phoenix_markets ${m.symbol}: Phoenix mainnet lists no such market`);
      continue;
    }
    if (l.orderbook !== m.orderbook) out.push(`phoenix_markets ${m.symbol}: orderbook ${m.orderbook}, Phoenix says ${l.orderbook}`);
    if (!l.active) out.push(`phoenix_markets ${m.symbol}: not active on Phoenix`);
    let units = null;
    try {
      units = phoenixUnits(l.baseLotsDecimals, l.tickSize);
    } catch (e) {
      out.push(`phoenix_markets ${m.symbol}: Phoenix's lot or tick does not fit the policy (${e.message})`);
    }
    if (units !== null && units.base_lot_e8 !== m.base_lot_e8) out.push(`phoenix_markets ${m.symbol}: base_lot_e8 ${m.base_lot_e8}, Phoenix says ${units.base_lot_e8}`);
    if (units !== null && units.tick_e8 !== m.tick_e8) out.push(`phoenix_markets ${m.symbol}: tick_e8 ${m.tick_e8}, Phoenix says ${units.tick_e8}`);
  }
  for (const s of p.orderly_symbols ?? []) {
    if (!live.orderly.includes(s)) out.push(`orderly_symbols ${s}: Orderly mainnet lists no such symbol`);
  }
  return out;
}
