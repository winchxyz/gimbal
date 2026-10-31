// Venue setup of one desk (interfaces 1.3), run by the engine through operator methods after create_desk. Every
// step reads the venue first and skips what is already done, so a rerun (or a run after a crash or an unknown
// outcome) never signs twice for the same thing: the venue's own state, not the engine's memory, decides.
//
//   hyperliquid  hl_set_referrer (no code: skipped), hl_approve_builder_fee; both need the account to exist, so an
//                unfunded desk waits for its first deposit and retries then
//   orderly      register -> add key (an expired key is reported, never added again: Orderly refuses a key it holds)
//                -> receiver_address lookup (the owner pins it; a pinned one must match) -> referral_bind (no code:
//                skipped) -> ip_restriction (no set_orderly_ips list: skipped)
//   phoenix      register (build-register-ixs, sol_sign_register, send-register-ixs; done once the trader account
//                exists; with none, every run first looks for one for as long as an earlier run's registration could
//                still land) -> referral (no code: skipped; already activated: done without signing; not activated on
//                an account this run did not register: looked for as long first); mainnet only
//
// A SetupProgress with every step goes out after each change.

import type { SetupProgress, TxRef } from '@gimbal/shared';
import type { DeskView } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import { sleep as realSleep } from '../relayer/tx.ts';
import { errorMessage } from '../venues/recorder.ts';

export type SetupStep = SetupProgress['steps'][number];
export type SetupStepName = SetupStep['step'];

export const SETUP_STEPS: readonly SetupStepName[] = [
  'hl_set_referrer', 'hl_approve_builder_fee',
  'orderly_register', 'orderly_add_key', 'orderly_receiver_lookup', 'orderly_referral_bind', 'orderly_ip_restriction',
  'phoenix_register', 'phoenix_referral',
];

/** Hyperliquid's part: public /info reads for the done-checks, signed actions through the relayer. */
export interface HlSetup {
  /** userRole is not "missing": Hyperliquid knows the address (it has had a deposit). */
  hasAccount(): Promise<boolean>;
  /** The referral code (or referrer) the account is bound to, null when none. */
  referredBy(): Promise<string | null>;
  /** maxBuilderFee for the treasury builder, in tenths of a basis point. */
  approvedBuilderFee(): Promise<number>;
  setReferrer(): Promise<TxRef[]>;
  approveBuilderFee(): Promise<TxRef[]>;
}

/** OrderlyDeskClient's setup part. */
export interface OrderlySetup {
  readonly accountId: string;
  isRegistered(brokerId: string): Promise<boolean>;
  keyInfo(): Promise<{ scope: string | null; expiration: number | null; status: string | null } | null>;
  register(): Promise<string>;
  addKey(): Promise<string>;
  receiverAddress(): Promise<unknown>;
  bindReferral(): Promise<'bound' | 'skipped'>;
  restrictKeyIps(): Promise<unknown>;
}

/** PhoenixOnboarding's part. */
export interface PhoenixSetup {
  isRegistered(): Promise<boolean>;
  register(): Promise<{ tx: TxRef[] }>;
  /** The trader account already carries the capabilities a referral activation grants. */
  referralActivated(): Promise<boolean>;
  activateReferral(): Promise<{ status: string; tx: TxRef[] } | null>;
}

export interface SetupPlan {
  deskId: string;
  /** get_desk, read fresh (the receiver the owner pinned, the IP list). */
  desk(): Promise<DeskView>;
  referralCodes: { hyperliquid: string | null; orderly: string | null; phoenix: string | null };
  /** fees.hl_builder_tenth_bps; null or 0 means no builder fee to approve. */
  builderFeeTenthBps: number | null;
  brokerId: string;
  hl: HlSetup;
  orderly: OrderlySetup;
  /** null: Phoenix is not set up on this network (testnet; Phoenix runs on mainnet only). */
  phoenix: PhoenixSetup | null;
  /** The NEAR transactions of the Orderly signatures since the last call (the Orderly client returns none itself). */
  takeOrderlyTx?: () => TxRef[];
  publish(progress: SetupProgress): void;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often an unfunded Hyperliquid account is looked at again; default 30 s. */
  depositPollMs?: number;
  /** How long setup waits for that deposit before it leaves the Hyperliquid steps pending; default 30 min. */
  depositWaitMs?: number;
  /** An orderly key that expires sooner than this shows the days it has left; default 30 days. */
  keyWarnMs?: number;
  /** How often, and how many times, a sent Phoenix registration is looked for on Solana; default 3 s, 10 times. */
  phoenixPollMs?: number;
  phoenixPolls?: number;
  /** How long a signed Phoenix registration can still land (see PHOENIX_LANDING_MS). */
  phoenixLandingMs?: number;
}

