// The parts of pair-mainnet.ts that decide something without a network: its arguments and order options, when the
// stored price is fresh enough and when to refresh it, whether a withdrawal leaves the Phoenix leg its collateral,
// the cross-margin numbers of each venue, and the Phoenix order that hedges what a late maker fill left open.
// pair-mainnet.ts runs on import; this module does not, so the tests drive these directly.

import type { TxRef } from '@gimbal/shared';
import { MAX_PRIORITY_MICROLAMPORTS, ORDER_PRIORITY_MICROLAMPORTS } from '../relayer/phoenix-tx.ts';
import { pct, usd, venueMaxLeverage } from '../trade/carry-plan.ts';
import type { LegSide, MakerSettings } from '../trade/legs.ts';
import { abs, floorToLot } from '../trade/lots.ts';

export class UsageError extends Error {}

export const FLAGS: Record<string, 'value' | 'switch'> = {
  '--send': 'switch', '--short': 'value', '--long': 'value', '--leverage': 'value', '--hold-days': 'value', '--basis-bps': 'value',
  '--slippage-bps': 'value', '--reprice-s': 'value', '--maker-timeout-s': 'value', '--max-orders': 'value', '--taker-fallback': 'switch',
  '--priority-microlamports': 'value',
};

/** The reprice floor and the post-only order cap of one pair operation (the C10 meter counts every signed reprice). */
export const MIN_REPRICE_S = 30;
export const MAX_MAKER_ORDERS = 6;
export const DEFAULT_MAKER_TIMEOUT_S = 120;
/**
 * The oracle's recency window on mainnet: a stored price's at_ms is the oracle answer's timestamp less it
 * (docs/interfaces.md, prices()), so a price fresh from refresh_prices is already this old.
 */
export const ORACLE_RECENCY_S = 600;
/** How long the stored price must still live after the maker timeout when a part starts: the IOC and an unwind. */
export const PRICE_MARGIN_S = 120;
/** An order finding the stored price this close to oracle_max_age_s refreshes it first. */
export const PRICE_STALE_MARGIN_S = 30;
/** The contract skips a refresh_prices this soon after the last one (and the client's poll would then throw). */
export const MIN_REFRESH_GAP_S = 30;

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
  send: boolean;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const kind = FLAGS[a];
    if (kind === undefined) throw new UsageError(`unknown option ${a}`);
    if (a in flags) throw new UsageError(`${a} is given twice`);
    if (kind === 'switch') flags[a] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      flags[a] = v;
      i++;
    }
  }
  const command = positional.shift();
  if (command === undefined) throw new UsageError('no command');
  return { command, positional, flags, send: flags['--send'] === true };
}

export function num(args: Args, flag: string, fallback: number): number {
  const v = args.flags[flag];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a number of 0 or more`);
  return n;
}

export function orderOptions(args: Args): { maker: MakerSettings; microLamports: number; slippageBps: number } {
  const repriceS = num(args, '--reprice-s', MIN_REPRICE_S);
  const timeoutS = num(args, '--maker-timeout-s', DEFAULT_MAKER_TIMEOUT_S);
  const maxOrders = num(args, '--max-orders', MAX_MAKER_ORDERS);
  const microLamports = num(args, '--priority-microlamports', ORDER_PRIORITY_MICROLAMPORTS);
  if (repriceS < MIN_REPRICE_S) throw new UsageError(`--reprice-s must be ${MIN_REPRICE_S} or more: every reprice is signed and metered`);
  if (!(timeoutS > 0)) throw new UsageError('--maker-timeout-s must be above 0');
  if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_MAKER_ORDERS) throw new UsageError(`--max-orders must be 1..${MAX_MAKER_ORDERS}`);
  if (!Number.isInteger(microLamports) || microLamports < 1 || microLamports > MAX_PRIORITY_MICROLAMPORTS) throw new UsageError(`--priority-microlamports must be 1..${MAX_PRIORITY_MICROLAMPORTS}`);
  return {
    maker: { repriceMs: repriceS * 1000, timeoutMs: timeoutS * 1000, takerFallback: args.flags['--taker-fallback'] === true, pollMs: 1000, maxOrders },
    microLamports, slippageBps: num(args, '--slippage-bps', 50),
  };
}

/** How long a price fresh from refresh_prices stays under oracle_max_age_s: at most this many seconds. */
export function priceLifeS(oracleMaxAgeS: number): number {
  return oracleMaxAgeS - ORACLE_RECENCY_S;
}

/** Why a maker timeout plus the price margin does not fit a fresh price's life, or null when it does. */
export function priceFitRefusal(timeoutS: number, oracleMaxAgeS: number): string | null {
  const life = priceLifeS(oracleMaxAgeS);
  if (timeoutS + PRICE_MARGIN_S <= life) return null;
  const most = life - PRICE_MARGIN_S;
  return `--maker-timeout-s ${timeoutS} plus ${PRICE_MARGIN_S} s for the IOC does not fit the life of a fresh price: oracle_max_age_s ${oracleMaxAgeS} less the oracle's ${ORACLE_RECENCY_S} s recency is ${life} s`
    + (most > 0 ? `; use --maker-timeout-s ${most} or less` : '; the policy leaves no time for a maker order');
}

