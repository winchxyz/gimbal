// Development only: a stream of StreamEvent-shaped events so the shell can run without an engine.
// Every value here is made up; the UI labels this source "Fake stream". Each event goes through
// JSON and the same parser as the SSE client, so it exercises the real path into the store.
import type {
  DeskState,
  JournalEntry,
  Leg,
  Mode,
  SetupProgress,
  StreamEvent,
  Window as FundingWindow,
} from '@gimbal/shared';
import { parseStreamEvent, type Health, type StreamAction } from './store.ts';

export interface FakeOptions {
  mode: Mode;
  intervalMs?: number;
}

export function startFakeStream(dispatch: (action: StreamAction) => void, options: FakeOptions): () => void {
  const intervalMs = options.intervalMs ?? 800;
  let tick = 0;

  const send = (event: StreamEvent) => {
    const parsed = parseStreamEvent(JSON.stringify(event));
    dispatch(parsed ? { kind: 'event', event: parsed, at: Date.now() } : { kind: 'rejected', at: Date.now() });
  };

  const step = () => {
    const now = Date.now();
    if (tick === 0) send({ type: 'setup', data: fakeSetup() });
    if (tick % 3 === 0) send({ type: 'health', data: fakeHealth(tick) });
    if (tick % 4 === 0) send({ type: 'windows', data: fakeWindows(now, tick) });
    if (tick % 6 === 5) send({ type: 'journal', data: fakeFunding(now, tick) });
    send({ type: 'desk', data: fakeDesk(options.mode, now, tick) });
    tick += 1;
  };

  dispatch({ kind: 'connection', source: 'fake', connection: 'open' });
  step();
  const timer = setInterval(step, intervalMs);
  return () => {
    clearInterval(timer);
    dispatch({ kind: 'connection', source: 'fake', connection: 'idle' });
  };
}

const ENTRY = 0.2;
const SIZE = 6000;

function fakeDesk(mode: Mode, now: number, tick: number): DeskState {
  // A slow swing of ±20% takes the short leg inside the 15% warning line for part of each cycle.
  const mark = ENTRY * (1 + 0.2 * Math.sin(tick / 20)) * (1 + (Math.random() - 0.5) * 0.002);
  const short = fakeLeg('hyperliquid', 'short', mark, ENTRY * 1.33, tick);
  const long = fakeLeg('phoenix', 'long', mark, ENTRY * 0.68, tick);
  const nearest = Math.min(short.distanceToLiqPct ?? Infinity, long.distanceToLiqPct ?? Infinity);
  const fundingUsd = short.fundingEarnedUsd + long.fundingEarnedUsd;
  const feesUsd = -1.47;
  return {
    deskId: 'fake-desk',
    owner: 'fake-owner.testnet',
    contract: 'gimbal-fake.testnet',
    mode,
    legs: [short, long],
    netDelta: 0,
    equityUsd: round(958.6 + fundingUsd + feesUsd, 2),
    reserveUsd: 40,
    pnl: { fundingUsd, feesUsd, priceUsd: 0, netUsd: round(fundingUsd + feesUsd, 2) },
    health: nearest < 15 ? 'watch' : 'level',
    paused: null,
    rescueFailure: null,
    updatedAt: now,
  };
}

function fakeLeg(venue: Leg['venue'], side: Leg['side'], mark: number, liqPx: number, tick: number): Leg {
  const distance = side === 'short' ? (liqPx - mark) / mark : (mark - liqPx) / mark;
  return {
    venue,
    symbol: 'DOGE',
    side,
    size: SIZE,
    entry: ENTRY,
    mark: round(mark, 5),
    liqPx: round(liqPx, 5),
    marginUsd: 480,
    marginRatio: round(0.32 + (side === 'short' ? 1 : -1) * (mark - ENTRY), 3),
    distanceToLiqPct: round(distance * 100, 1),
    fundingEarnedUsd: round(0.002 * tick, 3),
    unsettledFundingUsd: venue === 'phoenix' ? round(0.001 * (tick % 50), 3) : 0,
    unpriced: false,
  };
}

function fakeWindows(now: number, tick: number): FundingWindow[] {
  const rows: [string, string, string, number][] = [
    ['DOGE', 'phoenix', 'hyperliquid', 13.8],
    ['SOL', 'phoenix', 'orderly', 8.6],
    ['AVAX', 'orderly', 'hyperliquid', 6.1],
    ['LTC', 'hyperliquid', 'phoenix', 4.2],
  ];
  return rows.map(([symbol, longVenue, shortVenue, base], i) => {
    const netAprPct = round(base + 1.5 * Math.sin((tick + i * 7) / 9), 1);
    const costs = { feesPct: 1.9, slippagePct: 0.4, basisPct: 0.3, rescueReservePct: 0.5 };
    const grossAprPct = round(netAprPct + costs.feesPct + costs.slippagePct + costs.basisPct + costs.rescueReservePct, 1);
    return {
      id: `fake-${symbol.toLowerCase()}`,
      symbol,
      longVenue,
      shortVenue,
      grossAprPct,
      grossApr7dPct: round(grossAprPct - 0.8, 1),
      costs,
      netAprPct,
      usdPerDayPer1k: round((netAprPct / 100 / 365) * 1000, 2),
      breakevenHours: round(30 - netAprPct, 0),
      depthUsd: 25000 - i * 4000,
      intervalsAbove: 12 - i,
      updatedAt: now,
      tradable: true,
      held: i === 0 ? { since: now - 6 * 3_600_000 } : null,
      checks: [],
      switchCostUsd: i === 0 ? null : 1.1,
      stale: false,
    };
  });
}

function fakeFunding(now: number, tick: number): JournalEntry {
  return {
    id: `fake-funding-${tick}`,
    t: now,
    kind: 'funding',
    summary: 'Funding paid on both legs (fake stream)',
    numbers: { usd: 0.03, symbol: 'DOGE' },
    tx: [],
  };
}

function fakeHealth(tick: number): Health {
  return {
    hyperliquid: 'ok',
    phoenix: tick % 30 === 15 ? 'slow' : 'ok',
    orderly: 'ok',
    intents: 'ok',
    near: 'ok',
  };
}

function fakeSetup(): SetupProgress {
  const steps: SetupProgress['steps'][number]['step'][] = [
    'hl_set_referrer',
    'hl_approve_builder_fee',
    'orderly_register',
    'orderly_add_key',
    'orderly_receiver_lookup',
    'orderly_referral_bind',
    'phoenix_login',
    'phoenix_invite',
    'phoenix_register',
  ];
  return { deskId: 'fake-desk', steps: steps.map((step) => ({ step, status: 'done', tx: [] })) };
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
