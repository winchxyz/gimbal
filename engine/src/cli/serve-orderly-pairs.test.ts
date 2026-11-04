// serve with Orderly pairs (GIMBAL_ORDERLY_PAIRS=1), end to end on fakes and wired as serve.ts wires it: the pair
// trader (servePair) with an Orderly session, the strategy loop (serveLoop, the real decide()) on the pair's hands,
// and the position book (createBook through loopBook, its Orderly ledgers from liveBookSources over the session's fill
// log). An HL + Orderly window and an Orderly + Phoenix window pass the gate, enter (Hyperliquid maker then the
// Orderly IOC; two IOCs), are held, booked (fees, funding), closed by panic_close, and adopted again after a
// restart. A window Orderly lacks the margin for is refused once. Without the flag the HL/Phoenix desk's decisions and
// text are as before. No network: Orderly's public /info comes from the recorded wire; nothing signs.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContractPolicy, JournalEntry, StreamEvent, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { createBook } from '../book/book.ts';
import type { PositionBook } from '../book/book.ts';
import { ORDERLY_LATE_PUSH_MS, OrderlyFillLog } from '../book/orderly.ts';
import { liveBookSources } from '../book/sources.ts';
import type { BookSources } from '../book/sync.ts';
import { FixtureLedger } from '../book/test-helpers.ts';
import type { NearContractClient } from '../contract/near-client.ts';
import type { Relayer } from '../relayer/relayer.ts';
import type { WindowCarry } from '../scanner/scanner.ts';
import { loopStateFile } from '../strategy/loop.ts';
import type { StrategyLoop } from '../strategy/loop.ts';
import { HOUR, STRATEGY, T0, win } from '../strategy/test-helpers.ts';
import type { LegOutcome, LegSide, PendingMakerOrder, TradeLeg } from '../trade/legs.ts';
import { qtyNumber, toQty } from '../trade/lots.ts';
import { makerIndexOf } from '../trade/pair-shape.ts';
import { parseFundingRow } from '../venues/hyperliquid.ts';
import type { HlFundingRow } from '../venues/hyperliquid.ts';
import type { OrderlyFundingFeePage, OrderlyFundingFeeRow } from '../venues/orderly-actions.ts';
import { readWireRecording, replayFetch } from '../venues/replay.ts';
import type { AccountState, Book, Market, VenueReader } from '../venues/venue.ts';
import type { ContractSide } from './serve-contract.ts';
import { loopBook, serveLoop, windowSymbol } from './serve-loop.ts';
import type { BuiltLegs, ServeOrderly, ServePair, ServePairInput } from './serve-pair.ts';
import { fullLegs, servePair } from './serve-pair.ts';
import { traderStateFile } from '../trade/trader-state.ts';
import { REPLAY_WINDOW_MS } from '../trade/pair.ts';
import type { OrderlySessionStatus } from './serve-orderly.ts';
import { startOrderlySession } from './serve-orderly.ts';
import { NothingExecuted } from '../relayer/tx.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONTRACT = 'gimbal-test.near';
const DESK = 'canary';
const EVM = `0x${'ab'.repeat(20)}`;
const ACCOUNT = `0x${'0'.repeat(62)}a1`;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const WIRE = readWireRecording(join(fileURLToPath(new URL('../../fixtures/orderly-wire/', import.meta.url)), 'orderly-mainnet-2026-10-31.jsonl.gz'));
const PANIC = { reason: 'panic_close: the owner closed the desk', reduceOnly: true, by: 'panic_close' } as const;
/** Fees by venue, of the notional: Hyperliquid's maker rate, Orderly's 3 bps plus the 1 bp gimbal_dex broker fee, Phoenix's. */
const FEE = { hyperliquid: 0.00015, orderly: 0.0004, phoenix: 0.0005 } as const;

