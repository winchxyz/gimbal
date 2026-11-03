// serve's pair trader on mainnet (trade/protected-pair.ts): the legs pair-mainnet trades (HlLeg, PhoenixLeg, the
// relayer), built the same way and with the same guards (pair-mainnet-lib.ts: the stored price refreshed when it would
// not outlive an IOC and its retry, the 300 s life of a fresh price; the policy cap less the band; the Phoenix
// exchange and market checked against the pinned accounts), adopted from the venues at start, and run by a PairTrader
// whose orders are all reduce-only IOCs. It feeds panic_close and a rescue's reduce (the `reducer`) and the ADL watch.
//
// Trading is opt-in: GIMBAL_TRADE=1 takes the per-desk trader lock first (the one pair-mainnet --send takes), loads the
// operator key by name (never printed) and builds the signing relayer; it refuses in a linked git worktree, as
// pair-mainnet --send does. `serve --once` never trades. Without it the pair is alert only: the legs are read, ADL and
// the liquidation alert are journaled, and nothing is signed; the lock is released as soon as the pair is found not
// to trade, so pair-mainnet can run. The trader's state is kept in GIMBAL_STATE_DIR (default the per-user state
// directory), trader-mainnet-<contract>-<desk>-<evm>.json (trade/trader-state.ts); a missing file is not a fresh start:
// GIMBAL_TRADER_FRESH=<contract>/<desk> asks for one (trade/protected-pair.ts startPlan).
//
// The pair: the one symbol in both policy.hl_assets and policy.phoenix_markets that either venue holds; with both legs
// flat, GIMBAL_PAIR_SYMBOL (exactly as the policy spells it: kPEPE), else the saved state's, else the only symbol in
// both lists. Two open pairs are refused (serve protects one). Hyperliquid positions outside the policy's pair are
// named, not protected.
//
// Resting orders: the Phoenix leg sends IOCs only, so only Hyperliquid can hold one (a post-only order of an earlier
// pair-mainnet run). One resting on the pair's coin at start makes the pair alert only (it could fill under the trader,
// and the ADL watch would read the fill as a shrink or a growth of ours), with a line naming it; cancel it, reconcile
// and start again. panic_close cancels every resting order on the policy's Hyperliquid coins first (cancelResting).
//
// TODO(dedupe): buildLiveLegs mirrors pair-mainnet.ts buildPair (it runs on import, so it cannot be imported); move
// buildPair onto it once engine/pair-followups is merged.

import type { ContractPolicy, Mode, StreamEvent, TxRef } from '@gimbal/shared';
import type { NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import type { SolanaChain } from '../relayer/phoenix-money.ts';
import { solanaChain } from '../relayer/phoenix-money.ts';
import { ORDER_PRIORITY_MICROLAMPORTS, exchangeMismatches, marketMismatches, splineOf } from '../relayer/phoenix-tx.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter } from '../relayer/solana.ts';
import type { Reducer } from '../rescue/rescuer.ts';
import { ADL_ATTEMPTS, AdlWatch } from '../risk/adl.ts';
import type { LegSide, MakerSettings, TradeLeg } from '../trade/legs.ts';
import { DEFAULT_MAKER, HlLeg } from '../trade/legs.ts';
import { signedQtyString } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { GuardedLeg, InFlightBook, ProtectedPair, startPlan } from '../trade/protected-pair.ts';
import type { TraderFileState, TraderLock } from '../trade/trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, traderLockPath, traderStateFile, userStateDir } from '../trade/trader-state.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, ensureFresh, newPriceState, oraclePxOf, priceLifeS, refreshLanded } from './pair-mainnet-lib.ts';
import type { ContractSide } from './serve-contract.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

/** The IOC slippage of serve's closes, as pair-mainnet's default. */
export const SERVE_SLIPPAGE_BPS = 50;
/** At start both legs are read twice this far apart, and must agree; up to START_READ_TRIES times. */
const START_CONFIRM_MS = 3_000;
const START_READ_TRIES = 3;

