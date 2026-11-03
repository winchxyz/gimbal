// The position book (E10): a durable record of every position the desk holds, from the strategy loop's carried-out
// enters and exits (BookRecord, through the loop's `book` sink), the venues' own funding ledgers, fill fees and
// transfers. On disk in GIMBAL_STATE_DIR: book-<mode>-<contract>-<desk>.jsonl (append-only events, store.ts) and
// .summary.json next to it (derived, rewritten after every change). Both are written atomically.
//
// serve wiring (after the loop merges): `const book = createBook({...})`, pass `book.record` as the loop's `book`
// option, `book.start()` (sync now, then every hour, HOUR_SYNC_DELAY_MS after the top of the hour), `book.stop()` on
// shutdown; merge `book.entryNumbers(id)` / `book.exitNumbers(id)` into the loop's enter / exit journal entries.

import type { JournalEntry, Mode } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import { systemClock } from '../venues/venue.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { BookSummary, PositionResult } from './derive.ts';
import { HOUR_MS, openPosition, positionIdOf, positionResult, positionsOf, summarize } from './derive.ts';
import { entryNumbers, exitNumbers, feeJournal, fundingJournal, transferJournal } from './journal.ts';
import type { StoreHooks } from './store.ts';
import { BookStore, bookFile } from './store.ts';
import type { BookSources, SyncLine } from './sync.ts';
import { failedLine, fundingEvents, fundingWindow, ledgerEvents, ledgerWindow, missingFees, syncLine } from './sync.ts';
import type { BookEvent, BookRecord, EnterEvent, FeeEvent, JournalEvent, TransferEvent, TransferInput } from './types.ts';

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

export class PositionBook {
  readonly path: string;
  readonly #o: BookOptions;
  readonly #store: BookStore;
  readonly #clock: Clock;
  readonly #persist: boolean;
  #events: BookEvent[];
  #syncing: Promise<SyncReport> | null = null;
  #timer: unknown = null;
  #stopped = false;

  constructor(o: BookOptions) {
    this.#o = o;
    this.#clock = o.clock ?? systemClock;
    this.#persist = o.persist ?? true;
    this.path = o.path ?? bookFile(o.dir, o.mode, o.contractId, o.deskId);
    this.#store = new BookStore(this.path, o.hooks ?? {});
    this.#events = this.#store.load();
    const addresses = Object.fromEntries(Object.entries(o.addresses ?? {}).filter(([, a]) => a !== ''));
    const desk = [...this.#events].reverse().find((e) => e.type === 'desk');
    const same = desk !== undefined && desk.type === 'desk' && desk.mode === o.mode && desk.contract === o.contractId
      && desk.desk === o.deskId && JSON.stringify(desk.addresses) === JSON.stringify(addresses);
    if (!same && (o.addresses !== undefined || desk === undefined)) {
      this.#append([{ v: 1, type: 'desk', at: this.#clock.now(), mode: o.mode, contract: o.contractId, desk: o.deskId, addresses }]);
    }
  }

  get events(): readonly BookEvent[] {
    return this.#events;
  }

  /** The desk's address on a venue: the options', else the book's own desk line. */
  address(venue: string): string | null {
    const given = this.#o.addresses?.[venue];
    if (given !== undefined && given !== '') return given;
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const e = this.#events[i]!;
      if (e.type === 'desk' && e.addresses[venue] !== undefined) return e.addresses[venue]!;
    }
    return null;
  }