const ticks = async (n = 50) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A venue leg at a price of 1 USD: Hyperliquid also rests maker orders, Orderly's fills are pushed to the session's log. */
class FakeLeg implements TradeLeg {
  readonly lot = toQty('0.01');
  readonly replayable: boolean;
  readonly makerOrder?: (side: LegSide, size: bigint, reduceOnly: boolean, reason: string) => Promise<LegOutcome>;
  pos = 0n;
  /** The next IOCs: how much each fills (less than asked: partly), or 'refuse' (signed, nothing filled). */
  next: (bigint | 'refuse')[] = [];
  readonly venue: VenueId;
  readonly symbol: string;
  readonly #desk: Desk;
  constructor(venue: VenueId, symbol: string, desk: Desk) {
    this.venue = venue;
    this.symbol = symbol;
    this.#desk = desk;
    this.replayable = venue === 'orderly';
    if (venue === 'hyperliquid') this.makerOrder = async (side, size, reduceOnly) => this.#fill(side, size, reduceOnly, 'maker');
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    return this.pos;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    return this.#fill(side, size, reduceOnly, 'ioc');
  }
  adoptPending(_orders: readonly PendingMakerOrder[]): void {}
  pendingMakerOrders(): readonly PendingMakerOrder[] {
    return [];
  }
  async cancelPending(): Promise<string[]> {
    return [];
  }
  #fill(side: LegSide, asked: bigint, reduceOnly: boolean, how: 'maker' | 'ioc'): LegOutcome {
    const at = this.#desk.now;
    const plan = how === 'ioc' ? this.next.shift() : undefined;
    const id = ++this.#desk.orderIds;
    const tx = [{ chain: 'near' as const, id: `t${id}`, url: '' }];
    if (plan === 'refuse') {
      this.#desk.timeline.push(`${this.venue} ${this.symbol} ${how} ${side}${reduceOnly ? ' reduce-only' : ''} refused`);
      return { kind: 'failed', error: new NothingExecuted(this.venue, 'the IOC filled nothing'), ref: { venue: this.venue, side, size: String(asked), reduceOnly, orderId: `o${id}`, clientId: null, tx, sentAt: at } };
    }
    const size = plan ?? asked;
    this.#desk.timeline.push(`${this.venue} ${this.symbol} ${how} ${side}${reduceOnly ? ' reduce-only' : ''}${size === asked ? '' : ` ${qtyNumber(size)} of ${qtyNumber(asked)}`}`);
    this.pos += side === 'BUY' ? size : -size;
    const n = qtyNumber(size);
    const ref = { venue: this.venue, side, size: String(asked), reduceOnly, orderId: `o${id}`, clientId: null, tx, sentAt: at };
    if (this.venue !== 'orderly') return { kind: 'filled', filled: size, avgPx: 1, fee: n * FEE[this.venue], ref };
    // Orderly: the fee comes with the session's executionreport push (the book reads it from the fill log).
    this.#desk.fills.onExecutionReport({
      symbol: this.symbol, clientOrderId: `g${id}`, orderId: id, type: 'LIMIT', side, quantity: n, price: 1, tradeId: 9000 + id, executedPrice: 1,
      executedQuantity: n, fee: n * FEE.orderly, feeAsset: 'USDC', totalExecutedQuantity: n, avgPrice: 1, averageExecutedPrice: 1, status: 'FILLED',
      reason: '', totalFee: n * FEE.orderly, visible: n, visibleQuantity: n, timestamp: at, createdTime: at - 4, matchId: 9000 + id, seq: at * 1000,
      marginMode: 'CROSS', maker: false,
    }, at + 20);
    return { kind: 'filled', filled: size, avgPx: 1, fee: null, ref };
  }
}

interface Desk {
  dir: string;
  env: Record<string, string>;
  now: number;
  timeline: string[];
  orderIds: number;
  fills: OrderlyFillLog;
  legs: Map<string, FakeLeg>;
  /** Free margin per venue, USD. */
  margin: Record<string, number>;
  windows: FundingWindow[];
  events: StreamEvent[];
  lines: string[];
  fundingRows: OrderlyFundingFeeRow[];
  hlFunding: FixtureLedger;
  /**
   * serve's Orderly session (serveOrderly): idle until started; live `upAfterMs` after the start (null: never), the
   * pair's start waiting for it at most `waitMs` (startOrderlySession, as serve.ts waits).
   */
  session: { state: 'idle' | 'opening' | 'live'; starts: number; upAfterMs: number | null; waitMs: number };
}

function desk(env: Record<string, string>): Desk {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-pairs-'));
  dirs.push(dir);
  return {
    dir, env: { LOCALAPPDATA: dir, XDG_STATE_HOME: dir, GIMBAL_TRADE: '1', GIMBAL_TRADER_FRESH: `${CONTRACT}/${DESK}`, ...env },
    now: T0 + 2 * 60_000, timeline: [], orderIds: 0, fills: new OrderlyFillLog(T0 - HOUR), legs: new Map(),
    margin: { hyperliquid: 50, phoenix: 50, orderly: 50 }, windows: [], events: [], lines: [], fundingRows: [], hlFunding: new FixtureLedger([]),
    session: { state: 'idle', starts: 0, upAfterMs: 5, waitMs: 2_000 },
  };
}

function legOf(d: Desk, venue: VenueId, symbol: string): FakeLeg {
  const key = `${venue}:${symbol}`;
  let leg = d.legs.get(key);
  if (leg === undefined) {
    leg = new FakeLeg(venue, symbol, d);
    d.legs.set(key, leg);
  }
  return leg;
}

const heldOn = (d: Desk, venue: VenueId) => [...d.legs.values()].filter((l) => l.venue === venue && l.pos !== 0n);
const positions = (d: Desk) => Object.fromEntries([...d.legs.entries()].filter(([, l]) => l.pos !== 0n).map(([k, l]) => [k, qtyNumber(l.pos)]));

const POLICY = {
  hl_assets: [{ symbol: 'SOL', index: 5, sz_decimals: 2 }, { symbol: 'ETH', index: 1, sz_decimals: 4 }],
  phoenix_markets: [{ symbol: 'SOL' }, { symbol: 'ETH' }],
  orderly_symbols: ['PERP_SOL_USDC', 'PERP_ETH_USDC'],
  oracle_max_age_s: 900, price_band_bps: 100, unpriced: [], max_notional_usd: 20, unpriced_max_notional_usd: 10,
};