/** The Hyperliquid leg as serve needs it (HlLeg; tests pass their own). */
export type PairHlLeg = TradeLeg & Pick<HlLeg, 'adoptPending' | 'pendingMakerOrders' | 'cancelPending'>;

/** What servePair reads and builds; the defaults are the mainnet venues and contract, tests pass their own. */
export interface ServePairDeps {
  /** The coins the desk's Hyperliquid account holds (size not 0). */
  hlHeld(evm: string): Promise<string[]>;
  /** The symbols the desk's Phoenix trader holds, every subaccount; none when it is not registered. */
  phoenixHeld(authority: string): Promise<string[]>;
  /** Hyperliquid /info openOrders for the desk, as answered. */
  openOrders(evm: string): Promise<unknown>;
  /** The signing contract client and relayer (GIMBAL_TRADE=1 only): the operator key is loaded here. */
  signing(): Promise<{ client: NearContractClient; relayer: Relayer }>;
  /** The legs of `symbol` (buildLiveLegs). */
  buildLegs(p: { symbol: string; client: NearContractClient; relayer: Relayer | null; prices: PriceDeps; trading: () => boolean }): Promise<{ hl: PairHlLeg; phoenix: TradeLeg; priced: boolean; mismatches: string[] }>;
  close(): void;
}

export interface ServePairInput {
  mode: Mode;
  env: (name: string) => string | undefined;
  side: ContractSide;
  deskId: string;
  clock: Clock;
  log: (line: string) => void;
  publish: (event: StreamEvent) => void;
  /** --state-dir or GIMBAL_STATE_DIR when set; default: the per-user state directory. */
  stateDir?: string;
  /** This checkout is a linked git worktree: GIMBAL_TRADE=1 refuses there. */
  linkedWorktree: boolean;
  /** serve --once: alert only, whatever GIMBAL_TRADE says (it exits after one read, maybe in the middle of a close). */
  once?: boolean;
  sleep?: (ms: number) => Promise<void>;
  deps?: Partial<ServePairDeps>;
}

/** What panic_close's cancel did (rescue/closing.ts cancelResting). */
export interface CancelResult {
  cancelled: number;
  tx: TxRef[];
  notes: string[];
}

export interface ServePair {
  pair: ProtectedPair | null;
  adl: AdlWatch | undefined;
  /** The rescue's and panic_close's reducer: the pair when it trades, else null (they then say nothing traded). */
  reducer(): Reducer | null;
  /** Why nothing is traded here (panic_close says so), or null when the pair trades. */
  notTrading(): string | null;
  /** panic_close: cancels the desk's resting Hyperliquid orders (live only; undefined otherwise). */
  cancelResting?: () => Promise<CancelResult>;
  /** What serve's start says about the pair, one line each. */
  lines: string[];
  /** Waits up to `timeoutMs` for a close in flight to end; true when none runs (serve's shutdown, before stop()). */
  drain(timeoutMs: number): Promise<boolean>;
  /** Stops the watch and the trader, closes the readers and releases the lock. */
  stop(): void;
}

const none = (lines: string[], why: string, stop: () => void = () => {}): ServePair => ({
  pair: null, adl: undefined, reducer: () => null, notTrading: () => why, lines, drain: async () => true, stop,
});

/** Resting Hyperliquid orders of `coin` in an openOrders answer; a string when the answer cannot be read. */
export function restingOn(raw: unknown, coin: string): { side: LegSide | string; sz: string; oid: unknown }[] | string {
  if (!Array.isArray(raw)) return `the Hyperliquid open orders cannot be read (${(typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'nothing').slice(0, 80)})`;
  return (raw as { coin?: unknown; side?: unknown; sz?: unknown; oid?: unknown }[])
    .filter((o) => o?.coin === coin)
    .map((o) => ({ side: o.side === 'B' ? 'BUY' : o.side === 'A' ? 'SELL' : String(o.side), sz: String(o.sz), oid: o.oid }));
}

