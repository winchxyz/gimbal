import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SetupProgress, TxRef } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import { HlExchangeError } from '../relayer/hyperliquid.ts';
import { testDesk } from '../relayer/test-helpers.ts';
import type { HlSetup, OrderlySetup, PhoenixSetup, SetupPlan, SetupStepName } from './setup.ts';
import { PHOENIX_LANDING_MS, receiverOf, runSetup, SETUP_STEPS } from './setup.ts';

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

test('a rerun on a desk that is set up signs no action: only the receiver read, to check the pinned one', async () => {
  const hl = fakeHl({ approved: 10, referredBy: 'GIMBAL' });
  const ob = fakeOrderly({ registered: true, key: true });
  const { plan: p } = plan({
    hl: hl.hl, orderly: ob.orderly, referralCodes: { hyperliquid: 'GIMBAL', orderly: null, phoenix: null },
    desk: async () => testDesk({ orderly_receiver: RECEIVER }),
  });
  const final = await runSetup(p);
  assert.deepEqual(hl.calls, []);
  assert.deepEqual(ob.calls, ['receiverAddress']);
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
    relayerIps: async () => ['203.0.113.7'],
  });
  const final = await runSetup(p);
  assert.deepEqual(hl.calls, ['setReferrer', 'approveBuilderFee']);
  assert.deepEqual(ob.calls, ['register', 'addKey', 'receiverAddress', 'bindReferral', 'restrictKeyIps']);
  assert.equal(status(final).orderly_referral_bind, 'done');
  assert.match(step(final, 'orderly_referral_bind').detail!, /already bound/);
  assert.equal(step(final, 'orderly_ip_restriction').detail, 'key limited to 203.0.113.7');
});

test('an IP list without the engine’s own public IP is not applied: the step fails with the missing IP, nothing signed', async () => {
  const ob = fakeOrderly({ registered: true, key: true });
  const { plan: p } = plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: ob.orderly,
    desk: async () => testDesk({ orderly_ips: ['203.0.113.7', '2001:db8::1'] }),
    relayerIps: async () => ['198.51.100.4'],
  });
  const final = await runSetup(p);
  assert.deepEqual(ob.calls, ['receiverAddress']);
  assert.equal(status(final).orderly_ip_restriction, 'failed');
  const detail = step(final, 'orderly_ip_restriction').detail!;
  assert.match(detail, /leaves out 198\.51\.100\.4, the IP this engine sends its Orderly requests from/);
  assert.match(detail, /could not trade, close or rescue/);
  assert.match(detail, /Nothing was signed/);
});

test('the IP check compares canonical forms, so an IPv6 written another way still counts', async () => {
  const ob = fakeOrderly({ registered: true, key: true });
  const { plan: p } = plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: ob.orderly,
    desk: async () => testDesk({ orderly_ips: ['2001:db8::1'] }),
    relayerIps: async () => ['2001:DB8:0:0:0:0:0:1'],
  });
  const final = await runSetup(p);
  assert.equal(status(final).orderly_ip_restriction, 'done');
  assert.deepEqual(ob.calls, ['receiverAddress', 'restrictKeyIps']);
});

test('an engine that cannot tell its public IP refuses to apply a list rather than guess', async () => {
  const unknown = async (): Promise<string[]> => {
    throw new Error("the engine's public IP is unknown (lookup failed); set GIMBAL_PUBLIC_IP to it");
  };
  for (const relayerIps of [undefined, unknown]) {
    const ob = fakeOrderly({ registered: true, key: true });
    const { plan: p } = plan({
      hl: fakeHl({ approved: 10 }).hl, orderly: ob.orderly,
      desk: async () => testDesk({ orderly_ips: ['203.0.113.7'] }),
      ...(relayerIps === undefined ? {} : { relayerIps }),
    });
    const final = await runSetup(p);
    assert.equal(status(final).orderly_ip_restriction, 'failed');
    assert.match(step(final, 'orderly_ip_restriction').detail!, /GIMBAL_PUBLIC_IP/);
    assert.deepEqual(ob.calls, ['receiverAddress']);
  }
});

