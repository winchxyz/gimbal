#!/usr/bin/env node
// Edits a live desk's policy by appending to it (tools/mainnet/README.md, "Allowing a token without an oracle price"):
//
//   node tools/mainnet/set-policy.mjs <contract> <desk_id> [--add-unpriced SYM[,SYM...] --venues hl,orderly|hl,phoenix
//     --usd <cap per symbol>] [--unpriced-cap-usd N] [--key-file <owner key json>] [--send]
//
// The live policy is read with get_desk, never from a file. --add-unpriced appends, for each symbol: its Hyperliquid
// perp (index and szDecimals from Hyperliquid's live meta), PERP_<SYM>_USDC when Orderly lists it and the Phoenix
// market when Phoenix lists it (only for the venues --venues names), and an `unpriced` entry whose max_sz is --usd
// worth at Hyperliquid's live mark, rounded down to the coarsest lot of those venues. --unpriced-cap-usd sets
// unpriced_max_notional_usd. Nothing existing is ever removed or changed: the contract refuses every order on a
// symbol missing from a venue list, reduce-only closes included (E_ASSET), so a removal could strand an open position.
//
// Default: a dry run. It prints the live policy's sha256, every added field, max_sz with the mark and USD it is worth,
// the full set_policy args, the signer, the deposit and the gas, and what changes for the engine. --send reads the
// owner's key file, only then, checks it is a full-access key of the desk's owner, refuses in a linked git worktree,
// signs one set_policy, waits for final and reads get_desk after: the new policy must be the planned one exactly.

import { createHash } from 'node:crypto';
import { UsageError, isMain, parseFlags, run } from './cli.mjs';
import { sendRefusal } from './checks.mjs';
import { wasmExports } from './deploy.mjs';
import { contractConfigProblems } from './desk.mjs';
import { DESK_ID, eventsOf, parseUsdc, summaryBlock, usdcText } from './money.mjs';
import {
  NO_CODE, ROOT, YOCTO_PER_BYTE, act, describeTx, feesOf, freeBalance, fullAccessVerdict, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp,
  panicOf, readKeyFile, tgasText, txGasCap, txLink,
} from './near.mjs';
import { FINAL_SYMBOLS, HL_API, ORDERLY_API, livePolicyProblems, phoenixUnits, policyShapeProblems, readLive } from './venues.mjs';

const USAGE = `usage: node tools/mainnet/set-policy.mjs <contract> <desk_id> [--add-unpriced SYM[,SYM...] --venues hl,orderly|hl,phoenix --usd <cap per symbol>]
         [--unpriced-cap-usd N] [--key-file <owner key json>] [--send]
  default: dry run (reads the live policy and public venue data, prints the set_policy call; no key needed)
  the tool only appends: it never removes or changes an existing entry of the policy`;
const SPEC = {
  '--add-unpriced': 'value', '--venues': 'value', '--usd': 'value', '--unpriced-cap-usd': 'value', '--key-file': 'value', '--send': 'switch',
  // Named only to refuse them with the reason (parsed as switches so the refusal comes before anything else).
  '--remove': 'switch', '--remove-unpriced': 'switch',
};

/** The contract's oracle assets (contract/core/src/oracle.rs ORACLE_ASSETS): priced, so never added as unpriced. */
export const ORACLE_ASSETS = [...FINAL_SYMBOLS].sort();
/** Policy::MAX_LIST_LEN. */
export const MAX_LIST_LEN = 32;
/** set_policy validates a policy of at most 4 x 32 entries and writes one desk record: far under this. */
export const SET_POLICY_TGAS = 50n;
/** Bytes added to the estimated growth before the deposit is rounded up to 0.001 NEAR; the contract refunds the rest. */
export const STORAGE_MARGIN_BYTES = 500n;
export const VENUES = ['hl', 'orderly', 'phoenix'];
const VENUE_NAMES = { hl: 'Hyperliquid', orderly: 'Orderly', phoenix: 'Phoenix' };
const LISTS = ['hl_assets', 'phoenix_markets', 'orderly_symbols', 'unpriced'];
const E8 = 100_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const REMOVE_REFUSAL = 'set-policy.mjs never removes or changes an existing policy entry: the contract refuses every order on a symbol '
  + 'missing from a venue list, reduce-only closes included (E_ASSET), so removing a symbol with an open position would strand it. '
  + 'Close the position first; a removal is a separate, reviewed change';

// --- decimals ---

