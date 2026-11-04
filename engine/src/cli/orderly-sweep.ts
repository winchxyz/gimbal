// panic_close's Orderly sweep (GIMBAL_ORDERLY_PAIRS=1). After Orderly's IP restriction the owner's machine cannot post
// to Orderly, and pair-mainnet refuses Orderly: the owner's only lever on an Orderly position is the on-chain
// panic_close, read by serve. A pair trader closes its own legs; anything else held on Orderly (a pair whose trader
// state was lost or reset, a leg the start found outside its pair, a start not confirmed, a pair alert only) has no
// trader. So serve's reducer for panic_close (panicReducer) closes the pair's legs through its trader when one trades,
// then every other Orderly position the desk holds, reduce-only, through serve's Orderly session: each leg prices
// against the stored price refreshed first (oraclePxOf with trading on), and its orders are split under the policy cap
// less the price band as the trader splits them. Which markets the pair trader holds (`covered`) is asked anew on each
// sweep and each watch round.
//
// A position whose reduce-only order filled nothing (a rejected order, an IOC with an empty book, a market Orderly
// dropped) is not tried again until the desk's `closing` ends (unpause, then panic_close again to retry): nothing signs
// over and over on a market that does not take it.
//
// The replay watch: a signed Orderly order can be sent again by anyone for 300 s, a copy of the open's IOC included.
// Each sweep watches from its own start for REPLAY_WINDOW_MS (never from the orders it sends): every SWEEP_POLL_MS it
// reads the desk's Orderly positions, and one that comes back (held now, flat or absent at the last look) is closed
// and journaled, at most SWEEP_MAX_WATCH_ROUNDS times. It stops at the end of its window, on stop(), on endWatch()
// (the strategy loop opens), and once `closing` reads false. A sweep and a watch round run one at a time.
//
// With no session, the sweep closes nothing: it says so in its result when the saved trader state holds an Orderly
// leg (panic_close journals it as an error and tries again every 60 s), and "nothing on Orderly to close" when not.
// A rescue's reduce never uses the sweep (Reducer.panicOnly while no pair trader holds the legs).

import type { StreamEvent, TxRef } from '@gimbal/shared';
import type { Reducer, ReduceResult } from '../rescue/rescuer.ts';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { wasSigned } from '../trade/legs.ts';
import { abs, floorToLot, qtyString, signedQtyString } from '../trade/lots.ts';
import type { LegReport } from '../trade/pair.ts';
import { REPLAY_WINDOW_MS, records } from '../trade/pair.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { AccountState, Clock } from '../venues/venue.ts';
import type { OrderlyLegSpec } from './pair-ops.ts';

/** How often the desk's Orderly positions are read while a sweep's window is open. */
export const SWEEP_POLL_MS = 15_000;
/** Reduce-only orders one position's close may send (each under the policy cap). */
export const SWEEP_MAX_ORDERS = 8;
/** Watch rounds that close a position that came back, per panic_close; the watch stops after them. */
export const SWEEP_MAX_WATCH_ROUNDS = 3;

export interface OrderlySweepInput {
  /** serve's Orderly session; undefined: serve has none, and nothing on Orderly is read or closed here. */
  session: { leg(spec: OrderlyLegSpec): TradeLeg | null; account(): Promise<AccountState> } | undefined;
  /** With no session: whether the saved trader state holds an Orderly leg that may be open (unknown counts as yes). */
  heldKnown(): boolean;
  /** The Orderly markets (PERP_X_USDC) the live pair trader holds and closes itself, now. */
  covered(): readonly string[];
  /** The desk's `closing` (get_desk) now; null: unknown (the watch goes on). */
  closing(): Promise<boolean | null>;
  /** The leg spec of an Orderly market, its stored price refreshed first; null: not one the desk can price. */
  spec(symbol: string): OrderlyLegSpec | null;
  /** Before anything is signed: the trader lock and the signing client; why not, or null. */
  begin(): Promise<string | null>;
  /** After the sweep or a watch round that began (the lock goes back when begin took it and nothing else owns it). */
  end(): void;
  /** The policy's price band (bps): each reduce-only order fits the cap at any price inside it. */
  bandBps: number;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  publish: (event: StreamEvent) => void;
  windowMs?: number;
  pollMs?: number;
}

/** What one sweep did: `closed` when every Orderly position it is to close is flat (or there was none). */
export interface SweepResult {
  closed: boolean;
  legs: LegReport[];
  notes: string[];
  tx: TxRef[];
}

type Session = NonNullable<OrderlySweepInput['session']>;

