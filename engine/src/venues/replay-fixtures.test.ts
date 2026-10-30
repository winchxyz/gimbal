// Plays every committed recording in fixtures/replay/ and checks it twice gives the same results.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ReplayMissError, ReplayVenue, VirtualClock, readRecording } from './replay.ts';
import type { Book } from './venue.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/replay/', import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl.gz')).sort();
const STEP_MS = 5_000;
const COINS = ['BTC', 'ETH', 'SOL'];

interface CoinView {
  coin: string;
  ratePerHour: number | null;
  markPx: number | null;
  mid: number;
  spreadBps: number;
  depthUsd10Bps: number;          // bid + ask notional within 10 bps of mid
}

interface Tick {
  t: number;
  markets: number;
  funded: number;
  top: [string, number][];        // the three highest |rate| markets, as APR %
  coins: (CoinView | 'miss')[];
}

/** A small deterministic scan: what the scanner will do later, reduced to numbers we can compare. */
async function play(file: string): Promise<{ ticks: Tick[]; digest: string; span: number }> {
  const lines = readRecording(join(FIXTURES, file));
  const clock = new VirtualClock(lines[0]!.t);
  const venue = new ReplayVenue(lines, clock);
  const markets = await venue.markets();
  const ticks: Tick[] = [];
  for (let t = venue.start; ; t = Math.min(t + STEP_MS, venue.end)) {
    clock.set(t);
    const funding = await venue.funding().catch((e: unknown) => (e instanceof ReplayMissError ? [] : Promise.reject(e)));
    const coins: Tick['coins'] = [];
    for (const coin of COINS) {
      try {
        const book = await venue.book(coin, 20);
        const f = funding.find((r) => r.symbol === coin);
        coins.push(view(coin, book, f?.ratePerHour ?? null, f?.markPx ?? null));
      } catch (e) {
        if (!(e instanceof ReplayMissError)) throw e;
        coins.push('miss');
      }
    }
    const top = [...funding]
      .sort((a, b) => Math.abs(b.ratePerHour) - Math.abs(a.ratePerHour) || a.symbol.localeCompare(b.symbol))
      .slice(0, 3)
      .map((r): [string, number] => [r.symbol, r.ratePerHour * 24 * 365 * 100]);
    ticks.push({ t, markets: markets.length, funded: funding.length, top, coins });
    if (t === venue.end) break;
  }
  const digest = createHash('sha256').update(JSON.stringify(ticks)).digest('hex');
  return { ticks, digest, span: venue.end - venue.start };
}

function view(coin: string, book: Book, ratePerHour: number | null, markPx: number | null): CoinView {
  const bid = book.bids[0]!.px;
  const ask = book.asks[0]!.px;
  const mid = (bid + ask) / 2;
  const within = (px: number) => Math.abs(px - mid) / mid <= 0.001;
  const depth = [...book.bids, ...book.asks].filter((l) => within(l.px)).reduce((s, l) => s + l.px * l.sz, 0);
  return { coin, ratePerHour, markPx, mid, spreadBps: ((ask - bid) / mid) * 1e4, depthUsd10Bps: Math.round(depth) };
}

test('there is a committed recording of at least 10 minutes', () => {
  assert.ok(files.length > 0, `no .jsonl.gz in ${FIXTURES}`);
  const spans = files.map((f) => {
    const lines = readRecording(join(FIXTURES, f));
    return lines[lines.length - 1]!.t - lines[0]!.t;
  });
  assert.ok(Math.max(...spans) >= 9.5 * 60_000, `longest recording spans ${Math.max(...spans)} ms`);
});

for (const file of files) {
  test(`${file}: two replays give identical results`, async () => {
    const a = await play(file);
    const b = await play(file);
    assert.deepEqual(a.ticks, b.ticks);
    assert.equal(a.digest, b.digest);
    assert.ok(a.ticks.length >= Math.floor(a.span / STEP_MS), `only ${a.ticks.length} ticks over ${a.span} ms`);
  });

  test(`${file}: the data is coherent`, async () => {
    const { ticks } = await play(file);
    // Books for every coin from the second tick on (the first tick may land before its books).
    for (const tick of ticks.slice(1)) {
      assert.ok(tick.funded > 0, `no funded markets at ${tick.t}`);
      for (const c of tick.coins) {
        assert.notEqual(c, 'miss', `missing book at ${tick.t}`);
        if (c === 'miss') continue;
        assert.ok(c.spreadBps >= 0 && c.spreadBps < 20, `${c.coin} spread ${c.spreadBps} bps at ${tick.t}`);
        assert.ok(c.ratePerHour !== null && Math.abs(c.ratePerHour) < 0.01, `${c.coin} rate ${c.ratePerHour}`);
        assert.ok(c.markPx !== null && Math.abs(c.mid / c.markPx - 1) < 0.005, `${c.coin} mid ${c.mid} vs mark ${c.markPx}`);
      }
    }
  });
}
