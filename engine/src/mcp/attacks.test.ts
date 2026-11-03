// The attack runner against a contract test double that models the refusals the real contract gives: an over-size
// and an out-of-policy order (real checkHlOrder), a bad 1Click signature, another desk's quote, the extra-arg and
// out-of-key-list methods, an Orderly MARKET order and the hourly meter. It checks each row's outcome, code and tx,
// the before/after ledger check, that a dry run sends nothing, and that anything but the exact refusal is a FAIL.
//
// Four rows are hand-modelled in FakeContract / fakeTransport rather than run by real contract code: the hourly meter
// (its cap and message), the quote-fields check after the real signature check, the Orderly MARKET refusal, and the
// node's and near-sdk's answers to set_policy / set_paused / hl_withdraw with `destination`. Their messages copy the
// contract's (contract/core/src/limits.rs, contract/src/deposit.rs); the contract's own tests are the proof.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NearCallOutcome } from '../contract/near-client.ts';
import { checkHlOrder } from '../contract/replay-checks.ts';
import type { Eip3009SignedAction, DeskView, HlOrder, HlSignedAction, SignedQuote, StoredPrice } from '../contract/types.ts';
import { ContractRefusal } from '../contract/types.ts';
import { checkQuoteSignature } from '../rescue/oneclick.ts';
import type { AttackContract, AttackDeps } from './attacks.ts';
import { ATTACKS, NODE_METHOD, fakeQuote, held, hlPx, keyProblems, ledgerMoved, recordedQuote, report, runAttacks } from './attacks.ts';
import { deskEnv, loadOperatorKey } from './env.ts';

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
  /** Set: every action method refuses with E_PAUSED, the wrong code for every row. */
  pausedAll = false;
  constructor(d: DeskView, prices: StoredPrice[] = []) {
    this.#desk = d;
    this.#prices = prices;
  }
  #paused(): void {
    if (this.pausedAll) throw new ContractRefusal('E_PAUSED', 'desk final-1 is paused', 'txPaused');
  }
  async getDesk(): Promise<DeskView | null> {
    return this.#desk;
  }
  async prices(): Promise<StoredPrice[]> {
    return this.#prices;
  }
  async hlOrder(_deskId: string, order: HlOrder): Promise<HlSignedAction> {
    this.#paused();
    checkHlOrder(this.#desk.policy, order, (s) => { const p = this.#prices.find((x) => x.asset === s); return p === undefined ? null : BigInt(p.price_e8); });
    if (!order.reduce_only) {
      // Hand-modelled hourly meter: an unpriced order at max_sz counts the unpriced cap; the cap is
      // max_hourly_notional_usd, else 15 x max_notional_usd. The message copies contract/core/src/limits.rs.
      const p = this.#desk.policy;
      const u = p.unpriced.find((x) => x.symbol === p.hl_assets.find((a) => a.index === order.asset)?.symbol);
      const per = u === undefined ? Number(order.px) * Number(order.sz) : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
      const cap = p.max_hourly_notional_usd ?? p.max_notional_usd * 15;
      if (this.#meterUsd + per > cap) {
        throw new ContractRefusal('E_SIZE', `hl_order: ${per} USD of notional is over what is left of max_hourly_notional_usd ${cap} in the sliding hour, ${cap - this.#meterUsd} USD`, 'txMeter');
      }
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
    this.#paused();
    this.#verifyQuote(quote, 'fund_venue');
    this.signed.push({ method: 'fund_venue' });
    return [];
  }
  async evmUsdcToIntents(_deskId: string, quote: SignedQuote): Promise<Eip3009SignedAction> {
    this.#paused();
    this.#verifyQuote(quote, 'evm_usdc_to_intents');
    this.signed.push({ method: 'evm_usdc_to_intents' });
    return eip3009Action();
  }
  async orderlyRequest(_deskId: string, req: { order_type?: string | null }): Promise<never> {
    this.#paused();
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

/**
 * Hand-modelled node and near-sdk answers: the node refuses a method outside the operator key's list (set_policy),
 * near-sdk refuses an unknown argument (hl_withdraw `destination`), the contract refuses set_paused(false) without
 * 1 yoctoNEAR. `fail`, when set, is thrown for every call (a spent allowance, a dead RPC).
 */
function fakeTransport(signed: { method: string }[], o: { fail?: Error; counters?: Record<string, unknown> } = {}): AttackDeps['transport'] {
  return {
    async view<T>(_contract: string, method: string): Promise<T> {
      return (method === 'get_desk_counters' ? o.counters ?? null : null) as T;
    },
    async call(_contract: string, method: string, args: object): Promise<NearCallOutcome> {
      if (o.fail !== undefined) throw o.fail;
      if (method === 'set_paused' && (args as { paused?: boolean }).paused === false) {
        return { txHash: 'txPause', ok: false, failure: 'Smart contract panicked: E_NOT_ALLOWED: set_paused(false) needs exactly 1 yoctoNEAR attached, which only the owner\'s wallet can attach; attached 0' };
      }
      if (method === 'set_policy') {
        const err = new Error(`AccessKeyMethodNameMismatchError: the access key does not allow method ${method}`);
        err.name = 'AccessKeyMethodNameMismatchError';
        throw err;
      }
      if (method === 'hl_withdraw' && 'destination' in (args as object)) {
        return { txHash: 'txArgs', ok: false, failure: 'Smart contract panicked: Failed to deserialize input from JSON. Error: `unknown field `destination`, expected `desk_id` or `amount`` at line 1 column 40' };
      }
      signed.push({ method });
      return { txHash: 'txUnexpected', ok: true, value: null };
    },
  };
}

/** A keyless Hyperliquid /info double: a BTC mid, and the desk's account value (`accountValue` in turn per read). */
function hlInfo(accountValues: string[] = ['12.5']) {
  let reads = 0;
  return async (body: object): Promise<unknown> => {
    const b = body as { type: string };
    if (b.type === 'allMids') return { BTC: '100000', ETH: '3000', SOL: '150' };
    if (b.type === 'clearinghouseState') return { marginSummary: { accountValue: accountValues[Math.min(reads++, accountValues.length - 1)] } };
    return null;
  };
}

function deps(contract: FakeContract, o: Parameters<typeof fakeTransport>[1] & { accountValues?: string[] } = {}): AttackDeps {
  return {
    network: 'testnet', contractId: 'gimbal-final-fcf135.testnet', deskId: 'final-1', contract,
    transport: fakeTransport(contract.signed, o), hlInfo: hlInfo(o.accountValues), now: () => 1_762_000_000_000,
  };
}

const WHERE = { network: 'testnet' as const, contractId: 'gimbal-final-fcf135.testnet', deskId: 'final-1' };

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
  assert.equal(by.get('owner-method')!.code, NODE_METHOD);
  assert.equal(by.get('owner-method')!.tx, null);
  assert.equal(by.get('unpause')!.code, 'E_NOT_ALLOWED');
  assert.equal(by.get('unpause')!.tx, 'txPause');
  assert.equal(by.get('orderly-market')!.code, 'E_PRICE_BAND');

  // The meter attack is skipped without --meter, and a skipped row is neither PASS nor FAIL.
  assert.equal(by.get('hourly-meter')!.outcome, 'skipped');
  assert.equal(by.get('hourly-meter')!.pass, null);
  // Every row that ran got exactly its refusal; nothing was signed; neither the NEAR ledger nor the HL account moved.
  assert.ok(run.results.filter((r) => r.pass !== null).every((r) => r.pass === true), JSON.stringify(run.results.filter((r) => r.pass !== true)));
  assert.deepEqual(contract.signed, []);
  assert.equal(run.ledger.hlBeforeE6, 12_500_000n);
  assert.equal(run.ledger.movedE6, 0n);
  assert.equal(held(run, [], true), true);
});

test('FAIL: a wrong code (E_PAUSED where E_SIZE is expected) fails the row and the run, and prints what came back', async () => {
  const contract = new FakeContract(desk());
  contract.pausedAll = true;
  const run = await runAttacks(deps(contract), { dry: false, meter: false, only: ['over-size'] });
  const r = run.results[0]!;
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, 'E_PAUSED');
  assert.equal(r.pass, false);
  assert.equal(held(run), false);
  assert.match(report(run, WHERE, false).join('\n'), /FAIL .*\n\s+got E_PAUSED: desk final-1 is paused\n/);
});