export class OrderlySweep {
  readonly #o: OrderlySweepInput;
  #queue: Promise<unknown> = Promise.resolve();
  /** The watch reads the positions until then (local ms); null: no window open. */
  #until: number | null = null;
  #watching: Promise<void> | null = null;
  #ended = false;
  #seq = 0;
  #rounds = 0;
  /** Markets whose last reduce-only order filled nothing: not tried again until `closing` ends. */
  readonly #gaveUp = new Map<string, string>();
  /** Markets held (and not covered) at the last look: the watch acts only on one that was not. */
  #held = new Set<string>();

  constructor(input: OrderlySweepInput) {
    this.#o = input;
  }

  /** The watch in flight (tests wait on it). */
  get watch(): Promise<void> | null {
    return this.#watching;
  }

  /** Every Orderly position the pair trader does not hold, closed reduce-only (after any watch round in flight). */
  sweep(reason: string): Promise<SweepResult> {
    return this.#serial(async () => {
      const start = this.#o.clock.now();
      const session = this.#o.session;
      if (session === undefined) {
        if (!this.#o.heldKnown()) {
          return { closed: true, legs: [], tx: [], notes: ['nothing on Orderly to close: serve has no Orderly session, and the trader state holds no Orderly leg'] };
        }
        return {
          closed: false, legs: [], tx: [],
          notes: ['serve has no Orderly session (GIMBAL_ORDERLY_PAIRS=1), and the trader state holds an Orderly leg: the desk\'s Orderly positions are neither read nor closed here, and pair-mainnet cannot close them; start serve with its Orderly session'],
        };
      }
      const why = await this.#o.begin();
      if (why !== null) return { closed: false, legs: [], tx: [], notes: [`the desk's Orderly positions are not closed: ${why}`] };
      try {
        return await this.#closeAll(session, reason, null);
      } finally {
        this.#o.end();
        this.#arm(start);
      }
    });
  }

  /** Ends the watch now (the strategy loop opens: the desk is not closing). */
  endWatch(): void {
    this.#until = null;
  }

  /** Ends the watch for good (serve's stop). */
  stop(): void {
    this.#ended = true;
    this.#until = null;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The positions held and not covered; `only`: close just those markets (a watch round), else all of them. */
  async #closeAll(session: Session, reason: string, only: readonly string[] | null): Promise<SweepResult> {
    const out: SweepResult = { closed: true, legs: [], notes: [], tx: [] };
    let account: AccountState;
    try {
      account = await session.account();
    } catch (err) {
      return { closed: false, legs: [], tx: [], notes: [`the desk's Orderly account cannot be read: ${errorMessage(err)}; nothing on Orderly was closed`] };
    }
    const covered = this.#o.covered();
    const held = [...new Set(account.positions.filter((p) => p.size !== 0 && !covered.includes(p.symbol)).map((p) => p.symbol))];
    if (only === null) this.#held = new Set(held);
    else for (const s of held) this.#held.add(s);
    for (const symbol of held) {
      if (only !== null && !only.includes(symbol)) continue;
      const gave = this.#gaveUp.get(symbol);
      if (gave !== undefined) {
        out.closed = false;
        out.notes.push(`Orderly ${symbol}: not tried again while the desk is closing (${gave}); unpause, then panic_close again to retry`);
        continue;
      }
      const spec = this.#o.spec(symbol);
      if (spec === null) {
        out.closed = false;
        out.notes.push(`Orderly ${symbol}: not a market the desk can price, so it is not closed here`);
        continue;
      }
      const leg = session.leg(spec);
      if (leg === null) {
        out.closed = false;
        out.notes.push(`Orderly ${symbol}: serve's Orderly session is not up, so it is not closed`);
        continue;
      }
      const one = await this.#closeOne(leg, reason);
      out.legs.push(one.report);
      out.tx.push(...one.report.orders.flatMap((o) => o.ref.tx));
      out.notes.push(...one.notes);
      if (one.flat) this.#held.delete(symbol);
      else out.closed = false;
    }
    return out;
  }

  /**
   * One position to 0 with reduce-only IOCs, each under the cap less the band, read back from the venue after each.
   * An order that left the position where it was (rejected, or filled nothing) gives the market up until `closing` ends.
   */
  async #closeOne(leg: TradeLeg, reason: string): Promise<{ report: LegReport; notes: string[]; flat: boolean }> {
    const report: LegReport = { venue: leg.venue, symbol: leg.symbol, start: 'unknown', target: '0', final: null, orders: [] };
    const notes: string[] = [];
    let pos: bigint | null;
    try {
      pos = await leg.position();
    } catch (err) {
      notes.push(`Orderly ${leg.symbol}: the position cannot be read (${errorMessage(err)}), so nothing was sent`);
      return { report, notes, flat: false };
    }
    report.start = signedQtyString(pos);
    for (let n = 0; n < SWEEP_MAX_ORDERS && pos !== null && pos !== 0n; n++) {
      const before: bigint = pos;
      const side: LegSide = before > 0n ? 'SELL' : 'BUY';
      const size = await this.#chunk(leg, side, abs(before));
      const o: LegOutcome = await leg.order(side, size, true, reason);
      report.orders.push(...records(o, 'close'));
      const said = `${side} ${qtyString(size)} reduce-only: ${o.kind}${o.kind === 'filled' ? ` ${qtyString(o.filled)}` : ` (${o.error.message})`}`;
      this.#o.log(`pair      panic_close sweep: Orderly ${leg.symbol} ${said}`);
      if (o.kind === 'failed' && !wasSigned(o)) {
        notes.push(`Orderly ${leg.symbol}: the reduce-only ${side} ${qtyString(size)} was refused before signing: ${o.error.message}`);
        break;
      }
      try {
        pos = await leg.position(o.ref.settledAt ?? o.ref.sentAt);
      } catch (err) {
        notes.push(`Orderly ${leg.symbol}: the position cannot be read after the close (${errorMessage(err)})`);
        pos = null;
        break;
      }
      if (abs(pos) >= abs(before)) {
        this.#gaveUp.set(leg.symbol, `its reduce-only ${said} left it at ${signedQtyString(pos)}`);
        notes.push(`Orderly ${leg.symbol}: the reduce-only ${said} left it at ${signedQtyString(pos)}; not tried again while the desk is closing`);
        break;
      }
    }
    report.final = pos === null ? null : signedQtyString(pos);
    if (pos !== null && pos !== 0n) notes.push(`Orderly ${leg.symbol} still holds ${signedQtyString(pos)} after the sweep`);
    return { report, notes, flat: pos === 0n };
  }

  /** As the pair trader sizes a reduce-only order (PairTrader #chunk): all of it, or the cap less the band, floored to the lot. */
  async #chunk(leg: TradeLeg, side: LegSide, want: bigint): Promise<bigint> {
    let cap: bigint;
    try {
      cap = abs(await leg.maxSize(side, true));
    } catch {
      return want;
    }
    const band = BigInt(Math.ceil(this.#o.bandBps));
    const max = floorToLot((cap * 10_000n) / (10_000n + band), leg.lot);
    const most = max > 0n ? max : leg.lot;
    return want > most ? most : want;
  }

  /** Opens (or extends) the watch's window: REPLAY_WINDOW_MS from a sweep's start. */
  #arm(start: number): void {
    if (this.#ended) return;
    const until = start + (this.#o.windowMs ?? REPLAY_WINDOW_MS);
    this.#until = Math.max(this.#until ?? 0, until);
    if (this.#watching !== null) return;
    this.#watching = this.#watch().catch((err: unknown) => this.#o.log(`pair      panic_close sweep watch: ${errorMessage(err)}`)).finally(() => {
      this.#watching = null;
    });
  }

  async #watch(): Promise<void> {
    for (;;) {
      await this.#o.sleep(this.#o.pollMs ?? SWEEP_POLL_MS);
      if (this.#ended || this.#until === null) return;
      const closing = await this.#o.closing().catch(() => null);
      if (closing === false) {
        // Unpaused: this panic_close is over. A later one tries every market again.
        this.#until = null;
        this.#gaveUp.clear();
        this.#rounds = 0;
        this.#o.log('pair      panic_close sweep watch: the desk is not closing any more; the watch stops');
        return;
      }
      await this.#serial(() => this.#round());
      if (this.#until === null || this.#o.clock.now() > this.#until) {
        this.#until = null;
        return;
      }
    }
  }

  /** One watch read: a market held now that was not at the last look came back, and is closed (once in its turn). */
  async #round(): Promise<void> {
    if (this.#ended || this.#until === null) return;
    const session = this.#o.session!;
    let account: AccountState;
    try {
      account = await session.account();
    } catch (err) {
      this.#o.log(`pair      panic_close sweep watch: the Orderly account cannot be read (${errorMessage(err)})`);
      return;
    }
    const covered = this.#o.covered();
    const now = account.positions.filter((p) => p.size !== 0 && !covered.includes(p.symbol));
    const nowHeld = new Set(now.map((p) => p.symbol));
    const back = now.filter((p) => !this.#held.has(p.symbol) && !this.#gaveUp.has(p.symbol));
    this.#held = new Set([...this.#held].filter((s) => nowHeld.has(s)));
    if (back.length === 0) return;
    const names = back.map((p) => `${p.symbol} ${p.size}`).join(', ');
    if (this.#rounds >= SWEEP_MAX_WATCH_ROUNDS) {
      this.#until = null;
      this.#journal(`panic_close: Orderly ${names} came back after the sweep again, after ${SWEEP_MAX_WATCH_ROUNDS} closes: the watch stops; panic_close's own retry still sweeps every 60 s`, []);
      return;
    }
    this.#rounds++;
    const why = await this.#o.begin();
    if (why !== null) {
      for (const p of back) this.#held.add(p.symbol);
      this.#journal(`panic_close: Orderly ${names} came back after the sweep (a replayed order?), and is not closed: ${why}`, []);
      return;
    }
    try {
      const r = await this.#closeAll(session, 'panic_close: close an Orderly position that came back after the sweep', back.map((p) => p.symbol));
      const legs = r.legs.map((l) => `${l.symbol} ${l.start} -> ${l.final ?? '?'}`).join(', ') || names;
      this.#journal(`panic_close: Orderly ${legs} came back after the sweep (a replayed order?): ${r.closed ? 'closed reduce-only' : `NOT closed: ${r.notes.join('; ')}`}`, r.tx);
    } finally {
      this.#o.end();
    }
  }

  #journal(summary: string, tx: TxRef[]): void {
    const t = this.#o.clock.now();
    this.#o.publish({ type: 'journal', data: { id: `orderly-sweep-${t.toString(36)}-${++this.#seq}`, t, kind: 'error', summary, numbers: { venue: 'orderly' }, tx: [...tx] } });
    this.#o.log(`pair      ${summary}`);
  }
}

