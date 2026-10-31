// Onboarding end to end: the controller against a fake wallet, a fake chain that applies transactions the way the
// contract does, and a stand-in engine. Every step the issue lists is here: create desk with the owner check after
// `get_desk`, the operator key with its method list, venue setup progress, rules drafted, edited and confirmed, the
// signature, `PUT /strategy`, the 503 path and the USD cap on an unpriced asset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressesFrom } from './derive.ts';
import { CREATE_DESK_GAS, DEPOSIT_GAS, OWNER_CALL_GAS } from './desk-actions.ts';
import { FakeWorld, FAKE_ENGINE_KEY, FAKE_RECEIVER } from './fakes.ts';
import { currentStep, OnboardingFlow, receiverFound, rulesProblems, setupView, stepsOf, type FlowState } from './flow.ts';
import { OPERATOR_METHODS } from './operator.ts';
import type { WalletAction } from './wallet.ts';

const SAMPLE = 'I want steady income from funding, nothing fancy. Big coins plus DOGE and NEAR are fine. Never more than $1,500 a side and never more than 3x. If prices look weird, don’t trade. Money only ever comes back to me.';

function start(world = new FakeWorld(), config = world.config()): { world: FakeWorld; flow: OnboardingFlow } {
  return { world, flow: new OnboardingFlow(world.deps(config)) };
}

const call = (world: FakeWorld, method: string): WalletAction & { type: 'FunctionCall' } => {
  for (const tx of world.sent) {
    for (const a of tx.actions) if (a.type === 'FunctionCall' && a.params.methodName === method) return a;
  }
  throw new Error(`no ${method} was signed`);
};
const calls = (world: FakeWorld, method: string): number => world.sent.flatMap((t) => t.actions).filter((a) => a.type === 'FunctionCall' && a.params.methodName === method).length;
const stepNow = (s: FlowState) => stepsOf(s).find((x) => x.status === 'now')?.id ?? null;

/** Connects, creates the desk and adds the engine key. */
async function withDeskAndKey(world = new FakeWorld()) {
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  await flow.addEngineKey();
  return flow;
}

/** …and runs venue setup, pins the receiver, funds the desk. */
async function funded(world = new FakeWorld()) {
  const flow = await withDeskAndKey(world);
  await flow.startSetup();
  world.finishSetup();
  await flow.pinReceiver();
  world.giveUsdc(250);
  await flow.refreshBalance();
  flow.setFund({ depositText: '250' });
  await flow.deposit();
  return flow;
}