/** "132.63" or "80500.0" -> units of 1e-8 (bigint); digits with an optional fraction of at most 8 significant decimals. */
export function decimalE8(text, what = 'value') {
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) throw new Error(`${what} ${JSON.stringify(text)} is not a decimal`);
  const [whole, f = ''] = text.split('.');
  const frac = f.replace(/0+$/, '');
  if (frac.length > 8) throw new Error(`${what} ${text} has more than 8 decimals`);
  return BigInt(whole) * E8 + BigInt(frac.padEnd(8, '0') || '0');
}

/** Units of 1e-8 as the contract's canonical decimal: no leading zero, no trailing zero after the dot. */
export function e8Text(v) {
  const n = BigInt(v);
  const frac = (n % E8).toString().padStart(8, '0').replace(/0+$/, '');
  return `${n / E8}${frac === '' ? '' : `.${frac}`}`;
}

/** A venue's float (Orderly's base_tick 0.1) as units of 1e-8; refused unless it is a whole number of them. */
export function numberE8(x, what = 'value') {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) throw new Error(`${what} ${JSON.stringify(x)} is not a positive number`);
  const v = Math.round(x * 1e8);
  if (v < 1 || Math.abs(x * 1e8 - v) > 1e-6 + v * 1e-12) throw new Error(`${what} ${x} is not a whole number of 1e-8`);
  return BigInt(v);
}

/** decimal.rs parse_e8's canonical form: what the contract accepts as max_sz. */
export const isCanonicalDecimal = (s) => typeof s === 'string' && /^(0|[1-9]\d*)(\.\d{0,7}[1-9])?$/.test(s);

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

/**
 * The size cap of an unpriced symbol, in units of 1e-8: `usdE6` (USD x 1e6) at the mark (USD x 1e8), rounded down
 * to a whole number of `lotE8` (the lots of every venue the symbol trades on, so each venue can fill it exactly).
 */
export function maxSzE8(usdE6, markE8, lotE8) {
  if (markE8 <= 0n) throw new Error('a mark of 0');
  if (lotE8 <= 0n) throw new Error('a lot of 0');
  const units = (BigInt(usdE6) * 10n ** 10n) / markE8;
  return (units / lotE8) * lotE8;
}

/** USD x 1e6 that `szE8` base units are worth at `markE8`, rounded down. */
export const worthE6 = (szE8, markE8) => (szE8 * markE8) / 10n ** 10n;

// --- arguments ---

/** Why `s` cannot be added as an unpriced symbol, or null. */
export function addSymbolProblem(s) {
  if (/^k[A-Z0-9]/.test(s) || /^1000/.test(s)) {
    return `${s} is a k- or 1000-prefixed name: one unit is 1000 tokens on some venues and 1 on others (Hyperliquid kPEPE, Orderly `
      + 'PERP_1000PEPE_USDC), so one max_sz cannot mean the same size on every venue';
  }
  if (!/^[A-Z0-9]{1,22}$/.test(s)) return `${JSON.stringify(s)} is not 1 to 22 characters of A-Z and 0-9 (PERP_<SYM>_USDC must fit 32)`;
  if (ORACLE_ASSETS.includes(s)) {
    return `${s} has an oracle price in this contract (ORACLE_ASSETS: ${ORACLE_ASSETS.join(', ')}): add it as a priced asset with its price band, not as unpriced`;
  }
  return null;
}