export interface StoredPrice {
  px: number;
  ageS: number;
}

/** What ensureFresh reads and sends, and the state its callers share. */
export interface PriceDeps {
  maxAgeS: number;
  send: boolean;
  read(symbol: string): Promise<StoredPrice | null>;
  refresh(symbol: string, maxAgeS: number): Promise<TxRef[]>;
  now(): number;
  log(line: string): void;
  /** One refresh in flight per symbol: concurrent callers wait on it rather than send a second one. */
  refreshing: Map<string, Promise<void>>;
  /** When each symbol's last refresh ended (ms). */
  lastRefreshAt: Map<string, number>;
}

export function newPriceState(): Pick<PriceDeps, 'refreshing' | 'lastRefreshAt'> {
  return { refreshing: new Map(), lastRefreshAt: new Map() };
}

/**
 * The stored price of `symbol` when it will live `marginS` more (age ≤ oracle_max_age_s − marginS); otherwise one
 * refresh_prices (--send only), shared by concurrent callers, and the price after it, checked against the same
 * margin. A refresh under MIN_REFRESH_GAP_S after the last one is not sent: the contract would skip it.
 */
export async function ensureFresh(d: PriceDeps, symbol: string, marginS: number): Promise<StoredPrice> {
  const limit = d.maxAgeS - marginS;
  const sp = await d.read(symbol);
  if (sp !== null && sp.ageS <= limit) return sp;
  const was = sp === null ? 'missing' : `${Math.round(sp.ageS)} s old`;
  if (!d.send) throw new Error(`the stored ${symbol} price is ${was}`);
  const inFlight = d.refreshing.get(symbol);
  if (inFlight !== undefined) {
    await inFlight;
  } else {
    const last = d.lastRefreshAt.get(symbol);
    if (last !== undefined && d.now() - last < MIN_REFRESH_GAP_S * 1000) {
      d.log(`refresh   the stored ${symbol} price is ${was}, but the last refresh_prices was ${Math.round((d.now() - last) / 1000)} s ago: not sent again`);
    } else {
      d.log(`refresh   the stored ${symbol} price is ${was}: refresh_prices`);
      const p = d.refresh(symbol, Math.max(1, limit))
        .then((tx) => d.log(`          ${tx.map((t) => t.url).join('  ')}`))
        .finally(() => {
          d.refreshing.delete(symbol);
          d.lastRefreshAt.set(symbol, d.now());
        });
      d.refreshing.set(symbol, p);
      await p;
    }
  }
  const fresh = await d.read(symbol);
  if (fresh === null || fresh.ageS > limit) {
    throw new Error(`after refresh_prices the stored ${symbol} price is ${fresh === null ? 'missing' : `${Math.round(fresh.ageS)} s old`}: it does not live the ${marginS} s needed (oracle_max_age_s ${d.maxAgeS})`);
  }
  return fresh;
}

/**
 * The legs' price read: the stored price as it is while planning (a dry run, or --send before its refusals are
 * checked); once `trading()`, one about to go stale is refreshed first, so an unwind or a close is never refused for
 * a stale price.
 */
export function oraclePxOf(d: PriceDeps, symbol: string, trading: () => boolean): () => Promise<number> {
  return async () => {
    if (trading()) return (await ensureFresh(d, symbol, PRICE_STALE_MARGIN_S)).px;
    const sp = await d.read(symbol);
    if (sp === null) throw new Error(`the contract has no stored ${symbol} price`);
    return sp.px;
  };
}

/** One venue's cross margin: equity, maintenance, and the mark notional of its cross positions. */
export interface CrossMargin {
  equityUsd: number;
  maintenanceUsd: number;
  notionalUsd: number;
}

