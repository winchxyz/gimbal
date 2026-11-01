// The watch and rescue lines: the owner's floor, the volatility term sized for the slow rescue measured on mainnet
// (one 120 s signature plus a 65 s 1Click transfer), hysteresis, and realised volatility on hand-computed marks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountState, Position } from '../venues/venue.ts';
import { legRisk } from './margin.ts';
import { HYSTERESIS_PTS, MPC_SLOW_S, ONE_CLICK_SLOW_S, RESCUE_HORIZON_S, RESCUE_Z, Volatility, healthFor, levelFor, riskLines, worst } from './thresholds.ts';

const RISK = { watchDistancePct: 15, rescueDistancePct: 8 };

function near(actual: number, expected: number, eps = 1e-9, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} != ${expected}`);
}

test('the horizon is the slow case measured on mainnet 2026-10-27: a 120 s signature plus a 65 s 1Click transfer', () => {
  assert.equal(MPC_SLOW_S, 120);
  assert.equal(ONE_CLICK_SLOW_S, 65);
  assert.equal(RESCUE_HORIZON_S, 185, 'about 3 minutes');
  assert.ok(RESCUE_HORIZON_S >= 120 + 54, 'also covers the slow signature plus the Hyperliquid → 1Click leg (54 s)');
  assert.equal(RESCUE_Z, 4);
});

test("lines: the owner's without an estimate; a calm market keeps them; a fast one lifts both, keeping the gap", () => {
  assert.deepEqual(riskLines(RISK, null), { watchPct: 15, rescuePct: 8, sigmaPerSqrtS: null, volPct: 0 });
  // ETH at 60 % a year: σ = 0.6 / √(365 × 86400) = 1.0685e-4 /√s; (exp(4 × σ × √185) − 1) × 100 = 0.5830 %.
  const calm = riskLines(RISK, 0.6 / Math.sqrt(365 * 86_400));
  near(calm.volPct, 0.5830, 1e-4);
  assert.equal(calm.rescuePct, 8);
  assert.equal(calm.watchPct, 15);
  // σ = 1.5e-3 /√s: 4 × 1.5e-3 × 13.6015 = 0.081609, exp − 1 = 8.5031 %, over the owner's 8.
  const fast = riskLines(RISK, 1.5e-3);
  near(fast.volPct, Math.expm1(0.006 * Math.sqrt(185)) * 100, 1e-12);
  near(fast.rescuePct, 8.5031, 1e-4);
  near(fast.watchPct, fast.rescuePct + 7, 1e-12);
  // σ = 3e-3 /√s: 17.7293 % rescue, 24.7293 % watch.
  const wild = riskLines(RISK, 3e-3);
  near(wild.rescuePct, 17.7293, 1e-4);
  near(wild.watchPct, 24.7293, 1e-4);
});

test("a leg that triggers at its rescue line is not liquidated by a 4σ move over the slow rescue's 185 s", () => {
  // Short 1 ETH at 2000, σ = 2e-3 /√s: the line is (exp(4 × 2e-3 × √185) − 1) × 100 = 11.4952 %.
  const sigma = 2e-3;
  const lines = riskLines(RISK, sigma);
  near(lines.rescuePct, 11.4952, 1e-4);
  const m = 0.02;
  const leg = (linePct: number) => {
    // Margin so the leg sits right at the line: e = D(1 + m) + m.
    const e = (linePct / 100) * (1 + m) + m;
    const position: Position = { symbol: 'ETH', size: -1, entryPx: 2000, liqPx: null, marginUsd: e * 2000, unrealizedPnlUsd: 0, leverage: 1 / e, fundingSinceOpenUsd: 0, unsettledFundingUsd: 0 };
    const account: AccountState = { venue: 'hyperliquid', address: '', time: 1, equityUsd: e * 2000, freeMarginUsd: 0, maintenanceMarginUsd: m * 2000, positions: [position] };
    return legRisk({ venue: 'hyperliquid', account, position, markPx: 2000 });
  };
  const atLine = leg(lines.rescuePct);
  near(atLine.distanceToLiqPct!, lines.rescuePct, 1e-9);
  assert.equal(healthFor(atLine.distanceToLiqPct! - 1e-9, lines), 'rescue', 'just under the line: the rescue starts');
  // The 4σ adverse move over the 185 s until the margin lands (up, for a short) ends at the liquidation price, not past.
  const moved = 2000 * Math.exp(RESCUE_Z * sigma * Math.sqrt(RESCUE_HORIZON_S));
  assert.ok(moved <= atLine.liqPx! * (1 + 1e-12), `${moved} vs liquidation at ${atLine.liqPx}`);
  // Sized for the quote's 30 s estimate instead, the same move goes 6.7 % past liquidation.
  const quoted = leg(Math.expm1(RESCUE_Z * sigma * Math.sqrt(30)) * 100);
  assert.ok(moved > quoted.liqPx! * 1.06, `${moved} vs ${quoted.liqPx}`);
});

test('health: rescue under its line, watch under its line, and a level is left only one point past its line', () => {
  const lines = { watchPct: 15, rescuePct: 8 };
  assert.equal(HYSTERESIS_PTS, 1);
  assert.equal(healthFor(null, lines), 'level');
  assert.equal(healthFor(20, lines), 'level');
  assert.equal(healthFor(14.9, lines), 'watch');
  assert.equal(healthFor(7.9, lines), 'rescue');
  assert.equal(healthFor(0, lines), 'rescue');
  assert.equal(healthFor(8.5, lines, 'rescue'), 'rescue', 'under 8 + 1');
  assert.equal(healthFor(9.1, lines, 'rescue'), 'watch');
  assert.equal(healthFor(15.5, lines, 'watch'), 'watch', 'under 15 + 1');
  assert.equal(healthFor(15.5, lines, 'rescue'), 'watch');
  assert.equal(healthFor(16.1, lines, 'watch'), 'level');
  assert.equal(healthFor(15.5, lines, 'level'), 'level');
  assert.equal(worst(['level', 'watch', 'level']), 'watch');
  assert.equal(worst(['watch', 'rescue']), 'rescue');
  assert.equal(worst([]), 'level');
});

test('volatility: Σ squared log returns over the time they span, nothing under 10 returns, a 30 min window', () => {
  const v = new Volatility();
  // 100, 101, 100, 101, …: every return is ±ln(1.01), one a second.
  for (let i = 0; i <= 9; i++) v.add(i * 1000, i % 2 === 0 ? 100 : 101);
  assert.equal(v.sigmaPerSqrtS(), null, '9 returns');
  v.add(10_000, 101 * 0 + 100);
  near(v.sigmaPerSqrtS()!, Math.log(1.01), 1e-12);
  // Uneven gaps weigh by their length: the same 10 returns over 40 s is half the σ.
  const slow = new Volatility();
  for (let i = 0; i <= 10; i++) slow.add(i * 4000, i % 2 === 0 ? 100 : 101);
  near(slow.sigmaPerSqrtS()!, Math.log(1.01) / 2, 1e-12);
  // A repeated timestamp or a bad price is ignored; marks older than the window drop out.
  slow.add(40_000, 999);
  slow.add(41_000, 0);
  near(slow.sigmaPerSqrtS()!, Math.log(1.01) / 2, 1e-12);
  const windowed = new Volatility({ windowMs: 10_000, minReturns: 2 });
  for (let i = 0; i <= 20; i++) windowed.add(i * 1000, i <= 10 ? (i % 2 === 0 ? 100 : 110) : 100);
  assert.equal(windowed.sigmaPerSqrtS(), 0, 'the jumpy first 10 s are out of the window');
});

test('level from a leg: margin ratio 1 or more is rescue; an unknown distance is never safe (watch at least); none is level', () => {
  const lines = { watchPct: 15, rescuePct: 8 };
  // The reviewer's case: 0.05 % from the account margin, ratio 0.98.
  assert.equal(levelFor({ distanceToLiqPct: 0.05, distanceBasis: 'account', marginRatio: 0.98 }, lines), 'rescue');
  assert.equal(levelFor({ distanceToLiqPct: null, distanceBasis: 'unknown', marginRatio: 0.2 }, lines), 'watch');
  assert.equal(levelFor({ distanceToLiqPct: null, distanceBasis: 'unknown', marginRatio: 0.2 }, lines, 'rescue'), 'rescue', 'unknown does not clear a rescue');
  assert.equal(levelFor({ distanceToLiqPct: null, distanceBasis: 'none', marginRatio: 0.02 }, lines), 'level');
  assert.equal(levelFor({ distanceToLiqPct: 50, distanceBasis: 'price', marginRatio: 1 }, lines), 'rescue');
  assert.equal(levelFor({ distanceToLiqPct: 12, distanceBasis: 'price', marginRatio: 0.3 }, lines), 'watch');
});