test('without an IP list the public IP is never looked up', async () => {
  let asked = 0;
  const { plan: p } = plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly,
    relayerIps: async () => {
      asked++;
      return [];
    },
  });
  const final = await runSetup(p);
  assert.equal(status(final).orderly_ip_restriction, 'skipped');
  assert.equal(asked, 0);
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

test('Hyperliquid refusing an account it does not know yet: pending with the spent signature kept; the builder fee waits instead of spending one too', async () => {
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
  // The refused setReferrer, its retry once the deposit settled, then the builder fee: never a refused builder fee.
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

function fakePhoenix(o: { landsAfter?: number; activated?: boolean } = {}) {
  const calls: string[] = [];
  let polls = -1;                                   // -1: not sent yet
  let activated = o.activated ?? false;
  const phoenix: PhoenixSetup = {
    isRegistered: async () => {
      if (polls < 0) return false;
      polls++;
      return polls > (o.landsAfter ?? 0);
    },
    register: async () => {
      calls.push('register');
      polls = 0;
      return { tx: [near('sol')] };
    },
    referralActivated: async () => activated,
    activateReferral: async () => {
      calls.push('activate');
      activated = true;
      return { status: 'activated', tx: [near('act')] };
    },
  };
  return { phoenix, calls };
}

test('Phoenix on mainnet: register when the trader account is missing, done once it exists; the referral only with a code', async () => {
  const ph = fakePhoenix({ landsAfter: 2 });
  const base = { hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, phoenix: ph.phoenix };
  const first = await runSetup(plan(base).plan);
  assert.equal(status(first).phoenix_register, 'done');
  assert.equal(step(first, 'phoenix_register').detail, 'registered: trader account exists');
  assert.deepEqual(step(first, 'phoenix_register').tx, [near('sol')]);
  assert.equal(status(first).phoenix_referral, 'skipped');
  const coded = { ...base, referralCodes: { hyperliquid: null, orderly: null, phoenix: 'TESTREF1' } };
  const second = await runSetup(plan(coded).plan);
  assert.equal(step(second, 'phoenix_register').detail, 'trader account exists');
  assert.equal(step(second, 'phoenix_referral').detail, 'activate-tx: activated');
  // A rerun reads the activation on the trader account and signs nothing.
  const third = await runSetup(plan(coded).plan);
  assert.equal(step(third, 'phoenix_referral').detail, 'already activated: the trader account has the referral capabilities');
  assert.deepEqual(ph.calls, ['register', 'activate']);
});

test('Phoenix: a registration whose trader account never shows up fails with its transactions, and the referral waits', async () => {
  const ph = fakePhoenix({ landsAfter: 1_000 });
  const final = await runSetup(plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, phoenix: ph.phoenix,
    referralCodes: { hyperliquid: null, orderly: null, phoenix: 'TESTREF1' },
  }).plan);
  assert.equal(status(final).phoenix_register, 'failed');
  assert.match(step(final, 'phoenix_register').detail!, /trader account does not exist yet: a rerun looks for it for 90 s before it signs anything/);
  assert.deepEqual(step(final, 'phoenix_register').tx, [near('sol')]);
  assert.equal(step(final, 'phoenix_referral').detail, 'waits for phoenix_register');
  assert.deepEqual(ph.calls, ['register']);
});