test('the whole flow: connect, desk, engine key, setup, funds, rules, signature, engine rules', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  assert.equal(stepNow(flow.state), 'wallet');

  // 1 wallet
  await flow.connect();
  assert.equal(flow.state.account, 'demo-owner.testnet');
  assert.equal(stepNow(flow.state), 'desk');

  // 2 desk: the addresses are derived from the MPC keys and shown before anything is signed
  await flow.setDeskId('Desk-07 ');
  assert.equal(flow.state.deskId, 'desk-07');
  assert.equal(flow.state.deskCheck, 'free');
  const want = addressesFrom(
    (await world.chain.view(world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/evm', predecessor: world.contractId, domain_id: 0 })) as string,
    (await world.chain.view(world.mpc, 'derived_public_key', { path: 'gimbal/desk-07/sol', predecessor: world.contractId, domain_id: 1 })) as string,
  );
  assert.deepEqual(flow.state.derived, want);
  assert.equal(world.sent.length, 0, 'deriving signs nothing');

  await flow.createDesk();
  const create = call(world, 'create_desk');
  assert.equal(create.params.gas, CREATE_DESK_GAS);
  assert.equal(CREATE_DESK_GAS, '100000000000000');
  assert.ok(BigInt(create.params.deposit) > 1n, 'create_desk carries the storage deposit');
  assert.deepEqual((create.params.args as { evm_address: string }).evm_address, want.evm_address);
  assert.equal(flow.state.deskCheck, 'mine', 'get_desk was read back and names this wallet');
  assert.equal(flow.state.desk?.owner, 'demo-owner.testnet');
  assert.equal(stepNow(flow.state), 'key');

  // 3 operator key
  await flow.addEngineKey();
  const tx = world.sent.at(-1)!;
  assert.equal(tx.receiverId, 'demo-owner.testnet', 'the key is added on the owner’s own account');
  const add = tx.actions[0]!;
  assert.equal(add.type, 'AddKey');
  if (add.type !== 'AddKey') throw new Error('unreachable');
  assert.equal(add.params.publicKey, FAKE_ENGINE_KEY);
  assert.equal(add.params.accessKey.permission.receiverId, world.contractId);
  assert.deepEqual(add.params.accessKey.permission.methodNames, [...OPERATOR_METHODS]);
  assert.equal(add.params.accessKey.permission.allowance, '5000000000000000000000000');
  assert.equal(world.hasKey(), true);
  assert.equal(stepNow(flow.state), 'setup');

  // 4 venue setup runs in the engine; the page shows its progress
  assert.equal(setupView(flow.state), 'not-started');
  await flow.startSetup();
  assert.deepEqual(world.engineCalls, ['POST /setup']);
  assert.equal(setupView(flow.state), 'running');
  world.advanceSetup();
  assert.equal(flow.state.setup?.steps[0]?.status, 'done');
  assert.equal(flow.state.setup?.steps[1]?.status, 'running');
  world.finishSetup();
  const ip = flow.state.setup?.steps.find((x) => x.step === 'orderly_ip_restriction');
  assert.equal(ip?.status, 'skipped', 'no IP list on testnet: shown as skipped');
  assert.equal(receiverFound(flow.state), FAKE_RECEIVER);
  assert.equal(setupView(flow.state), 'needs-receiver');
  await flow.pinReceiver();
  const pin = call(world, 'set_orderly_receiver');
  assert.deepEqual(pin.params.args, { desk_id: 'desk-07', receiver: FAKE_RECEIVER });
  assert.ok(BigInt(pin.params.deposit) > 1n, 'a storage deposit, not 1 yocto');
  assert.equal(pin.params.gas, OWNER_CALL_GAS);
  assert.equal(setupView(flow.state), 'done');
  assert.equal(stepNow(flow.state), 'funds');

  // 5 funds: NEAR USDC goes in with ft_transfer_call and counts as principal
  world.giveUsdc(1050);
  await flow.refreshBalance();
  assert.equal(flow.state.fund.balance, 1_050_000_000n);
  flow.setFund({ depositText: '1050' });
  await flow.deposit();
  const dep = call(world, 'ft_transfer_call');
  assert.equal(dep.params.gas, DEPOSIT_GAS);
  assert.deepEqual(dep.params.args, { receiver_id: world.contractId, amount: '1050000000', msg: '{"desk_id":"desk-07"}' });
  assert.equal(flow.state.desk?.ledger.deposited, 1_050_000_000n);
  assert.equal(stepNow(flow.state), 'rules');

  // 6 rules: the owner's words become a draft; nothing is applied yet
  flow.setWords(SAMPLE);
  await flow.draftRules();
  assert.deepEqual(world.engineCalls.slice(-1), ['POST /policy/draft']);
  const draft = flow.state.rules.draft!;
  assert.equal(draft.policy.max_notional_usd, 1500);
  assert.equal(draft.strategy.maxLeverage, 3);
  assert.deepEqual(draft.policy.hl_assets.map((a) => a.symbol), ['BTC', 'ETH', 'SOL', 'DOGE', 'NEAR']);
  assert.equal(calls(world, 'set_policy'), 0, 'a draft signs nothing');
  assert.equal(world.engineCalls.includes('PUT /strategy'), false, 'a draft saves nothing');
  assert.equal(world.strategy.legUsd, 100, 'the engine still holds its old rules');
  assert.equal(flow.state.desk?.policy.max_notional_usd, 0, 'the contract still holds the starter policy');

  // the owner edits one number, in either part
  flow.editNumber('leg', '1200');
  flow.editNumber('leverage', '2');
  assert.equal(flow.state.rules.draft?.strategy.legUsd, 1200);
  assert.deepEqual(rulesProblems(flow.state), []);

  // 7 sign: set_policy first, then PUT /strategy
  await flow.signPolicy();
  const sp = call(world, 'set_policy');
  assert.equal(sp.params.gas, OWNER_CALL_GAS);
  assert.ok(BigInt(sp.params.deposit) > 1n);
  assert.deepEqual((sp.params.args as { policy: unknown }).policy, flow.state.rules.draft!.policy);
  assert.equal(flow.state.desk?.policy.max_notional_usd, 1500, 'the contract now holds the owner’s rules');
  assert.deepEqual(world.engineCalls.slice(-1), ['PUT /strategy']);
  assert.equal(world.strategy.legUsd, 1200);
  assert.equal(world.strategy.maxLeverage, 2);
  assert.equal(flow.state.rules.strategySaved, true);
  assert.equal(currentStep(flow.state), null);
  assert.ok(stepsOf(flow.state).every((s) => s.status === 'done'));
  assert.deepEqual(flow.state.errors, {});
});

test('a desk id that someone else owns is shown as theirs and nothing is sent to it', async () => {
  const world = new FakeWorld();
  world.desks.set('desk-07', {
    owner: 'someone-else.testnet',
    policy: (await world.engine.draftPolicy('x')).policy,
    evm_address: '0xabc',
    solana: { authority: 'a', usdc_ata: 'b', phusd_ata: 'c', phoenix_trader: 'd' },
    orderly_receiver: null,
    ips: [],
    deposited: 0n,
  });
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  assert.equal(flow.state.deskCheck, 'foreign');
  await flow.createDesk();
  assert.match(flow.state.errors.create!, /exists already/);
  world.giveUsdc(100);
  flow.setFund({ depositText: '100' });
  await flow.deposit();
  assert.match(flow.state.errors.deposit!, /desk is yours|Create your desk first/);
  assert.equal(world.sent.length, 0, 'no transaction was signed at all');
});

test('if the chain shows the new desk with another owner, the owner check stops everything', async () => {
  const world = new FakeWorld();
  // A chain that reports every desk as owned by someone else once it exists.
  const lying = { ...world.chain, view: async (c: string, m: string, a?: object) => {
    const out = await world.chain.view(c, m, a);
    return m === 'get_desk' && out !== null ? { ...(out as object), owner: 'impostor.testnet' } : out;
  } };
  const flow = new OnboardingFlow(world.deps(world.config(), { chain: lying }));
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  assert.equal(flow.state.deskCheck, 'foreign');
  assert.match(flow.state.errors.create!, /not yours/);
  await flow.addEngineKey();
  assert.match(flow.state.errors.key!, /Create your desk first/);
  assert.equal(calls(world, 'ft_transfer_call'), 0);
});

test('a desk whose stored addresses differ from the derived ones is not trusted', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  assert.equal(flow.state.deskCheck, 'mine');
  world.desks.get('desk-07')!.evm_address = '0x0000000000000000000000000000000000000bad';
  await flow.setDeskId('desk-07');
  assert.equal(flow.state.deskCheck, 'foreign');
});

