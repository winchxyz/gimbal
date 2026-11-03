// The position book (E10): a durable record of every position the desk holds, from the strategy loop's carried-out
// enters, exits and partial fills (BookRecord, through the loop's `book` sink), the venues' own funding ledgers, fill
// fees and transfers. On disk in GIMBAL_STATE_DIR: book-<mode>-<contract>-<desk>.jsonl (appended to, fsynced; store.ts)
// and .summary.json next to it (derived; rewritten atomically once per record and once per sync, after the call has
// returned).
//
// serve wiring: serve.ts creates it with createBook and hands `loopBook(book, ...)` (serve-loop.ts) the loop's `book`
// option and journal; `book.start()` syncs now, then every hour HOUR_SYNC_DELAY_MS after the top of the hour, and
// `book.stop()` on shutdown.

import type { JournalEntry, Mode } from '@gimbal/shared';
import { scanRead } from '../venues/http-budget.ts';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { BookSummary, PositionResult } from './derive.ts';
import {
  HOUR_MS, indexBook, openPosition, positionIdOf, positionResult, positionsOf, summarize, unsettledJournals,
} from './derive.ts';
import { entryNumbers, exitNumbers, feeJournal, fundingJournal, settledJournal, settlingNote, transferJournal } from './journal.ts';
import type { StoreHooks } from './store.ts';
import { BookStore, bookFile } from './store.ts';
import type { BookSources, SyncLine } from './sync.ts';
import {
  failedLine, feeEvents, fundingEvents, fundingWindow, keepSync, knownTxIds, ledgerEvents, ledgerWindow, missingFees, syncLine,
} from './sync.ts';
import type { BookEvent, BookRecord, EnterEvent, JournalEvent, SyncEvent, TransferEvent, TransferInput } from './types.ts';

/** The hourly sync runs this long after the top of the hour: Hyperliquid pays at it, Phoenix books a little later. */
export const HOUR_SYNC_DELAY_MS = 5 * 60_000;

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
}

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
    const positionId = this.#newId(input.windowId, input.since, positions);
    const record: BookRecord = {
      kind: 'enter', windowId: input.windowId, symbol: input.symbol, at: input.since,
      legs: input.legs.map((l) => ({ venue: l.venue, side: l.side === 'long' ? 'BUY' : 'SELL', qty: l.qty ?? '', avgPx: l.avgPx ?? null, feeUsd: null })),
      feeUsd: 0, tx: [], forecastNetAprPct: input.forecastNetAprPct ?? null, exitReason: null, rotation: null, by: input.by ?? 'manual',
      marginMoves: [], legUsd: input.legUsd ?? null,
    };
    const e: EnterEvent = { v: 1, type: 'enter', at: now, positionId, record, adopted: true };
    this.#append([e]);
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
    // The book's reads are background reads: below the risk engine's account reads, skipped (not retried) when the
    // venue's budget is short. A skipped read is a failed one: the next sync starts from the last good read.
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
    return { lines, added };
  }

  /** Syncs now, then every hour HOUR_SYNC_DELAY_MS after the top of the hour, until stop(). */
  start(): void {
    this.#stopped = false;
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
    if (this.#timer !== null) {
      if (this.#o.timers !== undefined) this.#o.timers.clearTimeout(this.#timer);
      else clearTimeout(this.#timer as NodeJS.Timeout);
    }
    this.#timer = null;
    this.flushSummary();
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
    this.#store.append(events, this.#persist);
    if (summary) this.#scheduleSummary();
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

/** The next hourly sync: HOUR_SYNC_DELAY_MS past the next top of the hour (or this one, when it is still ahead). */
export function nextSyncAt(now: number): number {
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_SYNC_DELAY_MS;
  return now < thisHour ? thisHour : thisHour + HOUR_MS;
}

/** The book's entry point for serve. Loads the book (throws on an unreadable file: it is never started over). */
export function createBook(options: BookOptions): PositionBook {
  return new PositionBook(options);
}
