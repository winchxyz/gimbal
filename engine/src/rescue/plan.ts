// Where a rescue's margin comes from (E9). Pure: the rescuer (rescuer.ts) passes the desk as the risk engine last read
// it and what its routes can do, and runs the plan this returns.
//
// Source order, the first that can pay wins:
//   1. the reserve: the desk's idle_usdc on NEAR, sent with fund_venue (its own limits, not the rescue cap);
//   2. free margin on the other leg's venue: Phoenix with sol_sign_rescue, or Hyperliquid with hl_withdraw to the desk's
//      own Arbitrum address and then evm_usdc_to_intents (1Click quotes nothing out of HyperCore). Both count against
//      policy.rescue_cap_usd_per_hour; the Hyperliquid route counts twice (hl_withdraw's amount, then the bridge's).
//      USDC an earlier withdraw of the rescuer left on Arbitrum goes first; a withdraw only tops it up (fromHyperliquid);
//   3. reducing both legs reduce-only by the same size, so the hedge stays flat and the leg needs less margin.
// Orderly is never a source: its money out is a settle, a withdraw (~50 s to Arbitrum) and an EIP-3009 transfer, four
// MPC signatures in all.
//
// Fees are roughly flat per transfer (measured on mainnet: 0.32 USDC Phoenix -> Hyperliquid on 4, the same NEAR ->
// Hyperliquid on 12; Hyperliquid's withdraw takes 1 USDC more), so a small rescue loses a large share of what it
// moves. A route whose expected fees are over MAX_FEE_SHARE (10 %) of the amount it sends is skipped, and the legs are
// reduced instead: a 10 % fee on margin is worse than giving up 10 % of a funding carry's size.
//
// So each route takes rescues from a smallest amount, and the cap bounds the largest (rescueSizes; a plan that ends in
// a reduce or in nothing names them in its notes, so the journal says it). At the final mainnet policy
// (rescue_cap_usd_per_hour 50, 300 bps, 1 USD flat), with a 1Click key and nothing on Arbitrum yet, in USD of margin
// the target needs:
//   reserve -> Hyperliquid from 2.86      reserve -> Orderly any (it sends at least 6.20)    reserve -> Phoenix from 0.44
//   Phoenix -> Hyperliquid 2.86 to 49.40  Phoenix -> Orderly up to 49.67
//   Hyperliquid -> Phoenix 10.39 to 24.31: the withdraw's 1 USDC fee sets the floor, the cap the ceiling (the withdraw
//   and the bridge both count, about twice the rescue); at a 20 USD cap no Hyperliquid rescue fits at all.
// Without a key 1Click adds 0.2 %, which moves each floor up a little.

import type { VenueId } from '@gimbal/shared';

/** A route whose expected fees are over this share of what it sends is skipped (see the header). */
export const MAX_FEE_SHARE = 0.10;
/** Hyperliquid's withdraw fee, USDC, taken out of the amount withdrawn (the ledger's usdc is net of it). */
export const HL_WITHDRAW_FEE_USD = 1;
/** Into HyperCore 1Click charges its withdraw fee (measured 0.32 on 4 and on 12 USDC). */
export const INTO_HYPERCORE_FEE_USD = 0.32;
/** Into Arbitrum USDC (the Orderly receiver) or Solana USDC: measured under 0.01 on 10 USDC with a key; a margin. */
export const INTO_EVM_OR_SOLANA_FEE_USD = 0.05;
/** 1Click adds this without an API key (CLAUDE.md: +0.2 %). */
export const NO_KEY_FEE_SHARE = 0.002;
/** Slippage asked of 1Click: 5 bps over fund_venue's room rule (amountOut − minAmountOut ≥ 0.5 %), so rounding never lands on it. */
export const SLIPPAGE_BPS = 55;
/** The least sent into the Orderly receiver: 6 USDC must arrive (below 5 it is lost); room for slippage and fees. */
export const ORDERLY_MIN_IN_USD = 6.2;
/** The least sent into HyperCore: 1Click's 0.5 USDC minimum plus its fee. */
export const HYPERCORE_MIN_IN_USD = 1;
/** The least an hl_withdraw brings to Arbitrum when it tops up USDC already there (it takes HL_WITHDRAW_FEE_USD more). */
export const HL_TOP_UP_MIN_USD = 1;
/** rescueSizes looks for each route's sizes up to this amount, USD. */
export const SIZE_SCAN_MAX_USD = 200;
/** A reduce asks for this much more than the amount it replaces, so the leg clears its watch line. */
export const REDUCE_HEADROOM = 1.1;

