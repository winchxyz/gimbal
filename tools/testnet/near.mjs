// A minimal NEAR testnet client for the deploy and live-check scripts: JSON-RPC, transactions signed
// with a key file from .keys/ (never printed), keccak256, base58 and Solana address derivation.
// No dependencies: node:crypto signs and hashes, the rest is written out here.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEYS = join(ROOT, '.keys');
/** NEAR_RPC_URL, then FastNEAR (as the engine uses), then the deprecated, rate-limited near.org endpoint as a fallback. */
export const RPC_URLS = [process.env.NEAR_RPC_URL, 'https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'].filter(Boolean);
export const TGAS = 10n ** 12n;
export const YOCTO_PER_NEAR = 10n ** 24n;

// --- testnet only ---
// These scripts sign with real keys, so they refuse mainnet twice: every account id they touch
// must end in `.testnet`, and every RPC endpoint must answer `status` with chain_id "testnet"
// before the first call that goes through it (a NEAR_RPC_URL pointing at mainnet is refused).

/** Returns `id` when it is a `.testnet` account id; throws otherwise. */
export function testnetId(id, what = 'account') {
  if (typeof id !== 'string' || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/.test(id)) {
    throw new Error(`${what} ${JSON.stringify(id)} is not a .testnet account: these scripts run on testnet only`);
  }
  return id;
}

const CHAIN_CHECKED = new Map();

/** Resolves once `url` answered `status` with chain_id "testnet"; a fatal error otherwise. */
function assertTestnet(url) {
  if (!CHAIN_CHECKED.has(url)) {
    const check = (async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'gimbal', method: 'status', params: [] }),
        signal: AbortSignal.timeout(30_000),
      });
      const chain = (await res.json()).result?.chain_id;
      if (chain !== 'testnet') {
        const err = new Error(`${new URL(url).host} serves chain ${JSON.stringify(chain)}, not testnet: refusing`);
        err.fatal = true;
        throw err;
      }
    })();
    // A network error is retried on the next call; a wrong chain stays refused.
    check.catch((e) => { if (!e.fatal) CHAIN_CHECKED.delete(url); });
    CHAIN_CHECKED.set(url, check);
  }
  return CHAIN_CHECKED.get(url);
}

// --- base58 ---

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

// --- keccak256 (Ethereum's, not SHA3-256) ---

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// ROT[x][y]
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const M64 = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);

function keccakF(a) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let i = 0; i < 25; i++) a[i] ^= c[(i % 5 + 4) % 5] ^ rotl(c[(i % 5 + 1) % 5], 1);
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    a[0] ^= RC[r];
  }
}

export function keccak256(data) {
  const rate = 136;
  const msg = Buffer.from(data);
  const padded = Buffer.alloc(Math.ceil((msg.length + 1) / rate) * rate);
  msg.copy(padded);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) a[i] ^= padded.readBigUInt64LE(off + 8 * i);
    keccakF(a);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i], 8 * i);
  return out;
}

if (keccak256(Buffer.alloc(0)).toString('hex') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') {
  throw new Error('keccak256 self-test failed');
}

export const sha256 = (data) => createHash('sha256').update(data).digest();

/** The lowercase 0x address of a 64-byte uncompressed secp256k1 key (x ‖ y). */
export const evmAddress = (key64) => '0x' + keccak256(key64).subarray(12).toString('hex');

// --- Solana derivation (find_program_address, as the contract's core does it) ---

const P = (1n << 255n) - 19n;
const modp = (x) => ((x % P) + P) % P;
function powmod(b, e) {
  let r = 1n;
  b = modp(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = modp(-121665n * powmod(121666n, P - 2n));

/** Whether 32 bytes decompress to an Ed25519 point (curve25519-dalek's `decompress`). */
export function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  y = modp(y);
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n);
  const v = modp(D * y2 + 1n);
  const w = (u * powmod(v, P - 2n)) % P;
  return w === 0n || powmod(w, (P - 1n) / 2n) === 1n;
}

export function findProgramAddress(seeds, program) {
  for (let bump = 255; bump >= 1; bump--) {
    const hash = sha256(Buffer.concat([...seeds.map((s) => Buffer.from(s)), Buffer.from([bump]), program, Buffer.from('ProgramDerivedAddress')]));
    if (!isOnCurve(hash)) return hash;
  }
  throw new Error('no program address');
}

const TOKEN_PROGRAM = b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = b58decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PHOENIX_PROGRAM = b58decode('EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih');

/** The `SolanaAccounts` `create_desk` takes for an authority (base58), given the two mints. */
export function solanaAccounts(authority, usdcMint, phusdMint) {
  const a = b58decode(authority);
  const ata = (mint) => b58encode(findProgramAddress([a, TOKEN_PROGRAM, b58decode(mint)], ATA_PROGRAM));
  return {
    authority,
    usdc_ata: ata(usdcMint),
    phusd_ata: ata(phusdMint),
    phoenix_trader: b58encode(findProgramAddress([Buffer.from('trader'), a, Buffer.from([0]), Buffer.from([0])], PHOENIX_PROGRAM)),
  };
}