export function parseSetPolicyArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (values['--remove'] || values['--remove-unpriced']) throw new UsageError(REMOVE_REFUSAL);
  if (positional.length < 2) throw new UsageError('the contract and the desk id are required');
  if (positional.length > 2) throw new UsageError(`unexpected argument ${positional[2]}`);
  const [contract, deskId] = positional;
  try {
    mainnetId(contract, 'contract');
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);

  const adding = values['--add-unpriced'] !== undefined;
  let symbols = [];
  let venues = [];
  let usdE6 = null;
  if (adding) {
    symbols = values['--add-unpriced'].split(',').map((s) => s.trim());
    if (symbols.some((s) => s === '')) throw new UsageError('--add-unpriced has an empty symbol');
    if (new Set(symbols).size !== symbols.length) throw new UsageError('--add-unpriced names a symbol twice');
    if (values['--venues'] === undefined) throw new UsageError('--add-unpriced needs --venues (hl,orderly or hl,phoenix)');
    if (values['--usd'] === undefined) throw new UsageError('--add-unpriced needs --usd, the cap per symbol in USD');
    venues = values['--venues'].split(',').map((v) => v.trim());
    const unknown = venues.filter((v) => !VENUES.includes(v));
    if (unknown.length > 0) throw new UsageError(`--venues: unknown venue ${unknown.join(', ')} (hl, orderly, phoenix)`);
    if (new Set(venues).size !== venues.length) throw new UsageError('--venues names a venue twice');
    if (!venues.includes('hl') || venues.length < 2) throw new UsageError('--venues must be hl plus orderly and/or phoenix: a pair needs Hyperliquid and one more venue');
    try {
      usdE6 = parseUsdc(values['--usd'], '--usd');
    } catch (e) {
      throw new UsageError(e.message);
    }
  } else if (values['--venues'] !== undefined || values['--usd'] !== undefined) {
    throw new UsageError('--venues and --usd go with --add-unpriced');
  }
  let unpricedCap = null;
  if (values['--unpriced-cap-usd'] !== undefined) {
    const t = values['--unpriced-cap-usd'];
    if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) throw new UsageError(`--unpriced-cap-usd ${JSON.stringify(t)} is not a whole number of USD`);
    unpricedCap = Number(t);
  }
  if (!adding && unpricedCap === null) throw new UsageError('nothing to change: give --add-unpriced and/or --unpriced-cap-usd');
  const send = values['--send'] === true;
  if (send && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: only the desk owner can set its policy');
  return { contract, deskId, symbols, venues, usdE6, unpricedCap, keyFile: values['--key-file'] ?? null, send };
}

// --- the policy ---

const POLICY_ORDER = [
  'hl_assets', 'phoenix_markets', 'orderly_symbols', 'max_notional_usd', 'price_band_bps', 'oracle_max_age_s', 'rescue_cap_usd_per_hour',
  'max_transfer_cost_bps', 'max_transfer_cost_flat_e6', 'unpriced', 'unpriced_max_notional_usd', 'max_hourly_notional_usd',
];
const ENTRY_ORDER = { hl_assets: ['index', 'symbol', 'sz_decimals'], phoenix_markets: ['symbol', 'orderbook', 'base_lot_e8', 'tick_e8'], unpriced: ['symbol', 'max_sz'] };

/**
 * null when the policy's JSON has the field order of contract/core/src/policy.rs Policy (and its entries'): then
 * sha256(JSON.stringify(policy)) is the contract's policy_sha256 (contract/src/desk.rs). Otherwise why not.
 */
export function policyOrderProblem(p) {
  const keys = Object.keys(p ?? {});
  const want = POLICY_ORDER.filter((k) => k !== 'max_hourly_notional_usd' || k in p);
  if (JSON.stringify(keys) !== JSON.stringify(want)) return `its fields are ${keys.join(', ')}, not Policy's order`;
  // serde skips a None max_hourly_notional_usd; a null in the JSON is not what the contract writes.
  if (p.max_hourly_notional_usd === null) return 'max_hourly_notional_usd is null (the contract leaves it out)';
  for (const [list, order] of Object.entries(ENTRY_ORDER)) {
    for (const e of p[list]) if (JSON.stringify(Object.keys(e)) !== JSON.stringify(order)) return `a ${list} entry's fields are not in order`;
  }
  return null;
}

export const policySha256 = (p) => createHash('sha256').update(JSON.stringify(p)).digest('hex');

/** The Borsh size of a Policy (how the contract stores it in the desk record), in bytes. */
export function policyBorshBytes(p) {
  const str = (s) => 4 + Buffer.byteLength(s);
  let n = 4 + p.hl_assets.reduce((s, a) => s + 4 + str(a.symbol) + 1, 0);
  n += 4 + p.phoenix_markets.reduce((s, m) => s + str(m.symbol) + str(m.orderbook) + 8 + 8, 0);
  n += 4 + p.orderly_symbols.reduce((s, x) => s + str(x), 0);
  n += 8 + 4 + 4 + 8 + 4 + 8; // max_notional_usd .. max_transfer_cost_flat_e6
  n += 4 + p.unpriced.reduce((s, u) => s + str(u.symbol) + str(u.max_sz), 0);
  n += 8; // unpriced_max_notional_usd
  n += p.max_hourly_notional_usd === undefined || p.max_hourly_notional_usd === null ? 1 : 9;
  return n;
}

/**
 * The deposit to attach: the storage the larger policy adds (`growthBytes`) plus STORAGE_MARGIN_BYTES at `bytePrice`,
 * rounded up to 0.001 NEAR. set_policy keeps exactly what the storage took (charge_storage) and refunds the rest.
 */
