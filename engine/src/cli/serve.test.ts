// The serve CLI as a process: it refuses to start on a bad policy file, and listens where GIMBAL_HOST says.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPolicyFile } from './serve-replay.ts';

const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));

const GOOD = {
  hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }], phoenix_markets: [], orderly_symbols: [],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

/** Runs serve until `until` matches its output or it exits; then stops it. */
function run(args: string[], env: Record<string, string>, until: RegExp): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE, ...args], { env: { ...process.env, GIMBAL_MODE: 'replay', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    const seen = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (until.test(out)) child.kill();
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('a policy file that does not match ContractPolicy stops the engine before it starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-'));
  try {
    const bad = join(dir, 'policy.json');
    writeFileSync(bad, JSON.stringify({ ...GOOD, max_notional_usd: -1 }));
    const r = await run(['--port', '0', '--policy', bad], {}, /listening|engine replay on/);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /serve: policy file .*policy\.json: policy: max_notional_usd must be a number > 0/);
    assert.doesNotMatch(r.out, /engine replay on/);
    // Not JSON at all, and a file that is not there.
    writeFileSync(bad, '{"hl_assets": [');
    assert.throws(() => loadPolicyFile(bad), /policy file .*policy\.json: /);
    assert.throws(() => loadPolicyFile(join(dir, 'missing.json')), /policy file .*missing\.json: /);
    // A good one, without `unpriced`, loads with none.
    writeFileSync(bad, JSON.stringify(GOOD));
    assert.deepEqual(loadPolicyFile(bad).unpriced, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it listens on 127.0.0.1 by default and on GIMBAL_HOST when set', async () => {
  const plain = await run(['--port', '0'], {}, /engine replay on http:\/\/\S+:\d+/);
  assert.match(plain.out, /engine replay on http:\/\/127\.0\.0\.1:\d+: /);
  const set = await run(['--port', '0'], { GIMBAL_HOST: 'localhost' }, /engine replay on http:\/\/\S+:\d+/);
  assert.match(set.out, /engine replay on http:\/\/localhost:\d+: /);
  // Variables left empty, as .env.example has them, count as not set.
  const empty = { GIMBAL_HOST: '', GIMBAL_POLICY_FILE: '', GIMBAL_REPLAY_FILE: '', GIMBAL_REPLAY_SPEED: '' };
  const blank = await run(['--port', '0'], empty, /engine replay on http:\/\/\S+:\d+/);
  assert.match(blank.out, /engine replay on http:\/\/127\.0\.0\.1:\d+: /);
});