function side(): ContractSide {
  const client = { contractId: CONTRACT, prices: async () => [], refreshPrices: async () => [] } as unknown as NearContractClient;
  const policy = structuredClone(POLICY);
  return { client, desk: { policy, evm_address: EVM, solana: { authority: 'Auth111' } }, policy, prices: {} } as unknown as ContractSide;
}

/** servePair's input as serve builds it, over the fake venues; `orderly`: the Orderly session (serveOrderly) is up. */
function pairInput(d: Desk, onProtectionClose: ServePairInput['onProtectionClose'], orderly = true): ServePairInput {
  const s = side();
  // The pair trader's Orderly side over the session (orderlyPairSide): nothing until the session is live.
  const session: ServeOrderly = {
    leg: (spec) => (d.session.state === 'live' ? legOf(d, 'orderly', spec.symbol) : null),
    ready: async () => (d.session.state === 'live' ? null : `serve's Orderly session is not up (${d.session.state})`),
    account: async () => {
      if (d.session.state !== 'live') throw new Error(`orderly account unknown: the private session is ${d.session.state}`);
      return {
      venue: 'orderly', address: ACCOUNT, time: d.now, equityUsd: 100, freeMarginUsd: d.margin.orderly!, maintenanceMarginUsd: 0,
      positions: heldOn(d, 'orderly').map((l) => ({
        symbol: l.symbol, size: qtyNumber(l.pos), entryPx: 1, liqPx: null, marginUsd: 1, unrealizedPnlUsd: 0, leverage: 1, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0,
      })),
      };
    },
  };
  return {
    mode: 'mainnet', env: (n) => d.env[n], side: s, deskId: DESK, clock: { now: () => d.now }, log: (l) => d.lines.push(l), publish: (e) => d.events.push(e),
    stateDir: d.dir, linkedWorktree: false, sleep: async (ms) => { d.now += ms; },
    ...(orderly ? { orderly: session } : {}),
    ...(onProtectionClose === undefined ? {} : { onProtectionClose }),
    deps: {
      hlHeld: async () => heldOn(d, 'hyperliquid').map((l) => l.symbol),
      phoenixHeld: async () => heldOn(d, 'phoenix').map((l) => l.symbol),
      openOrders: async () => [],
      signing: async () => ({ client: s.client, relayer: {} as Relayer }),
      buildLegs: async ({ symbol, shape }) => {
        const legs = shape.legs.map((l) => legOf(d, l.venue, l.symbol)) as [FakeLeg, FakeLeg];
        const on = (v: VenueId) => (shape.legs.some((l) => l.venue === v) ? legOf(d, v, symbol) : null);
        return { shape, legs, hl: on('hyperliquid'), phoenix: on('phoenix'), priced: false, mismatches: [] } as unknown as BuiltLegs;
      },
      // pair-mainnet's open and close as liveCarry sends them: the shape's long leg, Hyperliquid first as maker.
      carry: (c) => ({
        open: async (request) => {
          const gated = request.gate?.() ?? null;
          if (gated !== null) return { refusals: [`${gated}: nothing sent`], results: [] };
          const full = fullLegs(c.symbol, c.legs);
          const maker = makerIndexOf(full.shape);
          const results = await c.pair.openInChunks({
            size: toQty(request.qty ?? String(request.legUsd)), longIndex: full.shape.longIndex, reason: request.reason, ...(maker === null ? {} : { maker: { index: maker } }),
          });
          return { refusals: [], results };
        },
        close: async (request) => ({ refusals: [], results: [await c.pair.close({ reason: request.reason })] }),
      }),
      close: () => {},
    },
  };
}

/** The desk venues' public readers: every market in lots of 0.01, books at 1 USD. */
function readers(): VenueReader[] {
  const market = (venue: VenueId, symbol: string): Market => ({
    venue, symbol, assetIndex: null, szDecimals: 2, lotSize: 0.01, tickSize: 0.0001, maxPxDecimals: 4, maxLeverage: 10, isolatedOnly: false, delisted: false,
  });
  const names: Record<string, string[]> = { hyperliquid: ['SOL', 'ETH'], phoenix: ['SOL', 'ETH'], orderly: ['PERP_SOL_USDC', 'PERP_ETH_USDC'] };
  return (['hyperliquid', 'phoenix', 'orderly'] as const).map((id) => ({
    id,
    markets: async () => names[id]!.map((s) => market(id, s)),
    book: async (symbol: string): Promise<Book> => ({ venue: id, symbol, time: 0, bids: [{ px: 0.9995, sz: 10_000 }], asks: [{ px: 1.0005, sz: 10_000 }] }),
  } as unknown as VenueReader));
}

const carryOf = (w: FundingWindow): WindowCarry => ({
  estimate: { gross: { d14AprPct: 18 } },
  long: { venue: w.longVenue, symbol: w.symbol, oiUsd: 5_000_000, priceMove24hPct: 1 },
  short: { venue: w.shortVenue, symbol: w.symbol, oiUsd: 5_000_000, priceMove24hPct: 1 },
} as unknown as WindowCarry);