export async function servePair(input: ServePairInput): Promise<ServePair> {
  const { env, log } = input;
  if (input.mode !== 'mainnet') return none([`pair      none on ${input.mode}: the pair is Hyperliquid and Phoenix, and Phoenix is mainnet only`], `no pair on ${input.mode}`);
  const asksTrade = env('GIMBAL_TRADE') === '1';
  const wantLive = asksTrade && input.once !== true;
  if (wantLive && input.linkedWorktree) throw new Error('GIMBAL_TRADE=1: this checkout is a linked git worktree, and trading refuses here (as pair-mainnet --send does); run serve from the main checkout');
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hlUrl = (env('HL_API_URL') ?? HL_MAINNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  if (/testnet/.test(hlUrl)) throw new Error(`HL_API_URL ${hlUrl} is a testnet URL; the pair is on mainnet`);
  const phoenixUrl = (env('PHOENIX_API_URL') ?? PHOENIX_API_URL).replace(/\/+$/, '');
  const solRpcUrl = env('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL;
  const desk = input.side.desk;
  const policy: ContractPolicy = desk.policy;
  const evm = desk.evm_address.toLowerCase();
  const contractId = input.side.client.contractId;
  const deps: ServePairDeps = { ...defaultDeps({ input, hlUrl, phoenixUrl, solRpcUrl }), ...input.deps };

  // The lock first: pair-mainnet --send cannot start between the reads below and the first save.
  let lock: TraderLock | null = null;
  const release = () => {
    lock?.release();
    lock = null;
  };
  if (wantLive) {
    try {
      lock = acquireTraderLock(traderLockPath(env, input.mode, contractId, input.deskId));
    } catch (err) {
      deps.close();
      throw new Error(`GIMBAL_TRADE=1: ${errorMessage(err)} (pair-mainnet --send holds the same lock)`);
    }
  }
  const stopNone = () => {
    deps.close();
    release();
  };

  try {
    const identity = { contractId, deskId: input.deskId, evm };
    const store = new TraderStateStore(traderStateFile(input.stateDir ?? userStateDir(env), input.mode, identity), identity);
    const saved = store.load();

    // ---- which pair ----
    const common = policy.hl_assets.map((a) => a.symbol).filter((s) => policy.phoenix_markets.some((m) => m.symbol === s));
    const held = [...new Set([...(await deps.hlHeld(evm)), ...(await deps.phoenixHeld(desk.solana.authority))])];
    const lines: string[] = [];
    const outside = held.filter((s) => !common.includes(s));
    if (outside.length > 0) lines.push(`pair      not protected (not in both policy lists): ${outside.join(', ')}`);
    const open = held.filter((s) => common.includes(s));
    if (open.length > 1) {
      stopNone();
      return none([...lines, `pair      NONE: ${open.join(' and ')} are both open; serve protects one pair: close one with pair-mainnet first`], 'two pairs are open: serve protects none');
    }
    const savedSymbol = saved.kind === 'loaded' ? saved.state.symbol : null;
    const symbol = open[0] ?? env('GIMBAL_PAIR_SYMBOL')?.trim() ?? savedSymbol ?? (common.length === 1 ? common[0]! : null);
    if (symbol === null) {
      stopNone();
      return none([...lines, `pair      none: both legs flat and no GIMBAL_PAIR_SYMBOL (policy pairs: ${common.join(', ') || 'none'}); nothing to protect`], 'no pair is open');
    }
    if (!common.includes(symbol)) {
      stopNone();
      return none([...lines, `pair      none: ${symbol} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`], `${symbol} is not a policy pair`);
    }

    // ---- the legs ----
    let live = false;
    let relayer: Relayer | null = null;
    let client: NearContractClient = input.side.client;
    if (wantLive) ({ client, relayer } = await deps.signing());
    const prices: PriceDeps = {
      maxAgeS: policy.oracle_max_age_s, send: wantLive, read: (s) => storedPrice(client, s),
      refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }), now: () => input.clock.now(), log: (l) => log(`pair ${l.trim()}`),
      landed: refreshLanded, ...newPriceState(),
    };
    const legs = await deps.buildLegs({ symbol, client, relayer, prices, trading: () => live });
    const why: string[] = [];
    why.push(...legs.mismatches);
    if (!(priceLifeS(policy.oracle_max_age_s) > PRICE_MARGIN_S)) {
      why.push(`oracle_max_age_s ${policy.oracle_max_age_s} leaves a fresh price ${priceLifeS(policy.oracle_max_age_s)} s, not more than the ${PRICE_MARGIN_S} s an IOC and its retry need`);
    }
    const resting = restingOn(await deps.openOrders(evm).catch((err: unknown) => errorMessage(err)), symbol);
    if (typeof resting === 'string') {
      why.push(`${resting}: a resting ${symbol} order could fill under the trader`);
    } else if (resting.length > 0) {
      const names = resting.map((o) => `${o.side} ${o.sz} (oid ${String(o.oid)})`).join(', ');
      why.push(`Hyperliquid has ${resting.length} resting ${symbol} order(s) (${names}), left by an earlier pair-mainnet run: one could fill under the trader and the ADL watch would misread it; cancel it on Hyperliquid, reconcile both legs, then start serve again`);
    }

    // ---- what the trader holds ----
    const read = await readTwice([legs.hl, legs.phoenix], sleep, log);
    const plan = startPlan({ symbol, read, saved, fresh: env('GIMBAL_TRADER_FRESH'), freshWant: `${contractId}/${input.deskId}`, path: store.path });
    if (!plan.stateOk && plan.why !== null) why.push(plan.why);
    if (input.once === true) why.unshift(`serve --once is alert only${asksTrade ? ' (GIMBAL_TRADE=1 is ignored: it exits after one read, maybe in the middle of a close)' : ''}`);
    else if (!asksTrade) why.unshift('GIMBAL_TRADE is not 1');
    live = wantLive && why.length === 0;
    // An alert-only pair holds no lock: pair-mainnet must be able to fix what made it alert only.
    if (!live) release();

    const book = new InFlightBook(plan.inFlight);
    // Set once the trader and the watch exist; a save before that has nothing to write.
    let snapshot: (() => TraderFileState) | null = null;
    const save = () => {
      if (!live || snapshot === null) return;
      store.save(snapshot());
    };
    const guard = (index: 0 | 1) => ({
      index, live: () => live, now: () => input.clock.now(),
      beforeSign: (o: Parameters<InFlightBook['add']>[0]) => book.add(o, save),
    });
    let pair: ProtectedPair | null = null;
    const onOpen = (open: string[]) => {
      for (const line of open) log(line);
      const t = input.clock.now();
      input.publish({ type: 'journal', data: { id: `pair-${t.toString(36)}`, t, kind: 'error', summary: open.join(' | '), numbers: { venue: 'hyperliquid' }, tx: [] } });
    };
    const trader = new PairTrader({
      legs: [new GuardedLeg(legs.hl, guard(0)), new GuardedLeg(legs.phoenix, guard(1))],
      priceBandBps: policy.price_band_bps, clock: input.clock, log: (line) => log(`pair      ${line}`),
      // serve never opens: the human opens with pair-mainnet; after an ADL the pair stays paused too.
      openBlocked: () => 'serve never opens a pair (pair-mainnet open does)',
      onWatch: (w) => {
        // The check's orders are in the trader's state now: they leave the book in the same save.
        book.watchRecorded();
        try {
          save();
        } catch (err) {
          log(`pair      trader state not saved after a watch check: ${errorMessage(err)}`);
        }
        if (w.status === 'unhedged') onOpen(pair?.openLines() ?? [`open:     watch: ${w.notes.join('; ')}`]);
      },
    });
    if (plan.restore !== null) trader.importState(plan.restore);
    else trader.adopt(plan.adopt!);
    legs.hl.adoptPending(plan.pendingMaker);
    pair = new ProtectedPair({
      trader, symbol, live, why: live ? null : why.join('; '), inFlight: book, adlHold: plan.adlHold,
      ...(legs.priced ? { freshPrice: async () => { await ensureFresh(prices, symbol, PRICE_MARGIN_S); } } : {}),
      pendingMaker: () => legs.hl.pendingMakerOrders(),
      cancelPending: (reason) => legs.hl.cancelPending(reason),
      save, onOpen, log: (l) => log(`pair      ${l}`), sleep,
    });
    const pp = pair;
    const adl = new AdlWatch(pp, {
      state: plan.adl, trade: live, hold: () => pp.adlHold, log: (l) => log(`pair      ${l}`),
      // Throws when the save fails: an unwind attempt then sends nothing (risk/adl.ts).
      onChange: () => save(),
    });
    snapshot = () => ({
      version: TRADER_STATE_VERSION, savedAt: input.clock.now(), symbol, trader: trader.exportState(),
      pendingMaker: [...legs.hl.pendingMakerOrders()], inFlight: book.orders, adl: adl.state,
    });
    save();

    for (const n of plan.notes) lines.push(`pair      ${n}`);
    const heldLock = lock as TraderLock | null;
    lines.push(`pair      ${symbol}: hyperliquid ${signedQtyString(read[0])} (${read[0] < 0n ? 'short' : read[0] > 0n ? 'long' : 'flat'}), phoenix ${signedQtyString(read[1])} (${read[1] > 0n ? 'long' : read[1] < 0n ? 'short' : 'flat'})`
      + `${read[0] + read[1] === 0n ? '' : ' NOT offsetting'}; state ${store.path}${live ? '' : ' (read only)'}${heldLock === null ? '' : `, lock ${heldLock.path}`}`);
    for (const line of pp.openLines()) lines.push(line);
    const cancelResting = async (): Promise<CancelResult> => {
      const raw = await deps.openOrders(evm);
      if (!Array.isArray(raw)) throw new Error(restingOn(raw, symbol) as string);
      const out: CancelResult = { cancelled: 0, tx: [], notes: [] };
      for (const o of raw as { coin?: unknown; side?: unknown; sz?: unknown; oid?: unknown }[]) {
        const name = `${String(o.coin)} ${o.side === 'B' ? 'BUY' : 'SELL'} ${String(o.sz)} (oid ${String(o.oid)})`;
        const asset = policy.hl_assets.find((a) => a.symbol === o.coin);
        if (asset === undefined || typeof o.oid !== 'number') {
          out.notes.push(`${name}: not a policy coin, not cancelled here`);
          continue;
        }
        try {
          const r = await relayer!.hlCancel(asset.index, o.oid, 'panic_close: cancel a resting order');
          out.tx.push(...r.tx);
          if (r.statuses[0] === 'success') out.cancelled++;
          else out.notes.push(`${name}: Hyperliquid answered ${JSON.stringify(r.statuses[0] ?? null)} (filled or ended already?)`);
        } catch (err) {
          out.notes.push(`${name}: the cancel failed (${errorMessage(err)})`);
        }
      }
      out.notes.push('Phoenix: the leg sends IOCs only, nothing rests there');
      return out;
    };
    return {
      pair: pp, adl, lines,
      reducer: () => (live ? pp : null),
      notTrading: () => (live ? null : `alert only: ${pp.why ?? 'not live'}`),
      ...(live ? { cancelResting } : {}),
      drain: (timeoutMs) => pp.whenIdle(timeoutMs),
      stop: () => {
        adl.stop();
        trader.stop();
        deps.close();
        release();
      },
    };
  } catch (err) {
    stopNone();
    throw err;
  }
}

