// The five MCP tool handlers (DeskTools) against a fake contract, a fake NEAR transport and a fetch stub: a read of
// the desk, a signed order posted and not posted, a refusal carrying the contract's code and tx, a withdraw to the
// desk's own address only, and try_attack both dry and sent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NearCallOutcome, NearTransport } from '../contract/near-client.ts';
import { checkHlOrder } from '../contract/replay-checks.ts';
import type { Eip3009SignedAction, DeskView, HlOrder, HlSignedAction, SignedQuote, StoredPrice } from '../contract/types.ts';
import { ContractRefusal } from '../contract/types.ts';
import type { HlPoster, ToolAnswer } from './desk-tools.ts';
import { DeskTools, summariseHl } from './desk-tools.ts';

/** A tool answer as a plain record, for reading fields in assertions. */
const fields = (a: ToolAnswer): Record<string, unknown> => a as unknown as Record<string, unknown>;

const POLICY = JSON.parse(readFileSync(new URL('../../../tools/testnet-policy.json', import.meta.url), 'utf8'));
const DESK_EVM = '0x6dc11a853ca5afaa44fb926bf26ff0b3950928cb';
const SIG = { scheme: 'Secp256k1' as const, big_r: { affine_point: `02${'11'.repeat(32)}` }, s: { scalar: '22'.repeat(32) }, recovery_id: 0 };
const nearTx = { chain: 'near' as const, id: 'txSign', url: 'https://testnet.nearblocks.io/txns/txSign' };

function desk(overrides: Partial<DeskView> = {}): DeskView {
  return {
    owner: 'gimbal-owner-fcf135.testnet', operator: 'gimbal-owner-fcf135.testnet', paused: false, policy: POLICY, evm_address: DESK_EVM,
    solana: { authority: '3CfwbY27qA1UBukpcqEYfjCxHYkU6dpA3dkUraLdHcTB', usdc_ata: '', phusd_ata: '', phoenix_trader: '' },
    orderly_receiver: null, ledger: { deposited: 10, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 10 }, ...overrides,
  };
}

const action = (kind: string): HlSignedAction => ({ desk_id: 'final-1', request_id: 1, venue: 'hyperliquid', kind, payload: { action: { type: 'order' }, nonce: 1 }, signature: SIG, nearTx });

class FakeContract {
  async getDesk(): Promise<DeskView | null> {
    return desk();
  }
  async prices(): Promise<StoredPrice[]> {
    return [{ asset: 'ETH', price_e8: '250000000000', at_ms: 1 }];
  }
  async hlOrder(_d: string, order: HlOrder): Promise<HlSignedAction> {
    checkHlOrder(POLICY, order, () => null);
    return action('order');
  }
  async hlWithdraw(_d: string, amount: string): Promise<HlSignedAction> {
    if (Number(amount) < 10) throw new ContractRefusal('E_SIZE', `operator hl_withdraw ${amount} is under the 10 USDC minimum`, 'txWd');
    return action('withdraw3');
  }
  async fundVenue(_d: string, quote: SignedQuote): Promise<[]> {
    if (!quote.quote_signature.startsWith('ed25519:')) throw new ContractRefusal('E_QUOTE_SIGNATURE', 'not a signature', 'txFund');
    return [];
  }
  async evmUsdcToIntents(): Promise<Eip3009SignedAction> {
    return {
      desk_id: 'final-1', request_id: 1, venue: 'arbitrum', kind: 'transfer_with_authorization',
      payload: { from: DESK_EVM, to: DESK_EVM, value: '1', validAfter: '0', validBefore: '1', nonce: '0x', token: '0x', chainId: 42161 }, signature: SIG, nearTx,
    };
  }
  async orderlyRequest(): Promise<never> {
    throw new ContractRefusal('E_PRICE_BAND', 'market', 'txOrderly');
  }
}

const transport: NearTransport = {
  accountId: 'gimbal-owner-fcf135.testnet',
  async call(): Promise<NearCallOutcome> {
    return { txHash: 'tx', ok: true, value: null };
  },
  async view<T>(_c: string, method: string): Promise<T> {
    return (method === 'get_desk_counters' ? { notional_cap_usd: 750, notional_left_e8: '75000000000', rescue_cap_left_e8: '2000000000' } : null) as T;
  },
  async account() {
    return { amount: 5n * 10n ** 24n, locked: 0n, storageUsage: 0 };
  },
  async allowance() {
    return 10n ** 24n;
  },
};

