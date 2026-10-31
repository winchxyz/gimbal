// The Phoenix, Orderly and side-by-side SOL smokes over the recorded fixtures: what `npm run smoke -w engine --
// phoenix|orderly|sol` prints, without the network.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import { VirtualClock, readWireRecording, replayFetch, replayWsRequester } from '../venues/replay.ts';
import { aprPct, smokeOrderly, smokePhoenix, smokeSol } from './smoke-venues.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const read = (dir: string, file: string) => readWireRecording(join(FIXTURES, dir, file));
const HL = read('hl-wire', 'hl-mainnet-2026-10-30.jsonl.gz');
const PHOENIX = read('phoenix-wire', 'phoenix-mainnet-2026-10-31.jsonl.gz');
const ORDERLY = read('orderly-wire', 'orderly-mainnet-2026-10-31.jsonl.gz');
const ORDERLY_TESTNET = read('orderly-wire', 'orderly-testnet-2026-10-31.jsonl.gz');

const phoenix = () => new PhoenixReader({ fetch: replayFetch(PHOENIX), clock: new VirtualClock(PHOENIX[0]!.t) });
const orderly = (lines = ORDERLY, network: 'mainnet' | 'testnet' = 'mainnet') =>
  new OrderlyReader({ network, fetch: replayFetch(lines), wsRequest: replayWsRequester(lines), clock: new VirtualClock(lines[0]!.t) });

async function lines(run: (log: (l: string) => void) => Promise<unknown>): Promise<string[]> {
  const out: string[] = [];
  await run((l) => out.push(l));
  return out;
}

function assertBook(out: string[], symbol: string): void {
  const at = out.findIndex((l) => l.startsWith(`${symbol} book at`));
  assert.ok(at > 0, out.join('\n'));
  const levels = out.slice(at + 2, at + 7);
  assert.equal(levels.length, 5);
  for (const l of levels) assert.match(l, /^\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/);
  assert.match(out.at(-1)!, /^spread\s+\d+\.\d{4} \(\d+\.\d\d bps\)$/);
}

test('APR in percent = rate per hour x 24 x 365 x 100', () => {
  assert.equal(aprPct(0.0000125), 0.0000125 * 8760 * 100);   // 10.95 %
  assert.ok(Math.abs(aprPct(0.0000125) - 10.95) < 1e-9);
  assert.equal(aprPct(0), 0);
});

test('phoenix smoke: SOL market, funding per hour and APR, top 5 levels', async () => {
  const out = await lines((log) => smokePhoenix(phoenix(), log));
  assert.match(out[0]!, /^Phoenix mainnet\s+https:\/\/perp-api\.phoenix\.trade$/);
  assert.match(out[1]!, /^SOL\s+asset id \d+, lot [\d.]+ SOL, tick [\d.]+ USD, max leverage \d+x, taker [\d.]+ bps, market \w+/);
  const funding = out.find((l) => l.startsWith('funding'))!;
  assert.match(funding, /^funding\s+0\.0000207533 per hour .*APR 18\.18 %\s+longs pay shorts\s+last booked hour, settles daily/);
  assertBook(out, 'SOL');
});

test('orderly smoke, mainnet and testnet: the 8 h estimate per hour, and the book over the public stream', async () => {
  const out = await lines((log) => smokeOrderly(orderly(), log));
  assert.match(out[0]!, /^Orderly mainnet\s+https:\/\/api\.orderly\.org$/);
  assert.match(out[1]!, /^PERP_SOL_USDC\s+lot 0\.01, tick 0\.001 USD, max leverage 100x, funding every 8 h, min notional 10 USD$/);
  assert.match(out.find((l) => l.startsWith('funding'))!, /per hour .*APR -?\d+\.\d\d %.*estimate for the running 8 h period, settles 8h/);
  assertBook(out, 'PERP_SOL_USDC');
  const test = await lines((log) => smokeOrderly(orderly(ORDERLY_TESTNET, 'testnet'), log));
  assert.match(test[0]!, /^Orderly testnet\s+https:\/\/testnet-api\.orderly\.org$/);
  assertBook(test, 'PERP_SOL_USDC');
});

test('sol smoke: one row per venue with rate per hour, APR, settlement and basis, then the widest gap', async () => {
  const hyperliquid = new HyperliquidReader({ fetch: replayFetch(HL) });
  let ok = false;
  const out = await lines(async (log) => { ok = await smokeSol({ hyperliquid, phoenix: phoenix(), orderly: orderly() }, log); });
  assert.equal(ok, true);
  assert.match(out[0]!, /^SOL funding, side by side/);
  const row = (venue: string) => out.find((l) => l.startsWith(venue))!;
  const rate = (venue: string) => Number(row(venue).trim().split(/\s+/)[2]);
  assert.match(row('hyperliquid'), /^hyperliquid\s+SOL\s+-?\d\.\d{10}\s+-?\d+\.\d\d %\s+hourly .*current hour, estimate$/);
  assert.match(row('phoenix'), /^phoenix\s+SOL\s+0\.0000207533\s+18\.18 %\s+daily .*last hour booked$/);
  assert.match(row('orderly'), /^orderly\s+PERP_SOL_USDC\s+-?\d\.\d{10}\s+-?\d+\.\d\d %\s+8h .*running period, estimate$/);
  const rates = ['hyperliquid', 'phoenix', 'orderly'].map((v) => ({ v, r: rate(v) })).sort((a, b) => a.r - b.r);
  assert.match(out.at(-1)!, new RegExp(`^widest gap  short ${rates[2]!.v}, long ${rates[0]!.v}: \\d+\\.\\d\\d % APR gross`));
});

test('sol smoke keeps going when one venue fails, and reports it on that venue\'s row', async () => {
  const hyperliquid = new HyperliquidReader({ fetch: (async () => new Response('down', { status: 503 })) as typeof fetch });
  let ok = true;
  const out = await lines(async (log) => { ok = await smokeSol({ hyperliquid, phoenix: phoenix(), orderly: orderly() }, log); });
  assert.equal(ok, false);
  assert.match(out.find((l) => l.startsWith('hyperliquid'))!, /error: .*503/);
  assert.match(out.at(-1)!, /^widest gap  short phoenix, long orderly/);
});
