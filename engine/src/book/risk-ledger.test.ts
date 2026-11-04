import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RiskActRecord, RiskCheckRecord, RiskLedgerRecord } from './risk-ledger.ts';
import {
  MAX_PRICING, PRICE_GRACE_MS, RiskLedger, holdSpan, ledgerFilesIn, ledgerForBook, loadRiskLedger, riskLedgerFile, riskLedgerSummary, roundTripUsd,
} from './risk-ledger.ts';
import { bookFile } from './store.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gimbal-risk-ledger-'));
  dirs.push(d);
  return d;
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 10, 5);

function check(over: Partial<RiskCheckRecord> = {}): RiskCheckRecord {
  const at = over.at ?? T0;
  const windowId = over.windowId ?? 'sol-phoenix-hyperliquid';
  return {
    v: 1, type: 'check', id: `${at}-${windowId}`, at, kind: 'enter', by: 'auto', windowId, symbol: 'SOL', outcome: 'refused', verdict: 'refused',
    reason: 'a spike', why: 'NEAR AI risk check refused (attested): a spike', attestation: 'attested', model: 'test-model',
    prompt: [{ role: 'system', content: 's' }, { role: 'user', content: '{}' }], reply: '{"verdict":"veto","reasons":["a spike"]}', latencyMs: 640,
    legUsd: 1000, leverage: 1.5, forecastNetAprPct: 20, roundTripCostUsd: 0.5, holdHours: 4, ...over,
  };
}

test('paths: one ledger per mode, contract and desk, next to its book', () => {
  const dir = tmp();
  assert.equal(riskLedgerFile(dir, 'mainnet', 'gimbal.near', 'desk-1'), join(dir, 'risk-checks-mainnet-gimbal.near-desk-1.jsonl'));
  assert.equal(riskLedgerFile(dir, 'replay', null, null), join(dir, 'risk-checks-replay.jsonl'));
  assert.equal(ledgerForBook(bookFile(dir, 'mainnet', 'gimbal.near', 'desk-1')), riskLedgerFile(dir, 'mainnet', 'gimbal.near', 'desk-1'));
  assert.throws(() => riskLedgerFile(dir, 'mainnet', '../x', 'd'), /cannot name a risk check ledger/);
  assert.deepEqual(ledgerFilesIn(join(dir, 'none')), []);
});

test('append and load: fsynced lines; a torn last line is dropped, a bad line is skipped and counted; the ledger reloads', () => {
  const path = riskLedgerFile(tmp(), 'testnet', null, null);
  const logs: string[] = [];
  const ledger = new RiskLedger(path, (l) => logs.push(l));
  ledger.check(check());
  ledger.check(check({ at: T0 + HOUR, verdict: 'passed', outcome: 'passed' }));
  appendFileSync(path, 'not json\n{"v":1,"type":"check"}\n{"v":1,"type":"hou');
  const { records, skipped } = loadRiskLedger(path);
  assert.deepEqual(records.map((r) => (r as RiskCheckRecord).verdict), ['refused', 'passed']);
  assert.equal(skipped, 2);
  assert.deepEqual(loadRiskLedger(join(tmp(), 'missing.jsonl')), { records: [], skipped: 0 });
  // A restart reads them back (and says what it skipped).
  const again = new RiskLedger(path, (l) => logs.push(l));
  assert.ok(logs.some((l) => /2 line\(s\) of .* are not records: skipped/.test(l)));
  again.hourly(T0 + 3 * HOUR, () => []);
});

