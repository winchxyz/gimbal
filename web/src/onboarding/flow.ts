// Onboarding as one controller: what the owner has done (read from the chain, not remembered), what is in flight, and
// every action the screen offers. The wallet, the chain, the engine, 1Click and the exchange's data are passed in, so
// the same controller runs against the real ones, against the development fakes and in the tests.
//
// What counts as done is always read back: a desk exists when `get_desk` says so and names this wallet as its owner; the
// engine's key is on the account when the account's key list holds it; the deposit counts when the ledger shows it; the
// policy is live when the contract's copy equals the one the owner signed. A signature alone proves nothing.
import type { ContractPolicy, SetupProgress } from '@gimbal/shared';
import { createStore, type Store } from '../stream/hub.ts';
import {
  deriveAddresses,
  desksOf,
  readConfig,
  readDesk,
  tokenBalance,
  type Chain,
  type ChainDesk,
} from './chain.ts';
import type { OnboardingConfig } from './config.ts';
import { createDeskTx, depositTx, isDeskId, isEvmAddress, setOrderlyIpsTx, setOrderlyReceiverTx, setPolicyTx, splitIps } from './desk-actions.ts';
import type { DerivedAddresses } from './derive.ts';
import { DraftUnavailable, EngineError, type OnboardingEngine } from './engine.ts';
import { dollars, formatUsdc, ORIGINS, usdcUnits, type IntentsApi, type IntentsQuote, type IntentsStatus, MIN_FUND_USDC } from './intents.ts';
import type { HlAsset, VenueData } from './marks.ts';
import { addOperatorKeyAction, hasOperatorKey, isPublicKey, type AccessKeyInfo } from './operator.ts';
import { addHlAsset, addUnpriced, policyProblems, removeCoin, removeUnpriced, removeVenue, starterPolicy, strategyProblems, type Problem, type VenueKey } from './policy.ts';
import { applyEdit, defaultStrategy, draftOf, setAuto, type EditId, type RulesDraft } from './rules.ts';
import { refusalText, WalletError, type Wallet, type WalletTx } from './wallet.ts';

// ---------- state ----------

/** The one action in flight; the screen shows its button as working and disables the rest. */
export type ActionId =
  | 'connect'
  | 'load'
  | 'create'
  | 'key'
  | 'setup'
  | 'receiver'
  | 'ips'
  | 'quote'
  | 'deposit'
  | 'draft'
  | 'asset'
  | 'sign'
  | 'strategy';

export type DeskCheck = 'unknown' | 'free' | 'mine' | 'foreign';

export interface FundState {
  originId: (typeof ORIGINS)[number]['id'];
  amount: string;
  refundTo: string;
  quote: IntentsQuote | null;
  status: IntentsStatus | null;
  /** The owner's USDC on NEAR, in 1e-6 units; null until read. */
  balance: bigint | null;
  /** How much of it to put into the desk, USDC. */
  depositText: string;
}

export interface RulesState {
  words: string;
  drafting: 'idle' | 'busy' | 'unavailable' | 'failed';
  draft: RulesDraft | null;
  editing: boolean;
  /** What the owner typed in a box whose text is not a number: kept so the box does not jump back. */
  raw: Partial<Record<EditId, string>>;
  /** The owner pressed Sign policy: the rules are theirs. Cleared when the wallet did not sign. */
  confirmed: boolean;
  marks: Record<string, number>;
  hlAssets: HlAsset[] | null;
  strategySaved: boolean;
}

export interface FlowState {
  config: OnboardingConfig;
  account: string | null;
  busy: ActionId | null;
  /** The last mistake of each action, in words. */
  errors: Partial<Record<ActionId, string>>;
  /** A transaction hash for the last signed action, for the explorer link. */
  txs: Partial<Record<ActionId, string>>;
  deskId: string;
  existing: string[];
  mpc: string | null;
  derived: DerivedAddresses | null;
  desk: ChainDesk | null;
  deskCheck: DeskCheck;
  keys: AccessKeyInfo[] | null;
  operatorKey: string;
  setup: SetupProgress | null;
  ipsText: string;
  receiverText: string;
  fund: FundState;
  rules: RulesState;
}