/**
 * panic_close's reducer while GIMBAL_ORDERLY_PAIRS=1 (see the header): the pair trader's close of its own legs when one
 * trades (`pair`), then the sweep of every other Orderly position. Any other close (a rescue's reduce, an ADL unwind)
 * is the pair's alone; with no pair, panicOnly keeps the rescuer from planning one. With no pair, `outside` says what
 * this engine leaves on the other venues (null: nothing held there): the close is not done while it says anything.
 */
export function panicReducer(pair: Reducer | null, sweep: OrderlySweep, outside: () => Promise<string | null> = async () => null): Reducer {
  return {
    legs: pair?.legs ?? [],
    lot: pair?.lot ?? 0n,
    ...(pair === null ? { panicOnly: 'no pair trader holds the legs here (panic_close alone closes the desk\'s Orderly positions, through serve\'s Orderly session)' } : {}),
    close: async (request): Promise<ReduceResult> => {
      if (request.by !== 'panic_close') {
        if (pair === null) throw new Error('no pair trader holds the legs here: nothing was closed');
        return pair.close(request);
      }
      let first: ReduceResult | null = null;
      let failed: unknown = null;
      if (pair !== null) {
        try {
          first = await pair.close(request);
        } catch (err) {
          failed = err;
        }
      }
      const swept = await sweep.sweep(request.reason);
      if (pair === null) {
        const left = await outside();
        if (left !== null) {
          swept.closed = false;
          swept.notes.push(left);
        }
      }
      if (failed !== null) {
        throw new Error(`${errorMessage(failed)}; the Orderly sweep ${swept.closed ? 'closed every other Orderly position' : `did not end flat: ${swept.notes.join('; ')}`}`);
      }
      const done = (s: ReduceResult['status']) => s === 'closed' || s === 'flat';
      const status: ReduceResult['status'] = first !== null && !done(first.status) ? first.status : swept.closed ? (first?.status ?? 'closed') : 'stuck';
      return {
        status,
        size: first?.size ?? '0',
        legs: [...(first?.legs ?? []), ...swept.legs],
        notes: [...(first?.notes ?? []), ...swept.notes],
        tx: [...(first?.tx ?? []), ...swept.tx],
        feeUsd: (first?.feeUsd ?? 0) + swept.legs.flatMap((l) => l.orders).reduce((a, o) => a + (o.fee ?? 0), 0),
        feeUnknown: (first?.feeUnknown ?? 0) + swept.legs.flatMap((l) => l.orders).filter((o) => o.outcome === 'filled' && o.fee === null).length,
      };
    },
  };
}
