// serve's strategy loop (src/strategy/loop.ts), built from what serve already holds: the pair's hands (serve-pair.ts,
// mainnet only, with GIMBAL_TRADE=1), the desk's numbers from the last `desk` event, the venues' free margin, whether
// a live rescue route covers each venue, the scanner's carry and the venues' lots for decide(), the NEAR AI client for
// the veto, and what makes the loop wait (a rescue or an ADL unwind running, a close in flight).
//
// The loop decides in every mode (testnet and replay too, with GIMBAL_TRADE=1): with no hands its acts are journaled
// as refused, nothing is signed. On mainnet it opens and closes through the same code as pair-mainnet open and close
// (pair-ops.ts), and only the short hyperliquid / long phoenix direction pair-mainnet opens.

import type { ContractPolicy, DeskState, Mode, StrategyConfig, StreamEvent, Window as FundingWindow } from '@gimbal/shared';
import { isEnterable } from '../scanner/price.ts';
import type { WindowCarry } from '../scanner/scanner.ts';
import { LIVE_RESCUE } from '../trade/carry-plan.ts';
import { userStateDir } from '../trade/trader-state.ts';
import { kiloBase } from '../venues/base-symbol.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Clock, Market, VenueReader } from '../venues/venue.ts';
import type { DecideInput, Decision } from '../strategy/decide.ts';
import type { ActOutcome, BookFill, BookSink, HandsHeld, LoopHands, WindowFacts } from '../strategy/loop.ts';
import type { PairResult } from '../trade/pair.ts';
import { qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import { LoopStore, StrategyLoop, loopStateFile } from '../strategy/loop.ts';
import type { VetoSource } from '../strategy/veto.ts';
import type { HandsResult, PairHands, ServePair } from './serve-pair.ts';

/** The venues decide() reads free margin and live rescue for. */
export const LOOP_VENUES = ['hyperliquid', 'phoenix', 'orderly'] as const;
/** Markets (lot sizes) are read again after this. */
const MARKETS_TTL_MS = 3_600_000;
/** A mid price is read again after this. */
const MID_TTL_MS = 30_000;
/** At most this many windows get lots per check (each may need two book reads). */
const MAX_LOT_WINDOWS = 6;

export interface ServeLoopInput {
  mode: Mode;
  env: (name: string) => string | undefined;
  /** --once: the loop never trades then. */
  once: boolean;
  /** GIMBAL_STATE_DIR when set; else the per-user state directory, next to the trader state. */
  stateDir?: string;
  contractId: string | null;
  deskId: string | null;
  pair: ServePair | null;
  lastDesk: () => DeskState | null;
  /** The desk's venue accounts, for free margin (none in replay without a contract). */
  accounts: { venue: string; read: () => Promise<AccountState> }[];
  /** A live rescuer runs (mainnet with GIMBAL_RESCUE=1): the venues LIVE_RESCUE names have a route. */
  rescueLive: boolean;
  busy: () => string | null;
  windows: () => readonly FundingWindow[] | null;
  strategy: () => StrategyConfig;
  policy: () => ContractPolicy | null;
  publish: (event: StreamEvent) => void;
  clock: Clock;
  log: (line: string) => void;
  /** The scanner's carry per window and the desk venues' readers, for decide()'s 14 days and lots. */
  carry?: (windowId: string) => WindowCarry | null;
  venues?: readonly VenueReader[];
  /** NEAR AI (the client POST /policy/draft uses); none = every window passes, "no veto check". */
  veto?: VetoSource;
  /** The position book: every carried-out enter and exit; default none. */
  book?: BookSink;
  /** Tests: stand-ins for the hands and decide(). */
  hands?: LoopHands | null;
  decide?: (input: DecideInput) => Decision;
}

export function serveLoop(input: ServeLoopInput): StrategyLoop {
  const trade = input.env('GIMBAL_TRADE') === '1' && !input.once;
  const pairHands = input.pair?.hands;
  const hands = input.hands !== undefined ? input.hands : pairHands === undefined ? null : loopHands(pairHands, input.lastDesk, input.log, input.busy);
  const handsWhy = hands !== null ? undefined
    : input.pair === null ? (input.mode === 'mainnet' ? 'no contract desk is set (GIMBAL_CONTRACT_ID, DESK_ID)' : `serve holds a pair on mainnet only, this is ${input.mode}`)
    : input.pair.notTrading() ?? 'the pair is alert only';
  const dir = input.stateDir ?? userStateDir(input.env);
  const store = new LoopStore(loopStateFile(dir, input.mode, input.contractId, input.deskId));
  const facts = input.carry === undefined ? undefined : windowFacts({
    carry: input.carry, venues: input.venues ?? [], symbols: () => policySymbols(input.policy()), clock: input.clock, log: input.log,
  });
  return new StrategyLoop({
    trade, hands, ...(handsWhy === undefined ? {} : { handsWhy }),
    strategy: input.strategy, policy: input.policy, windows: input.windows,
    freeMargin: async () => {
      const out: Record<string, number> = {};
      await Promise.all(input.accounts.map(async (a) => {
        try {
          out[a.venue] = (await a.read()).freeMarginUsd;
        } catch (err) {
          input.log(`strategy loop: ${a.venue} free margin not read (${errorMessage(err)})`);
        }
      }));
      return out;
    },
    liveRescue: () => Object.fromEntries(LOOP_VENUES.map((v) => [v, input.rescueLive && LIVE_RESCUE[v] === true])),
    ...(facts === undefined ? {} : { facts }),
    busy: input.busy, store, publish: input.publish, clock: input.clock, log: input.log,
    ...(input.decide === undefined ? {} : { decide: input.decide }),
    ...(input.veto === undefined ? {} : { veto: input.veto }),
    ...(input.book === undefined ? {} : { book: input.book }),
  });
}

/** Each leg's fills over the results of one open or close: summed size, size-weighted price, summed fee. */
export function fillsOf(results: readonly PairResult[]): BookFill[] {
  const byLeg = new Map<string, { venue: string; side: 'BUY' | 'SELL'; qty: bigint; notional: number; priced: number; fee: number; feeKnown: boolean }>();
  for (const r of results) {
    for (const leg of r.legs) {
      for (const o of leg.orders) {
        if (o.filled === null) continue;
        const q = toQty(o.filled);
        if (q === 0n) continue;
        const key = `${leg.venue}|${o.ref.side}`;
        const f = byLeg.get(key) ?? { venue: leg.venue, side: o.ref.side, qty: 0n, notional: 0, priced: 0, fee: 0, feeKnown: true };
        const n = Number(o.filled);
        f.qty += q;
        if (o.avgPx !== null) {
          f.notional += n * o.avgPx;
          f.priced += n;
        }
        if (o.fee === null) f.feeKnown = false;
        else f.fee += o.fee;
        byLeg.set(key, f);
      }
    }
  }
  return [...byLeg.values()].map((f) => ({
    venue: f.venue, side: f.side, qty: qtyString(f.qty), avgPx: f.priced > 0 ? f.notional / f.priced : null, feeUsd: f.feeKnown ? f.fee : null,
  }));
}

/** The pair symbols the policy allows: in both hl_assets and phoenix_markets. */
export function policySymbols(policy: ContractPolicy | null): string[] {
  if (policy === null) return [];
  const px = new Set(policy.phoenix_markets.map((m) => m.symbol));
  return policy.hl_assets.map((a) => a.symbol).filter((s) => px.has(s));
}

/**
 * serve-pair's hands as the loop takes them: windows mapped to policy symbols, the desk's numbers for the held pair
 * (its symbol's legs only), a single leg named, and `busy` (a rescue running, fund_venue included; an ADL unwind;
 * panic_close) refusing before the hands' own reasons.
 */
export function loopHands(hands: PairHands, lastDesk: () => DeskState | null, log: (line: string) => void, busy: () => string | null = () => null): LoopHands {
  const outcome = (r: HandsResult): ActOutcome => {
    for (const line of r.lines) log(`strategy loop: ${line}`);
    return { ok: r.ok, reason: r.reason, sent: r.sent ?? (r.results.length > 0 || r.tx.length > 0), tx: r.tx, feeUsd: r.feeUsd, open: r.open, fills: fillsOf(r.results) };
  };
  return {
    blocked: () => busy() ?? hands.blocked(),
    held: (): HandsHeld | null => {
      const symbol = hands.heldSymbol();
      if (symbol === null) return null;
      const legs = (lastDesk()?.legs ?? []).filter((l) => sameSymbol(l.symbol, symbol));
      const legUsd = legs.length === 0 ? 0 : Math.max(...legs.map((l) => l.size * l.mark));
      let pnlUsd = 0;
      // What closing each leg frees on its venue: its margin plus its P&L.
      const freed: Record<string, number> = {};
      for (const l of legs) {
        const price = (l.mark - l.entry) * l.size * (l.side === 'long' ? 1 : -1);
        pnlUsd += price + l.fundingEarnedUsd + l.unsettledFundingUsd + l.feesUsd;
        freed[l.venue] = (freed[l.venue] ?? 0) + Math.max(0, l.marginUsd + price);
      }
      const known = hands.heldLegs();
      const open = known.filter((l) => l.qty !== 0n);
      // One leg: one venue holds a position and the other is known flat (an unknown leg is not called flat).
      const oneLeg = open.length === 1 && open[0]!.qty !== null && known.length === 2 && known.every((l) => l.qty !== null)
        ? { venue: open[0]!.venue, qty: signedQtyString(open[0]!.qty!) } : null;
      return { symbol, legUsd, pnlUsd, oneLeg, ...(legs.length === 0 ? {} : { freedMarginUsd: freed }) };
    },
    symbolOf: (w) => windowSymbol(w, hands.symbols),
    open: async (r) => outcome(await hands.open({ symbol: r.symbol, legUsd: r.legUsd, leverage: r.leverage, reason: r.reason, qty: r.qty })),
    close: async (r) => outcome(await hands.close({ reason: r.reason })),
  };
}

/** A desk leg's symbol and a policy symbol name the same market (kPEPE and PEPE, case aside). */
function sameSymbol(a: string, b: string): boolean {
  const n = (s: string) => kiloBase(s).base.toUpperCase();
  return a.toUpperCase() === b.toUpperCase() || n(a) === n(b);
}

/** The policy symbol (a Hyperliquid asset Phoenix also lists) a window trades here, or why serve cannot trade it. */
export function windowSymbol(w: FundingWindow, symbols: readonly string[]): { symbol: string } | { refused: string } {
  if (w.longVenue !== 'phoenix' || w.shortVenue !== 'hyperliquid') {
    return { refused: `serve opens short hyperliquid, long phoenix only (as pair-mainnet open); ${w.id} is long ${w.longVenue}, short ${w.shortVenue}` };
  }
  const base = w.symbol.toUpperCase();
  const symbol = symbols.find((s) => s.toUpperCase() === base || kiloBase(s).base.toUpperCase() === base);
  return symbol === undefined ? { refused: `${w.symbol} is not a market both legs list in the desk's policy (${symbols.join(', ') || 'none'})` } : { symbol };
}

/**
 * decide()'s and the veto's facts: every window's 14-day gross and legs' open interest from the scanner's carry; and,
 * for the enterable windows serve could trade (at most MAX_LOT_WINDOWS), each leg's lot (Market.lotSize) and the mid
 * pair-mainnet sizes on (the mean of both venues' best bid and ask). A venue that does not answer leaves its windows
 * without lots: decide() does not enter them.
 */
export function windowFacts(p: {
  carry: (windowId: string) => WindowCarry | null; venues: readonly VenueReader[]; symbols: () => readonly string[]; clock: Clock;
  log: (line: string) => void;
}): (windows: readonly FundingWindow[]) => Promise<WindowFacts> {
  const markets = new Map<string, { at: number; bySymbol: Map<string, Market> }>();
  const mids = new Map<string, { at: number; px: number | null }>();
  const reader = (id: string) => p.venues.find((v) => v.id === id);
  const marketsOf = async (venue: string): Promise<Map<string, Market> | null> => {
    const now = p.clock.now();
    const cached = markets.get(venue);
    if (cached !== undefined && now - cached.at < MARKETS_TTL_MS) return cached.bySymbol;
    const r = reader(venue);
    if (r === undefined) return null;
    try {
      const bySymbol = new Map((await r.markets()).map((m) => [m.symbol, m]));
      markets.set(venue, { at: now, bySymbol });
      return bySymbol;
    } catch (err) {
      p.log(`strategy loop: ${venue} markets not read (${errorMessage(err)}), no lots this check`);
      return cached?.bySymbol ?? null;
    }
  };
  const midOf = async (symbol: string): Promise<number | null> => {
    const now = p.clock.now();
    const cached = mids.get(symbol);
    if (cached !== undefined && now - cached.at < MID_TTL_MS) return cached.px;
    const hl = reader('hyperliquid');
    const px = reader('phoenix');
    let mid: number | null = null;
    if (hl !== undefined && px !== undefined) {
      try {
        const [a, b] = await Promise.all([hl.book(symbol, 5), px.book(symbol, 5)]);
        const quotes = [a.bids[0]?.px, a.asks[0]?.px, b.bids[0]?.px, b.asks[0]?.px];
        if (quotes.every((q) => q !== undefined && q > 0)) mid = (quotes as number[]).reduce((s, q) => s + q, 0) / 4;
      } catch (err) {
        p.log(`strategy loop: ${symbol} books not read (${errorMessage(err)}), no lots this check`);
      }
    }
    mids.set(symbol, { at: now, px: mid });
    return mid;
  };
  return async (windows) => {
    const gross14dAprPct: Record<string, number | null> = {};
    const openInterest: Record<string, { longUsd: number | null; shortUsd: number | null }> = {};
    for (const w of windows) {
      const c = p.carry(w.id);
      if (c === null) continue;
      gross14dAprPct[w.id] = c.estimate.gross.d14AprPct;
      openInterest[w.id] = { longUsd: c.long.oiUsd, shortUsd: c.short.oiUsd };
    }
    const lots: NonNullable<WindowFacts['lots']> = {};
    const symbols = p.symbols();
    const candidates = windows
      .filter((w) => isEnterable(w))
      .map((w) => ({ w, s: windowSymbol(w, symbols) }))
      .filter((x): x is { w: FundingWindow; s: { symbol: string } } => 'symbol' in x.s)
      .sort((a, b) => b.w.netAprPct - a.w.netAprPct)
      .slice(0, MAX_LOT_WINDOWS);
    if (candidates.length > 0) {
      const [hlM, pxM] = await Promise.all([marketsOf('hyperliquid'), marketsOf('phoenix')]);
      for (const { w, s } of candidates) {
        const short = hlM?.get(s.symbol);
        const long = pxM?.get(s.symbol);
        if (short === undefined || long === undefined) continue;
        const px = await midOf(s.symbol);
        if (px === null) continue;
        lots[w.id] = { longLot: long.lotSize, shortLot: short.lotSize, px };
      }
    }
    return { gross14dAprPct, openInterest, lots };
  };
}