// --- keys (the values never leave this module) ---

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A key file of .keys/ as a signer: its account, public key and a sign function. */
export function loadKey(accountId) {
  const file = join(KEYS, `${testnetId(accountId)}.json`);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.account_id !== accountId) throw new Error(`${file} is not the key of ${accountId}`);
  const raw = b58decode(json.private_key.replace(/^ed25519:/, ''));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const publicKey = b58decode(json.public_key.replace(/^ed25519:/, ''));
  const derived = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (Buffer.from(derived, 'base64url').compare(publicKey) !== 0) throw new Error(`${file}: the public key is not the private key's`);
  return { accountId, publicKey, publicKeyString: json.public_key, sign: (msg) => sign(null, msg, privateKey) };
}

/** Writes a new ed25519 key for `accountId` into .keys/ (refusing to overwrite) and returns its public key. */
export function newKey(accountId) {
  const file = join(KEYS, `${testnetId(accountId)}.json`);
  if (existsSync(file)) throw new Error(`${file} exists`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  mkdirSync(KEYS, { recursive: true });
  const public_key = `ed25519:${b58encode(pub)}`;
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key, private_key: `ed25519:${b58encode(Buffer.concat([seed, pub]))}` }) + '\n', { mode: 0o600 });
  return public_key;
}

// --- JSON-RPC ---

/**
 * One JSON-RPC call, over the endpoints in turn. A network error or a rate limit is asked again, except with
 * `{ once: true }` (send_tx): there a request that may have reached the node (no answer, an unreadable answer) throws
 * with `unknown` set instead, because the caller must look the transaction up rather than guess. A rate limit (429)
 * was not taken, so it is still asked again.
 */
export async function rpc(method, params, { once = false } = {}) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = RPC_URLS[attempt % RPC_URLS.length];
    let asked = false;
    try {
      await assertTestnet(url);
      asked = true;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'gimbal', method, params }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) {
        last = new Error(`${method}: HTTP 429`);
        await sleep(2000);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        const cause = json.error.cause?.name ?? json.error.name;
        if (['TIMEOUT_ERROR', 'TooManyRequests'].includes(cause) || res.status === 429) {
          last = new Error(`${method}: ${cause}`);
          last.timeout = cause === 'TIMEOUT_ERROR';
          await sleep(2000);
          if (last.timeout) throw last;
          continue;
        }
        const err = new Error(`${method}: ${JSON.stringify(json.error).slice(0, 2000)}`);
        err.rpc = json.error;
        throw err;
      }
      return json.result;
    } catch (e) {
      if (e.rpc || e.timeout || e.fatal) throw e;
      if (once && asked) {
        const err = new Error(`${method}: no answer from ${new URL(url).host} (${e.message}): the request may have arrived`);
        err.unknown = true;
        throw err;
      }
      last = e;
      await sleep(1500);
    }
  }
  throw last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function view(contract, method, args = {}) {
  testnetId(contract, 'contract');
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (r.error) throw new Error(`${contract}.${method}: ${r.error}`);
  return JSON.parse(Buffer.from(r.result).toString() || 'null');
}

export async function account(accountId) {
  testnetId(accountId);
  return rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
}

// --- borsh transactions ---

class Writer {
  parts = [];
  u8(n) { this.parts.push(Buffer.from([n])); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); return this; }
  u128(n) { const b = Buffer.alloc(16); const v = BigInt(n); b.writeBigUInt64LE(v & M64); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  bytes(b) { this.parts.push(Buffer.from(b)); return this; }
  vec(b) { return this.u32(b.length).bytes(b); }
  string(s) { return this.vec(Buffer.from(s, 'utf8')); }
  done() { return Buffer.concat(this.parts); }
}

export const actions = {
  deploy: (code) => (w) => w.u8(1).vec(code),
  call: (method, args, gasTgas = 300n, deposit = 0n) => (w) =>
    w.u8(2).string(method).vec(Buffer.from(JSON.stringify(args))).u64(BigInt(gasTgas) * TGAS).u128(deposit),
  transfer: (deposit) => (w) => w.u8(3).u128(deposit),
};

/** How many times `send` signs again after an InvalidNonce answer. */
export const NONCE_RETRIES = 3;

/** The highest nonce this process signed with, per `account/public key`: an RPC can serve an access key from before it. */
const lastNonce = new Map();

/** Whether an RPC error is InvalidNonce: the node refused the transaction while validating it, so it never ran. */
export const isInvalidNonce = (e) => Boolean(e?.rpc) && /InvalidNonce/.test(JSON.stringify(e.rpc));

