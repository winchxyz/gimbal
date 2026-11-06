// serve's strategy loop (src/strategy/loop.ts), built from what serve already holds: the pair's hands (serve-pair.ts,
// mainnet only, with GIMBAL_TRADE=1), the desk's numbers from the last `desk` event, the venues' free margin, whether
// a live rescue route covers each venue, the scanner's carry and the venues' lots for decide(), the NEAR AI client for
// the veto, and what makes the loop wait (a rescue or an ADL unwind running, a close in flight).
//
// The loop decides in every mode (testnet and replay too, with GIMBAL_TRADE=1): with no hands its acts are journaled
// as refused, nothing is signed. On mainnet it opens and closes through the same code as pair-mainnet open and close
// (pair-ops.ts), and only the short hyperliquid / long phoenix direction pair-mainnet opens. With
// GIMBAL_ORDERLY_PAIRS=1 (the hands then name the symbols each pair of venues may open on: PairHands.pairSymbols) a
// window on any two of Hyperliquid, Orderly and Phoenix is traded in the direction it pays, its lots and mid read on
// its own two venues, and the open names its legs.

import type { ContractPolicy, DeskState, Mode, StrategyConfig, StreamEvent, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { isEnterable } from '../scanner/price.ts';
import type { WindowCarry } from '../scanner/scanner.ts';
import { withTimeout } from '../scanner/scanner.ts';
import type { RiskLedgerSink } from '../book/risk-ledger.ts';
import { LIVE_RESCUE } from '../trade/carry-plan.ts';
import { PAIR_VENUES, venueSymbol } from '../trade/pair-shape.ts';
import { orderlyBase } from '../venues/orderly.ts';
import { userStateDir } from '../trade/trader-state.ts';
import { kiloBase } from '../venues/base-symbol.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Book, Clock, Market, VenueReader } from '../venues/venue.ts';
import type { DecideInput, Decision } from '../strategy/decide.ts';
import type { ActOutcome, BookFill, BookSink, HandsHeld, LoopHands, LoopHeld, WindowFacts } from '../strategy/loop.ts';
import type { AdoptInput, CloseLookup, OutsideClose, PositionBook } from '../book/book.ts';
import type { ProtectionCloseReport } from '../trade/protected-pair.ts';
import type { BookRecord } from '../book/types.ts';
import type { PairResult } from '../trade/pair.ts';
import { qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import { LoopStore, StrategyLoop, loopStateFile } from '../strategy/loop.ts';
import type { VetoLegFacts, VetoSource } from '../strategy/veto.ts';
import type { HandsResult, PairAdl, PairHands, ServePair } from './serve-pair.ts';

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
  accounts: LoopAccount[];
  /**
   * A live rescuer runs (mainnet with GIMBAL_RESCUE=1): the venues LIVE_RESCUE names have a route. A function in serve:
   * the live rescuer may start late, after a failed start read (rescue-retry.ts).
   */
  rescueLive: boolean | (() => boolean);
  busy: () => string | null;
  /**
   * Why no order may go out now, for an open already past the loop's gate (a rescue, fund_venue included; an ADL
   * unwind; panic_close): asked again right before its first order and before each later part. Unlike `busy` it does
   * not count the pair's own operation (the open itself). None: `busy`.
   */
  orderGate?: () => string | null;
  windows: () => readonly FundingWindow[] | null;
  strategy: () => StrategyConfig;
  policy: () => ContractPolicy | null;
  publish: (event: StreamEvent) => void;
  clock: Clock;
  log: (line: string) => void;
  /** The scanner's carry per window and the desk venues' readers, for decide()'s 14 days and lots. */
  carry?: (windowId: string) => WindowCarry | null;
  venues?: readonly VenueReader[];
  /** NEAR AI (the client POST /policy/draft uses); none = no key, every enter and rotate is held, never passed. */
  veto?: VetoSource;
  /** How a reply shows its attestation (Attestor.label). */
  attestation?: () => string;
  /** Every risk check outcome, and the refused windows' hours (book/risk-ledger.ts); with `grossHours`. */
  ledger?: RiskLedgerSink;
  /** The scanner's grossHours. */
  grossHours?: (windowId: string, fromMs: number, toMs: number) => { t: number; grossAprPct: number }[] | null;
  /** The position book: every carried-out enter and exit; default none. */
  book?: BookSink;
  /**
   * The symbols a pair long `long` / short `short` may open on (GIMBAL_ORDERLY_PAIRS=1); default the pair's hands'
   * (PairHands.pairSymbols). None: short Hyperliquid / long Phoenix only, on policySymbols.
   */
  pairSymbols?: (long: VenueId, short: VenueId) => readonly string[];
  /** Tests: stand-ins for the hands and decide(). */
  hands?: LoopHands | null;
  decide?: (input: DecideInput) => Decision;
  /** What `hands` are, for the loop's start line (replay: the replay desk's). */
  handsLine?: string;
}

/**
 * A desk venue account the loop reads free margin from. `logOnce`: a failed read is logged once per kind of error
 * (digits ignored) until the venue reads again, not at every decision (serve's Orderly account, which stays unknown
 * while its private session is down); without it every failure is logged.
 */
export interface LoopAccount {
  venue: string;
  read: () => Promise<AccountState>;
  logOnce?: boolean;
}

/** decide()'s free margin per venue: a venue whose read fails is left out (and logged, see LoopAccount). */
export function freeMarginReader(accounts: readonly LoopAccount[], log: (line: string) => void): () => Promise<Record<string, number>> {
  const lastFailure = new Map<string, string>();
  return async () => {
    const out: Record<string, number> = {};
    await Promise.all(accounts.map(async (a) => {
      try {
        out[a.venue] = (await a.read()).freeMarginUsd;
        lastFailure.delete(a.venue);
      } catch (err) {
        const message = errorMessage(err);
        if (a.logOnce === true) {
          const kind = message.replace(/\d+/g, '#');
          if (lastFailure.get(a.venue) === kind) return;
          lastFailure.set(a.venue, kind);
        }
        log(`strategy loop: ${a.venue} free margin not read (${message})`);
      }
    }));
    return out;
  };
}

export function serveLoop(input: ServeLoopInput): StrategyLoop {
  const trade = input.env('GIMBAL_TRADE') === '1' && !input.once;
  // A pair whose start is not confirmed (review S1): its legs are unknown, so the loop decides nothing (a held
  // record must not read as "closed outside the loop") and every act, a manual one too, is refused with the reason.
  const unconfirmed = () => input.pair?.unconfirmed?.() ?? null;
  const busy = () => unconfirmed() ?? input.busy();
  const orderGate = () => unconfirmed() ?? (input.orderGate ?? input.busy)();
  const pairHands = input.pair?.hands;
  const hands = input.hands !== undefined ? input.hands : pairHands === undefined ? null : loopHands(pairHands, input.lastDesk, input.log, busy, orderGate);
  const handsWhy = hands !== null ? undefined
    : input.pair === null ? (input.mode === 'mainnet' ? 'no contract desk is set (GIMBAL_CONTRACT_ID, DESK_ID)' : `serve holds a pair on mainnet only, this is ${input.mode}`)
    : input.pair.notTrading() ?? 'the pair is alert only';
  const dir = input.stateDir ?? userStateDir(input.env);
  const store = new LoopStore(loopStateFile(dir, input.mode, input.contractId, input.deskId));
  const pairs = input.pairSymbols ?? (pairHands?.pairSymbols === undefined ? undefined : pairHands.pairSymbols.bind(pairHands));
  const facts = input.carry === undefined ? undefined : windowFacts({
    carry: input.carry, venues: input.venues ?? [], symbols: () => policySymbols(input.policy()), clock: input.clock, log: input.log,
    ...(pairs === undefined ? {} : { pairs }),
  });
  return new StrategyLoop({
    trade, hands, ...(handsWhy === undefined ? {} : { handsWhy }), ...(input.handsLine === undefined ? {} : { handsLine: input.handsLine }),
    strategy: input.strategy, policy: input.policy, windows: input.windows,
    freeMargin: freeMarginReader(input.accounts, input.log),
    liveRescue: () => Object.fromEntries(LOOP_VENUES.map((v) => [v, (typeof input.rescueLive === 'function' ? input.rescueLive() : input.rescueLive) && LIVE_RESCUE[v] === true])),
    ...(facts === undefined ? {} : { facts }),
    busy, store, publish: input.publish, clock: input.clock, log: input.log,
    ...(input.decide === undefined ? {} : { decide: input.decide }),
    ...(input.veto === undefined ? {} : { veto: input.veto }),
    ...(input.book === undefined ? {} : { book: input.book }),
    ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
    ...(input.ledger === undefined ? {} : { ledger: input.ledger }),
    ...(input.grossHours === undefined ? {} : { grossHours: input.grossHours }),
    ...(input.carry === undefined ? {} : { riskFacts: riskFacts({ carry: input.carry, venues: input.venues ?? [], clock: input.clock, log: input.log }) }),
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

/**
 * The leg size an open's parts that went out and opened add up to (canonical base units): a part its gate stopped
 * before its first order, or one that ended other than open (its legs unwound or alerted), adds nothing.
 */
export function openedQty(results: readonly PairResult[]): string {
  return qtyString(results.reduce((acc, r) => (r.status === 'open' && r.legs.some((l) => l.orders.length > 0) ? acc + toQty(r.size) : acc), 0n));
}

/** What the ADL watch of the pair held now says about the loop's orders (serve-pair.ts PairAdl, AdlWatch). */
export interface AdlGate {
  /** An unwind attempt runs: its close signs or is in flight. */
  unwinding: boolean;
  /** A check saw a leg off its baseline and is confirming it: an event may be made under an open. */
  confirming: boolean;
  /** An ADL event is open (made, not yet ended): attempts may still go out on it. */
  event: boolean;
  /** Why the pair is paused since an ADL (no new pair opens until the owner reconciles), or null. */
  paused: string | null;
}

export function adlGate(adl: PairAdl | undefined): AdlGate | null {
  if (adl === undefined) return null;
  return { unwinding: adl.unwinding, confirming: adl.confirming, event: adl.state.event !== null, paused: adl.state.paused };
}

/** What protectionText and openGateText read. */
export interface Protections {
  rescue: string | null;
  adl: AdlGate | null;
  panicClose: boolean;
}

/**
 * Why the strategy loop decides and sends nothing now because a protection runs, or null: a rescue (its fund_venue
 * step included); the ADL watch unwinding, holding an open event, or confirming a leg off its baseline; panic_close.
 * The ADL watch's read-only check, started beside every 5 s desk read, is not one while it sees nothing off.
 */
export function protectionText(p: Protections): string | null {
  if (p.rescue !== null) return `rescue ${p.rescue} runs`;
  if (p.adl?.unwinding === true) return 'an ADL unwind is in flight';
  if (p.adl?.event === true) return 'an ADL event is in progress';
  if (p.adl?.confirming === true) return 'an ADL check is confirming a leg off its baseline';
  if (p.panicClose) return 'panic_close runs';
  return null;
}

/**
 * The gate every open of the loop carries, asked again right before its first order and before each later part:
 * protectionText, and a pair paused since an ADL (paused while the open ran, after its own start checks).
 */
export function openGateText(p: Protections): string | null {
  const protection = protectionText(p);
  if (protection !== null) return protection;
  const paused = p.adl?.paused ?? null;
  return paused === null ? null : `the pair is paused since an ADL (${paused}): no new pair opens until the owner reconciles`;
}

/** Where serve reads what its protections are doing (loopGates): each asked fresh at every gate. */
export interface ProtectionSources {
  /** The rescue running (its fund_venue step included), by id, or null. */
  rescue: () => string | null;
  /** The ADL watch of the pair held now (ServePair.adl). */
  adl: () => PairAdl | undefined;
  /** panic_close runs. */
  panicClose: () => boolean;
  /** A close of the pair runs (ProtectedPair.closing: panic_close, a rescue's reduce, an ADL unwind or the loop's). */
  pairClosing: () => boolean;
}

/**
 * serveLoop's `busy` and `orderGate` as serve wires them, from one place: `busy` (no decision, no act) is
 * protectionText or a close of the pair running; `orderGate` (every open's gate, asked again before its first order
 * and each later part) is openGateText, which also stops on a pair paused since an ADL. The two differ on purpose:
 * a pause stops opens, not the loop's decisions (a held pair may still be closed).
 */
export function loopGates(s: ProtectionSources): { busy: () => string | null; orderGate: () => string | null } {
  const now = (): Protections => ({ rescue: s.rescue(), adl: adlGate(s.adl()), panicClose: s.panicClose() });
  return {
    busy: () => protectionText(now()) ?? (s.pairClosing() ? 'a close of the pair runs' : null),
    orderGate: () => openGateText(now()),
  };
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
 * panic_close) refusing before the hands' own reasons. `gate` goes with every open, asked again before its orders.
 */
export function loopHands(
  hands: PairHands, lastDesk: () => DeskState | null, log: (line: string) => void, busy: () => string | null = () => null, gate: () => string | null = busy,
): LoopHands {
  const outcome = (r: HandsResult): ActOutcome => {
    for (const line of r.lines) log(`strategy loop: ${line}`);
    return {
      ok: r.ok, reason: r.reason, sent: r.sent ?? (r.results.length > 0 || r.tx.length > 0), tx: r.tx, feeUsd: r.feeUsd, open: r.open, fills: fillsOf(r.results),
      ...(r.refreshed === true ? { refreshed: true, ...(r.refreshes === undefined ? {} : { refreshes: r.refreshes }) } : {}),
      ...(r.costRefused === undefined ? {} : { costRefused: r.costRefused }),
    };
  };
  return {
    blocked: () => busy() ?? hands.blocked(),
    held: (): HandsHeld | null => {
      const symbol = hands.heldSymbol();
      if (symbol === null) return null;
      const legs = (lastDesk()?.legs ?? []).filter((l) => sameSymbol(l.symbol, symbol));
      const legUsd = legs.length === 0 ? 0 : Math.max(...legs.map((l) => l.size * l.mark));
      // Price, funding and the fees paid so far (live: the book's open fees, bookLegFees; nothing else in the loop
      // subtracts them, so they count once). The close's own fees are not in it.
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
      // GIMBAL_ORDERLY_PAIRS=1: the legs the trader has, the default pair included (the loop matches its record on them).
      const pair = hands.heldPair?.() ?? null;
      const venues = pair === null ? {} : { long: pair.long, short: pair.short };
      return { symbol, legUsd, pnlUsd, oneLeg, ...(legs.length === 0 ? {} : { freedMarginUsd: freed }), ...venues };
    },
    symbolOf: (w) => windowSymbol(w, hands.symbols, hands.pairSymbols?.bind(hands)),
    open: async (r) => {
      // GIMBAL_ORDERLY_PAIRS=1: the legs the window pays (without it the hands open short Hyperliquid / long Phoenix).
      const legs = hands.pairSymbols === undefined ? {} : { long: r.window.longVenue as VenueId, short: r.window.shortVenue as VenueId };
      const h = await hands.open({
        symbol: r.symbol, ...legs, legUsd: r.legUsd, leverage: r.leverage, reason: r.reason, qty: r.qty, gate, ...(r.noRefresh === undefined ? {} : { noRefresh: r.noRefresh }),
        ...(r.demo === undefined ? {} : { demo: r.demo }),
      });
      // What filled, not what was asked (a later part the gate stopped holds nothing): the journal and the held size.
      return { ...outcome(h), filledQty: openedQty(h.results) };
    },
    prepareOpen: async (r) => outcome(await hands.prepareOpen({ symbol: r.symbol, ...(r.noRefresh === undefined ? {} : { noRefresh: r.noRefresh }) })),
    ...(hands.rotateOutRefused === undefined ? {} : { rotateOutRefused: hands.rotateOutRefused.bind(hands) }),
    reconcile: () => hands.reconcile(),
    close: async (r) => outcome(await hands.close({ reason: r.reason })),
  };
}

/**
 * The live desk's leg fees (risk/sources.ts AccountsDeskSource `fees`): what the position book booked for the open
 * position's leg on that venue and symbol (PositionBook.openLegFees), signed (a cost < 0); null with no book (not
 * loaded yet, or not kept) or no open position booked there. `book` is asked at each read: serve creates the book after
 * the desk source.
 */
export function bookLegFees(book: () => Pick<PositionBook, 'openLegFees'> | null): (venue: VenueId, symbol: string) => number | null {
  return (venue, symbol) => book()?.openLegFees(venue, (s) => sameSymbol(s, symbol)) ?? null;
}

/**
 * A desk leg's symbol and a policy symbol name the same market: the same name case aside, or the same base and
 * multiplier (an Orderly leg's PERP_SOL_USDC and SOL, its PERP_1000PEPE_USDC and kPEPE; kPEPE and PEPE are not).
 */
function sameSymbol(a: string, b: string): boolean {
  const n = (s: string) => {
    const k = s.startsWith('PERP_') ? orderlyBase(s) : kiloBase(s);
    return `${k.multiplier === 1 ? '' : 'k'}${k.base.toUpperCase()}`;
  };
  return a.toUpperCase() === b.toUpperCase() || n(a) === n(b);
}

/** A venue a pair can have a leg on (Hyperliquid, Orderly, Phoenix). */
function isPairVenue(v: string): v is VenueId {
  return (PAIR_VENUES as readonly string[]).includes(v);
}

/**
 * The policy symbol a window trades here, or why serve cannot trade it. Without `pairs`: short Hyperliquid / long
 * Phoenix only, on `symbols` (a Hyperliquid asset Phoenix also lists). With `pairs` (GIMBAL_ORDERLY_PAIRS=1): any two
 * of Hyperliquid, Orderly and Phoenix, in the window's direction, on a symbol both its venues list.
 */
export function windowSymbol(
  w: FundingWindow, symbols: readonly string[], pairs?: (long: VenueId, short: VenueId) => readonly string[],
): { symbol: string } | { refused: string } {
  let list = symbols;
  let legs = '';
  if (pairs === undefined) {
    if (w.longVenue !== 'phoenix' || w.shortVenue !== 'hyperliquid') {
      return { refused: `serve opens short hyperliquid, long phoenix only (as pair-mainnet open); ${w.id} is long ${w.longVenue}, short ${w.shortVenue}` };
    }
  } else {
    if (w.longVenue === w.shortVenue || !isPairVenue(w.longVenue) || !isPairVenue(w.shortVenue)) {
      return { refused: `serve opens a pair on two of ${PAIR_VENUES.join(', ')}; ${w.id} is long ${w.longVenue}, short ${w.shortVenue}` };
    }
    list = pairs(w.longVenue, w.shortVenue);
    if (w.longVenue !== 'phoenix' || w.shortVenue !== 'hyperliquid') legs = ` (long ${w.longVenue}, short ${w.shortVenue})`;
  }
  const base = w.symbol.toUpperCase();
  const symbol = list.find((s) => s.toUpperCase() === base || kiloBase(s).base.toUpperCase() === base);
  return symbol === undefined ? { refused: `${w.symbol} is not a market both legs${legs} list in the desk's policy (${list.join(', ') || 'none'})` } : { symbol };
}

/**
 * decide()'s and the veto's facts: every window's 14-day gross and legs' open interest from the scanner's carry, and
 * each tradable window's round trip in USD (the one its profit checks print) when it was priced on the books; and, for the enterable windows serve could trade (at most
 * MAX_LOT_WINDOWS) and the windows named in `lotsFor` (an owner demo entry's target, whose profit checks fail), each
 * leg's lot (Market.lotSize) and the mid pair-mainnet sizes on (the mean of both venues' best bid and ask). A venue
 * that does not answer leaves its windows without lots: decide() does not enter them.
 */
export function windowFacts(p: {
  carry: (windowId: string) => WindowCarry | null; venues: readonly VenueReader[]; symbols: () => readonly string[]; clock: Clock;
  log: (line: string) => void;
  /** GIMBAL_ORDERLY_PAIRS=1: windowSymbol's pairs (any two venues; lots and mid on the window's own two). */
  pairs?: (long: VenueId, short: VenueId) => readonly string[];
}): (windows: readonly FundingWindow[], lotsFor?: readonly string[]) => Promise<WindowFacts> {
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
  /** The mean of both venues' best bid and ask; `venues` in PAIR_VENUES order (Hyperliquid and Phoenix by default). */
  const midOf = async (symbol: string, venues: readonly [VenueId, VenueId] = ['hyperliquid', 'phoenix']): Promise<number | null> => {
    const now = p.clock.now();
    const plain = venues[0] === 'hyperliquid' && venues[1] === 'phoenix';
    const key = plain ? symbol : `${symbol}|${venues.join('|')}`;
    const cached = mids.get(key);
    if (cached !== undefined && now - cached.at < MID_TTL_MS) return cached.px;
    const ra = reader(venues[0]);
    const rb = reader(venues[1]);
    let mid: number | null = null;
    if (ra !== undefined && rb !== undefined) {
      try {
        const [a, b] = await Promise.all([ra.book(venueSymbol(venues[0], symbol), 5), rb.book(venueSymbol(venues[1], symbol), 5)]);
        const quotes = [a.bids[0]?.px, a.asks[0]?.px, b.bids[0]?.px, b.asks[0]?.px];
        if (quotes.every((q) => q !== undefined && q > 0)) mid = (quotes as number[]).reduce((s, q) => s + q, 0) / 4;
      } catch (err) {
        p.log(`strategy loop: ${symbol}${plain ? '' : ` (${venues.join(', ')})`} books not read (${errorMessage(err)}), no lots this check`);
      }
    }
    mids.set(key, { at: now, px: mid });
    return mid;
  };
  return async (windows, lotsFor = []) => {
    const gross14dAprPct: Record<string, number | null> = {};
    const openInterest: Record<string, { longUsd: number | null; shortUsd: number | null }> = {};
    const roundTripUsd: Record<string, number> = {};
    for (const w of windows) {
      const c = p.carry(w.id);
      if (c === null) continue;
      gross14dAprPct[w.id] = c.estimate.gross.d14AprPct;
      openInterest[w.id] = { longUsd: c.long.oiUsd, shortUsd: c.short.oiUsd };
      // Only a tradable window's round trip priced on the books (not one put together with unknown costs as 0): any
      // other is left out, and a demo entry into it is refused, its cost not known.
      const rt = (c.estimate.roundTrip as WindowCarry['estimate']['roundTrip'] | undefined)?.totalUsd;
      if (w.tradable && c.roundTripPriced === true && rt !== undefined && Number.isFinite(rt)) roundTripUsd[w.id] = rt;
    }
    const lots: NonNullable<WindowFacts['lots']> = {};
    const symbols = p.symbols();
    const tradable = (list: readonly FundingWindow[]) => list
      .map((w) => ({ w, s: windowSymbol(w, symbols, p.pairs) }))
      .filter((x): x is { w: FundingWindow; s: { symbol: string } } => 'symbol' in x.s);
    const top = tradable(windows.filter((w) => isEnterable(w))).sort((a, b) => b.w.netAprPct - a.w.netAprPct).slice(0, MAX_LOT_WINDOWS);
    // Asked for by name (a demo entry's target): read past the cap, it is one window; a watch-only one is not read.
    const named = tradable(windows.filter((w) => w.tradable && lotsFor.includes(w.id) && !top.some((x) => x.w.id === w.id)));
    const candidates = [...top, ...named];
    if (candidates.length > 0) {
      // Each window's own two venues (Hyperliquid and Phoenix only, without Orderly pairs), read once each.
      const need = PAIR_VENUES.filter((v) => candidates.some(({ w }) => w.longVenue === v || w.shortVenue === v));
      const read = await Promise.all(need.map((v) => marketsOf(v)));
      const byVenue = new Map(need.map((v, i) => [v, read[i]] as const));
      for (const { w, s } of candidates) {
        const sv = w.shortVenue as VenueId;
        const lv = w.longVenue as VenueId;
        const short = byVenue.get(sv)?.get(venueSymbol(sv, s.symbol));
        const long = byVenue.get(lv)?.get(venueSymbol(lv, s.symbol));
        if (short === undefined || long === undefined) continue;
        const venues = PAIR_VENUES.filter((v) => v === w.longVenue || v === w.shortVenue) as unknown as [VenueId, VenueId];
        const px = await midOf(s.symbol, venues);
        if (px === null) continue;
        lots[w.id] = { longLot: long.lotSize, shortLot: short.lotSize, px };
      }
    }
    return { gross14dAprPct, openInterest, roundTripUsd, lots };
  };
}

/** Book levels read per leg for the risk check's depth at the leg's size. */
const RISK_BOOK_LEVELS = 20;
/** A risk check fact read waits at most this long: the check itself has 5 s. */
const RISK_FACT_TIMEOUT_MS = 3_000;
const DAY_MS = 86_400_000;

/** USD on the side a leg fills, and how far its whole size fills from the mid (null: the levels do not hold it). */
export function depthAtSize(book: Book, side: 'long' | 'short', legUsd: number): { bookDepthUsd: number | null; fillImpactBps: number | null } {
  const levels = side === 'long' ? book.asks : book.bids;
  const bid = book.bids[0]?.px;
  const ask = book.asks[0]?.px;
  if (levels.length === 0 || bid === undefined || ask === undefined || !(bid > 0) || !(ask > 0)) return { bookDepthUsd: null, fillImpactBps: null };
  const mid = (bid + ask) / 2;
  let depth = 0;
  let filledUsd = 0;
  let filledQty = 0;
  for (const l of levels) {
    if (!(l.px > 0) || !(l.sz > 0)) continue;
    const usd = l.px * l.sz;
    depth += usd;
    if (filledUsd < legUsd) {
      const take = Math.min(usd, legUsd - filledUsd);
      filledUsd += take;
      filledQty += take / l.px;
    }
  }
  const filled = filledUsd >= legUsd - 1e-9 && filledQty > 0;
  return { bookDepthUsd: depth, fillImpactBps: filled ? Math.abs((filledUsd / filledQty) / mid - 1) * 1e4 : null };
}

/**
 * The risk check's facts a window does not carry, read when the check is asked: each leg's book at the leg's size
 * (RISK_BOOK_LEVELS levels on the side it fills), its market's 24 h move (the scanner's carry: the venue's mark
 * against its own price 24 h ago) and its listing age where the venue says (Orderly's created_time). Whatever a venue
 * does not give, or does not answer in time, stays unknown (null).
 */
export function riskFacts(p: {
  carry: (windowId: string) => WindowCarry | null; venues: readonly VenueReader[]; clock: Clock; log: (line: string) => void;
}): (w: FundingWindow, legUsd: number) => Promise<{ long?: VetoLegFacts; short?: VetoLegFacts }> {
  const markets = new Map<string, { at: number; bySymbol: Map<string, Market> }>();
  const marketOf = async (venue: string, symbol: string): Promise<Market | null> => {
    const now = p.clock.now();
    const cached = markets.get(venue);
    if (cached !== undefined && now - cached.at < MARKETS_TTL_MS) return cached.bySymbol.get(symbol) ?? null;
    const r = p.venues.find((v) => v.id === venue);
    if (r === undefined) return null;
    const bySymbol = new Map((await withTimeout(r.markets(), RISK_FACT_TIMEOUT_MS, `${venue} markets`)).map((m) => [m.symbol, m]));
    markets.set(venue, { at: now, bySymbol });
    return bySymbol.get(symbol) ?? null;
  };
  const leg = async (rates: WindowCarry['long'], side: 'long' | 'short', legUsd: number): Promise<VetoLegFacts> => {
    const out: VetoLegFacts = { priceMove24hPct: rates.priceMove24hPct ?? null };
    const r = p.venues.find((v) => v.id === rates.venue);
    const [book, market] = await Promise.allSettled([
      r === undefined ? Promise.reject(new Error('no reader')) : withTimeout(r.book(rates.symbol, RISK_BOOK_LEVELS), RISK_FACT_TIMEOUT_MS, `${rates.venue} ${rates.symbol} book`),
      marketOf(rates.venue, rates.symbol),
    ]);
    if (book.status === 'fulfilled') Object.assign(out, depthAtSize(book.value, side, legUsd));
    else p.log(`strategy loop: risk check: ${rates.venue} ${rates.symbol} book not read (${errorMessage(book.reason)}), its depth is unknown`);
    const listedAt = market.status === 'fulfilled' ? market.value?.listedAt ?? null : null;
    if (listedAt !== null && Number.isFinite(listedAt)) out.daysSinceListing = Math.max(0, (p.clock.now() - listedAt) / DAY_MS);
    return out;
  };
  return async (w, legUsd) => {
    const c = p.carry(w.id);
    if (c === null) return {};
    const [long, short] = await Promise.all([leg(c.long, 'long', legUsd), leg(c.short, 'short', legUsd)]);
    return { long, short };
  };
}

/** The book calls loopBook uses (book/book.ts PositionBook). */
export interface LoopBookPort {
  record(record: BookRecord): { positionId: string | null; numbers: Record<string, number | string>; note?: string | null };
  adopt(input: AdoptInput): string;
  openWindow(): string | null;
  recordOutside(close: OutsideClose): { positionId: string | null };
  queueCloseLookup(lookup: CloseLookup): void;
}

/**
 * The position book on the strategy loop. `sink` is the loop's `book` option. The loop records a carried-out enter or
 * exit and then, synchronously, journals it (`enter`, `rotate`, `exit`, or `error` when the venues hold a pair the open
 * did not finish): `publish` merges the book's numbers (position id, legs, fees, the forecast; at an exit its funding,
 * net and actual APR) into that next journal entry, the book's keys over the loop's (the book's `feeUsd` is signed, a
 * cost < 0), and the book's note (an exit: `funding read to 14:00, settling`) to its summary. `adopt` books the pair the loop holds when the book has no open position for it (opened outside the
 * loop, or before the book existed), from the loop's own `since`; serve calls it at start and on every decision.
 * `protectionClose` books a protection's close (panic_close, a rescue's reduce, an ADL unwind: ProtectedPair's
 * onProtectionClose) from its result: an exit when both legs ended flat, else its fills as a partial fill; booked on
 * the next turn of the event loop, so the protection's path never waits on the book's fsync. One that threw (no
 * result), or whose booking failed: the book's next sync reads its fills over its own time from the venues
 * (queueCloseLookup), and the close-outside detector books the exit when the loop no longer holds the pair.
 */
export function loopBook(book: LoopBookPort, publish: (event: StreamEvent) => void, log: (line: string) => void, held: () => LoopHeld | null = () => null): {
  sink: BookSink; publish: (event: StreamEvent) => void; adopt: (held: LoopHeld | null) => void;
  protectionClose: (report: ProtectionCloseReport) => void;
} {
  let pending: { numbers: Record<string, number | string>; note: string | null } | null = null;
  const adopt = (held: LoopHeld | null) => {
    if (held === null || book.openWindow() === held.windowId) return;
    try {
      const id = book.adopt({
        windowId: held.windowId, symbol: held.symbol, since: held.since, legUsd: held.legUsd, forecastNetAprPct: held.entryNetAprPct,
        legs: [{ venue: held.short ?? 'hyperliquid', side: 'short' }, { venue: held.long ?? 'phoenix', side: 'long' }], by: 'manual',
      });
      // A position the book closed after `since` (a protection's close the loop has not seen yet) is not adopted again.
      if (book.openWindow() === held.windowId) log(`book: holds ${held.symbol} as ${id} (adopted from the strategy loop, from ${new Date(held.since).toISOString()})`);
    } catch (err) {
      log(`book: ${held.windowId} not adopted (${errorMessage(err)})`);
    }
  };
  return {
    sink: (record) => {
      pending = null;
      const r = book.record(record);
      if (r.positionId !== null) pending = { numbers: r.numbers, note: r.note ?? null };
    },
    publish: (event) => {
      if (event.type === 'journal' && pending !== null) {
        const { numbers, note } = pending;
        pending = null;
        const summary = note === null ? event.data.summary : `${event.data.summary}; ${note}`;
        publish({ type: 'journal', data: { ...event.data, summary, numbers: { ...event.data.numbers, ...numbers } } });
        return;
      }
      publish(event);
      if (event.type === 'decision') adopt(held());
    },
    adopt,
    protectionClose: (c) => {
      const by = c.by === 'panic_close' ? 'manual' : 'auto';
      const lookup = { reason: c.by, by, startedAt: c.startedAt, at: c.at, symbol: c.symbol } as const;
      // Nothing in here may throw out of the setImmediate: an uncaught exception there would stop serve.
      setImmediate(() => {
        try {
          const r = c.result;
          if (r === null) {
            log(`book: the ${c.by} close left no result (${c.error ?? 'no error'}); the next sync reads its fills from the venues`);
            book.queueCloseLookup(lookup);
            return;
          }
          try {
            const flat = r.legs.every((l) => l.final !== null && toQty(l.final) === 0n);
            book.recordOutside({
              // The book names the pair by the first leg's market, or by the pair's symbol when that is Orderly's PERP_X_USDC.
              reason: c.by, by, startedAt: c.startedAt, at: c.at, fills: fillsOf([r]), feeUsd: r.feeUsd, tx: r.tx, flat, symbol: r.legs[0].venue === 'orderly' ? c.symbol : r.legs[0].symbol,
            });
          } catch (err) {
            log(`book: the ${c.by} close was not booked (${errorMessage(err)}); the next sync reads its fills from the venues`);
            book.queueCloseLookup(lookup);
          }
        } catch (err) {
          log(`book: the ${c.by} close was not booked and its fills are not looked for (${errorMessage(err)}); check the book by hand (npm run report)`);
        }
      });
    },
  };
}