export type StepId = 'wallet' | 'desk' | 'key' | 'setup' | 'funds' | 'rules' | 'sign';
export type StepStatus = 'done' | 'now' | 'todo';

export interface StepView {
  id: StepId;
  status: StepStatus;
  title: string;
  sub: string;
}

export interface FlowDeps {
  wallet: Wallet;
  chain: Chain;
  engine: OnboardingEngine;
  intents: IntentsApi;
  venue: VenueData;
  config: OnboardingConfig;
  /** The engine's `setup` events: the stream store in the app. */
  setupFeed: { get(): SetupProgress | null; subscribe(listener: () => void): () => void };
  now?: () => number;
  /** Waiting between reads of a transaction's effect; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  retryMs?: number;
}

type Update = (s: FlowState) => FlowState;

export function initialFlowState(config: OnboardingConfig): FlowState {
  return {
    config,
    account: null,
    busy: null,
    errors: {},
    txs: {},
    deskId: '',
    existing: [],
    mpc: null,
    derived: null,
    desk: null,
    deskCheck: 'unknown',
    keys: null,
    operatorKey: config.operatorKey ?? '',
    setup: null,
    ipsText: '',
    receiverText: '',
    fund: { originId: 'arbitrum', amount: '', refundTo: '', quote: null, status: null, balance: null, depositText: '' },
    rules: { words: '', drafting: 'idle', draft: null, editing: false, raw: {}, confirmed: false, marks: {}, hlAssets: null, strategySaved: false },
  };
}

// ---------- reading the state ----------

/** The policy as the contract compares it: only the fields it has, in a fixed order. */
const normalized = (p: ContractPolicy): string =>
  JSON.stringify([
    p.hl_assets.map((a) => [a.index, a.symbol, a.sz_decimals]),
    p.phoenix_markets.map((m) => [m.symbol, m.orderbook, m.base_lot_e8, m.tick_e8]),
    p.orderly_symbols,
    p.max_notional_usd,
    p.price_band_bps,
    p.oracle_max_age_s,
    p.rescue_cap_usd_per_hour,
    p.max_transfer_cost_bps,
    p.max_transfer_cost_flat_e6,
    (p.unpriced ?? []).map((u) => [u.symbol, u.max_sz]),
    p.unpriced_max_notional_usd ?? 0,
  ]);

export const samePolicy = (a: ContractPolicy, b: ContractPolicy): boolean => normalized(a) === normalized(b);

/** The setup steps of the desk being set up, or null while the engine has sent nothing for it. */
const setupOf = (s: FlowState): SetupProgress | null => (s.setup !== null && s.setup.deskId === s.deskId ? s.setup : null);

/** The address `orderly_receiver_lookup` found: its `detail`, when that is an address. */
export function receiverFound(s: FlowState): string | null {
  const step = setupOf(s)?.steps.find((x) => x.step === 'orderly_receiver_lookup');
  return step?.status === 'done' && step.detail !== undefined && isEvmAddress(step.detail.trim()) ? step.detail.trim() : null;
}

export type SetupView = 'not-started' | 'running' | 'failed' | 'needs-receiver' | 'done';

export function setupView(s: FlowState): SetupView {
  const setup = setupOf(s);
  if (setup === null) return 'not-started';
  if (setup.steps.some((x) => x.status === 'failed')) return 'failed';
  const finished = setup.steps.every((x) => x.status === 'done' || x.status === 'skipped');
  if (!finished) return 'running';
  const lookup = setup.steps.find((x) => x.step === 'orderly_receiver_lookup');
  // A receiver is pinned when the lookup found one; a skipped lookup has nothing to pin.
  if (lookup?.status === 'done' && s.desk?.orderly_receiver == null) return 'needs-receiver';
  return 'done';
}

export const isStarter = (p: ContractPolicy): boolean => samePolicy(p, starterPolicy());

/** The rules the owner signed are what the contract holds. */
export function policyLive(s: FlowState): boolean {
  if (s.desk === null) return false;
  return s.rules.draft !== null ? samePolicy(s.desk.policy, s.rules.draft.policy) : !isStarter(s.desk.policy);
}

export function stepsOf(s: FlowState): StepView[] {
  const desk = s.deskCheck === 'mine' && s.desk !== null;
  const key = s.keys !== null && s.operatorKey !== '' && hasOperatorKey(s.keys, s.operatorKey, s.config.contractId ?? '');
  const setupDone = setupView(s) === 'done';
  const funded = desk && s.desk!.ledger.deposited > 0n;
  const signed = policyLive(s) && (s.rules.draft === null || s.rules.strategySaved);
  const rulesDone = s.rules.confirmed || signed;
  const done: Record<StepId, boolean> = { wallet: s.account !== null, desk, key, setup: setupDone, funds: funded, rules: rulesDone, sign: signed };
  const setup = setupOf(s);
  const finishedSteps = setup === null ? 0 : setup.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length;
  const text: Record<StepId, [string, string]> = {
    wallet: [done.wallet ? 'Wallet connected' : 'Connect your wallet', s.account ?? 'A NEAR wallet signs for you. Gimbal never sees a key.'],
    desk: [
      done.desk ? 'Desk created' : 'Create your desk',
      done.desk ? `${s.deskId} · addresses derived for Hyperliquid, Phoenix and Orderly` : 'One transaction. The contract checks the addresses it will sign for.',
    ],
    key: [done.key ? 'Engine key added' : 'Let the engine trade', done.key ? 'It can call the trading methods only, never move your money out' : 'A key for the engine that can call the trading methods only.'],
    setup: [
      done.setup ? 'Exchange accounts ready' : 'Set up the exchanges',
      done.setup ? 'Hyperliquid, Phoenix and Orderly accounts opened for the desk' : setup === null ? 'The engine opens the desk’s accounts on each exchange.' : `${finishedSteps} of ${setup.steps.length} steps done`,
    ],
    funds: [
      done.funds ? `${dollars(s.desk!.ledger.deposited)} deposited` : 'Add funds',
      done.funds ? 'USDC from NEAR, counted as your principal' : 'Send USDC from another chain through Intents, then deposit it into the desk.',
    ],
    rules: [done.rules ? 'Rules confirmed' : 'Your rules', done.rules ? 'Your words, as numbers the contract can check' : 'Say what the desk may do. NEAR AI turns it into a policy.'],
    sign: [done.sign ? 'Policy signed' : 'Sign the policy', done.sign ? 'The contract enforces it, the engine follows it' : 'One signature with your wallet. The contract enforces it from then on.'],
  };
  const order: StepId[] = ['wallet', 'desk', 'key', 'setup', 'funds', 'rules', 'sign'];
  let now = true;
  return order.map((id) => {
    const status: StepStatus = done[id] ? 'done' : now ? 'now' : 'todo';
    if (!done[id]) now = false;
    return { id, status, title: text[id][0], sub: text[id][1] };
  });
}

/** The first step that is not done; null when the owner is finished. */
export const currentStep = (s: FlowState): StepId | null => stepsOf(s).find((x) => x.status === 'now')?.id ?? null;

/** Everything wrong with the rules as they stand, each tied to its field. */
export function rulesProblems(s: FlowState): Problem[] {
  const draft = s.rules.draft;
  if (draft === null) return [];
  const own = Object.keys(s.rules.raw).map((field): Problem => ({ field, message: `“${s.rules.raw[field as EditId]}” is not a number.` }));
  return [...own, ...policyProblems(draft.policy), ...strategyProblems(draft.strategy, draft.policy)];
}

// ---------- the controller ----------

const wordsOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The errors without one action's: a mistake that was answered leaves no trace, not an `undefined`. */
function without(errors: FlowState['errors'], id: ActionId): FlowState['errors'] {
  const { [id]: _gone, ...rest } = errors;
  return rest;
}

export class OnboardingFlow {
  readonly store: Store<FlowState, Update>;
  private readonly d: Required<Pick<FlowDeps, 'sleep' | 'retries' | 'retryMs' | 'now'>> & FlowDeps;
  private stopFeed: () => void;
  private stopSignOut: () => void;

