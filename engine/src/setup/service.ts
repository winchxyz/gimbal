// POST /setup's side: one venue setup run per desk at a time, built from the contract client and the venues'
// endpoints. Every signature goes through the operator key's contract methods; nothing here holds a key.

import type { SetupProgress, TxRef } from '@gimbal/shared';
import type { ContractConfigView, NearNetwork } from '../contract/near-client.ts';
import type { ContractClient, DeskView, HlSignedAction } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { Relayer } from '../relayer/relayer.ts';
import { hlTradeFetch } from '../venues/hyperliquid.ts';
import { errorMessage } from '../venues/recorder.ts';
import { OrderlyDeskClient } from '../venues/orderly-actions.ts';
import type { OrderlySigner } from '../venues/orderly-signer.ts';
import type { OrderlyWithdrawRun } from './orderly-withdraw.ts';
import { PhoenixOnboarding, solanaReads } from './phoenix.ts';
import { publicIpLookup, type PublicIps } from './public-ip.ts';
import type { HlSetup, SetupPlan } from './setup.ts';
import { runSetup } from './setup.ts';
import type { RouteAnswer, SetupStarter } from './route.ts';
import { refused } from './route.ts';

export interface SetupServiceOptions {
  network: NearNetwork;
  contract: ContractClient;
  /** The NEAR account the operator key is on: it can set up the desks that account owns or operates. */
  operatorAccount: string;
  config: ContractConfigView;
  hlUrl: string;                 // Hyperliquid API root (no /info)
  orderlyUrl: string;            // Orderly REST root
  /** Mainnet only (Phoenix): Solana JSON-RPC for the blockhash and the trader-account check. */
  solanaRpcUrl?: string;
  phoenixApiUrl?: string;
  fetch?: typeof fetch;
  /** This engine's public IPs, checked against a desk's IP list before it is applied; default: the lookup in public-ip.ts. */
  publicIps?: PublicIps;
  log?: (line: string) => void;
  /** Passed to runSetup (tests make them instant). */
  depositPollMs?: number;
  depositWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SetupService implements SetupStarter {
  readonly #o: SetupServiceOptions;
  readonly #publicIps: PublicIps;
  readonly #running = new Map<string, Promise<SetupProgress | null>>();
  /** A GIMBAL_ORDERLY_WITHDRAW run started next to this service (serve-setup.ts); serve's shutdown drains it. */
  orderlyWithdraw: OrderlyWithdrawRun | null = null;

  constructor(options: SetupServiceOptions) {
    this.#o = options;
    this.#publicIps = options.publicIps ?? publicIpLookup(options.fetch === undefined ? {} : { fetch: options.fetch });
  }

  /** Starts a run in the background and answers at once; progress goes to `publish`. */
  async start(deskId: string, publish: (progress: SetupProgress) => void): Promise<RouteAnswer> {
    if (this.#running.has(deskId)) return refused(`setup of ${deskId} is already running`);
    // The slot is taken before the first await, so two POSTs at once cannot both start a run.
    let settle!: (progress: SetupProgress | null) => void;
    this.#running.set(deskId, new Promise((resolve) => (settle = resolve)));
    let plan: SetupPlan;
    try {
      const desk = await this.#o.contract.getDesk(deskId);
      if (desk === null) throw new Error(`the contract has no desk ${deskId}`);
      if (desk.owner !== this.#o.operatorAccount && desk.operator !== this.#o.operatorAccount) {
        throw new Error(`desk ${deskId} belongs to ${desk.owner}; the operator key is on ${this.#o.operatorAccount}`);
      }
      plan = this.plan(deskId, desk, publish);
    } catch (err) {
      this.#running.delete(deskId);
      settle(null);
      return refused(errorMessage(err));
    }
    this.#o.log?.(`setup ${deskId}: started`);
    void runSetup(plan)
      .catch((err: unknown) => {
        this.#o.log?.(`setup ${deskId}: stopped: ${errorMessage(err)}`);
        return null;
      })
      .then((progress) => {
        this.#running.delete(deskId);
        settle(progress);
      });
    return { status: 200, body: { ok: true } };
  }

  /** The run in progress for a desk, if any (resolves with its last progress). */
  running(deskId: string): Promise<SetupProgress | null> | null {
    return this.#running.get(deskId) ?? null;
  }

  plan(deskId: string, desk: DeskView, publish: (progress: SetupProgress) => void): SetupPlan {
    const o = this.#o;
    const codes = o.config.treasury?.referral_codes ?? {};
    const code = (venue: string) => {
      const c = codes[venue];
      return typeof c === 'string' && c !== '' ? c : null;
    };
    const brokerId = o.config.orderly?.broker_id;
    if (brokerId === undefined) throw new Error('config().orderly.broker_id is missing');
    if (desk.orderly_account_id === undefined) throw new Error(`get_desk(${deskId}) has no orderly_account_id`);
    const builder = o.config.treasury?.hl_builder;
    const fee = o.config.fees?.hl_builder_tenth_bps;

    const collected = collectingSigner(o.contract);
    const orderly = new OrderlyDeskClient({
      deskId, network: o.network, apiUrl: o.orderlyUrl, accountId: desk.orderly_account_id,
      orderlyKey: `ed25519:${desk.solana.authority}`, evmAddress: desk.evm_address,
      referralCode: code('orderly'), signer: collected.signer, ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
      ...(o.now === undefined ? {} : { clock: { now: o.now } }),
    });
    const relayer = new Relayer({
      contract: o.contract, deskId,
      hyperliquid: new HyperliquidSubmitter({ network: o.network, apiUrl: o.hlUrl, ...(o.fetch === undefined ? {} : { fetch: o.fetch }) }),
    });
    let phoenix: PhoenixOnboarding | null = null;
    if (o.network === 'mainnet') {
      if (o.solanaRpcUrl === undefined) throw new Error('Phoenix setup needs a Solana RPC (SOLANA_RPC_URL)');
      phoenix = new PhoenixOnboarding({
        deskId, authority: desk.solana.authority, traderPda: desk.solana.phoenix_trader, referralCode: code('phoenix'), signer: o.contract,
        solana: solanaReads(o.solanaRpcUrl, o.fetch), ...(o.phoenixApiUrl === undefined ? {} : { apiUrl: o.phoenixApiUrl }),
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
      });
    }

    return {
      deskId,
      desk: async () => {
        const d = await o.contract.getDesk(deskId);
        if (d === null) throw new Error(`the contract has no desk ${deskId}`);
        return d;
      },
      referralCodes: { hyperliquid: code('hyperliquid'), orderly: code('orderly'), phoenix: code('phoenix') },
      builderFeeTenthBps: builder === undefined || fee === undefined ? null : fee,
      brokerId,
      hl: hlSetup(o.hlUrl, desk.evm_address, builder ?? null, {
        setReferrer: () => o.contract.hlSetReferrer(deskId), approveBuilderFee: () => o.contract.hlApproveBuilderFee(deskId),
        submit: (signed) => relayer.submitHl(signed),
      }, o.fetch ?? hlTradeFetch(o.hlUrl)),
      orderly,
      phoenix,
      relayerIps: this.#publicIps,
      takeOrderlyTx: collected.take,
      publish,
      ...(o.log === undefined ? {} : { log: o.log }),
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
      ...(o.depositPollMs === undefined ? {} : { depositPollMs: o.depositPollMs }),
      ...(o.depositWaitMs === undefined ? {} : { depositWaitMs: o.depositWaitMs }),
    };
  }
}

export interface HlSetupSigner {
  setReferrer(): Promise<HlSignedAction>;
  approveBuilderFee(): Promise<HlSignedAction>;
  /** Posts and confirms a signed action (the relayer). */
  submit(signed: HlSignedAction): Promise<{ tx: TxRef[] }>;
}

/** Hyperliquid's setup reads (public /info) and its two signed actions (signed by the contract, sent by the relayer). */
export function hlSetup(apiUrl: string, user: string, builder: string | null, signer: HlSetupSigner, fetchImpl: typeof fetch): HlSetup {
  const address = user.toLowerCase();
  // A refusal keeps the NEAR transaction that signed it, so the step shows what was spent.
  const send = async (sign: () => Promise<HlSignedAction>): Promise<TxRef[]> => {
    const signed = await sign();
    try {
      return (await signer.submit(signed)).tx;
    } catch (err) {
      if (err instanceof OutcomeUnknown || signed.nearTx === undefined || Array.isArray((err as { tx?: unknown }).tx)) throw err;
      throw Object.assign(new Error(errorMessage(err)), { tx: [signed.nearTx] });
    }
  };
  const info = async <T>(body: Record<string, unknown>): Promise<T> => {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/info`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json() as T;
  };
  return {
    hasAccount: async () => (await info<{ role?: string }>({ type: 'userRole', user: address })).role !== 'missing',
    referredBy: async () => {
      const r = await info<{ referredBy?: { code?: string; referrer?: string } | null }>({ type: 'referral', user: address });
      const by = r.referredBy ?? null;
      return by === null ? null : by.code ?? by.referrer ?? JSON.stringify(by);
    },
    approvedBuilderFee: async () => {
      if (builder === null) return 0;
      const n = Number(await info<unknown>({ type: 'maxBuilderFee', user: address, builder: builder.toLowerCase() }));
      if (!Number.isFinite(n)) throw new Error('hyperliquid maxBuilderFee: not a number');
      return n;
    },
    setReferrer: () => send(signer.setReferrer),
    approveBuilderFee: () => send(signer.approveBuilderFee),
  };
}

/** The contract's Orderly methods, keeping the NEAR transaction of every signature for the step that asked. */
export function collectingSigner(signer: OrderlySigner): { signer: OrderlySigner; take: () => TxRef[] } {
  const seen: TxRef[] = [];
  const keep = async <T extends { nearTx?: TxRef }>(signed: Promise<T>): Promise<T> => {
    const action = await signed;
    if (action.nearTx !== undefined) seen.push(action.nearTx);
    return action;
  };
  return {
    signer: {
      orderlyRequest: (d, req, reason) => keep(signer.orderlyRequest(d, req, reason)),
      orderlyWsAuth: (d, t) => keep(signer.orderlyWsAuth(d, t)),
      orderlyRegister: (d, nonce) => keep(signer.orderlyRegister(d, nonce)),
      orderlyAddKey: (d, ms) => keep(signer.orderlyAddKey(d, ms)),
      orderlySettlePnl: (d, nonce) => keep(signer.orderlySettlePnl(d, nonce)),
      orderlyWithdraw: (d, amount, nonce) => keep(signer.orderlyWithdraw(d, amount, nonce)),
    },
    take: () => seen.splice(0),
  };
}
