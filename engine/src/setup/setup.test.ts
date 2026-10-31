import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SetupProgress, TxRef } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import { HlExchangeError } from '../relayer/hyperliquid.ts';
import { testDesk } from '../relayer/test-helpers.ts';
import type { HlSetup, OrderlySetup, PhoenixSetup, SetupPlan, SetupStepName } from './setup.ts';
import { receiverOf, runSetup, SETUP_STEPS } from './setup.ts';

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const RECEIVER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const near = (id: string): TxRef => ({ chain: 'near', id, url: `https://testnet.nearblocks.io/txns/${id}` });

/** A Hyperliquid account that exists once `fundedAfter` hasAccount() calls have been made (0: from the start). */
function fakeHl(o: { fundedAfter?: number; referredBy?: string | null; approved?: number; noAccountText?: string } = {}) {
  let checks = 0;
  let funded = (o.fundedAfter ?? 0) === 0;
  let approved = o.approved ?? 0;
  let referredBy = o.referredBy ?? null;
  const calls: string[] = [];
  const refuse = (kind: string) => new HlExchangeError(`hyperliquid ${kind}: refused: ${o.noAccountText ?? 'User or API Wallet 0xab does not exist.'}`, 200, '{}');
  const hl: HlSetup = {
    hasAccount: async () => {
      checks++;
      if (o.fundedAfter !== undefined && checks >= o.fundedAfter) funded = true;
      return funded;
    },
    referredBy: async () => referredBy,
    approvedBuilderFee: async () => approved,
    setReferrer: async () => {
      calls.push('setReferrer');
      if (!funded) throw refuse('set referrer');
      referredBy = 'GIMBAL';
      return [near('ref')];
    },
    approveBuilderFee: async () => {
      calls.push('approveBuilderFee');
      if (!funded) throw refuse('approve builder fee');
      approved = 10;
      return [near('fee')];
    },
  };
  return { hl, calls };
}

function fakeOrderly(o: { registered?: boolean; key?: boolean; failRegister?: string; bindAnswer?: string } = {}) {
  let registered = o.registered ?? false;
  let key = o.key ?? false;
  const calls: string[] = [];
  const orderly: OrderlySetup = {
    accountId: '0xacc',
    isRegistered: async () => registered,
    keyInfo: async () => (key ? { scope: 'read,trading', expiration: NOW + 300 * DAY, status: 'ACTIVE' } : null),
    register: async () => {
      calls.push('register');
      if (o.failRegister !== undefined) throw new Error(o.failRegister);
      registered = true;
      return '0xacc';
    },
    addKey: async () => {
      calls.push('addKey');
      key = true;
      return 'ed25519:k';
    },
    receiverAddress: async () => {
      calls.push('receiverAddress');
      return { chain_id: 421614, receiver_address: RECEIVER, token: 'USDC' };
    },
    bindReferral: async () => {
      calls.push('bindReferral');
      if (o.bindAnswer !== undefined) throw new Error(o.bindAnswer);
      return 'bound';
    },
    restrictKeyIps: async () => {
      calls.push('restrictKeyIps');
      return {};
    },
  };
  return { orderly, calls };
}

function plan(over: Partial<SetupPlan> & { hl: HlSetup; orderly: OrderlySetup }): { plan: SetupPlan; events: SetupProgress[] } {
  const events: SetupProgress[] = [];
  let t = NOW;
  return {
    events,
    plan: {
      deskId: 'alpha',
      desk: async () => testDesk(),
      referralCodes: { hyperliquid: null, orderly: null, phoenix: null },
      builderFeeTenthBps: 10,
      brokerId: 'woofi_dex',
      phoenix: null,
      publish: (p) => events.push(p),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      depositPollMs: 30_000,
      depositWaitMs: 10 * 60_000,
      ...over,
    },
  };
}

const status = (p: SetupProgress) => Object.fromEntries(p.steps.map((s) => [s.step, s.status])) as Record<SetupStepName, string>;
const step = (p: SetupProgress, name: SetupStepName) => p.steps.find((s) => s.step === name)!;

