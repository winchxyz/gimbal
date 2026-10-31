// A whole fake world for onboarding: a wallet that signs, a chain that keeps desks and keys, an engine that drafts
// rules and runs venue setup, 1Click, and an exchange's public data. The same object serves the tests and the
// development page (`?ob=...` with no engine and no wallet), so what the tests prove is what the page shows.
//
// The chain applies every signed transaction the way the contract does: it checks the arguments `create_desk` is
// given against the keys it derived, refuses a non-owner, and keeps the ledger. Nothing here is a real address.
import { sha256 } from '@noble/hashes/sha2.js';
import type { ContractPolicy, PolicyDraft, SetupProgress, StrategyConfig } from '@gimbal/shared';
import { createStore, type Store } from '../stream/hub.ts';
import { b58encode, evmPath, solPath, addressesFrom } from './derive.ts';
import type { Chain, ChainDesk } from './chain.ts';
import { DraftUnavailable, EngineError, type OnboardingEngine } from './engine.ts';
import type { IntentsApi, IntentsQuote, IntentsRequest, IntentsStatus } from './intents.ts';
import type { OnboardingConfig } from './config.ts';
import type { FlowDeps } from './flow.ts';
import type { AccessKeyInfo } from './operator.ts';
import { DEFAULT_ALLOWANCE_NEAR, OPERATOR_METHODS } from './operator.ts';
import { policyProblems, strategyProblems } from './policy.ts';
import { defaultStrategy } from './rules.ts';
import type { HlAsset, VenueData } from './marks.ts';
import { WalletError, type NearNetwork, type TxOutcome, type Wallet, type WalletTx } from './wallet.ts';

const bytes = (seed: string, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 32) out.set(sha256(new TextEncoder().encode(`${seed}/${i}`)).subarray(0, Math.min(32, length - i)), i);
  return out;
};

/** A well-formed `ed25519:` key for a seed (not on any curve; the page checks only the shape). */
export const fakeEd25519 = (seed: string): string => `ed25519:${b58encode(bytes(seed, 32))}`;
const fakeSecp256k1 = (seed: string): string => `secp256k1:${b58encode(bytes(seed, 64))}`;

export const FAKE_ENGINE_KEY = fakeEd25519('fake engine operator key');
export const FAKE_RECEIVER = '0x00000000000000000000000000000000000f4ce1';

const SETUP_STEPS: SetupProgress['steps'][number]['step'][] = [
  'hl_set_referrer',
  'hl_approve_builder_fee',
  'orderly_register',
  'orderly_add_key',
  'orderly_receiver_lookup',
  'orderly_referral_bind',
  'orderly_ip_restriction',
  'phoenix_register',
  'phoenix_referral',
];

interface FakeDesk {
  owner: string;
  policy: ContractPolicy;
  evm_address: string;
  solana: ChainDesk['solana'];
  orderly_receiver: string | null;
  ips: string[];
  deposited: bigint;
}

export interface FakeOptions {
  network?: NearNetwork;
  contractId?: string;
  usdcToken?: string;
  account?: string;
}

/** Everything the page talks to, behind the same interfaces as the real ones, plus levers to make things go wrong. */
export class FakeWorld {
  readonly network: NearNetwork;
  readonly contractId: string;
  readonly usdcToken: string;
  readonly account: string;
  readonly mpc = 'v1.signer-prod.testnet';

  readonly desks = new Map<string, FakeDesk>();
  readonly keys = new Map<string, AccessKeyInfo[]>();
  readonly tokens = new Map<string, bigint>();
  /** Every transaction the wallet signed, in order. */
  readonly sent: WalletTx[] = [];
  /** Every call the page made to the engine, in order. */
  readonly engineCalls: string[] = [];
  readonly setupStore: Store<SetupProgress | null, SetupProgress | null> = createStore((_s: SetupProgress | null, a: SetupProgress | null) => a, null);

