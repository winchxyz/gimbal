// The attack runner against a contract test double that models the refusals the real contract gives: an over-size
// and an out-of-policy order (real checkHlOrder), a bad 1Click signature, another desk's quote, the extra-arg and
// out-of-key-list methods, an Orderly MARKET order and the hourly meter. It checks each row's outcome, code and tx,
// the before/after ledger check, and that a dry run sends nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { NearCallOutcome } from '../contract/near-client.ts';
import { checkHlOrder } from '../contract/replay-checks.ts';
import type { Eip3009SignedAction, DeskView, HlOrder, HlSignedAction, SignedQuote, StoredPrice } from '../contract/types.ts';
import { ContractRefusal } from '../contract/types.ts';
import { checkQuoteSignature } from '../rescue/oneclick.ts';
import type { AttackContract, AttackDeps } from './attacks.ts';
import { ATTACKS, fakeQuote, hlPx, ledgerMoved, recordedQuote, report, runAttacks } from './attacks.ts';

const POLICY = JSON.parse(readFileSync(new URL('../../../tools/testnet-policy.json', import.meta.url), 'utf8'));
const DESK_EVM = '0x6dc11a853ca5afaa44fb926bf26ff0b3950928cb';

function desk(overrides: Partial<DeskView> = {}): DeskView {
  return {
    owner: 'gimbal-owner-fcf135.testnet', operator: 'gimbal-owner-fcf135.testnet', paused: false, policy: POLICY, evm_address: DESK_EVM,
    solana: { authority: '3CfwbY27qA1UBukpcqEYfjCxHYkU6dpA3dkUraLdHcTB', usdc_ata: '', phusd_ata: '', phoenix_trader: '' },
    orderly_receiver: null, ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 }, ...overrides,
  };
}

const SIG = { scheme: 'Secp256k1' as const, big_r: { affine_point: `02${'11'.repeat(32)}` }, s: { scalar: '22'.repeat(32) }, recovery_id: 0 };
const signedAction = (kind: string): HlSignedAction => ({ desk_id: 'final-1', request_id: 1, venue: 'hyperliquid', kind, payload: { action: { type: 'order' }, nonce: 1 }, signature: SIG });
const eip3009Action = (): Eip3009SignedAction => ({
  desk_id: 'final-1', request_id: 1, venue: 'arbitrum', kind: 'transfer_with_authorization',
  payload: { from: DESK_EVM, to: DESK_EVM, value: '1', validAfter: '0', validBefore: '1', nonce: '0x', token: '0x', chainId: 42161 }, signature: SIG,
});

