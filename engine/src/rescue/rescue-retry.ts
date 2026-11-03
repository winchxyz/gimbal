// Review S1, the rescue part: a live rescuer whose start read fails (NEAR RPC, the desk, Phoenix, Solana) is not left
// detect only until a restart. Rescue is the main protection while a pair is open, so serve runs the detect-only
// rescue meanwhile (each trigger is published at `detect` and the owner acts) and tries the live start again in the
// background with the start backoff (start-errors.ts: 5, 10, 20, 40, then 60 s). Once it starts, the live rescuer
// takes the next trigger. The fallback and the recovery are journaled; a retry that fails again is logged, and
// journaled only when its reason changes. A configuration error is never retried: at the first try it stops serve
// (thrown), on a retry it ends the retries (journaled; the owner fixes it and restarts serve).
// One ClosingWatch (panic_close) serves the whole run: the live start is handed the fallback's, so a panic_close in
// flight is never left behind by the swap.

import { ConfigError, START_RETRY_MAX_MS, startBackoffMs } from '../cli/start-errors.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { ClosingWatch } from './closing.ts';
import type { ServeRescue } from './serve-rescue.ts';

export interface RescueTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export interface RetryingRescueOptions {
  /** serveRescue as configured (GIMBAL_RESCUE=1 on mainnet); `closing` is the watch to keep, once there is one. */
  live: (closing: ClosingWatch | undefined) => Promise<ServeRescue>;
  /** serveRescue without GIMBAL_RESCUE: detect only, nothing signed. */
  detectOnly: () => Promise<ServeRescue>;
  log: (line: string) => void;
  /** A journal entry: `error` for the fallback and a retry's new reason, `wait` for the recovery. */
  journal: (kind: 'error' | 'wait', summary: string) => void;
  /** Tests drive the retries; serve uses unref'ed timers. */
  timers?: RescueTimers;
}

export interface RetryingRescue extends ServeRescue {
  /** The risk engine's rescuer: false when the trigger was not taken (detect only now: the engine publishes it). */
  rescuer: (trigger: RescueTrigger) => boolean;
  /** Whether a live rescuer takes the triggers now (off mainnet: the recorded one). */
  live(): boolean;
  /** Why the live rescuer is not running yet; null when it runs or a retry is not pending. */
  pending(): string | null;
  /** One retry now (tests; the timer calls it too). True when the live rescuer runs after it. */
  retry(): Promise<boolean>;
}

const defaultTimers: RescueTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

/** The kind of a failure: its words without the numbers (a slot or a status code changes every try). */
const kindOf = (s: string) => s.replace(/\d+/g, '#');

export async function retryingRescue(o: RetryingRescueOptions): Promise<RetryingRescue> {
  const timers = o.timers ?? defaultTimers;
  let current: ServeRescue;
  let pending: string | null = null;
  let tries = 0;
  let lastKind: string | null = null;
  let timer: unknown = null;
  let stopped = false;
  let attempt: Promise<boolean> | null = null;

  try {
    current = await o.live(undefined);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    current = await o.detectOnly();
    pending = errorMessage(err);
    lastKind = kindOf(pending);
    tries = 1;
    const wait = startBackoffMs(tries);
    const summary = `rescue: the live rescuer did not start (${pending}): detect only for now, each trigger is journaled and the owner acts; `
      + `the live start is tried again in ${wait / 1000} s, then with backoff up to ${START_RETRY_MAX_MS / 1000} s`;
    o.log(summary);
    o.journal('error', summary);
    schedule(wait);
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void retry();
    }, ms);
  }

  function retry(): Promise<boolean> {
    if (pending === null || stopped) return Promise.resolve(pending === null && !stopped);
    if (attempt !== null) return attempt;
    attempt = (async () => {
      try {
        const next = await o.live(current.closing);
        if (stopped) {
          await next.stop();
          return false;
        }
        const old = current;
        current = next;
        const failed = tries;
        pending = null;
        await old.stop();
        const summary = `rescue: the live rescuer started after ${failed} failed attempt(s); it takes the next trigger (${next.summary})`;
        o.log(summary);
        for (const line of next.routes) o.log(line);
        o.journal('wait', summary);
        return true;
      } catch (err) {
        const why = errorMessage(err);
        if (err instanceof ConfigError) {
          pending = `${why} (a configuration error: fix it and restart serve; not tried again)`;
          const summary = `rescue: the live rescuer is refused (${why}): detect only until serve restarts with the configuration fixed`;
          o.log(summary);
          o.journal('error', summary);
          stopped = true;
          return false;
        }
        tries++;
        pending = why;
        const wait = startBackoffMs(tries);
        const line = `rescue: the live rescuer did not start (try ${tries}: ${why}); detect only, tried again in ${wait / 1000} s`;
        o.log(line);
        if (kindOf(why) !== lastKind) {
          lastKind = kindOf(why);
          o.journal('error', line);
        }
        schedule(wait);
        return false;
      } finally {
        attempt = null;
      }
    })();
    return attempt;
  }

  return {
    rescuer: (trigger) => {
      const take = current.rescuer;
      if (take === undefined) return false;
      take(trigger);
      return true;
    },
    get closing() {
      return current.closing;
    },
    get summary() {
      return pending === null ? current.summary : `${current.summary}; the live rescuer did not start (${pending}): tried again in the background`;
    },
    get routes() {
      return current.routes;
    },
    running: () => current.running(),
    stop: async () => {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      await current.stop();
    },
    live: () => current.rescuer !== undefined,
    pending: () => pending,
    retry,
  };
}