/** One serve: the pair trader, the book and the loop on it, as serve.ts wires them. */
async function serve(d: Desk, o: { orderly?: boolean } = {}) {
  let loop: StrategyLoop | null = null;
  const fees = {
    accountId: ACCOUNT,
    async fundingFeeHistory(start: number, end: number, page: number, size: number): Promise<OrderlyFundingFeePage> {
      const all = d.fundingRows.filter((r) => r.created_time >= start && r.created_time <= end);
      return { rows: all.slice((page - 1) * size, page * size), meta: { total: all.length, records_per_page: size, current_page: page } };
    },
  };
  const live = liveBookSources({ network: 'mainnet', fetch: replayFetch(WIRE), orderly: { fundingFees: fees, fills: () => d.fills, hearWaitMs: 20 } });
  const sources: BookSources = {
    funding: { hyperliquid: d.hlFunding, phoenix: new FixtureLedger([]), orderly: live.funding.orderly! },
    fillFee: (q) => (q.venue === 'orderly' ? live.fillFee!(q) : Promise.resolve(null)),
    closeFills: (q) => (q.venue === 'orderly' ? live.closeFills!(q) : Promise.resolve(null)),
  };
  const book: PositionBook = createBook({
    dir: d.dir, mode: 'mainnet', contractId: CONTRACT, deskId: DESK, addresses: { hyperliquid: EVM, phoenix: 'Auth111', orderly: ACCOUNT }, sources,
    publish: (data: JournalEntry) => d.events.push({ type: 'journal', data }), clock: { now: () => d.now }, log: (l) => d.lines.push(l), loopHeld: () => loop?.held ?? null,
  });
  const booked = loopBook(book, (e) => d.events.push(e), (l) => d.lines.push(l), () => loop?.held ?? null);
  // As serve.ts: the Orderly session opened, and waited for, before the pair's start reads over it.
  if (o.orderly !== false) {
    const late = await startOrderlySession({
      start: () => {
        if (d.session.state !== 'idle') return;
        d.session.starts++;
        d.session.state = 'opening';
        const after = d.session.upAfterMs;
        if (after !== null) setTimeout(() => { d.session.state = 'live'; }, after);
      },
      status: () => ({ state: d.session.state, why: null } as unknown as OrderlySessionStatus),
    }, { deadlineMs: d.session.waitMs, pollMs: 2 });
    d.lines.push(late === null ? 'orderly: the private session is live; the pair starts' : `orderly: ${late}`);
  }
  const pair: ServePair = await servePair(pairInput(d, (r) => booked.protectionClose(r), o.orderly ?? true));
  const account = (venue: string) => ({
    venue, read: async (): Promise<AccountState> => ({ venue, address: 'a', time: d.now, equityUsd: 100, freeMarginUsd: d.margin[venue]!, maintenanceMarginUsd: 0, positions: [] } as unknown as AccountState),
  });
  loop = serveLoop({
    mode: 'mainnet', env: (n) => d.env[n], once: false, stateDir: d.dir, contractId: CONTRACT, deskId: DESK, pair, lastDesk: () => null,
    accounts: ['hyperliquid', 'phoenix', ...(o.orderly === false ? [] : ['orderly'])].map(account), rescueLive: false, busy: () => null,
    windows: () => d.windows, strategy: () => STRATEGY, policy: () => POLICY as unknown as ContractPolicy, publish: booked.publish, clock: { now: () => d.now },
    log: (l) => d.lines.push(l), book: booked.sink, carry: (id) => {
      const w = d.windows.find((x) => x.id === id);
      return w === undefined ? null : carryOf(w);
    },
    venues: readers(),
  });
  const l = loop;
  return {
    pair, book, loop: l,
    stop: () => {
      l.stop();
      pair.stop();
    },
  };
}

/** Hourly checks (just past the top of each hour) until `until` holds or `max` checks ran. */
async function hourly(d: Desk, loop: StrategyLoop, until: () => boolean, max = 6): Promise<number> {
  for (let i = 0; i < max; i++) {
    d.now = Math.floor(d.now / HOUR) * HOUR + HOUR + 2 * 60_000;
    await loop.check();
    if (until()) return i + 1;
  }
  return max;
}

const journal = (d: Desk) => d.events.flatMap((e) => (e.type === 'journal' ? [e.data] : []));
const decisions = (d: Desk) => d.events.flatMap((e) => (e.type === 'decision' ? [e.data] : []));
const loopFile = (d: Desk) => loopStateFile(d.dir, 'mainnet', CONTRACT, DESK);

/** Hyperliquid userFunding rows (wire shape): a short SOL 12 receiving 0.001 an hour at `hours`. */
function hlRows(hours: number[]) {
  return hours.map((t) => parseFundingRow({ time: t + 65, hash: ZERO_HASH, delta: { type: 'funding', coin: 'SOL', usdc: '0.001', szi: '-12.0', fundingRate: '0.00001', nSamples: null } } as HlFundingRow));
}