/**
 * How long a signed Solana transaction can still land: its blockhash is good for 150 blocks, about 60 s, and this
 * leaves a margin for slow or skipped slots. Every run that finds no trader account looks for one this long before it
 * signs a registration: an earlier run's (whose poll gave up, or which crashed) can land until then, and a second
 * registration signed meanwhile would be a second transaction for the same account.
 */
export const PHOENIX_LANDING_MS = 90_000;

type Outcome = { status: 'done' | 'skipped' | 'pending' | 'failed'; detail?: string; tx?: TxRef[] };

/** Hyperliquid's answer when the address has no account yet (seen on testnet: "User or API Wallet 0x… does not exist."). */
const HL_NO_ACCOUNT = /does not exist|must deposit/i;
const DAY_MS = 86_400_000;
const WAITING_FOR_DEPOSIT = 'waiting for the first deposit on Hyperliquid: the account does not exist until it lands';

export async function runSetup(plan: SetupPlan): Promise<SetupProgress> {
  const now = plan.now ?? Date.now;
  const sleep = plan.sleep ?? realSleep;
  const steps: SetupStep[] = SETUP_STEPS.map((step) => ({ step, status: 'pending', tx: [] }));
  const at = (name: SetupStepName) => steps.find((s) => s.step === name)!;
  const progress = (): SetupProgress => ({ deskId: plan.deskId, steps: steps.map((s) => ({ ...s, tx: [...s.tx] })) });
  const emit = () => plan.publish(progress());

  const set = (name: SetupStepName, status: SetupStep['status'], detail?: string, tx: TxRef[] = []) => {
    const s = at(name);
    s.status = status;
    if (detail === undefined) delete s.detail;
    else s.detail = detail;
    s.tx.push(...tx);
    emit();
  };

  /** Runs one step: done-check and action inside `body`; a failure stays on this step and stops its dependents. */
  const run = async (name: SetupStepName, body: () => Promise<Outcome>): Promise<SetupStep['status']> => {
    set(name, 'running');
    try {
      const r = await body();
      set(name, r.status, r.detail, [...(r.tx ?? []), ...(plan.takeOrderlyTx?.() ?? [])]);
    } catch (err) {
      // OutcomeUnknown and NothingExecuted carry the transactions that did happen (the NEAR signature at least).
      const own = (err as { tx?: unknown }).tx;
      const tx = [...(Array.isArray(own) ? own as TxRef[] : []), ...(plan.takeOrderlyTx?.() ?? [])];
      const detail = err instanceof OutcomeUnknown ? `${err.message}; a rerun reads the venue before it signs anything again` : errorMessage(err);
      plan.log?.(`setup ${plan.deskId} ${name}: ${detail}`);
      set(name, 'failed', detail, tx);
    }
    return at(name).status;
  };

  const waits = (name: SetupStepName, on: SetupStepName) => set(name, 'pending', `waits for ${on}`);

  emit();
  let hlWaiting = await hyperliquid(plan, run);
  await orderly(plan, run, waits, now);
  await phoenix(plan, run, waits, sleep);

  // The Hyperliquid steps need an account, which exists only after the first deposit: look again until it lands.
  const deadline = now() + (plan.depositWaitMs ?? 30 * 60_000);
  while (hlWaiting && now() < deadline) {
    await sleep(plan.depositPollMs ?? 30_000);
    let funded: boolean;
    try {
      funded = await plan.hl.hasAccount();
    } catch (err) {
      plan.log?.(`setup ${plan.deskId}: Hyperliquid userRole: ${errorMessage(err)}`);
      continue;
    }
    if (funded) hlWaiting = await hyperliquid(plan, run);
  }
  if (hlWaiting) {
    for (const name of ['hl_set_referrer', 'hl_approve_builder_fee'] as const) {
      if (at(name).status === 'pending') set(name, 'pending', `${WAITING_FOR_DEPOSIT}; no deposit yet, so POST /setup again once it has one`);
    }
  }
  return progress();
}

