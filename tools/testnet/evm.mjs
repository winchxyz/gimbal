// EVM helpers for the live checks: secp256k1 public-key recovery, msgpack (Hyperliquid's form) and
// the Hyperliquid L1 digest, so a SignedAction can be checked against the desk's address without
// trusting the contract's own check. BigInt arithmetic, no dependencies.

import { keccak256 } from './near.mjs';

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];

const mod = (a, m = P) => ((a % m) + m) % m;
function pow(b, e, m = P) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (a, m = P) => pow(a, m - 2n, m);

function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p[0] === q[0]) {
    if (mod(p[1] + q[1]) === 0n) return null;
    const l = mod(3n * p[0] * p[0] * inv(2n * p[1]));
    const x = mod(l * l - 2n * p[0]);
    return [x, mod(l * (p[0] - x) - p[1])];
  }
  const l = mod((q[1] - p[1]) * inv(q[0] - p[0]));
  const x = mod(l * l - p[0] - q[0]);
  return [x, mod(l * (p[0] - x) - p[1])];
}

function mul(k, p) {
  let r = null;
  for (let a = p; k > 0n; k >>= 1n, a = add(a, a)) if (k & 1n) r = add(r, a);
  return r;
}

const big = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const bytes32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** The lowercase address that signed `digest` with (r, s, recovery id 0 or 1), or null. */
export function recoverAddress(digest, r, s, recoveryId) {
  const R = typeof r === 'bigint' ? r : big(r);
  const S = typeof s === 'bigint' ? s : big(s);
  if (R <= 0n || R >= N || S <= 0n || S >= N || ![0, 1].includes(recoveryId)) return null;
  const y2 = mod(R ** 3n + 7n);
  let y = pow(y2, (P + 1n) / 4n);
  if (mod(y * y) !== y2) return null;
  if ((y & 1n) !== BigInt(recoveryId)) y = P - y;
  const e = mod(big(digest), N);
  const rInv = inv(R, N);
  const q = add(mul(mod(S * rInv, N), [R, y]), mul(mod(-e * rInv, N), G));
  if (!q) return null;
  return '0x' + keccak256(Buffer.concat([bytes32(q[0]), bytes32(q[1])])).subarray(12).toString('hex');
}

/** r, s and v (27/28) of an MPC Secp256k1 answer, as Hyperliquid's `signature` takes them. */
export function hlSignature(sig) {
  if (sig.scheme !== 'Secp256k1') throw new Error(`a ${sig.scheme} signature, not secp256k1`);
  return {
    r: '0x' + sig.big_r.affine_point.slice(2).toLowerCase(),
    s: '0x' + sig.s.scalar.toLowerCase(),
    v: 27 + sig.recovery_id,
  };
}

// --- msgpack, as Hyperliquid's Python SDK writes it ---

export function msgpack(v) {
  const out = [];
  const u = (n, len) => {
    const b = Buffer.alloc(len);
    if (len === 1) b.writeUInt8(n);
    else if (len === 2) b.writeUInt16BE(n);
    else if (len === 4) b.writeUInt32BE(n);
    else b.writeBigUInt64BE(BigInt(n));
    out.push(b);
  };
  const enc = (x) => {
    if (x === null || x === undefined) out.push(Buffer.from([0xc0]));
    else if (x === true) out.push(Buffer.from([0xc3]));
    else if (x === false) out.push(Buffer.from([0xc2]));
    else if (typeof x === 'number' || typeof x === 'bigint') {
      const n = BigInt(x);
      if (n < 0n) throw new Error('negative ints are not used');
      if (n < 128n) u(Number(n), 1);
      else if (n < 256n) { out.push(Buffer.from([0xcc])); u(Number(n), 1); }
      else if (n < 65536n) { out.push(Buffer.from([0xcd])); u(Number(n), 2); }
      else if (n < 2n ** 32n) { out.push(Buffer.from([0xce])); u(Number(n), 4); }
      else { out.push(Buffer.from([0xcf])); u(n, 8); }
    } else if (typeof x === 'string') {
      const b = Buffer.from(x, 'utf8');
      if (b.length < 32) out.push(Buffer.from([0xa0 | b.length]));
      else if (b.length < 256) { out.push(Buffer.from([0xd9])); u(b.length, 1); }
      else { out.push(Buffer.from([0xda])); u(b.length, 2); }
      out.push(b);
    } else if (Array.isArray(x)) {
      if (x.length < 16) out.push(Buffer.from([0x90 | x.length]));
      else { out.push(Buffer.from([0xdc])); u(x.length, 2); }
      x.forEach(enc);
    } else {
      const keys = Object.keys(x);
      if (keys.length < 16) out.push(Buffer.from([0x80 | keys.length]));
      else { out.push(Buffer.from([0xde])); u(keys.length, 2); }
      for (const k of keys) { enc(k); enc(x[k]); }
    }
  };
  enc(v);
  return Buffer.concat(out);
}

const AGENT_TYPEHASH = keccak256(Buffer.from('Agent(string source,bytes32 connectionId)'));
const EXCHANGE_DOMAIN = keccak256(Buffer.concat([
  keccak256(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
  keccak256(Buffer.from('Exchange')),
  keccak256(Buffer.from('1')),
  bytes32(1337n),
  Buffer.alloc(32),
]));

const u64be = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/**
 * The EIP-712 digest of an L1 action body `{action, nonce, vaultAddress: null[, expiresAfter]}` on testnet ("b").
 * The connection id hashes msgpack(action) ‖ nonce (u64 BE) ‖ `0x00` (no vault), and with `expiresAfter` also
 * `0x00` ‖ expiresAfter (u64 BE), as the contract (contract/core/src/hl.rs `expiring_connection_id`) and
 * Hyperliquid's Python SDK (`action_hash`) write it. The contract sets `expiresAfter` on orders and cancels.
 */
export function hlL1Digest(body, source = 'b') {
  if (body.vaultAddress !== null && body.vaultAddress !== undefined) throw new Error('vault actions are not used');
  const parts = [msgpack(body.action), u64be(body.nonce), Buffer.from([0])];
  if (body.expiresAfter !== null && body.expiresAfter !== undefined) parts.push(Buffer.from([0]), u64be(body.expiresAfter));
  const connectionId = keccak256(Buffer.concat(parts));
  const struct = keccak256(Buffer.concat([AGENT_TYPEHASH, keccak256(Buffer.from(source)), connectionId]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), EXCHANGE_DOMAIN, struct]));
}