test('FAIL: the right code with the wrong message is not a pass (withdraw-destination must name `destination`)', async () => {
  const contract = new FakeContract(desk());
  const t = fakeTransport(contract.signed);
  const d: AttackDeps = { ...deps(contract), transport: { ...t, call: async () => ({ txHash: 'txOther', ok: false, failure: 'Failed to deserialize input from JSON. Error: missing field `amount`' }) } };
  const run = await runAttacks(d, { dry: false, meter: false, only: ['withdraw-destination'] });
  assert.equal(run.results[0]!.code, 'E_ARGS');
  assert.equal(run.results[0]!.pass, false);
});

test('FAIL: an exhausted allowance is a node rejection, never a pass, and the preflight says so', async () => {
  const contract = new FakeContract(desk());
  const spent = new Error('NotEnoughAllowance: the access key does not have enough allowance for this transaction');
  spent.name = 'NotEnoughAllowanceError';
  const run = await runAttacks(deps(contract, { fail: spent }), { dry: false, meter: false, only: ['owner-method', 'withdraw-destination', 'unpause'] });
  for (const r of run.results) {
    assert.equal(r.outcome, 'rejected', r.id);
    assert.equal(r.code, 'NODE_NotEnoughAllowance', r.id);
    assert.equal(r.pass, false, r.id);
  }
  assert.equal(held(run), false);
  // The CLI's preflight: a low allowance, an unlimited key, a key that is not on chain are all top-level FAILs.
  assert.match((await keyProblems(async () => 10n ** 23n))[0]!, /allowance is 0.1 NEAR, under 0.3 NEAR/);
  assert.match((await keyProblems(async () => null))[0]!, /no allowance/);
  assert.match((await keyProblems(async () => { throw new Error('access key does not exist'); }))[0]!, /not on chain/);
  assert.deepEqual(await keyProblems(async () => 10n ** 24n), []);
  assert.equal(held(run, ['the key is missing']), false);
});