const feeRow = (symbol: string, t: number, fee: number, type: 'Pay' | 'Receive' = 'Pay'): OrderlyFundingFeeRow & Record<string, unknown> => ({
  symbol, funding_rate: 0.00005, mark_price: 1, funding_fee: fee, payment_type: type, status: 'Accrued', created_time: t, updated_time: t, margin_mode: 'CROSS',
});

const near = (a: number | null | undefined, b: number, what: string) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

/** Enters `id` through the loop's hourly checks (the session already live). */
async function enter(d: Desk, s: Awaited<ReturnType<typeof serve>>, id: string): Promise<void> {
  d.windows = [win(id)];
  assert.equal(await hourly(d, s.loop, () => s.loop.held !== null), 3, JSON.stringify(decisions(d).map((x) => x.reason)));
}

test('GIMBAL_ORDERLY_PAIRS=1, HL + Orderly: the window passes the gate, opens Hyperliquid maker then the Orderly IOC, is held and booked (fees, funding), adopted again after a restart, and closed by panic_close', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  d.windows = [win('sol-orderly-hyperliquid')];
  let s = await serve(d);
  // The session was opened and live before the pair's start read the desk's Orderly positions over it.
  assert.equal(d.session.starts, 1);
  assert.equal(s.pair.unconfirmed?.() ?? null, null, s.pair.lines.join('\n'));
  assert.ok(s.pair.hands?.pairSymbols !== undefined, s.pair.lines.join('\n'));
  assert.deepEqual(s.pair.hands!.pairSymbols!('orderly', 'hyperliquid'), ['SOL', 'ETH']);
  assert.deepEqual(windowSymbol(d.windows[0]!, s.pair.hands!.symbols, s.pair.hands!.pairSymbols!.bind(s.pair.hands!)), { symbol: 'SOL' });

  // The gate: three passing hourly checks, then the enter (the real decide(), lots and mid from Orderly's and HL's markets).
  const checks = await hourly(d, s.loop, () => s.loop.held !== null);
  assert.equal(checks, 3, JSON.stringify(decisions(d).map((x) => x.reason)));
  assert.deepEqual(d.timeline, ['hyperliquid SOL maker SELL', 'orderly PERP_SOL_USDC ioc BUY']);
  assert.deepEqual(positions(d), { 'hyperliquid:SOL': -12, 'orderly:PERP_SOL_USDC': 12 });
  const held = s.loop.held!;
  assert.deepEqual([held.windowId, held.symbol, held.long, held.short], ['sol-orderly-hyperliquid', 'SOL', 'orderly', 'hyperliquid']);
  const enter = journal(d).find((j) => j.kind === 'enter')!;
  assert.match(enter.summary, /^enter sol-orderly-hyperliquid, SOL short hyperliquid, long orderly, at most 12 SOL \(12 USD\) a leg at 1\.5x/);
  const enteredAt = d.now;

  // Held: the next checks hold it (the record names its legs, the hands name theirs).
  await hourly(d, s.loop, () => false, 1);
  assert.equal(decisions(d).at(-1)!.action, 'hold', decisions(d).at(-1)!.reason);
  assert.equal(d.timeline.length, 2, 'nothing sent while held');

  // Booked: the open's Orderly fee from the session's push, Orderly's 16:00 payment (its 8 h period) from the signed
  // read, Hyperliquid's hourly funding.
  d.fundingRows = [feeRow('PERP_SOL_USDC', T0 + 4 * HOUR, 0.005)];
  d.hlFunding.rows = hlRows([T0 + 3 * HOUR, T0 + 4 * HOUR, T0 + 5 * HOUR]);
  d.now = T0 + 5 * HOUR + 5 * 60_000;
  d.fills.heard(d.now + ORDERLY_LATE_PUSH_MS);
  await s.book.sync();
  let p = s.book.summary().positions[0]!;
  assert.equal(p.open, true);
  assert.deepEqual(p.legs.map((l) => `${l.venue} ${l.side}`).sort(), ['hyperliquid short', 'orderly long']);
  const ox = p.legs.find((l) => l.venue === 'orderly')!;
  const hl = p.legs.find((l) => l.venue === 'hyperliquid')!;
  assert.ok(Math.abs(ox.entryFeeUsd! + 12 * FEE.orderly) < 1e-9, `orderly open fee ${ox.entryFeeUsd}`);
  assert.ok(Math.abs(hl.entryFeeUsd! + 12 * FEE.hyperliquid) < 1e-9, `hyperliquid open fee ${hl.entryFeeUsd}`);
  assert.ok(Math.abs(ox.fundingUsd + 0.005) < 1e-9, `orderly funding ${ox.fundingUsd}`);
  assert.ok(hl.fundingUsd > 0, `hyperliquid funding ${hl.fundingUsd}`);
  assert.ok(enteredAt < T0 + 4 * HOUR);

  // Restart: the trader state and the loop's record bring the pair back with its legs; the book holds it still.
  s.stop();
  await ticks();
  s = await serve(d);
  assert.equal(s.pair.pair?.live, true, s.pair.lines.join('\n'));
  assert.deepEqual(s.pair.hands!.heldLegs().map((l) => l.venue), ['hyperliquid', 'orderly']);
  await hourly(d, s.loop, () => false, 1);
  assert.deepEqual([s.loop.held?.windowId, s.loop.held?.long, s.loop.held?.short], ['sol-orderly-hyperliquid', 'orderly', 'hyperliquid']);
  assert.equal(decisions(d).at(-1)!.action, 'hold', decisions(d).at(-1)!.reason);
  assert.equal(s.book.summary().positions.filter((x) => x.open).length, 1);

  // The loop's record lost: the venues' pair is adopted on its own legs (the window it pays), not as HL / Phoenix.
  s.stop();
  await ticks();
  rmSync(loopFile(d));
  s = await serve(d);
  await hourly(d, s.loop, () => false, 1);
  assert.deepEqual([s.loop.held?.windowId, s.loop.held?.long, s.loop.held?.short], ['sol-orderly-hyperliquid', 'orderly', 'hyperliquid']);
  const saved = JSON.parse(readFileSync(loopFile(d), 'utf8')) as { held: Record<string, unknown> };
  assert.deepEqual([saved.held.long, saved.held.short], ['orderly', 'hyperliquid']);

  // panic_close: both legs close reduce-only through the pair's trader; the book books the exit.
  const before = d.timeline.length;
  const r = await s.pair.reducer()!.close(PANIC);
  assert.equal(r.status, 'closed', r.notes.join('; '));
  assert.deepEqual(positions(d), {});
  assert.deepEqual(d.timeline.slice(before).sort(), ['hyperliquid SOL ioc BUY reduce-only', 'orderly PERP_SOL_USDC ioc SELL reduce-only']);
  await ticks();
  p = s.book.summary().positions[0]!;
  assert.equal(p.open, false, JSON.stringify(p));
  // Its Orderly exit fee from the session's push (the close's fill had none), once the session was heard past it.
  d.now += 5 * 60_000;
  d.fills.heard(d.now + ORDERLY_LATE_PUSH_MS);
  await s.book.sync();
  p = s.book.summary().positions[0]!;
  near(p.legs.find((l) => l.venue === 'orderly')!.exitFeeUsd, -12 * FEE.orderly, 'orderly exit fee');
  near(p.legs.find((l) => l.venue === 'hyperliquid')!.exitFeeUsd, -12 * FEE.hyperliquid, 'hyperliquid exit fee');
  assert.equal(p.unknownFees, 0);
  s.stop();
});