type Run = (name: SetupStepName, body: () => Promise<Outcome>) => Promise<SetupStep['status']>;

/** The Hyperliquid steps; true when they wait for the account's first deposit. */
async function hyperliquid(plan: SetupPlan, run: Run): Promise<boolean> {
  let waiting = false;
  let exists: boolean | null = null;
  /**
   * An address Hyperliquid does not know is not a failure: the step waits for the deposit. userRole (free) is read
   * before signing, so no signature is spent on an answer known in advance; Hyperliquid's own refusal (seen on testnet
   * 2026-10-31: "Must deposit before performing actions. User: 0x…") covers a deposit that has not settled yet.
   */
  const orWait = async (act: () => Promise<TxRef[]>): Promise<Outcome> => {
    exists ??= await plan.hl.hasAccount();
    if (!exists) {
      waiting = true;
      return { status: 'pending', detail: WAITING_FOR_DEPOSIT };
    }
    try {
      return { status: 'done', tx: await act() };
    } catch (err) {
      if (!(err instanceof OutcomeUnknown) && HL_NO_ACCOUNT.test(errorMessage(err))) {
        waiting = true;
        exists = false;
        const own = (err as { tx?: unknown }).tx;
        return { status: 'pending', detail: `${WAITING_FOR_DEPOSIT} (Hyperliquid: ${errorMessage(err)})`, tx: Array.isArray(own) ? own as TxRef[] : [] };
      }
      throw err;
    }
  };

  const code = plan.referralCodes.hyperliquid;
  // Before the first order: Hyperliquid binds a referrer only to an account that has not traded yet.
  await run('hl_set_referrer', async () => {
    if (code === null) return { status: 'skipped', detail: 'no Hyperliquid referral code is configured' };
    const bound = await plan.hl.referredBy();
    if (bound !== null) return { status: 'done', detail: bound === code ? `referred by ${code}` : `already referred by ${bound}; Hyperliquid binds one referrer per account` };
    const r = await orWait(() => plan.hl.setReferrer());
    return r.status === 'done' ? { ...r, detail: `referrer set: ${code}` } : r;
  });

  const fee = plan.builderFeeTenthBps;
  await run('hl_approve_builder_fee', async () => {
    if (fee === null || fee <= 0) return { status: 'skipped', detail: 'no builder fee is configured' };
    const approved = await plan.hl.approvedBuilderFee();
    if (approved >= fee) return { status: 'done', detail: `approved up to ${approved} tenths of a bp (the fee is ${fee})` };
    const r = await orWait(() => plan.hl.approveBuilderFee());
    if (r.status !== 'done') return r;
    const after = await plan.hl.approvedBuilderFee().catch(() => null);
    return { ...r, detail: after === null ? `approved ${fee} tenths of a bp` : `approved up to ${after} tenths of a bp (the fee is ${fee})` };
  });
  return waiting;
}