test('a wallet that does not answer, or is closed, signs nothing and says so', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  world.walletSilent = true;
  await flow.connect();
  assert.equal(flow.state.account, null);
  assert.match(flow.state.errors.connect!, /Nothing was signed: no wallet answered/);
  assert.equal(flow.state.busy, null);

  world.walletSilent = false;
  await flow.connect();
  assert.equal(flow.state.errors.connect, undefined, 'a later try clears the old mistake');
  await flow.setDeskId('desk-07');
  world.signSilent = true;
  await flow.createDesk();
  assert.match(flow.state.errors.create!, /Nothing was signed: the wallet was closed/);
  assert.equal(flow.state.deskCheck, 'free');
});

test('a refusal from the contract is read in words, with its code', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  world.refuse = { method: 'create_desk', text: 'E_DEPOSIT: attach NEAR for storage' };
  await flow.createDesk();
  assert.match(flow.state.errors.create!, /did not cover the storage \(E_DEPOSIT/);
  world.refuse = null;
  await flow.createDesk();
  assert.equal(flow.state.deskCheck, 'mine');
});

test('the engine key must be a public key, and it is checked on the account afterwards', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  flow.setOperatorKey('not a key');
  await flow.addEngineKey();
  assert.match(flow.state.errors.key!, /public key/);
  assert.equal(calls(world, 'create_desk'), 1);
  assert.equal(world.sent.length, 1, 'no key was signed');
  flow.setOperatorKey(FAKE_ENGINE_KEY);
  await flow.addEngineKey();
  assert.equal(stepNow(flow.state), 'setup');
});

