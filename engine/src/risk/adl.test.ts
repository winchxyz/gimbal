// ADL against a real PairTrader on fake legs: a confirmed shrink pauses the pair and unwinds both legs reduce-only,
// from one attempt budget per pair; our own fills, an open in flight, an Orderly leg inside its replay window and one
// bad read never look like ADL. The four bugs of the re-hedge this replaced are reproduced and shown impossible:
//   (A) the try cap was bypassable (51 orders in 24 checks);
//   (B) an Orderly replay plus adopting the actual positions dropped the ADL event;
//   (C) no closing journal entry;
//   (D) a stale `unhedged` alert.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VenueId } from '@gimbal/shared';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { toQty } from '../trade/lots.ts';
import { PairTrader } from '../trade/pair.ts';
import type { AdlReport, AdlState } from './adl.ts';
import { ADL_ATTEMPTS, AdlWatch, CONFIRM_MS, RETRY_MS, adlJournal, legChange, newAdlState } from './adl.ts';

class Leg implements TradeLeg {
  readonly venue: VenueId;
  readonly symbol = 'XLM';
  readonly lot: bigint;
  readonly replayable: boolean;
  pos = 0n;
  orders: { side: LegSide; size: bigint; reduceOnly: boolean }[] = [];
  hold: Promise<void> | null = null;
  onRead: (() => void) | null = null;
  reads: bigint[] = [];
  reject: (side: LegSide, reduceOnly: boolean) => boolean = () => false;
  readonly #now: () => number;

