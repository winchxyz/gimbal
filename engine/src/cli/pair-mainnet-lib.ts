// The parts of pair-mainnet.ts that decide something without a network: its arguments and order options, when the
// stored price is fresh enough and when to refresh it (and whether a failed refresh still went on chain), whether
// Hyperliquid has resting orders an open must not start beside, whether a withdrawal leaves the Phoenix leg its collateral,
// the cross-margin numbers of each venue, and the Phoenix order that hedges what a late maker fill left open (with
// the reads around it).
// pair-mainnet.ts runs on import; this module does not, so the tests drive these directly.

import type { TxRef } from '@gimbal/shared';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import { MAX_PRIORITY_MICROLAMPORTS, ORDER_PRIORITY_MICROLAMPORTS } from '../relayer/phoenix-tx.ts';
import { pct, usd, venueMaxLeverage } from '../trade/carry-plan.ts';
import type { LegOutcome, LegSide, MakerSettings } from '../trade/legs.ts';
import { abs, floorToLot, qtyString, signedQtyString } from '../trade/lots.ts';

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
 * The oracle's recency window on mainnet: a stored price's at_ms is the oracle answer's timestamp less its
 * `recency_duration_sec` (contract/src/prices.rs, the time of an oracle answer's prices; docs/interfaces.md,
 * prices()), so a price fresh from refresh_prices is already this old. The contract takes the value from each oracle
 * answer; 600 is what the mainnet oracle answers. Change it here if that ever changes.
 */
export const ORACLE_RECENCY_S = 600;
/** How long the stored price must still live after the maker timeout when a part starts: the IOC and an unwind. */
export const PRICE_MARGIN_S = 120;
/** An order finding the stored price this close to oracle_max_age_s refreshes it first. */
export const PRICE_STALE_MARGIN_S = 30;
/** The contract skips a refresh_prices this soon after the last one (and the client's poll would then throw). */
export const MIN_REFRESH_GAP_S = 30;
/**
 * An open's own refresh_prices (refreshForOpen) must leave the price this long past the first part's margin, for what
 * runs between it and the first part's check (serve: the size held to the cap, the gate, both legs read): that check
 * then finds it fresh and sends no second refresh, which the contract would skip within MIN_REFRESH_GAP_S anyway.
 */
