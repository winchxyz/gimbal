// The status line's states and their order: docs/interfaces.md §2, next to `RescueFailure`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskState, Leg, RescueFailure } from '@gimbal/shared';
import { actionsOf, downVenues, statusOf, type StatusView } from './status.ts';

const leg = (venue: Leg['venue'], side: Leg['side'], distanceToLiqPct: number | null, overrides: Partial<Leg> = {}): Leg => ({
  venue,
  symbol: 'DOGE',
  side,
  size: 6040,
  entry: 0.2,
  mark: 0.2,
  liqPx: 0.26,
  marginUsd: 480,
  marginRatio: 0.31,
  distanceToLiqPct,
  fundingEarnedUsd: 0,
  unsettledFundingUsd: 0,
  feesUsd: 0,
  lotSize: 1,
  unpriced: false,
  ...overrides,
});

const FAILURE: RescueFailure = {
  rescueId: 'r1',
  step: 'quote',
  reason: 'The 1Click quote expired twice',
  tries: 3,
  next: 'Only you can act now',
  at: 0,
};

const OPEN = [leg('hyperliquid', 'short', 6.8), leg('phoenix', 'long', 31.9)];

const desk = (overrides: Partial<DeskState> = {}): DeskState => ({
  deskId: 'desk-07',
  owner: 'owner.near',
  contract: '(test contract)',
  mode: 'mainnet',
  legs: OPEN,
  netDelta: 0,
  equityUsd: 1000,
  reserveUsd: 40,
  pnl: { fundingUsd: 0, feesUsd: 0, priceUsd: 0, netUsd: 0 },
  health: 'level',
  paused: null,
  rescueFailure: null,
  updatedAt: 0,
  ...overrides,
});

const PAUSED = { by: 'owner.near', at: Date.UTC(2026, 9, 24, 23, 41) };

test('Needs you wins over every other state, and says what failed and what the desk tried', () => {
  const v = statusOf(desk({ rescueFailure: FAILURE, paused: PAUSED, health: 'rescue' }));
  assert.equal(v.tone, 'needs');
  assert.equal(v.word, 'Needs you');
  assert.equal(v.sentence, 'The rescue could not finish. The Hyperliquid short is now 6.8% from liquidation.');
  assert.equal(v.detail, 'The 1Click quote expired twice. Tried 3 times. Only you can act now.');
  // a single try, a leg the venue gives no distance for, and no leg at all
  assert.match(statusOf(desk({ rescueFailure: { ...FAILURE, tries: 1 } })).detail ?? '', /Tried 1 time\./);
  assert.match(statusOf(desk({ rescueFailure: FAILURE, legs: [leg('orderly', 'long', null)] })).sentence, /The Orderly long is close to liquidation\.$/);
  assert.equal(statusOf(desk({ rescueFailure: FAILURE, legs: [] })).sentence, 'The rescue could not finish.');
});

test('Paused comes next: by you, with the date, and what still works', () => {
  const v = statusOf(desk({ paused: PAUSED, health: 'rescue' }));
  assert.deepEqual(v, {
    tone: 'paused',
    word: 'Paused',
    sentence: 'Paused by you on 24 Oct 23:41 UTC. No new position opens. Rescues and closing still work.',
  });
  // paused by another account says which
  assert.match(statusOf(desk({ paused: { by: 'operator.near', at: PAUSED.at } })).sentence, /^Paused by operator\.near on /);
  // a paused desk with no position is Paused, not Waiting
  assert.equal(statusOf(desk({ paused: PAUSED, legs: [] })).tone, 'paused');
});

test('then Rescuing, Watch, Waiting and Level, in that order', () => {
  assert.equal(statusOf(desk({ health: 'rescue' })).tone, 'rescuing');
  assert.equal(statusOf(desk({ health: 'rescue', legs: [] })).sentence, 'The desk is moving margin now.');
  assert.equal(statusOf(desk({ health: 'watch' })).tone, 'watch');
  // health watch is read before "no legs": the written order is the rule
  assert.equal(statusOf(desk({ health: 'watch', legs: [] })).tone, 'watch');
  assert.equal(statusOf(desk({ health: 'watch', legs: [] })).sentence, 'A leg is close to liquidation.');
  assert.equal(statusOf(desk({ health: 'level', legs: [] })).tone, 'waiting');
  assert.equal(statusOf(desk()).tone, 'level');
});

test('Level adds that funding comes in on both sides only when both legs have earned', () => {
  const earned = [leg('hyperliquid', 'short', 30, { fundingEarnedUsd: 0.31 }), leg('phoenix', 'long', 30, { fundingEarnedUsd: 1.05 })];
  assert.equal(statusOf(desk({ legs: earned })).sentence, 'Both legs are safe. Funding is coming in on both sides.');
  const oneSide = [leg('hyperliquid', 'short', 30, { fundingEarnedUsd: 0.31 }), leg('phoenix', 'long', 30)];
  assert.equal(statusOf(desk({ legs: oneSide })).sentence, 'Both legs are safe.');
  const paying = [leg('hyperliquid', 'short', 30, { fundingEarnedUsd: 0.31 }), leg('phoenix', 'long', 30, { fundingEarnedUsd: -0.2 })];
  assert.equal(statusOf(desk({ legs: paying })).sentence, 'Both legs are safe.');
});

