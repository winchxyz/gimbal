// Where the risk engine reads the desk from.
//
// AccountsDeskSource (testnet, mainnet): the desk's own accounts through the venue readers, one account per venue,
// every open position a leg. serve passes Hyperliquid (the desk EVM address) and Phoenix (the desk's Solana
// authority), which read publicly; Orderly's account is read only over its authenticated stream, which serve does not
// open (it signs nothing), so Orderly legs come in once the strategy engine holds that session. An account read has a
// deadline (ACCOUNT_READ_DEADLINE_MS): past it that venue's read fails for this tick instead of holding the tick up.
//
// ReplayDesk (replay): there are no recorded accounts, so the desk is scripted: one pair at strategy.legUsd a leg and
// strategy.maxLeverage, opened at the first recorded marks, then marked and funded by the recording as the replay
// clock runs. The positions are a script; every price and funding rate is the recording's. Its first read journals
// what it opened, saying so.

import type { DeskState, StrategyConfig, VenueId } from '@gimbal/shared';
import { readBy } from '../venues/http-budget.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Clock, MarketFunding, Position, VenueReader } from '../venues/venue.ts';
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
}

/** A snapshot waits this long for the desk view (get_desk) before it goes on with the last answer. */
export const DESK_VIEW_WAIT_MS = 5_000;

/**
 * An account read gives up after this: the tick goes on with that venue's read failed (the venue is down in
 * HealthMap) rather than wait out a venue's request budget (Phoenix: up to 15 s through a cool-down). Over
 * SLOW_READ_MS (5 s), so a slow answer still counts as slow, and long enough for one 429 retry after Phoenix's
 * Retry-After: 2 and a token at the cut rate (http-budget.ts PHOENIX_BUDGET).
 */
export const ACCOUNT_READ_DEADLINE_MS = 7_000;

