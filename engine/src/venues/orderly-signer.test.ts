import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrderlyRestAction } from './orderly-signer.ts';
import {
  ORDERLY_WS_AUTH_KIND, base58, checkEip712Action, checkRestAction, checkWsAuthAction, ed25519SignatureBase64Url, evmSignatureHex,
  isOrderlyKeyString, orderlyAuthHeaders, orderlyKeyString, orderlyRestMessage,
} from './orderly-signer.ts';

const NOW = Date.UTC(2026, 9, 31, 1);
const SIG = Array.from({ length: 64 }, (_, i) => (i * 37 + 251) % 256);

function restAction(over: Partial<OrderlyRestAction['payload']> = {}, kind = 'settle_nonce'): OrderlyRestAction {
  const payload = { method: 'GET', path: '/v1/settle_nonce', body: '', timestamp: NOW, ...over };
  return {
    desk_id: 'alpha', request_id: 7, venue: 'orderly', kind,
    payload: { ...payload, message: over.message ?? orderlyRestMessage(payload.timestamp, payload.method, payload.path, payload.body) },
    signature: { scheme: 'Ed25519', signature: SIG },
  };
}

test('base58 (Bitcoin alphabet), with leading zero bytes as 1s', () => {
  assert.equal(base58(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(base58(Uint8Array.from([0, 0, 1])), '112');
  assert.equal(base58(new Uint8Array(32)), '1'.repeat(32));
});

test('orderly key: "ed25519:" + base58 of the 32-byte public key', () => {
  const key = orderlyKeyString(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  assert.match(key, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.ok(isOrderlyKeyString(key));
  assert.ok(!isOrderlyKeyString('ed25519:0OIl'));
  assert.throws(() => orderlyKeyString(new Uint8Array(31)), /32 bytes/);
});

test('REST message = timestamp + METHOD + path (with query) + body, as Orderly verifies it', () => {
  assert.equal(orderlyRestMessage(1793408400000, 'get', '/v1/withdraw_nonce', ''), '1793408400000GET/v1/withdraw_nonce');
  assert.equal(orderlyRestMessage(1, 'POST', '/v1/settle_pnl', '{"a":1}'), '1POST/v1/settle_pnl{"a":1}');
});

test('orderly-signature header = base64url of the 64 signature bytes', () => {
  const s = ed25519SignatureBase64Url({ scheme: 'Ed25519', signature: SIG });
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.deepEqual([...Buffer.from(s, 'base64url')], SIG);
  assert.doesNotMatch(s, /[+/=]/);
  assert.throws(() => ed25519SignatureBase64Url({ scheme: 'Ed25519', signature: SIG.slice(1) }), /64 bytes/);
});

test('EIP-712 signature for Orderly = 0x + r (affine point without its prefix byte) + s + v (27 + recovery id)', () => {
  const sig = { scheme: 'Secp256k1' as const, big_r: { affine_point: `03${'ab'.repeat(32)}` }, s: { scalar: 'cd'.repeat(32) }, recovery_id: 1 };
  const hex = evmSignatureHex(sig);
  assert.equal(hex, `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1c`);
  assert.equal((hex.length - 2) / 2, 65);
  assert.equal(evmSignatureHex({ ...sig, recovery_id: 0 }).slice(-2), '1b');
  assert.equal(evmSignatureHex({ ...sig, s: { scalar: 'ff' } }).slice(66, 130), `${'0'.repeat(62)}ff`, 'a short s is left-padded');
  assert.throws(() => evmSignatureHex({ ...sig, big_r: { affine_point: 'ab'.repeat(33) } }), /compressed point/);
  assert.throws(() => evmSignatureHex({ ...sig, recovery_id: 2 }), /recovery id/);
});

test('a signed REST action is checked before sending: desk, kind, message, method and body, 300 s window', () => {
  checkRestAction(restAction(), 'settle_nonce', NOW + 1000, 'alpha');
  assert.throws(() => checkRestAction(restAction(), 'settle_nonce', NOW, 'beta'), /for desk alpha, not beta/);
  assert.throws(() => checkRestAction(restAction(), 'withdraw_nonce', NOW, 'alpha'), /asked for withdraw_nonce/);
  assert.throws(() => checkRestAction(restAction({ message: `${NOW}GET/v1/withdraw_nonce` }), 'settle_nonce', NOW, 'alpha'), /not timestamp \+ method/);
  assert.throws(() => checkRestAction(restAction({ body: '{}' }), 'settle_nonce', NOW, 'alpha'), /carries a body/);
  assert.throws(() => checkRestAction(restAction({ path: '/v2/x' }), 'settle_nonce', NOW, 'alpha'), /unexpected path/);
  assert.throws(() => checkRestAction(restAction(), 'settle_nonce', NOW + 300_001, 'alpha'), /outside 300 s/);
  assert.throws(() => checkRestAction({ ...restAction(), venue: 'hyperliquid' }, 'settle_nonce', NOW, 'alpha'), /for hyperliquid/);
});

test('a ws auth action signs the timestamp alone, for this desk, as kind ws_auth', () => {
  assert.equal(ORDERLY_WS_AUTH_KIND, 'ws_auth');
  const ok = restAction({ message: String(NOW) }, 'ws_auth');
  checkWsAuthAction(ok, NOW, NOW, 'alpha');
  assert.throws(() => checkWsAuthAction(ok, NOW + 1, NOW, 'alpha'), /asked to sign/);
  assert.throws(() => checkWsAuthAction(restAction({}, 'ws_auth'), NOW, NOW, 'alpha'), /not the timestamp/);
  assert.throws(() => checkWsAuthAction(ok, NOW, NOW, 'beta'), /for desk alpha, not beta/);
  assert.throws(() => checkWsAuthAction(restAction({ message: String(NOW) }, 'settle_nonce'), NOW, NOW, 'alpha'), /signed settle_nonce, not ws_auth/);
});

test('an EIP-712 action is for this desk and carries the nonce asked for (a number or its decimal string)', () => {
  const sig = { scheme: 'Secp256k1' as const, big_r: { affine_point: `02${'ab'.repeat(32)}` }, s: { scalar: 'cd'.repeat(32) }, recovery_id: 0 };
  const action = (message: Record<string, unknown>, desk = 'alpha') => ({
    desk_id: desk, request_id: 1, venue: 'orderly', kind: 'withdraw', payload: { message: { timestamp: NOW, ...message } }, signature: sig,
  });
  checkEip712Action(action({ withdrawNonce: 41 }), 'alpha', 'withdraw', { withdrawNonce: 41 });
  checkEip712Action(action({ withdrawNonce: '41' }), 'alpha', 'withdraw', { withdrawNonce: 41 });
  assert.throws(() => checkEip712Action(action({ withdrawNonce: 42 }), 'alpha', 'withdraw', { withdrawNonce: 41 }), /signed withdrawNonce 42, the engine asked for 41/);
  assert.throws(() => checkEip712Action(action({}), 'alpha', 'withdraw', { withdrawNonce: 41 }), /signed withdrawNonce undefined/);
  assert.throws(() => checkEip712Action(action({ withdrawNonce: 41 }, 'beta'), 'alpha', 'withdraw', { withdrawNonce: 41 }), /for desk beta, not alpha/);
});

test('the four headers of a private call', () => {
  const key = `ed25519:${'1'.repeat(32)}`;
  const h = orderlyAuthHeaders(restAction(), `0x${'0a'.repeat(32)}`, key);
  assert.deepEqual(Object.keys(h), ['orderly-timestamp', 'orderly-account-id', 'orderly-key', 'orderly-signature']);
  assert.equal(h['orderly-timestamp'], String(NOW));
  assert.equal(h['orderly-key'], key);
  assert.equal(h['orderly-signature'], Buffer.from(SIG).toString('base64url'));
});