  // levers
  /** The wallet remembers a session from an earlier visit. */
  restores = false;
  walletSilent = false;
  signSilent = false;
  /** Make the contract refuse this method with this text. */
  refuse: { method: string; text: string } | null = null;
  draftMode: 'ok' | 'unavailable' | 'silent' | 'broken' = 'ok';
  putStrategyRefusal: string | null = null;
  setupRefusal: string | null = null;
  intentsStatus: IntentsStatus = 'PENDING_DEPOSIT';
  intentsDown = false;
  marksDown = false;
  /** Marks by symbol; a symbol that is not here is unlisted. */
  marks = new Map<string, number>([['BTC', 64_000], ['ETH', 3_200], ['SOL', 150], ['DOGE', 0.14], ['NEAR', 4.2], ['kPEPE', 0.0075]]);
  hlAssets: HlAsset[] = [
    { index: 0, symbol: 'BTC', sz_decimals: 5 },
    { index: 1, symbol: 'ETH', sz_decimals: 4 },
    { index: 5, symbol: 'SOL', sz_decimals: 2 },
    { index: 12, symbol: 'DOGE', sz_decimals: 0 },
    { index: 34, symbol: 'NEAR', sz_decimals: 1 },
    { index: 150, symbol: 'kPEPE', sz_decimals: 0 },
  ];
  /** The strategy the engine holds. */
  strategy: StrategyConfig = defaultStrategy();

  readonly wallet: Wallet;
  private account_: string | null = null;
  private signOut: (() => void)[] = [];
  private quotes = 0;

  constructor(options: FakeOptions = {}) {
    this.network = options.network ?? 'testnet';
    this.contractId = options.contractId ?? 'gimbal-c6-fcf135.testnet';
    this.usdcToken = options.usdcToken ?? 'usdc.fakes.testnet';
    this.account = options.account ?? 'demo-owner.testnet';
    this.wallet = this.makeWallet();
  }

  // ---- contract rules, as the contract applies them ----

  private derived(deskId: string) {
    return addressesFrom(fakeSecp256k1(evmPath(deskId)), fakeEd25519(solPath(deskId)));
  }

  private deskJson(d: FakeDesk): unknown {
    return {
      owner: d.owner,
      operator: null,
      paused: false,
      policy: d.policy,
      evm_address: d.evm_address,
      solana: d.solana,
      orderly_account_id: `0x${'ab'.repeat(32)}`,
      orderly_receiver: d.orderly_receiver,
      ledger: { deposited: d.deposited.toString(), idle_usdc: '0' },
    };
  }

  /** Applies one FunctionCall the way the contract would; returns the panic text or null. */
  private call(receiver: string, method: string, args: Record<string, unknown>, deposit: string, signer: string): string | null {
    if (this.refuse?.method === method) return this.refuse.text;
    if (receiver === this.usdcToken && method === 'ft_transfer_call') {
      const amount = BigInt(String(args.amount));
      const have = this.tokens.get(signer) ?? 0n;
      if (have < amount) return 'The account doesn’t have enough balance';
      const msg = JSON.parse(String(args.msg)) as { desk_id: string };
      const desk = this.desks.get(msg.desk_id);
      if (!desk) return 'E_NO_DESK: no such desk';
      this.tokens.set(signer, have - amount);
      desk.deposited += amount;
      return null;
    }
    if (receiver !== this.contractId) return `no such contract ${receiver}`;
    const deskId = String(args.desk_id ?? '');
    if (method === 'create_desk') {
      if (!/^[a-z0-9-]{1,32}$/.test(deskId)) return 'E_ARGS: bad desk id';
      if (this.desks.has(deskId)) return 'E_DESK_EXISTS: a desk with this id exists already';
      if (BigInt(deposit) < 1n) return 'E_DEPOSIT: attach NEAR for storage';
      const policy = args.policy as ContractPolicy;
      if (policyProblems(policy).length > 0) return 'E_ARGS: the policy is not valid';
      const want = this.derived(deskId);
      if (args.evm_address !== want.evm_address || JSON.stringify(args.solana) !== JSON.stringify(want.solana)) return 'E_MPC: the addresses do not match the MPC keys';
      this.desks.set(deskId, { owner: signer, policy, evm_address: want.evm_address, solana: want.solana, orderly_receiver: null, ips: [], deposited: 0n });
      return null;
    }
    const desk = this.desks.get(deskId);
    if (!desk) return 'E_NO_DESK: no such desk';
    if (desk.owner !== signer) return 'E_NOT_ALLOWED: only the owner may call this';
    if (method === 'set_policy') {
      if (BigInt(deposit) < 1n) return 'E_DEPOSIT: attach NEAR for storage';
      const policy = args.policy as ContractPolicy;
      if (policyProblems(policy).length > 0) return 'E_ARGS: the policy is not valid';
      desk.policy = policy;
      return null;
    }
    if (method === 'set_orderly_receiver') {
      if (deposit !== '1') return 'E_DEPOSIT: attach exactly 1 yoctoNEAR';
      desk.orderly_receiver = String(args.receiver);
      return null;
    }
    if (method === 'set_orderly_ips') {
      if (deposit !== '1') return 'E_DEPOSIT: attach exactly 1 yoctoNEAR';
      const ips = args.ips as string[];
      if (ips.length < 1 || ips.length > 10) return 'E_ARGS: 1 to 10 IPs';
      desk.ips = ips;
      return null;
    }
    return `E_ARGS: ${method} is not a method of the fake contract`;
  }