/** Phoenix on a clock: each registration lands `landsAfterMs` after it was signed (never when null). */
function clockedPhoenix(now: () => number, landsAfterMs: number | null) {
  const signed: number[] = [];
  const reads: number[] = [];
  let failReadAt: number | null = null;
  const phoenix: PhoenixSetup = {
    isRegistered: async () => {
      reads.push(now());
      if (failReadAt !== null && reads.length === failReadAt) throw new Error('solana: getAccountInfo timed out');
      return landsAfterMs !== null && signed.some((at) => now() >= at + landsAfterMs);
    },
    register: async () => {
      signed.push(now());
      return { tx: [near('sol')] };
    },
    referralActivated: async () => false,
    activateReferral: async () => null,
  };
  return { phoenix, signed, reads, failRead: (n: number) => { failReadAt = n; } };
}

test('Phoenix: every run looks for an earlier registration before it signs one, as long as that one could land', async () => {
  let t = NOW;
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  const desk = { hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, ...clock };

  // The registration lands 45 s after it was signed: after the 30 s poll gave up. A rerun at once does not sign again.
  const late = clockedPhoenix(() => t, 45_000);
  const first = await runSetup(plan({ ...desk, phoenix: late.phoenix }).plan);
  assert.equal(status(first).phoenix_register, 'failed');
  assert.equal(late.signed.length, 1);
  assert.ok(late.signed[0]! - NOW >= PHOENIX_LANDING_MS, 'a first run looks too: it cannot know there was no earlier one');
  const second = await runSetup(plan({ ...desk, phoenix: late.phoenix }).plan);
  assert.equal(status(second).phoenix_register, 'done');
  assert.equal(step(second, 'phoenix_register').detail, 'trader account exists: an earlier registration landed');
  assert.deepEqual(step(second, 'phoenix_register').tx, []);
  assert.equal(late.signed.length, 1, 'one registration: a second one signed while the first could land is a second transaction');

  // One that never lands: the rerun signs again only once the first can no longer land.
  const lost = clockedPhoenix(() => t, null);
  await runSetup(plan({ ...desk, phoenix: lost.phoenix }).plan);
  await runSetup(plan({ ...desk, phoenix: lost.phoenix }).plan);
  assert.equal(lost.signed.length, 2);
  assert.ok(lost.signed[1]! - lost.signed[0]! >= PHOENIX_LANDING_MS);

  // A read that fails while looking fails the step: nothing is signed on a guess.
  const flaky = clockedPhoenix(() => t, null);
  flaky.failRead(3);
  const r = await runSetup(plan({ ...desk, phoenix: flaky.phoenix }).plan);
  assert.equal(status(r).phoenix_register, 'failed');
  assert.match(step(r, 'phoenix_register').detail!, /getAccountInfo timed out/);
  assert.equal(flaky.signed.length, 0);
});

/** Phoenix on a clock for the referral: each activation lands `landsAfterMs` after it was signed. */
function referralPhoenix(now: () => number, o: { registered: boolean; landsAfterMs: number }) {
  const registered: number[] = o.registered ? [0] : [];
  const activations: number[] = [];
  const phoenix: PhoenixSetup = {
    isRegistered: async () => registered.some((at) => now() >= at + 3_000),
    register: async () => {
      registered.push(now());
      return { tx: [near('sol')] };
    },
    referralActivated: async () => activations.some((at) => now() >= at + o.landsAfterMs),
    activateReferral: async () => {
      activations.push(now());
      return { status: 'sent', tx: [near('act')] };
    },
  };
  return { phoenix, registered, activations };
}

