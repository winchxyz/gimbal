// One live rescuer per mode, contract and desk on this machine (E9). Two engines on the same desk would each think the
// other's payments are not held and could pay twice; tools/mainnet/hl-return.mjs shares the desk's EIP-3009 counter,
// its Arbitrum address and the rescue cap, and tools/mainnet/fund.mjs the desk's idle USDC, fund_venue ring and cost
// budget (the reserve route), so each takes the same lock for its run.
//
// The lock is a listening socket the operating system gives to one process only and takes back when that process
// dies, however it dies: on Windows the named pipe \\.\pipe\gimbal-rescue-<mode>-<contract>-<desk>; on Linux the same
// name in the abstract socket namespace (no file); on other POSIX systems a unix socket file in
// <userStateDir>/locks, named by a hash so the path fits their 104-byte limit. Its name is fixed per user and machine
// (not in a checkout or in GIMBAL_STATE_DIR), so another worktree or state dir finds the same lock. There is no pid
// to go stale and no takeover: a second listen fails while the first process lives. The socket file a killed process
// leaves on those other systems is removed only after a connect to it is refused, i.e. nobody listens there.

import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
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
const PIPE = '\\\\.\\pipe\\';

/** The lock's name for `mode`'s live rescuer of one contract and desk (see the header). */
export function rescueLockName(env: (name: string) => string | undefined, mode: Mode, contractId: string, deskId: string, platform: NodeJS.Platform = process.platform): string {
  for (const [what, v] of [['contract id', contractId], ['desk id', deskId]] as const) {
    if (!SAFE.test(v)) throw new Error(`${what} ${JSON.stringify(v)} is not [a-z0-9._-]{1,64}`);
  }
  const name = `gimbal-rescue-${mode}-${contractId}-${deskId}`;
  if (platform === 'win32') return `${PIPE}${name}`;
  if (platform === 'linux') return `\0${name}`;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 24);
  return join(userStateDir(env, platform), 'locks', `rescue-${hash}.sock`);
}

/** The name as a person reads it (the abstract namespace's leading NUL shown as @). */
export function lockText(name: string): string {
  return name.startsWith('\0') ? `@${name.slice(1)} (abstract socket)` : name;
}

export interface RescueLock {
  readonly name: string;
  release(): Promise<void>;
}

const isFileSocket = (name: string) => !name.startsWith('\0') && !name.startsWith(PIPE);

function listen(server: Server, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(name);
  });
}

/** Whether a process listens on `name`: a connect that is accepted (or that does not answer in time). */
export function lockHeld(name: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(name);
    const done = (held: boolean) => {
      sock.destroy();
      resolve(held);
    };
    sock.setTimeout(timeoutMs, () => done(true));
    sock.once('connect', () => done(true));
    sock.once('error', (err: NodeJS.ErrnoException) => done(err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED'));
  });
}

/** Takes the lock or throws why not. It is the process's until release() or its death. */
export async function acquireRescueLock(name: string): Promise<RescueLock> {
  if (isFileSocket(name)) mkdirSync(join(name, '..'), { recursive: true });
  // A connection is only someone asking whether the lock is held: it is closed at once.
  const server = createServer((sock) => sock.destroy());
  try {
    await listen(server, name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw new Error(`the rescuer lock ${lockText(name)} could not be taken: ${(err as Error).message}`);
    // A socket file nobody listens on is what a killed process left (Windows and Linux leave nothing).
    if (!isFileSocket(name) || await lockHeld(name)) {
      throw new Error(`another live rescuer (or tools/mainnet/hl-return.mjs or fund.mjs) holds ${lockText(name)}: one per desk; stop it first`);
    }
    unlinkSync(name);
    try {
      await listen(server, name);
    } catch (again) {
      throw new Error(`the rescuer lock ${lockText(name)} could not be taken: ${(again as Error).message}`);
    }
  }
  // The lock never keeps the process alive on its own.
  server.unref();
  let released = false;
  return {
    name,
    release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