test('GIMBAL_ORDERLY_PAIRS=1, Orderly + Phoenix: the window passes the gate and opens with two IOCs (no Hyperliquid maker leg), held, then panic_close closes both', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  d.windows = [win('eth-phoenix-orderly')];
  const s = await serve(d);
  assert.deepEqual(s.pair.hands!.pairSymbols!('phoenix', 'orderly'), ['SOL', 'ETH']);
  assert.equal(await hourly(d, s.loop, () => s.loop.held !== null), 3, JSON.stringify(decisions(d).map((x) => x.reason)));
  assert.deepEqual(d.timeline.sort(), ['orderly PERP_ETH_USDC ioc SELL', 'phoenix ETH ioc BUY']);
  assert.deepEqual(positions(d), { 'orderly:PERP_ETH_USDC': -12, 'phoenix:ETH': 12 });
  assert.deepEqual([s.loop.held?.long, s.loop.held?.short], ['phoenix', 'orderly']);
  assert.match(journal(d).find((j) => j.kind === 'enter')!.summary, /^enter eth-phoenix-orderly, ETH short orderly, long phoenix, at most 12 ETH/);
  await hourly(d, s.loop, () => false, 1);
  assert.equal(decisions(d).at(-1)!.action, 'hold');
  // Booked: the short Orderly leg receives its 16:00 payment (its 8 h period); its open fee from the session's push.
  d.fundingRows = [feeRow('PERP_ETH_USDC', T0 + 4 * HOUR, 0.004, 'Receive')];
  d.now = T0 + 5 * HOUR + 5 * 60_000;
  d.fills.heard(d.now + ORDERLY_LATE_PUSH_MS);
  await s.book.sync();
  let p = s.book.summary().positions[0]!;
  assert.deepEqual(p.legs.map((l) => `${l.venue} ${l.side}`).sort(), ['orderly short', 'phoenix long']);
  const ox = () => p.legs.find((l) => l.venue === 'orderly')!;
  near(ox().entryFeeUsd, -12 * FEE.orderly, 'orderly open fee');
  near(p.legs.find((l) => l.venue === 'phoenix')!.entryFeeUsd, -12 * FEE.phoenix, 'phoenix open fee');
  near(ox().fundingUsd, 0.004, 'orderly funding');
  const r = await s.pair.reducer()!.close(PANIC);
  assert.equal(r.status, 'closed', r.notes.join('; '));
  assert.deepEqual(positions(d), {});
  await ticks();
  d.now += 5 * 60_000;
  d.fills.heard(d.now + ORDERLY_LATE_PUSH_MS);
  await s.book.sync();
  p = s.book.summary().positions[0]!;
  assert.equal(p.open, false);
  near(ox().exitFeeUsd, -12 * FEE.orderly, 'orderly exit fee');
  assert.equal(p.unknownFees, 0);
  s.stop();
});