test('a new testnet desk: Orderly set up, Phoenix skipped, Hyperliquid waits for the deposit and then approves', async () => {
  const hl = fakeHl({ fundedAfter: 3 });
  const ob = fakeOrderly();
  const { plan: p, events } = plan({ hl: hl.hl, orderly: ob.orderly });
  const final = await runSetup(p);

  assert.deepEqual(final.steps.map((s) => s.step), SETUP_STEPS);
  assert.deepEqual(status(final), {
    hl_set_referrer: 'skipped', hl_approve_builder_fee: 'done',
    orderly_register: 'done', orderly_add_key: 'done', orderly_receiver_lookup: 'done', orderly_referral_bind: 'skipped',
    orderly_ip_restriction: 'skipped', phoenix_register: 'skipped', phoenix_referral: 'skipped',
  });
  // No signature while Hyperliquid has no account (userRole), one once the deposit landed.
  assert.deepEqual(hl.calls, ['approveBuilderFee']);
  assert.ok(events.some((e) => step(e, 'hl_approve_builder_fee').status === 'pending' && /first deposit/.test(step(e, 'hl_approve_builder_fee').detail ?? '')));
  assert.deepEqual(step(final, 'hl_approve_builder_fee').tx, [near('fee')]);
  assert.deepEqual(ob.calls, ['register', 'addKey', 'receiverAddress']);
  // The dashboard reads the receiver from the detail: the address alone, lowercase.
  assert.equal(step(final, 'orderly_receiver_lookup').detail, RECEIVER.toLowerCase());
  assert.equal(step(final, 'phoenix_register').detail, 'Phoenix runs on mainnet only');
  assert.equal(step(final, 'orderly_ip_restriction').detail, 'no IP list is set (set_orderly_ips)');
  // Every change went out, each event a full snapshot.
  assert.ok(events.length > SETUP_STEPS.length);
  assert.ok(events.every((e) => e.deskId === 'alpha' && e.steps.length === SETUP_STEPS.length));
});

test('a rerun on a desk that is set up signs nothing', async () => {
  const hl = fakeHl({ approved: 10, referredBy: 'GIMBAL' });
  const ob = fakeOrderly({ registered: true, key: true });
  const { plan: p } = plan({
    hl: hl.hl, orderly: ob.orderly, referralCodes: { hyperliquid: 'GIMBAL', orderly: null, phoenix: null },
    desk: async () => testDesk({ orderly_receiver: RECEIVER }),
  });
  const final = await runSetup(p);
  assert.deepEqual(hl.calls, []);
  assert.deepEqual(ob.calls, []);
  assert.equal(status(final).hl_set_referrer, 'done');
  assert.equal(step(final, 'hl_set_referrer').detail, 'referred by GIMBAL');
  assert.equal(step(final, 'orderly_add_key').detail, 'key active until 2027-08-27');
  assert.equal(step(final, 'orderly_receiver_lookup').detail, RECEIVER.toLowerCase());
});

test('with codes and an IP list: the referrer before the builder fee, the bind, the IP restriction', async () => {
  const hl = fakeHl();
  const ob = fakeOrderly({ bindAnswer: 'orderly referral_bind: -1 already bound a referral code' });
  const { plan: p } = plan({
    hl: hl.hl, orderly: ob.orderly, referralCodes: { hyperliquid: 'GIMBAL', orderly: 'GIMBAL', phoenix: null },
    desk: async () => testDesk({ orderly_ips: ['203.0.113.7'] }),
  });
  const final = await runSetup(p);
  assert.deepEqual(hl.calls, ['setReferrer', 'approveBuilderFee']);
  assert.deepEqual(ob.calls, ['register', 'addKey', 'receiverAddress', 'bindReferral', 'restrictKeyIps']);
  assert.equal(status(final).orderly_referral_bind, 'done');
  assert.match(step(final, 'orderly_referral_bind').detail!, /already bound/);
  assert.equal(step(final, 'orderly_ip_restriction').detail, 'key limited to 203.0.113.7');
});