export class AccountsDeskSource implements DeskSource {
  readonly #o: AccountsDeskSourceOptions;
  #desk: { reserveUsd: number; paused: DeskState['paused'] } = { reserveUsd: 0, paused: null };
  #deskAt: number | null = null;
  #deskError: string | null = null;
  #deskRead: { promise: Promise<void>; since: number } | null = null;

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
    for (const r of reads) {
      if (r.account === null) continue;
      for (const position of r.account.positions) {
        if (position.size === 0) continue;
        legs.push({
          venue: r.venue, symbol: position.symbol, lotSize: this.#o.lotSize?.(r.venue, position.symbol) ?? 1e-8,
          account: r.account, position, markPx: null, feesUsd: 0, unpriced: false,
        });
      }
    }
    await deskRead;
    const late = this.#deskRead === null ? null : `get_desk has not answered for ${Math.round((now() - this.#deskRead.since) / 1000)} s`;
    return {
      deskId: this.#o.deskId, owner: this.#o.owner, contract: this.#o.contract,
      reserveUsd: this.#desk.reserveUsd,
      paused: this.#desk.paused,
      legs,
      reads: reads.map(({ venue, ms, error }) => ({ venue, ms, error })),
      ...(this.#o.desk === undefined ? {} : { deskView: { at: this.#deskAt, error: late ?? this.#deskError } }),
    };
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
async function withDeadline<T>(ms: number, what: string, fn: () => Promise<T>): Promise<T> {
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

/** The replay script's maintenance fraction where the recording has no market list: Hyperliquid's ETH (1/(2×25)). */
export const REPLAY_MAINTENANCE_FRACTION = 0.02;
/** The replay desk's reserve: this share of the margin it posts on both legs. */
export const REPLAY_RESERVE_SHARE = 0.2;

interface ScriptLeg {
  venue: VenueId;
  symbol: string;
  size: number;          // signed, units of `symbol`
  entryPx: number;
  marginUsd: number;
  m: number;
  lotSize: number;
  fundingUsd: number;
  mark: number;
  rate: number;
  at: number;
}

export interface ReplayDeskOptions {
  venues: readonly VenueReader[];
  clock: Clock;
  strategy: () => StrategyConfig;
  /** The pair to script; default: ETH on Hyperliquid and Phoenix when both have it, else the first common base. */
  base?: string;
  /** Called once, with what the script opened. */
  onOpen?: (summary: string) => void;
}

export class ReplayDesk implements DeskSource {
  readonly #o: ReplayDeskOptions;
  #legs: ScriptLeg[] | null = null;
  #opening: Promise<ScriptLeg[]> | null = null;
  /** The reserve, fixed when the script opens, less what replayed rescues took from it. */
  #reserve: number | null = null;

  constructor(options: ReplayDeskOptions) {
    this.#o = options;
  }

  async read(): Promise<DeskSnapshot> {
    if (this.#legs === null) {
      this.#opening ??= this.#open();
      this.#legs = await this.#opening;
    }
    const now = this.#o.clock.now();
    const reads: DeskSnapshot['reads'] = [];
    for (const v of this.#o.venues) {
      const mine = this.#legs.filter((l) => l.venue === v.id);
      if (mine.length === 0) continue;
      const started = Date.now();
      try {
        const rows = await v.funding();
        for (const l of mine) {
          const row = rows.find((r) => r.symbol === l.symbol);
          if (row === undefined || row.markPx === null || !(row.markPx > 0)) throw new Error(`replay: no recorded mark for ${l.symbol}`);
          // Funding since the last read, at the rate in force then: a long pays a positive rate.
          const hours = Math.max(0, now - l.at) / 3_600_000;
          l.fundingUsd += -l.size * l.mark * l.rate * hours;
          l.mark = row.markPx;
          l.rate = row.ratePerHour;
          l.at = now;
        }
        reads.push({ venue: v.id, ms: Date.now() - started, error: null });
      } catch (err) {
        reads.push({ venue: v.id, ms: Date.now() - started, error: errorMessage(err) });
      }
    }
    const failed = new Set(reads.filter((r) => r.error !== null).map((r) => r.venue));
    const legs = this.#legs.filter((l) => !failed.has(l.venue)).map((l) => this.#input(l, now));
    this.#reserve ??= this.#legs.reduce((s, l) => s + l.marginUsd, 0) * REPLAY_RESERVE_SHARE;
    return {
      deskId: 'replay', owner: 'replay', contract: 'replay', reserveUsd: Math.max(0, this.#reserve), paused: null, legs, reads,
    };
  }

  /** A replayed rescue landed `usd` on `venue`: the scripted leg there holds that much more margin. */
  credit(venue: VenueId, usd: number): void {
    const leg = this.#legs?.find((l) => l.venue === venue);
    if (leg !== undefined) leg.marginUsd += usd;
  }

  /** A replayed rescue took `usd` from the reserve. */
  spendReserve(usd: number): void {
    if (this.#reserve !== null) this.#reserve -= usd;
  }

  #input(l: ScriptLeg, now: number): LegInput {
    const upnl = l.size * (l.mark - l.entryPx);
    const equity = l.marginUsd + upnl + l.fundingUsd;
    const position: Position = {
      symbol: l.symbol, size: l.size, entryPx: l.entryPx, liqPx: null, marginUsd: l.marginUsd, unrealizedPnlUsd: upnl,
      leverage: Math.abs(l.size) * l.mark / l.marginUsd, fundingSinceOpenUsd: l.fundingUsd, unsettledFundingUsd: 0,
    };
    const account: AccountState = {
      venue: l.venue, address: 'replay', time: now, equityUsd: equity,
      freeMarginUsd: Math.max(0, equity - Math.abs(l.size) * l.mark / Math.max(1, this.#o.strategy().maxLeverage)),
      maintenanceMarginUsd: l.m * Math.abs(l.size) * l.mark, positions: [position],
    };
    return { venue: l.venue, symbol: l.symbol, lotSize: l.lotSize, account, position, markPx: l.mark, feesUsd: 0, unpriced: false };
  }

  async #open(): Promise<ScriptLeg[]> {
    const funding = new Map<VenueId, MarketFunding[]>();
    for (const v of this.#o.venues) {
      try {
        funding.set(v.id, await v.funding());
      } catch {
        // a venue the recording does not answer yet is left out of the script
      }
    }
    const baseOf = (r: MarketFunding) => r.base ?? r.symbol;
    const priced = (venue: VenueId, base: string) => funding.get(venue)?.find((r) => baseOf(r) === base && (r.multiplier ?? 1) === 1 && r.markPx !== null && r.markPx > 0);
    const venues = [...funding.keys()];
    const pairs: [VenueId, VenueId][] = [];
    if (venues.includes('hyperliquid') && venues.includes('phoenix')) pairs.push(['hyperliquid', 'phoenix']);
    for (let i = 0; i < venues.length; i++) for (let j = i + 1; j < venues.length; j++) pairs.push([venues[i]!, venues[j]!]);
    let pick: { a: MarketFunding; b: MarketFunding } | null = null;
    for (const [x, y] of pairs) {
      const bases = this.#o.base !== undefined ? [this.#o.base] : ['ETH', ...(funding.get(x) ?? []).map(baseOf)];
      for (const base of bases) {
        const a = priced(x, base);
        const b = priced(y, base);
        if (a !== undefined && b !== undefined) {
          pick = { a, b };
          break;
        }
      }
      if (pick !== null) break;
    }
    if (pick === null) throw new Error('replay desk: no market the recording prices on two desk venues');
    const strategy = this.#o.strategy();
    const now = this.#o.clock.now();
    // Long where funding is lower (a long pays a positive rate), short where it is higher: what the desk would hold.
    const [long, short] = pick.a.ratePerHour <= pick.b.ratePerHour ? [pick.a, pick.b] : [pick.b, pick.a];
    const units = strategy.legUsd / long.markPx!;
    const legs: ScriptLeg[] = [];
    for (const [row, sign] of [[long, 1], [short, -1]] as const) {
      const venue = row.venue as VenueId;
      const market = await this.#market(venue, row.symbol);
      legs.push({
        venue, symbol: row.symbol, size: sign * units, entryPx: row.markPx!, marginUsd: strategy.legUsd / strategy.maxLeverage,
        m: market.m, lotSize: market.lot, fundingUsd: 0, mark: row.markPx!, rate: row.ratePerHour, at: now,
      });
    }
    this.#o.onOpen?.(`replay desk (scripted positions, recorded prices): long ${units.toPrecision(4)} ${long.symbol} on ${long.venue} at ${long.markPx}, short on ${short.venue} at ${short.markPx}, ${strategy.legUsd} USD a leg at ${strategy.maxLeverage}x`);
    return legs;
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
