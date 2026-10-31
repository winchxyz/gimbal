// The fake must show every state the status line and the Desk screen have, shaped like the shared types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@gimbal/shared';
import { actionsOf, downVenues, statusOf } from '../shell/status.ts';
import { exposureOf, latestEvents, paybackOf, placeLegs } from '../desk/model.ts';
import { fakeDesk, fakeDeskHealth, fakeLatest } from './fake-desk.ts';
import { startFakeStream } from './fake.ts';
import { DESK_SCENARIOS, deskFor, pickFakeDesk, type DeskScenario } from './source.ts';
import { initialStreamState, parseStreamEvent, reduceStream, type StreamAction } from './store.ts';

const T0 = Date.UTC(2026, 9, 27, 14, 2);
const make = (scenario: DeskScenario, tick = 0, drift = false) => fakeDesk(T0, tick, { mode: 'mainnet', scenario, drift });

/** What the status line says for a scenario, with the health the fake sends next to it. */
const word = (scenario: DeskScenario) => {
  const desk = make(scenario);
  return statusOf(desk, { down: downVenues(desk, fakeDeskHealth(0, scenario)) }).word;
};

test('every status has a scenario: level, watch, rescuing, needs you, waiting, paused, and a venue down', () => {
  assert.equal(word('level'), 'Level');
  assert.equal(word('watch'), 'Watch');
  assert.equal(word('rescuing'), 'Rescuing');
  assert.equal(word('needs'), 'Needs you');
  assert.equal(word('waiting'), 'Waiting');
  assert.equal(word('paused'), 'Paused');
  assert.equal(word('down'), 'Hyperliquid not answering');
  // the others keep the desk running
  assert.equal(word('unpriced'), 'Level');
  assert.equal(word('unbalanced'), 'Level');
});

test('level is the mockup’s desk: DOGE, short on Hyperliquid and long on Phoenix, $999.41 in all', () => {
  const desk = make('level');
  const { left, right } = placeLegs(desk.legs);
  assert.equal(left?.venue, 'hyperliquid');
  assert.equal(right?.venue, 'phoenix');
  assert.equal(left?.distanceToLiqPct, 32.6);
  assert.equal(right?.distanceToLiqPct, 31.9);
  assert.equal(desk.equityUsd, 999.41);
  assert.equal(desk.reserveUsd, 40.81);
  assert.deepEqual(desk.pnl, { fundingUsd: 1.36, feesUsd: -1.47, priceUsd: -0.48, netUsd: -0.59 });
  assert.equal(paybackOf(desk.pnl, 0.6).pct, 70);
  assert.equal(exposureOf(desk).drift, false);
  assert.equal(statusOf(desk).sentence, 'Both legs are safe. Funding is coming in on both sides.');
});

test('the price scenarios put the short leg where the status line expects it', () => {
  assert.equal(make('watch').legs[0]?.distanceToLiqPct, 12.4);
  assert.equal(make('watch').health, 'watch');
  assert.equal(make('rescuing').legs[0]?.distanceToLiqPct, 7.6);
  assert.equal(make('rescuing').health, 'rescue');
  assert.equal(make('needs').legs[0]?.distanceToLiqPct, 6.8);
  assert.equal(make('needs').rescueFailure?.tries, 3);
  assert.equal(statusOf(make('needs')).sentence, 'The rescue could not finish. The Hyperliquid short is now 6.8% from liquidation.');
  // the desk value is the same money whatever the price did to each leg
  for (const s of ['watch', 'rescuing', 'needs'] as const) assert.ok(Math.abs(make(s).equityUsd - 999.41) < 1.5, s);
});

test('paused, unpriced, unbalanced and waiting each set only what they are about', () => {
  const paused = make('paused');
  assert.equal(paused.paused?.by, paused.owner);
  assert.equal(paused.paused?.at, T0 - 3 * 3_600_000);
  assert.equal(make('level').paused, null);
  assert.deepEqual(make('unpriced').legs.map((l) => l.unpriced), [false, true]);
  assert.deepEqual(make('level').legs.map((l) => l.unpriced), [false, false]);
  const unbalanced = make('unbalanced');
  assert.equal(unbalanced.netDelta, 120);
  assert.equal(exposureOf(unbalanced).drift, true);
  const waiting = make('waiting');
  assert.deepEqual(waiting.legs, []);
  assert.equal(waiting.equityUsd, 1050);
  assert.equal(statusOf(waiting).tone, 'waiting');
});