  constructor(deps: FlowDeps) {
    this.d = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), retries: 8, retryMs: 1500, now: Date.now, ...deps };
    this.store = createStore<FlowState, Update>((s, f) => f(s), { ...initialFlowState(deps.config), setup: deps.setupFeed.get() });
    // The stream store notifies on every event of every type; only a new `setup` value changes this state.
    this.stopFeed = deps.setupFeed.subscribe(() => {
      const next = deps.setupFeed.get();
      this.set((s) => (s.setup === next ? s : { ...s, setup: next }));
    });
    this.stopSignOut = deps.wallet.onSignOut(() => this.set((s) => ({ ...initialFlowState(s.config), operatorKey: s.operatorKey, setup: s.setup })));
  }

  dispose(): void {
    this.stopFeed();
    this.stopSignOut();
  }

  get state(): FlowState {
    return this.store.getState();
  }

  private set(f: Update): void {
    this.store.dispatch(f);
  }

  private patch(p: Partial<FlowState>): void {
    this.set((s) => ({ ...s, ...p }));
  }

  private rules(p: Partial<RulesState>): void {
    this.set((s) => ({ ...s, rules: { ...s.rules, ...p } }));
  }

  private fund(p: Partial<FundState>): void {
    this.set((s) => ({ ...s, fund: { ...s.fund, ...p } }));
  }

  /** Runs one action: marks it busy, clears its last mistake, and turns a thrown error into words. */
  private async run(id: ActionId, body: () => Promise<void>): Promise<void> {
    if (this.state.busy !== null) return;
    this.set((s) => ({ ...s, busy: id, errors: without(s.errors, id) }));
    try {
      await body();
    } catch (error) {
      const text = error instanceof WalletError ? `Nothing was signed: ${error.message}.` : wordsOf(error);
      this.set((s) => ({ ...s, errors: { ...s.errors, [id]: text } }));
    } finally {
      this.set((s) => ({ ...s, busy: null }));
    }
  }

  private fail(id: ActionId, text: string): void {
    this.set((s) => ({ ...s, errors: { ...s.errors, [id]: text } }));
  }

  /** Signs one transaction; throws the contract's refusal in words. */
  private async sign(id: ActionId, tx: WalletTx): Promise<void> {
    const outcome = await this.d.wallet.signAndSend(tx);
    if (outcome.failure !== null) throw new Error(refusalText(outcome.failure));
    if (outcome.hash !== null) this.set((s) => ({ ...s, txs: { ...s.txs, [id]: outcome.hash! } }));
  }

  /** Reads until `ok`, giving the chain a few moments to show a transaction's effect. */
  private async until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    let last = await read();
    for (let i = 0; i < this.d.retries && !ok(last); i++) {
      await this.d.sleep(this.d.retryMs);
      last = await read();
    }
    return last;
  }

  // ---- wallet ----

  async connect(): Promise<void> {
    await this.run('connect', async () => {
      const account = await this.d.wallet.connect();
      this.patch({ account });
    });
    if (this.state.account !== null) await this.load();
  }

  /** Picks up a wallet session from an earlier visit, without opening the wallet, and reads what the chain holds. */
  async resume(): Promise<void> {
    const account = (await this.d.wallet.restore?.()) ?? null;
    if (account === null) return;
    this.patch({ account });
    await this.load();
  }

  async disconnect(): Promise<void> {
    await this.d.wallet.disconnect();
    this.set((s) => ({ ...initialFlowState(s.config), operatorKey: s.operatorKey, setup: s.setup }));
  }

  /** Reads what the chain already holds for this owner, so a returning owner resumes where they stopped. */
  async load(): Promise<void> {
    const { account, config } = this.state;
    if (account === null) return;
    await this.run('load', async () => {
      if (config.contractId === null) throw new Error(`No gimbal contract is configured for ${config.network}. Set VITE_GIMBAL_CONTRACT.`);
      const info = await readConfig(this.d.chain, config.contractId);
      if ((info.network === 'Mainnet') !== (config.network === 'mainnet')) {
        throw new Error(`The contract ${config.contractId} runs on ${info.network}, but the engine is on ${config.network}.`);
      }
      const existing = await desksOf(this.d.chain, config.contractId, account);
      const keys = await this.d.chain.accessKeys(account);
      const deskId = this.state.deskId !== '' ? this.state.deskId : (existing[0] ?? '');
      this.patch({ mpc: info.mpc, existing, keys, deskId });
      await this.inspectDesk();
      await this.refreshBalance();
    });
  }

  // ---- desk ----

  /** Types a desk id. The id is checked, then its addresses are derived and the chain asked who owns it. */
  async setDeskId(text: string): Promise<void> {
    const deskId = text.trim().toLowerCase();
    this.set((s) => ({ ...s, deskId, derived: null, desk: null, deskCheck: 'unknown', errors: without(s.errors, 'create') }));
    if (!isDeskId(deskId) || this.state.account === null) return;
    await this.run('load', async () => {
      await this.inspectDesk();
    });
  }

  /** Derives the desk's addresses and asks `get_desk` who owns the id. Funding never starts before this says "mine". */
  private async inspectDesk(): Promise<void> {
    const { deskId, config, mpc, account } = this.state;
    if (!isDeskId(deskId) || config.contractId === null || mpc === null || account === null) return;
    const derived = await deriveAddresses(this.d.chain, mpc, config.contractId, deskId);
    const desk = await readDesk(this.d.chain, config.contractId, deskId);
    if (this.state.deskId !== deskId) return;
    let check: DeskCheck = desk === null ? 'free' : desk.owner === account ? 'mine' : 'foreign';
    // The contract stores the addresses it was given and checks them at creation; a desk that carries other ones was
    // not made from this derivation, so nothing is sent to it.
    if (desk !== null && check === 'mine' && (desk.evm_address !== derived.evm_address || desk.solana.authority !== derived.solana.authority)) check = 'foreign';
    this.patch({ derived, desk, deskCheck: check });
  }

  async createDesk(): Promise<void> {
    await this.run('create', async () => {
      const { account, deskId, derived, config, deskCheck } = this.state;
      if (account === null || config.contractId === null) throw new Error('Connect your wallet first.');
      if (!isDeskId(deskId)) throw new Error('A desk id is 1 to 32 characters: a to z, 0 to 9 and “-”.');
      if (derived === null) throw new Error('The desk’s addresses are not derived yet.');
      if (deskCheck !== 'free') throw new Error(deskCheck === 'mine' ? 'This desk is already yours.' : 'A desk with this id exists already.');
      await this.sign('create', createDeskTx(config.contractId, deskId, starterPolicy(), derived));
      await this.until(
        () => this.inspectDesk().then(() => this.state.deskCheck),
        (check) => check !== 'free',
      );
      const { deskCheck: after, desk } = this.state;
      if (after === 'free') throw new Error('The transaction was signed, but the desk is not on the chain yet. Check again in a moment.');
      if (after !== 'mine' || desk === null) throw new Error(`The desk ${deskId} is on the chain, but it is not yours. Nothing will be sent to it.`);
      this.set((s) => ({ ...s, existing: [...new Set([...s.existing, deskId])] }));
    });
  }

  // ---- engine key ----

  setOperatorKey(text: string): void {
    this.patch({ operatorKey: text.trim() });
  }

  async addEngineKey(): Promise<void> {
    await this.run('key', async () => {
      const { account, operatorKey, config } = this.state;
      if (account === null || config.contractId === null) throw new Error('Connect your wallet first.');
      if (this.state.deskCheck !== 'mine') throw new Error('Create your desk first.');
      if (!isPublicKey(operatorKey)) throw new Error('Paste the engine’s public key: ed25519: and then 43 or 44 characters.');
      await this.sign('key', { receiverId: account, actions: [addOperatorKeyAction(operatorKey, config.contractId, config.allowanceNear)] });
      const keys = await this.until(
        () => this.d.chain.accessKeys(account),
        (list) => hasOperatorKey(list, operatorKey, config.contractId!),
      );
      this.patch({ keys });
      if (!hasOperatorKey(keys, operatorKey, config.contractId)) throw new Error('The key was signed in, but your account does not list it yet. Check again in a moment.');
    });
  }

  async refreshKeys(): Promise<void> {
    const { account } = this.state;
    if (account === null) return;
    this.patch({ keys: await this.d.chain.accessKeys(account) });
  }

  // ---- venue setup ----

  setIpsText(text: string): void {
    this.patch({ ipsText: text });
  }

  async setIps(): Promise<void> {
    await this.run('ips', async () => {
      const { deskId, config, ipsText } = this.state;
      if (config.network !== 'mainnet') throw new Error('The IP list is for mainnet. Orderly’s testnet takes none.');
      // setOrderlyIpsTx refuses a list without the engine's IP; its reason is the error the owner sees.
      await this.sign('ips', setOrderlyIpsTx(config.contractId!, deskId, splitIps(ipsText), config.relayerIps));
    });
  }

  async startSetup(): Promise<void> {
    await this.run('setup', async () => {
      if (this.state.deskCheck !== 'mine') throw new Error('Create your desk first.');
      await this.d.engine.startSetup(this.state.deskId);
    });
  }

  setReceiverText(text: string): void {
    this.patch({ receiverText: text.trim() });
  }

  /** Pins the Orderly receiver: the address the engine found, or the one the owner typed when it found none. */
  async pinReceiver(): Promise<void> {
    await this.run('receiver', async () => {
      const s = this.state;
      const receiver = receiverFound(s) ?? s.receiverText;
      if (!isEvmAddress(receiver)) throw new Error('The Orderly receiver is an address: 0x and 40 hex digits.');
      await this.sign('receiver', setOrderlyReceiverTx(s.config.contractId!, s.deskId, receiver));
      const desk = await this.until(
        () => readDesk(this.d.chain, s.config.contractId!, s.deskId),
        (d) => d?.orderly_receiver === receiver,
      );
      this.patch({ desk });
      if (desk?.orderly_receiver !== receiver) throw new Error('The receiver was signed in, but the desk does not show it yet. Check again in a moment.');
    });
  }

  // ---- funds ----

  setFund(p: Partial<Pick<FundState, 'originId' | 'amount' | 'refundTo' | 'depositText'>>): void {
    this.fund({ ...p, ...(p.originId !== undefined || p.amount !== undefined || p.refundTo !== undefined ? { quote: null, status: null } : {}) });
  }

  /** Asks 1Click for a deposit address for this amount. Only on mainnet: 1Click has no testnet. */
  async quote(): Promise<void> {
    await this.run('quote', async () => {
      const s = this.state;
      if (s.config.network !== 'mainnet') throw new Error('1Click has no testnet. Put test USDC on your NEAR account instead and deposit it below.');
      const origin = ORIGINS.find((o) => o.id === s.fund.originId)!;
      const units = usdcUnits(s.fund.amount);
      if (units === null) throw new Error('Type an amount of USDC, for example 100.');
      if (units < BigInt(MIN_FUND_USDC) * 1_000_000n) throw new Error(`The least worth sending is ${MIN_FUND_USDC} USDC: the fee is nearly flat, so a small transfer loses a large share.`);
      if (!origin.isAddress(s.fund.refundTo.trim())) throw new Error(`Type your refund address: the ${origin.label} address that gets your USDC back if the transfer fails (${origin.addressHint}).`);
      if (s.account === null) throw new Error('Connect your wallet first.');
      const quote = await this.d.intents.quote({ origin, amountUsdc: s.fund.amount.trim(), refundTo: s.fund.refundTo.trim(), recipient: s.account, now: this.d.now() });
      this.fund({ quote, status: 'PENDING_DEPOSIT' });
    });
  }

  /** Reads 1Click's status of the deposit address; a failed read is shown and the last status stays. */
  async refreshStatus(): Promise<void> {
    const quote = this.state.fund.quote;
    if (quote === null) return;
    try {
      const status = await this.d.intents.status(quote.depositAddress, quote.depositMemo);
      this.fund({ status });
      if (status === 'SUCCESS') await this.refreshBalance();
    } catch (error) {
      this.fail('quote', wordsOf(error));
    }
  }

  async refreshBalance(): Promise<void> {
    const { account, config } = this.state;
    if (account === null || config.usdcToken === null) return;
    try {
      this.fund({ balance: await tokenBalance(this.d.chain, config.usdcToken, account) });
    } catch (error) {
      this.fail('deposit', wordsOf(error));
    }
  }

  async deposit(): Promise<void> {
    await this.run('deposit', async () => {
      const s = this.state;
      if (s.deskCheck !== 'mine' || s.desk === null) throw new Error('Create your desk first. Funds go only to a desk that is yours.');
      if (s.config.usdcToken === null || s.config.contractId === null) throw new Error(`No USDC token is configured for ${s.config.network}. Set VITE_USDC_TOKEN.`);
      const units = usdcUnits(s.fund.depositText);
      if (units === null) throw new Error('Type an amount of USDC, for example 100.');
      const have = await tokenBalance(this.d.chain, s.config.usdcToken, s.account!);
      this.fund({ balance: have });
      if (units > have) throw new Error(`Your NEAR account holds ${formatUsdc(have)} USDC, less than ${formatUsdc(units)}.`);
      const before = s.desk.ledger.deposited;
      await this.sign('deposit', depositTx(s.config.usdcToken, s.config.contractId, s.deskId, units));
      const desk = await this.until(
        () => readDesk(this.d.chain, s.config.contractId!, s.deskId),
        (d) => d !== null && d.ledger.deposited > before,
      );
      this.patch({ desk });
      await this.refreshBalance();
      if (desk === null || desk.ledger.deposited <= before) throw new Error('The deposit was signed, but the desk’s ledger does not show it yet. Check again in a moment.');
    });
  }

  // ---- rules ----

  setWords(text: string): void {
    this.rules({ words: text });
  }

  /** NEAR AI drafts the rules from the owner's words. Nothing is applied. */
  async draftRules(): Promise<void> {
    const words = this.state.rules.words.trim();
    if (words === '') {
      this.fail('draft', 'Write what the desk may do, or set the numbers yourself.');
      return;
    }
    await this.run('draft', async () => {
      this.rules({ drafting: 'busy' });
      try {
        const draft = await this.d.engine.draftPolicy(words);
        this.rules({ drafting: 'idle', draft: draftOf(draft), editing: false, raw: {}, confirmed: false, strategySaved: false });
        await this.loadMarks();
      } catch (error) {
        this.rules({ drafting: error instanceof DraftUnavailable ? 'unavailable' : 'failed' });
        if (error instanceof DraftUnavailable) return;
        throw new Error(error instanceof EngineError ? error.message : `NEAR AI answered, but not with rules the page can read: ${wordsOf(error)}`);
      }
    });
  }

  /** The owner fills the numbers themselves: the starting point is the engine's defaults, nothing is drafted. */
  fillByHand(): void {
    const policy: ContractPolicy = { ...starterPolicy(), max_notional_usd: 100, rescue_cap_usd_per_hour: 50 };
    this.rules({ draft: { policy, strategy: defaultStrategy(), notes: [], model: null }, editing: true, raw: {}, confirmed: false, strategySaved: false, drafting: this.state.rules.drafting });
    void this.loadMarks();
  }

  private edit(f: (d: RulesDraft) => RulesDraft): void {
    this.set((s) => (s.rules.draft === null ? s : { ...s, rules: { ...s.rules, draft: f(s.rules.draft), confirmed: false, strategySaved: false } }));
  }

  setEditing(editing: boolean): void {
    this.rules({ editing });
  }

  /** The owner typed into a rule's box. A number is applied; anything else is kept as typed, with its mistake. */
  editNumber(id: EditId, text: string): void {
    const draft = this.state.rules.draft;
    if (draft === null) return;
    const result = applyEdit(draft, id, text);
    if ('error' in result) {
      this.rules({ raw: { ...this.state.rules.raw, [id]: text } });
      return;
    }
    const { [id]: _gone, ...raw } = this.state.rules.raw;
    this.set((s) => ({ ...s, rules: { ...s.rules, draft: result.draft, raw, confirmed: false, strategySaved: false } }));
  }

  setAutoMode(auto: boolean): void {
    this.edit((d) => setAuto(d, auto));
  }

  dropCoin(coin: string): void {
    this.edit((d) => ({ ...d, policy: removeCoin(d.policy, coin) }));
  }

  dropVenue(venue: VenueKey): void {
    this.edit((d) => ({ ...d, policy: removeVenue(d.policy, venue) }));
  }

  dropUnpriced(symbol: string): void {
    this.edit((d) => ({ ...d, policy: removeUnpriced(d.policy, symbol) }));
  }

  /** Reads Hyperliquid's list and the marks the form converts with; a failed read leaves the form usable by hand. */
  async loadMarks(): Promise<void> {
    try {
      this.rules({ hlAssets: await this.d.venue.hlAssets() });
    } catch {
      this.rules({ hlAssets: null });
    }
  }

  /** Adds a Hyperliquid asset by symbol, with its index and size decimals from Hyperliquid's own list. */
  async addAsset(symbol: string): Promise<void> {
    await this.run('asset', async () => {
      const draft = this.state.rules.draft;
      if (draft === null) return;
      const sym = symbol.trim();
      if (this.state.rules.hlAssets === null) await this.loadMarks();
      const asset = this.state.rules.hlAssets?.find((a) => a.symbol.toLowerCase() === sym.toLowerCase());
      if (this.state.rules.hlAssets === null) throw new Error('Hyperliquid’s asset list could not be read, so the asset cannot be added from here.');
      if (asset === undefined) throw new Error(`Hyperliquid lists no asset called “${sym}”.`);
      const result = addHlAsset(draft.policy, asset);
      if ('error' in result) throw new Error(result.error);
      this.edit((d) => ({ ...d, policy: result.policy }));
    });
  }

  /**
   * An asset without an oracle price trades under a size cap. The owner types a cap in dollars; it becomes `max_sz`
   * at the current mark (or at the mark they typed when the exchange has none). The result is shown before signing.
   */
  async addUnpricedAsset(symbol: string, usdCap: string, markText: string): Promise<void> {
    await this.run('asset', async () => {
      const draft = this.state.rules.draft;
      if (draft === null) return;
      const sym = symbol.trim();
      const usd = Number(usdCap.replace(/,/g, ''));
      let mark = markText.trim() === '' ? NaN : Number(markText.replace(/,/g, ''));
      if (Number.isNaN(mark)) {
        try {
          mark = (await this.d.venue.mark(sym)) ?? NaN;
        } catch {
          throw new Error(`Hyperliquid’s prices could not be read. Type the mark price of ${sym} yourself.`);
        }
      }
      if (Number.isNaN(mark)) throw new Error(`Hyperliquid has no price for “${sym}”. Check the spelling, or type its mark price yourself.`);
      const result = addUnpriced(draft.policy, sym, usd, mark);
      if ('error' in result) throw new Error(result.error);
      this.set((s) => ({ ...s, rules: { ...s.rules, marks: { ...s.rules.marks, [sym]: mark } } }));
      this.edit((d) => ({ ...d, policy: result.policy }));
    });
  }

  // ---- signing ----

  /** The owner's confirmation: `set_policy` in the wallet, then the engine's rules. Nothing is applied before this. */
  async signPolicy(): Promise<void> {
    await this.run('sign', async () => {
      const s = this.state;
      const draft = s.rules.draft;
      if (draft === null) throw new Error('Write your rules first.');
      if (s.deskCheck !== 'mine') throw new Error('Create your desk first.');
      const problems = rulesProblems(s);
      if (problems.length > 0) throw new Error(problems[0]!.message);
      this.rules({ confirmed: true });
      try {
        await this.sign('sign', setPolicyTx(s.config.contractId!, s.deskId, draft.policy));
        const desk = await this.until(
          () => readDesk(this.d.chain, s.config.contractId!, s.deskId),
          (d) => d !== null && samePolicy(d.policy, draft.policy),
        );
        this.patch({ desk });
        if (desk === null || !samePolicy(desk.policy, draft.policy)) throw new Error('The policy was signed, but the contract does not show it yet. Check again in a moment.');
      } catch (error) {
        this.rules({ confirmed: false });
        throw error;
      }
    });
    if (policyLive(this.state) && !this.state.rules.strategySaved && this.state.errors.sign === undefined) await this.saveStrategy();
  }

  /** Saves the engine's rules (`PUT /strategy`). Separate from the signature, so a refusal here does not ask for another one. */
  async saveStrategy(): Promise<void> {
    await this.run('strategy', async () => {
      const draft = this.state.rules.draft;
      if (draft === null) return;
      await this.d.engine.putStrategy(draft.strategy);
      this.rules({ strategySaved: true });
    });
  }
}