/** A contract that refuses exactly what the gimbal contract refuses for each attack; it signs anything it would. */
class FakeContract implements AttackContract {
  signed: { method: string }[] = [];
  #desk: DeskView;
  #prices: StoredPrice[];
  #meterUsd = 0;
  constructor(d: DeskView, prices: StoredPrice[] = []) {
    this.#desk = d;
    this.#prices = prices;
  }
  async getDesk(): Promise<DeskView | null> {
    return this.#desk;
  }
  async prices(): Promise<StoredPrice[]> {
    return this.#prices;
  }
  async hlOrder(_deskId: string, order: HlOrder): Promise<HlSignedAction> {
    checkHlOrder(this.#desk.policy, order, (s) => { const p = this.#prices.find((x) => x.asset === s); return p === undefined ? null : BigInt(p.price_e8); });
    if (!order.reduce_only) {
      // The hourly notional meter: each unpriced meter order is worth about the cap slice; refuse over 15x max_notional.
      const u = this.#desk.policy.unpriced.find((x) => x.symbol === this.#desk.policy.hl_assets.find((a) => a.index === order.asset)?.symbol);
      const cap = Math.min(this.#desk.policy.max_notional_usd, this.#desk.policy.unpriced_max_notional_usd);
      const per = u === undefined ? Number(order.px) * Number(order.sz) : cap;
      if (this.#meterUsd + per > this.#desk.policy.max_notional_usd * 15) throw new ContractRefusal('E_SIZE', `order takes the hourly notional meter over ${this.#desk.policy.max_notional_usd * 15} USD`, 'txMeter');
      this.#meterUsd += per;
    }
    this.signed.push({ method: 'hl_order' });
    return signedAction('order');
  }
  async hlWithdraw(): Promise<HlSignedAction> {
    this.signed.push({ method: 'hl_withdraw' });
    return signedAction('withdraw3');
  }
  async fundVenue(_deskId: string, quote: SignedQuote): Promise<[]> {
    this.#verifyQuote(quote, 'fund_venue');
    this.signed.push({ method: 'fund_venue' });
    return [];
  }
  async evmUsdcToIntents(_deskId: string, quote: SignedQuote): Promise<Eip3009SignedAction> {
    this.#verifyQuote(quote, 'evm_usdc_to_intents');
    this.signed.push({ method: 'evm_usdc_to_intents' });
    return eip3009Action();
  }
  async orderlyRequest(_deskId: string, req: { order_type?: string | null }): Promise<never> {
    if (req.order_type === 'MARKET') throw new ContractRefusal('E_PRICE_BAND', 'a MARKET order has no price limit', 'txMarket');
    throw new ContractRefusal('E_ARGS', 'unexpected', 'txOrderly');
  }
  /** The contract's first two quote steps: the signature over the exact string, then the recipient/refund fields. */
  #verifyQuote(quote: SignedQuote, method: 'fund_venue' | 'evm_usdc_to_intents'): void {
    const str = String(quote.quote);
    try {
      checkQuoteSignature(str, quote.quote_signature);
    } catch (e) {
      throw new ContractRefusal('E_QUOTE_SIGNATURE', (e as Error).message, 'txQuoteSig');
    }
    const f = JSON.parse(str) as Record<string, unknown>;
    const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    const refundOk = method === 'fund_venue' ? f.refundTo === this.#desk.owner : same(f.refundTo, this.#desk.evm_address);
    const recipientOk = same(f.recipient, this.#desk.evm_address) || f.recipient === this.#desk.solana.authority || (this.#desk.orderly_receiver !== null && same(f.recipient, this.#desk.orderly_receiver));
    if (!refundOk || !recipientOk) throw new ContractRefusal('E_QUOTE_FIELDS', 'refundTo or recipient is not this desk', 'txQuoteFields');
  }
}

/** The node refuses a call whose method is not in the operator key's list (set_policy), and E_ARGS on an extra arg. */
function fakeTransport(signed: { method: string }[]): AttackDeps['transport'] {
  return {
    async call(_contract: string, method: string, args: object): Promise<NearCallOutcome> {
      if (method === 'set_policy') {
        const err = new Error(`AccessKeyMethodNameMismatchError: the access key does not allow method ${method}`);
        err.name = 'AccessKeyMethodNameMismatchError';
        throw err;
      }
      if (method === 'hl_withdraw' && 'destination' in (args as object)) {
        return { txHash: 'txArgs', ok: false, failure: '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Failed to deserialize input from JSON."}}}}' };
      }
      signed.push({ method });
      return { txHash: 'txUnexpected', ok: true, value: null };
    },
  };
}

function deps(contract: FakeContract, prices: StoredPrice[] = []): AttackDeps {
  return { network: 'testnet', contractId: 'gimbal-final-fcf135.testnet', deskId: 'final-1', contract, transport: fakeTransport(contract.signed), now: () => 1_762_000_000_000, prices } as AttackDeps;
}

test('hlPx keeps Hyperliquid price rules (integer above 10k, 5 sig figs below)', () => {
  assert.equal(hlPx(100000, 5), '100000');
  assert.equal(hlPx(103.5, 2), '103.5');
  assert.equal(hlPx(0.4, 2), '0.4');
});

test('every attack is refused and nothing is signed, so no USDC moves', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: false, meter: false });
  const by = new Map(run.results.map((r) => [r.id, r]));

  assert.equal(by.get('over-size')!.code, 'E_SIZE');
  assert.equal(by.get('over-size')!.outcome, 'refused');
  assert.equal(by.get('asset')!.code, 'E_ASSET');
  assert.equal(by.get('withdraw-destination')!.code, 'E_ARGS');
  assert.equal(by.get('withdraw-destination')!.tx, 'txArgs');
  assert.equal(by.get('fake-quote')!.code, 'E_QUOTE_SIGNATURE');
  assert.equal(by.get('foreign-quote')!.code, 'E_QUOTE_FIELDS');
  assert.equal(by.get('owner-method')!.outcome, 'rejected');
  assert.equal(by.get('owner-method')!.tx, null);
  assert.equal(by.get('orderly-market')!.code, 'E_PRICE_BAND');

  // The meter attack is skipped without --meter.
  assert.equal(by.get('hourly-meter')!.outcome, 'skipped');
  // Nothing got through, nothing was signed, the ledger did not move.
  assert.ok(run.results.every((r) => r.outcome !== 'signed'));
  assert.deepEqual(contract.signed, []);
  assert.equal(run.ledger.movedE6, 0n);
});