export type Source = VenueId | 'reserve';

/** Which transfers the rescuer can run: from a source into a target venue. */
export type RouteCheck = (from: Source, to: VenueId) => string | null;

export interface PlanInput {
  /** The leg in rescue: its venue, the margin that brings it back to its watch line, and what it holds (null: not read). */
  target: { venue: VenueId; symbol: string; amountUsd: number; marginUsd: number | null };
  reserveUsd: number;
  /** Free (withdrawable) margin by venue, from the risk engine's last read; absent: not read. */
  freeMargin: Partial<Record<VenueId, number>>;
  /** The venues the desk holds a leg on. */
  legVenues: readonly VenueId[];
  capUsd: number;
  /** What the rescues of the last hour still weigh against the cap (the contract's sliding hour). */
  capUsedUsd: number;
  /** Why a route cannot run (null: it can). */
  route: RouteCheck;
  /** Whether a reduce can run (a pair trader holds both legs); the reason when it cannot. */
  reduce: string | null;
  /** 1Click is called with an API key (1 bp) or without (+0.2 %). */
  keyed: boolean;
  /** policy.max_transfer_cost_bps / _flat_e6: amountIn − minAmountOut must fit max(bps share, flat). */
  maxCostBps: number;
  maxCostFlatE6: number;
  /** Recorded mode: the amount a recording sends on that route, which replaces the computed one. */
  fixedAmountUsd?: (from: Source, to: VenueId) => number | null;
  /** Transfers are held (an earlier one's outcome is unknown): only a reduce may run. */
  transfersHeld?: string | null;
  /**
   * USDC on the desk's Arbitrum address that the rescuer's own hl_withdraws left there unbridged (never another flow's):
   * spent before anything is withdrawn, and a withdraw only tops it up. null: the address could not be read, so
   * Hyperliquid is no source.
   */
  arbitrumUsd?: number | null;
  /** Why no new hl_withdraw may go out (an earlier one is still on its way); the Arbitrum USDC may still be spent. */
  hlWithdrawHeld?: string | null;
}

export type Plan =
  /**
   * A 1Click transfer of amountInUsd. Out of Hyperliquid: `arbitrumUsd` of it is USDC already on the desk's Arbitrum
   * address (an earlier withdraw), and `withdrawUsd` (null: none) is the hl_withdraw that tops it up first.
   */
  | { kind: 'transfer'; from: Source; to: VenueId; amountInUsd: number; feeUsd: number; capUsd: number; withdrawUsd: number | null; arbitrumUsd: number; notes: string[] }
  | { kind: 'reduce'; fraction: number; notes: string[] }
  | { kind: 'none'; reason: string; notes: string[] };

/** The fees a transfer is expected to cost (USD), from the measured flat fees; `withdraw` false: Hyperliquid's USDC already on Arbitrum. */
export function expectedFeeUsd(from: Source, to: VenueId, amountInUsd: number, keyed: boolean, withdraw = true): number {
  const into = to === 'hyperliquid' ? INTO_HYPERCORE_FEE_USD : INTO_EVM_OR_SOLANA_FEE_USD;
  const hops = from === 'hyperliquid' && withdraw ? HL_WITHDRAW_FEE_USD : 0;
  return into + hops + (keyed ? 0 : NO_KEY_FEE_SHARE * amountInUsd);
}

/** What a transfer sends so `amountUsd` arrives: the amount, its fees and the slippage room, at least the route's minimum. */
export function amountInFor(from: Source, to: VenueId, amountUsd: number, keyed: boolean, withdraw = true): number {
  let x = amountUsd;
  for (let i = 0; i < 3; i++) x = amountUsd + expectedFeeUsd(from, to, x, keyed, withdraw) + (x * SLIPPAGE_BPS) / 10_000;
  return Math.ceil(Math.max(x, routeMinUsd(to)) * 100 - 1e-6) / 100;
}

