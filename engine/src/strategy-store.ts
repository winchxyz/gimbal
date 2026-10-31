// The confirmed engine rules (StrategyConfig, PUT /strategy) on disk, so a restart keeps what the owner confirmed.
// One JSON file per mode and desk: rules confirmed in replay or on testnet never reach a mainnet desk, nor one desk's
// another's. A save writes a temporary file and renames it over the old one, so a crash mid-write leaves the last
// good file. A file that does not parse, or no longer passes the checks (the owner lowered the policy's cap since),
// is not used: the engine starts from DEFAULT_STRATEGY (auto off) and says why; the next PUT replaces it.

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContractPolicy, Mode, StrategyConfig } from '@gimbal/shared';
import { parseStrategyConfig } from './scanner/config.ts';
import { errorMessage } from './venues/recorder.ts';

/** Desk ids are [a-z0-9-]{1,32} (docs/interfaces.md §1.5), so one is safe in a file name. */
const DESK_ID = /^[a-z0-9-]{1,32}$/;

/** The file that keeps `mode`'s rules for `deskId` (none: the rules of a run without a desk). */
export function strategyFile(dir: string, mode: Mode, deskId: string | null): string {
  if (deskId !== null && !DESK_ID.test(deskId)) throw new Error(`desk id ${JSON.stringify(deskId)} is not [a-z0-9-]{1,32}`);
  return join(dir, `strategy-${mode}${deskId === null ? '' : `-${deskId}`}.json`);
}

export class StrategyStore {
  readonly path: string;
  /** Saves run one after another: two PUTs never race on the temporary file. */
  #saving: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /**
   * The saved rules, checked against `policy` as PUT /strategy checks them; `strategy` null when there is no file
   * yet, and also when the file is unusable, then with `problem` saying why.
   */
  load(policy: ContractPolicy | null): { strategy: StrategyConfig | null; problem: string | null } {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { strategy: null, problem: null };
      return { strategy: null, problem: `${this.path}: ${errorMessage(err)}` };
    }
    try {
      return { strategy: parseStrategyConfig(JSON.parse(text), policy), problem: null };
    } catch (err) {
      return { strategy: null, problem: `${this.path}: ${errorMessage(err)}` };
    }
  }

  /** Writes `strategy` (already checked); resolves once it is on disk. */
  save(strategy: StrategyConfig): Promise<void> {
    const next = this.#saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(strategy, null, 2)}\n`, 'utf8');
      await rename(tmp, this.path);
    });
    // A failed save must not block the next one.
    this.#saving = next.catch(() => {});
    return next;
  }
}