/** The mainnet readers, the contract's signing side and buildLiveLegs. */
function defaultDeps(p: { input: ServePairInput; hlUrl: string; phoenixUrl: string; solRpcUrl: string }): ServePairDeps {
  const { input, hlUrl, phoenixUrl, solRpcUrl } = p;
  const desk = input.side.desk;
  // Made on first use: a test that passes every dependency opens nothing.
  let made: { hl: HyperliquidReader; phoenix: PhoenixReader; solana: SolanaSubmitter } | null = null;
  const r = () => (made ??= {
    hl: new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` }),
    phoenix: new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl }),
    solana: new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' }),
  });
  return {
    hlHeld: async (evm) => (await r().hl.account(evm)).positions.filter((x) => x.size !== 0).map((x) => x.symbol),
    phoenixHeld: async (authority) => phoenixHeld(await phoenixTraderApi(phoenixUrl).traderState(authority)),
    openOrders: (evm) => hlInfo(hlUrl, { type: 'openOrders', user: evm }),
    signing: async () => {
      const cfg = contractEnv(input.env, input.mode, { signing: true });
      if (cfg === null) throw new Error('GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key');
      const transport: NearTransport = new NearApiTransport({ network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
      const client = new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport, onHealth: (s, d) => input.log(`pair near ${s}: ${d}`) });
      checkContractNetwork(cfg.contractId, await client.config(), cfg.network);
      return { client, relayer: new Relayer({ contract: client, deskId: input.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }), solana: r().solana }) };
    },
    buildLegs: ({ symbol, client, relayer, prices, trading }) => buildLiveLegs({
      client, desk, symbol, hlUrl, hl: r().hl, phoenix: r().phoenix, phoenixUrl, chain: solanaChain(solRpcUrl), solana: r().solana, relayer,
      prices, trading, maker: { ...DEFAULT_MAKER, timeoutMs: 120_000 }, slippageBps: SERVE_SLIPPAGE_BPS, microLamports: ORDER_PRIORITY_MICROLAMPORTS,
    }),
    close: () => made?.phoenix.close(),
  };
}

async function hlInfo(hlUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
  return res.json();
}

/** The symbols the desk's Phoenix trader holds (every subaccount); none when it is not registered. */
function phoenixHeld(raw: unknown): string[] {
  const r = raw as { snapshot?: { subaccounts?: { positions?: { symbol?: unknown; basePositionLots?: unknown }[] }[] } } | null;
  const out = new Set<string>();
  for (const sub of r?.snapshot?.subaccounts ?? []) {
    for (const p of sub.positions ?? []) {
      if (typeof p.symbol === 'string' && typeof p.basePositionLots === 'string' && /^-?\d+$/.test(p.basePositionLots) && BigInt(p.basePositionLots) !== 0n) out.add(p.symbol);
    }
  }
  return [...out];
}

/** Both legs read twice START_CONFIRM_MS apart until two reads agree (START_READ_TRIES at most); throws otherwise. */
async function readTwice(legs: [TradeLeg, TradeLeg], sleep: (ms: number) => Promise<void>, log: (line: string) => void): Promise<[bigint, bigint]> {
  let last = '';
  for (let i = 0; i < START_READ_TRIES; i++) {
    try {
      const a = await Promise.all(legs.map((l) => l.position()));
      await sleep(START_CONFIRM_MS);
      const b = await Promise.all(legs.map((l) => l.position()));
      if (a[0] === b[0] && a[1] === b[1]) return [a[0]!, a[1]!];
      last = `two reads differ: ${a.map(String).join(',')} then ${b.map(String).join(',')}`;
    } catch (err) {
      last = errorMessage(err);
    }
    log(`pair      the legs could not be read twice alike at start (${last}); trying again`);
    await sleep(START_CONFIRM_MS);
  }
  throw new Error(`pair: the legs could not be read twice alike at start (${last}); nothing is adopted`);
}

/** The contract's stored price of `symbol` and its age (s), or null. */
async function storedPrice(client: NearContractClient, symbol: string): Promise<StoredPrice | null> {
  const row = (await client.prices()).find((p) => p.asset === symbol);
  return row === undefined ? null : { px: Number(row.price_e8) / 1e8, ageS: (Date.now() - row.at_ms) / 1000 };
}

export interface LiveLegsInput {
  client: NearContractClient;
  desk: DeskView;
  symbol: string;
  hlUrl: string;
  hl: Pick<HyperliquidReader, 'book'>;
  phoenix: Pick<PhoenixReader, 'book'>;
  phoenixUrl: string;
  chain: SolanaChain;
  solana: SolanaSubmitter;
  /** The signing relayer; null: a relayer that refuses everything (nothing is signed). */
  relayer: Relayer | null;
  prices: PriceDeps;
  /** Once true, an order finding the stored price about to go stale refreshes it first (oraclePxOf). */
  trading: () => boolean;
  maker: MakerSettings;
  slippageBps: number;
  microLamports: number;
}

export interface LiveLegs {
  hl: HlLeg;
  phoenix: PhoenixLeg;
  /** The symbol has a stored price (not in policy.unpriced). */
  priced: boolean;
  /** The Phoenix exchange and the policy market against the pinned accounts (status ignored: closes are reduce-only). */
  mismatches: string[];
}

/** The two legs of the pair as pair-mainnet builds them (buildPair), for `symbol`. */
export async function buildLiveLegs(input: LiveLegsInput): Promise<LiveLegs> {
  const { symbol, desk } = input;
  const p = desk.policy;
  const asset = p.hl_assets.find((a) => a.symbol === symbol);
  const market = p.phoenix_markets.find((m) => m.symbol === symbol);
  if (asset === undefined || market === undefined) throw new Error(`${symbol} must be in both policy.hl_assets and policy.phoenix_markets`);
  const unpriced = p.unpriced.find((u) => u.symbol === symbol);
  const maxNotionalUsd = unpriced === undefined ? p.max_notional_usd : Math.min(p.max_notional_usd, p.unpriced_max_notional_usd);
  const oraclePx = unpriced !== undefined ? async () => null : oraclePxOf(input.prices, symbol, input.trading);
  const relayer = input.relayer ?? refusingRelayer();
  const best = (book: { bids: { px: number }[]; asks: { px: number }[] }, side: LegSide, venue: string): number => {
    const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on ${venue} ${symbol}`);
    return px;
  };
  const hl = new HlLeg({
    relayer, info: (body) => hlInfo(input.hlUrl, body), user: desk.evm_address.toLowerCase(), coin: symbol, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx,
    bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => best(await input.hl.book(symbol, 5), side, 'Hyperliquid'),
    slippageBps: input.slippageBps, maker: input.maker,
  });
  const spline = await splineOf(market.orderbook);
  const sol: DeskSolanaAccounts = { authority: desk.solana.authority, traderAccount: desk.solana.phoenix_trader, usdcAta: desk.solana.usdc_ata, phusdAta: desk.solana.phusd_ata };
  const phoenix = new PhoenixLeg({
    relayer, chain: input.chain, landedSlot: (sig) => input.solana.landedSlot(sig), waitPastLastValidHeight: (h) => input.solana.waitPastLastValidHeightSlot(h),
    api: phoenixTraderApi(input.phoenixUrl), desk: sol,
    market: { symbol, orderbook: market.orderbook, spline, baseLotE8: market.base_lot_e8, tickE8: market.tick_e8 },
    oraclePx, bandBps: p.price_band_bps, maxNotionalUsd, ...(unpriced === undefined ? {} : { maxSz: unpriced.max_sz }),
    bestPx: async (side) => best(await input.phoenix.book(symbol, 5), side, 'Phoenix'),
    slippageBps: input.slippageBps, microLamports: input.microLamports,
  });
  const res = await fetch(`${input.phoenixUrl}/v1/exchange/snapshot`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`phoenix GET /v1/exchange/snapshot: HTTP ${res.status}`);
  const snap = await res.json() as { exchange: Parameters<typeof exchangeMismatches>[0]; markets: (Parameters<typeof marketMismatches>[0] & { symbol: string })[] };
  const mismatches = [
    ...exchangeMismatches(snap.exchange).map((m) => `the Phoenix exchange differs from the pinned accounts: ${m}`),
    ...marketMismatches(snap.markets.find((m) => m.symbol === symbol), market, spline, { ignoreStatus: true }),
  ];
  return { hl, phoenix, priced: unpriced === undefined, mismatches };
}