test('FAIL: an RPC error is an error row, not a pass', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract, { fail: new Error('fetch failed: ECONNRESET') }), { dry: false, meter: false, only: ['owner-method', 'unpause'] });
  for (const r of run.results) {
    assert.equal(r.outcome, 'error', r.id);
    assert.equal(r.pass, false, r.id);
  }
  assert.match(report(run, WHERE, false).join('\n'), /got error: fetch failed: ECONNRESET/);
  assert.equal(held(run), false);
});

test('FAIL: USDC that moved on the Hyperliquid account fails the run even when every row passed', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract, { accountValues: ['12.5', '2.5'] }), { dry: false, meter: false, only: ['over-size'] });
  assert.equal(run.results[0]!.pass, true);
  assert.equal(run.ledger.movedE6, 10_000_000n);
  assert.equal(held(run, [], true), false);
  assert.match(report(run, WHERE, false).join('\n'), /Hyperliquid account value 12.5 -> 2.5 USDC\n10 USDC moved \(NEAR ledger \+ Hyperliquid account\)/);
});

test('FAIL: mainnet needs --mainnet, and the key file must be for the target network', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const mainnet = { NEAR_NETWORK: 'mainnet', GIMBAL_CONTRACT_ID: 'gimbal.near', DESK_ID: 'd1' };
  assert.throws(() => deskEnv(env(mainnet)), /refusing mainnet without --mainnet/);
  assert.equal(deskEnv(env(mainnet), {}, { allowMainnet: true }).network, 'mainnet');
  assert.equal(deskEnv(env({ GIMBAL_CONTRACT_ID: 'gimbal.testnet', DESK_ID: 'd1' })).network, 'testnet');

  // A dummy key file (not a real key): its network field must match.
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-key-'));
  const file = join(dir, 'operator.json');
  writeFileSync(file, JSON.stringify({ account_id: 'owner.testnet', public_key: 'ed25519:dummy', private_key: 'ed25519:dummy', network: 'mainnet' }));
  assert.throws(() => loadOperatorKey(file, 'testnet'), /is a mainnet key, but the target network is testnet/);
  writeFileSync(file, JSON.stringify({ account_id: 'owner.testnet', public_key: 'ed25519:dummy', private_key: 'ed25519:dummy' }));
  assert.equal(loadOperatorKey(file, 'testnet').accountId, 'owner.testnet');
  assert.throws(() => loadOperatorKey(file, 'mainnet'), /is a testnet key/);
});

test('the foreign-quote attack uses the repo\'s recorded 1Click quote (real signature, another desk)', async () => {
  const q = recordedQuote();
  assert.ok(q !== null, 'oneclick-live.json has an evm_usdc_to_intents quote');
  // Its signature verifies (it is 1Click's), so the refusal is on the fields, not the signature.
  assert.doesNotThrow(() => checkQuoteSignature(q!.quote, q!.quote_signature));
});