/** The least a route into `to` sends (1Click's minimums). */
function routeMinUsd(to: VenueId): number {
  return to === 'orderly' ? ORDERLY_MIN_IN_USD : to === 'hyperliquid' ? HYPERCORE_MIN_IN_USD : 0;
}

/**
 * The least USDC already on Arbitrum that a bridge into `to` takes on its own: 1Click's minimum into `to`, and enough
 * that its fee (no withdraw fee: that was paid) stays within MAX_FEE_SHARE. Less is still spent, together with the
 * next withdraw's USDC.
 */
export function bridgeMinUsd(to: VenueId, keyed: boolean): number {
  const into = to === 'hyperliquid' ? INTO_HYPERCORE_FEE_USD : INTO_EVM_OR_SOLANA_FEE_USD;
  let x = ceilCents(Math.max(routeMinUsd(to), into / (MAX_FEE_SHARE - (keyed ? 0 : NO_KEY_FEE_SHARE))));
  while (expectedFeeUsd('hyperliquid', to, x, keyed, false) > MAX_FEE_SHARE * x) x = Math.round(x * 100 + 1) / 100;
  return x;
}

const floorCents = (x: number) => Math.floor(x * 100 + 1e-6) / 100;
const ceilCents = (x: number) => Math.ceil(x * 100 - 1e-6) / 100;

/**
 * Hyperliquid as the source (it leaves through the desk's Arbitrum address). The USDC the rescuer's earlier withdraws
 * left there goes first: when it covers the rescue it is bridged with no withdraw; when it is short, an hl_withdraw
 * tops up the shortfall and both are bridged together, so no amount left there, however small, ever blocks a
 * withdraw. While a withdraw is still on its way (no new one), what is there is bridged alone if the route takes it.
 * Null, with notes: Hyperliquid cannot pay.
 */
