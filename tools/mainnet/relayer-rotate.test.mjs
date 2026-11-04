import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTransaction } from 'viem';
import { ARB_USDC, ARB_USDC_E } from './balances.mjs';
import { parseDotEnv } from './cli.mjs';
import { FEE_MARGIN, KEY_FILE_DELETE_WHEN, OLD_ENTRY, rotateEnvText, runRotate } from './relayer-rotate.mjs';
import { ENTRY, evmAddressOf } from './relayer-wallet.mjs';

const OLD_KEY = `0x${'1'.repeat(64)}`;
const NEW_KEY = `0x${'2'.repeat(64)}`;
const OLD = evmAddressOf(OLD_KEY);
const NEW = evmAddressOf(NEW_KEY);
const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;

/** A fake Arbitrum One RPC: balances, a gas price, an estimate, nonces; a sent transaction moves its value. */
function fakeArbitrum(o = {}) {
  const s = {
    wei: new Map([[OLD, o.wei ?? 3n * ETH / 1000n]]),
    usdc: new Map([[OLD, o.usdc ?? 0n]]),
    usdce: new Map([[OLD, o.usdce ?? 0n]]),
    gasPrice: o.gasPrice ?? GWEI / 100n,
    estimate: o.estimate ?? 30_000n,
    latest: o.latest ?? 7n,
    pending: o.pending ?? o.latest ?? 7n,
    sent: [],
    receipts: new Map(),
    calls: [],
  };
  const answer = (method, params) => {
    s.calls.push(method);
    const q = (v) => `0x${v.toString(16)}`;
    switch (method) {
      case 'eth_chainId': return q(42161n);
      case 'eth_gasPrice': return q(s.gasPrice);
      case 'eth_estimateGas': return q(s.estimate);
      case 'eth_getBalance': return q(s.wei.get(params[0].toLowerCase()) ?? 0n);
      case 'eth_call': {
        const who = `0x${params[0].data.slice(-40)}`;
        const book = params[0].to === ARB_USDC ? s.usdc : params[0].to === ARB_USDC_E ? s.usdce : null;
        assert.ok(book !== null, `eth_call to ${params[0].to}`);
        return q(book.get(who) ?? 0n);
      }
      case 'eth_getTransactionCount': return q(params[1] === 'pending' ? s.pending : s.latest);
      case 'eth_sendRawTransaction': {
        if (o.failSend) throw new Error('fake RPC: eth_sendRawTransaction refused');
        const tx = parseTransaction(params[0]);
        s.sent.push(tx);
        const hash = `0x${String(s.sent.length).padStart(64, 'a')}`;
        // Mined at once: the value moves, and the gas used (2/3 of the limit at the base fee, half the max fee).
        const fee = (tx.gas * 2n / 3n) * (tx.maxFeePerGas / FEE_MARGIN);
        s.wei.set(OLD, s.wei.get(OLD) - tx.value - fee);
        s.wei.set(tx.to.toLowerCase(), (s.wei.get(tx.to.toLowerCase()) ?? 0n) + tx.value);
        s.receipts.set(hash, { status: o.status ?? '0x1', blockNumber: '0x10' });
        return hash;
      }
      case 'eth_getTransactionReceipt': return s.receipts.get(params[0]) ?? null;
      default: throw new Error(`fake RPC: ${method}`);
    }
  };
  s.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const result = answer(method, params);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return s;
}

function envDir(text) {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-rotate-'));
  const file = join(dir, '.env');
  writeFileSync(file, text);
  return { dir, file };
}

async function rotate(argv, chain, extra = {}) {
  const out = [];
  let made = 0;
  const lines = await runRotate(argv, {
    env: {}, fetch: chain.fetch, say: (l = '') => out.push(l), now: () => Date.UTC(2026, 10, 4, 12), tree: null,
    newKey: () => { made++; return { privateKey: NEW_KEY, address: NEW }; },
    sleep: async () => {}, pollMs: 0, ...extra,
  });
  return { out: out.join('\n'), lines, made: () => made };
}

const BEFORE = `GIMBAL_MODE=mainnet\n${ENTRY}=${OLD_KEY}   # gas-only Arbitrum wallet\nARBITRUM_RPC_URL=\n`;