const hl: HlPoster = {
  async submit() {
    return { kind: 'order', statuses: [{ resting: { oid: 7 } }], oid: 7, filled: null, resting: true, fills: [], tx: [nearTx], confirmed: true, expiresAfter: null };
  },
};

/** /info answers: clearinghouseState for read_desk. */
const fetchStub: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  if (String(url).endsWith('/info') && body.type === 'clearinghouseState') {
    return new Response(JSON.stringify({ marginSummary: { accountValue: '12.3' }, withdrawable: '10.0', assetPositions: [] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
}) as typeof fetch;

function tools() {
  return new DeskTools({
    network: 'testnet', contractId: 'gimbal-final-fcf135.testnet', deskId: 'final-1',
    contract: new FakeContract(), transport, hl, oneClick: { async quote() { return { ok: false, status: 400, message: 'no quote' }; } },
    fetch: fetchStub, now: () => 1_762_000_000_000,
  });
}

test('read_desk returns the policy, ledger, meters and Hyperliquid account', async () => {
  const a = await tools().status();
  assert.equal(a.ok, true);
  assert.equal(fields(a).desk_id, 'final-1');
  assert.deepEqual(fields(a).ledger_usdc_e6, desk().ledger);
  assert.equal((fields(a).meters as { hourly_notional_cap_usd: number }).hourly_notional_cap_usd, 750);
  assert.deepEqual((fields(a).hyperliquid as { positions: unknown[] }).positions, []);
});

test('place_hl_order with post:false signs through the contract and does not post', async () => {
  const a = await tools().placeOrder({ symbol: 'BTC', side: 'buy', price: '100000', size: '0.0001', post: false });
  assert.equal(a.ok, true);
  assert.equal(fields(a).posted, false);
  assert.equal(fields(a).tx, 'txSign');
});

test('place_hl_order posts the signed order to Hyperliquid when post is not false', async () => {
  const a = await tools().placeOrder({ symbol: 'BTC', side: 'buy', price: '100000', size: '0.0001' });
  assert.equal(a.ok, true);
  assert.equal(fields(a).posted, true);
  assert.equal((fields(a).hyperliquid as { oid: number }).oid, 7);
});

test('an order outside the policy comes back as the contract\'s refusal with its code and tx', async () => {
  const a = await tools().placeOrder({ symbol: '99', side: 'buy', price: '1', size: '1' });
  assert.equal(a.ok, false);
  assert.equal(fields(a).refused, true);
  assert.equal(fields(a).code, 'E_ASSET');
});

test('withdraw under the operator minimum is refused E_SIZE', async () => {
  const a = await tools().withdraw({ amount: '1', post: false });
  assert.equal(a.ok, false);
  assert.equal(fields(a).code, 'E_SIZE');
  assert.equal(fields(a).tx, 'txWd');
});

test('fund_venue with a bad signature is refused E_QUOTE_SIGNATURE', async () => {
  const a = await tools().fundVenue({ quote: '{"amountIn":"1000000"}', quote_signature: 'not-a-sig' });
  assert.equal(a.ok, false);
  assert.equal(fields(a).code, 'E_QUOTE_SIGNATURE');
});

test('try_attack dry builds the request and sends nothing', async () => {
  const a = await tools().tryAttack({ attack: 'over-size', dry: true });
  assert.equal(a.ok, true);
  assert.equal(fields(a).outcome, 'dry');
  assert.equal(fields(a).expected, 'E_SIZE');
});

test('try_attack asset is refused E_ASSET and reports it did not get through', async () => {
  const a = await tools().tryAttack({ attack: 'asset' });
  assert.equal(fields(a).outcome, 'refused');
  assert.equal(fields(a).code, 'E_ASSET');
  assert.equal(fields(a).pass, true);
  assert.equal(fields(a).got_through, false);
});

test('try_attack refuses the hourly-meter attack whatever the schema allowed: it signs real orders', async () => {
  const a = await tools().tryAttack({ attack: 'hourly-meter' });
  assert.equal(a.ok, false);
  assert.match(String(fields(a).error), /signs real orders/);
});

test('summariseHl pulls account value, withdrawable and positions', () => {
  const s = summariseHl({ marginSummary: { accountValue: '5' }, withdrawable: '4', assetPositions: [{ position: { coin: 'BTC', szi: '0.1' } }] });
  assert.deepEqual(s, { account_value: '5', withdrawable: '4', positions: [{ coin: 'BTC', size: '0.1', entry_px: undefined, unrealized_pnl: undefined, liquidation_px: undefined }] });
});