  // ---- the five seams ----

  private makeWallet(): Wallet {
    return {
    network: this.network,
    accountId: () => this.account_,
    restore: async () => {
      if (this.restores) this.account_ = this.account;
      return this.account_;
    },
    connect: async () => {
      if (this.walletSilent) throw new WalletError('no wallet answered');
      this.account_ = this.account;
      return this.account;
    },
    signAndSend: async (tx) => {
      if (this.signSilent) throw new WalletError('the wallet was closed');
      const signer = this.account_;
      if (signer === null) throw new WalletError('no wallet is connected');
      this.sent.push(tx);
      let failure: string | null = null;
      for (const action of tx.actions) {
        if (action.type === 'AddKey') {
          if (tx.receiverId !== signer) return { hash: null, value: null, failure: 'AddKey is only for the signer’s own account' };
          const { publicKey, accessKey } = action.params;
          const list = this.keys.get(signer) ?? [];
          this.keys.set(signer, [...list.filter((k) => k.publicKey !== publicKey), { publicKey, permission: { ...accessKey.permission } }]);
        } else {
          failure = this.call(tx.receiverId, action.params.methodName, action.params.args as Record<string, unknown>, action.params.deposit, signer);
          if (failure !== null) break;
        }
      }
      const outcome: TxOutcome = { hash: `fake-tx-${this.sent.length}`, value: null, failure };
      return outcome;
    },
    disconnect: async () => {
      this.account_ = null;
    },
    onSignOut: (listener) => {
      this.signOut.push(listener);
      return () => {
        this.signOut = this.signOut.filter((l) => l !== listener);
      };
    },
    };
  }

  /** The wallet signs out by itself. */
  signOutNow(): void {
    this.account_ = null;
    for (const l of this.signOut) l();
  }

  readonly chain: Chain = {
    view: async (contract, method, args = {}) => {
      const a = args as Record<string, unknown>;
      if (contract === this.mpc && method === 'derived_public_key') {
        const path = String(a.path);
        return a.domain_id === 0 ? fakeSecp256k1(path) : fakeEd25519(path);
      }
      if (contract === this.usdcToken && method === 'ft_balance_of') return (this.tokens.get(String(a.account_id)) ?? 0n).toString();
      if (contract !== this.contractId) throw new Error(`${contract}: no such account`);
      if (method === 'config') return { network: this.network === 'mainnet' ? 'Mainnet' : 'Testnet', mpc: this.mpc };
      if (method === 'desks_of') return [...this.desks].filter(([, d]) => d.owner === a.owner).map(([id]) => id);
      if (method === 'get_desk') {
        const d = this.desks.get(String(a.desk_id));
        return d ? this.deskJson(d) : null;
      }
      throw new Error(`${contract}.${method}: no such method`);
    },
    accessKeys: async (account) => [...(this.keys.get(account) ?? [])],
  };