test('the engine refuses setup when its key is not on the account yet; the page shows its words', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  await flow.startSetup();
  assert.match(flow.state.errors.setup!, /engine key is not on the owner/);
  assert.equal(setupView(flow.state), 'not-started');
});

test('a failed setup step is shown with the engine’s reason', async () => {
  const world = new FakeWorld();
  const flow = await withDeskAndKey(world);
  await flow.startSetup();
  world.advanceSetup();
  world.failSetup('hl_approve_builder_fee', 'the builder fee was not approved: insufficient margin');
  assert.equal(setupView(flow.state), 'failed');
  const failed = flow.state.setup?.steps.find((s) => s.status === 'failed');
  assert.equal(failed?.detail, 'the builder fee was not approved: insufficient margin');
  assert.equal(stepNow(flow.state), 'setup');
});

test('mainnet: the IP list takes 1 to 10 addresses and carries a storage deposit', async () => {
  const world = new FakeWorld({ network: 'mainnet', contractId: 'gimbal.near', usdcToken: 'usdc.mainnet' });
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  flow.setIpsText('');
  await flow.setIps();
  assert.match(flow.state.errors.ips!, /1 to 10/);
  flow.setIpsText('203.0.113.7, 999.1.1.1');
  await flow.setIps();
  assert.match(flow.state.errors.ips!, /999\.1\.1\.1/);
  flow.setIpsText('203.0.113.7\n198.51.100.20');
  await flow.setIps();
  const ips = call(world, 'set_orderly_ips');
  assert.deepEqual(ips.params.args, { desk_id: 'desk-07', ips: ['203.0.113.7', '198.51.100.20'] });
  assert.ok(BigInt(ips.params.deposit) > 1n, 'a storage deposit, not 1 yocto');
  // and on mainnet the IP step is not skipped
  await flow.addEngineKey();
  await flow.startSetup();
  world.finishSetup();
  assert.equal(flow.state.setup?.steps.find((s) => s.step === 'orderly_ip_restriction')?.status, 'done');
});

test('testnet has no IP list', async () => {
  const flow = await withDeskAndKey();
  flow.setIpsText('203.0.113.7');
  await flow.setIps();
  assert.match(flow.state.errors.ips!, /mainnet/);
});

test('funding through Intents: a quote needs an amount and a refund address, then its status is followed', async () => {
  const world = new FakeWorld({ network: 'mainnet', contractId: 'gimbal.near', usdcToken: 'usdc.mainnet' });
  const { flow } = start(world);
  await flow.connect();
  await flow.setDeskId('desk-07');
  await flow.createDesk();

  await flow.quote();
  assert.match(flow.state.errors.quote!, /amount/);
  flow.setFund({ amount: '2' });
  await flow.quote();
  assert.match(flow.state.errors.quote!, /least worth sending/);
  flow.setFund({ amount: '100' });
  await flow.quote();
  assert.match(flow.state.errors.quote!, /refund/i);
  flow.setFund({ originId: 'arbitrum', refundTo: '0x1111111111111111111111111111111111111111' });
  await flow.quote();
  const quote = flow.state.fund.quote!;
  assert.equal(quote.depositAddress, 'fake-deposit-address-1');
  assert.equal(flow.state.fund.status, 'PENDING_DEPOSIT');

  world.intentsStatus = 'PROCESSING';
  await flow.refreshStatus();
  assert.equal(flow.state.fund.status, 'PROCESSING');

  world.deliver(99.6);
  await flow.refreshStatus();
  assert.equal(flow.state.fund.status, 'SUCCESS');
  assert.equal(flow.state.fund.balance, 99_600_000n, 'the USDC arrived on NEAR, in the owner’s account');
  assert.equal(world.desks.get('desk-07')!.deposited, 0n, 'and is not in the desk until the owner deposits it');

  // changing the amount drops the old quote: its address is for the old amount
  flow.setFund({ amount: '120' });
  assert.equal(flow.state.fund.quote, null);
});

