// panic_close on the engine's side (interfaces: "The engine, on reading `closing`, cancels resting orders and closes
// every leg reduce-only"). The owner's panic_close pauses the desk and sets `closing: true` in get_desk; the paused
// desk lets exactly cancels and reduce-only orders through. On the first read of `closing: true` this cancels the
// resting orders on both legs, then closes both legs reduce-only with the pair trader (engine/src/trade), and journals
// both. A close that did not end flat is tried again every CLOSE_RETRY_MS while `closing` stays true. While closing,
// `blocked()` names why: the rescuer starts no rescue and the pair trader sends no open (its openBlocked option).
// set_paused(false) clears `closing`, and the watch is ready for the next panic_close.

import type { StreamEvent, TxRef } from '@gimbal/shared';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { Reducer } from './rescuer.ts';

export const CLOSE_RETRY_MS = 60_000;

export interface ClosingWatchOptions {
  publish: (event: StreamEvent) => void;
  clock: Clock;
  /** Cancels every resting order on both legs' venues; what it cancelled and the transactions. */
  cancelResting?: () => Promise<{ cancelled: number; tx: TxRef[]; notes: string[] }>;
  /** The pair trader holding both legs; null: none here (nothing is traded, the owner is told). */
  reducer: () => Reducer | null;
  log?: (line: string) => void;
  retryMs?: number;
}

export class ClosingWatch {
  readonly #o: ClosingWatchOptions;
  #closing = false;
  #done = false;
  #lastTry: number | null = null;
  /** Bumped by every unpause: a close still in flight from before it must not mark the next panic_close done. */
  #gen = 0;
  #seq = 0;
  /** The close in flight (tests wait on it). */
  current: Promise<void> | null = null;

  constructor(options: ClosingWatchOptions) {
    this.#o = options;
  }

  /** Why nothing may open or be rescued now, or null. */
  blocked(): string | null {
    return this.#closing ? 'the desk is closing (panic_close): both legs are being closed reduce-only' : null;
  }

  /** Every read of get_desk: whether it says `closing`. */
  observe(closing: boolean): void {
    if (!closing) {
      if (this.#closing) {
        this.#log('closing cleared (set_paused false): opens and rescues may run again');
        this.#gen++;
      }
      this.#closing = false;
      this.#done = false;
      this.#lastTry = null;
      return;
    }
    this.#closing = true;
    if (this.#done) return;
    // A close in flight from before an unpause: this panic_close's close starts once it ends (the next read).
    if (this.current !== null) return;
    const now = this.#o.clock.now();
    const fresh = this.#announced !== this.#gen;
    if (!fresh && this.#lastTry !== null && now - this.#lastTry < (this.#o.retryMs ?? CLOSE_RETRY_MS)) return;
    this.#lastTry = now;
    const gen = this.#gen;
    this.current = this.#close(fresh, gen).finally(() => {
      this.current = null;
    });
  }

  /** The panic_close (#gen) whose close was announced in the journal. */
  #announced = -1;

  async #close(first: boolean, gen: number): Promise<void> {
    // Whatever this close finds, it counts only for the panic_close it was started for.
    const current = () => gen === this.#gen;
    const done = () => {
      if (current()) this.#done = true;
    };
    this.#announced = gen;
    if (first) this.#journal('exit', 'panic_close read from get_desk: cancelling resting orders, then closing both legs reduce-only; no rescue or open starts', {});
    const reducer = this.#o.reducer();
    if (reducer === null) {
      done();
      this.#journal('error', 'panic_close: no pair trader holds the legs here, so nothing was cancelled or closed; close them from the venues', {});
      return;
    }
    if (this.#o.cancelResting !== undefined) {
      try {
        const c = await this.#o.cancelResting();
        this.#journal('exit', `panic_close: cancelled ${c.cancelled} resting order${c.cancelled === 1 ? '' : 's'}${c.notes.length === 0 ? '' : ` (${c.notes.join('; ')})`}`, { cancelled: c.cancelled }, c.tx);
      } catch (err) {
        // A resting order left would only reduce (the paused desk takes nothing else); the close still runs.
        this.#journal('error', `panic_close: cancelling resting orders failed: ${errorMessage(err)}; closing the legs anyway`, {});
      }
    }
    try {
      const r = await reducer.close({ reason: 'panic_close: the owner closed the desk', reduceOnly: true });
      const legs = r.legs.map((l) => `${l.venue} ${l.symbol} ${l.start} -> ${l.final ?? '?'}`).join(', ');
      if (r.status === 'closed' || r.status === 'flat') {
        done();
        this.#journal('exit', `panic_close: both legs closed reduce-only (${legs})`, {}, r.tx);
      } else {
        this.#journal('error', `panic_close: the reduce-only close ended ${r.status} (${legs}): ${r.notes.join('; ') || 'no notes'}; tried again in ${Math.round((this.#o.retryMs ?? CLOSE_RETRY_MS) / 1000)} s`, {}, r.tx);
      }
    } catch (err) {
      this.#journal('error', `panic_close: the reduce-only close failed: ${errorMessage(err)}; tried again in ${Math.round((this.#o.retryMs ?? CLOSE_RETRY_MS) / 1000)} s`, {});
    }
  }

  #journal(kind: 'exit' | 'error', summary: string, numbers: Record<string, number | string>, tx: TxRef[] = []): void {
    const t = this.#o.clock.now();
    this.#o.publish({ type: 'journal', data: { id: `closing-${t.toString(36)}-${++this.#seq}`, t, kind, summary, numbers, tx: [...tx] } });
    this.#log(summary);
  }

  #log(line: string): void {
    this.#o.log?.(line);
  }
}