export const OPEN_HEADROOM_S = 15;

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
  /**
   * Whether a refresh that threw still went on chain (refreshLanded for the near-client): then the contract skips
   * another within MIN_REFRESH_GAP_S. Default: it did not.
   */
  landed?(err: unknown): boolean;
  /**
   * Whether a refresh that threw still reached the chain and spent gas (refreshReachedChain): a transaction that ran,
   * failed or was refused there, or one sent with no outcome. Such a refresh is paid for and counted (pair-ops
   * counting) even when it recorded no ask; only an error before the chain is not. Default: landed().
   */
  reachedChain?(err: unknown): boolean;
  now(): number;
  log(line: string): void;
  /** One refresh in flight per symbol: concurrent callers wait on it rather than send a second one. */
  refreshing: Map<string, Promise<void>>;
  /** When each symbol's last refresh that landed ended (ms). */
  lastRefreshAt: Map<string, number>;
  /**
   * While planning only: the price an open plans with where the contract stores none, or a stale one over the band
   * from the books (planOpen sets the books' mid, and clears it), so every other refusal is judged before any
   * refresh_prices is paid for. Never used once trading.
   */
  estimate?: Map<string, number>;
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
      // The gap starts only from a refresh that went on chain: one that failed before it must not block the next.
      const p = d.refresh(symbol, Math.max(1, limit))
        .then((tx) => {
          d.lastRefreshAt.set(symbol, d.now());
          d.log(`          ${tx.map((t) => t.url).join('  ')}`);
        }, (err: unknown) => {
          if (d.landed?.(err) === true) d.lastRefreshAt.set(symbol, d.now());
          throw err;
        })
        .finally(() => {
          d.refreshing.delete(symbol);
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
 * checked; planOpen's estimate where it set one); once `trading()`, one about to go stale is refreshed first, so an
 * unwind or a close is never refused for a stale price.
 */
export function oraclePxOf(d: PriceDeps, symbol: string, trading: () => boolean): () => Promise<number> {
  return async () => {
    if (trading()) return (await ensureFresh(d, symbol, PRICE_STALE_MARGIN_S)).px;
    // planOpen's estimate first: it is set only where the stored price is missing or too far off to judge on.
    const estimate = d.estimate?.get(symbol);
    if (estimate !== undefined) return estimate;
    const sp = await d.read(symbol);
    if (sp !== null) return sp.px;
    throw new Error(`the contract has no stored ${symbol} price`);
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
  const equity = numeric(r?.crossMarginSummary?.accountValue);
  const maintenance = numeric(r?.crossMaintenanceMarginUsed);
  if (r === null || typeof r !== 'object' || equity === null || maintenance === null || !Array.isArray(r.assetPositions)) {
    throw new Error('hyperliquid clearinghouseState: no crossMarginSummary.accountValue, crossMaintenanceMarginUsed or assetPositions');
  }
  let notional = 0;
  for (const row of r.assetPositions) {
    if (row?.position?.leverage?.type !== 'cross') continue;
    const v = numeric(row.position.positionValue);
    if (v === null) throw new Error(`hyperliquid clearinghouseState: positionValue ${JSON.stringify(row.position.positionValue)}`);
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
 * Whether a refresh_prices that threw still went on chain, so the contract skips another within MIN_REFRESH_GAP_S:
 * it ran (near-client refreshPrices wraps every error after the call returned as "refresh_prices ran in <tx>: ..."),
 * or it was sent with no final outcome. Not a refusal, an error before the call, or a transaction that failed on chain
 * (its state reverted: no ask was recorded).
 */
export function refreshLanded(err: unknown): boolean {
  if (err instanceof OutcomeUnknown) return !err.detail.startsWith('failed without a refusal code');
  return err instanceof Error && !(err instanceof ContractRefusal) && /^refresh_prices ran in \S+: /.test(err.message);
}

/**
 * Whether a refresh_prices that threw reached the chain, so its gas is spent: it landed (refreshLanded), it was sent
 * with no final outcome, the contract refused it in a transaction, or the transaction failed there (state reverted).
 * Not an error before the call: the RPC or HTTP failing, or the prices() read the call starts with. Wider than
 * refreshLanded, which says only whether the contract recorded the ask (the 30 s gap); this one says it was paid.
 */
export function refreshReachedChain(err: unknown): boolean {
  if (refreshLanded(err) || err instanceof OutcomeUnknown) return true;
  if (err instanceof ContractRefusal) return err.txHash !== null;
  return err instanceof Error && /^refresh_prices failed in transaction \S+: /.test(err.message);
}

/**
 * Why `open` must not start while Hyperliquid has resting orders for `coin` (an earlier run's post-only orders could
 * fill outside the target net), or null. `raw` is the /info openOrders answer; one that cannot be read refuses too.
 */
export function restingOrdersRefusal(raw: unknown, coin: string): string | null {
  if (!Array.isArray(raw)) return `the Hyperliquid open orders cannot be read (${JSON.stringify(raw)?.slice(0, 80)}): an earlier run's resting order could fill outside the pair`;
  const rows = (raw as { coin?: unknown; side?: unknown; sz?: unknown; oid?: unknown }[]).filter((o) => o?.coin === coin);
  if (rows.length === 0) return null;
  const names = rows.map((o) => `${o.side === 'B' ? 'BUY' : o.side === 'A' ? 'SELL' : String(o.side)} ${String(o.sz)} (oid ${String(o.oid)})`).join(', ');
  return `Hyperliquid has ${rows.length} resting ${coin} order(s) (${names}): an earlier run's order could fill outside the target net; cancel it on Hyperliquid and reconcile both legs first`;
}

/**
 * The Phoenix IOC that brings the pair back to its target net (Phoenix to `targetNet` − hl), in whole Phoenix lots,
 * or null when no whole lot is off. Reduce-only when it only shrinks the Phoenix position. The target net is the sum
 * of the operation's targets: an open keeps hl + px as it found them (an imbalance an older run left is not this run's
 * to trade away); a close targets flat on both legs, so 0.
 */
export function residualHedge(hlPos: bigint, pxPos: bigint, pxLot: bigint, targetNet: bigint): { side: LegSide; size: bigint; reduceOnly: boolean } | null {
  const delta = targetNet - hlPos - pxPos;
  const size = floorToLot(abs(delta), pxLot);
  if (size === 0n) return null;
  const side: LegSide = delta > 0n ? 'BUY' : 'SELL';
  const reduceOnly = pxPos !== 0n && (delta > 0n) !== (pxPos > 0n) && size <= abs(pxPos);
  return { side, size, reduceOnly };
}

/** What finish() knows after cancelPending and a fresh read of both legs. */
export interface ResidualInput {
  /** Post-only orders still unsettled after cancelPending. */
  left: number;
  /** The Phoenix leg has an order with no answer that may still run. */
  phoenixUnsettled: boolean;
  send: boolean;
  /** The command passed its refusals and traded. */
  trading: boolean;
  hl: bigint;
  px: bigint;
  /** The Phoenix lot. */
  lot: bigint;
  /** The sum of the operation's targets: hl + px before an open began; 0 for a close (both legs flat). */
  targetNet: bigint;
  symbol: string;
  /** The pair's unhedged alert before this read (PairTrader.unhedged). */
  unhedged: string | null;
}

export interface ResidualPlan {
  /** The Phoenix IOC to send, or null. */
  hedge: { side: LegSide; size: bigint; reduceOnly: boolean } | null;
  /** Why the legs are off and nothing is sent, or null. */
  held: string | null;
  /**
   * The unhedged alert as of this read: the exact amount when the legs are off the target net; cleared only
   * when they do and no post-only order is left that could still fill; the alert before it otherwise.
   */
  unhedged: string | null;
}

export function residualPlan(i: ResidualInput): ResidualPlan {
  const off = i.hl + i.px - i.targetNet;
  const unhedged = off !== 0n
    ? `unhedged: hyperliquid ${i.symbol} ${signedQtyString(i.hl)}, phoenix ${i.symbol} ${signedQtyString(i.px)} against a target net of ${signedQtyString(i.targetNet)}: ${qtyString(abs(off))} ${i.symbol} ${off > 0n ? 'long' : 'short'} is not offset`
    : i.left === 0 ? null : i.unhedged;
  if (off === 0n) return { hedge: null, held: null, unhedged };
  const hedge = residualHedge(i.hl, i.px, i.lot, i.targetNet);
  const held = hedge === null ? `the ${qtyString(abs(off))} ${i.symbol} off is under one Phoenix lot ${qtyString(i.lot)}`
    : i.left > 0 ? `${i.left} post-only order(s) are still unsettled and may fill more`
    : i.phoenixUnsettled ? 'Phoenix has an order with no answer that may still run'
    : !i.send || !i.trading ? 'nothing is sent outside a trading --send run'
    : null;
  return { hedge: held === null ? hedge : null, held, unhedged };
}

/** What settleResidual reads and sends. */
export interface ResidualDeps {
  /** Both legs' positions now, or null (with the reason printed) when either cannot be read. */
  readLegs(): Promise<{ hl: bigint; px: bigint } | null>;
  /** The Phoenix IOC (PhoenixLeg.order); never throws. */
  hedge(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome>;
  say(line: string): void;
  /** Something the owner must reconcile: an `open:` line, exit code 3. */
  open(line: string): void;
}

/**
 * finish() after cancelPending: both legs read again, the residual plan, at most one Phoenix IOC back to the target
 * net, and the legs read once more after it. Returns the unhedged alert as of the last read (null when the legs are at
 * the target net and nothing is left that could still move them). A hedge with no answer is an `open:` line and keeps
 * the alert: its order may still run.
 */
export async function settleResidual(base: Omit<ResidualInput, 'hl' | 'px'>, d: ResidualDeps): Promise<string | null> {
  const read = await d.readLegs();
  if (read === null) return `the legs cannot be read after the cancel: check hyperliquid and phoenix ${base.symbol} by hand`;
  d.say(`positions after the cancel: hyperliquid ${base.symbol} ${signedQtyString(read.hl)}, phoenix ${base.symbol} ${signedQtyString(read.px)} (net ${signedQtyString(read.hl + read.px)}, target ${signedQtyString(base.targetNet)})`);
  const input: ResidualInput = { ...base, hl: read.hl, px: read.px };
  const plan = residualPlan(input);
  if (plan.held !== null) d.say(`hedge     not sent: ${plan.held}`);
  if (plan.hedge === null) return plan.unhedged;
  const h = plan.hedge;
  d.say(`hedge     phoenix ${h.side} ${qtyString(h.size)}${h.reduceOnly ? ' reduce-only' : ''}: back to the target net against hyperliquid ${signedQtyString(read.hl)}`);
  const out = await d.hedge(h.side, h.size, h.reduceOnly);
  const tx = out.ref.tx.length === 0 ? '' : ` ${out.ref.tx.map((t) => t.url).join('  ')}`;
  d.say(`          ${out.kind}${out.kind === 'filled' ? ` ${qtyString(out.filled)}` : ` (${out.error.message})`}${tx}`);
  if (out.kind === 'unknown') {
    d.open(`the phoenix hedge ${h.side} ${qtyString(h.size)} ${base.symbol} (${out.ref.orderId ?? 'no signature'}) has no proven outcome: check Phoenix by hand before sending another`);
  }
  const now = await d.readLegs();
  if (now === null) return `the legs cannot be read after the hedge: check hyperliquid and phoenix ${base.symbol} by hand`;
  d.say(`positions hyperliquid ${base.symbol} ${signedQtyString(now.hl)}, phoenix ${base.symbol} ${signedQtyString(now.px)}`);
  return residualPlan({ ...input, hl: now.hl, px: now.px, phoenixUnsettled: out.kind === 'unknown' || input.phoenixUnsettled }).unhedged;
}

/** A string or number that reads as a finite number (never null, which Number() reads as 0). */
function numeric(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
