// One live rescuer per mode, contract and desk: the lock file at a fixed per-user path, refused while its owner runs
// (also from another process), taken over when its pid is gone, and removed on release.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireRescueLock, rescueLockPath, userStateDir } from './lock.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'gimbal-lock-'));
const LOCK_TS = new URL('./lock.ts', import.meta.url).href;

/** A second process that tries the same lock: prints "took" or the refusal, then exits (releasing what it took). */
function otherProcess(path: string): string {
  const script = join(tmp(), 'try-lock.mjs');
  writeFileSync(script, [
    `import { acquireRescueLock } from ${JSON.stringify(LOCK_TS)};`,
    'try {',
    '  acquireRescueLock(process.argv[2]);',
    "  console.log('took');",
    '} catch (err) {',
    "  console.log('refused: ' + err.message);",
    '}',
    '',
  ].join('\n'), 'utf8');
  return execFileSync(process.execPath, [script, path], { encoding: 'utf8' }).trim();
}

test('the per-user directory is outside any checkout: LOCALAPPDATA on Windows, XDG_STATE_HOME or ~/.local/state elsewhere', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assert.equal(userStateDir(env({ LOCALAPPDATA: join('C:', 'Users', 'u', 'AppData', 'Local') }), 'win32'), join('C:', 'Users', 'u', 'AppData', 'Local', 'gimbal', 'state'));
  assert.equal(userStateDir(env({ XDG_STATE_HOME: '/home/u/.state' }), 'linux'), join('/home/u/.state', 'gimbal'));
  assert.match(userStateDir(env({}), 'linux'), /[\\/]\.local[\\/]state[\\/]gimbal$/);
  const path = rescueLockPath(env({ XDG_STATE_HOME: '/x' }), 'mainnet', 'gimbal.near', 'alpha');
  assert.ok(path.startsWith(userStateDir(env({ XDG_STATE_HOME: '/x' }))) && path.endsWith(join('locks', 'rescue-mainnet-gimbal.near-alpha.lock')), path);
  assert.throws(() => rescueLockPath(env({}), 'mainnet', 'gimbal.near', '../x'), /desk id/);
});

test('two processes: the second is refused while the first holds the lock, and takes it once released', () => {
  const path = join(tmp(), 'locks', 'rescue-mainnet-gimbal.near-alpha.lock');
  const lock = acquireRescueLock(path, { onExit: false });
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
  assert.throws(() => acquireRescueLock(path, { onExit: false }), /another live rescuer \(pid \d+\) holds/, 'refused in this process too');
  assert.match(otherProcess(path), new RegExp(`^refused: another live rescuer \\(pid ${process.pid}\\) holds .*one engine per desk`));
  lock.release();
  assert.ok(!existsSync(path), 'removed on release');
  assert.equal(otherProcess(path), 'took');
  assert.ok(!existsSync(path), 'and the other process removed it when it exited');
});

test('a lock whose process is gone is stale and taken over; one with no pid is refused with how to fix it', () => {
  const path = join(tmp(), 'rescue.lock');
  // A pid that ran and is gone now.
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, `${gone}\n`, 'utf8');
  const lock = acquireRescueLock(path, { onExit: false });
  assert.equal(readFileSync(path, 'utf8').trim(), String(process.pid));
  lock.release();
  writeFileSync(path, 'garbage', 'utf8');
  assert.throws(() => acquireRescueLock(path, { onExit: false }), /holds no pid .*if no engine runs for this desk, remove it/);
  // A release never removes a lock someone else holds.
  const other = join(tmp(), 'rescue.lock');
  const mine = acquireRescueLock(other, { onExit: false });
  writeFileSync(other, '1\n', 'utf8');
  mine.release();
  assert.ok(existsSync(other));
});
