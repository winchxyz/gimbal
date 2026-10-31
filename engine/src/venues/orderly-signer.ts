// What the engine gets back from the contract for Orderly, and how it turns that into what Orderly accepts.
// The shapes mirror docs/interfaces.md section 1.3 (OrderlyRequest, the operator methods) and 1.4 (SignedAction).
// The engine never signs: an OrderlySigner is the contract client (or a fake one in tests); this file only checks
// and encodes what it returns.

/** Orderly request kinds the contract builds (interfaces 1.3). */
export type OrderlyRequestKind =
  | 'order' | 'cancel' | 'cancel_all'
  | 'receiver_address' | 'settle_nonce' | 'withdraw_nonce' | 'settle_pnl' | 'withdraw_request' | 'referral_bind'
  | 'funding_fee_history';         // GET /v1/funding_fee/history?start_t&end_t&page&size, read only

/** The `kind` the engine expects on an orderly_ws_auth SignedAction (interfaces 1.4 names no kind for it yet). */
export const ORDERLY_WS_AUTH_KIND = 'ws_auth';

/** interfaces 1.3 `OrderlyRequest`; the contract builds path and body from it, the engine never passes raw JSON. */
export interface OrderlyRequest {
  kind: OrderlyRequestKind;
  symbol?: string | null;
  side?: 'BUY' | 'SELL' | null;
  order_type?: 'IOC' | 'LIMIT' | 'MARKET' | null;
  price?: string | null;
  quantity?: string | null;
  reduce_only: boolean;
  client_order_id?: string | null;
  order_id?: number | null;
  timestamp_ms: number;
  amount?: string | null;
  nonce?: number | null;
  signed_at_ms?: number | null;
  eip712_signature?: string | null;
  // funding_fee_history only: ms window and paging.
  start_t?: number | null;
  end_t?: number | null;
  page?: number | null;
  size?: number | null;
}

export interface Secp256k1Signature {
  scheme: 'Secp256k1';
  big_r: { affine_point: string };      // 33-byte compressed point, hex: 02/03 then r
  s: { scalar: string };                // 32 bytes, hex
  recovery_id: number;                  // 0 or 1
}

export interface Ed25519Signature {
  scheme: 'Ed25519';
  signature: number[];                  // 64 bytes
}

/** interfaces 1.4: what every action method returns; the engine submits it as is. */
export interface SignedAction<P = unknown, S = Secp256k1Signature | Ed25519Signature> {
  desk_id: string;
  request_id: number;
  venue: string;
  kind: string;
  payload: P;
  signature: S;
}

/** A signed Orderly REST call (orderly_request) or WebSocket login (orderly_ws_auth). */
export interface OrderlyRestPayload {
  method: string;                       // GET | POST | PUT | DELETE
  path: string;                         // with the query, as signed
  body: string;                         // '' for GET and DELETE
  timestamp: number;                    // ms
  message: string;                      // timestamp + METHOD + path + body, exactly as signed; the timestamp alone for ws auth
}

/** An EIP-712 action (Registration, AddOrderlyKey, SettlePnl, Withdraw): the typed-data message the contract signed (interfaces 1.4). */
export interface OrderlyEip712Payload {
  message: Record<string, unknown> & { timestamp: number | string };
  userAddress?: string;                 // the desk's EVM address; the relayer falls back to its config
}

export type OrderlyRestAction = SignedAction<OrderlyRestPayload, Ed25519Signature>;
export type OrderlyEip712Action = SignedAction<OrderlyEip712Payload, Secp256k1Signature>;

/** The contract's Orderly operator methods (interfaces 1.3), as the engine's contract client exposes them. */
export interface OrderlySigner {
  orderlyRequest(deskId: string, req: OrderlyRequest, reason: string): Promise<OrderlyRestAction>;
  orderlyWsAuth(deskId: string, timestamp: number): Promise<OrderlyRestAction>;
  orderlyRegister(deskId: string, registrationNonce: string): Promise<OrderlyEip712Action>;
  orderlyAddKey(deskId: string, expirationMs: number): Promise<OrderlyEip712Action>;
  orderlySettlePnl(deskId: string, settleNonce: number): Promise<OrderlyEip712Action>;
  orderlyWithdraw(deskId: string, amount: string, withdrawNonce: number): Promise<OrderlyEip712Action>;
}

/** Orderly accepts a signed REST call for 300 s after its timestamp. */
export const ORDERLY_SIGNATURE_TTL_MS = 300_000;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin-alphabet base58 of some bytes (leading zero bytes become leading '1's). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** The `orderly-key` header and `orderly_key` field: "ed25519:" + base58 of the 32-byte public key. */
export function orderlyKeyString(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error(`orderly key: an Ed25519 public key is 32 bytes, got ${publicKey.length}`);
  return `ed25519:${base58(publicKey)}`;
}

export function isOrderlyKeyString(key: string): boolean {
  return /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);
}

/** The text Orderly verifies for a REST call: timestamp + METHOD + path + body. */
export function orderlyRestMessage(timestamp: number, method: string, path: string, body: string): string {
  return `${timestamp}${method.toUpperCase()}${path}${body}`;
}

/** The `orderly-signature` header: base64url of the 64-byte Ed25519 signature. */
export function ed25519SignatureBase64Url(signature: Ed25519Signature): string {
  const bytes = signatureBytes(signature);
  return Buffer.from(bytes).toString('base64url');
}