test('an unfunded desk signs nothing on Hyperliquid, and stays pending when no deposit comes', async () => {
  const hl = fakeHl({ fundedAfter: 1_000 });
  const ob = fakeOrderly({ registered: true, key: true });
  const { plan: p } = plan({ hl: hl.hl, orderly: ob.orderly, referralCodes: { hyperliquid: 'GIMBAL', orderly: null, phoenix: null } });
  const final = await runSetup(p);
  assert.deepEqual(hl.calls, []);
  assert.equal(status(final).hl_set_referrer, 'pending');
  assert.equal(status(final).hl_approve_builder_fee, 'pending');
  assert.match(step(final, 'hl_approve_builder_fee').detail!, /POST \/setup again/);
});

test('Hyperliquid refusing an account it does not know yet: pending with the signature spent, one signature only', async () => {
  let accepts = false;
  let approved = 0;
  const calls: string[] = [];
  const refused = Object.assign(new Error('hyperliquid setReferrer: refused: Must deposit before performing actions. User: 0xab'), { tx: [near('spent')] });
  const hl: HlSetup = {
    hasAccount: async () => true,          // userRole already knows the address, the deposit has not settled
    referredBy: async () => null,
    approvedBuilderFee: async () => approved,
    setReferrer: async () => {
      calls.push('setReferrer');
      if (!accepts) throw refused;
      return [near('ref')];
    },
    approveBuilderFee: async () => {
      calls.push('approveBuilderFee');
      approved = 10;
      return [near('fee')];
    },
  };
  const { plan: p } = plan({
    hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, referralCodes: { hyperliquid: 'GIMBAL', orderly: null, phoenix: null },
    sleep: async () => {
      accepts = true;
    },
  });
  const final = await runSetup(p);
  assert.deepEqual(calls, ['setReferrer', 'setReferrer', 'approveBuilderFee'], 'the builder fee waits too instead of being refused the same way');
  assert.equal(status(final).hl_set_referrer, 'done');
  assert.deepEqual(step(final, 'hl_set_referrer').tx, [near('spent'), near('ref')]);
  assert.equal(status(final).hl_approve_builder_fee, 'done');
});

test('a failed step stops its dependents; the other venues go on', async () => {
  const hl = fakeHl({ approved: 10 });
  const ob = fakeOrderly({ failRegister: 'orderly register_account: -1 broker not allowed' });
  const { plan: p } = plan({ hl: hl.hl, orderly: ob.orderly });
  const final = await runSetup(p);
  assert.equal(status(final).orderly_register, 'failed');
  assert.match(step(final, 'orderly_register').detail!, /broker not allowed/);
  for (const name of ['orderly_add_key', 'orderly_receiver_lookup', 'orderly_referral_bind', 'orderly_ip_restriction'] as const) {
    assert.equal(status(final)[name], 'pending');
    assert.equal(step(final, name).detail, 'waits for orderly_register');
  }
  assert.equal(status(final).hl_approve_builder_fee, 'done');
  assert.equal(status(final).phoenix_register, 'skipped');
});

test('an unknown outcome fails the step with its transactions; a rerun starts from the venue read', async () => {
  const ob = fakeOrderly({ registered: true, key: true });
  const unknown = new OutcomeUnknown('hyperliquid approve builder fee', '/exchange gave no answer', { nearTx: 'n1' }, [near('n1')]);
  let approved = 0;
  const hl: HlSetup = {
    hasAccount: async () => true, referredBy: async () => null, approvedBuilderFee: async () => approved,
    setReferrer: async () => [], approveBuilderFee: async () => {
      throw unknown;
    },
  };
  const first = await runSetup(plan({ hl, orderly: ob.orderly }).plan);
  assert.equal(status(first).hl_approve_builder_fee, 'failed');
  assert.match(step(first, 'hl_approve_builder_fee').detail!, /rerun reads the venue/);
  assert.deepEqual(step(first, 'hl_approve_builder_fee').tx, [near('n1')]);
  // It had landed after all: the rerun sees it on Hyperliquid and signs nothing.
  approved = 10;
  const second = await runSetup(plan({ hl, orderly: ob.orderly }).plan);
  assert.equal(status(second).hl_approve_builder_fee, 'done');
});

