// The position book (E10): a durable record of every position the desk holds, from the strategy loop's carried-out
// enters, exits and partial fills (BookRecord, through the loop's `book` sink), the venues' own funding ledgers, fill
// fees and transfers. On disk in GIMBAL_STATE_DIR: book-<mode>-<contract>-<desk>.jsonl (appended to, fsynced; store.ts)
// and .summary.json next to it (derived; rewritten atomically once per record and once per sync, after the call has
// returned).
//
// serve wiring: serve.ts creates it with createBook and hands `loopBook(book, ...)` (serve-loop.ts) the loop's `book`
// option and journal; `book.start()` syncs now, then every hour HOUR_SYNC_DELAY_MS after the top of the hour, and at
// once when a position is booked (entered, or adopted from the loop) while it runs, so its ledgers are read from the
// start rather than at the next hour; `book.stop()` on shutdown. A book with no position has no ledger to read: its
// summary then has no cursors (`npm run report`: "never synced") until one is booked.

import type { JournalEntry, Mode, TxRef } from '@gimbal/shared';
import { scanRead } from '../venues/http-budget.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { BookSummary, OpenFeesIndex, OpenLegFees, PositionResult } from './derive.ts';
import {
  HOUR_MS, indexBook, openFeesIndex, openLegFeesUsd, openPosition, positionIdOf, positionResult, positionsOf, summarize, unsettledJournals,
} from './derive.ts';
import { entryNumbers, exitNumbers, feeJournal, fundingJournal, settledJournal, settlingNote, transferJournal } from './journal.ts';
import { FILL_WINDOW_SLACK_MS } from './sources.ts';
import type { StoreHooks } from './store.ts';
import { BookStore, bookFile } from './store.ts';
import type { BookSources, SyncLine } from './sync.ts';
import {
  failedLine, feeEvents, fundingEvents, fundingWindow, keepSync, knownTxIds, ledgerEvents, ledgerWindow, missingFees, syncLine,
} from './sync.ts';
import type { BookEvent, BookFill, BookRecord, EnterEvent, JournalEvent, SyncEvent, TransferEvent, TransferInput } from './types.ts';

/** The hourly sync runs this long after the top of the hour: Hyperliquid pays at it, Phoenix books a little later. */
export const HOUR_SYNC_DELAY_MS = 5 * 60_000;
/**
 * The sync after an enter waits this long: Phoenix's trades-history indexes a fill some seconds after it lands, and a
 * fee read before every signature is there would be partial (the fee read waits for them all anyway, sources.ts). An
 * adopted position (no fills of its own) is read at once.
 */
export const POST_ENTER_SYNC_MS = 60_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BookOptions {
  /** GIMBAL_STATE_DIR. */
  dir: string;
  mode: Mode;
  contractId: string | null;
  deskId: string | null;
  /** Venue id -> the desk's address there (hyperliquid: the desk EVM address; phoenix: its Solana authority). */
  addresses?: Record<string, string>;
  /** The ledgers; none = the book records but never syncs. */
  sources?: BookSources | null;
  /** Journal entries (serve: publish({ type: 'journal', data })). */
  publish?: (entry: JournalEntry) => void;
  clock?: Clock;
  log?: (line: string) => void;
  /** false: nothing is written to disk (the report's --sync reads into memory only). Default true. */
  persist?: boolean;
  /** The JSONL path; default bookFile(dir, mode, contractId, deskId). */
  path?: string;
  hooks?: StoreHooks;
  timers?: Timers;
  /**
   * The window the strategy loop holds now: null when it holds nothing, undefined when it cannot tell (no loop, no
   * hands). A position the book holds open while the loop holds nothing was closed outside the loop with no close
   * report (a protection's close that threw, a close by hand): the next sync books its exit from the venues' fills.
   */
  loopHeld?: () => { windowId: string } | null | undefined;
}

/** A close made outside the strategy loop (panic_close, a rescue's reduce, an ADL unwind), as recordOutside takes it. */
export interface OutsideClose {
  /** The exit reason: 'panic_close', 'rescue reduce', 'ADL unwind', 'closed outside the loop'. */
  reason: string;
  by: 'auto' | 'manual';
  /** ms, before its first order. */
  startedAt: number;
  at: number;
  /** Its fills per venue and side (BookFill: feeUsd is the venue's charge). */
  fills: BookFill[];
  /** The venues' charge for them, > 0 a cost. */
  feeUsd: number;
  tx: TxRef[];
  /** Both legs read flat after it: the position's exit. Otherwise its fills are a partial reduce (a `fill` record). */
  flat: boolean;
  /** The pair's symbol: the open position on it. */
  symbol?: string;
}