test('the hourly pricing: a refusal\'s hours after it was asked, up to its hold, each hour once, across a restart', () => {
  const path = riskLedgerFile(tmp(), 'mainnet', null, null);
  const ledger = new RiskLedger(path, () => {});
  const c = check();
  ledger.check(c);
  ledger.check(check({ at: T0 + 1, windowId: 'eth-phoenix-hyperliquid', verdict: 'passed', outcome: 'passed' }));
  const { from, to } = holdSpan(c);
  assert.equal(from, Date.UTC(2026, 10, 3, 11));
  assert.equal(to, from + 4 * HOUR);
  const asked: [string, number, number][] = [];
  const hours = (id: string, f: number, t: number) => {
    asked.push([id, f, t]);
    const pts = [];
    for (let h = f; h < t; h += HOUR) pts.push({ t: h, grossAprPct: 10 });
    return pts;
  };
  ledger.hourly(from - 1, hours);               // before its first full hour: nothing asked
  assert.deepEqual(asked, []);
  ledger.hourly(from + 2 * HOUR + 60_000, hours);
  ledger.hourly(from + 2 * HOUR + 120_000, hours);  // the same hours again: nothing new booked
  assert.deepEqual(asked.map((a) => a[0]), ['sol-phoenix-hyperliquid', 'sol-phoenix-hyperliquid'], 'only the refusal is priced');
  const restarted = new RiskLedger(path, () => {});
  restarted.hourly(from + 10 * HOUR, hours);    // past the hold: up to its end only
  restarted.hourly(from + 11 * HOUR, hours);    // all 4 hours priced: not asked again
  assert.equal(asked.length, 3);
  const booked = loadRiskLedger(path).records.filter((r) => r.type === 'hours');
  assert.deepEqual(booked.map((r) => r.points.map((p) => (p.t - from) / HOUR)), [[0, 1, 2], [3]]);
  // A scanner that holds no history for it (null) books nothing.
  const quiet = new RiskLedger(riskLedgerFile(tmp(), 'mainnet', null, null), () => {});
  quiet.check(c);
  quiet.hourly(to, () => null);
});

test('a ledger that cannot write logs it and goes on', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'blocker'), 'a file, not a directory');
  const logs: string[] = [];
  const ledger = new RiskLedger(join(dir, 'blocker', 'risk-checks-mainnet.jsonl'), (l) => logs.push(l));
  ledger.check(check());
  assert.ok(logs.some((l) => /^risk checks: not booked in /.test(l)));
});

test('the summary: the round trip is prorated to the hours priced, and helped or hurt only once the whole hold is priced', () => {
  const lost = check({ at: T0, windowId: 'a-phoenix-hyperliquid' });
  const won = check({ at: T0 + 1, windowId: 'b-phoenix-hyperliquid' });
  const early = check({ at: T0 + 2, windowId: 'c-phoenix-hyperliquid' });
  const fresh = check({ at: T0 + 3, windowId: 'd-phoenix-hyperliquid' });
  const { from } = holdSpan(lost);
  const hrs = (c: RiskCheckRecord, g: number[]): RiskLedgerRecord => ({ v: 1, type: 'hours', at: from + 9 * HOUR, checkId: c.id, points: g.map((x, i) => ({ t: from + i * HOUR, grossAprPct: x })) });
  // a: 4 h at 8.76 % on 1000 USD = 0.04 USD of funding against the whole 0.5 USD round trip: -0.46, helped.
  // b: 4 h at 219 % = 1 USD - 0.5 = +0.5: hurt. An hour outside the hold and a repeated hour are ignored.
  // c: 1 of 4 h at 219 % = 0.25 USD less a quarter of the round trip (0.125): +0.125 so far, pending, never "helped"
  //    for want of hours (the old full-cost charge would have shown -0.25, helped).
  const extra: RiskLedgerRecord = { v: 1, type: 'hours', at: from, checkId: won.id, points: [{ t: from, grossAprPct: 99_999 }, { t: from + 50 * HOUR, grossAprPct: 99_999 }] };
  const s = riskLedgerSummary([
    lost, won, early, fresh, hrs(lost, [8.76, 8.76, 8.76, 8.76]), hrs(won, [219, 219, 219, 219]), extra, hrs(early, [219]), lost,
  ], [], 3);
  assert.equal(s.refusals.length, 4, 'a check booked twice counts once');
  const [a, b, c, d] = s.refusals;
  assert.equal(a!.call, 'helped');
  assert.equal(a!.hours, 4);
  assert.ok(Math.abs(a!.counterfactualUsd! - (0.04 - 0.5)) < 1e-9);
  assert.equal(b!.call, 'hurt');
  assert.ok(Math.abs(b!.counterfactualUsd! - 0.5) < 1e-9);
  assert.deepEqual([c!.call, c!.hours], ['pending', 1]);
  assert.ok(Math.abs(c!.counterfactualUsd! - (0.25 - 0.125)) < 1e-9);
  assert.deepEqual([d!.call, d!.hours, d!.counterfactualUsd], ['pending', 0, null]);
  assert.deepEqual([s.totals.refused, s.totals.helped, s.totals.hurt, s.totals.pending, s.skipped], [4, 1, 1, 2, 3]);
  assert.ok(Math.abs(s.totals.refusedCounterfactualUsd - 0.04) < 1e-9, 'only the fully priced ones');
  assert.ok(Math.abs(s.totals.pendingCounterfactualUsd - 0.125) < 1e-9);
});

