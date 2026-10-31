// Development only: the Desk screen's fake data, shaped exactly like the shared types. The numbers follow
// design/screens/shared/data.js (the mockup's DOGE desk) and are made up. Every status the line can show has a
// scenario (`?desk=`, listed with their meaning in source.ts). The short leg is 32.6% from liquidation in `level`,
// 12.4% in `watch`, 7.6% in `rescuing` and 6.8% in `needs`.
import type { DeskState, JournalEntry, Leg, Mode } from '@gimbal/shared';
import type { DeskScenario } from './source.ts';
import type { Health } from './store.ts';

export interface DeskOptions {
  mode: Mode;
  scenario: DeskScenario;
  /** A slow wobble in the marks and funding that grows with the tick; off for a still picture. */
  drift: boolean;
}

const SIZE = 6040;
const SHORT = { entry: 0.19861, liq: 0.26314, margin: 482.1, ratio: 0.31, funding: 0.31, mark: 0.19842 };
const LONG = { entry: 0.19873, liq: 0.13512, margin: 476.5, ratio: 0.33, funding: 1.05, unsettled: 0.011, mark: 0.19846 };
const RESERVE = 40.81;
const FEES = -1.47;
const IDLE_VALUE = 1050;
const HOUR = 3_600_000;

/** How far the short leg is from liquidation, in %, where the scenario moves the price (null: the mockup's marks). */
const SHORT_DISTANCE: Partial<Record<DeskScenario, number>> = { watch: 12.4, rescuing: 7.6, needs: 6.8 };

export function fakeDesk(now: number, tick: number, options: DeskOptions): DeskState {
  const { scenario } = options;
  const wobble = options.drift ? Math.sin(tick / 7) * 0.0004 : 0;
  const owner = 'demo-owner.testnet';
  const base = { deskId: 'desk-07', owner, contract: 'gimbal-demo.testnet', mode: options.mode, updatedAt: now };

  if (scenario === 'waiting' || scenario === 'loading') {
    return {
      ...base,
      legs: [],
      netDelta: 0,
      equityUsd: IDLE_VALUE,
      reserveUsd: RESERVE,
      pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 },
      health: 'level',
      paused: null,
      rescueFailure: null,
    };
  }

  const distance = SHORT_DISTANCE[scenario];
  const shortMark = round((distance === undefined ? SHORT.mark : SHORT.liq / (1 + distance / 100)) * (1 + wobble), 5);
  const longMark = round(shortMark + (LONG.mark - SHORT.mark), 5);
  const grown = options.drift ? 0.0004 * tick : 0;
  const longSize = scenario === 'unbalanced' ? SIZE + 120 : SIZE;

  // An open leg's margin is its collateral plus what the price has done to it since the mockup's marks.
  const shortUpnl = -(shortMark - SHORT.entry) * SIZE;
  const longUpnl = (longMark - LONG.entry) * longSize;
  const shortUpnl0 = -(SHORT.mark - SHORT.entry) * SIZE;
  const longUpnl0 = (LONG.mark - LONG.entry) * SIZE;
  const short = leg('hyperliquid', 'short', SIZE, SHORT.entry, shortMark, SHORT.liq, SHORT.margin + shortUpnl - shortUpnl0, SHORT.ratio, SHORT.funding + grown, 0, false);
  const long = leg('phoenix', 'long', longSize, LONG.entry, longMark, LONG.liq, LONG.margin + longUpnl - longUpnl0, LONG.ratio, LONG.funding + grown, LONG.unsettled, scenario === 'unpriced');

  const fundingUsd = round(short.fundingEarnedUsd + long.fundingEarnedUsd, 2);
  const priceUsd = round(shortUpnl + longUpnl, 2);
  return {
    ...base,
    legs: [short, long],
    netDelta: longSize - SIZE,
    equityUsd: round(short.marginUsd + long.marginUsd + RESERVE, 2),
    reserveUsd: RESERVE,
    pnl: { fundingUsd, feesUsd: FEES, priceUsd, netUsd: round(fundingUsd + FEES + priceUsd, 2) },
    health: scenario === 'watch' ? 'watch' : scenario === 'rescuing' || scenario === 'needs' ? 'rescue' : 'level',
    paused: scenario === 'paused' ? { by: owner, at: now - 3 * HOUR } : null,
    rescueFailure:
      scenario === 'needs'
        ? {
            rescueId: 'rescue-demo-1',
            step: 'quote',
            reason: 'The 1Click quote expired twice before it could be signed',
            tries: 3,
            next: 'Only you can act now: add margin to Hyperliquid or close both legs',
            at: now - 60_000,
          }
        : null,
  };
}

