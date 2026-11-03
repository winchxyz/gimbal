// Where a rescue's margin comes from (E9). Pure: the rescuer (rescuer.ts) passes the desk as the risk engine last read
// it and what its routes can do, and runs the plan this returns.
//
// Source order, the first that can pay wins:
//   1. the reserve: the desk's idle_usdc on NEAR, sent with fund_venue (its own limits, not the rescue cap);
//   2. free margin on the other leg's venue: Phoenix with sol_sign_rescue, or Hyperliquid with hl_withdraw to the desk's
//      own Arbitrum address and then evm_usdc_to_intents (1Click quotes nothing out of HyperCore). Both count against
//      policy.rescue_cap_usd_per_hour; the Hyperliquid route counts twice (hl_withdraw's amount, then the bridge's);
//   3. reducing both legs reduce-only by the same size, so the hedge stays flat and the leg needs less margin.
// Orderly is never a source: its money out is a settle, a withdraw (~50 s to Arbitrum) and an EIP-3009 transfer, four
// MPC signatures in all.
//
// Fees are roughly flat per transfer (measured on mainnet: 0.32 USDC Phoenix -> Hyperliquid on 4, the same NEAR ->
// Hyperliquid on 12; Hyperliquid's withdraw takes 1 USDC more), so a small rescue loses a large share of what it
// moves. A route whose expected fees are over MAX_FEE_SHARE (10 %) of the amount it sends is skipped, and the legs are
// reduced instead: a 10 % fee on margin is worse than giving up 10 % of a funding carry's size.

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
   * USDC already on the desk's Arbitrum address (a Hyperliquid withdraw that was not bridged): spent before any new
   * withdraw, in part when it is less than the rescue needs. null: it could not be read, so Hyperliquid is no source.
   */
  arbitrumUsd?: number | null;
  /** Why no new hl_withdraw may go out (an earlier one's USDC is still on Arbitrum or on its way); the Arbitrum USDC may still be spent. */
  hlWithdrawHeld?: string | null;
}

export type Plan =
  | { kind: 'transfer'; from: Source; to: VenueId; amountInUsd: number; feeUsd: number; capUsd: number; withdrawUsd: number | null; notes: string[] }
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
    // Hyperliquid: USDC already on the desk's Arbitrum address goes first, with no withdraw (its fee was paid), all of
    // it when it is less than the rescue needs but still at least the route's minimum.
    const onArbitrum = from === 'hyperliquid' ? Math.floor((input.arbitrumUsd ?? 0) * 100 + 1e-6) / 100 : 0;
    const strandedIn = Math.min(onArbitrum, fixed ?? amountInFor(from, to, target.amountUsd, input.keyed, false));
    if (from === 'hyperliquid' && strandedIn > 0 && strandedIn >= routeMinUsd(to)) {
      const fee = expectedFeeUsd(from, to, strandedIn, input.keyed, false);   // no withdraw: no withdraw fee
      const problem = costProblem(from, strandedIn, fee, fee, input)
        ?? (strandedIn > capLeft ? `over the rescue cap: it would count ${strandedIn.toFixed(2)} USD, and ${capLeft.toFixed(2)} of the ${input.capUsd} USD an hour is left` : null);
      if (problem === null) {
        const need = fixed ?? amountInFor(from, to, target.amountUsd, input.keyed, false);
        if (strandedIn < need) notes.push(`hyperliquid: only ${strandedIn.toFixed(2)} of the ${need.toFixed(2)} USD is on Arbitrum; it is bridged first, a later rescue takes the rest`);
        return { kind: 'transfer', from, to, amountInUsd: strandedIn, feeUsd: fee, capUsd: strandedIn, withdrawUsd: null, notes };
      }
      // Not worth bridging alone: a withdraw may still pay, unless withdraws are held.
      notes.push(`hyperliquid (the ${onArbitrum.toFixed(2)} USDC on Arbitrum): ${problem}`);
    }
    if (from === 'hyperliquid' && input.hlWithdrawHeld !== undefined && input.hlWithdrawHeld !== null) {
      notes.push(`hyperliquid: no new hl_withdraw: ${input.hlWithdrawHeld}`);
      continue;
    }
    const fee = expectedFeeUsd(from, to, amountIn, input.keyed);
    const hopFee = from === 'hyperliquid' ? fee - HL_WITHDRAW_FEE_USD : fee;   // Hyperliquid's own fee is not in the quote
    const problem = costProblem(from, amountIn, fee, hopFee, input);
    if (problem !== null) {
      notes.push(`${from}: ${problem}`);
      continue;
    }
    if (from === 'reserve') {
      if (input.reserveUsd < amountIn) {
        notes.push(`reserve: ${input.reserveUsd.toFixed(2)} USD idle on NEAR, under the ${amountIn.toFixed(2)} USD it would send`);
        continue;
      }
      return { kind: 'transfer', from, to, amountInUsd: amountIn, feeUsd: fee, capUsd: 0, withdrawUsd: null, notes };
    }
    const free = input.freeMargin[from];
    // Hyperliquid: hl_withdraw takes amountIn plus its own fee, and must keep amount + 1 USDC within the withdrawable.
    const withdraw = from === 'hyperliquid' ? Math.ceil((amountIn + HL_WITHDRAW_FEE_USD) * 100 - 1e-6) / 100 : null;
    const needFree = withdraw === null ? amountIn : withdraw + HL_WITHDRAW_FEE_USD;
    if (free === undefined || free < needFree) {
      notes.push(`${from}: ${free === undefined ? 'free margin not read' : `${free.toFixed(2)} USD free`}, under the ${needFree.toFixed(2)} USD it would take`);
      continue;
    }
    const capWeight = withdraw === null ? amountIn : withdraw + amountIn;
    if (capWeight > capLeft) {
      notes.push(`${from}: over the rescue cap: it would count ${capWeight.toFixed(2)} USD${withdraw === null ? '' : ' (hl_withdraw and the bridge both count, about twice its size)'}, `
        + `and ${capLeft.toFixed(2)} of the ${input.capUsd} USD an hour is left`);
      continue;
    }
    return { kind: 'transfer', from, to, amountInUsd: amountIn, feeUsd: fee, capUsd: capWeight, withdrawUsd: withdraw, notes };
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