test('one hour the scanner never held: final once the hold is over with 90 % priced, prorated; pending before', () => {
  // A 20 h hold with hour 7 never priced: 19 of 20 h (95 %) at 8.76 % gross on 1000 USD = 0.19 USD, less 19/20 of 0.5.
  const c = check({ at: T0, holdHours: 20 });
  const { from, to } = holdSpan(c);
  const pts = Array.from({ length: 20 }, (_, i) => i).filter((i) => i !== 7).map((i) => ({ t: from + i * HOUR, grossAprPct: 8.76 }));
  const records: RiskLedgerRecord[] = [c, { v: 1, type: 'hours', at: to, checkId: c.id, points: pts }];
  const during = riskLedgerSummary(records, [], 0, to - 1);
  assert.deepEqual([during.refusals[0]!.call, during.refusals[0]!.hours], ['pending', 19]);
  const over = riskLedgerSummary(records, [], 0, to);
  const r = over.refusals[0]!;
  assert.deepEqual([r.call, r.hours], ['helped', 19]);
  assert.ok(Math.abs(r.counterfactualUsd! - (0.19 - 0.5 * 19 / 20)) < 1e-9);
  assert.deepEqual([over.totals.helped, over.totals.pending], [1, 0]);
  // Under 90 %: still pending after the hold (17 of 20 h).
  const thin: RiskLedgerRecord[] = [c, { v: 1, type: 'hours', at: to, checkId: c.id, points: pts.slice(0, 17) }];
  assert.equal(riskLedgerSummary(thin, [], 0, to + HOUR).refusals[0]!.call, 'pending');
});

test('a window refused again inside an earlier refusal\'s hold is a repeat: each window-hour counted once', () => {
  const first = check({ at: T0 });
  const inside = check({ at: T0 + 2 * HOUR });                        // inside the first refusal's hold
  const after = check({ at: holdSpan(first).to + HOUR });            // after it: a new hold of its own
  const { from } = holdSpan(first);
  const same = (c: RiskCheckRecord): RiskLedgerRecord => ({ v: 1, type: 'hours', at: from + 9 * HOUR, checkId: c.id, points: [0, 1, 2, 3].map((i) => ({ t: from + i * HOUR, grossAprPct: 8.76 })) });
  const s = riskLedgerSummary([first, inside, after, same(first), same(inside)], []);
  assert.deepEqual(s.refusals.map((r) => r.call), ['helped', 'repeat', 'pending']);
  assert.equal(s.refusals[1]!.repeatOf, first.id);
  assert.equal(s.refusals[1]!.counterfactualUsd, null, 'the repeat\'s hours are the first one\'s: not counted twice');
  assert.deepEqual([s.totals.refused, s.totals.repeats], [2, 1]);
  assert.ok(Math.abs(s.totals.refusedCounterfactualUsd - (0.04 - 0.5)) < 1e-9);
  // The ledger on disk prices the repeat not at all.
  const path = riskLedgerFile(tmp(), 'mainnet', null, null);
  const ledger = new RiskLedger(path, () => {});
  ledger.check(first);
  ledger.check(inside);
  assert.equal(ledger.pricing, 1);
  const asked: string[] = [];
  ledger.hourly(from + 5 * HOUR, (id, f, t) => {
    asked.push(id);
    const pts = [];
    for (let h = f; h < t; h += HOUR) pts.push({ t: h, grossAprPct: 1 });
    return pts;
  });
  assert.equal(asked.length, 1);
  // Fully priced: dropped, never asked again.
  assert.equal(ledger.pricing, 0);
  ledger.hourly(from + 6 * HOUR, () => {
    throw new Error('asked again');
  });
  // A restart reads the same: nothing left to price.
  assert.equal(new RiskLedger(path, () => {}).pricing, 0);
});