test('a quote that 1Click refuses, or a status it cannot give, is shown and the last status stays', async () => {
  const world = new FakeWorld({ network: 'mainnet', contractId: 'gimbal.near', usdcToken: 'usdc.mainnet' });
  const { flow } = start(world);
  await flow.connect();
  flow.setFund({ amount: '100', refundTo: '0x1111111111111111111111111111111111111111' });
  world.intentsDown = true;
  await flow.quote();
  assert.match(flow.state.errors.quote!, /1Click refused the quote/);
  world.intentsDown = false;
  await flow.quote();
  world.intentsStatus = 'KNOWN_DEPOSIT_TX';
  await flow.refreshStatus();
  world.intentsDown = true;
  await flow.refreshStatus();
  assert.equal(flow.state.fund.status, 'KNOWN_DEPOSIT_TX');
  assert.match(flow.state.errors.quote!, /status/);
});

test('testnet: there is no 1Click quote', async () => {
  const { flow } = start();
  await flow.connect();
  flow.setFund({ amount: '100', refundTo: '0x1111111111111111111111111111111111111111' });
  await flow.quote();
  assert.match(flow.state.errors.quote!, /no testnet/);
});

test('a deposit larger than the NEAR balance is refused before the wallet opens', async () => {
  const world = new FakeWorld();
  const flow = await withDeskAndKey(world);
  world.giveUsdc(10);
  flow.setFund({ depositText: '50' });
  await flow.deposit();
  assert.match(flow.state.errors.deposit!, /holds 10 USDC, less than 50/);
  assert.equal(calls(world, 'ft_transfer_call'), 0);
});

test('NEAR AI unavailable (503): the page says so and the owner fills the numbers by hand', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  world.draftMode = 'unavailable';
  flow.setWords('anything');
  await flow.draftRules();
  assert.equal(flow.state.rules.drafting, 'unavailable');
  assert.equal(flow.state.errors.draft, undefined, 'unavailable is not an error to retry');
  assert.equal(flow.state.rules.draft, null);

  flow.fillByHand();
  const hand = flow.state.rules.draft!;
  assert.equal(hand.model, null);
  assert.equal(flow.state.rules.editing, true);
  await flow.addAsset('btc');
  await flow.addAsset('ETH');
  flow.editNumber('size', '800');
  flow.editNumber('leg', '500');
  assert.deepEqual(flow.state.rules.draft!.policy.hl_assets.map((a) => a.symbol), ['BTC', 'ETH']);
  assert.deepEqual(rulesProblems(flow.state), []);
  await flow.signPolicy();
  assert.equal(flow.state.desk?.policy.max_notional_usd, 800);
  assert.equal(world.strategy.legUsd, 500);
  assert.equal(currentStep(flow.state), null);
});

test('NEAR AI that does not answer, or answers with something unreadable, keeps the owner’s words', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  world.draftMode = 'silent';
  await flow.draftRules();
  assert.match(flow.state.errors.draft!, /did not answer/);
  assert.equal(flow.state.rules.drafting, 'failed');
  assert.equal(flow.state.rules.words, SAMPLE);
  world.draftMode = 'broken';
  await flow.draftRules();
  assert.match(flow.state.errors.draft!, /not with rules the page can read/);
  world.draftMode = 'ok';
  await flow.draftRules();
  assert.equal(flow.state.rules.drafting, 'idle');
  assert.ok(flow.state.rules.draft);
});