  readonly engine: OnboardingEngine = {
    draftPolicy: async (text) => {
      this.engineCalls.push('POST /policy/draft');
      if (this.draftMode === 'unavailable') throw new DraftUnavailable('NEAR AI is not available');
      if (this.draftMode === 'silent') throw new EngineError('the engine did not answer');
      if (this.draftMode === 'broken') throw new Error('POST /policy/draft: policy: hl_assets is not a list');
      return fakeDraft(text);
    },
    putStrategy: async (strategy) => {
      this.engineCalls.push('PUT /strategy');
      if (this.putStrategyRefusal !== null) throw new EngineError(this.putStrategyRefusal);
      // The real engine refuses what it cannot run; the fake checks the same limits against the desk's policy on the chain.
      const desk = [...this.desks.values()][0];
      const problem = desk ? strategyProblems(strategy, desk.policy)[0] : undefined;
      if (problem) throw new EngineError(problem.message);
      this.strategy = strategy;
      return strategy;
    },
    startSetup: async (deskId) => {
      this.engineCalls.push('POST /setup');
      if (this.setupRefusal !== null) throw new EngineError(this.setupRefusal);
      const desk = this.desks.get(deskId);
      if (!desk) throw new EngineError(`there is no desk ${deskId}`);
      if (!(this.keys.get(desk.owner) ?? []).some((k) => k.publicKey === FAKE_ENGINE_KEY)) throw new EngineError('the engine key is not on the owner’s account yet');
      this.setupStore.dispatch({ deskId, steps: SETUP_STEPS.map((step, i) => ({ step, status: i === 0 ? 'running' : 'pending', tx: [] })) });
    },
  };

  /** One tick of venue setup: the running step ends and the next begins. */
  advanceSetup(): void {
    const now = this.setupStore.getState();
    if (now === null) return;
    const deskId = now.deskId;
    const running = now.steps.findIndex((s) => s.status === 'running');
    const steps = now.steps.map((s) => ({ ...s }));
    if (running >= 0) {
      const s = steps[running]!;
      if (s.step === 'orderly_ip_restriction' && (this.network === 'testnet' || (this.desks.get(deskId)?.ips.length ?? 0) === 0)) s.status = 'skipped';
      else s.status = 'done';
      if (s.step === 'orderly_receiver_lookup') s.detail = FAKE_RECEIVER;
    }
    const next = steps.findIndex((s) => s.status === 'pending');
    if (next >= 0) steps[next]!.status = 'running';
    this.setupStore.dispatch({ deskId, steps });
  }

  /** Runs setup to its end. */
  finishSetup(): void {
    for (let i = 0; i < SETUP_STEPS.length + 1; i++) this.advanceSetup();
  }

  /** Makes a setup step fail with a reason. */
  failSetup(step: SetupProgress['steps'][number]['step'], detail: string): void {
    const now = this.setupStore.getState();
    if (now === null) return;
    this.setupStore.dispatch({ ...now, steps: now.steps.map((s) => (s.step === step ? { ...s, status: 'failed', detail } : s)) });
  }

  readonly intents: IntentsApi = {
    quote: async (request: IntentsRequest): Promise<IntentsQuote> => {
      if (this.intentsDown) throw new Error('1Click refused the quote (503)');
      this.quotes += 1;
      const amountIn = BigInt(Math.round(Number(request.amountUsdc) * 1e6));
      return {
        depositAddress: `fake-deposit-address-${this.quotes}`,
        depositMemo: null,
        amountIn: amountIn.toString(),
        minAmountOut: (amountIn - 400_000n).toString(),
        timeEstimateS: 30,
        deadline: new Date(request.now + 30 * 60_000).toISOString(),
      };
    },
    status: async () => {
      if (this.intentsDown) throw new Error('1Click status: 503');
      return this.intentsStatus;
    },
  };

