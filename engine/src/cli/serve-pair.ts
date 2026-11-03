// serve's pair trader on mainnet (trade/protected-pair.ts): the legs pair-mainnet trades (HlLeg, PhoenixLeg, the
// relayer), built the same way and with the same guards (pair-mainnet-lib.ts: the stored price refreshed when it would
// not outlive an IOC and its retry, the 300 s life of a fresh price; the policy cap less the band; the Phoenix
// exchange and market checked against the pinned accounts), adopted from the venues at start, and run by a PairTrader
// whose orders are all reduce-only IOCs. It feeds panic_close and a rescue's reduce (the `reducer`) and the ADL watch.
//
// Trading is opt-in: GIMBAL_TRADE=1 loads the operator key by name (never printed), builds the signing relayer and
// takes the per-desk trader lock; it refuses in a linked git worktree, as pair-mainnet --send does. Without it the
// pair is alert only: the legs are read, ADL and the liquidation alert are journaled, and nothing is signed. The
// trader's state is kept in GIMBAL_STATE_DIR (default the per-user state directory), trader-mainnet-<contract>-<desk>-
// <evm>.json (trade/trader-state.ts); a missing file is not a fresh start: GIMBAL_TRADER_FRESH=1 asks for one.
//
// The pair: the one symbol in both policy.hl_assets and policy.phoenix_markets that either venue holds; with both legs
// flat, GIMBAL_PAIR_SYMBOL, else the saved state's, else the only symbol in both lists. Two open pairs are refused
// (serve protects one). Hyperliquid positions outside the policy's pair are named, not protected.
//
// TODO(dedupe): buildLiveLegs mirrors pair-mainnet.ts buildPair (it runs on import, so it cannot be imported); move
// buildPair onto it once engine/pair-followups is merged.

import type { ContractPolicy, Mode, StreamEvent } from '@gimbal/shared';
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
import type { LegSide, MakerSettings } from '../trade/legs.ts';
import { DEFAULT_MAKER, HlLeg } from '../trade/legs.ts';
import { signedQtyString } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import { PhoenixLeg, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { GuardedLeg, ProtectedPair, startPlan } from '../trade/protected-pair.ts';
import type { InFlightOrder, TraderFileState, TraderLock } from '../trade/trader-state.ts';
import { TRADER_STATE_VERSION, TraderStateStore, acquireTraderLock, traderLockPath, traderStateFile, userStateDir } from '../trade/trader-state.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';
import type { PriceDeps, StoredPrice } from './pair-mainnet-lib.ts';
import { PRICE_MARGIN_S, ensureFresh, newPriceState, oraclePxOf, priceLifeS } from './pair-mainnet-lib.ts';
import type { ContractSide } from './serve-contract.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

/** The IOC slippage of serve's closes, as pair-mainnet's default. */
export const SERVE_SLIPPAGE_BPS = 50;
/** At start both legs are read twice this far apart, and must agree; up to START_READ_TRIES times. */
const START_CONFIRM_MS = 3_000;
const START_READ_TRIES = 3;

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
  sleep?: (ms: number) => Promise<void>;
}

export interface ServePair {
  pair: ProtectedPair | null;
  adl: AdlWatch | undefined;
  /** The rescue's and panic_close's reducer: the pair when it trades, else null (they then say nothing traded). */
  reducer(): Reducer | null;
  /** What serve's start says about the pair, one line each. */
  lines: string[];
  stop(): void;
}

const none = (lines: string[]): ServePair => ({ pair: null, adl: undefined, reducer: () => null, lines, stop: () => {} });

