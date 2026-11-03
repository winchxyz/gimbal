// What serve's start does with an error (review S1). A start must not crash-loop: with the host's restart policy a
// process that exits on a slow or failing read restarts every minute or so, and the risk engine, the ADL watch, the
// rescuer, the liquidation monitor and panic_close are all down meanwhile, while a pair may be open. So only a
// ConfigError (a bad env, a contract on another network, a desk that does not exist) may stop serve; anything else a
// start reads (NEAR RPC, Hyperliquid info, the Phoenix API, Solana RPC) is retried, with backoff capped at
// START_RETRY_MAX_MS, while the rest of serve runs.

import { errorMessage } from '../venues/recorder.ts';

/** A start error that no retry can fix: serve exits on it (the owner fixes the configuration). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The first retry of a start read that failed comes this much later; each further one twice as late, up to the cap. */
export const START_RETRY_FIRST_MS = 5_000;
export const START_RETRY_MAX_MS = 60_000;

/** The wait before retry `tries` (1 = the first retry): 5, 10, 20, 40, 60, 60 ... s. */
export function startBackoffMs(tries: number): number {
  const n = Math.max(1, Math.floor(tries));
  return Math.min(START_RETRY_MAX_MS, START_RETRY_FIRST_MS * 2 ** Math.min(n - 1, 16));
}

/**
 * `run` until it answers: a ConfigError is thrown on at once, any other error is logged and tried again after
 * startBackoffMs. For a start step nothing else can run without (the contract's desk names every account serve reads).
 */
export async function retryStart<T>(what: string, run: () => Promise<T>, o: { log: (line: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let tries = 1; ; tries++) {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      const wait = startBackoffMs(tries);
      o.log(`${what}: not read at start (try ${tries}: ${errorMessage(err)}); trying again in ${wait / 1000} s (a read that fails is retried; only a configuration error stops serve)`);
      await sleep(wait);
    }
  }
}
