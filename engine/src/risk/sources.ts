// Where the risk engine reads the desk from.
//
// AccountsDeskSource (testnet, mainnet): the desk's own accounts through the venue readers, one account per venue,
// every open position a leg. serve passes Hyperliquid (the desk EVM address) and Phoenix (the desk's Solana
// authority), which read publicly; Orderly's account is read only over its authenticated stream, which serve opens only
// with GIMBAL_ORDERLY_PAIRS=1 (cli/serve-orderly.ts: a third account, unknown while that session is down). An account
// read has a
// deadline (ACCOUNT_READ_DEADLINE_MS): past it that venue's read fails for this tick instead of holding the tick up.
// Phoenix legs are marked with marks up to 5 s old (phoenix.ts MARKS_MAX_AGE_MS), refreshed between ticks.
// The account reads carry no fees: a leg's fees (the desk P&L's `feesUsd`) come from the position book (`fees`
// option; serve: PositionBook.openLegFees through serve-loop.ts bookLegFees): the fills' fees it booked for the open
// position's leg on that venue, symbol and side, the entry's and those of later acts on it while open (a cost < 0, a
// maker rebate > 0); the leg names that position (Leg.feesPositionId). With no book, a book gone read only, no open
// position booked for the leg (one opened by hand and not adopted yet, or on the other side) or a fee the book has not
// read yet, that part is 0: nothing is estimated. monitor (cli/monitor.ts) has no book: its legs show fees 0. Neither
// venue's entry price carries fees (Hyperliquid's entryPx is the fills' average; Phoenix's virtual quote position is
// the fills' quote, the fee comes out of collateral apart), so the price P&L does not count them again.
//
// ReplayDesk (replay): there are no recorded accounts, so the desk is simulated: REPLAY_DEPOSIT_USD deposited,
// REPLAY_VENUE_CASH_USD of it on each of Hyperliquid and Phoenix and the rest in the reserve, flat at the start. The
// strategy loop opens and closes a pair on it through the replay hands (cli/serve-replay-loop.ts): fills at the
// recorded best bid and ask, the scanner's taker fees, marked and funded by the recording as the replay clock runs,
// funding booked at every hour boundary it holds a pair through (onFunding). Nothing is signed or sent; every price
// and funding rate is the recording's.

import type { DeskState, StrategyConfig, VenueId } from '@gimbal/shared';
import { readBy } from '../venues/http-budget.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Clock, Position, VenueReader } from '../venues/venue.ts';
import type { DeskSnapshot, DeskSource, LegInput } from './engine.ts';

export interface AccountsDeskSourceOptions {
  deskId: string;
  owner: string;
  contract: string;
  accounts: { reader: Pick<VenueReader, 'id' | 'account'>; address: string }[];
  /**
   * The desk's own state (serve: get_desk): the USDC held back for rescues (ledger.idle_usdc) and whether it is
   * paused. Read again with every snapshot, but off its path: one read at a time, and a snapshot waits for it at most
   * DESK_VIEW_WAIT_MS (a slow NEAR RPC retries for minutes) and goes on with the last answer. A read that throws keeps
   * the last answer and is logged. The snapshot says how old the answer is (deskView), and the risk engine marks NEAR
   * slow or down and the desk unknown from it.
   */
  desk?: () => Promise<{ reserveUsd: number; paused: DeskState['paused'] }>;
  log?: (line: string) => void;
  /** Lot size per venue and symbol; default 10^-8 (unknown). */
  lotSize?: (venue: VenueId, symbol: string) => number;
  now?: () => number;
  /** Default DESK_VIEW_WAIT_MS. */
  deskWaitMs?: number;
  /** Default ACCOUNT_READ_DEADLINE_MS. */
  readDeadlineMs?: number;
  /**
   * A leg's trading fees, signed (a cost < 0, a rebate > 0), and the book position they are of: serve passes what the
   * position book booked for the open position's leg on that venue, symbol and side (the venue position's sign)
   * (PositionBook.openLegFees). Null, absent, not a number or a throw: 0 (nothing invented), no position named.
   */
  fees?: (venue: VenueId, symbol: string, side: 'long' | 'short') => { usd: number; positionId: string } | null;
}

/** A snapshot waits this long for the desk view (get_desk) before it goes on with the last answer. */
export const DESK_VIEW_WAIT_MS = 5_000;