/** Hyperliquid's cross margin from a raw clearinghouseState: crossMarginSummary, and positionValue of cross positions. */
export function hlCross(raw: unknown): CrossMargin {
  const r = raw as {
    crossMarginSummary?: { accountValue?: unknown }; crossMaintenanceMarginUsed?: unknown;
    assetPositions?: { position?: { positionValue?: unknown; leverage?: { type?: unknown } } }[];
  } | null;
  const equity = Number(r?.crossMarginSummary?.accountValue);
  const maintenance = Number(r?.crossMaintenanceMarginUsed);
  if (r === null || typeof r !== 'object' || !Number.isFinite(equity) || !Number.isFinite(maintenance) || !Array.isArray(r.assetPositions)) {
    throw new Error('hyperliquid clearinghouseState: no crossMarginSummary.accountValue, crossMaintenanceMarginUsed or assetPositions');
  }
  let notional = 0;
  for (const row of r.assetPositions) {
    if (row?.position?.leverage?.type !== 'cross') continue;
    const v = Number(row.position.positionValue);
    if (!Number.isFinite(v)) throw new Error(`hyperliquid clearinghouseState: positionValue ${JSON.stringify(row.position.positionValue)}`);
    notional += Math.abs(v);
  }
  return { equityUsd: equity, maintenanceUsd: maintenance, notionalUsd: notional };
}

/** The Phoenix account as the CLI reads it: the cross subaccount (0), and every position with its mark notional. */
export interface PhoenixCrossView {
  cross: { equityUsd: number; maintenanceMarginUsd: number };
  positions: readonly { symbol: string; size: number; notionalUsd: number; subaccountIndex: number }[];
}

export function phoenixCross(pa: PhoenixCrossView): CrossMargin {
  const notional = pa.positions.filter((p) => p.subaccountIndex === 0 && p.size !== 0).reduce((acc, p) => acc + p.notionalUsd, 0);
  return { equityUsd: pa.cross.equityUsd, maintenanceUsd: pa.cross.maintenanceMarginUsd, notionalUsd: notional };
}

/**
 * A withdrawal must leave an open Phoenix leg its collateral: `all` is refused while a position is open, and an amount
 * must leave the cross subaccount at or under Phoenix's leverage cap and more than 40 % from liquidation, at the
 * mark. Only a trader proven unregistered passes unread; a state or an account that cannot be read is refused.
 */
export async function withdrawKeepsLegs(
  reads: { state(): Promise<string | null>; account(): Promise<PhoenixCrossView> }, all: boolean, amountUsd: number,
): Promise<string[]> {
  let state: string | null;
  try {
    state = await reads.state();
  } catch (err) {
    return [`the Phoenix trader state cannot be read (${errorText(err)}): a withdrawal is not planned without the positions`];
  }
  if (state === 'uninitialized') return [];
  if (state === null) return ['the Phoenix trader state is unknown: a withdrawal is not planned without the positions'];
  let pa: PhoenixCrossView;
  try {
    pa = await reads.account();
  } catch (err) {
    return [`the Phoenix account cannot be read (${errorText(err)}): a withdrawal is not planned without the positions`];
  }
  const open = pa.positions.filter((p) => p.size !== 0);
  if (open.length === 0) return [];
  const names = open.map((p) => `${p.symbol} ${p.size}`).join(', ');
  if (all) return [`Phoenix holds ${names}: defund-phoenix all would take the leg's collateral; close the pair first, or withdraw an amount`];
  const c = phoenixCross(pa);
  if (c.notionalUsd === 0) return [];
  const left = c.equityUsd - amountUsd;
  const cap = venueMaxLeverage('phoenix');
  const out: string[] = [];
  if (!(left * cap >= c.notionalUsd)) out.push(`after it Phoenix would hold ${usd(left)} against ${usd(c.notionalUsd)} open at the mark (${names}): over ${cap}x; at most ${usd(Math.max(0, c.equityUsd - c.notionalUsd / cap))} can go`);
  const distance = (left - c.maintenanceUsd) / c.notionalUsd;
  if (!(distance > 0.4)) out.push(`after it the Phoenix positions would be ${pct(distance)} from liquidation, not more than 40 %`);
  return out;
}

/**
 * The Phoenix IOC that brings it back against Hyperliquid (net 0: Phoenix holds −hl), in whole Phoenix lots, or null
 * when no whole lot is off. Reduce-only when it only shrinks the Phoenix position.
 */
export function residualHedge(hlPos: bigint, pxPos: bigint, pxLot: bigint): { side: LegSide; size: bigint; reduceOnly: boolean } | null {
  const delta = -hlPos - pxPos;
  const size = floorToLot(abs(delta), pxLot);
  if (size === 0n) return null;
  const side: LegSide = delta > 0n ? 'BUY' : 'SELL';
  const reduceOnly = pxPos !== 0n && (delta > 0n) !== (pxPos > 0n) && size <= abs(pxPos);
  return { side, size, reduceOnly };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