function fromHyperliquid(to: VenueId, fixed: number | null, capLeft: number, input: PlanInput, notes: string[]): Extract<Plan, { kind: 'transfer' }> | null {
  const { keyed } = input;
  const onArb = floorCents(Math.max(0, input.arbitrumUsd ?? 0));
  const bridgeNeed = fixed ?? amountInFor('hyperliquid', to, input.target.amountUsd, keyed, false);
  const bridgeMin = bridgeMinUsd(to, keyed);
  const capNote = (weight: number, both: boolean) => `over the rescue cap: it would count ${weight.toFixed(2)} USD${both ? ' (hl_withdraw and the bridge both count, about twice its size)' : ''}, `
    + `and ${capLeft.toFixed(2)} of the ${input.capUsd} USD an hour is left`;
  // The Arbitrum USDC alone: no withdraw, so no withdraw fee in its fee share.
  const bridgeOnly = (amount: number): Extract<Plan, { kind: 'transfer' }> | null => {
    const fee = expectedFeeUsd('hyperliquid', to, amount, keyed, false);
    const problem = costProblem('hyperliquid', amount, fee, fee, input) ?? (amount > capLeft ? capNote(amount, false) : null);
    if (problem === null) return { kind: 'transfer', from: 'hyperliquid', to, amountInUsd: amount, feeUsd: fee, capUsd: amount, withdrawUsd: null, arbitrumUsd: amount, notes };
    notes.push(`hyperliquid (the ${onArb.toFixed(2)} USDC on Arbitrum): ${problem}`);
    return null;
  };
  if (onArb > 0 && onArb >= bridgeNeed) {
    // Enough is there: at least what the route takes alone, at most what is there. A withdraw would only cost more.
    return bridgeOnly(fixed ?? Math.min(onArb, Math.max(bridgeNeed, bridgeMin)));
  }
  if (input.hlWithdrawHeld !== undefined && input.hlWithdrawHeld !== null) {
    notes.push(`hyperliquid: no new hl_withdraw: ${input.hlWithdrawHeld}`);
  } else {
    // A withdraw tops up the shortfall; what arrives is bridged together with what was there. The bridge is sized as
    // a bridge (its own fees and slippage); Hyperliquid's 1 USDC goes on the withdraw only, never into the bridge.
    const arrive = ceilCents(Math.max(bridgeNeed - onArb, onArb > 0 ? HL_TOP_UP_MIN_USD : 0));
    const withdraw = ceilCents(arrive + HL_WITHDRAW_FEE_USD);
    const amountIn = Math.round((onArb + arrive) * 100) / 100;
    const fee = expectedFeeUsd('hyperliquid', to, amountIn, keyed, true);
    // Hyperliquid's own fee is not in the quote.
    const problem = costProblem('hyperliquid', amountIn, fee, fee - HL_WITHDRAW_FEE_USD, input);
    const free = input.freeMargin.hyperliquid;
    // hl_withdraw must keep amount + 1 USDC within the withdrawable.
    const needFree = withdraw + HL_WITHDRAW_FEE_USD;
    const capWeight = withdraw + amountIn;
    if (problem !== null) notes.push(`hyperliquid: ${problem}`);
    else if (free === undefined || free < needFree) notes.push(`hyperliquid: ${free === undefined ? 'free margin not read' : `${free.toFixed(2)} USD free`}, under the ${needFree.toFixed(2)} USD it would take`);
    else if (capWeight > capLeft) notes.push(`hyperliquid: ${capNote(capWeight, true)}`);
    else return { kind: 'transfer', from: 'hyperliquid', to, amountInUsd: amountIn, feeUsd: fee, capUsd: capWeight, withdrawUsd: withdraw, arbitrumUsd: onArb, notes };
  }
  // No withdraw: what is there is bridged alone, in part, when the route takes that much on its own.
  if (onArb <= 0) return null;
  if (onArb < bridgeMin) {
    notes.push(`hyperliquid: the ${onArb.toFixed(2)} USDC on Arbitrum is under the ${bridgeMin.toFixed(2)} a bridge into ${to} takes alone; the next withdraw takes it along`);
    return null;
  }
  const partial = bridgeOnly(onArb);
  if (partial !== null) notes.push(`hyperliquid: only ${onArb.toFixed(2)} of the ${bridgeNeed.toFixed(2)} USD is on Arbitrum; it is bridged first, a later rescue takes the rest`);
  return partial;
}

/**
 * Why a transfer of `amountIn` with expected fees `fee` (of which `hopFee` is in 1Click's quote) is passed over, or
 * null: the fee share, then the policy's cost bound, which must leave the slippage a quote needs.
 */
function costProblem(from: Source, amountIn: number, fee: number, hopFee: number, input: PlanInput): string | null {
  void from;
  if (fee > MAX_FEE_SHARE * amountIn) {
    return `fees of about ${fee.toFixed(2)} USD are ${Math.round((fee / amountIn) * 100)} % of the ${amountIn.toFixed(2)} USD it would send, over the ${MAX_FEE_SHARE * 100} % this desk accepts`;
  }
  // The quote's cost (amountIn − minAmountOut) is the fee plus the slippage room: it must fit the policy's bound.
  const allowed = Math.max((amountIn * input.maxCostBps) / 10_000, input.maxCostFlatE6 / 1e6);
  const roomBps = ((allowed - hopFee) / amountIn) * 10_000;
  if (roomBps < SLIPPAGE_BPS) {
    return `the policy's transfer cost bound (${allowed.toFixed(2)} USD on ${amountIn.toFixed(2)}) leaves ${Math.max(0, Math.floor(roomBps))} bps after the fee, under the ${SLIPPAGE_BPS} bps of slippage a quote needs`;
  }
  return null;
}

/**
 * The plan for one rescue (see the header). Every source passed over leaves a note saying why, so the journal can say
 * what was tried.
 */