test('GIMBAL_ORDERLY_PAIRS=1: a session not live by the start\'s wait leaves the pair alert only (Orderly read down), and the next start attempt once it is live trades', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  d.session.upAfterMs = null;
  d.session.waitMs = 20;
  const s = await serve(d);
  assert.ok(d.lines.includes('orderly: the Orderly session is not live after 0.02 s (opening)'), d.lines.join('\n'));
  assert.match(s.pair.unconfirmed?.() ?? '', /^legs unknown, start not confirmed: orderly: orderly account unknown: the private session is opening/);
  d.session.state = 'live';
  assert.match(await s.pair.retryStart!() ?? '', /pair start confirmed after 1 failed attempt/);
  assert.equal(s.pair.unconfirmed?.() ?? null, null);
  await enter(d, s, 'sol-orderly-hyperliquid');
  assert.deepEqual(positions(d), { 'hyperliquid:SOL': -12, 'orderly:PERP_SOL_USDC': 12 });
  s.stop();
});

test('GIMBAL_ORDERLY_PAIRS=1: a rotate out of a pair with an Orderly leg is refused before anything is closed (its close would arm the replay watch and leave the desk flat)', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  const s = await serve(d);
  await enter(d, s, 'sol-orderly-hyperliquid');
  const sent = d.timeline.length;
  d.windows = [win('sol-orderly-hyperliquid'), win('eth-phoenix-orderly', { netAprPct: 40 })];
  await hourly(d, s.loop, () => false, 1);                  // the target's lots are read at a check
  assert.equal(d.timeline.length, sent, 'one hour above is no rotation');
  assert.deepEqual(s.loop.rotate('eth-phoenix-orderly'), { ok: true });
  await s.loop.idle(2_000);
  assert.equal(d.timeline.length, sent, `nothing sent: ${d.timeline.slice(sent).join(', ')}`);
  assert.deepEqual(positions(d), { 'hyperliquid:SOL': -12, 'orderly:PERP_SOL_USDC': 12 });
  assert.equal(s.loop.held?.windowId, 'sol-orderly-hyperliquid');
  const refused = journal(d).filter((j) => j.kind === 'refused' && j.summary.startsWith('rotate sol-orderly-hyperliquid -> eth-phoenix-orderly'));
  assert.equal(refused.length, 1, JSON.stringify(journal(d).map((j) => j.summary)));
  assert.match(refused[0]!.summary, /not carried out: the held SOL pair has an Orderly leg \(PERP_SOL_USDC\): its close arms the trader's replay watch \(Orderly takes a signed copy of an order for up to 300 s\), so no other pair could open after it and the rotate would leave the desk flat; sol-orderly-hyperliquid is kept, nothing closed/);
  s.stop();
});

test('GIMBAL_ORDERLY_PAIRS=1: the Orderly leg\'s replay watch is saved with the trader and watched again after a restart inside its 300 s; a pair on other legs waits it out', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  let s = await serve(d);
  await enter(d, s, 'sol-orderly-hyperliquid');
  const openedAt = d.now;
  // The loop's exit (panic_close's sweep would sleep its own watch through the window here, the clock moving with it).
  const r = await s.pair.hands!.close({ reason: 'strategy: exit' });
  assert.equal(r.ok, true, r.reason);
  s.stop();
  await ticks();
  const file = traderStateFile(d.dir, 'mainnet', { contractId: CONTRACT, deskId: DESK, evm: EVM });
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { trader: { replay?: { index: number; until: number }[] } };
  assert.equal(saved.trader.replay?.length, 1);
  assert.equal(saved.trader.replay![0]!.index, 1);
  assert.ok(saved.trader.replay![0]!.until >= openedAt + 299_000, JSON.stringify(saved.trader.replay));

  // A restart inside the window: the restored trader watches the Orderly leg; a pair on other legs is not built yet.
  d.now += 60_000;
  s = await serve(d);
  const leg = s.pair.pair!.trader.legs.find((l) => l.venue === 'orderly')!;
  assert.equal(s.pair.pair!.trader.watching(leg), true, s.pair.lines.join('\n'));
  assert.ok(d.lines.some((l) => /PERP_SOL_USDC: a signed order from before the restart can still be replayed: watched until/.test(l)));
  const other = await s.pair.hands!.open({ symbol: 'ETH', long: 'phoenix', short: 'orderly', legUsd: 12, leverage: 1.5, reason: 'test' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /the SOL pair is not settled: a signed orderly PERP_SOL_USDC order can still be replayed/);
  // The same pair again is not held back: its trader keeps watching.
  const same = await s.pair.hands!.open({ symbol: 'SOL', long: 'orderly', short: 'hyperliquid', legUsd: 12, leverage: 1.5, reason: 'test' });
  assert.equal(same.ok, true, same.reason);
  await s.pair.hands!.close({ reason: 'test' });
  s.stop();
  await ticks();
  // Past the window: nothing saved, nothing watched.
  d.now += REPLAY_WINDOW_MS + 60_000;
  s = await serve(d);
  s.stop();
  await ticks();
  const later = JSON.parse(readFileSync(file, 'utf8')) as { trader: Record<string, unknown> };
  assert.equal('replay' in later.trader, false);
});