test('Waiting says why when it is told the minimum, the best window and Auto', () => {
  const idle = desk({ legs: [] });
  assert.equal(statusOf(idle).sentence, 'No position is open.');
  assert.equal(statusOf(idle, { minNetAprPct: 5, bestNetAprPct: 2.1 }).sentence, 'No window clears your 5% minimum right now.');
  assert.equal(statusOf(idle, { minNetAprPct: 5, bestNetAprPct: null }).sentence, 'No window clears your 5% minimum right now.');
  assert.equal(statusOf(idle, { minNetAprPct: 5.5, bestNetAprPct: 1 }).sentence, 'No window clears your 5.5% minimum right now.');
  // a window clears the minimum but nothing is open: the line does not claim otherwise
  assert.equal(statusOf(idle, { minNetAprPct: 5, bestNetAprPct: 8 }).sentence, 'No position is open.');
  assert.equal(statusOf(idle, { minNetAprPct: 5, bestNetAprPct: 2, auto: false }).sentence, 'No position is open. Auto is off, so the desk only watches.');
});

test('a venue that does not answer is a red line that names it, after Needs you and before the rest', () => {
  const v = statusOf(desk({ paused: PAUSED, health: 'watch' }), { down: ['hyperliquid'] });
  assert.equal(v.tone, 'down');
  assert.equal(v.word, 'Hyperliquid not answering');
  assert.equal(v.sentence, 'Its figures may be old. Your short is still open on the exchange and the contract still enforces your policy.');
  assert.equal(statusOf(desk({ rescueFailure: FAILURE }), { down: ['hyperliquid'] }).tone, 'needs');
  assert.equal(statusOf(desk(), { down: ['hyperliquid', 'phoenix'] }).word, 'Hyperliquid and Phoenix not answering');
  assert.match(statusOf(desk(), { down: ['hyperliquid', 'phoenix'] }).sentence, /Your short and long are still open/);
  // a venue the desk has no leg on does not matter here
  assert.equal(statusOf(desk(), { down: ['orderly'] }).tone, 'level');
});

test('downVenues lists the desk’s venues that the engine reports as down, once each', () => {
  const health = { hyperliquid: 'down', phoenix: 'slow', orderly: 'down', intents: 'ok', near: 'ok' } as const;
  assert.deepEqual(downVenues(desk(), health), ['hyperliquid']);
  assert.deepEqual(downVenues(desk({ legs: [OPEN[0]!, OPEN[0]!] }), health), ['hyperliquid']);
  assert.deepEqual(downVenues(desk(), null), []);
});

const view = (tone: StatusView['tone']): StatusView => ({ tone, word: '', sentence: '' });
const labels = (tone: StatusView['tone'], auto: boolean | null = true, screen: 'desk' | 'rescue' = 'desk', mode: DeskState['mode'] = 'mainnet') =>
  actionsOf(view(tone), { auto, screen, mode }).buttons.map((b) => b.label);

test('each state offers the actions of design/HANDOFF.md', () => {
  assert.deepEqual(labels('level'), ['Auto on', 'Pause', 'Close position']);
  assert.deepEqual(labels('watch', false), ['Auto off', 'Pause', 'Close position']);
  assert.deepEqual(labels('level', null), ['Pause', 'Close position']);
  assert.deepEqual(labels('needs'), ['Add margin', 'Close both legs']);
  assert.deepEqual(labels('down'), ['Close both legs']);
  assert.deepEqual(labels('paused'), ['Resume']);
  assert.deepEqual(labels('waiting'), []);
  assert.deepEqual(labels('rescuing'), []);
  assert.equal(actionsOf(view('rescuing'), { auto: true, screen: 'desk', mode: 'mainnet' }).note, 'No action needed from you');
});

test('Close both legs is the filled button when the owner is needed; a replay has no actions; Rescue only reports', () => {
  const needs = actionsOf(view('needs'), { auto: true, screen: 'desk', mode: 'testnet' }).buttons;
  assert.equal(needs.find((b) => b.id === 'close')?.style, 'primary');
  assert.equal(needs.find((b) => b.id === 'add-margin')?.style, 'plain');
  assert.deepEqual(labels('level', true, 'desk', 'replay'), []);
  assert.deepEqual(labels('needs', true, 'desk', 'replay'), []);
  assert.equal(actionsOf(view('rescuing'), { auto: true, screen: 'desk', mode: 'replay' }).note, null);
  assert.deepEqual(labels('level', true, 'rescue'), []);
  assert.deepEqual(labels('needs', true, 'rescue'), ['Add margin', 'Close both legs']);
});