export function storageDeposit(growthBytes, bytePrice = YOCTO_PER_BYTE) {
  const grow = BigInt(Math.max(growthBytes, 0));
  const raw = (grow + STORAGE_MARGIN_BYTES) * BigInt(bytePrice);
  const step = 10n ** 21n;
  return ((raw + step - 1n) / step) * step;
}

/** What the contract's Policy::validate_for(Mainnet) would refuse (venues.mjs policyShapeProblems, ported), [] when none. */
export function validateForProblems(p) {
  const { max_hourly_notional_usd: hourly, ...rest } = p;
  const out = policyShapeProblems(rest);
  if (hourly !== undefined && hourly !== null && !(Number.isSafeInteger(hourly) && hourly >= 0)) out.push('max_hourly_notional_usd is not 0 to 2^53 - 1');
  (Array.isArray(p.unpriced) ? p.unpriced : []).forEach((u, i) => {
    if (isCanonicalDecimal(u?.max_sz) && decimalE8(u.max_sz) > MAX_SAFE * E8) out.push(`unpriced[${i}].max_sz is over 2^53 - 1 base units`);
  });
  return out;
}

const label = (k, e) => (k === 'orderly_symbols' ? e : e?.symbol ?? JSON.stringify(e));

/**
 * Where `after` is not `before` with entries appended: a field or entry removed, an entry changed or moved, a limit
 * changed (unpriced_max_notional_usd only when `capChange`). [] when it only appends.
 */
export function additionProblems(before, after, { capChange = false } = {}) {
  const out = [];
  for (const k of Object.keys(before)) if (!(k in after)) out.push(`${k} would be removed`);
  for (const k of Object.keys(after)) if (!(k in before)) out.push(`${k} would be added as a new field`);
  for (const k of Object.keys(before)) {
    if (!(k in after)) continue;
    if (LISTS.includes(k)) {
      const a = before[k] ?? [];
      const b = after[k] ?? [];
      a.forEach((e, i) => {
        if (JSON.stringify(e) !== JSON.stringify(b[i])) out.push(`${k}[${i}] ${label(k, e)} would be removed or changed: this tool only appends`);
      });
    } else if (JSON.stringify(before[k]) !== JSON.stringify(after[k]) && !(capChange && k === 'unpriced_max_notional_usd')) {
      out.push(`${k} would change from ${JSON.stringify(before[k])} to ${JSON.stringify(after[k])}`);
    }
  }
  return out;
}

/** The symbols a policy names anywhere. */
function policySymbols(p) {
  return new Set([
    ...p.hl_assets.map((a) => a.symbol), ...p.phoenix_markets.map((m) => m.symbol), ...p.unpriced.map((u) => u.symbol),
    ...p.orderly_symbols.map((s) => /^PERP_(.+)_USDC$/.exec(s)?.[1] ?? s),
  ]);
}

/**
 * The new policy: `policy` (the live one) with every symbol of `a` appended, and the unpriced cap when given. `market`
 * is readMarket's. Throws with every reason when anything is refused. Returns { next, add, rows }.
 */
