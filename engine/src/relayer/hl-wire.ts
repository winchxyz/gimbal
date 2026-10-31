// What Hyperliquid verifies, rebuilt in the engine from the payload the contract returned: the msgpack bytes of an
// L1 action, the EIP-712 digest of L1 and user-signed actions, and the MPC signature as Hyperliquid's {r, s, v}.
// The relayer recovers the signer before it posts anything, so a payload that does not match its signature (or a
// key that is not the desk's) stops here with a clear error instead of Hyperliquid's "User or API Wallet does not
// exist". Checked against contract/core/tests/vectors/hl.json (made with Hyperliquid's own SDKs).

import { hashTypedData, keccak256, recoverAddress } from 'viem';
import type { Hex } from 'viem';
import type { HlPayload, Secp256k1Signature } from '../contract/types.ts';

export type HlNetwork = 'mainnet' | 'testnet';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** secp256k1 group order; an s above half of it is flipped to its low twin (EIP-2), which recovers the same key. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ---- msgpack, as Hyperliquid's SDKs encode an action (smallest form of every int, str8 allowed, no floats) ----

export type MsgpackValue = null | boolean | number | bigint | string | MsgpackValue[] | { [key: string]: MsgpackValue };

/** msgpack of a JSON action, map keys in their insertion order: the order the contract signed them in. */
export function msgpack(value: MsgpackValue): Uint8Array {
  const out: number[] = [];
  encode(value, out);
  return Uint8Array.from(out);
}

function encode(v: MsgpackValue, out: number[]): void {
  if (v === null) out.push(0xc0);
  else if (v === false) out.push(0xc2);
  else if (v === true) out.push(0xc3);
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`msgpack: ${v} is not a safe integer (actions carry no floats)`);
    encodeInt(BigInt(v), out);
  } else if (typeof v === 'bigint') encodeInt(v, out);
  else if (typeof v === 'string') {
    const bytes = new TextEncoder().encode(v);
    const n = bytes.length;
    if (n < 32) out.push(0xa0 | n);
    else if (n <= 0xff) out.push(0xd9, n);
    else if (n <= 0xffff) out.push(0xda, n >> 8, n & 0xff);
    else out.push(0xdb, ...be(BigInt(n), 4));
    for (const b of bytes) out.push(b);
  } else if (Array.isArray(v)) {
    const n = v.length;
    if (n < 16) out.push(0x90 | n);
    else if (n <= 0xffff) out.push(0xdc, n >> 8, n & 0xff);
    else out.push(0xdd, ...be(BigInt(n), 4));
    for (const item of v) encode(item, out);
  } else if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    const n = entries.length;
    if (n < 16) out.push(0x80 | n);
    else if (n <= 0xffff) out.push(0xde, n >> 8, n & 0xff);
    else out.push(0xdf, ...be(BigInt(n), 4));
    for (const [k, x] of entries) {
      encode(k, out);
      encode(x, out);
    }
  } else {
    throw new Error(`msgpack: cannot encode ${typeof v}`);
  }
}

function encodeInt(n: bigint, out: number[]): void {
  if (n >= 0n) {
    if (n < 128n) out.push(Number(n));
    else if (n <= 0xffn) out.push(0xcc, Number(n));
    else if (n <= 0xffffn) out.push(0xcd, ...be(n, 2));
    else if (n <= 0xffffffffn) out.push(0xce, ...be(n, 4));
    else if (n <= 0xffffffffffffffffn) out.push(0xcf, ...be(n, 8));
    else throw new Error(`msgpack: ${n} is over u64`);
  } else {
    if (n >= -32n) out.push(Number(n & 0xffn));
    else if (n >= -128n) out.push(0xd0, Number(n & 0xffn));
    else if (n >= -32768n) out.push(0xd1, ...be(n & 0xffffn, 2));
    else if (n >= -2147483648n) out.push(0xd2, ...be(n & 0xffffffffn, 4));
    else if (n >= -(2n ** 63n)) out.push(0xd3, ...be(n & 0xffffffffffffffffn, 8));
    else throw new Error(`msgpack: ${n} is under i64`);
  }
}