export function planRescue(input: PlanInput): Plan {
  const plan = planOnce(input);
  if (plan.kind === 'transfer') return plan;
  // Why no transfer, in sizes: the smallest rescue each route tried takes at this policy.
  const to = input.target.venue;
  const tried = (['reserve', ...input.legVenues] as Source[]).filter((f, i, all) => f !== to && f !== 'orderly' && all.indexOf(f) === i && input.route(f, to) === null);
  if (tried.length > 0) {
    const sizes = tried.map((from) => rescueSize(from, to, input)).map((r) => `${r.from} -> ${r.to} ${sizeText(r)}`);
    plan.notes.push(`rescue sizes at this policy: ${sizes.join(', ')}`);
  }
  return plan;
}

/** A route's rescue sizes, in USD of margin needed on the target: null minUsd: none fits; null maxUsd: no bound up to SIZE_SCAN_MAX_USD. */
export interface RescueSize {
  from: Source;
  to: VenueId;
  minUsd: number | null;
  maxUsd: number | null;
}

export function sizeText(r: RescueSize): string {
  if (r.minUsd === null) return `takes no rescue up to ${SIZE_SCAN_MAX_USD} USD`;
  return r.maxUsd === null ? `from ${r.minUsd.toFixed(2)} USD` : `from ${r.minUsd.toFixed(2)} to ${r.maxUsd.toFixed(2)} USD`;
}

/** The routes the rescuer sizes (Orderly is never a source; Hyperliquid -> Orderly is not quoted). */
export const SIZED_ROUTES: readonly (readonly [Source, VenueId])[] = [
  ['reserve', 'hyperliquid'], ['reserve', 'orderly'], ['reserve', 'phoenix'], ['phoenix', 'hyperliquid'], ['phoenix', 'orderly'], ['hyperliquid', 'phoenix'],
];

const sizes = new Map<string, RescueSize>();

/**
 * The smallest and largest rescue (USD of margin on the target, to the cent) the route `from -> to` plans as a
 * transfer under the policy's cap and cost bounds, with the source holding plenty, a full cap and nothing on
 * Arbitrum. Remembered per policy.
 */
export function rescueSize(from: Source, to: VenueId, p: Pick<PlanInput, 'capUsd' | 'keyed' | 'maxCostBps' | 'maxCostFlatE6'>): RescueSize {
  const key = `${from}|${to}|${p.capUsd}|${p.keyed}|${p.maxCostBps}|${p.maxCostFlatE6}`;
  const known = sizes.get(key);
  if (known !== undefined) return known;
  let minUsd: number | null = null;
  let maxUsd: number | null = null;
  const top = SIZE_SCAN_MAX_USD * 100;
  for (let cents = 1; cents <= top; cents++) {
    const plan = planOnce({
      target: { venue: to, symbol: 'X', amountUsd: cents / 100, marginUsd: 1e9 }, reserveUsd: from === 'reserve' ? 1e9 : 0,
      freeMargin: from === 'reserve' ? {} : { [from]: 1e9 }, legVenues: from === 'reserve' ? [to] : [to, from],
      capUsd: p.capUsd, capUsedUsd: 0, route: () => null, reduce: 'sizing', keyed: p.keyed, maxCostBps: p.maxCostBps, maxCostFlatE6: p.maxCostFlatE6,
      arbitrumUsd: 0,
    });
    if (plan.kind !== 'transfer' || plan.from !== from) continue;
    minUsd ??= cents / 100;
    maxUsd = cents / 100;
  }
  const r: RescueSize = { from, to, minUsd, maxUsd: maxUsd === null || maxUsd * 100 >= top ? null : maxUsd };
  sizes.set(key, r);
  return r;
}

/** Each sized route's rescue sizes at a desk's policy. */
export function rescueSizes(policy: { rescue_cap_usd_per_hour: number; max_transfer_cost_bps: number; max_transfer_cost_flat_e6: number }, keyed: boolean): RescueSize[] {
  const p = { capUsd: policy.rescue_cap_usd_per_hour, keyed, maxCostBps: policy.max_transfer_cost_bps, maxCostFlatE6: policy.max_transfer_cost_flat_e6 };
  return SIZED_ROUTES.map(([from, to]) => rescueSize(from, to, p));
}

