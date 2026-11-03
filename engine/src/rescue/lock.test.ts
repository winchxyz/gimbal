// One live rescuer per mode, contract and desk: an OS-exclusive listening socket (a named pipe on Windows, an abstract
// unix socket on Linux, a socket file elsewhere), refused while its owner runs (also from another process), free
// again on release, and free again when its owner is killed, with nothing to clean up and no pid to go stale.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireRescueLock, lockHeld, lockText, rescueLockName, userStateDir } from './lock.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'gimbal-lock-'));
const LOCK_TS = new URL('./lock.ts', import.meta.url).href;
const env = (vars: Record<string, string>) => (name: string) => vars[name];
/** A name no other test or engine on this machine uses. */
const testName = () => rescueLockName(env({ XDG_STATE_HOME: tmp() }), 'testnet', `lock-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.near`, 'alpha');

/** A script that tries the lock: prints "took" or the refusal; with "hold", keeps it until killed. */
function script(): string {
  const path = join(tmp(), 'try-lock.mjs');
  writeFileSync(path, [
    `import { acquireRescueLock } from ${JSON.stringify(LOCK_TS)};`,
    'try {',
    '  await acquireRescueLock(process.argv[2]);',
    "  console.log('took');",
    "  if (process.argv[3] === 'hold') setInterval(() => {}, 1000);",
    '} catch (err) {',
    "  console.log('refused: ' + err.message);",
    '}',
    '',
  ].join('\n'), 'utf8');
  return path;
}

const otherProcess = (name: string): string => execFileSync(process.execPath, [script(), name], { encoding: 'utf8' }).trim();

test('the per-user directory is outside any checkout; the lock is named per mode, contract and desk: a pipe, an abstract socket, a short socket file', () => {
  assert.equal(userStateDir(env({ LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') }), 'win32'), join('C:', 'Users', 'u', 'AppData', 'Local', 'gimbal', 'state'));
  assert.equal(userStateDir(env({ XDG_STATE_HOME: '/home/u/.state' }), 'linux'), join('/home/u/.state', 'gimbal'));
  assert.match(userStateDir(env({}), 'linux'), /[\\/]\.local[\\/]state[\\/]gimbal$/);
  assert.equal(rescueLockName(env({}), 'mainnet', 'gimbal.near', 'alpha', 'win32'), '\\\\.\\pipe\\gimbal-rescue-mainnet-gimbal.near-alpha');
  assert.equal(rescueLockName(env({}), 'mainnet', 'gimbal.near', 'alpha', 'linux'), '\0gimbal-rescue-mainnet-gimbal.near-alpha');
  assert.equal(lockText('\0gimbal-rescue-mainnet-gimbal.near-alpha'), '@gimbal-rescue-mainnet-gimbal.near-alpha (abstract socket)');
  const mac = rescueLockName(env({ XDG_STATE_HOME: '/x' }), 'mainnet', 'a-contract-id-of-sixty-four-characters-is-allowed-by-near.near', 'alpha', 'darwin');
  assert.ok(mac.startsWith(join('/x', 'gimbal', 'locks')) && /rescue-[0-9a-f]{24}\.sock$/.test(mac) && mac.length < 104, mac);
  assert.notEqual(rescueLockName(env({}), 'mainnet', 'gimbal.near', 'alpha'), rescueLockName(env({}), 'testnet', 'gimbal.near', 'alpha'));
  assert.notEqual(rescueLockName(env({}), 'mainnet', 'gimbal.near', 'alpha'), rescueLockName(env({}), 'mainnet', 'gimbal.near', 'beta'));
  assert.throws(() => rescueLockName(env({}), 'mainnet', 'gimbal.near', '../x'), /desk id/);
});

test('two processes: the second is refused while the first holds the lock, and takes it once released', async () => {
  const name = testName();
  const lock = await acquireRescueLock(name);
  assert.equal(await lockHeld(name), true);
  await assert.rejects(acquireRescueLock(name), /another live rescuer \(or tools\/mainnet\/hl-return\.mjs\) holds .*one per desk/, 'refused in this process too');
  assert.match(otherProcess(name), /^refused: another live rescuer .* holds /);
  await lock.release();
  assert.equal(await lockHeld(name), false, 'free on release');
  assert.equal(otherProcess(name), 'took');
  assert.equal(await lockHeld(name), false, 'and free again once that process exited');
});

test('a holder that is killed (no exit handler runs) frees the lock at once: nothing stale to take over or clean up', async () => {
  const name = testName();
  const holder = spawn(process.execPath, [script(), name, 'hold'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const first = await new Promise<string>((resolve) => holder.stdout.once('data', (b: Buffer) => resolve(b.toString().trim())));
  assert.equal(first, 'took');
  assert.equal(await lockHeld(name), true);
  await assert.rejects(acquireRescueLock(name), /holds/);
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const mine = await acquireRescueLock(name);
  assert.equal(mine.name, name);
  await mine.release();
});
