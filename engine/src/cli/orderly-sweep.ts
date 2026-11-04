// panic_close's Orderly sweep (GIMBAL_ORDERLY_PAIRS=1). After Orderly's IP restriction the owner's machine cannot post
// to Orderly, and pair-mainnet refuses Orderly: the owner's only lever on an Orderly position is the on-chain
// panic_close, read by serve. A pair trader closes its own legs; anything else held on Orderly (a pair whose trader
// state was lost or reset, a leg the start found outside its pair, a start not confirmed, a pair alert only) has no
// trader. So serve's reducer for panic_close (panicReducer) closes the pair's legs through its trader when one trades,
// then every other Orderly position the desk holds, reduce-only, through serve's Orderly session: each leg prices
// against the stored price refreshed first (oraclePxOf with trading on), and its orders are split under the policy cap
// less the price band as the trader splits them. A signed Orderly order can be sent again by anyone for 300 s, a copy
// of the open's IOC included: after a sweep the desk's Orderly positions are read every SWEEP_POLL_MS until
// REPLAY_WINDOW_MS after its last order, and any that comes back is closed again and journaled. With no session, the
// sweep closes nothing and says so in the result (panic_close journals it as an error and tries again every 60 s).
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

/** How often the desk's Orderly positions are read while a sweep's orders can still be replayed. */
export const SWEEP_POLL_MS = 15_000;
/** Reduce-only orders one position's close may send (each under the policy cap). */
export const SWEEP_MAX_ORDERS = 8;

export interface OrderlySweepInput {
  /** serve's Orderly session; undefined: serve has none, and nothing on Orderly is read or closed here. */
  session: { leg(spec: OrderlyLegSpec): TradeLeg | null; account(): Promise<AccountState> } | undefined;
  /** The leg spec of an Orderly market (PERP_X_USDC), its stored price refreshed first; null: not one the desk can price. */
  spec(symbol: string): OrderlyLegSpec | null;
  /** Before anything is signed: the trader lock and the signing client; why not, or null. */
  begin(): Promise<string | null>;
  /** After the sweep or a watch round (the lock goes back when begin took it and no pair trades). */
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

/** What one sweep did: `closed` when every Orderly position it found is flat (or there was none). */
export interface SweepResult {
  closed: boolean;
  legs: LegReport[];
  notes: string[];
  tx: TxRef[];
}

export class OrderlySweep {
  readonly #o: OrderlySweepInput;
  /** The watch: reads the positions until then (local ms); null when none runs. */
  #until: number | null = null;
  #watching: Promise<void> | null = null;
  #ended = false;
  #seq = 0;
  /** The symbols the last sweep left to the pair trader (its own legs): the watch leaves them to it too. */
  #covered: readonly string[] = [];

  constructor(input: OrderlySweepInput) {
    this.#o = input;
  }

  /** The watch in flight (tests wait on it). */
  get watch(): Promise<void> | null {
    return this.#watching;
  }

  /** Every Orderly position not in `covered` (markets a pair trader closes itself), closed reduce-only. */
  async sweep(covered: readonly string[], reason: string): Promise<SweepResult> {
    const session = this.#o.session;
    if (session === undefined) {
      return {
        closed: false, legs: [], tx: [],
        notes: ['serve has no Orderly session (GIMBAL_ORDERLY_PAIRS=1): the desk\'s Orderly positions are neither read nor closed here, and pair-mainnet cannot close them; start serve with its Orderly session'],
      };
    }
    const why = await this.#o.begin();
    if (why !== null) return { closed: false, legs: [], tx: [], notes: [`the desk's Orderly positions are not closed: ${why}`] };
    this.#covered = covered;
    try {
      const out = await this.#closeAll(session, covered, reason);
      // Anything signed can come back for 300 s, and an earlier open's IOC may still be replayed: watched from now.
      this.#arm(this.#o.clock.now());
      return out;
    } finally {
      this.#o.end();
    }
  }

  /** Ends the watch (serve's stop). */
  stop(): void {
    this.#ended = true;
  }

  async #closeAll(session: NonNullable<OrderlySweepInput['session']>, covered: readonly string[], reason: string): Promise<SweepResult> {
    const out: SweepResult = { closed: true, legs: [], notes: [], tx: [] };
    let account: AccountState;
    try {
      account = await session.account();
    } catch (err) {
      return { closed: false, legs: [], tx: [], notes: [`the desk's Orderly account cannot be read: ${errorMessage(err)}; nothing on Orderly was closed`] };
    }
    const held = [...new Set(account.positions.filter((p) => p.size !== 0 && !covered.includes(p.symbol)).map((p) => p.symbol))];
    for (const symbol of held) {
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
      if (!one.flat) out.closed = false;
      if (one.signedAt !== null) this.#arm(one.signedAt);
    }
    return out;
  }

