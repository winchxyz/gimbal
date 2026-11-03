// One live rescuer per mode, contract and desk on this machine (E9). Two engines on the same desk would each think the
// other's payments are not held and could pay twice; so the live rescuer starts only with an exclusive lock file at
// a fixed per-user path (not in a checkout, not in GIMBAL_STATE_DIR, so another worktree or state dir finds the same
// lock). The file holds the owner's pid: a lock whose pid no longer runs is stale and taken over; any other lock
// refuses the start. It is removed when the process exits.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mode } from '@gimbal/shared';

/** The per-user state directory: %LOCALAPPDATA%/gimbal/state on Windows, else $XDG_STATE_HOME/gimbal or ~/.local/state/gimbal. */
export function userStateDir(env: (name: string) => string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = env('LOCALAPPDATA');
    return join(local !== undefined && local !== '' ? local : join(homedir(), 'AppData', 'Local'), 'gimbal', 'state');
  }
  const xdg = env('XDG_STATE_HOME');
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'state'), 'gimbal');
}

const SAFE = /^[a-z0-9._-]{1,64}$/;

/** The lock of `mode`'s live rescuer for one contract and desk. */
export function rescueLockPath(env: (name: string) => string | undefined, mode: Mode, contractId: string, deskId: string): string {
  for (const [what, v] of [['contract id', contractId], ['desk id', deskId]] as const) {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} is not [a-z0-9._-]{1,64}`);
  }
  return join(userStateDir(env), 'locks', `rescue-${mode}-${contractId}-${deskId}.lock`);
}

/** Whether `pid` runs (EPERM: it runs as another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RescueLock {
  readonly path: string;
  release(): void;
}

/** Takes the lock or throws why not; `onExit` false leaves removing it to the caller (tests). */
export function acquireRescueLock(path: string, options: { onExit?: boolean } = {}): RescueLock {
  mkdirSync(join(path, '..'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`the rescuer lock ${path} could not be made: ${(err as Error).message}`);
      let text = '';
      try {
        text = readFileSync(path, 'utf8').trim();
      } catch {
        // Removed meanwhile: try again.
        continue;
      }
      const pid = /^\d+$/.test(text) ? Number(text) : null;
      if (pid === null) throw new Error(`the rescuer lock ${path} holds no pid (${JSON.stringify(text.slice(0, 40))}); if no engine runs for this desk, remove it`);
      if (pid === process.pid || alive(pid)) throw new Error(`another live rescuer (pid ${pid}) holds ${path}: one engine per desk; stop it first`);
      // Stale: its process is gone.
      try {
        unlinkSync(path);
      } catch {
        // Someone else took it over first; the next open says who.
      }
      continue;
    }
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
      } catch {
        // Already gone.
      }
    };
    if (options.onExit !== false) process.once('exit', release);
    return { path, release };
  }
  throw new Error(`the rescuer lock ${path} could not be taken`);
}