function signatureBytes(signature: Ed25519Signature): Uint8Array {
  if (signature.scheme !== 'Ed25519') throw new Error(`orderly: expected an Ed25519 signature, got ${String(signature.scheme)}`);
  const s = signature.signature;
  if (!Array.isArray(s) || s.length !== 64 || s.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('orderly: an Ed25519 signature is 64 bytes');
  }
  return Uint8Array.from(s);
}

/** An EIP-712 signature as Orderly takes it: "0x" + r (32 bytes) + s (32 bytes) + v (27 + recovery id), hex. */
export function evmSignatureHex(signature: Secp256k1Signature): string {
  if (signature.scheme !== 'Secp256k1') throw new Error(`orderly: expected a Secp256k1 signature, got ${String(signature.scheme)}`);
  const point = signature.big_r.affine_point.toLowerCase().replace(/^0x/, '');
  const s = signature.s.scalar.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (!/^0[23][0-9a-f]{64}$/.test(point)) throw new Error('orderly: big_r must be a 33-byte compressed point');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('orderly: s must be 32 bytes of hex');
  if (signature.recovery_id !== 0 && signature.recovery_id !== 1) throw new Error(`orderly: recovery id must be 0 or 1, got ${signature.recovery_id}`);
  return `0x${point.slice(2)}${s}${(27 + signature.recovery_id).toString(16)}`;
}

export interface OrderlyAuthHeaders {
  'orderly-timestamp': string;
  'orderly-account-id': string;
  'orderly-key': string;
  'orderly-signature': string;
}

/**
 * Checks a signed REST action before anything is sent: the right venue, desk and kind, a message that is exactly
 * timestamp + METHOD + path + body, a timestamp still inside Orderly's 300 s window. Throws on any mismatch.
 */
export function checkRestAction(action: OrderlyRestAction, expectedKind: string, now: number, deskId: string): void {
  checkVenueAndDesk(action, deskId);
  if (action.kind !== expectedKind) throw new Error(`orderly: asked for ${expectedKind}, the contract signed ${action.kind}`);
  const p = action.payload;
  const method = String(p.method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error(`orderly: unknown method ${p.method}`);
  if (!p.path.startsWith('/v1/')) throw new Error(`orderly: unexpected path ${p.path}`);
  if ((method === 'GET' || method === 'DELETE') && p.body !== '') throw new Error(`orderly: ${method} ${p.path} carries a body`);
  if (p.message !== orderlyRestMessage(p.timestamp, method, p.path, p.body)) {
    throw new Error(`orderly: ${expectedKind}: the signed message is not timestamp + method + path + body`);
  }
  checkFresh(p.timestamp, now, expectedKind);
  signatureBytes(action.signature);
}

/** A ws auth action signs the timestamp alone; checked the same way. */
export function checkWsAuthAction(action: OrderlyRestAction, timestamp: number, now: number, deskId: string): void {
  checkVenueAndDesk(action, deskId);
  if (action.kind !== ORDERLY_WS_AUTH_KIND) throw new Error(`orderly ws auth: the contract signed ${action.kind}, not ${ORDERLY_WS_AUTH_KIND}`);
  if (action.payload.timestamp !== timestamp) throw new Error(`orderly ws auth: asked to sign ${timestamp}, got ${action.payload.timestamp}`);
  if (action.payload.message !== String(timestamp)) throw new Error('orderly ws auth: the signed message is not the timestamp');
  checkFresh(timestamp, now, 'ws auth');
  signatureBytes(action.signature);
}

/**
 * An EIP-712 action: for Orderly, for this desk, and its typed message carries exactly the `fields` the engine asked
 * the contract to sign (a nonce, an amount). A number and its decimal string compare equal.
 */
export function checkEip712Action(action: OrderlyEip712Action, deskId: string, what: string, fields: Record<string, string | number> = {}): void {
  checkVenueAndDesk(action, deskId);
  const message = action.payload?.message;
  if (typeof message !== 'object' || message === null) throw new Error(`orderly ${what}: the signed action has no EIP-712 message`);
  for (const [field, want] of Object.entries(fields)) {
    const got = message[field];
    if (got === undefined || got === null || String(got) !== String(want)) {
      throw new Error(`orderly ${what}: the contract signed ${field} ${JSON.stringify(got)}, the engine asked for ${JSON.stringify(want)}`);
    }
  }
}

function checkVenueAndDesk(action: SignedAction, deskId: string): void {
  if (action.venue !== 'orderly') throw new Error(`orderly: signed action is for ${action.venue}`);
  if (action.desk_id !== deskId) throw new Error(`orderly: signed action is for desk ${action.desk_id}, not ${deskId}`);
}

function checkFresh(timestamp: number, now: number, what: string): void {
  if (!Number.isInteger(timestamp)) throw new Error(`orderly ${what}: timestamp must be integer ms, got ${timestamp}`);
  if (Math.abs(now - timestamp) > ORDERLY_SIGNATURE_TTL_MS) throw new Error(`orderly ${what}: signature timestamp ${timestamp} is outside 300 s of ${now}`);
}

/** The four headers of a signed private REST call. */
export function orderlyAuthHeaders(action: OrderlyRestAction, accountId: string, orderlyKey: string): OrderlyAuthHeaders {
  return {
    'orderly-timestamp': String(action.payload.timestamp),
    'orderly-account-id': accountId,
    'orderly-key': orderlyKey,
    'orderly-signature': ed25519SignatureBase64Url(action.signature),
  };
}