test('--meter signs post-only orders up to the hourly cap, then the contract refuses on the meter', async () => {
  const contract = new FakeContract(desk());
  const plan = await ATTACKS.find((a) => a.id === 'hourly-meter')!.plan(desk(), deps(contract));
  assert.ok(!('skip' in plan));
  const order = (plan.args as { order: HlOrder }).order;
  // Post-only, a buy at half the BTC mid or lower: it cannot fill. sz = max_sz, so each counts the unpriced cap.
  assert.equal(order.tif, 'Alo');
  assert.equal(order.is_buy, true);
  assert.ok(Number(order.px) <= 50_000, order.px);
  assert.equal(plan.maxOrders, 16);

  const run = await runAttacks(deps(contract), { dry: false, meter: true, only: ['hourly-meter'] });
  const meter = run.results[0]!;
  assert.equal(meter.outcome, 'refused');
  assert.equal(meter.code, 'E_SIZE');
  // No max_hourly_notional_usd in the policy: cap 15 x 50 = 750, each order counts 50: 15 sign, the 16th is refused.
  assert.equal(meter.signed, 15);
  assert.equal(meter.pass, true);
  assert.equal(contract.signed.length, 15);
});

test('--meter reads the real cap: max_hourly_notional_usd and the counters view, not a hardcoded 15x', async () => {
  const policy = { ...POLICY, max_hourly_notional_usd: 200 };
  const contract = new FakeContract(desk({ policy }));
  // The counters say 100 of the 200 are left: 2 orders sign, the 3rd must be refused.
  const d = deps(contract, { counters: { notional_cap_usd: 200, notional_left_e8: String(100 * 1e8) } });
  const plan = await ATTACKS.find((a) => a.id === 'hourly-meter')!.plan(desk({ policy }), d);
  assert.ok(!('skip' in plan));
  assert.equal(plan.maxOrders, 3);
});

test('FAIL: a meter refusal on the very first order is not a pass (E_SIZE is shared with the size check)', async () => {
  const policy = { ...POLICY, max_hourly_notional_usd: 10 };
  const contract = new FakeContract(desk({ policy }));
  // The counters claim room for 15 orders, but the contract refuses the first: nothing was shown about the meter.
  const run = await runAttacks(deps(contract, { counters: { notional_cap_usd: 750, notional_left_e8: String(750 * 1e8) } }), { dry: false, meter: true, only: ['hourly-meter'] });
  assert.equal(run.results[0]!.code, 'E_SIZE');
  assert.equal(run.results[0]!.signed, 0);
  assert.equal(run.results[0]!.pass, false);
});

test('the meter never runs on mainnet', async () => {
  const contract = new FakeContract(desk());
  const plan = await ATTACKS.find((a) => a.id === 'hourly-meter')!.plan(desk(), { ...deps(contract), network: 'mainnet' });
  assert.ok('skip' in plan && /never on mainnet/.test(plan.skip));
});

test('a dry run builds every request and sends nothing', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: true, meter: true });
  assert.ok(run.results.every((r) => r.outcome === 'dry'));
  assert.deepEqual(contract.signed, []);
  // Every planned request names the code it expects.
  assert.deepEqual(
    run.results.map((r) => r.expect).sort(),
    ['E_ARGS', 'E_ASSET', 'E_NOT_ALLOWED', 'E_PRICE_BAND', 'E_QUOTE_FIELDS', 'E_QUOTE_SIGNATURE', 'E_SIZE', 'E_SIZE', NODE_METHOD].sort(),
  );
  assert.ok(run.results.every((r) => r.pass === null));
});

test('the report prints PASS per row, the NEAR ledger and the Hyperliquid account', async () => {
  const contract = new FakeContract(desk());
  const run = await runAttacks(deps(contract), { dry: false, meter: false });
  const text = report(run, WHERE, false).join('\n');
  assert.match(text, /PASS .*E_SIZE/);
  assert.match(text, /rejected before the chain, no tx/);
  assert.match(text, /NEAR ledger before/);
  assert.match(text, /Hyperliquid account value 12.5 -> 12.5 USDC/);
  assert.match(text, /0 USDC moved \(NEAR ledger \+ Hyperliquid account\)/);
  assert.doesNotMatch(text, /FAIL/);
  // A top-level problem (no key, no allowance) is printed as FAIL.
  assert.match(report(run, WHERE, false, ['no allowance']).join('\n'), /^FAIL: no allowance$/m);
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

test('ATTACKS has the eight named attacks plus the meter', () => {
  assert.deepEqual(ATTACKS.map((a) => a.id), ['over-size', 'asset', 'withdraw-destination', 'fake-quote', 'foreign-quote', 'owner-method', 'unpause', 'orderly-market', 'hourly-meter']);
});