  constructor(venue: VenueId, now: () => number, replayable = false) {
    this.venue = venue;
    this.lot = toQty('1');
    this.replayable = replayable;
    this.#now = now;
  }
  async check(): Promise<void> {}
  async maxSize(): Promise<bigint> {
    return toQty('1000');
  }
  async position(): Promise<bigint> {
    const p = this.reads.length > 0 ? this.reads.shift()! : this.pos;
    const hook = this.onRead;
    this.onRead = null;
    hook?.();
    return p;
  }
  async order(side: LegSide, size: bigint, reduceOnly: boolean): Promise<LegOutcome> {
    this.orders.push({ side, size, reduceOnly });
    const ref = { venue: this.venue, side, size: String(size), reduceOnly, orderId: `o${this.orders.length}`, clientId: null, tx: [], sentAt: this.#now() };
    if (this.reject(side, reduceOnly)) return { kind: 'failed', error: new Error('refused'), ref };
    if (reduceOnly) {
      const next = this.pos + (side === 'BUY' ? size : -size);
      if ((this.pos >= 0n && next > this.pos) || (this.pos <= 0n && next < this.pos)) return { kind: 'failed', error: new Error('reduce-only would increase'), ref };
    }
    if (this.hold !== null) {
      const h = this.hold;
      this.hold = null;
      await h;
    }
    this.pos += side === 'BUY' ? size : -size;
    return { kind: 'filled', filled: size, avgPx: 0.25, ref };
  }
}

function setup(options: { replayable?: boolean; state?: AdlState; trade?: boolean } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now };
  const hl = new Leg('hyperliquid', clock.now);
  const px = new Leg(options.replayable ? 'orderly' : 'phoenix', clock.now, options.replayable ?? false);
  const trader = new PairTrader({ legs: [hl, px], priceBandBps: 100, clock, unsettledPollMs: null });
  const saves: AdlState[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  const adl = new AdlWatch(trader, {
    ...(options.state === undefined ? {} : { state: options.state }), trade: options.trade ?? true,
    onChange: (s) => saves.push(structuredClone(s)), log: (l) => lines.push(l), clock, sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  return { hl, px, trader, adl, saves, sleeps, lines, clock, advance: (ms: number) => { now += ms; } };
}

/** A pair opened at 50 XLM a leg: Hyperliquid short, Phoenix long. */
async function opened(s: ReturnType<typeof setup>): Promise<void> {
  const r = await s.trader.open({ size: '50', longIndex: 1, reason: 'enter' });
  assert.equal(r.status, 'open');
}

const sent = (...legs: Leg[]) => legs.reduce((n, l) => n + l.orders.length, 0);

test('legChange: shrank toward zero, grew, flipped', () => {
  assert.equal(legChange(-500n, -500n), 'same');
  assert.equal(legChange(-500n, -300n), 'shrank');
  assert.equal(legChange(-500n, 0n), 'shrank');
  assert.equal(legChange(500n, 700n), 'grew');
  assert.equal(legChange(500n, -100n), 'flipped');
  assert.equal(legChange(0n, 100n), 'grew');
});

test('a confirmed ADL pauses the pair and unwinds both legs reduce-only, never a partial re-hedge; the budget is saved first', async () => {
  const s = setup();
  await opened(s);
  assert.equal(await s.adl.check(), null, 'right after our own fills: nothing is off');
  s.hl.pos = toQty('-30');                                  // the venue deleveraged 20 of the short
  const report = await s.adl.check();
  assert.ok(report !== null);
  assert.equal(report.stage, 'unwound');
  assert.equal(report.attempt, 1);
  assert.equal(s.hl.pos, 0n);
  assert.equal(s.px.pos, 0n);
  assert.ok([...s.hl.orders.slice(1), ...s.px.orders.slice(1)].every((o) => o.reduceOnly), 'every ADL order is reduce-only');
  assert.match(s.adl.paused ?? '', /^ADL on hyperliquid XLM -50 -> -30/);
  // The attempt was counted on disk before its first order.
  const counted = s.saves.find((x) => x.attemptsLeft === ADL_ATTEMPTS - 1);
  assert.ok(counted !== undefined && counted.event !== null && counted.event.attempts === 1);
  assert.equal(s.saves.at(-1)!.event, null);
  assert.equal(s.trader.unhedged, null);
  const [entry, ...rest] = adlJournal(report, 5);
  assert.equal(entry!.kind, 'adl');
  assert.deepEqual(entry!.numbers, { stage: 'unwound', attemptsLeft: ADL_ATTEMPTS - 1, attempt: 1, venue: 'hyperliquid', before: '-50', after: '-30', lost: '20' });
  assert.match(entry!.summary, /the pair is paused; unwinding both legs reduce-only: attempt 1 of 3 closed both legs$/);
  assert.equal(rest.length, 0, 'no owner alert: it was unwound');
  assert.equal(await s.adl.check(), null, 'flat and flat: nothing more');
});

test('unwinding: true only while an unwind attempt\'s close signs or is in flight, never during the read-only checks', async () => {
  const s = setup();
  await opened(s);
  const seen: boolean[] = [];
  s.hl.onRead = () => seen.push(s.adl.unwinding);
  assert.equal(await s.adl.check(), null);
  assert.deepEqual(seen, [false], 'a check with nothing off reads only');
  assert.equal(s.adl.unwinding, false);
  // The venue deleveraged the short: the confirming read is still read-only, then the close goes out and is held.
  s.hl.pos = toQty('-30');
  let release!: () => void;
  s.px.hold = new Promise<void>((r) => { release = r; });
  s.hl.onRead = () => seen.push(s.adl.unwinding);
  const running = s.adl.check();
  while (s.px.orders.length < 2) await new Promise((r) => setImmediate(r));
  assert.equal(seen.at(-1), false, 'the first read of the event is the read-only check');
  assert.equal(s.adl.unwinding, true, 'the close is in flight');
  release();
  const report = await running;
  assert.equal(report?.stage, 'unwound');
  assert.equal(s.adl.unwinding, false, 'over when the attempt returns');
});

test('confirming: true from the read that saw a leg off its baseline until the check returns, confirmed or not', async () => {
  const s = setup();
  await opened(s);
  const seen: boolean[] = [];
  const watchReads = () => {
    s.hl.onRead = () => {
      seen.push(s.adl.confirming);
      s.hl.onRead = () => seen.push(s.adl.confirming);
    };
  };
  watchReads();
  assert.equal(await s.adl.check(), null);
  assert.deepEqual(seen, [false], 'nothing off: one read, never confirming');
  // A read that is not confirmed 3 s later: confirming during the second read, over after.
  seen.length = 0;
  s.hl.reads = [toQty('-30'), toQty('-50')];
  watchReads();
  assert.equal(await s.adl.check(), null);
  assert.deepEqual(seen, [false, true]);
  assert.equal(s.adl.confirming, false);
  assert.equal(s.adl.state.event, null);
  // Confirmed: the same, and the event is made (its unwind runs before the check returns).
  seen.length = 0;
  s.hl.pos = toQty('-30');
  watchReads();
  const report = await s.adl.check();
  assert.equal(report?.stage, 'unwound');
  assert.deepEqual(seen.slice(0, 2), [false, true]);
  assert.equal(s.adl.confirming, false);
});

test('a partial ADL is unwound too, not re-hedged at the smaller size', async () => {
  const s = setup();
  await opened(s);
  s.px.pos = toQty('45');                                    // 90 % kept: the old watch re-hedged here
  const report = await s.adl.check();
  assert.equal(report!.stage, 'unwound');
  assert.deepEqual([s.hl.pos, s.px.pos], [0n, 0n]);
});

test('our own fills never look like ADL: nothing is checked while an open is in flight, or when a read races our order', async () => {
  const s = setup();
  let release!: () => void;
  s.hl.hold = new Promise<void>((r) => { release = r; });
  const opening = s.trader.open({ size: '50', longIndex: 1, reason: 'enter' });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.trader.busy, true);
  assert.equal(await s.adl.check(), null);
  release();
  await opening;
  let racing: Promise<unknown> | null = null;
  s.hl.pos = toQty('-40');
  s.hl.onRead = () => { racing = s.trader.close({ reason: 'own close', targets: [toQty('-40'), toQty('40')], reduceOnly: true }); };
  assert.equal(await s.adl.check(), null, 'the read is stale: our own close started while it was out');
  await racing;
  assert.equal(await s.adl.check(), null, 'our close moved the baselines');
});

test('one bad read is not ADL: the change must be confirmed by a second read 3 s later', async () => {
  const s = setup();
  await opened(s);
  s.hl.reads = [0n];                                         // Hyperliquid left the coin out of assetPositions once
  assert.equal(await s.adl.check(), null);
  assert.deepEqual(s.sleeps, [CONFIRM_MS]);
  assert.ok(s.lines.some((l) => /not confirmed by a read 3 s later/.test(l)));
  assert.equal(sent(s.hl, s.px), 2, 'nothing traded');
  assert.equal(s.adl.state.event, null);
});

test('a leg that grew or flipped, or a pair unhedged before, is not ADL: journaled once with the owner alert, nothing traded', async () => {
  const s = setup();
  await opened(s);
  s.hl.pos = toQty('-70');
  const grew = await s.adl.check();
  assert.equal(grew!.stage, 'not-adl');
  assert.equal(grew!.ownerAlert, true);
  assert.match(grew!.summary, /not ADL, nothing traded: hyperliquid XLM grew -50 -> -70/);
  assert.equal(await s.adl.check(), null, 'the same finding is not reported twice');
  assert.equal(adlJournal(grew!, 1).map((j) => j.kind).join(','), 'adl,error');
  assert.equal(sent(s.hl, s.px), 2);

  const u = setup();
  u.px.reject = () => true;
  u.hl.reject = (_side, reduceOnly) => reduceOnly;
  assert.equal((await u.trader.open({ size: '10', longIndex: 0, reason: 'enter' })).status, 'unhedged');
  u.px.reject = () => false;
  u.hl.reject = () => false;
  const before = sent(u.hl, u.px);
  u.hl.pos = toQty('6');
  const r = await u.adl.check();
  assert.equal(r!.stage, 'not-adl');
  assert.match(r!.summary, /the pair was not hedged before \(baselines 10 and 0\)/);
  assert.equal(sent(u.hl, u.px), before);
});

test('(A) the attempt budget is per pair, not per event: 24 checks with the legs moving every time send at most 3 attempts', async () => {
  // The old watch keyed its try cap on the positions: legs that moved between checks were a "new event" each time,
  // and 51 orders went out in 24 checks. Here a venue that refuses every reduce-only order, legs drifting.
  const s = setup();
  await opened(s);
  const opening = sent(s.hl, s.px);
  s.hl.reject = (_side, reduceOnly) => reduceOnly;
  s.px.reject = (_side, reduceOnly) => reduceOnly;
  const reports: AdlReport[] = [];
  let closes = 0;
  const by: unknown[] = [];
  const close = s.trader.close.bind(s.trader);
  s.trader.close = (req) => {
    closes++;
    by.push((req as { by?: string }).by);
    return close(req);
  };
  for (let i = 0; i < 24; i++) {
    s.hl.pos = toQty(String(-(40 - i)));                     // a further ADL slice every check
    s.px.pos = toQty(String(45 - i));
    const r = await s.adl.check();
    if (r !== null) reports.push(r);
    s.advance(RETRY_MS * 2 ** i);                            // well past every backoff
  }
  assert.equal(closes, ADL_ATTEMPTS);
  assert.ok(by.every((x) => x === 'ADL unwind'), 'each unwind names itself: the book books it outside the loop');
  assert.ok(sent(s.hl, s.px) - opening <= ADL_ATTEMPTS * 4, `at most 2 orders per leg per attempt, got ${sent(s.hl, s.px) - opening}`);
  assert.deepEqual(reports.map((r) => r.stage), ['failed', 'failed', 'gave-up']);
  assert.equal(s.adl.state.attemptsLeft, 0);
  // A restart from the saved state does not refill it.
  const again = setup({ state: structuredClone(s.saves.at(-1)!) });
  again.trader.adopt([toQty('-17'), toQty('22')]);
  const before = sent(again.hl, again.px);
  again.hl.pos = toQty('-17');
  again.px.pos = toQty('22');
  const r = await again.adl.check();
  assert.equal(r, null, 'the event goes on and its owner alert was already raised: nothing new');
  assert.equal(sent(again.hl, again.px), before, 'no order after a restart either');
});

test('(A) a new event after the budget is spent sends nothing either: the owner alert, once', async () => {
  const s = setup({ state: { attemptsLeft: 0, paused: 'earlier', event: null } });
  await opened(s);
  s.hl.pos = toQty('-20');
  const r = await s.adl.check();
  assert.equal(r!.stage, 'gave-up');
  assert.equal(r!.ownerAlert, true);
  assert.equal(sent(s.hl, s.px), 2);
  assert.equal(await s.adl.check(), null);
});

test('(B) a failed attempt whose close adopted the actual positions does not drop the event: the next attempt goes', async () => {
  const s = setup();
  await opened(s);
  s.px.reject = (_side, reduceOnly) => reduceOnly;           // Phoenix refuses the first unwind
  s.hl.pos = toQty('-30');
  const first = await s.adl.check();
  assert.equal(first!.stage, 'failed');
  // The trader took what the failed close left as its intents and baselines (hl 0, phoenix 50): the old watch saw
  // nothing off any more and dropped the event.
  assert.deepEqual([s.trader.baseline(s.hl), s.trader.baseline(s.px)], [0n, toQty('50')]);
  assert.notEqual(s.adl.state.event, null);
  s.px.reject = () => false;
  assert.equal(await s.adl.check(), null, 'inside the backoff: nothing');
  s.advance(RETRY_MS);
  const second = await s.adl.check();
  assert.equal(second!.stage, 'unwound');
  assert.equal(second!.attempt, 2);
  assert.deepEqual([s.hl.pos, s.px.pos], [0n, 0n]);
});

test('(B) an Orderly replay reconciled by the trader\'s watch cannot hide an ADL: the baseline is the last close\'s, not the watch\'s', async () => {
  const s = setup({ replayable: true });
  await opened(s);
  // Inside the replay window a push shows Orderly smaller: the trader's watch matches the deficit on Hyperliquid
  // (its intents move to the smaller pair). The ADL watch must still see both legs shrank from the baseline.
  s.px.pos = toQty('30');
  await s.trader.positionPushed(s.px, toQty('30'));
  assert.deepEqual([s.trader.intent(s.hl), s.trader.intent(s.px)], [toQty('-30'), toQty('30')]);
  assert.deepEqual([s.trader.baseline(s.hl), s.trader.baseline(s.px)], [toQty('-50'), toQty('50')]);
  assert.equal(await s.adl.check(), null, 'inside the replay window: not checked');
  s.advance(400_000);
  const r = await s.adl.check();
  assert.equal(r!.stage, 'unwound');
  assert.deepEqual([s.hl.pos, s.px.pos], [0n, 0n]);
});

test('(B) a restart in the middle of an event resumes it from the saved state', async () => {
  const s = setup();
  await opened(s);
  s.px.reject = (_side, reduceOnly) => reduceOnly;
  s.hl.pos = toQty('-30');
  assert.equal((await s.adl.check())!.stage, 'failed');
  const saved = structuredClone(s.saves.at(-1)!);
  const t = setup({ state: saved });
  t.hl.pos = s.hl.pos;
  t.px.pos = s.px.pos;
  t.trader.importState(s.trader.exportState());
  t.advance(RETRY_MS);
  const r = await t.adl.check();
  assert.equal(r!.stage, 'unwound');
  assert.equal(r!.attempt, 2);
  assert.equal(t.adl.state.attemptsLeft, ADL_ATTEMPTS - 2);
});

test('(C) every end is journaled: confirmed + attempt, each failed attempt, the give-up, the end by hand', async () => {
  const s = setup();
  await opened(s);
  s.hl.reject = (_side, reduceOnly) => reduceOnly;
  s.px.reject = (_side, reduceOnly) => reduceOnly;
  s.hl.pos = toQty('-30');
  const journal: string[] = [];
  const take = (r: AdlReport | null) => {
    if (r !== null) for (const j of adlJournal(r, 1)) journal.push(`${j.kind} ${r.stage}`);
  };
  take(await s.adl.check());
  for (let i = 0; i < 4; i++) {
    s.advance(RETRY_MS * 8);
    take(await s.adl.check());
  }
  // The owner closes both legs on the venues: the event ends, journaled.
  s.hl.pos = 0n;
  s.px.pos = 0n;
  take(await s.adl.check());
  assert.deepEqual(journal, ['adl failed', 'adl failed', 'adl gave-up', 'error gave-up', 'adl flat']);
  assert.equal(s.adl.state.event, null);
});

test('(D) the unhedged alert is raised while the event lasts and cleared when it ends: never stale', async () => {
  const s = setup();
  await opened(s);
  s.px.reject = (_side, reduceOnly) => reduceOnly;
  s.hl.pos = toQty('-30');
  await s.adl.check();
  assert.match(s.trader.unhedged ?? '', /^adl: .*attempt 1 of 3 did not close both legs/);
  s.px.reject = () => false;
  s.advance(RETRY_MS);
  assert.equal((await s.adl.check())!.stage, 'unwound');
  assert.equal(s.trader.unhedged, null);

  // Spent budget, then the owner closes by hand: the alert goes with the event.
  const g = setup({ state: { ...newAdlState(), attemptsLeft: 1 } });
  await opened(g);
  g.px.reject = (_side, reduceOnly) => reduceOnly;
  g.hl.pos = toQty('-30');
  assert.equal((await g.adl.check())!.stage, 'gave-up');
  assert.notEqual(g.trader.unhedged, null);
  g.hl.pos = 0n;
  g.px.pos = 0n;
  assert.equal((await g.adl.check())!.stage, 'flat');
  assert.equal(g.trader.unhedged, null);
});

test('alert only (the trader does not trade): a confirmed ADL is journaled with the owner alert once, nothing is sent', async () => {
  const s = setup({ trade: false });
  await opened(s);
  s.hl.pos = toQty('-30');
  const r = await s.adl.check();
  assert.equal(r!.stage, 'alert');
  assert.equal(r!.ownerAlert, true);
  assert.equal(sent(s.hl, s.px), 2);
  assert.equal(s.adl.state.attemptsLeft, ADL_ATTEMPTS, 'no attempt counted');
  s.advance(RETRY_MS * 10);
  assert.equal(await s.adl.check(), null);
  s.hl.pos = 0n;
  s.px.pos = 0n;
  assert.equal((await s.adl.check())!.stage, 'flat');
});

test('a save that fails stops an attempt before any order', async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const hl = new Leg('hyperliquid', clock.now);
  const px = new Leg('phoenix', clock.now);
  const trader = new PairTrader({ legs: [hl, px], priceBandBps: 100, clock, unsettledPollMs: null });
  await trader.open({ size: '50', longIndex: 1, reason: 'enter' });
  let fail = false;
  const adl = new AdlWatch(trader, { clock, sleep: async (ms) => { now += ms; }, onChange: () => { if (fail) throw new Error('disk full'); } });
  hl.pos = toQty('-30');
  fail = true;
  await assert.rejects(adl.check(), /disk full/);
  assert.equal(hl.orders.length + px.orders.length, 2, 'nothing sent');
});

test('stop() is final: a check in flight sends nothing after it', async () => {
  const s = setup();
  await opened(s);
  s.hl.pos = toQty('-30');
  s.hl.onRead = () => s.adl.stop();
  assert.equal(await s.adl.check(), null);
  assert.equal(sent(s.hl, s.px), 2);
});