/** The relayer of a pair that does not trade: anything that would sign is refused (a bug if reached: legs refuse first). */
function refusingRelayer(): Relayer {
  const no = () => {
    throw new Error('serve does not trade (GIMBAL_TRADE is not 1): nothing is signed');
  };
  return { hlOrder: no, hlCancel: no, solSign: no } as unknown as Relayer;
}

/**
 * The start lines: what is live. `rescue` is serve-rescue's summary; `rescueLive` whether its live rescuer runs.
 * Every protection is named as trading or only alerting.
 */
export function liveLines(p: { pair: ServePair; rescueSummary: string; rescueLive: boolean; mode: Mode; alertPct: number; monitorMin: number }): string[] {
  const pp = p.pair.pair;
  const out: string[] = [...p.pair.lines];
  const tradeVia = 'reduce-only IOCs through the PairTrader (legging guard, price refreshed before each close, open: lines)';
  const adlWhy = pp === null ? null : pp.adlHold ?? pp.adlOff();
  if (pp === null) {
    out.push('live      trades: nothing (no pair trader)');
  } else if (pp.live) {
    const adl = adlWhy === null
      ? `ADL -> pair paused, both legs unwound (${p.pair.adl?.state.attemptsLeft ?? ADL_ATTEMPTS} of ${ADL_ATTEMPTS} attempts left)`
      : `ADL -> alert only: ${adlWhy}`;
    out.push(`live      TRADES (GIMBAL_TRADE=1), ${tradeVia}: panic_close -> resting Hyperliquid orders cancelled, both legs closed; ${adl}`
      + `${p.rescueLive ? '; rescue reduce -> both legs smaller' : ''}`);
  } else {
    out.push(`live      trades: NOTHING, alert only: ${pp.why ?? 'not live'}`);
  }
  const alerts = [
    `liquidation under ${p.alertPct} % (journal + console; monitor lines every ${p.monitorMin} min)`,
    'risk watch and rescue lines (journal, rescue trigger)',
    ...(pp !== null && !pp.live ? ['ADL (journaled, the owner unwinds)', 'panic_close (journaled, nothing cancelled or closed)'] : []),
    ...(pp !== null && pp.live && adlWhy !== null ? [`ADL (journaled for the owner: ${adlWhy})`] : []),
    ...(pp !== null && pp.live && !p.rescueLive ? ['a rescue reduce (no live rescuer: GIMBAL_RESCUE is not 1)'] : []),
    'venue, 1Click and NEAR health',
  ];
  out.push(`live      alerts only: ${alerts.join('; ')}`);
  out.push(`live      rescue: ${p.rescueSummary.replace(/^rescue: /, '')}`);
  if (p.mode === 'mainnet') {
    out.push(`live      rescue routes on mainnet: ${p.rescueLive
      ? `reserve -> Hyperliquid (fund_venue), Hyperliquid -> Arbitrum -> 1Click (hl_withdraw, evm_usdc_to_intents)${pp?.live === true ? ', reduce both legs' : ''}; Phoenix as a source or a target is not wired`
      : 'none live (GIMBAL_RESCUE is not 1): triggers are published at detect, the owner acts'}`);
  }
  return out;
}