test('down: the health event names Hyperliquid, and nothing else is down', () => {
  assert.equal(fakeDeskHealth(0, 'down').hyperliquid, 'down');
  assert.equal(fakeDeskHealth(0, 'level').hyperliquid, 'ok');
  assert.deepEqual(downVenues(make('down'), fakeDeskHealth(0, 'down')), ['hyperliquid']);
  const buttons = actionsOf(statusOf(make('down'), { down: ['hyperliquid'] }), { auto: true, screen: 'desk', mode: 'mainnet' }).buttons;
  assert.deepEqual(buttons.map((b) => b.label), ['Close both legs']);
});

test('drift moves the marks and the funding; off keeps the picture still', () => {
  assert.deepEqual(make('level', 0, false), make('level', 40, false));
  const a = make('level', 0, true);
  const b = make('level', 40, true);
  assert.notDeepEqual(a.legs.map((l) => l.mark), b.legs.map((l) => l.mark));
  assert.ok(b.pnl.fundingUsd > a.pnl.fundingUsd);
});

test('the mockup’s three latest events: funding paid, the open, and an unprotected rotation', () => {
  const rows = latestEvents(fakeLatest(T0, 'level').sort((x, y) => y.t - x.t), T0);
  assert.deepEqual(rows.map((r) => r.when), ['Today 14:00', '24 Oct 23:41', '24 Oct 23:39']);
  assert.equal(rows[2]?.unprotected, 'Phoenix leg sent without price protection');
  assert.equal(rows[1]?.proof?.label, '2 transactions ↗');
  assert.deepEqual(fakeLatest(T0, 'waiting'), []);
});

test('every event goes through the same parser as the engine stream', () => {
  for (const scenario of DESK_SCENARIOS) {
    const events: StreamEvent[] = [
      { type: 'desk', data: make(scenario) },
      { type: 'health', data: fakeDeskHealth(0, scenario) },
      ...fakeLatest(T0, scenario).map((data): StreamEvent => ({ type: 'journal', data })),
    ];
    for (const e of events) assert.ok(parseStreamEvent(JSON.stringify(e)), `${scenario} ${e.type}`);
  }
});

test('?desk= picks the scenario; without it the desk follows ?state=', () => {
  assert.equal(pickFakeDesk('', 'normal'), 'level');
  assert.equal(pickFakeDesk('?desk=needs', 'normal'), 'needs');
  assert.equal(pickFakeDesk('?desk=paused&net=replay', 'empty'), 'paused');
  assert.equal(pickFakeDesk('?desk=other', 'normal'), 'level');
  assert.equal(pickFakeDesk('?state=loading', 'loading'), 'loading');
  assert.equal(pickFakeDesk('?state=empty', 'empty'), 'waiting');
  assert.equal(pickFakeDesk('?state=error', 'error'), 'down');
  assert.equal(deskFor('normal'), 'level');
  for (const s of DESK_SCENARIOS) assert.equal(pickFakeDesk(`?desk=${s}`, 'normal'), s);
});

test('the fake stream sends the desk, its health and the latest events; loading sends no desk', () => {
  const run = (desk: DeskScenario) => {
    const actions: StreamAction[] = [];
    startFakeStream((a) => actions.push(a), { mode: 'testnet', intervalMs: 60_000, desk, drift: false })();
    return actions.reduce(reduceStream, initialStreamState());
  };
  const level = run('level');
  assert.equal(level.desk?.legs.length, 2);
  assert.equal(level.journal.length, 3);
  assert.equal(level.health?.hyperliquid, 'ok');
  assert.equal(run('down').health?.hyperliquid, 'down');
  assert.equal(run('paused').desk?.paused !== null, true);
  assert.equal(run('needs').desk?.rescueFailure?.step, 'quote');
  const waiting = run('waiting');
  assert.deepEqual(waiting.desk?.legs, []);
  assert.deepEqual(waiting.journal, []);
  assert.equal(waiting.windows?.some((w) => w.held), false, 'a desk with no position has no held window');
  const loading = run('loading');
  assert.equal(loading.desk, null);
  assert.equal(loading.counts.desk, 0);
});

test('the default fake desk is the level one, and ?state= still reaches the desk through the stream', () => {
  const actions: StreamAction[] = [];
  startFakeStream((a) => actions.push(a), { mode: 'testnet', intervalMs: 60_000, scenario: 'empty' })();
  const s = actions.reduce(reduceStream, initialStreamState());
  assert.deepEqual(s.desk?.legs, []);
});