function leg(
  venue: Leg['venue'],
  side: Leg['side'],
  size: number,
  entry: number,
  mark: number,
  liqPx: number,
  marginUsd: number,
  ratioAtBase: number,
  fundingEarnedUsd: number,
  unsettledFundingUsd: number,
  unpriced: boolean,
): Leg {
  const distance = side === 'short' ? (liqPx - mark) / mark : (mark - liqPx) / mark;
  const baseMargin = side === 'short' ? SHORT.margin : LONG.margin;
  return {
    venue,
    symbol: 'DOGE',
    side,
    size,
    entry,
    mark,
    liqPx,
    marginUsd: round(marginUsd, 2),
    marginRatio: round(ratioAtBase * (marginUsd / baseMargin), 3),
    distanceToLiqPct: round(distance * 100, 1),
    fundingEarnedUsd: round(fundingEarnedUsd, 3),
    unsettledFundingUsd,
    feesUsd: side === 'short' ? -0.48 : -0.99,
    lotSize: 1,
    unpriced,
  };
}

/** The engine's health event for a scenario: only `down` has a venue that does not answer. */
export function fakeDeskHealth(tick: number, scenario: DeskScenario): Health {
  return {
    hyperliquid: scenario === 'down' ? 'down' : 'ok',
    phoenix: tick % 30 === 15 ? 'slow' : 'ok',
    orderly: 'ok',
    intents: 'ok',
    near: 'ok',
  };
}

/** The three entries the Desk's "Latest" shows in the mockup: funding paid, the open, and an unprotected rotation. */
export function fakeLatest(now: number, scenario: DeskScenario): JournalEntry[] {
  if (scenario === 'waiting' || scenario === 'loading') return [];
  const funded = Math.floor(now / HOUR) * HOUR;
  const opened = now - ((2 * 24 + 14) * HOUR + 21 * 60_000); // 2 d 14 h 21 min ago: 24 Oct 23:41 at the mockup's 27 Oct 14:02
  return [
    {
      id: 'fake-latest-funding',
      t: funded,
      kind: 'funding',
      summary: 'Funding paid · Phoenix +$0.026 · Hyperliquid +$0.004',
      numbers: { usd: 0.03, symbol: 'DOGE' },
      tx: [{ chain: 'near', id: 'fake-funding', url: 'https://explorer.invalid/tx/fake-funding' }],
    },
    {
      id: 'fake-latest-open',
      t: opened,
      kind: 'enter',
      summary: 'Opened DOGE · both legs filled 1.2 s apart',
      numbers: { symbol: 'DOGE' },
      tx: [
        { chain: 'hyperliquid', id: 'fake-open-hl', url: 'https://explorer.invalid/tx/fake-open-hl' },
        { chain: 'solana', id: 'fake-open-sol', url: 'https://explorer.invalid/tx/fake-open-sol' },
      ],
    },
    {
      id: 'fake-latest-rotate',
      t: opened - 2 * 60_000,
      kind: 'rotate',
      summary: 'Closed LTC to rotate',
      why: 'DOGE paid more after costs, and the switch earns its cost back in about a day.',
      numbers: { symbol: 'LTC', unpriced: 1, venue: 'phoenix' },
      tx: [],
    },
  ];
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