test('the .env text: the new key in place with its comment, the old line kept right under it as _OLD', () => {
  assert.equal(rotateEnvText(BEFORE, NEW_KEY), `GIMBAL_MODE=mainnet\n${ENTRY}=${NEW_KEY}  # gas-only Arbitrum wallet\n${OLD_ENTRY}=${OLD_KEY}   # gas-only Arbitrum wallet\nARBITRUM_RPC_URL=\n`);
  const crlf = rotateEnvText(`A=1\r\nexport ${ENTRY}=${OLD_KEY}\r\n`, NEW_KEY);
  assert.equal(crlf, `A=1\r\n${ENTRY}=${NEW_KEY}\r\nexport ${OLD_ENTRY}=${OLD_KEY}\r\n`, 'CRLF and export kept');
  // An empty _OLD entry (from .env.example) gives way to the moved line, wherever it was.
  for (const text of [`${OLD_ENTRY}=\n${ENTRY}=${OLD_KEY}\n`, `${ENTRY}=${OLD_KEY}\nB=2\n${OLD_ENTRY}=\n`]) {
    const m = parseDotEnv(rotateEnvText(text, NEW_KEY));
    assert.equal(m.get(ENTRY), NEW_KEY);
    assert.equal(m.get(OLD_ENTRY), OLD_KEY);
    assert.equal(rotateEnvText(text, NEW_KEY).split(OLD_ENTRY).length, 2, 'one _OLD entry');
  }
  assert.throws(() => rotateEnvText('A=1\n', NEW_KEY), /no RELAYER_EVM_PRIVATE_KEY: there is no relayer key to rotate/);
  assert.throws(() => rotateEnvText(`${ENTRY}=\n`, NEW_KEY), /no relayer key to rotate/);
  assert.throws(() => rotateEnvText(`${ENTRY}=${OLD_KEY}\n${ENTRY}=${OLD_KEY}\n`, NEW_KEY), /2 times/);
  assert.throws(() => rotateEnvText(`${ENTRY}=${OLD_KEY}\n${OLD_ENTRY}=${NEW_KEY}\n`, NEW_KEY), /earlier rotation's key: once its wallet is empty/);
});

test('the dry run generates, writes and signs nothing; it prints the old wallet, its balances and how much ETH would leave, to where', async () => {
  const { dir, file } = envDir(BEFORE);
  const chain = fakeArbitrum();
  const r = await rotate(['--env-file', file], chain);
  assert.equal(readFileSync(file, 'utf8'), BEFORE);
  assert.deepEqual(readdirSync(dir), ['.env'], 'no backup, no temporary file');
  assert.equal(r.made(), 0, 'no key generated');
  assert.equal(chain.sent.length, 0);
  assert.equal(chain.calls.includes('eth_sendRawTransaction'), false);
  assert.match(r.out, new RegExp(`old relayer ${OLD} \\(${ENTRY} in the env file\\)`));
  assert.match(r.out, /Arbitrum One \(chain 42161, RPC arb1\.arbitrum\.io\): 0\.003000 ETH, 0 USDC, 0 USDC\.e/);
  // 30 000 x 3/2 = 45 000 gas at 2 x 0.01 gwei: at most 0.0000009 ETH of gas.
  assert.match(r.out, new RegExp(`money     0\\.002999 ETH leaves the old relayer ${OLD} for the new relayer address \\(generated by --send\\) on Arbitrum One; it stays the owner's`));
  assert.match(r.out, /Gone for good: only the gas, at most 0\.0000009 ETH/);
  assert.match(r.out, /--send would:\n  1\. generate a new relayer key/);
  assert.match(r.out, /Nothing was generated, written or signed/);
  assert.equal(r.out.includes(OLD_KEY.slice(2)), false, 'the key is not printed');
  assert.ok(r.lines.some((l) => l.startsWith('money ')), 'the money line is in the block');
});

test('--send: a backup, the atomic write read back, then all the ETH minus gas to the new key\'s address; keys never printed', async () => {
  const { dir, file } = envDir(BEFORE);
  const chain = fakeArbitrum();
  const r = await rotate(['--send', '--env-file', file], chain);
  const after = parseDotEnv(readFileSync(file, 'utf8'));
  assert.equal(after.get(ENTRY), NEW_KEY);
  assert.equal(after.get(OLD_ENTRY), OLD_KEY);
  assert.equal(after.get('GIMBAL_MODE'), 'mainnet', 'the rest of the file kept');
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['.env', '.env.bak-20261104T120000Z', '.env.relayer-new-20261104T120000Z'], 'the backup, the key file, and no temporary file left');
  assert.equal(readFileSync(join(dir, files[1]), 'utf8'), BEFORE, 'the backup is the file before');
  // The key file holds the new key and the old one: written before .env, so the key the ETH goes to is on disk twice.
  const keys = parseDotEnv(readFileSync(join(dir, files[2]), 'utf8'));
  assert.equal(keys.get(ENTRY), NEW_KEY);
  assert.equal(keys.get(OLD_ENTRY), OLD_KEY);
  if (process.platform !== 'win32') for (const f of files) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.match(r.out, /key file  .*\.env\.relayer-new-20261104T120000Z: the new key and the old one \(values not shown\)/);
  assert.match(r.out, new RegExp(`money     0\\.002999 ETH leaves the old relayer ${OLD} for ${NEW} on Arbitrum One; it stays the owner's \\(both are the owner's gas wallets; the new key is in the env file and in .*\\.env\\.relayer-new-20261104T120000Z; the backup holds the file before, with the old key\\)`));
  assert.equal(chain.sent.length, 1);
  const tx = chain.sent[0];
  assert.equal(tx.to.toLowerCase(), NEW);
  assert.equal(tx.chainId, 42161);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.gas, 45_000n);
  assert.equal(tx.maxFeePerGas, 2n * GWEI / 100n);
  assert.equal(tx.value, 3n * ETH / 1000n - 45_000n * 2n * GWEI / 100n, 'the balance minus the most the gas can cost');
  assert.equal(chain.wei.get(NEW), tx.value);
  for (const want of [`new relayer ${NEW}`, 'tx        https://arbiscan.io/tx/0x', `send      0.002999 ETH from ${OLD} to ${NEW} on Arbitrum One`,
    'mined     block 16: the new relayer has 0.002999 ETH', `next      update ${ENTRY} on Railway`]) {
    assert.ok(r.out.includes(want), want);
  }
  assert.ok(r.lines.some((l) => l.includes('https://arbiscan.io/tx/')), 'the tx link is in the block');
  for (const k of [OLD_KEY, NEW_KEY]) assert.equal(r.out.includes(k.slice(2)), false, 'no key printed');

  // A rerun generates nothing and writes nothing: what is left is less than the gas, so the rotation is done.
  const text = readFileSync(file, 'utf8');
  const again = await rotate(['--send', '--env-file', file], chain);
  assert.equal(again.made(), 0);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(chain.sent.length, 1);
  assert.match(again.out, /done      the rotation is finished/);
  assert.match(again.out, new RegExp(`take ${OLD_ENTRY} out of the env file first`));
  // When the key file may go: said after the send, and again once the rotation is done.
  assert.ok(r.out.includes(`then      the key file: ${KEY_FILE_DELETE_WHEN}`));
  assert.ok(again.out.includes(`.env.relayer-new-20261104T120000Z: ${KEY_FILE_DELETE_WHEN}`));
  assert.match(KEY_FILE_DELETE_WHEN, /once Railway runs the new key and the old address holds no ETH/);
});