  /** 1Click delivered: the owner has USDC on NEAR. */
  deliver(usdc: number): void {
    this.intentsStatus = 'SUCCESS';
    this.giveUsdc(usdc);
  }

  /** USDC on NEAR in the owner's account. */
  giveUsdc(usdc: number): void {
    this.tokens.set(this.account, (this.tokens.get(this.account) ?? 0n) + BigInt(Math.round(usdc * 1e6)));
  }

  readonly venue: VenueData = {
    mark: async (symbol) => {
      if (this.marksDown) throw new Error('Hyperliquid allMids: 503');
      return this.marks.get(symbol) ?? null;
    },
    hlAssets: async () => {
      if (this.marksDown) throw new Error('Hyperliquid meta: 503');
      return this.hlAssets;
    },
  };

  /** The operator key, as the engine would show it. */
  get engineKey(): string {
    return FAKE_ENGINE_KEY;
  }

  /** The page's configuration for this world: its contract, its USDC token and the engine's key. */
  config(): OnboardingConfig {
    return { network: this.network, contractId: this.contractId, usdcToken: this.usdcToken, operatorKey: FAKE_ENGINE_KEY, allowanceNear: DEFAULT_ALLOWANCE_NEAR };
  }

  /** Everything the controller needs, wired to this world. */
  deps(config: OnboardingConfig = this.config(), extra: Partial<FlowDeps> = {}): FlowDeps {
    return {
      wallet: this.wallet,
      chain: this.chain,
      engine: this.engine,
      intents: this.intents,
      venue: this.venue,
      config,
      setupFeed: { get: () => this.setupStore.getState(), subscribe: (l) => this.setupStore.subscribe(l) },
      sleep: async () => {},
      ...extra,
    };
  }

  /** Whether the owner's account holds the operator key with all 19 methods. */
  hasKey(): boolean {
    return (this.keys.get(this.account) ?? []).some(
      (k) => k.publicKey === FAKE_ENGINE_KEY && k.permission !== 'FullAccess' && k.permission.receiverId === this.contractId && k.permission.methodNames.length === OPERATOR_METHODS.length,
    );
  }
}

/** What a plain-English description becomes: numbers found in the words, the rest from a fixed policy. */
export function fakeDraft(text: string): PolicyDraft {
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]!.replace(/,/g, '')) : null;
  };
  const size = num(/\$\s?([\d,]+)/) ?? 1_000;
  const leverage = num(/(\d+(?:\.\d+)?)\s?[x×]/i) ?? 3;
  const wants = (coin: string): boolean => new RegExp(`(?<![A-Za-z])${coin}(?![A-Za-z])`).test(text);
  const hl = [
    { index: 0, symbol: 'BTC', sz_decimals: 5 },
    { index: 1, symbol: 'ETH', sz_decimals: 4 },
    { index: 5, symbol: 'SOL', sz_decimals: 2 },
    { index: 12, symbol: 'DOGE', sz_decimals: 0 },
    { index: 34, symbol: 'NEAR', sz_decimals: 1 },
  ].filter((a) => wants(a.symbol) || ['BTC', 'ETH', 'SOL'].includes(a.symbol));
  const notes: string[] = [];
  if (/never lose|guarantee/i.test(text)) notes.push('could not map: “never lose money”, no rule can promise that');
  return {
    policy: {
      hl_assets: hl,
      phoenix_markets: [],
      orderly_symbols: hl.map((a) => `PERP_${a.symbol}_USDC`),
      max_notional_usd: size,
      price_band_bps: 100,
      oracle_max_age_s: 60,
      rescue_cap_usd_per_hour: Math.round(size / 2),
      max_transfer_cost_bps: 100,
      max_transfer_cost_flat_e6: 500_000,
      unpriced: [],
      unpriced_max_notional_usd: 0,
    },
    strategy: { ...defaultStrategy(), legUsd: Math.min(size, 1_000), maxLeverage: leverage },
    notes,
    model: 'fake-model-1',
  };
}