test('Phoenix: the referral, like the registration, is looked for before it is signed again, unless this run registered', async () => {
  let t = NOW;
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  const desk = {
    hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, ...clock,
    referralCodes: { hyperliquid: null, orderly: null, phoenix: 'TESTREF1' },
  };

  // An activation sent by a run that ended before it landed (45 s later): a rerun at once does not sign another.
  const late = referralPhoenix(() => t, { registered: true, landsAfterMs: 45_000 });
  const first = await runSetup(plan({ ...desk, phoenix: late.phoenix }).plan);
  assert.equal(step(first, 'phoenix_referral').detail, 'activate-tx: sent');
  assert.ok(late.activations[0]! - NOW >= PHOENIX_LANDING_MS, 'the account was there before this run: an earlier run may have activated it');
  const second = await runSetup(plan({ ...desk, phoenix: late.phoenix }).plan);
  assert.equal(status(second).phoenix_referral, 'done');
  assert.equal(step(second, 'phoenix_referral').detail, 'activated: an earlier activation landed');
  assert.deepEqual(step(second, 'phoenix_referral').tx, []);
  assert.equal(late.activations.length, 1, 'one activation: a second one signed while the first could land is a second transaction');

  // A run that registers the account itself activates without the look: no earlier run got that far.
  const fresh = referralPhoenix(() => t, { registered: false, landsAfterMs: 1_000 });
  const r = await runSetup(plan({ ...desk, phoenix: fresh.phoenix }).plan);
  assert.equal(status(r).phoenix_register, 'done');
  assert.equal(step(r, 'phoenix_referral').detail, 'activate-tx: sent');
  assert.ok(fresh.activations[0]! - fresh.registered[0]! < PHOENIX_LANDING_MS);
});

test('Phoenix: a poll interval of 0 fails the step instead of looking forever; nothing is signed', async () => {
  let sleeps = 0;
  const ph = fakePhoenix();
  const final = await runSetup(plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, phoenix: ph.phoenix,
    phoenixPollMs: 0,
    sleep: async () => {
      if (++sleeps > 10_000) throw new Error('the look never ends');
    },
  }).plan);
  assert.equal(status(final).phoenix_register, 'failed');
  assert.match(step(final, 'phoenix_register').detail!, /phoenixPollMs must be over 0 and phoenixLandingMs 0 or more, got 0 and 90000: nothing is signed/);
  assert.deepEqual(ph.calls, []);
});

test('receiverOf reads receiver_address and nothing else', () => {
  // What Orderly testnet answered for a desk on 2026-10-31.
  const recorded = JSON.parse(readFileSync(new URL('../../fixtures/orderly-signed/receiver-address-testnet-2026-10-31.json', import.meta.url), 'utf8')) as { data: unknown };
  assert.equal(receiverOf(recorded.data), '0xdd31bf887d636fd83ab68716c61ec63f162e2df1');
  assert.equal(receiverOf({ chain_id: 421614, receiver_address: RECEIVER, token: 'USDC' }), RECEIVER.toLowerCase());
  for (const answer of [RECEIVER, { chain_id: 1, other: RECEIVER }, { receiver_address: '0x12' }, { chain_id: 1 }, null]) {
    assert.throws(() => receiverOf(answer), /no receiver_address address in the answer/);
  }
});

test('a pinned receiver is checked against Orderly: a different one fails the step', async () => {
  const other = '0x1111111111111111111111111111111111111111';
  const final = await runSetup(plan({
    hl: fakeHl({ approved: 10 }).hl, orderly: fakeOrderly({ registered: true, key: true }).orderly, desk: async () => testDesk({ orderly_receiver: other }),
  }).plan);
  assert.equal(status(final).orderly_receiver_lookup, 'failed');
  assert.equal(step(final, 'orderly_receiver_lookup').detail, `the pinned receiver ${other} is not the one Orderly gives this account (${RECEIVER.toLowerCase()}): pin ${RECEIVER.toLowerCase()} with set_orderly_receiver`);
});

test('an active orderly key close to its expiry is done; an expired one fails the step (Orderly refuses to re-add a key, -1616), nothing signed', async () => {
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
  assert.equal(adds, 0);
  assert.equal(status(expired).orderly_add_key, 'failed');
  assert.equal(step(expired, 'orderly_add_key').detail, "Orderly holds the desk's key as ACTIVE, scope read,trading, expiration 2026-10-31: it is not usable and Orderly refuses to add it again (-1616); the desk needs a new key");
  assert.equal(step(expired, 'orderly_receiver_lookup').detail, 'waits for orderly_add_key');
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