test('a rerun after a --send whose transfer did not go out sends to the address of the key in the file, and writes nothing', async () => {
  const rotated = rotateEnvText(BEFORE, NEW_KEY);
  const { dir, file } = envDir(rotated);
  const chain = fakeArbitrum();
  const dry = await rotate(['--env-file', file], chain);
  assert.match(dry.out, new RegExp(`old relayer ${OLD} \\(${OLD_ENTRY}`));
  assert.match(dry.out, new RegExp(`money     0\\.002999 ETH leaves the old relayer ${OLD} for ${NEW} on Arbitrum One`));
  const r = await rotate(['--send', '--env-file', file], chain);
  assert.equal(r.made(), 0);
  assert.equal(readFileSync(file, 'utf8'), rotated);
  assert.deepEqual(readdirSync(dir), ['.env'], 'no backup: nothing written');
  assert.equal(chain.sent[0].to.toLowerCase(), NEW);
});

test('.env that lost the new key (the backup put back, a write that did not land): the key file puts it back, and the ETH goes to it', async () => {
  const { dir, file } = envDir(BEFORE);
  // A --send whose transfer failed after .env was written: the key file and .env both hold the new key.
  const failing = fakeArbitrum({ failSend: true });
  await assert.rejects(rotate(['--send', '--env-file', file], failing), /eth_sendRawTransaction/);
  assert.equal(failing.sent.length, 0);
  // Then .env loses it: the backup is copied over it.
  writeFileSync(file, BEFORE);
  const chain = fakeArbitrum();
  const dry = await rotate(['--env-file', file], chain);
  assert.match(dry.out, new RegExp(`recovery  .* lost the new key an earlier --send wrote; .*\\.env\\.relayer-new-20261104T120000Z has it \\(relayer ${NEW}\\): --send puts it back first`));
  assert.match(dry.out, new RegExp(`money     0\\.002999 ETH leaves the old relayer ${OLD} for ${NEW} on Arbitrum One`));
  assert.equal(readFileSync(file, 'utf8'), BEFORE, 'the dry run writes nothing');
  const r = await rotate(['--send', '--env-file', file], chain, { now: () => Date.UTC(2026, 10, 4, 13) });
  assert.equal(r.made(), 0, 'no other key generated');
  const after = parseDotEnv(readFileSync(file, 'utf8'));
  assert.equal(after.get(ENTRY), NEW_KEY);
  assert.equal(after.get(OLD_ENTRY), OLD_KEY);
  assert.match(r.out, /recovered .*: RELAYER_EVM_PRIVATE_KEY and RELAYER_EVM_PRIVATE_KEY_OLD put back from .*\.env\.relayer-new-20261104T120000Z/);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].to.toLowerCase(), NEW);
  assert.ok(readdirSync(dir).includes('.env.bak-20261104T130000Z'), 'the file before the recovery is kept');
  for (const k of [OLD_KEY, NEW_KEY]) assert.equal(r.out.includes(k.slice(2)), false, 'no key printed');
});