  /** One position to 0 with reduce-only IOCs, each under the cap less the band, read back from the venue after each. */
  async #closeOne(leg: TradeLeg, reason: string): Promise<{ report: LegReport; notes: string[]; flat: boolean; signedAt: number | null }> {
    const report: LegReport = { venue: leg.venue, symbol: leg.symbol, start: 'unknown', target: '0', final: null, orders: [] };
    const notes: string[] = [];
    let signedAt: number | null = null;
    let pos: bigint | null;
    try {
      pos = await leg.position();
    } catch (err) {
      notes.push(`Orderly ${leg.symbol}: the position cannot be read (${errorMessage(err)}), so nothing was sent`);
      return { report, notes, flat: false, signedAt };
    }
    report.start = signedQtyString(pos);
    for (let n = 0; n < SWEEP_MAX_ORDERS && pos !== null && pos !== 0n; n++) {
      const side: LegSide = pos > 0n ? 'SELL' : 'BUY';
      const size = await this.#chunk(leg, side, abs(pos));
      const o: LegOutcome = await leg.order(side, size, true, reason);
      report.orders.push(...records(o, 'close'));
      if (wasSigned(o)) signedAt = Math.max(signedAt ?? 0, o.ref.sentAt);
      this.#o.log(`pair      panic_close sweep: Orderly ${leg.symbol} ${side} ${qtyString(size)} reduce-only: ${o.kind}${o.kind === 'filled' ? ` ${qtyString(o.filled)}` : ` (${o.error.message})`}`);
      if (o.kind === 'failed') {
        notes.push(`Orderly ${leg.symbol}: the reduce-only ${side} ${qtyString(size)} failed: ${o.error.message}`);
        break;
      }
      try {
        pos = await leg.position(o.ref.settledAt ?? o.ref.sentAt);
      } catch (err) {
        notes.push(`Orderly ${leg.symbol}: the position cannot be read after the close (${errorMessage(err)})`);
        pos = null;
      }
    }
    report.final = pos === null ? null : signedQtyString(pos);
    if (pos !== null && pos !== 0n) notes.push(`Orderly ${leg.symbol} still holds ${signedQtyString(pos)} after the sweep`);
    return { report, notes, flat: pos === 0n, signedAt };
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

  #arm(from: number): void {
    const until = from + (this.#o.windowMs ?? REPLAY_WINDOW_MS);
    this.#until = Math.max(this.#until ?? 0, until);
    if (this.#watching !== null || this.#ended) return;
    this.#watching = this.#watch().catch((err: unknown) => this.#o.log(`pair      panic_close sweep watch: ${errorMessage(err)}`)).finally(() => {
      this.#watching = null;
    });
  }

  async #watch(): Promise<void> {
    const session = this.#o.session!;
    for (;;) {
      await this.#o.sleep(this.#o.pollMs ?? SWEEP_POLL_MS);
      if (this.#ended || this.#until === null) return;
      let account: AccountState;
      try {
        account = await session.account();
      } catch (err) {
        this.#o.log(`pair      panic_close sweep watch: the Orderly account cannot be read (${errorMessage(err)})`);
        if (this.#o.clock.now() > this.#until) return;
        continue;
      }
      const back = account.positions.filter((p) => p.size !== 0 && !this.#covered.includes(p.symbol));
      if (back.length > 0) {
        const why = await this.#o.begin();
        if (why !== null) {
          this.#journal(`panic_close: Orderly ${back.map((p) => `${p.symbol} ${p.size}`).join(', ')} came back after the sweep (a replayed order?), and is not closed: ${why}`, []);
        } else {
          try {
            const r = await this.#closeAll(session, this.#covered, 'panic_close: close an Orderly position that came back after the sweep');
            const legs = r.legs.map((l) => `${l.symbol} ${l.start} -> ${l.final ?? '?'}`).join(', ');
            this.#journal(`panic_close: Orderly ${legs} came back after the sweep (a replayed order?): ${r.closed ? 'closed reduce-only' : `NOT closed: ${r.notes.join('; ')}`}`, r.tx);
          } finally {
            this.#o.end();
          }
        }
      }
      if (this.#o.clock.now() > this.#until) {
        this.#until = null;
        return;
      }
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
  const covered = (pair?.legs ?? []).filter((l) => l.venue === 'orderly').map((l) => l.symbol);
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
      const swept = await sweep.sweep(covered, request.reason);
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