async function orderly(plan: SetupPlan, run: Run, waits: (name: SetupStepName, on: SetupStepName) => void, now: () => number): Promise<void> {
  const o = plan.orderly;
  const registered = await run('orderly_register', async () => {
    if (await o.isRegistered(plan.brokerId)) return { status: 'done', detail: `registered under ${plan.brokerId}: ${o.accountId}` };
    return { status: 'done', detail: `registered under ${plan.brokerId}: ${await o.register()}` };
  });
  const after = ['orderly_add_key', 'orderly_receiver_lookup', 'orderly_referral_bind', 'orderly_ip_restriction'] as const;
  if (registered !== 'done') {
    for (const name of after) waits(name, 'orderly_register');
    return;
  }

  const usable = (key: Awaited<ReturnType<OrderlySetup['keyInfo']>>) =>
    key !== null && key.status === 'ACTIVE' && (key.scope ?? '').split(',').includes('trading') && (key.expiration ?? 0) > now();
  // Orderly refuses to add a key it already holds (seen on testnet 2026-10-31: -1616 "orderlyKey already exists"),
  // even close to its expiry, and the desk has exactly one Ed25519 key: an active key is done, its expiry is shown.
  // A key Orderly knows but that is no longer usable (expired, another scope) cannot be added again either: the step
  // fails with what Orderly holds, and nothing is signed.
  const keyDetail = (key: { expiration: number | null }, prefix: string) => {
    if (key.expiration === null) return prefix;
    const left = key.expiration - now();
    return `${prefix} until ${new Date(key.expiration).toISOString().slice(0, 10)}${left < orderlyWarnMs(plan) ? ` (${Math.floor(left / DAY_MS)} days left)` : ''}`;
  };
  const keyed = await run('orderly_add_key', async () => {
    const key = await o.keyInfo();
    if (usable(key)) return { status: 'done', detail: keyDetail(key!, 'key active') };
    if (key !== null) {
      const until = key.expiration === null ? 'no expiry' : `expiration ${new Date(key.expiration).toISOString().slice(0, 10)}`;
      return { status: 'failed', detail: `Orderly holds the desk's key as ${key.status ?? 'status unknown'}, scope ${key.scope ?? 'unknown'}, ${until}: it is not usable and Orderly refuses to add it again (-1616); the desk needs a new key` };
    }
    try {
      await o.addKey();
    } catch (err) {
      const again = await o.keyInfo().catch(() => null);
      if (usable(again)) return { status: 'done', detail: keyDetail(again!, 'key active') };
      throw err;
    }
    const added = await o.keyInfo().catch(() => null);
    return { status: 'done', detail: added === null ? 'key added' : keyDetail(added, `key added, ${added.status ?? 'status unknown'}`) };
  });
  // Every later step is a request signed with the orderly key.
  if (keyed !== 'done') {
    for (const name of after.slice(1)) waits(name, 'orderly_add_key');
    return;
  }

  // The detail is the address alone, lowercase: the dashboard reads it from there and asks the owner to pin it with
  // set_orderly_receiver. A receiver already pinned is looked up too: deposits go to the pinned one, so one that is
  // not Orderly's answer for this account fails the step.
  await run('orderly_receiver_lookup', async () => {
    const pinned = (await plan.desk()).orderly_receiver;
    const address = receiverOf(await o.receiverAddress());
    if (pinned !== null && pinned.toLowerCase() !== address) {
      throw new Error(`the pinned receiver ${pinned.toLowerCase()} is not the one Orderly gives this account (${address}): pin ${address} with set_orderly_receiver`);
    }
    return { status: 'done', detail: address };
  });

  await run('orderly_referral_bind', async () => {
    if (plan.referralCodes.orderly === null) return { status: 'skipped', detail: 'no Orderly referral code is configured' };
    try {
      await o.bindReferral();
    } catch (err) {
      // A bind is permanent and there is no public read of it: a second bind is refused, which is the done-check.
      if (/already/i.test(errorMessage(err))) return { status: 'done', detail: `already bound (Orderly: ${errorMessage(err)})` };
      throw err;
    }
    return { status: 'done', detail: `bound ${plan.referralCodes.orderly}` };
  });

  await run('orderly_ip_restriction', async () => {
    const ips = (await plan.desk()).orderly_ips ?? [];
    if (ips.length === 0) return { status: 'skipped', detail: 'no IP list is set (set_orderly_ips)' };
    // Setting the same list again changes nothing, so this step simply applies the stored list every run.
    await o.restrictKeyIps();
    return { status: 'done', detail: `key limited to ${ips.join(', ')}` };
  });
}

function orderlyWarnMs(plan: SetupPlan): number {
  return plan.keyWarnMs ?? 30 * DAY_MS;
}