/**
 * An account read gives up after this: the tick goes on with that venue's read failed (the venue is down in
 * HealthMap) rather than wait out a venue's request budget (Phoenix: up to 15 s through a cool-down). Over
 * SLOW_READ_MS (5 s), so a slow answer still counts as slow, and long enough for a 429 retry or two after Phoenix's
 * Retry-After: 2: the risk read is one request (its marks come from a cache of at most 5 s, phoenix.ts) and has a
 * rate of its own that no 429 cuts (http-budget.ts PHOENIX_BUDGET criticalFloor).
 */
export const ACCOUNT_READ_DEADLINE_MS = 7_000;

export class AccountsDeskSource implements DeskSource {
  readonly #o: AccountsDeskSourceOptions;
  #desk: { reserveUsd: number; paused: DeskState['paused'] } = { reserveUsd: 0, paused: null };
  #deskAt: number | null = null;
  #deskError: string | null = null;
  #deskRead: { promise: Promise<void>; since: number } | null = null;
  #feesError: string | null = null;

  constructor(options: AccountsDeskSourceOptions) {
    this.#o = options;
  }

  async read(): Promise<DeskSnapshot> {
    const now = this.#o.now ?? Date.now;
    const deskRead = this.#readDesk(now);
    const deadlineMs = this.#o.readDeadlineMs ?? ACCOUNT_READ_DEADLINE_MS;
    const reads = await Promise.all(this.#o.accounts.map(async ({ reader, address }) => {
      const started = now();
      try {
        const account = await withDeadline(deadlineMs, `${reader.id} account read`, () => reader.account(address));
        return { venue: reader.id, ms: now() - started, error: null, account };
      } catch (err) {
        return { venue: reader.id, ms: now() - started, error: errorMessage(err), account: null };
      }
    }));
    const legs: LegInput[] = [];
    let feesThrew = false;
    for (const r of reads) {
      if (r.account === null) continue;
      for (const position of r.account.positions) {
        if (position.size === 0) continue;
        const { threw, ...fees } = this.#fees(r.venue, position);
        feesThrew ||= threw;
        legs.push({
          venue: r.venue, symbol: position.symbol, lotSize: this.#o.lotSize?.(r.venue, position.symbol) ?? 1e-8,
          account: r.account, position, markPx: null, ...fees, unpriced: false,
        });
      }
    }
    if (!feesThrew) this.#feesError = null;
    await deskRead;
    const late = this.#deskRead === null ? null : `get_desk has not answered for ${Math.round((now() - this.#deskRead.since) / 1000)} s`;
    return {
      deskId: this.#o.deskId, owner: this.#o.owner, contract: this.#o.contract,
      reserveUsd: this.#desk.reserveUsd,
      paused: this.#desk.paused,
      legs,
      // Every account, flat ones too: the desk value counts each one's equity (risk/engine.ts).
      accounts: reads.map((r) => ({ venue: r.venue, equityUsd: r.account?.equityUsd ?? null })),
      reads: reads.map(({ venue, ms, error }) => ({ venue, ms, error })),
      ...(this.#o.desk === undefined ? {} : { deskView: { at: this.#deskAt, error: late ?? this.#deskError } }),
    };
  }

  /**
   * The `fees` option's answer for a leg (with the position it names), else 0. A throw is logged once per message
   * until a read whose fees all came through clears it (read()), so the same error after a recovery is logged again.
   */
  #fees(venue: VenueId, position: Position): { feesUsd: number; feesPositionId?: string; threw: boolean } {
    if (this.#o.fees === undefined || position.size === 0) return { feesUsd: 0, threw: false };
    try {
      const got = this.#o.fees(venue, position.symbol, position.size > 0 ? 'long' : 'short');
      if (got === null || !Number.isFinite(got.usd)) return { feesUsd: 0, threw: false };
      return { feesUsd: got.usd, feesPositionId: got.positionId, threw: false };
    } catch (err) {
      const message = errorMessage(err);
      if (this.#feesError !== message) this.#o.log?.(`risk: the ${venue} ${position.symbol} leg's fees could not be read from the book, shown as 0: ${message}`);
      this.#feesError = message;
      return { feesUsd: 0, threw: true };
    }
  }

  /** Starts a desk view read unless one is out, and waits for it at most deskWaitMs (see the option). */
  async #readDesk(now: () => number): Promise<void> {
    const read = this.#o.desk;
    if (read === undefined) return;
    if (this.#deskRead === null) {
      const since = now();
      const promise = read().then(
        (d) => { this.#desk = d; this.#deskAt = now(); this.#deskError = null; },
        (err: unknown) => {
          this.#deskError = errorMessage(err);
          this.#o.log?.(`risk: the desk view could not be read, keeping the last one: ${this.#deskError}`);
        },
      ).finally(() => { this.#deskRead = null; });
      this.#deskRead = { promise, since };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((r) => { timer = setTimeout(r, this.#o.deskWaitMs ?? DESK_VIEW_WAIT_MS); });
    try {
      await Promise.race([this.#deskRead.promise, wait]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `fn` with a deadline `ms` from now: budgeted reads in it (http-budget.ts readBy) stop waiting and time out then, and
 * whatever still runs is no longer waited for: the result rejects.
 */
export async function withDeadline<T>(ms: number, what: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave up after ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([readBy(Date.now() + ms, fn), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The replay desk's maintenance fraction where the recording has no market list: Hyperliquid's ETH (1/(2×25)). */
export const REPLAY_MAINTENANCE_FRACTION = 0.02;
/**
 * What the replay desk's owner deposited, USD: the scale of the final mainnet policy (legs of 12 USD, a 20 USD cap an
 * order, the 20 USD recorded NEAR Intents transfer a rescue plays).
 */
export const REPLAY_DEPOSIT_USD = 40;
/**
 * Of the deposit, the USDC on each of Hyperliquid and Phoenix from the start: a 12 USD leg at the 1.5x a venue with no
 * live rescue allows (decide.ts sizeFor) needs 8. The rest is the reserve on NEAR.
 */
export const REPLAY_VENUE_CASH_USD = 10;
/** The venues the replay desk keeps an account on: the default pair's (short Hyperliquid, long Phoenix). */
export const REPLAY_ACCOUNT_VENUES: readonly VenueId[] = ['hyperliquid', 'phoenix'];

const HOUR_MS = 3_600_000;

interface ScriptLeg {
  venue: VenueId;
  symbol: string;
  size: number;          // signed, units of `symbol`
  entryPx: number;
  m: number;
  lotSize: number;
  leverage: number;
  /** Accrued since the open at the recorded rates: received > 0. */
  fundingUsd: number;
  /** The part of fundingUsd an hourly booking already journaled. */
  bookedUsd: number;
  /** The open's fee, a cost > 0 (taken from the venue's cash). */
  feeUsd: number;
  mark: number;
  rate: number;
  at: number;
}

/** One leg's fill in an open or a close of the replay desk: at the recorded best bid or ask, else its recorded mark. */
export interface ReplayFill {
  venue: VenueId;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  px: number;
  /** A cost > 0. */
  feeUsd: number;
  source: 'book' | 'mark';
}

export type ReplayOpen = { ok: true; fills: ReplayFill[]; feeUsd: number } | { ok: false; reason: string };

/** A close of the replay desk's pair, with the position's realized P&L (fees as costs > 0). */
export type ReplayClose = {
  ok: true;
  fills: ReplayFill[];
  /** The close's own fees. */
  feeUsd: number;
  /** The open's fees. */
  entryFeeUsd: number;
  /** Funding over the whole hold, and the part no hourly booking journaled yet. */
  fundingUsd: number;
  unbookedFundingUsd: number;
  /** Both legs' price P&L, entry fill to exit fill. */
  priceUsd: number;
  /** fundingUsd + priceUsd − entryFeeUsd − feeUsd. */
  netUsd: number;
  heldMs: number;
} | { ok: false; reason: string };

/** Funding the replay desk booked at an hour boundary: what accrued since the last booking (or the open). */
export interface ReplayFunding {
  from: number;
  to: number;
  usd: number;
  legs: { venue: VenueId; symbol: string; side: 'long' | 'short'; usd: number; ratePerHour: number }[];
}

/** The pair the replay desk holds. */
export interface ReplayHeld {
  symbol: string;
  openedAt: number;
  legs: { venue: VenueId; side: 'long' | 'short'; size: number; entryPx: number; mark: number; fundingUsd: number; feeUsd: number; leverage: number }[];
}

export interface ReplayDeskOptions {
  venues: readonly VenueReader[];
  clock: Clock;
  strategy: () => StrategyConfig;
  /** A venue's taker fee, bps (serve: the scanner's fill costs); default none. */
  takerBps?: (venue: VenueId) => number;
  /** At each hour boundary the desk holds a pair through: the funding accrued since the last booking. */
  onFunding?: (funding: ReplayFunding) => void;
}

export class ReplayDesk implements DeskSource {
  readonly #o: ReplayDeskOptions;
  #legs: ScriptLeg[] = [];
  readonly #cash = new Map<VenueId, number>();
  #reserve = REPLAY_DEPOSIT_USD;
  /** The end of the last funding booking, or the open; null while flat. */
  #bookedAt: number | null = null;
  #openedAt: number | null = null;
  /** One read, open or close at a time: each moves the legs' accrual clock. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ReplayDeskOptions) {
    this.#o = options;
    for (const v of this.#accountVenues()) {
      this.#cash.set(v, REPLAY_VENUE_CASH_USD);
      this.#reserve -= REPLAY_VENUE_CASH_USD;
    }
  }

  read(): Promise<DeskSnapshot> {
    return this.#serial(() => this.#read());
  }

  /** A venue account as the strategy loop reads its free margin (the last marks; no venue read). */
  async account(venue: VenueId): Promise<AccountState> {
    if (!this.#cash.has(venue)) throw new Error(`replay desk: no account on ${venue}`);
    const now = this.#o.clock.now();
    const leg = this.#legs.find((l) => l.venue === venue);
    return leg === undefined ? this.#flatAccount(venue, now) : this.#input(leg, now).account;
  }

  /** The pair held now, or null when flat. */
  held(): ReplayHeld | null {
    if (this.#legs.length === 0 || this.#openedAt === null) return null;
    return {
      symbol: this.#legs[0]!.symbol, openedAt: this.#openedAt,
      legs: this.#legs.map((l) => ({
        venue: l.venue, side: l.size >= 0 ? 'long' : 'short', size: Math.abs(l.size), entryPx: l.entryPx, mark: l.mark, fundingUsd: l.fundingUsd,
        feeUsd: l.feeUsd, leverage: l.leverage,
      })),
    };
  }

  /** Opens `qty` of `symbol` long on `long` and short on `short`, from flat. Nothing is signed or sent. */
  openPair(p: { symbol: string; qty: number; long: VenueId; short: VenueId; leverage: number }): Promise<ReplayOpen> {
    return this.#serial(async (): Promise<ReplayOpen> => {
      if (this.#legs.length > 0) return { ok: false, reason: `the replay desk holds ${this.#legs[0]!.symbol} already` };
      if (!(p.qty > 0) || !Number.isFinite(p.qty)) return { ok: false, reason: `size ${p.qty} is not above 0` };
      if (!(p.leverage > 0)) return { ok: false, reason: `leverage ${p.leverage} is not above 0` };
      const now = this.#o.clock.now();
      const fills: ReplayFill[] = [];
      const legs: ScriptLeg[] = [];
      for (const [venue, side] of [[p.long, 'BUY'], [p.short, 'SELL']] as const) {
        const cash = this.#cash.get(venue);
        if (cash === undefined) return { ok: false, reason: `the replay desk has no account on ${venue}` };
        const fill = await this.#fill(venue, p.symbol, side, p.qty);
        if ('reason' in fill) return { ok: false, reason: fill.reason };
        const need = p.qty * fill.px / p.leverage + fill.feeUsd;
        if (need > cash + 1e-9) return { ok: false, reason: `${venue}: ${cash.toFixed(2)} USD on the account, under the ${need.toFixed(2)} USD the leg's margin and fee need` };
        const market = await this.#market(venue, p.symbol);
        fills.push(fill);
        legs.push({
          venue, symbol: p.symbol, size: side === 'BUY' ? p.qty : -p.qty, entryPx: fill.px, m: market.m, lotSize: market.lot, leverage: p.leverage,
          fundingUsd: 0, bookedUsd: 0, feeUsd: fill.feeUsd, mark: fill.mark, rate: fill.rate, at: now,
        });
      }
      for (const l of legs) this.#cash.set(l.venue, this.#cash.get(l.venue)! - l.feeUsd);
      this.#legs = legs;
      this.#openedAt = now;
      this.#bookedAt = now;
      return { ok: true, fills, feeUsd: fills.reduce((s, f) => s + f.feeUsd, 0) };
    });
  }

  /** Closes both legs to flat; their P&L and funding go to each venue's cash. Nothing is signed or sent. */
  closePair(): Promise<ReplayClose> {
    return this.#serial(async (): Promise<ReplayClose> => {
      if (this.#legs.length === 0 || this.#openedAt === null) return { ok: false, reason: 'the replay desk holds no pair' };
      const now = this.#o.clock.now();
      await this.#mark(now);
      const fills: ReplayFill[] = [];
      for (const l of this.#legs) {
        const fill = await this.#fill(l.venue, l.symbol, l.size >= 0 ? 'SELL' : 'BUY', Math.abs(l.size), l.mark);
        if ('reason' in fill) return { ok: false, reason: fill.reason };
        fills.push(fill);
      }
      let priceUsd = 0;
      let fundingUsd = 0;
      let unbooked = 0;
      let entryFeeUsd = 0;
      this.#legs.forEach((l, i) => {
        const f = fills[i]!;
        const price = l.size * (f.px - l.entryPx);
        priceUsd += price;
        fundingUsd += l.fundingUsd;
        unbooked += l.fundingUsd - l.bookedUsd;
        entryFeeUsd += l.feeUsd;
        this.#cash.set(l.venue, this.#cash.get(l.venue)! + price + l.fundingUsd - f.feeUsd);
      });
      const feeUsd = fills.reduce((s, f) => s + f.feeUsd, 0);
      const heldMs = now - this.#openedAt;
      this.#legs = [];
      this.#openedAt = null;
      this.#bookedAt = null;
      return {
        ok: true, fills, feeUsd, entryFeeUsd, fundingUsd, unbookedFundingUsd: unbooked, priceUsd,
        netUsd: fundingUsd + priceUsd - entryFeeUsd - feeUsd, heldMs,
      };
    });
  }

  /** A replayed rescue landed `usd` on `venue`: that account holds that much more. */
  credit(venue: VenueId, usd: number): void {
    if (this.#cash.has(venue)) this.#cash.set(venue, this.#cash.get(venue)! + usd);
  }

  /** A replayed rescue took `usd` from the reserve. */
  spendReserve(usd: number): void {
    this.#reserve -= usd;
  }

  /** The reserve now, USD (the risk engine's trigger names it as the source when it covers the need). */
  get reserveUsd(): number {
    return Math.max(0, this.#reserve);
  }

  #accountVenues(): VenueId[] {
    return REPLAY_ACCOUNT_VENUES.filter((v) => this.#o.venues.some((r) => r.id === v));
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #read(): Promise<DeskSnapshot> {
    const now = this.#o.clock.now();
    const reads = await this.#mark(now);
    const failed = new Set(reads.filter((r) => r.error !== null).map((r) => r.venue));
    const legs = this.#legs.filter((l) => !failed.has(l.venue)).map((l) => this.#input(l, now));
    const accounts = this.#accountVenues().map((venue) => {
      if (failed.has(venue)) return { venue, equityUsd: null };
      const leg = legs.find((i) => i.venue === venue);
      return { venue, equityUsd: leg === undefined ? this.#cash.get(venue)! : leg.account.equityUsd };
    });
    return {
      deskId: 'replay', owner: 'replay', contract: 'replay', reserveUsd: Math.max(0, this.#reserve), paused: null, legs, accounts, reads,
    };
  }

  /**
   * Every account venue's recorded funding read: the legs' funding accrued at the rate in force since the last mark
   * (booked at each hour boundary on the way), then their marks and rates moved to the recording's now.
   */
  async #mark(now: number): Promise<DeskSnapshot['reads']> {
    const reads: DeskSnapshot['reads'] = [];
    const rows = new Map<VenueId, Awaited<ReturnType<VenueReader['funding']>>>();
    for (const venue of this.#accountVenues()) {
      const reader = this.#o.venues.find((v) => v.id === venue)!;
      const started = Date.now();
      try {
        const got = await reader.funding();
        for (const l of this.#legs.filter((x) => x.venue === venue)) {
          const row = got.find((r) => r.symbol === l.symbol);
          if (row === undefined || row.markPx === null || !(row.markPx > 0)) throw new Error(`replay: no recorded mark for ${l.symbol}`);
        }
        rows.set(venue, got);
        reads.push({ venue, ms: Date.now() - started, error: null });
      } catch (err) {
        reads.push({ venue, ms: Date.now() - started, error: errorMessage(err) });
      }
    }
    if (this.#legs.length > 0 && this.#bookedAt !== null) {
      for (let b = Math.floor(this.#bookedAt / HOUR_MS) * HOUR_MS + HOUR_MS; b <= now; b += HOUR_MS) {
        this.#accrue(b);
        this.#book(b);
      }
      this.#accrue(now);
    }
    for (const l of this.#legs) {
      const row = rows.get(l.venue)?.find((r) => r.symbol === l.symbol);
      if (row === undefined || row.markPx === null || !(row.markPx > 0)) continue;
      l.mark = row.markPx;
      l.rate = row.ratePerHour;
    }
    return reads;
  }

  /** Funding to `t` at each leg's last rate: a long pays a positive rate. */
  #accrue(t: number): void {
    for (const l of this.#legs) {
      const hours = Math.max(0, t - l.at) / HOUR_MS;
      l.fundingUsd += -l.size * l.mark * l.rate * hours;
      l.at = Math.max(l.at, t);
    }
  }

  #book(to: number): void {
    const from = this.#bookedAt ?? to;
    const legs = this.#legs.map((l) => {
      const usd = l.fundingUsd - l.bookedUsd;
      l.bookedUsd = l.fundingUsd;
      return { venue: l.venue, symbol: l.symbol, side: l.size >= 0 ? 'long' as const : 'short' as const, usd, ratePerHour: l.rate };
    });
    this.#bookedAt = to;
    this.#o.onFunding?.({ from, to, usd: legs.reduce((s, l) => s + l.usd, 0), legs });
  }

  /** A fill of `qty` at the recorded best ask (BUY) or bid (SELL), else at the recorded mark; with its taker fee. */
  async #fill(venue: VenueId, symbol: string, side: 'BUY' | 'SELL', qty: number, lastMark?: number):
    Promise<ReplayFill & { mark: number; rate: number } | { reason: string }> {
    const reader = this.#o.venues.find((v) => v.id === venue);
    if (reader === undefined) return { reason: `the replay has no ${venue} recording` };
    let row: { markPx: number | null; ratePerHour: number } | undefined;
    try {
      row = (await reader.funding()).find((r) => r.symbol === symbol);
    } catch {
      // the mark below falls back to the last one
    }
    const mark = row?.markPx != null && row.markPx > 0 ? row.markPx : lastMark;
    let px: number | undefined;
    let source: ReplayFill['source'] = 'book';
    try {
      const book = await reader.book(symbol, 5);
      px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    } catch {
      // not recorded: the mark
    }
    if (px === undefined || !(px > 0)) {
      px = mark;
      source = 'mark';
    }
    if (px === undefined || !(px > 0) || mark === undefined) return { reason: `the recording has no price for ${symbol} on ${venue}` };
    const feeUsd = qty * px * (this.#o.takerBps?.(venue) ?? 0) / 1e4;
    return { venue, symbol, side, qty, px, feeUsd, source, mark, rate: row?.ratePerHour ?? 0 };
  }

  #flatAccount(venue: VenueId, now: number): AccountState {
    const cash = this.#cash.get(venue) ?? 0;
    return { venue, address: 'replay', time: now, equityUsd: cash, freeMarginUsd: Math.max(0, cash), maintenanceMarginUsd: 0, positions: [] };
  }

  #input(l: ScriptLeg, now: number): LegInput {
    const upnl = l.size * (l.mark - l.entryPx);
    const equity = (this.#cash.get(l.venue) ?? 0) + upnl + l.fundingUsd;
    const notional = Math.abs(l.size) * l.mark;
    const position: Position = {
      symbol: l.symbol, size: l.size, entryPx: l.entryPx, liqPx: null, marginUsd: notional / l.leverage, unrealizedPnlUsd: upnl,
      leverage: equity > 0 ? notional / equity : Infinity, fundingSinceOpenUsd: l.fundingUsd, unsettledFundingUsd: 0,
    };
    const account: AccountState = {
      venue: l.venue, address: 'replay', time: now, equityUsd: equity,
      freeMarginUsd: Math.max(0, equity - notional / l.leverage),
      maintenanceMarginUsd: l.m * notional, positions: [position],
    };
    return { venue: l.venue, symbol: l.symbol, lotSize: l.lotSize, account, position, markPx: l.mark, feesUsd: -l.feeUsd, unpriced: false };
  }

  /** Maintenance fraction (1/(2 × max leverage), Hyperliquid's rule) and lot from the recorded market list, if any. */
  async #market(venue: VenueId, symbol: string): Promise<{ m: number; lot: number }> {
    try {
      const reader = this.#o.venues.find((v) => v.id === venue)!;
      const market = (await reader.markets()).find((x) => x.symbol === symbol);
      if (market !== undefined && market.maxLeverage > 0) return { m: 1 / (2 * market.maxLeverage), lot: market.lotSize };
    } catch {
      // not recorded
    }
    return { m: REPLAY_MAINTENANCE_FRACTION, lot: 1e-4 };
  }
}