/** The access key's nonce an InvalidNonce answer reports (`ak_nonce`), or null. */
export function akNonceOf(e) {
  const m = JSON.stringify(e?.rpc ?? '').match(/"ak_nonce":\s*"?(\d+)/);
  return m ? BigInt(m[1]) : null;
}

const maxOf = (...xs) => xs.reduce((a, b) => (b > a ? b : a));

/**
 * Signs and sends a transaction from `key` to `receiverId` and waits until every receipt ran and is final
 * (`final_execution_status` FINAL), so a `view` or `account` read right after it (finality "final") sees its effects.
 * Returns { hash, value (the parsed SuccessValue or null), failure (the error or null), logs, burnt (TGas) }.
 *
 * Nonces: each transaction gets max(the chain's nonce, the last one this process used) + 1. InvalidNonce (the node
 * refused the transaction, it never ran) reads the key again and signs a new transaction, at most NONCE_RETRIES times.
 * A timeout or no answer to send_tx never signs again, since the first one may land and a second would run too:
 * the transaction is looked up by its hash, and when it is not found the error says its outcome is unknown.
 * `o.rpc`, `o.pause`, `o.polls` and `o.pollMs` are for tests (a fake RPC, no waiting).
 */
export async function send(key, receiverId, acts, o = {}) {
  const call = o.rpc ?? rpc;
  const pause = o.pause ?? sleep;
  const polls = o.polls ?? 40;
  const pollMs = o.pollMs ?? 3000;
  testnetId(key.accountId, 'signer');
  testnetId(receiverId, 'receiver');
  const keyId = `${key.accountId}/${key.publicKeyString}`;
  let refusedAt = 0n;
  for (let attempt = 0; ; attempt++) {
    const access = await call('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: key.accountId,
      public_key: key.publicKeyString,
    });
    const nonce = maxOf(BigInt(access.nonce), lastNonce.get(keyId) ?? 0n, refusedAt) + 1n;
    lastNonce.set(keyId, nonce);
    const w = new Writer()
      .string(key.accountId)
      .u8(0).bytes(key.publicKey)
      .u64(nonce)
      .string(receiverId)
      .bytes(b58decode(access.block_hash))
      .u32(acts.length);
    for (const a of acts) a(w);
    const tx = w.done();
    const hash = sha256(tx);
    const signed = Buffer.concat([tx, Buffer.from([0]), key.sign(hash)]);
    const txHash = b58encode(hash);
    let outcome;
    try {
      outcome = await call('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'EXECUTED_OPTIMISTIC' }, { once: true });
    } catch (e) {
      if (isInvalidNonce(e)) {
        if (attempt >= NONCE_RETRIES) throw new Error(`InvalidNonce ${attempt + 1} times in a row (last nonce ${nonce}): ${e.message}`);
        refusedAt = maxOf(refusedAt, akNonceOf(e) ?? 0n);
        await pause(1000);
        continue;
      }
      if (!e.timeout && !e.unknown) throw e;
    }
    return result(await finished(call, pause, key.accountId, txHash, outcome, polls, pollMs), txHash);
  }
}

/**
 * FINAL only: an EXECUTED_OPTIMISTIC outcome has run, but its blocks are not final yet, and the scripts read back
 * with finality "final" (deploy.mjs read `version` and got CodeDoesNotExist; desk.mjs read `get_desk` and got null).
 */
const isFinal = (outcome) => outcome?.final_execution_status === 'FINAL' && Boolean(outcome.status);

/** Polls `tx` by hash until the outcome is FINAL; never sends anything. */
async function finished(call, pause, sender, txHash, outcome, polls, pollMs) {
  let seen = Boolean(outcome);
  for (let i = 0; !isFinal(outcome); i++) {
    if (i >= polls) {
      const err = new Error(seen
        ? `transaction ${txHash} did not finish after ${polls} looks`
        : `transaction ${txHash} was not found after ${polls} looks: its outcome is unknown, so it was not sent again; look it up before sending anything else`);
      err.unknown = true;
      err.hash = txHash;
      throw err;
    }
    await pause(pollMs);
    try {
      outcome = await call('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' });
      seen = true;
    } catch (e) {
      if (!e.timeout && !/UNKNOWN_TRANSACTION/.test(e.message)) throw e;
    }
  }
  return outcome;
}

function result(outcome, txHash) {
  const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
  const logs = outcome.receipts_outcome.flatMap((r) => r.outcome.logs);
  const burnt = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const status = outcome.status;
  const value = status.SuccessValue !== undefined && status.SuccessValue !== ''
    ? JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString())
    : null;
  return {
    hash: txHash,
    value,
    failure: status.Failure ?? null,
    logs,
    burntTgas: Number((burnt * 100n) / TGAS) / 100,
    receipts: outcome.receipts_outcome,
  };
}

/** The panic message of a failed transaction, if it is a contract panic. */
export function panicOf(failure) {
  const s = JSON.stringify(failure ?? '');
  const m = s.match(/ExecutionError\\?":\\?"([^"\\]*(?:\\.[^"\\]*)*)/);
  return m ? m[1].replace(/\\\\/g, '\\') : s;
}
