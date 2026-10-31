// The Hyperliquid submitter with actions the replay contract signed using the public test key, and /exchange and
// /info answered by a stub: what is posted, how a fill becomes a TxRef, and what is never posted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HlOrder } from '../contract/types.ts';
import { HlExchangeError, HyperliquidSubmitter } from './hyperliquid.ts';
import type { StubCall } from './test-helpers.ts';
import { TEST_EVM_ADDRESS, fakeTime, stubFetch, testContract } from './test-helpers.ts';
import { NothingExecuted } from './tx.ts';

const T0 = 1_793_491_200_000;
const ORDER: HlOrder = { asset: 1, is_buy: true, px: '2510', sz: '0.01', reduce_only: false, tif: 'Ioc', cloid: null };
const FILL_HASH = `0x${'ab'.repeat(32)}`;

function setup(route: (call: StubCall, infoCalls: number) => unknown) {
  const time = fakeTime(T0);
  let info = 0;
  const stub = stubFetch((call) => (call.url.endsWith('/info') ? route(call, ++info) : route(call, 0)));
  const hl = new HyperliquidSubmitter({ network: 'testnet', fetch: stub.fetch, clock: time.clock, sleep: time.sleep, pollMs: 1_000, confirmMs: 10_000 });
  return { contract: testContract(time.now), hl, calls: stub.calls, time };
}

const okOrder = (status: unknown) => ({ status: 'ok', response: { type: 'order', data: { statuses: [status] } } });

test('an IOC that fills: posted as signed, confirmed in userFillsByTime, returned with its transaction', async () => {
  const { contract, hl, calls } = setup((call, n) => {
    if (call.url.endsWith('/exchange')) return okOrder({ filled: { totalSz: '0.01', avgPx: '2500.1', oid: 77 } });
    // The fill shows up on the second look.
    return n === 1 ? [] : [{ coin: 'ETH', px: '2500.1', sz: '0.01', side: 'B', time: T0 + 500, hash: FILL_HASH, oid: 77, fee: '0.01' }];
  });
  const signed = await contract.hlOrder('alpha', ORDER, 'enter');
  const result = await hl.submit(signed, TEST_EVM_ADDRESS);
  assert.equal(calls[0]!.url, 'https://api.hyperliquid-testnet.xyz/exchange');
  const posted = calls[0]!.json as Record<string, unknown>;
  assert.deepEqual(posted.action, signed.payload.action);
  assert.equal(posted.nonce, signed.payload.nonce);
  assert.equal(posted.vaultAddress, null);
  assert.match(String((posted.signature as { r: string }).r), /^0x[0-9a-f]{64}$/);
  assert.ok([27, 28].includes((posted.signature as { v: number }).v));
  const info = calls[1]!.json as Record<string, unknown>;
  assert.deepEqual(info, { type: 'userFillsByTime', user: TEST_EVM_ADDRESS.toLowerCase(), startTime: T0 - 60_000, aggregateByTime: false });
  assert.equal(result.oid, 77);
  assert.deepEqual(result.filled, { totalSz: '0.01', avgPx: '2500.1' });
  assert.equal(result.confirmed, true);
  assert.equal(result.fills.length, 1);
  assert.deepEqual(result.tx, [{ chain: 'hyperliquid', id: FILL_HASH, url: `https://app.hyperliquid-testnet.xyz/explorer/tx/${FILL_HASH}` }]);
});

test('an IOC with no match is NothingExecuted; a resting Gtc is reported as resting', async () => {
  const noMatch = setup(() => okOrder({ error: 'Order could not immediately match against any resting orders. asset=1' }));
  await assert.rejects(noMatch.hl.submit(await noMatch.contract.hlOrder('alpha', ORDER, 'enter'), TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof NothingExecuted);
    assert.match(err.message, /hyperliquid: nothing executed: Order could not immediately match/);
    return true;
  });
  const rest = setup(() => okOrder({ resting: { oid: 9 } }));
  const r = await rest.hl.submit(await rest.contract.hlOrder('alpha', { ...ORDER, tif: 'Gtc' }, 'quote'), TEST_EVM_ADDRESS);
  assert.equal(r.resting, true);
  assert.equal(r.oid, 9);
  assert.equal(rest.calls.length, 1);
});

test('a signature that does not recover to the desk is never posted', async () => {
  const { contract, hl, calls } = setup(() => okOrder({ resting: { oid: 1 } }));
  const signed = await contract.hlOrder('alpha', ORDER, 'enter');
  await assert.rejects(hl.submit(signed, '0x000000000000000000000000000000000000dEaD'), /nothing posted/);
  // A payload changed after signing recovers to someone else too.
  const tampered = { ...signed, payload: { ...signed.payload, nonce: signed.payload.nonce + 1 } };
  await assert.rejects(hl.submit(tampered, TEST_EVM_ADDRESS), /nothing posted/);
  assert.equal(calls.length, 0);
});

test('Hyperliquid refusing the whole action is HlExchangeError with its message', async () => {
  const { contract, hl } = setup(() => ({ status: 'err', response: 'User or API Wallet 0x1a64 does not exist.' }));
  await assert.rejects(hl.submit(await contract.hlOrder('alpha', ORDER, 'enter'), TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof HlExchangeError);
    assert.match(err.message, /refused: User or API Wallet 0x1a64 does not exist/);
    return true;
  });
});

test('usdClassTransfer: user-signed, confirmed by its ledger entry', async () => {
  const LEDGER_HASH = `0x${'cd'.repeat(32)}`;
  const { contract, hl, calls } = setup((call) => {
    if (call.url.endsWith('/exchange')) return { status: 'ok', response: { type: 'default' } };
    return [
      { time: T0 + 100, hash: `0x${'00'.repeat(32)}`, delta: { type: 'accountClassTransfer', usdc: '25.0', toPerp: true } },
      { time: T0 + 200, hash: LEDGER_HASH, delta: { type: 'accountClassTransfer', usdc: '25.0', toPerp: true } },
    ];
  });
  const signed = await contract.hlUsdClassTransfer('alpha', '25', true, 'margin to perp');
  assert.equal(signed.payload.action.hyperliquidChain, 'Testnet');
  const result = await hl.submit(signed, TEST_EVM_ADDRESS);
  assert.equal((calls[1]!.json as { type: string }).type, 'userNonFundingLedgerUpdates');
  assert.deepEqual(result.tx.map((t) => t.id), [LEDGER_HASH]);
  assert.equal(result.confirmed, true);
  // A user-signed action for the other network is refused before anything is posted.
  const mainnet = new HyperliquidSubmitter({ network: 'mainnet', fetch: stubFetch(() => ({})).fetch });
  await assert.rejects(mainnet.submit(signed, TEST_EVM_ADDRESS), /Testnet/);
});

test('cancel: an error status is NothingExecuted', async () => {
  const { contract, hl } = setup(() => ({ status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled. asset=1' }] } } }));
  await assert.rejects(hl.submit(await contract.hlCancel('alpha', 1, 77, 'stop'), TEST_EVM_ADDRESS), NothingExecuted);
});