function be(n: bigint, bytes: number): number[] {
  const out = new Array<number>(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const toHex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString('hex')}`;

// ---- digests ----

/** keccak256(msgpack(action) ‖ nonce as u64 big-endian ‖ 0x00): no vault, no expiresAfter. */
export function l1ConnectionId(action: MsgpackValue, nonce: number | bigint): Hex {
  const packed = msgpack(action);
  const bytes = new Uint8Array(packed.length + 9);
  bytes.set(packed, 0);
  bytes.set(be(BigInt(nonce), 8), packed.length);
  bytes[packed.length + 8] = 0;
  return keccak256(bytes);
}

/** The EIP-712 digest of an L1 action: `Agent(source, connectionId)` in domain Exchange / 1 / 1337. */
export function l1Digest(action: MsgpackValue, nonce: number | bigint, network: HlNetwork): Hex {
  return hashTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: network === 'mainnet' ? 'a' : 'b', connectionId: l1ConnectionId(action, nonce) },
  });
}

/** The typed fields of each user-signed action, in signing order (`HyperliquidTransaction:<name>`). */
export const USER_SIGNED_TYPES: Record<string, { name: string; fields: { name: string; type: string }[] }> = {
  usdClassTransfer: {
    name: 'UsdClassTransfer',
    fields: [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  sendAsset: {
    name: 'SendAsset',
    fields: [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'sourceDex', type: 'string' },
      { name: 'destinationDex', type: 'string' }, { name: 'token', type: 'string' }, { name: 'amount', type: 'string' },
      { name: 'fromSubAccount', type: 'string' }, { name: 'nonce', type: 'uint64' },
    ],
  },
  withdraw3: {
    name: 'Withdraw',
    fields: [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' },
      { name: 'time', type: 'uint64' },
    ],
  },
  approveBuilderFee: {
    name: 'ApproveBuilderFee',
    fields: [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
};

/** True for the actions signed in domain HyperliquidSignTransaction rather than as an L1 Agent. */
export function isUserSigned(actionType: string): boolean {
  return actionType in USER_SIGNED_TYPES;
}

/** The EIP-712 digest of a user-signed action; its network is in the action (`hyperliquidChain`). */
export function userSignedDigest(action: Record<string, unknown> & { type: string }): Hex {
  const spec = USER_SIGNED_TYPES[action.type];
  if (spec === undefined) throw new Error(`hyperliquid: ${action.type} is not a user-signed action`);
  const chainHex = action.signatureChainId;
  if (typeof chainHex !== 'string' || !/^0x[0-9a-f]+$/i.test(chainHex)) {
    throw new Error(`hyperliquid ${action.type}: signatureChainId ${JSON.stringify(chainHex)} is not a hex chain id`);
  }
  const message: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = action[f.name];
    if (v === undefined) throw new Error(`hyperliquid ${action.type}: the action has no ${f.name}`);
    message[f.name] = f.type === 'uint64' ? BigInt(v as number | string) : v;
  }
  const primaryType = `HyperliquidTransaction:${spec.name}`;
  return hashTypedData({
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number.parseInt(chainHex, 16), verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: spec.fields },
    primaryType,
    message,
  });
}

/** The digest Hyperliquid recovers the signer from, for whichever kind of action `payload` carries. */
export function payloadDigest(payload: HlPayload, network: HlNetwork): Hex {
  const action = payload.action;
  if (isUserSigned(action.type)) {
    const chain = action.hyperliquidChain;
    const want = network === 'mainnet' ? 'Mainnet' : 'Testnet';
    if (chain !== want) throw new Error(`hyperliquid ${action.type}: signed for ${String(chain)}, the relayer posts to ${want}`);
    return userSignedDigest(action);
  }
  return l1Digest(action as MsgpackValue, payload.nonce, network);
}

// ---- signatures ----

export interface HlSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

/**
 * interfaces 1.4: r = big_r without its 02/03 prefix byte, s = scalar, v = 27 + recovery_id. A high s is replaced by
 * n − s with the other recovery id: the same signature in the form EIP-2 requires.
 */
export function hlSignature(sig: Secp256k1Signature): HlSignature {
  if (sig.scheme !== 'Secp256k1') throw new Error(`hyperliquid: expected a Secp256k1 signature, got ${String(sig.scheme)}`);
  const point = sig.big_r.affine_point.toLowerCase().replace(/^0x/, '');
  if (!/^0[23][0-9a-f]{64}$/.test(point)) throw new Error('hyperliquid: big_r must be a 33-byte compressed point');
  const scalar = sig.s.scalar.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (!/^[0-9a-f]{64}$/.test(scalar)) throw new Error('hyperliquid: s must be 32 bytes of hex');
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new Error(`hyperliquid: recovery id must be 0 or 1, got ${sig.recovery_id}`);
  let s = BigInt(`0x${scalar}`);
  let recovery = sig.recovery_id;
  if (s === 0n || s >= SECP256K1_N) throw new Error('hyperliquid: s is outside the curve order');
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    recovery = recovery === 0 ? 1 : 0;
  }
  return { r: `0x${point.slice(2)}`, s: `0x${s.toString(16).padStart(64, '0')}`, v: recovery === 0 ? 27 : 28 };
}

/** The address `signature` recovers to over `digest`, lowercase. */
export async function recoverSigner(digest: Hex, signature: HlSignature): Promise<string> {
  const hex = `${signature.r}${signature.s.slice(2)}${signature.v.toString(16)}` as Hex;
  return (await recoverAddress({ hash: digest, signature: hex })).toLowerCase();
}

/** The `/exchange` body: the payload as the contract returned it, plus the signature. */
export function exchangeBody(payload: HlPayload, signature: HlSignature): Record<string, unknown> {
  return { ...payload, signature };
}

export { toHex as bytesToHex };