test('the summary: a pass shows the position its own act opened, by id; a pass whose open failed shows none', () => {
  const pass = check({ at: T0, verdict: 'passed', outcome: 'passed' });
  const failed = check({ at: T0 + 2 * HOUR, verdict: 'passed', outcome: 'passed' });
  const noAct = check({ at: T0 + 3 * HOUR, verdict: 'passed', outcome: 'passed' });
  const noKey = check({ at: T0 + 5 * HOUR, windowId: 'eth-phoenix-hyperliquid', verdict: 'unchecked', outcome: 'no-key', attestation: null, prompt: null, reply: '' });
  const act = (c: RiskCheckRecord, positionId: string | null, result: string): RiskActRecord => ({ v: 1, type: 'act', at: c.at + 5_000, checkId: c.id, opened: positionId !== null, positionId, result });
  const positions = [
    { id: 'sol-phoenix-hyperliquid@2026-11-03T10:05:20Z', windowId: 'sol-phoenix-hyperliquid', open: false, netUsd: 1.25 },
    // Opened by hand 10 min after the failed open: not that pass's position.
    { id: 'sol-phoenix-hyperliquid@2026-11-03T12:15:00Z', windowId: 'sol-phoenix-hyperliquid', open: true, netUsd: 9 },
    { id: 'eth-phoenix-hyperliquid@2026-11-03T15:05:01Z', windowId: 'eth-phoenix-hyperliquid', open: true, netUsd: -0.4 },
  ];
  const s = riskLedgerSummary([
    pass, failed, noAct, noKey, act(pass, positions[0]!.id, 'opened: both legs'), act(failed, null, 'not opened: the spread does not cover the round trip'),
    act(noKey, positions[2]!.id, 'opened: both legs'),
  ], positions);
  assert.deepEqual(s.passes.map((p) => p.position?.id ?? null), [positions[0]!.id, null, null]);
  assert.deepEqual(s.passes.map((p) => p.act), ['opened: both legs', 'not opened: the spread does not cover the round trip', null]);
  assert.deepEqual(s.unchecked.map((p) => p.position), [{ id: positions[2]!.id, open: true, netUsd: -0.4 }]);
  assert.deepEqual(
    [s.totals.checks, s.totals.passed, s.totals.passedWithPosition, s.totals.passedNetUsd, s.totals.unchecked, s.totals.uncheckedNetUsd],
    [4, 3, 1, 1.25, 1, -0.4],
  );
});

test('the round trip: the scanner\'s fill, slippage and basis APR points over its hold, on one leg', () => {
  assert.ok(Math.abs(roundTripUsd({ feesPct: 2, slippagePct: 1, basisPct: 1 }, 1000, 240) - 0.04 * 1000 * 240 / 8760) < 1e-12);
  assert.ok(Math.abs(roundTripUsd({ feesPct: 2, slippagePct: 1 }, 1000, 240) - 0.03 * 1000 * 240 / 8760) < 1e-12);
  assert.equal(roundTripUsd({ feesPct: 0, slippagePct: 0, basisPct: 0 }, 1000, 240), 0);
});

test('the ledger keeps at most MAX_PRICING refusals pricing, and drops one past the scanner\'s history', () => {
  const logs: string[] = [];
  const ledger = new RiskLedger(riskLedgerFile(tmp(), 'mainnet', null, null), (l) => logs.push(l));
  const c = check({ at: T0 });
  ledger.check(c);
  ledger.hourly(holdSpan(c).to + PRICE_GRACE_MS, () => {
    throw new Error('not asked past its grace');
  });
  assert.equal(ledger.pricing, 0);
  for (let i = 0; i <= MAX_PRICING; i++) ledger.check(check({ at: T0 + i, windowId: `w${i}-phoenix-hyperliquid` }));
  assert.equal(ledger.pricing, MAX_PRICING);
  assert.ok(logs.some((l) => /more than 500 refusals pricing/.test(l)));
});

test('the ledger holds no key: the journal-bound fields are the prompt, the reply and the numbers only', () => {
  const path = riskLedgerFile(tmp(), 'mainnet', null, null);
  new RiskLedger(path, () => {}).check(check());
  const text = readFileSync(path, 'utf8');
  assert.ok(!/authorization|bearer|api[_-]?key/i.test(text));
});