test('the foreign-quote attack uses the repo\'s recorded 1Click quote (real signature, another desk)', async () => {
  const q = recordedQuote();
  assert.ok(q !== null, 'oneclick-live.json has an evm_usdc_to_intents quote');
  // Its signature verifies (it is 1Click's), so the refusal is on the fields, not the signature.
  assert.doesNotThrow(() => checkQuoteSignature(q!.quote, q!.quote_signature));
});

test('--meter signs orders up to the hourly cap, then the contract refuses with E_SIZE', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: false, meter: true, only: ['hourly-meter'] });
  const meter = run.results[0]!;
  assert.equal(meter.outcome, 'refused');
  assert.equal(meter.code, 'E_SIZE');
  // max_notional_usd 50, cap 15x = 750, each order worth ~50: 15 sign, the 16th is refused.
  assert.equal(meter.signed, 15);
  assert.equal(contract.signed.length, 15);
});

test('a dry run builds every request and sends nothing', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: true, meter: true });
  assert.ok(run.results.every((r) => r.outcome === 'dry'));
  assert.deepEqual(contract.signed, []);
  // Every planned request names the code it expects.
  assert.deepEqual(
    run.results.map((r) => r.expect).sort(),
    ['E_ARGS', 'E_ASSET', 'E_PRICE_BAND', 'E_QUOTE_FIELDS', 'E_QUOTE_SIGNATURE', 'E_SIZE', 'E_SIZE', 'NODE'].sort(),
  );
});

test('the report prints a row per attack and the ledger check', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: false, meter: false });
  const text = report(run, { network: 'testnet', contractId: 'gimbal-final-fcf135.testnet', deskId: 'final-1' }, false).join('\n');
  assert.match(text, /E_SIZE/);
  assert.match(text, /rejected before the chain, no tx/);
  assert.match(text, /0 USDC moved/);
});

test('fakeQuote is signed by a key that is not 1Click\'s, so its signature fails', () => {
  const q = fakeQuote('owner.testnet', 1_762_000_000_000);
  assert.throws(() => checkQuoteSignature(q.quote, q.quote_signature), /E_QUOTE_SIGNATURE/);
});

test('ledgerMoved sums the absolute change across ledger fields', () => {
  const before = { deposited: 100, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 100 };
  const after = { deposited: 100, withdrawn: 10, fees_paid: 0, hwm: 0, idle_usdc: 90 };
  assert.equal(ledgerMoved(before, after), 20n);
});

test('ATTACKS has the seven named attacks plus the meter', () => {
  assert.deepEqual(ATTACKS.map((a) => a.id), ['over-size', 'asset', 'withdraw-destination', 'fake-quote', 'foreign-quote', 'owner-method', 'orderly-market', 'hourly-meter']);
});