test('empty words do not call NEAR AI', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  await flow.connect();
  flow.setWords('   ');
  await flow.draftRules();
  assert.match(flow.state.errors.draft!, /Write what the desk may do/);
  assert.deepEqual(world.engineCalls, []);
});

test('the model’s notes about what it could not map are kept for the owner', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords('Never lose money, $1,000 a side');
  await flow.draftRules();
  assert.deepEqual(flow.state.rules.draft?.notes, ['could not map: “never lose money”, no rule can promise that']);
});

test('an unpriced asset: a dollar cap becomes a size cap at the current mark, and both are in what is signed', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  await flow.addUnpricedAsset('kPEPE', '1,500', '');
  assert.equal(flow.state.errors.asset, undefined);
  const row = flow.state.rules.draft!.policy.unpriced[0]!;
  assert.deepEqual(row, { symbol: 'kPEPE', max_sz: '200000' }, '1500 / 0.0075 = 200000, canonical');
  assert.equal(flow.state.rules.marks.kPEPE, 0.0075, 'the mark used is kept to show next to the cap');
  flow.editNumber('unpriced-cap', '1500');
  await flow.signPolicy();
  const args = call(world, 'set_policy').params.args as { policy: { unpriced: unknown } };
  assert.deepEqual(args.policy.unpriced, [{ symbol: 'kPEPE', max_sz: '200000' }]);
  assert.deepEqual(world.desks.get('desk-07')!.policy.unpriced, [{ symbol: 'kPEPE', max_sz: '200000' }]);
});

test('an unpriced asset the exchange does not list needs a typed mark; one that rounds to nothing is refused', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  await flow.addUnpricedAsset('NOPE', '100', '');
  assert.match(flow.state.errors.asset!, /no price for “NOPE”/);
  await flow.addUnpricedAsset('NOPE', '100', '0.05');
  assert.deepEqual(flow.state.rules.draft!.policy.unpriced[0], { symbol: 'NOPE', max_sz: '2000' });
  await flow.addUnpricedAsset('NOPE', '100', '0.05');
  assert.match(flow.state.errors.asset!, /already on the list/);
  await flow.addUnpricedAsset('BIG', '0.00000001', '1000000');
  assert.match(flow.state.errors.asset!, /not a size the contract can hold/);
  world.marksDown = true;
  await flow.addUnpricedAsset('kPEPE', '100', '');
  assert.match(flow.state.errors.asset!, /could not be read/);
});

test('numbers that break a rule are shown before the wallet opens, and nothing is signed', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  // the engine would open $5,000 a leg under a contract cap of $1,500
  flow.editNumber('leg', '5000');
  assert.match(rulesProblems(flow.state)[0]!.message, /over the contract’s cap|over the contract's cap/);
  await flow.signPolicy();
  assert.match(flow.state.errors.sign!, /cap/);
  assert.equal(calls(world, 'set_policy'), 0);
  // text that is not a number is kept as typed and flagged
  flow.editNumber('leg', 'lots');
  assert.equal(flow.state.rules.raw.leg, 'lots');
  assert.equal(rulesProblems(flow.state).some((p) => p.field === 'leg'), true);
  flow.editNumber('leg', '900');
  assert.equal(flow.state.rules.raw.leg, undefined);
  assert.deepEqual(rulesProblems(flow.state), []);
});

test('closing the wallet at the signature leaves the rules unconfirmed and the contract untouched', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  world.signSilent = true;
  await flow.signPolicy();
  assert.match(flow.state.errors.sign!, /Nothing was signed/);
  assert.equal(flow.state.rules.confirmed, false);
  assert.equal(stepNow(flow.state), 'rules');
  assert.equal(world.engineCalls.includes('PUT /strategy'), false);
  assert.equal(world.desks.get('desk-07')!.policy.max_notional_usd, 0);
});