test('GIMBAL_ORDERLY_PAIRS=1: the Hyperliquid maker leg fills and the Orderly IOC is refused or fills partly: the legs are taken back flat, nothing held', async () => {
  const refusals = (n: number): 'refuse'[] => Array.from({ length: n }, () => 'refuse' as const);
  for (const [name, plan] of [['refused', refusals(20)], ['partly', [toQty('6'), ...refusals(2)]]] as const) {
    const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
    const s = await serve(d);
    legOf(d, 'orderly', 'PERP_SOL_USDC').next = [...plan];
    d.windows = [win('sol-orderly-hyperliquid')];
    await hourly(d, s.loop, () => d.timeline.length > 0);
    const said = `${name}: ${JSON.stringify(positions(d))}; ${d.timeline.join(', ')}; held ${JSON.stringify(s.loop.held)}`;
    assert.ok(d.timeline[0] === 'hyperliquid SOL maker SELL' && d.timeline[1]!.startsWith('orderly PERP_SOL_USDC ioc BUY'), said);
    // The open's legging guard took both legs back to where they started, reduce-only: flat, nothing held.
    assert.deepEqual(positions(d), {}, said);
    assert.equal(s.loop.held, null, said);
    assert.ok(d.timeline.includes('hyperliquid SOL ioc BUY reduce-only'), said);
    if (name === 'partly') assert.equal(d.timeline.at(-1), 'orderly PERP_SOL_USDC ioc SELL reduce-only', said);
    assert.ok(!journal(d).some((j) => j.kind === 'enter'), 'no enter journaled');
    s.stop();
    await ticks();
  }
});

test('GIMBAL_ORDERLY_PAIRS=1: a window Orderly has too little margin for is refused in plain words, never entered, journaled once', async () => {
  const d = desk({ GIMBAL_ORDERLY_PAIRS: '1' });
  d.windows = [win('sol-orderly-hyperliquid')];
  d.margin.orderly = 5;
  const s = await serve(d);
  await hourly(d, s.loop, () => false, 6);
  assert.deepEqual(d.timeline, [], 'nothing sent');
  assert.equal(s.loop.held, null);
  const why = /\$5\.00 free margin on Orderly at 1\.5x opens \$7\.50 a leg in whole lots, under the \$10\.00 minimum: the loop does not move margin to open/;
  assert.match(decisions(d).at(-1)!.reason, why);
  assert.equal(journal(d).filter((j) => why.test(j.summary)).length, 1, JSON.stringify(journal(d).map((j) => j.summary)));
  s.stop();
});

test('without GIMBAL_ORDERLY_PAIRS: the HL / Phoenix desk decides, opens and writes as before; Orderly windows are refused with the old text', async () => {
  const d = desk({});
  d.windows = [win('sol-orderly-hyperliquid', { netAprPct: 30 }), win('sol-phoenix-hyperliquid')];
  const s = await serve(d, { orderly: false });
  const hands = s.pair.hands!;
  assert.equal(hands.pairSymbols, undefined);
  assert.equal(hands.heldPair, undefined);
  assert.deepEqual(windowSymbol(d.windows[0]!, hands.symbols), {
    refused: 'serve opens short hyperliquid, long phoenix only (as pair-mainnet open); sol-orderly-hyperliquid is long orderly, short hyperliquid',
  });
  assert.equal(await hourly(d, s.loop, () => s.loop.held !== null), 3, JSON.stringify(decisions(d).map((x) => x.reason)));
  // The maker leg first (Hyperliquid), then Phoenix's IOC, as before.
  assert.deepEqual(d.timeline, ['hyperliquid SOL maker SELL', 'phoenix SOL ioc BUY']);
  assert.match(journal(d).find((j) => j.kind === 'enter')!.summary, /^enter sol-phoenix-hyperliquid, SOL short hyperliquid, long phoenix, at most 12 SOL \(12 USD\) a leg at 1\.5x, 15 % net/);
  // The loop's state and the held pair name no legs (the files as before).
  const saved = JSON.parse(readFileSync(loopFile(d), 'utf8')) as { held: Record<string, unknown> };
  assert.deepEqual(Object.keys(saved.held).sort(), ['entryNetAprPct', 'legUsd', 'since', 'symbol', 'windowId']);
  assert.equal('long' in s.loop.held!, false);
  assert.ok(!d.lines.some((l) => /orderly/i.test(l)), d.lines.filter((l) => /orderly/i.test(l)).join('\n'));
  const trader = JSON.parse(readFileSync(traderStateFile(d.dir, 'mainnet', { contractId: CONTRACT, deskId: DESK, evm: EVM }), 'utf8')) as { version: number; trader: Record<string, unknown> };
  assert.equal(trader.version, 1);
  assert.deepEqual(Object.keys(trader.trader).sort(), ['baselines', 'intents', 'known', 'net', 'unhedged', 'unsettled']);
  s.stop();
});