/** A position open in the book this long after its last record, while the loop holds nothing, is looked for as closed. */
export const OUTSIDE_CLOSE_GRACE_MS = 2 * 60_000;

/** How long the book retries a venue fills read it needs (a close lookup, a close found outside the loop) before it gives up. */
export const FILL_READ_GIVE_UP_MS = 24 * HOUR_MS;

/** A protection's close whose fills were not booked (it threw, or its booking failed): read from the venues at the next sync. */
export interface CloseLookup {
  /** The protection: 'panic_close', 'rescue reduce', 'ADL unwind'. */
  reason: string;
  by: 'auto' | 'manual';
  /** ms, before its first order. */
  startedAt: number;
  /** ms, when it ended (threw). */
  at: number;
  /** The pair's symbol: the open position on it. */
  symbol?: string;
}

type BookPosition = ReturnType<typeof positionsOf>[number];

export interface AdoptInput {
  windowId: string;
  symbol: string;
  /** ms: when the book starts counting it (funding before this is not its). */
  since: number;
  legs: { venue: string; side: 'long' | 'short'; qty?: string | null; avgPx?: number | null }[];
  forecastNetAprPct?: number | null;
  legUsd?: number | null;
  by?: 'auto' | 'manual';
}

export interface SyncReport {
  lines: SyncLine[];
  added: number;
}

export interface Recorded {
  positionId: string | null;
  /** What serve merges into the loop's journal entry for the act. */
  numbers: Record<string, number | string>;
  /** A clause for that entry's summary (an exit: `funding read to 14:00, settling`), or null. */
  note: string | null;
}

export class PositionBook {
  readonly path: string;
  readonly #o: BookOptions;
  readonly #store: BookStore;
  readonly #clock: Clock;
  readonly #persist: boolean;
  /** Ledger reads that went through but whose sync line was not written (it stored nothing): ledger -> end. */
  readonly #cursors: Record<string, number> = {};
  #syncing: Promise<SyncReport> | null = null;
  #timer: unknown = null;
  #summaryDue: NodeJS.Immediate | null = null;
  #stopped = false;
  #started = false;
  #syncSoonDue = false;
  /** Protection closes whose fills the next sync reads (memory only: a restart drops them, the venues keep the fills). */
  #lookups: (CloseLookup & { positionId: string; failingSince: number | null })[] = [];
  /** Position id -> when the read of its closing fills first failed (the detector retries until FILL_READ_GIVE_UP_MS). */
  readonly #detectFailing = new Map<string, number>();
  #readOnlyJournaled = false;
  /** openLegFees' index and the event count it was derived at (the store only appends). */
  #openFees: { n: number; ix: OpenFeesIndex } | null = null;