test('Orderly signatures are attached to their step', async () => {
  const hl = fakeHl({ approved: 10 });
  const ob = fakeOrderly();
  const pending: TxRef[] = [];
  const signing: OrderlySetup = {
    ...ob.orderly,
    register: async () => {
      pending.push(near('reg'));
      return ob.orderly.register();
    },
    addKey: async () => {
      pending.push(near('key'));
      return ob.orderly.addKey();
    },
  };
  const final = await runSetup(plan({ hl: hl.hl, orderly: signing, takeOrderlyTx: () => pending.splice(0) }).plan);
  assert.deepEqual(step(final, 'orderly_register').tx, [near('reg')]);
  assert.deepEqual(step(final, 'orderly_add_key').tx, [near('key')]);
  assert.deepEqual(step(final, 'orderly_receiver_lookup').tx, []);
});

test('Phoenix on mainnet: register when the trader account is missing, the referral only with a code', async () => {
  const calls: string[] = [];
  let exists = false;
  const phoenix: PhoenixSetup = {
    isRegistered: async () => exists,
    register: async () => {
      calls.push('register');
      exists = true;
      return { tx: [near('sol')] };
    },
    activateReferral: async () => {
      calls.push('activate');
      return { status: 'already_activated', tx: [] };
    },
  };
  const base = { hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, phoenix };
  const first = await runSetup(plan(base).plan);
  assert.equal(status(first).phoenix_register, 'done');
  assert.deepEqual(step(first, 'phoenix_register').tx, [near('sol')]);
  assert.equal(status(first).phoenix_referral, 'skipped');
  const second = await runSetup(plan({ ...base, referralCodes: { hyperliquid: null, orderly: null, phoenix: 'TESTREF1' } }).plan);
  assert.deepEqual(calls, ['register', 'activate']);
  assert.equal(step(second, 'phoenix_register').detail, 'trader account exists');
  assert.equal(step(second, 'phoenix_referral').detail, 'activate-tx: already_activated');
});

test('receiverOf reads the address however Orderly wraps it', () => {
  assert.equal(receiverOf(RECEIVER), RECEIVER);
  assert.equal(receiverOf({ receiver_address: RECEIVER }), RECEIVER);
  assert.equal(receiverOf({ chain_id: 1, other: RECEIVER }), RECEIVER);
  assert.equal(receiverOf({ chain_id: 1 }), null);
  assert.equal(receiverOf(null), null);
});

test('an active orderly key close to its expiry is done (Orderly refuses re-adding it); an expired one is added again', async () => {
  const hl = fakeHl({ approved: 10 });
  let expiration = NOW + 29 * DAY + 3_600_000;
  let adds = 0;
  const orderly: OrderlySetup = {
    ...fakeOrderly({ registered: true }).orderly,
    keyInfo: async () => ({ scope: 'read,trading', expiration, status: 'ACTIVE' }),
    addKey: async () => {
      adds++;
      expiration = NOW + 364 * DAY;
      return 'ed25519:k';
    },
  };
  const soon = await runSetup(plan({ hl: hl.hl, orderly }).plan);
  assert.equal(adds, 0);
  assert.equal(step(soon, 'orderly_add_key').detail, 'key active until 2026-11-29 (29 days left)');
  expiration = NOW - 1;
  const expired = await runSetup(plan({ hl: hl.hl, orderly }).plan);
  assert.equal(adds, 1);
  assert.equal(step(expired, 'orderly_add_key').detail, 'key added, ACTIVE until 2027-10-30');
});

test('an add-key refusal for a key Orderly turns out to hold is done', async () => {
  let held = false;
  const orderly: OrderlySetup = {
    ...fakeOrderly({ registered: true }).orderly,
    keyInfo: async () => (held ? { scope: 'read,trading', expiration: NOW + 300 * DAY, status: 'ACTIVE' } : null),
    addKey: async () => {
      held = true;
      throw new Error('orderly orderly_key: HTTP 200 code -1616 orderlyKey already exists');
    },
  };
  const final = await runSetup(plan({ hl: fakeHl({ approved: 10 }).hl, orderly }).plan);
  assert.equal(status(final).orderly_add_key, 'done');
  assert.equal(status(final).orderly_receiver_lookup, 'done');
});