test('if the engine refuses its rules after the signature, only they are retried: no second signature', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  world.putStrategyRefusal = 'the engine is restarting';
  await flow.signPolicy();
  assert.equal(calls(world, 'set_policy'), 1);
  assert.match(flow.state.errors.strategy!, /restarting/);
  assert.equal(flow.state.rules.strategySaved, false);
  assert.equal(stepNow(flow.state), 'sign', 'the signature is done; the engine rules are not');
  world.putStrategyRefusal = null;
  await flow.saveStrategy();
  assert.equal(flow.state.errors.strategy, undefined);
  assert.equal(calls(world, 'set_policy'), 1, 'no second signature');
  assert.equal(currentStep(flow.state), null);
});

test('editing the rules after they were signed makes the signature stale', async () => {
  const world = new FakeWorld();
  const flow = await funded(world);
  flow.setWords(SAMPLE);
  await flow.draftRules();
  await flow.signPolicy();
  assert.equal(currentStep(flow.state), null);
  flow.editNumber('size', '2000');
  assert.equal(stepNow(flow.state), 'rules');
  await flow.signPolicy();
  assert.equal(calls(world, 'set_policy'), 2);
  assert.equal(world.desks.get('desk-07')!.policy.max_notional_usd, 2000);
});

test('an owner who comes back resumes where the chain says they stopped', async () => {
  const world = new FakeWorld();
  await funded(world); // a first visit does the work, then the page is closed
  const { flow } = start(world);
  assert.equal(stepNow(flow.state), 'wallet');
  await flow.connect();
  assert.equal(flow.state.deskId, 'desk-07', 'the owner’s desk is found');
  assert.equal(flow.state.deskCheck, 'mine');
  // the key and the deposit are read back; the starter policy means the rules are still to do (the setup stream
  // is the engine's, so a fresh page has not seen it)
  const done = stepsOf(flow.state).filter((s) => s.status === 'done').map((s) => s.id);
  assert.deepEqual(done, ['wallet', 'desk', 'key', 'setup', 'funds']);
  assert.equal(stepNow(flow.state), 'rules');
});

test('a wallet session from an earlier visit is picked up without opening the wallet', async () => {
  const world = new FakeWorld();
  await withDeskAndKey(world);
  await world.wallet.disconnect(); // the first visit ends
  const { flow } = start(world);
  await flow.resume();
  assert.equal(flow.state.account, null, 'nothing remembered: the page waits for Connect');
  world.restores = true;
  await flow.resume();
  assert.equal(flow.state.account, 'demo-owner.testnet');
  assert.equal(flow.state.deskCheck, 'mine');
  assert.equal(world.sent.length, 2, 'resuming signs nothing');
});

test('signing out in the wallet clears the owner’s state', async () => {
  const world = new FakeWorld();
  const flow = await withDeskAndKey(world);
  assert.equal(flow.state.deskCheck, 'mine');
  world.signOutNow();
  assert.equal(flow.state.account, null);
  assert.equal(flow.state.deskCheck, 'unknown');
  assert.equal(stepNow(flow.state), 'wallet');
});

test('no contract configured for the network: onboarding says so and goes no further', async () => {
  const world = new FakeWorld({ network: 'mainnet' });
  const { flow } = start(world, { ...world.config(), contractId: null });
  await flow.connect();
  assert.match(flow.state.errors.load!, /No gimbal contract is configured for mainnet/);
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  assert.equal(world.sent.length, 0);
});

test('a contract on the other network than the engine is refused', async () => {
  const world = new FakeWorld({ network: 'testnet' });
  const { flow } = start(world, { ...world.config(), network: 'mainnet' });
  await flow.connect();
  assert.match(flow.state.errors.load!, /runs on Testnet, but the engine is on mainnet/);
});

test('only one action runs at a time', async () => {
  const world = new FakeWorld();
  const { flow } = start(world);
  const first = flow.connect();
  const second = flow.connect();
  await Promise.all([first, second]);
  assert.equal(flow.state.account, 'demo-owner.testnet');
});
