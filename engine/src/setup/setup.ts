// Venue setup of one desk (interfaces 1.3), run by the engine through operator methods after create_desk. Every
// step reads the venue first and skips what is already done, so a rerun (or a run after a crash or an unknown
// outcome) never signs twice for the same thing: the venue's own state, not the engine's memory, decides.
//
//   hyperliquid  hl_set_referrer (no code: skipped), hl_approve_builder_fee; both need the account to exist, so an
//                unfunded desk waits for its first deposit and retries then
//   orderly      register -> add key -> receiver_address lookup (the owner pins it) -> referral_bind (no code:
//                skipped) -> ip_restriction (no set_orderly_ips list: skipped)
//   phoenix      register (build-register-ixs, sol_sign_register, send-register-ixs) -> referral (no code: skipped);
//                mainnet only
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
}

type Outcome = { status: 'done' | 'skipped' | 'pending'; detail?: string; tx?: TxRef[] };

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
  await phoenix(plan, run, waits);

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
  const keyDetail = (key: { expiration: number | null }, prefix: string) => {
    if (key.expiration === null) return prefix;
    const left = key.expiration - now();
    return `${prefix} until ${new Date(key.expiration).toISOString().slice(0, 10)}${left < orderlyWarnMs(plan) ? ` (${Math.floor(left / DAY_MS)} days left)` : ''}`;
  };
  const keyed = await run('orderly_add_key', async () => {
    const key = await o.keyInfo();
    if (usable(key)) return { status: 'done', detail: keyDetail(key!, 'key active') };
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
  // set_orderly_receiver (an address already pinned is shown the same way).
  await run('orderly_receiver_lookup', async () => {
    const pinned = (await plan.desk()).orderly_receiver;
    if (pinned !== null) return { status: 'done', detail: pinned.toLowerCase() };
    const answer = await o.receiverAddress();
    const address = receiverOf(answer);
    if (address === null) throw new Error(`receiver_address: no address in ${JSON.stringify(answer).slice(0, 200)}`);
    return { status: 'done', detail: address.toLowerCase() };
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

async function phoenix(plan: SetupPlan, run: Run, waits: (name: SetupStepName, on: SetupStepName) => void): Promise<void> {
  const p = plan.phoenix;
  if (p === null) {
    await run('phoenix_register', async () => ({ status: 'skipped', detail: 'Phoenix runs on mainnet only' }));
    await run('phoenix_referral', async () => ({ status: 'skipped', detail: 'Phoenix runs on mainnet only' }));
    return;
  }
  const registered = await run('phoenix_register', async () => {
    if (await p.isRegistered()) return { status: 'done', detail: 'trader account exists' };
    return { status: 'done', detail: 'registered', tx: (await p.register()).tx };
  });
  if (registered !== 'done') return waits('phoenix_referral', 'phoenix_register');
  await run('phoenix_referral', async () => {
    if (plan.referralCodes.phoenix === null) return { status: 'skipped', detail: 'no Phoenix referral code is configured' };
    const r = await p.activateReferral();
    if (r === null) return { status: 'skipped', detail: 'no Phoenix referral code is configured' };
    return { status: 'done', detail: `activate-tx: ${r.status}`, tx: r.tx };
  });
}

/** The receiver address in Orderly's receiver_address answer: the data itself, or its first EVM address field. */
export function receiverOf(answer: unknown): string | null {
  const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (isAddress(answer)) return answer;
  if (typeof answer !== 'object' || answer === null) return null;
  const entries = Object.entries(answer as Record<string, unknown>);
  const named = entries.find(([k, v]) => /address|receiver/i.test(k) && isAddress(v));
  return (named ?? entries.find(([, v]) => isAddress(v)))?.[1] as string | undefined ?? null;
}