export function planPolicy(policy, a, market) {
  const problems = [];
  const add = { hl_assets: [], phoenix_markets: [], orderly_symbols: [], unpriced: [] };
  const rows = [];
  const present = policySymbols(policy);
  for (const s of a.symbols) {
    const why = addSymbolProblem(s);
    if (why !== null) {
      problems.push(why);
      continue;
    }
    if (present.has(s)) {
      problems.push(`${s} is already in the live policy: this tool only appends new symbols and never changes an existing entry`);
      continue;
    }
    const hl = market.live.hl.find((x) => x.symbol === s && !x.delisted);
    if (hl === undefined) {
      problems.push(`${s}: Hyperliquid mainnet lists no active ${s} perp`);
      continue;
    }
    const ctx = market.marks.get(s);
    if (ctx === undefined || ctx.index !== hl.index || typeof ctx.markPx !== 'string') {
      problems.push(`${s}: Hyperliquid's mark read does not match its meta (index ${hl.index}); run again`);
      continue;
    }
    let markE8;
    try {
      markE8 = decimalE8(ctx.markPx, `${s} mark`);
    } catch (e) {
      problems.push(e.message);
      continue;
    }
    if (markE8 === 0n) {
      problems.push(`${s}: Hyperliquid's mark is 0`);
      continue;
    }
    const lots = [{ venue: 'Hyperliquid', lotE8: 10n ** BigInt(8 - hl.szDecimals), why: `szDecimals ${hl.szDecimals}` }];
    const missing = [];
    let orderly = null;
    let phoenix = null;
    let priceRange = null;
    if (a.venues.includes('orderly')) {
      const sym = `PERP_${s}_USDC`;
      const row = market.orderly.get(sym);
      if (row !== undefined && market.live.orderly.includes(sym) && (row.status === undefined || row.status === 'ACTIVE')) {
        try {
          lots.push({ venue: 'Orderly', lotE8: numberE8(row.base_tick, `${sym} base_tick`), why: `base_tick ${row.base_tick}` });
          orderly = sym;
          priceRange = typeof row.price_range === 'number' ? row.price_range : null;
        } catch (e) {
          problems.push(e.message);
          continue;
        }
      } else {
        missing.push('Orderly');
      }
    }
    if (a.venues.includes('phoenix')) {
      const m = market.live.phoenix.find((x) => x.symbol === s && x.active);
      if (m !== undefined) {
        try {
          const units = phoenixUnits(m.baseLotsDecimals, m.tickSize);
          phoenix = { symbol: s, orderbook: m.orderbook, ...units };
          lots.push({ venue: 'Phoenix', lotE8: BigInt(units.base_lot_e8), why: `baseLotsDecimals ${m.baseLotsDecimals}` });
        } catch (e) {
          problems.push(`${s}: Phoenix's lot or tick does not fit the policy (${e.message})`);
          continue;
        }
      } else {
        missing.push('Phoenix');
      }
    }
    if (orderly === null && phoenix === null) {
      const asked = a.venues.filter((v) => v !== 'hl').map((v) => VENUE_NAMES[v]).join(' or ');
      problems.push(`${s}: listed on Hyperliquid but not on ${asked}: a pair needs Hyperliquid and one more venue`);
      continue;
    }
    const lotE8 = lots.map((l) => l.lotE8).reduce(lcm);
    const sz = maxSzE8(a.usdE6, markE8, lotE8);
    if (sz === 0n) {
      problems.push(`${s}: ${usdcText(a.usdE6)} USD is less than one lot (${e8Text(lotE8)} ${s}) at the mark ${ctx.markPx}`);
      continue;
    }
    add.hl_assets.push({ index: hl.index, symbol: s, sz_decimals: hl.szDecimals });
    if (phoenix !== null) add.phoenix_markets.push(phoenix);
    if (orderly !== null) add.orderly_symbols.push(orderly);
    add.unpriced.push({ symbol: s, max_sz: e8Text(sz) });
    rows.push({ symbol: s, markPx: ctx.markPx, markE8, lots, lotE8, maxSzE8: sz, worthE6: worthE6(sz, markE8), missing, priceRange, orderly, phoenix });
  }

  // A JSON copy keeps the live field order (the contract's), so the new policy hashes as the contract will.
  const next = JSON.parse(JSON.stringify(policy));
  for (const k of LISTS) next[k] = [...policy[k], ...add[k]];
  if (a.unpricedCap !== null) next.unpriced_max_notional_usd = a.unpricedCap;
  for (const k of LISTS) {
    if (next[k].length > MAX_LIST_LEN) problems.push(`${k} would have ${next[k].length} entries, over the contract's ${MAX_LIST_LEN}`);
  }
  if (problems.length === 0) {
    problems.push(
      ...additionProblems(policy, next, { capChange: a.unpricedCap !== null }),
      ...validateForProblems(next).map((p) => `the contract would refuse it: ${p}`),
      ...livePolicyProblems(next, market.live).map((p) => `live venue data disagrees: ${p}`),
    );
  }
  if (problems.length > 0) throw new Error(`the policy change is refused, nothing was signed:\n  ${problems.join('\n  ')}`);
  return { next, add, rows };
}

// --- live data ---