  /**
   * A carried-out enter or exit (the loop's BookSink). An exit closes the open position with its window id; with none
   * open it is kept as an exit the book never saw enter. Returns the position and the numbers for its journal entry.
   * Throws when the book could not be written (the loop logs it; the act stands).
   */
  record(record: BookRecord): { positionId: string | null; numbers: Record<string, number | string> } {
    const now = this.#clock.now();
    const positions = positionsOf(this.#events);
    let positionId: string | null;
    const added: BookEvent[] = [];
    if (record.kind === 'enter') {
      positionId = this.#newId(record.windowId, record.at, positions);
      added.push({ v: 1, type: 'enter', at: now, positionId, record: structuredClone(record), adopted: false });
    } else {
      positionId = openPosition(positions, record.windowId)?.id ?? null;
      added.push({ v: 1, type: 'exit', at: now, positionId, record: structuredClone(record) });
      if (positionId === null) this.#log(`book: exit of ${record.windowId} with no open position booked; kept apart`);
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
    const numbers = positionId === null ? {} : record.kind === 'enter' ? this.entryNumbers(positionId) : this.exitNumbers(positionId);
    return { positionId, numbers };
  }

  /** The window id of the position open now (the latest), or null. */
  openWindow(): string | null {
    return openPosition(positionsOf(this.#events))?.windowId ?? null;
  }

  /** A pair opened outside the loop (adopted from the venues): booked from `since`, with no opening fills. */
  adopt(input: AdoptInput): string {
    const now = this.#clock.now();
    const positions = positionsOf(this.#events);
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

  /** A transfer made outside the loop (rescue, the manual fund scripts), with its tx refs. Returns its id. */
  addTransfer(input: TransferInput, options: { journal?: boolean } = {}): string {
    if (!Number.isFinite(input.usd) || !Number.isFinite(input.feeUsd)) throw new Error('addTransfer: usd and feeUsd must be numbers');
    if (input.feeUsd > 0) throw new Error(`addTransfer: feeUsd is a cost, ≤ 0 (got ${input.feeUsd})`);
    const now = this.#clock.now();
    const time = input.at ?? now;
    let positionId: string | null = null;
    if (input.positionId === 'open') positionId = openPosition(positionsOf(this.#events))?.id ?? null;
    else if (input.positionId !== undefined && input.positionId !== null) {
      if (!positionsOf(this.#events).some((p) => p.id === input.positionId)) throw new Error(`addTransfer: no position ${input.positionId}`);
      positionId = input.positionId;
    }
    const same = this.#events.filter((e) => e.type === 'transfer' && e.time === time && e.source === input.source).length;
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
    const venues = [...new Set(positionsOf(this.#events).flatMap((p) => p.legs.map((l) => l.venue)))].sort();
    for (const venue of venues) {
      const source = sources.funding[venue];
      const address = this.address(venue);
      if (source === undefined || address === null) {
        lines.push({ ledger: venue, ok: false, text: `${venue}: ${source === undefined ? 'no ledger reader' : 'no desk address'}` });
        continue;
      }
      const now = this.#clock.now();
      const read = fundingWindow(this.#events, venue, now);
      if (read === null) {
        lines.push({ ledger: venue, ok: true, text: `${venue}: no position needs it` });
        continue;
      }
      try {
        const rows = await source.userFunding(address, read.from, read.to);
        const events = fundingEvents(this.#events, venue, rows, read, this.#clock.now());
        this.#append(events);
        added += events.length - 1;
        lines.push(syncLine(venue, events));
      } catch (err) {
        lines.push(failedLine(venue, err));
      }
    }
    const hlAddress = this.address('hyperliquid');
    if (sources.hlLedger !== undefined && hlAddress !== null) {
      const read = ledgerWindow(this.#events, this.#clock.now());
      if (read !== null) {
        try {
          const rows = await sources.hlLedger(hlAddress, read.from, read.to);
          const events = ledgerEvents(this.#events, rows, hlAddress, read, sources.hlTxRef ?? (() => null), this.#clock.now());
          const journals = events.filter((e): e is TransferEvent => e.type === 'transfer')
            .map((t) => transferJournal(t, this.#clock.now())).filter((j): j is JournalEvent => j !== null);
          this.#append([...events, ...journals]);
          this.#publishNew(journals);
          added += events.length - 1;
          lines.push(syncLine('hyperliquid-ledger', events));
        } catch (err) {
          lines.push(failedLine('hyperliquid-ledger', err));
        }
      }
    }
    if (sources.fillFee !== undefined) {
      for (const m of missingFees(this.#events, this.#clock.now())) {
        const address = this.address(m.venue);
        if (address === null) continue;
        const fill = m.record.legs.find((l) => l.venue === m.venue)!;
        try {
          const charged = await sources.fillFee({ venue: m.venue, address, symbol: m.symbol, side: fill.side, at: m.record.at, tx: m.record.tx });
          if (charged === null) continue;
          const now = this.#clock.now();
          const fee: FeeEvent = { v: 1, type: 'fee', at: now, positionId: m.positionId, stage: m.stage, venue: m.venue, usd: -charged || 0, source: 'venue' };
          const j = feeJournal(fee, m.symbol, now);
          this.#append([fee, j]);
          this.#publishNew([j]);
          added++;
          lines.push({ ledger: `${m.venue}-fills`, ok: true, text: `${m.venue}: ${m.stage} fee of ${m.positionId} read from the venue's fills` });
        } catch (err) {
          lines.push(failedLine(`${m.venue}-fills`, err));
        }
      }
    }
    const journals = fundingJournal(this.#events, this.#clock.now());
    this.#append(journals);
    this.#publishNew(journals);
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

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      if (this.#o.timers !== undefined) this.#o.timers.clearTimeout(this.#timer);
      else clearTimeout(this.#timer as NodeJS.Timeout);
    }
    this.#timer = null;
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
    return summarize(this.#events, this.#clock.now());
  }

  result(positionId: string): PositionResult | null {
    const all = positionsOf(this.#events);
    const p = all.find((x) => x.id === positionId);
    return p === undefined ? null : positionResult(p, this.#events, this.#clock.now(), all);
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

  #newId(windowId: string, at: number, positions: readonly { id: string }[]): string {
    const base = positionIdOf(windowId, at);
    let id = base;
    for (let n = 2; positions.some((p) => p.id === id); n++) id = `${base}.${n}`;
    return id;
  }

  #append(events: BookEvent[]): void {
    if (events.length === 0) return;
    if (this.#persist) {
      this.#store.append(events);
      this.#events = [...this.#store.events];
      try {
        this.#store.writeSummary(this.summary());
      } catch (err) {
        this.#log(`book: summary not written (${errorMessage(err)}); the JSONL holds everything`);
      }
    } else {
      this.#events = [...this.#events, ...events];
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