test('USDC or USDC.e on the old wallet: the dry run says --send refuses and how to move it; --send refuses before anything', async () => {
  for (const coins of [{ usdc: 1_500_000n }, { usdce: 1n }]) {
    const { dir, file } = envDir(BEFORE);
    const chain = fakeArbitrum(coins);
    const dry = await rotate(['--env-file', file], chain);
    assert.match(dry.out, /refusal   --send refuses: the old relayer .* holds .*USDC.*this script moves ETH only\. Move them first/);
    await assert.rejects(rotate(['--send', '--env-file', file], chain), /moves ETH only\. Move them first: .*then rerun/);
    assert.equal(readFileSync(file, 'utf8'), BEFORE);
    assert.deepEqual(readdirSync(dir), ['.env']);
    assert.equal(chain.sent.length, 0);
  }
});

test('--send refuses, with the file untouched: a pending transaction, the key in the shell environment, a linked worktree, no key', async () => {
  const cases = [
    [{ pending: 8n }, {}, /1 transaction\(s\) pending .* wait until they are mined/],
    [{}, { env: { [ENTRY]: OLD_KEY } }, /set in the shell environment, and it wins over \.env/],
    [{ wei: 100n }, {}, /less than the transfer's gas .*nothing to move/],
  ];
  for (const [o, extra, why] of cases) {
    const { dir, file } = envDir(BEFORE);
    const chain = fakeArbitrum(o);
    await assert.rejects(rotate(['--send', '--env-file', file], chain, extra), why);
    assert.equal(readFileSync(file, 'utf8'), BEFORE);
    assert.deepEqual(readdirSync(dir), ['.env']);
    assert.equal(chain.sent.length, 0);
  }
  const tree = mkdtempSync(join(tmpdir(), 'gimbal-worktree-'));
  writeFileSync(join(tree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  mkdirSync(join(tree, 'sub'));
  const inTree = join(tree, 'sub', '.env');
  writeFileSync(inTree, BEFORE);
  await assert.rejects(rotate(['--send', '--env-file', inTree], fakeArbitrum(), { tree: undefined }), /linked git worktree .*Run from the main checkout/);
  assert.equal(readFileSync(inTree, 'utf8'), BEFORE);
  const dry = await rotate(['--env-file', inTree], fakeArbitrum(), { tree: undefined });
  assert.match(dry.out, /--send refuses here; run it from the main checkout/);
  const { file } = envDir('A=1\n');
  await assert.rejects(rotate(['--env-file', file], fakeArbitrum()), /has no RELAYER_EVM_PRIVATE_KEY: there is no relayer key to rotate/);
});

test('a reverted transfer is said so: the ETH is still on the old wallet, and a rerun tries again', async () => {
  const { file } = envDir(BEFORE);
  const chain = fakeArbitrum({ status: '0x0' });
  const r = await rotate(['--send', '--env-file', file], chain);
  assert.match(r.out, /FAILED    the transfer reverted/);
  assert.match(r.out, /next      update RELAYER_EVM_PRIVATE_KEY on Railway/);
});