/** Every request answered once: readLive and the mark read share one Orderly info and nothing is fetched twice. */
function memoFetch(fetchImpl) {
  const seen = new Map();
  return (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url} ${init.body ?? ''}`;
    if (!seen.has(key)) seen.set(key, Promise.resolve(fetchImpl(url, init)));
    return seen.get(key).then((r) => r.clone());
  };
}

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
 * readLive (the read buildPolicy uses) plus what sizing needs: Hyperliquid's marks (metaAndAssetCtxs, by name with
 * its index) and Orderly's rows (base_tick, price_range, status) by symbol.
 */
export async function readMarket({ fetch: fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const f = memoFetch(fetchImpl);
  const [live, hlCtx, info] = await Promise.all([
    readLive({ fetch: f }),
    getJson(f, `${HL_API}/info`, { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }),
    getJson(f, `${ORDERLY_API}/v1/public/info`),
  ]);
  const [meta, ctxs] = Array.isArray(hlCtx) ? hlCtx : [];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) throw new Error('hyperliquid metaAndAssetCtxs: no universe and contexts');
  const marks = new Map();
  meta.universe.forEach((a, index) => marks.set(a.name, { index, markPx: ctxs[index]?.markPx }));
  const orderly = new Map(info.data.rows.map((r) => [r.symbol, { base_tick: r.base_tick, price_range: r.price_range, status: r.status }]));
  return { live, marks, orderly };
}

// --- the run ---

const summary = (p) => `hl_assets ${p.hl_assets.length}, phoenix_markets ${p.phoenix_markets.length}, orderly_symbols ${p.orderly_symbols.length}, `
  + `unpriced ${p.unpriced.length}; max_notional_usd ${p.max_notional_usd}, unpriced_max_notional_usd ${p.unpriced_max_notional_usd}`;

/** The diff lines: every appended entry with its index, and the cap when it changes. */
export function diffLines(before, plan) {
  const out = [];
  for (const k of LISTS) {
    plan.add[k].forEach((e, i) => out.push(`  + ${`${k}[${before[k].length + i}]`.padEnd(20)} ${JSON.stringify(e)}`));
  }
  if (plan.next.unpriced_max_notional_usd !== before.unpriced_max_notional_usd) {
    out.push(`  ~ ${'unpriced_max_notional_usd'.padEnd(20)} ${before.unpriced_max_notional_usd} -> ${plan.next.unpriced_max_notional_usd}`);
  }
  return out;
}

/** set_policy's args as JSON with one policy entry per line, in the policy's own field order (it parses back to `args`). */
export function argsText(args) {
  const p = args.policy;
  const fields = Object.keys(p).map((k) => {
    const v = p[k];
    if (Array.isArray(v) && v.length > 0) return `    ${JSON.stringify(k)}: [\n${v.map((x) => `      ${JSON.stringify(x)}`).join(',\n')}\n    ]`;
    return `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n  "desk_id": ${JSON.stringify(args.desk_id)},\n  "policy": {\n${fields.join(',\n')}\n  }\n}`;
}

/** "0.45" style USD from USD x 1e6, two decimals, rounded down. */
const usd2 = (e6) => (Number(e6 / 10_000n) / 100).toFixed(2);

/**
 * Runs the tool; every effect goes through `deps` (tests use fakes). Returns the summary block.
 * deps: near, fetch, say, now, tree, readKey(file, accountId).
 */
export async function runSetPolicy(argv, deps = {}) {
  const a = parseSetPolicyArgs(argv);
  const client = deps.near ?? near;
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);

  say(`gimbal set-policy on ${a.contract} desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const state = await client.account(a.contract);
  if (state === null) throw new Error(`${a.contract} does not exist on mainnet`);
  if (state.code_hash === NO_CODE) throw new Error(`${a.contract} has no contract code`);
  const bad = contractConfigProblems(await client.view(a.contract, 'config'));
  if (bad.length > 0) throw new Error(`${a.contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
  const code = await client.code(a.contract);
  const missingMethods = ['set_policy', 'get_desk'].filter((m) => !(code === null ? [] : wasmExports(code)).includes(m));
  if (missingMethods.length > 0) throw new Error(`${a.contract}'s code has no ${missingMethods.join(', ')}`);
  say(`contract  ${a.contract}: Mainnet Gimbal, its code has set_policy and get_desk`);
  const desk = await client.view(a.contract, 'get_desk', { desk_id: a.deskId });
  if (desk === null) throw new Error(`${a.contract} has no desk ${a.deskId}`);
  const owner = desk.owner;
  const before = desk.policy;
  say(`desk      ${a.deskId}: owner ${owner}, paused ${desk.paused}, closing ${desk.closing ?? false}`);
  const order = policyOrderProblem(before);
  const liveSha = order === null ? policySha256(before) : null;
  say(`live      policy sha256 ${liveSha === null ? `not computed (${order})` : `${liveSha} (the contract's policy_sha256: sha256 of get_desk's policy JSON)`}`);
  say(`          ${summary(before)}`);
  for (const u of before.unpriced) say(`          unpriced already: ${u.symbol} max_sz ${u.max_sz}`);

  const market = await readMarket({ fetch: deps.fetch });
  say(`venues    read live: Hyperliquid meta and marks, Orderly public/info, Phoenix markets (${new Date(now()).toISOString()})`);
  const plan = planPolicy(before, a, market);
  const { next } = plan;

  say();
  say('diff (additions only: nothing existing is removed or changed)');
  for (const l of diffLines(before, plan)) say(l);
  const cap = Math.min(next.max_notional_usd, next.unpriced_max_notional_usd);
  if (plan.rows.length > 0) {
    say();
    say(`max_sz    --usd ${usdcText(a.usdE6)} per symbol at Hyperliquid's live mark, rounded down to the coarsest lot of its venues`);
    for (const r of plan.rows) {
      const lots = r.lots.map((l) => `${l.venue} ${e8Text(l.lotE8)} (${l.why})`).join(', ');
      say(`  ${r.symbol.padEnd(6)} max_sz ${e8Text(r.maxSzE8)} ${r.symbol} = ${usd2(r.worthE6)} USD at mark ${r.markPx}; lot ${e8Text(r.lotE8)} from ${lots}`);
      const on = ['Hyperliquid', r.orderly === null ? null : 'Orderly', r.phoenix === null ? null : 'Phoenix'].filter(Boolean).join(' + ');
      say(`         trades on ${on}${r.missing.length > 0 ? ` (${r.missing.join(' and ')} lists no ${r.symbol}: not added there)` : ''}`);
    }
    if (a.usdE6 > BigInt(cap) * 1_000_000n) {
      say(`note      --usd ${usdcText(a.usdE6)} is over the unpriced cap per order, min(max_notional_usd, unpriced_max_notional_usd) = ${cap} USD: that cap decides`);
    }
  }
  say();
  say(`new       ${summary(next)}`);
  const nextSha = policyOrderProblem(next) === null ? policySha256(next) : null;
  say(`          policy sha256 ${nextSha ?? 'not computed'} (the policy_set event must show it)`);

  // Deposit and gas.
  const growth = policyBorshBytes(next) - policyBorshBytes(before);
  const cfg = await client.rpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
  const bytePrice = BigInt(cfg?.runtime_config?.storage_amount_per_byte ?? YOCTO_PER_BYTE);
  const deposit = storageDeposit(growth, bytePrice);
  const args = { desk_id: a.deskId, policy: next };
  const action = act.call('set_policy', args, SET_POLICY_TGAS, deposit);
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const gasCap = txGasCap(feesOf(cfg), { signer: owner, receiver: a.contract, actions: [action] });
  const gasNear = gasCap.total * gasPrice;
  const ownerState = await client.account(owner);
  if (ownerState === null) throw new Error(`the desk owner ${owner} does not exist on mainnet`);
  const free = freeBalance(ownerState);
  const need = deposit + gasNear;
  const short = free < need ? `the owner can spend ${nearText(free, 4)} NEAR; set_policy needs ${nearTextUp(need, 4)} (deposit and gas)` : null;
  if (short !== null && a.send) throw new Error(short);

  let signer = null;
  let signedBy = 'the owner\'s full-access key, read at --send';
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, owner);
    const verdict = fullAccessVerdict(await client.accessKey(owner, signer.publicKeyString));
    if (verdict !== 'matches') throw new Error(`--key-file is not a full-access key of the desk owner ${owner}: nothing was signed`);
    signedBy = `--key-file, a full-access key of ${owner}`;
  }
  say();
  say(describeTx('tx: set_policy', { signer: owner, signedBy, receiver: a.contract, actions: [action] }).join('\n'));
  say(`  deposit   ${nearText(deposit)} NEAR: the policy grows by ${growth} bytes (Borsh) x ${nearText(bytePrice)} NEAR per byte, plus ${STORAGE_MARGIN_BYTES} bytes `
    + 'of margin; set_policy keeps what the storage took and refunds the rest to the owner');
  say(`  gas       at most ${tgasText(gasCap.total)} TGas, ${nearTextUp(gasNear, 4)} NEAR; the unused part is refunded`);
  say(`  owner     ${owner}: ${nearText(BigInt(ownerState.amount), 4)} NEAR, ${nearText(free, 4)} free`);
  if (short !== null) say(`warning   ${short}: --send refuses until it can`);
  say();
  say('args      the same JSON, one entry per line:');
  say(argsText(args));

  const added = plan.rows.map((r) => r.symbol);
  say();
  say(`engine    restart serve once this is final: the scanner reads the policy's symbol list at start (railway redeploy, or Redeploy in the Railway dashboard)`);
  if (added.length > 0) {
    say(`risk      ${added.join(', ')} have no oracle price: the contract checks no price band on their orders. Each order is capped by its max_sz in`);
    say(`          base units and by min(max_notional_usd, unpriced_max_notional_usd) = ${cap} USD at the order's own price. The worst loss per bad`);
    say('          order is bounded by max_sz and the venue\'s own price limits:');
    for (const r of plan.rows) {
      const edge = r.priceRange === null ? '' : `; Orderly takes prices within ${(r.priceRange * 100).toFixed(1)} % of its mark: about ${usd2((r.worthE6 * BigInt(Math.round(r.priceRange * 1e6))) / 1_000_000n)} USD at that edge`;
      say(`            ${r.symbol}: ${e8Text(r.maxSzE8)} ${r.symbol} is worth ${usd2(r.worthE6)} USD now${edge}`);
    }
    say('          never remove one of them while a position on it is open: the contract refuses every order on a symbol missing from');
    say('          the venue list, reduce-only closes included (E_ASSET). After a large price move, set a new max_sz (a separate');
    say('          set_policy: this tool never changes an entry); until then the cap fails closed (after a fall a leg of the planned');
    say('          USD size is over max_sz and refused, after a rise the USD cap refuses it first).');
  }

  const at = () => new Date(now()).toISOString();
  const addedText = added.length === 0 ? 'no symbols' : plan.rows.map((r) => `${r.symbol} max_sz ${e8Text(r.maxSzE8)}`).join(', ');
  if (!a.send) {
    const block = summaryBlock('set-policy', {
      at: at(),
      lines: [
        `contract ${a.contract}, desk ${a.deskId}, owner ${owner}, dry run`,
        `live:     sha256 ${liveSha ?? 'not computed'}; ${summary(before)}`,
        `adds:     ${addedText}; unpriced_max_notional_usd ${before.unpriced_max_notional_usd} -> ${next.unpriced_max_notional_usd}`,
        `new:      sha256 ${nextSha ?? 'not computed'}; deposit ${nearText(deposit)} NEAR, gas at most ${tgasText(gasCap.total)} TGas`,
        ...(short === null ? [] : [`refused:  ${short}`]),
      ],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. Add --send and --key-file <owner key json>, from the main checkout, to send it.');
    if (short !== null) throw new Error(short);
    return block;
  }

  const lines = [`contract ${a.contract}, desk ${a.deskId}, owner ${owner}, SEND`];
  const out = await client.send(signer, a.contract, [action], { onSent: (h) => say(`\ntx sent ${h}; waiting for final`) });
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) say(`  log ${log}`);
  if (out.failure !== null) throw new Error(`set_policy ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
  lines.push(`tx:       ${out.hash} ${txLink(out.hash)}`);
  const event = eventsOf(out.logs).find((e) => e.event === 'policy_set');
  lines.push(`event:    ${event === undefined ? 'no policy_set event in the logs' : `policy_set ${JSON.stringify(event.data)}`}`);
  const after = await client.view(a.contract, 'get_desk', { desk_id: a.deskId });
  const problems = [];
  if (JSON.stringify(after?.policy) !== JSON.stringify(next)) {
    const got = after?.policy ?? {};
    const fields = [...new Set([...Object.keys(next), ...Object.keys(got)])].filter((k) => JSON.stringify(next[k]) !== JSON.stringify(got[k]));
    problems.push(`get_desk's policy is not the planned one: ${fields.map((k) => `${k} planned ${JSON.stringify(next[k])}, on chain ${JSON.stringify(got[k]) ?? 'missing'}`).join('; ')}`);
  }
  const afterSha = after?.policy === undefined ? null : policySha256(after.policy);
  if (event === undefined) problems.push('the transaction logged no policy_set event');
  else if (afterSha !== null && event.data.policy_sha256 !== afterSha) problems.push(`policy_set says sha256 ${event.data.policy_sha256}, get_desk's policy hashes to ${afterSha}`);
  lines.push(`after:    sha256 ${afterSha ?? 'none'}; ${after?.policy === undefined ? 'no policy' : summary(after.policy)}`);
  lines.push(problems.length === 0 ? `check:    get_desk holds exactly the planned additions (${addedText})` : `check:    FAILED ${problems.join('; ')}`);
  lines.push('next:     restart serve (railway redeploy, or Redeploy in the Railway dashboard)');
  const block = summaryBlock('set-policy', { at: at(), lines });
  say();
  say(block.join('\n'));
  if (problems.length > 0) throw new Error(`the policy on chain is not the planned one: ${problems.join('; ')}`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runSetPolicy(process.argv.slice(2)), USAGE);