  constructor(o: BookOptions) {
    this.#o = o;
    this.#clock = o.clock ?? systemClock;
    this.#persist = o.persist ?? true;
    this.path = o.path ?? bookFile(o.dir, o.mode, o.contractId, o.deskId);
    this.#store = new BookStore(this.path, o.hooks ?? {});
    this.#store.load({ repair: this.#persist });
    if (this.#store.repaired !== null) this.#log(`book: ${this.path}: ${this.#store.repaired}`);
    const addresses = Object.fromEntries(Object.entries(o.addresses ?? {}).filter(([, a]) => a !== ''));
    const desk = [...this.events].reverse().find((e) => e.type === 'desk');
    const same = desk !== undefined && desk.type === 'desk' && desk.mode === o.mode && desk.contract === o.contractId
      && desk.desk === o.deskId && JSON.stringify(desk.addresses) === JSON.stringify(addresses);
    if (!same && (o.addresses !== undefined || desk === undefined)) {
      this.#append([{ v: 1, type: 'desk', at: this.#clock.now(), mode: o.mode, contract: o.contractId, desk: o.deskId, addresses }]);
    }
  }

  get events(): readonly BookEvent[] {
    return this.#store.events;
  }

  /** The desk's address on a venue: the options', else the book's own desk line. */
  address(venue: string): string | null {
    const given = this.#o.addresses?.[venue];
    if (given !== undefined && given !== '') return given;
    const events = this.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'desk' && e.addresses[venue] !== undefined) return e.addresses[venue]!;
    }
    return null;
  }

  /**
   * A carried-out act (the loop's BookSink): an enter, an exit, or the fills of an act that did not end as asked. An
   * exit closes the open position with its window id; with none open it is kept as an exit the book never saw enter.
   * Fills go to the open position with their window id, else to the desk. Returns the position and the numbers for the
   * act's journal entry. Throws when the book could not be written (the loop logs it; the act stands).
   */
  record(record: BookRecord): Recorded {
    const now = this.#clock.now();
    const positions = positionsOf(this.events);
    let positionId: string | null;
    const added: BookEvent[] = [];
    const copy = structuredClone(record);
    if (record.kind === 'enter') {
      // An entry into a window the book still holds open: that one was closed outside the loop, unseen. Closed first.
      const stale = openPosition(positions, record.windowId);
      if (stale !== null) {
        const before = Math.max(lastRecordAt(stale), (record.startedAt ?? record.at) - 1);
        added.push({
          v: 1, type: 'exit', at: now, positionId: stale.id, record: {
            kind: 'exit', windowId: stale.windowId, symbol: stale.symbol, at: before, legs: [], feeUsd: 0, tx: [],
            forecastNetAprPct: stale.enter.record.forecastNetAprPct, exitReason: 'closed outside the loop (fills unread)',
            rotation: null, by: 'manual', marginMoves: [], fillsUnread: true,
          },
        });
        this.#log(`book: ${stale.id} was still open when ${record.windowId} was entered again: closed outside the loop first (its fills unread)`);
      }
      positionId = this.#newId(record.windowId, record.at, positions);
      added.push({ v: 1, type: 'enter', at: now, positionId, record: copy, adopted: false });
    } else if (record.kind === 'exit') {
      positionId = openPosition(positions, record.windowId)?.id ?? null;
      added.push({ v: 1, type: 'exit', at: now, positionId, record: copy });
      if (positionId === null) this.#log(`book: exit of ${record.windowId} with no open position booked; kept apart`);
    } else {
      positionId = openPosition(positions, record.windowId)?.id ?? null;
      added.push({ v: 1, type: 'fill', at: now, positionId, record: copy });
    }
    for (const [i, m] of record.marginMoves.entries()) {
      const t: TransferEvent = {
        v: 1, type: 'transfer', at: now, id: `loop:${record.windowId}:${record.kind}:${record.at}:${i}`, time: record.at, positionId,
        from: m.from, to: m.to, usd: 0, feeUsd: -Math.abs(m.feeUsd) || 0, tx: m.tx, source: 'loop', note: `margin move for the ${record.kind}`,
      };
      // The move itself is the record's (counted once, in derive, from marginMoves); this line carries its journal only.
      const j = transferJournal(t, now);
      if (j !== null) added.push(j);
    }
    this.#append(added);
    this.#publishNew(added);
    if (record.kind === 'enter') this.#syncSoon(POST_ENTER_SYNC_MS);
    if (positionId === null || record.kind === 'fill') return { positionId, numbers: {}, note: null };
    const r = this.result(positionId);
    if (r === null) return { positionId, numbers: {}, note: null };
    return record.kind === 'enter'
      ? { positionId, numbers: entryNumbers(r), note: null }
      : { positionId, numbers: exitNumbers(r), note: settlingNote(r) };
  }

  /** The window id of the position open now (the latest), or null. */
  openWindow(): string | null {
    return openPosition(positionsOf(this.events))?.windowId ?? null;
  }

  /** A pair opened outside the loop (adopted from the venues): booked from `since`, with no opening fills. */
  adopt(input: AdoptInput): string {
    const now = this.#clock.now();
    const positions = positionsOf(this.events);
    const held = openPosition(positions, input.windowId);
    if (held !== null) return held.id;
    // Closed in the book (panic_close, a rescue, an ADL unwind) while the loop still says it holds it: not adopted again.
    const closed = positions.findLast((p) => p.windowId === input.windowId && p.exit !== null && p.exit.record.at >= input.since);
    if (closed !== undefined) return closed.id;
    const positionId = this.#newId(input.windowId, input.since, positions);
    const record: BookRecord = {
      kind: 'enter', windowId: input.windowId, symbol: input.symbol, at: input.since,
      legs: input.legs.map((l) => ({ venue: l.venue, side: l.side === 'long' ? 'BUY' : 'SELL', qty: l.qty ?? '', avgPx: l.avgPx ?? null, feeUsd: null })),
      feeUsd: 0, tx: [], forecastNetAprPct: input.forecastNetAprPct ?? null, exitReason: null, rotation: null, by: input.by ?? 'manual',
      marginMoves: [], legUsd: input.legUsd ?? null,
    };
    const e: EnterEvent = { v: 1, type: 'enter', at: now, positionId, record, adopted: true };
    this.#append([e]);
    this.#syncSoon(0);
    return positionId;
  }

  /**
   * A transfer made outside the loop (rescue, the manual fund scripts), with its tx refs. Returns its id. A transfer
   * whose tx the book already holds (added before, read from the Hyperliquid ledger, a margin move of the loop) is not
   * added again: the id of the one held is returned.
   */
  addTransfer(input: TransferInput, options: { journal?: boolean } = {}): string {
    if (!Number.isFinite(input.usd) || !Number.isFinite(input.feeUsd)) throw new Error('addTransfer: usd and feeUsd must be numbers');
    if (input.feeUsd > 0) throw new Error(`addTransfer: feeUsd is a cost, ≤ 0 (got ${input.feeUsd})`);
    const known = knownTxIds(this.events);
    for (const t of input.tx) {
      const held = known.get(t.id.toLowerCase());
      if (held !== undefined) {
        this.#log(`book: transfer ${t.chain} ${t.id} is already booked as ${held}; not added again`);
        return held;
      }
    }
    const now = this.#clock.now();
    const time = input.at ?? now;
    let positionId: string | null = null;
    if (input.positionId === 'open') positionId = openPosition(positionsOf(this.events))?.id ?? null;
    else if (input.positionId !== undefined && input.positionId !== null) {
      if (!positionsOf(this.events).some((p) => p.id === input.positionId)) throw new Error(`addTransfer: no position ${input.positionId}`);
      positionId = input.positionId;
    }
    const same = this.events.filter((e) => e.type === 'transfer' && e.time === time && e.source === input.source).length;
    const t: TransferEvent = {
      v: 1, type: 'transfer', at: now, id: `${input.source}:${time}:${same}`, time, positionId,
      from: input.from, to: input.to, usd: input.usd, feeUsd: input.feeUsd || 0, tx: input.tx, source: input.source, note: input.note ?? null,
    };
    const added: BookEvent[] = [t];
    const j = options.journal === false ? null : transferJournal(t, now);
    if (j !== null) added.push(j);
    this.#append(added);
    this.#publishNew(added);
    return t.id;
  }

  /** Reads the ledgers (funding per venue, the Hyperliquid ledger, missing fill fees) and books what is new. */
  sync(): Promise<SyncReport> {
    if (this.#syncing !== null) return this.#syncing;
    this.#syncing = this.#sync().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #sync(): Promise<SyncReport> {
    const sources = this.#o.sources;
    const lines: SyncLine[] = [];
    let added = 0;
    if (sources === undefined || sources === null) return { lines: [{ ledger: 'book', ok: false, text: 'no ledgers to read' }], added };
    const readOnly = this.readOnly();
    if (readOnly !== null) return { lines: [{ ledger: 'book', ok: false, text: `read only until restart (${readOnly}): nothing synced` }], added };
    // The book's reads are background reads: below the risk engine's account reads, skipped (not retried) when the
    // venue's budget is short. A skipped read is a failed one: the next sync starts from the last good read.
    lines.push(...await this.#lookupCloses(sources));
    lines.push(...await this.#closedOutside(sources));
    const venues = [...new Set(positionsOf(this.events).flatMap((p) => p.legs.map((l) => l.venue)))].sort();
    for (const venue of venues) {
      const source = sources.funding[venue];
      const address = this.address(venue);
      if (source === undefined || address === null) {
        lines.push({ ledger: venue, ok: false, text: `${venue}: ${source === undefined ? 'no ledger reader' : 'no desk address'}` });
        continue;
      }
      const read = fundingWindow(this.events, venue, this.#clock.now(), this.#cursors);
      if (read === null) {
        lines.push({ ledger: venue, ok: true, text: `${venue}: no position needs it` });
        continue;
      }
      try {
        const rows = await scanRead(() => source.userFunding(address, read.from, read.to));
        const events = fundingEvents(this.events, venue, rows, read, this.#clock.now());
        this.#appendRead(events);
        added += events.length - 1;
        lines.push(syncLine(venue, events));
      } catch (err) {
        lines.push(failedLine(venue, err));
      }
    }
    const hlAddress = this.address('hyperliquid');
    const hlLedger = sources.hlLedger;
    if (hlLedger !== undefined && hlAddress !== null) {
      const read = ledgerWindow(this.events, this.#clock.now(), this.#cursors);
      if (read !== null) {
        try {
          const rows = await scanRead(() => hlLedger(hlAddress, read.from, read.to));
          const events = ledgerEvents(this.events, rows, hlAddress, read, sources.hlTxRef ?? (() => null), this.#clock.now());
          const journals = events.filter((e): e is TransferEvent => e.type === 'transfer')
            .map((t) => transferJournal(t, this.#clock.now())).filter((j): j is JournalEvent => j !== null);
          this.#appendRead([...events, ...journals]);
          this.#publishNew(journals);
          added += events.length - 1;
          lines.push(syncLine('hyperliquid-ledger', events));
        } catch (err) {
          lines.push(failedLine('hyperliquid-ledger', err));
        }
      }
    }
    const fillFee = sources.fillFee;
    if (fillFee !== undefined) {
      for (const m of missingFees(this.events, this.#clock.now())) {
        const address = this.address(m.venue);
        if (address === null) continue;
        try {
          const charged = await scanRead(() => fillFee({
            venue: m.venue, address, symbol: m.symbol, side: m.side, startedAt: m.record.startedAt ?? null, at: m.record.at, tx: m.record.tx,
            now: this.#clock.now(),
          }));
          if (charged === null || !Number.isFinite(charged)) continue;
          const now = this.#clock.now();
          const fees = feeEvents(m, charged, now);
          const j = feeJournal(m, fees, now);
          this.#append([...fees, j], false);
          this.#publishNew([j]);
          added += fees.length;
          lines.push({ ledger: `${m.venue}-fills`, ok: true, text: `${m.venue}: ${m.stage} fee of ${m.positionId ?? 'the desk'} read from the venue's fills` });
        } catch (err) {
          lines.push(failedLine(`${m.venue}-fills`, err));
        }
      }
    }
    const journals = fundingJournal(this.events, this.#clock.now());
    this.#append(journals, false);
    this.#publishNew(journals);
    // Settled: written to the file first, published after, once per position.
    const now = this.#clock.now();
    const ix = indexBook(this.events, this.#cursors);
    const settled = unsettledJournals(this.events, ix.all.map((p) => positionResult(p, ix, now))).map((r) => settledJournal(r, now));
    this.#append(settled, false);
    this.#publishNew(settled);
    this.#scheduleSummary();
    for (const l of lines) this.#log(`book: ${l.text}`);
    if (lines.length === 0) this.#log('book: no ledger read: no position is booked yet (the next sync after one is booked reads them)');
    return { lines, added };
  }

  /**
   * A close made outside the strategy loop: an exit when both legs ended flat, else (a partial reduce with fills) a
   * `fill` record of the open position. The position is the open one on `symbol` (else the latest open). Nothing
   * filled and not flat: nothing to book. Returns what record() returns.
   */
  recordOutside(c: OutsideClose): Recorded {
    const positions = positionsOf(this.events);
    const open = positions.filter((p) => p.exit === null);
    const on = c.symbol === undefined ? [] : open.filter((p) => p.symbol.toUpperCase() === c.symbol!.toUpperCase());
    const target = on.at(-1) ?? open.at(-1) ?? null;
    if (!c.flat && c.fills.length === 0) return { positionId: null, numbers: {}, note: null };
    if (c.flat && target === null && c.fills.length === 0) return { positionId: null, numbers: {}, note: null };
    const record: BookRecord = {
      kind: c.flat && target !== null ? 'exit' : 'fill',
      windowId: target?.windowId ?? `outside:${c.reason}`, symbol: target?.symbol ?? c.symbol ?? '',
      at: c.at, startedAt: c.startedAt, legs: c.fills, feeUsd: c.feeUsd, tx: c.tx,
      forecastNetAprPct: target?.enter.record.forecastNetAprPct ?? null, exitReason: c.reason, rotation: null, by: c.by, marginMoves: [],
    };
    const r = this.record(record);
    this.#log(`book: ${c.reason} booked as ${record.kind === 'exit' ? `the exit of ${r.positionId}` : `a partial fill of ${r.positionId ?? 'the desk'}`}`
      + ` (${c.fills.length} fill(s))`);
    return r;
  }

  /**
   * A protection's close whose fills were not booked (it threw after it may have filled, or its booking failed): the
   * next sync reads the venues' fills over [startedAt, at] and books them as a `fill` record with its reason. Memory
   * only. With no position open there is nothing to look for.
   */
  queueCloseLookup(c: CloseLookup): void {
    const open = positionsOf(this.events).filter((p) => p.exit === null);
    const on = c.symbol === undefined ? [] : open.filter((p) => p.symbol.toUpperCase() === c.symbol!.toUpperCase());
    const target = on.at(-1) ?? open.at(-1) ?? null;
    if (target === null) {
      this.#log(`book: the ${c.reason} close's fills are not looked for: no position is open`);
      return;
    }
    this.#lookups.push({ ...c, positionId: target.id, failingSince: null });
    this.#log(`book: the ${c.reason} close's fills on ${target.id} are read from the venues at the next sync`);
  }

  /** The closing fills of each leg of `p` in [from, to]; `failed` names each leg whose read failed or cannot be made. */
  async #readCloseFills(sources: BookSources, p: BookPosition, from: number, to: number): Promise<{ fills: BookFill[]; at: number; failed: string[] }> {
    const fills: BookFill[] = [];
    const failed: string[] = [];
    let at = 0;
    for (const leg of p.legs) {
      const address = this.address(leg.venue);
      if (sources.closeFills === undefined || address === null) {
        failed.push(`${leg.venue}: ${address === null ? 'no desk address' : 'no fills reader'}`);
        continue;
      }
      try {
        const f = await scanRead(() => sources.closeFills!({
          venue: leg.venue, address, symbol: p.symbol, side: leg.side === 'long' ? 'SELL' : 'BUY', from, to,
        }));
        if (f !== null) {
          fills.push(f.fill);
          at = Math.max(at, f.at);
        }
      } catch (err) {
        failed.push(`${leg.venue}: ${errorMessage(err)}`);
      }
    }
    return { fills, at, failed };
  }

  /** The queued close lookups (queueCloseLookup): each read once per sync until it books, finds nothing, or gives up. */
  async #lookupCloses(sources: BookSources): Promise<SyncLine[]> {
    const lines: SyncLine[] = [];
    const due = this.#lookups;
    this.#lookups = [];
    const keep: typeof due = [];
    for (const l of due) {
      const what = `the ${l.reason} close's fills on ${l.positionId}`;
      const p = positionsOf(this.events).find((q) => q.id === l.positionId);
      if (p === undefined || p.exit !== null) {
        lines.push({ ledger: 'book', ok: true, text: `${what}: not read, the position is closed` });
        continue;
      }
      const held = this.#o.loopHeld?.();
      if (held !== undefined && (held === null || held.windowId !== p.windowId)) {
        // The loop holds nothing there: the close-outside detector books the exit from every fill since the last record.
        lines.push({ ledger: 'book', ok: true, text: `${what}: the loop no longer holds it, so they go with its exit` });
        continue;
      }
      const now = this.#clock.now();
      // Never before the position's last record: fills already booked with it are not counted again.
      const from = Math.max(l.startedAt - FILL_WINDOW_SLACK_MS, lastRecordAt(p) + 1);
      const r = await this.#readCloseFills(sources, p, from, l.at + FILL_WINDOW_SLACK_MS);
      if (r.failed.length > 0) {
        const since = l.failingSince ?? now;
        if (now - since >= FILL_READ_GIVE_UP_MS) {
          lines.push({ ledger: 'book', ok: false, text: `${what}: not read for 24 h (${r.failed.join('; ')}); given up, they are not booked` });
          continue;
        }
        keep.push({ ...l, failingSince: since });
        lines.push({ ledger: 'book', ok: false, text: `${what}: not read (${r.failed.join('; ')}); tried again at the next sync` });
        continue;
      }
      if (r.fills.length === 0) {
        lines.push({ ledger: 'book', ok: true, text: `${what}: the venues show none, it filled nothing` });
        continue;
      }
      if (positionsOf(this.events).find((q) => q.id === p.id)?.exit !== null) continue;
      try {
        this.record({
          kind: 'fill', windowId: p.windowId, symbol: p.symbol, startedAt: l.startedAt, at: r.at > 0 ? r.at : l.at, legs: r.fills,
          feeUsd: r.fills.reduce((a, f) => a + (f.feeUsd ?? 0), 0), tx: [], forecastNetAprPct: p.enter.record.forecastNetAprPct,
          exitReason: l.reason, rotation: null, by: l.by, marginMoves: [],
        });
      } catch (err) {
        keep.push(l);
        lines.push({ ledger: 'book', ok: false, text: `${what}: read, but not written (${errorMessage(err)}); tried again at the next sync` });
        continue;
      }
      lines.push({ ledger: 'book', ok: true, text: `${what}: ${r.fills.length} venue fill(s) booked as a partial fill` });
    }
    this.#lookups.push(...keep);
    return lines;
  }

  /**
   * Open positions the loop no longer holds (see BookOptions.loopHeld): booked as exits from the venues' closing fills
   * since their last record. A leg whose read fails holds the position for the next sync; after FILL_READ_GIVE_UP_MS of
   * failures the exit is booked with what was read, marked `fillsUnread` (price and close fees unknown, estimated).
   */
  async #closedOutside(sources: BookSources): Promise<SyncLine[]> {
    const lines: SyncLine[] = [];
    for (const p of positionsOf(this.events)) {
      const held = this.#o.loopHeld?.();
      if (held === undefined) break;
      if (p.exit !== null || (held !== null && held.windowId === p.windowId)) {
        this.#detectFailing.delete(p.id);
        continue;
      }
      const now = this.#clock.now();
      const last = lastRecordAt(p);
      if (now - last < OUTSIDE_CLOSE_GRACE_MS) continue;
      // From just after the last record: fills booked with it (a lookup's partial fill) are not counted again.
      const r = await this.#readCloseFills(sources, p, last + 1, now);
      let unread: string | null = null;
      if (r.failed.length > 0) {
        const since = this.#detectFailing.get(p.id) ?? now;
        this.#detectFailing.set(p.id, since);
        if (now - since < FILL_READ_GIVE_UP_MS) {
          lines.push({ ledger: 'book', ok: false, text: `${p.id} looks closed outside the loop, but its closing fills were not read (${r.failed.join('; ')}); tried again at the next sync` });
          continue;
        }
        unread = r.failed.join('; ');
      }
      // Checked again after the reads: a close booked meanwhile (a protection's report), or the loop holds it again.
      const again = this.#o.loopHeld?.();
      const still = positionsOf(this.events).find((q) => q.id === p.id);
      if (still === undefined || still.exit !== null || again === undefined || (again !== null && again.windowId === p.windowId)) continue;
      let booked: Recorded;
      try {
        booked = this.record({
          kind: 'exit', windowId: p.windowId, symbol: p.symbol, at: r.at > 0 ? r.at : now, legs: r.fills,
          feeUsd: r.fills.reduce((a, f) => a + (f.feeUsd ?? 0), 0), tx: [], forecastNetAprPct: p.enter.record.forecastNetAprPct,
          exitReason: unread === null ? 'closed outside the loop' : 'closed outside the loop (fills unread)', rotation: null, by: 'manual',
          marginMoves: [], ...(unread === null ? {} : { fillsUnread: true }),
        });
      } catch (err) {
        lines.push({ ledger: 'book', ok: false, text: `${p.id} closed outside the loop, but its exit was not written (${errorMessage(err)}); the next sync tries again` });
        continue;
      }
      this.#detectFailing.delete(p.id);
      lines.push({
        ledger: 'book', ok: unread === null,
        text: `${booked.positionId} closed outside the loop (the loop holds ${again === null ? 'nothing' : again.windowId}): exit booked from ${r.fills.length} venue fill(s)`
          + `${unread === null ? '' : `; fills unread for 24 h (${unread}): price and close fees unknown, estimated`}`,
      });
    }
    return lines;
  }

  /** Syncs now, then every hour HOUR_SYNC_DELAY_MS after the top of the hour, until stop(). */
  start(): void {
    this.#stopped = false;
    this.#started = true;
    const run = () => {
      this.#timer = null;
      this.sync().catch((err: unknown) => this.#log(`book: sync failed (${errorMessage(err)})`)).finally(() => {
        if (!this.#stopped) this.#schedule(run);
      });
    };
    run();
  }

  /** Stops the hourly sync and writes a summary that is due. */
  stop(): void {
    this.#stopped = true;
    this.#started = false;
    if (this.#timer !== null) {
      if (this.#o.timers !== undefined) this.#o.timers.clearTimeout(this.#timer);
      else clearTimeout(this.#timer as NodeJS.Timeout);
    }
    this.#timer = null;
    this.flushSummary();
  }

  /**
   * A position was just booked while the hourly sync runs: a sync `delayMs` on (off the caller's stack; an enter's after
   * POST_ENTER_SYNC_MS), after the one running ends if one does (it chose its ledgers before this position was there).
   * The hourly timer is left as it is.
   */
  #syncSoon(delayMs: number): void {
    if (!this.#started || this.#stopped || this.#syncSoonDue) return;
    this.#syncSoonDue = true;
    const go = () => {
      if (this.#stopped) return;
      this.sync().catch((err: unknown) => this.#log(`book: sync failed (${errorMessage(err)})`));
    };
    const run = () => {
      this.#syncSoonDue = false;
      const running = this.#syncing;
      if (running === null) go();
      else void running.then(go, go);
    };
    if (this.#o.timers !== undefined) this.#o.timers.setTimeout(run, delayMs);
    else setTimeout(run, delayMs).unref();
  }

  #schedule(run: () => void): void {
    const now = this.#clock.now();
    const delay = nextSyncAt(now) - now;
    if (this.#o.timers !== undefined) this.#timer = this.#o.timers.setTimeout(run, delay);
    else {
      const t = setTimeout(run, delay);
      t.unref();
      this.#timer = t;
    }
  }

  summary(): BookSummary {
    return summarize(this.events, this.#clock.now(), this.#cursors);
  }

  result(positionId: string): PositionResult | null {
    const ix = indexBook(this.events, this.#cursors);
    const p = ix.all.find((x) => x.id === positionId);
    return p === undefined ? null : positionResult(p, ix, this.#clock.now());
  }

  /**
   * The fill fees booked for the open position's leg on `venue` and `side` whose symbol `matches` (derive.ts
   * openLegFeesUsd), signed (a cost < 0), with that position's id; null with no such open position, and while the book
   * is read only (a write that failed may have been the exit: what memory holds open may not be). The live desk's leg
   * fees (risk/sources.ts). Derived again only once an event was added.
   */
  openLegFees(venue: string, side: 'long' | 'short', matches: (symbol: string) => boolean): OpenLegFees | null {
    if (this.readOnly() !== null) return null;
    const n = this.events.length;
    if (this.#openFees?.n !== n) this.#openFees = { n, ix: openFeesIndex(this.events) };
    return openLegFeesUsd(this.#openFees.ix, venue, side, matches);
  }

  /** What serve merges into the loop's enter (or rotate) journal entry. */
  entryNumbers(positionId: string): Record<string, number | string> {
    const r = this.result(positionId);
    return r === null ? {} : entryNumbers(r);
  }

  /** What serve merges into the loop's exit journal entry. */
  exitNumbers(positionId: string): Record<string, number | string> {
    const r = this.result(positionId);
    return r === null ? {} : exitNumbers(r);
  }

  /** Writes the summary now when one is due (stop() does; tests do). */
  flushSummary(): void {
    if (this.#summaryDue === null) return;
    clearImmediate(this.#summaryDue);
    this.#summaryDue = null;
    this.#writeSummary();
  }

  #newId(windowId: string, at: number, positions: readonly { id: string }[]): string {
    const base = positionIdOf(windowId, at);
    let id = base;
    for (let n = 2; positions.some((p) => p.id === id); n++) id = `${base}.${n}`;
    return id;
  }

  /** One ledger read: its events, and its sync line only when keepSync says so (else the cursor moves in memory). */
  #appendRead(events: readonly BookEvent[]): void {
    const sync = events.find((e): e is SyncEvent => e.type === 'sync');
    const rest = events.filter((e) => e.type !== 'sync');
    const keep = sync !== undefined && keepSync(this.events, sync);
    this.#append(keep ? [...rest, sync] : rest, false);
    if (sync !== undefined && !(this.#cursors[sync.ledger]! >= sync.to)) this.#cursors[sync.ledger] = sync.to;
  }

  /** Appends (fsynced when persisting); `summary` true schedules the summary (a sync schedules it once, at its end). */
  #append(events: readonly BookEvent[], summary = true): void {
    if (events.length === 0) return;
    try {
      this.#store.append(events, this.#persist);
    } catch (err) {
      this.#noteReadOnly();
      throw err;
    }
    if (summary) this.#scheduleSummary();
  }

  /** Why the book refuses writes until the process restarts (a failed write it could not cut back), or null. */
  readOnly(): string | null {
    return this.#store.readOnly;
  }

  /** Once the store went read only: logged and journaled as an error, once. */
  #noteReadOnly(): void {
    const why = this.#store.readOnly;
    if (why === null || this.#readOnlyJournaled) return;
    this.#readOnlyJournaled = true;
    const now = this.#clock.now();
    this.#log(`book: READ ONLY until restart (${why})`);
    this.#o.publish?.({
      id: `book-read-only-${now}`, t: now, kind: 'error', numbers: { stage: 'book' }, tx: [],
      summary: `position book read only until serve restarts: ${why}. Nothing more is booked until then; the next start reads the funding again from its last good read`,
    });
  }

  /** The summary is derived from everything: written once the current call has returned, coalesced. */
  #scheduleSummary(): void {
    if (!this.#persist || this.#summaryDue !== null) return;
    this.#summaryDue = setImmediate(() => {
      this.#summaryDue = null;
      this.#writeSummary();
    });
  }

  #writeSummary(): void {
    try {
      this.#store.writeSummary(this.summary());
    } catch (err) {
      this.#log(`book: summary not written (${errorMessage(err)}); the JSONL holds everything`);
    }
  }

  #publishNew(events: readonly BookEvent[]): void {
    if (this.#o.publish === undefined || !this.#persist) return;
    for (const e of events) if (e.type === 'journal') this.#o.publish(e.entry);
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }
}

/** When a position's last record was made: its entry, or its latest partial fill. */
function lastRecordAt(p: BookPosition): number {
  return Math.max(p.enter.record.at, ...p.fills.map((f) => f.record.at));
}

/** The next hourly sync: HOUR_SYNC_DELAY_MS past the next top of the hour (or this one, when it is still ahead). */
export function nextSyncAt(now: number): number {
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_SYNC_DELAY_MS;
  return now < thisHour ? thisHour : thisHour + HOUR_MS;
}

/** The book's entry point for serve. Loads the book (throws on an unreadable file: it is never started over). */
export function createBook(options: BookOptions): PositionBook {
  return new PositionBook(options);
}