export async function servePair(input: ServePairInput): Promise<ServePair> {
  const { env, log } = input;
  if (input.mode !== 'mainnet') return none([`pair      none on ${input.mode}: the pair is Hyperliquid and Phoenix, and Phoenix is mainnet only`]);
  const wantLive = env('GIMBAL_TRADE') === '1';
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
  const hl = new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` });
  const phoenix = new PhoenixReader({ apiUrl: phoenixUrl, rpcUrl: solRpcUrl });
  const traderApi = phoenixTraderApi(phoenixUrl);
  const closeReaders = () => phoenix.close();

  try {
    const identity = { contractId, deskId: input.deskId, evm };
    const store = new TraderStateStore(traderStateFile(input.stateDir ?? userStateDir(env), input.mode, identity), identity);
    const saved = store.load();
    const fresh = env('GIMBAL_TRADER_FRESH') === '1';

    // ---- which pair ----
    const common = policy.hl_assets.map((a) => a.symbol).filter((s) => policy.phoenix_markets.some((m) => m.symbol === s));
    const hlHeld = (await hl.account(evm)).positions.filter((p) => p.size !== 0).map((p) => p.symbol);
    const pxState = await traderApi.traderState(desk.solana.authority);
    const pxHeld = phoenixHeld(pxState);
    const held = [...new Set([...hlHeld, ...pxHeld])];
    const lines: string[] = [];
    const outside = held.filter((s) => !common.includes(s));
    if (outside.length > 0) lines.push(`pair      not protected (not in both policy lists): ${outside.join(', ')}`);
    const open = held.filter((s) => common.includes(s));
    if (open.length > 1) return none([...lines, `pair      NONE: ${open.join(' and ')} are both open; serve protects one pair: close one with pair-mainnet first`]);
    const savedSymbol = saved.kind === 'loaded' ? saved.state.symbol : null;
    const asked = env('GIMBAL_PAIR_SYMBOL')?.toUpperCase();
    const symbol = open[0] ?? asked ?? savedSymbol ?? (common.length === 1 ? common[0]! : null);
    if (symbol === null) {
      return none([...lines, `pair      none: both legs flat and no GIMBAL_PAIR_SYMBOL (policy pairs: ${common.join(', ') || 'none'}); nothing to protect`]);
    }
    if (!common.includes(symbol)) return none([...lines, `pair      none: ${symbol} is not in both policy.hl_assets and policy.phoenix_markets (${common.join(', ') || 'none'})`]);

    // ---- the legs ----
    let live = false;
    let relayer: Relayer | null = null;
    let signingClient: NearContractClient | null = null;
    const solana = new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' });
    if (wantLive) {
      const cfg = contractEnv(env, input.mode, { signing: true });
      if (cfg === null) throw new Error('GIMBAL_TRADE=1 needs GIMBAL_CONTRACT_ID, DESK_ID and the operator key');
      const transport: NearTransport = new NearApiTransport({ network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
      signingClient = new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport, onHealth: (s, d) => log(`pair near ${s}: ${d}`) });
      checkContractNetwork(cfg.contractId, await signingClient.config(), cfg.network);
      relayer = new Relayer({ contract: signingClient, deskId: input.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'mainnet', apiUrl: hlUrl }), solana });
    }
    const client = signingClient ?? input.side.client;
    const prices: PriceDeps = {
      maxAgeS: policy.oracle_max_age_s, send: wantLive, read: (s) => storedPrice(client, s),
      refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }), now: () => input.clock.now(), log: (l) => log(`pair ${l.trim()}`), ...newPriceState(),
    };
    const legs = await buildLiveLegs({
      client, desk, symbol, hlUrl, hl, phoenix, phoenixUrl, chain: solanaChain(solRpcUrl), solana, relayer,
      prices, trading: () => live, maker: { ...DEFAULT_MAKER, timeoutMs: 120_000 }, slippageBps: SERVE_SLIPPAGE_BPS, microLamports: ORDER_PRIORITY_MICROLAMPORTS,
    });
    const why: string[] = [];
    why.push(...legs.mismatches);
    if (!(priceLifeS(policy.oracle_max_age_s) > PRICE_MARGIN_S)) {
      why.push(`oracle_max_age_s ${policy.oracle_max_age_s} leaves a fresh price ${priceLifeS(policy.oracle_max_age_s)} s, not more than the ${PRICE_MARGIN_S} s an IOC and its retry need`);
    }

    // ---- what the trader holds ----
    const read = await readTwice([legs.hl, legs.phoenix], sleep, log);
    const plan = startPlan({ symbol, read, saved, fresh, path: store.path });
    if (!plan.stateOk && plan.why !== null) why.push(plan.why);
    if (!wantLive) why.unshift('GIMBAL_TRADE is not 1');
    live = wantLive && why.length === 0;
    let lock: TraderLock | null = null;
    if (live) lock = acquireTraderLock(traderLockPath(env, input.mode, contractId, input.deskId));

    let inFlight: InFlightOrder | null = null;
    // Set once the trader and the watch exist; a save before that has nothing to write.
    let snapshot: (() => TraderFileState) | null = null;
    const save = () => {
      if (!live || snapshot === null) return;
      store.save(snapshot());
    };
    const guard = (index: 0 | 1) => ({
      index, live: () => live, now: () => input.clock.now(),
      beforeSign: (o: InFlightOrder) => {
        inFlight = o;
        save();
      },
      afterSign: () => {
        inFlight = null;
        save();
      },
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
      trader, symbol, live, why: live ? null : why.join('; '),
      ...(legs.priced ? { freshPrice: async () => { await ensureFresh(prices, symbol, PRICE_MARGIN_S); } } : {}),
      pendingMaker: () => legs.hl.pendingMakerOrders(),
      cancelPending: (reason) => legs.hl.cancelPending(reason),
      save, onOpen, log: (l) => log(`pair      ${l}`),
    });
    const adl = new AdlWatch(pair, {
      state: plan.adl, trade: live, log: (l) => log(`pair      ${l}`),
      // Throws when the save fails: an unwind attempt then sends nothing (risk/adl.ts).
      onChange: () => save(),
    });
    snapshot = () => ({
      version: TRADER_STATE_VERSION, savedAt: input.clock.now(), symbol, trader: trader.exportState(),
      pendingMaker: [...legs.hl.pendingMakerOrders()], inFlight, adl: adl.state,
    });
    save();

    for (const n of plan.notes) lines.push(`pair      ${n}`);
    lines.push(`pair      ${symbol}: hyperliquid ${signedQtyString(read[0])} (${read[0] < 0n ? 'short' : read[0] > 0n ? 'long' : 'flat'}), phoenix ${signedQtyString(read[1])} (${read[1] > 0n ? 'long' : read[1] < 0n ? 'short' : 'flat'})`
      + `${read[0] + read[1] === 0n ? '' : ' NOT offsetting'}; state ${store.path}${live ? '' : ' (read only)'}${lock === null ? '' : `, lock ${lock.path}`}`);
    for (const line of [...plan.open, ...pair.openLines()]) lines.push(line);
    return {
      pair, adl, lines,
      reducer: () => (live ? pair : null),
      stop: () => {
        adl.stop();
        trader.stop();
        closeReaders();
        lock?.release();
      },
    };
  } catch (err) {
    closeReaders();
    throw err;
  }
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
async function readTwice(legs: [HlLeg, PhoenixLeg], sleep: (ms: number) => Promise<void>, log: (line: string) => void): Promise<[bigint, bigint]> {
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
  const info = async (body: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch(`${input.hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
    return res.json();
  };
  const best = (book: { bids: { px: number }[]; asks: { px: number }[] }, side: LegSide, venue: string): number => {
    const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
    if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on ${venue} ${symbol}`);
    return px;
  };
  const hl = new HlLeg({
    relayer, info, user: desk.evm_address.toLowerCase(), coin: symbol, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx,
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
 * The start line: what is live. `rescue` is serve-rescue's summary; `rescueLive` whether its live rescuer runs.
 * Every protection is named as trading or only alerting.
 */
export function liveLines(p: { pair: ServePair; rescueSummary: string; rescueLive: boolean; mode: Mode; alertPct: number; monitorMin: number }): string[] {
  const pp = p.pair.pair;
  const out: string[] = [...p.pair.lines];
  const tradeVia = 'reduce-only IOCs through the PairTrader (legging guard, price refreshed before each close, open: lines)';
  if (pp === null) {
    out.push('live      trades: nothing (no pair trader)');
  } else if (pp.live) {
    out.push(`live      TRADES (GIMBAL_TRADE=1), ${tradeVia}: panic_close -> both legs closed; ADL -> pair paused, both legs unwound (${p.pair.adl?.state.attemptsLeft ?? ADL_ATTEMPTS} of ${ADL_ATTEMPTS} attempts left)`
      + `${p.rescueLive ? '; rescue reduce -> both legs smaller' : ''}`);
  } else {
    out.push(`live      trades: NOTHING, alert only: ${pp.why ?? 'not live'}`);
  }
  const alerts = [
    `liquidation under ${p.alertPct} % (journal + console; monitor lines every ${p.monitorMin} min)`,
    'risk watch and rescue lines (journal, rescue trigger)',
    ...(pp !== null && !pp.live ? ['ADL (journaled, the owner unwinds)', 'panic_close (journaled, nothing closed)'] : []),
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