async function phoenix(plan: SetupPlan, run: Run, waits: (name: SetupStepName, on: SetupStepName) => void, sleep: (ms: number) => Promise<void>): Promise<void> {
  const p = plan.phoenix;
  if (p === null) {
    await run('phoenix_register', async () => ({ status: 'skipped', detail: 'Phoenix runs on mainnet only' }));
    await run('phoenix_referral', async () => ({ status: 'skipped', detail: 'Phoenix runs on mainnet only' }));
    return;
  }
  const pollMs = plan.phoenixPollMs ?? 3_000;
  const landingMs = plan.phoenixLandingMs ?? PHOENIX_LANDING_MS;
  const landingS = Math.ceil(landingMs / 1000);
  /**
   * Looks for what an earlier run may have signed until it can no longer land, before this run signs it again. A read
   * that fails here fails the step: nothing is signed on a guess.
   */
  const lookFor = async (landed: () => Promise<boolean>): Promise<boolean> => {
    if (!(pollMs > 0) || !Number.isFinite(pollMs) || !(landingMs >= 0) || !Number.isFinite(landingMs)) {
      throw new Error(`phoenixPollMs must be over 0 and phoenixLandingMs 0 or more, got ${pollMs} and ${landingMs}: nothing is signed`);
    }
    for (let waited = 0; waited < landingMs; waited += pollMs) {
      await sleep(pollMs);
      if (await landed()) return true;
    }
    return false;
  };
  /** This run signed the registration: the account did not exist before, so no earlier run reached the referral. */
  let registeredHere = false;
  const registered = await run('phoenix_register', async () => {
    if (await p.isRegistered()) return { status: 'done', detail: 'trader account exists' };
    plan.log?.(`setup ${plan.deskId} phoenix_register: no trader account; looking for one for ${landingS} s before signing, in case an earlier run's registration is still landing`);
    if (await lookFor(() => p.isRegistered())) return { status: 'done', detail: 'trader account exists: an earlier registration landed' };
    const { tx } = await p.register();
    registeredHere = true;
    // send-register-ixs answering is not the account existing: Phoenix sends the transaction, Solana lands it or not.
    for (let i = 0; i < (plan.phoenixPolls ?? 10); i++) {
      await sleep(pollMs);
      if (await p.isRegistered().catch(() => false)) return { status: 'done', detail: 'registered: trader account exists', tx };
    }
    return {
      status: 'failed', tx,
      detail: `Phoenix took the registration, but the trader account does not exist yet: a rerun looks for it for ${landingS} s before it signs anything`,
    };
  });
  if (registered !== 'done') return waits('phoenix_referral', 'phoenix_register');
  await run('phoenix_referral', async () => {
    if (plan.referralCodes.phoenix === null) return { status: 'skipped', detail: 'no Phoenix referral code is configured' };
    if (await p.referralActivated()) return { status: 'done', detail: 'already activated: the trader account has the referral capabilities' };
    // An earlier run's activation (sent, then a crash or a rerun before it landed) can land as long as a
    // registration can; a second one signed meanwhile is a second transaction. Not needed when this run registered.
    if (!registeredHere) {
      plan.log?.(`setup ${plan.deskId} phoenix_referral: not activated; looking for ${landingS} s before signing, in case an earlier run's activation is still landing`);
      if (await lookFor(() => p.referralActivated())) return { status: 'done', detail: 'activated: an earlier activation landed' };
    }
    const r = await p.activateReferral();
    if (r === null) return { status: 'skipped', detail: 'no Phoenix referral code is configured' };
    return { status: 'done', detail: `activate-tx: ${r.status}`, tx: r.tx };
  });
}

/**
 * The receiver in Orderly's receiver_address answer: its `receiver_address` field, lowercase. Anything else is an
 * error: the owner pins this address and deposits are sent to it, so a guess from another field is never good enough.
 */
export function receiverOf(answer: unknown): string {
  const v = typeof answer === 'object' && answer !== null ? (answer as { receiver_address?: unknown }).receiver_address : undefined;
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`receiver_address: no receiver_address address in the answer ${JSON.stringify(answer).slice(0, 200)}`);
  }
  return v.toLowerCase();
}