function planOnce(input: PlanInput): Plan {
  const { target } = input;
  const notes: string[] = [];
  const to = target.venue;
  const capLeft = Math.max(0, input.capUsd - input.capUsedUsd);
  const partners = input.legVenues.filter((v) => v !== to && v !== 'orderly');
  const sources: Source[] = ['reserve', ...new Set(partners)];
  for (const from of sources) {
    if (input.transfersHeld !== undefined && input.transfersHeld !== null) {
      notes.push(`no transfer: ${input.transfersHeld}`);
      break;
    }
    const routeProblem = input.route(from, to);
    if (routeProblem !== null) {
      notes.push(`${from}: ${routeProblem}`);
      continue;
    }
    if (from === 'hyperliquid' && input.arbitrumUsd === null) {
      notes.push('hyperliquid: the desk\'s Arbitrum USDC could not be read, so neither a withdraw nor a bridge of what is there runs');
      continue;
    }
    const fixed = input.fixedAmountUsd?.(from, to) ?? null;
    const amountIn = fixed ?? amountInFor(from, to, target.amountUsd, input.keyed);
    if (from === 'hyperliquid') {
      const hl = fromHyperliquid(to, fixed, capLeft, input, notes);
      if (hl !== null) return hl;
      continue;
    }
    const fee = expectedFeeUsd(from, to, amountIn, input.keyed);
    const problem = costProblem(from, amountIn, fee, fee, input);
    if (problem !== null) {
      notes.push(`${from}: ${problem}`);
      continue;
    }
    if (from === 'reserve') {
      if (input.reserveUsd < amountIn) {
        notes.push(`reserve: ${input.reserveUsd.toFixed(2)} USD idle on NEAR, under the ${amountIn.toFixed(2)} USD it would send`);
        continue;
      }
      return { kind: 'transfer', from, to, amountInUsd: amountIn, feeUsd: fee, capUsd: 0, withdrawUsd: null, arbitrumUsd: 0, notes };
    }
    const free = input.freeMargin[from];
    if (free === undefined || free < amountIn) {
      notes.push(`${from}: ${free === undefined ? 'free margin not read' : `${free.toFixed(2)} USD free`}, under the ${amountIn.toFixed(2)} USD it would take`);
      continue;
    }
    if (amountIn > capLeft) {
      notes.push(`${from}: over the rescue cap: it would count ${amountIn.toFixed(2)} USD, and ${capLeft.toFixed(2)} of the ${input.capUsd} USD an hour is left`);
      continue;
    }
    return { kind: 'transfer', from, to, amountInUsd: amountIn, feeUsd: fee, capUsd: amountIn, withdrawUsd: null, arbitrumUsd: 0, notes };
  }
  if (input.reduce !== null) return { kind: 'none', reason: `no source can pay and the legs cannot be reduced: ${input.reduce}`, notes };
  // Unknown margin would size the cut at the whole leg: refused instead.
  if (target.marginUsd === null || !(target.marginUsd >= 0)) {
    return { kind: 'none', reason: `no source can pay, and the legs are not reduced: ${target.venue} ${target.symbol}'s margin is not read, so the cut cannot be sized`, notes };
  }
  const fraction = Math.min(1, (target.amountUsd * REDUCE_HEADROOM) / Math.max(1e-9, target.marginUsd + target.amountUsd * REDUCE_HEADROOM));
  return { kind: 'reduce', fraction, notes };
}

/** The rescue cap's sliding hour (interfaces §1.3): each amount weighs amount × (1 − elapsed / 1 h). */
export class CapLedger {
  readonly #entries: { usd: number; at: number }[] = [];

  /** What still weighs at `now`, oldest first (the rescuer's state file keeps it across restarts). */
  entries(now: number): { usd: number; at: number }[] {
    this.used(now);
    return this.#entries.map((e) => ({ ...e }));
  }

  add(usd: number, at: number): void {
    if (usd > 0) this.#entries.push({ usd, at });
  }

  used(now: number): number {
    let sum = 0;
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const e = this.#entries[i]!;
      const w = 1 - (now - e.at) / 3_600_000;
      if (w <= 0) this.#entries.splice(i, 1);
      else sum += e.usd * Math.min(1, w);
    }
    return sum;
  }
}
