// Records live Hyperliquid market data for replay.
//   npm run record -w engine -- --minutes 10 --out fixtures/replay/<name>.jsonl.gz
// Options: --interval <s> (default 5), --coins BTC,ETH,SOL (books), --testnet, --url <info endpoint>,
//   --address 0x... (also that account's state each tick and its funding history once, from --funding-days
//   days back, default 7).
// Public data only: funding for every listed market each tick, books for a few coins.

import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { HL_MAINNET_INFO_URL, HL_TESTNET_INFO_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { JsonlGzWriter, RecordingVenue, errorMessage } from '../venues/recorder.ts';

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '10' },
    out: { type: 'string' },
    interval: { type: 'string', default: '5' },
    coins: { type: 'string', default: 'BTC,ETH,SOL' },
    testnet: { type: 'boolean', default: false },
    url: { type: 'string' },
    address: { type: 'string' },
    'funding-days': { type: 'string', default: '7' },
  },
});

const minutes = Number(values.minutes);
const intervalMs = Number(values.interval) * 1000;
const fundingDays = Number(values['funding-days']);
const coins = values.coins.split(',').map((c) => c.trim()).filter((c) => c !== '');
const url = values.url ?? (values.testnet ? HL_TESTNET_INFO_URL : HL_MAINNET_INFO_URL);
if (values.out === undefined) fail('--out <path.jsonl.gz> is required');
if (!values.out.endsWith('.jsonl.gz')) fail('--out must end in .jsonl.gz');
if (!(minutes > 0)) fail('--minutes must be a positive number');
if (!(intervalMs >= 1000)) fail('--interval must be at least 1 second');
if (!(fundingDays > 0)) fail('--funding-days must be a positive number');

const out = resolve(values.out);
const writer = new JsonlGzWriter(out);
const venue = new RecordingVenue(new HyperliquidReader({ url, network: values.testnet ? 'testnet' : 'mainnet' }), writer);
const address = values.address;

const stop = new AbortController();
process.once('SIGINT', () => {
  log('SIGINT: closing the file after the current tick');
  stop.abort();
});

const start = Date.now();
const end = start + minutes * 60_000;
let ticks = 0;
let errors = 0;

log(`recording ${url} for ${minutes} min every ${intervalMs / 1000} s, books ${coins.join(' ')} -> ${values.out}`);

try {
  await venue.markets();
} catch (err) {
  errors++;
  log(`markets failed: ${errorMessage(err)}`);
}
if (address !== undefined) {
  try {
    await venue.userFunding(address, start - fundingDays * 86_400_000);
  } catch (err) {
    errors++;
    log(`userFunding failed: ${errorMessage(err)}`);
  }
}

// Ticks sit on a fixed grid from the start; a slow tick skips grid points instead of bunching up.
for (let due = start; due < end && !stop.signal.aborted; ) {
  const wait = due - Date.now();
  if (wait > 0) {
    try {
      await sleep(wait, undefined, { signal: stop.signal });
    } catch {
      break;
    }
  }
  const settled = await Promise.allSettled([
    venue.funding(),
    ...coins.map((c) => venue.book(c)),
    ...(address === undefined ? [] : [venue.account(address)]),
  ]);
  for (const s of settled) {
    if (s.status === 'rejected') {
      errors++;
      log(`tick ${ticks}: ${errorMessage(s.reason)}`);
    }
  }
  ticks++;
  if (ticks % Math.max(1, Math.round(60_000 / intervalMs)) === 0) {
    await writer.flush();
    log(`${Math.round((Date.now() - start) / 1000)} s, ${ticks} ticks, ${writer.lines} lines, ${errors} errors`);
  }
  while (due <= Date.now()) due += intervalMs;
}

await writer.close();
const bytes = statSync(out).size;
log(`done: ${ticks} ticks, ${writer.lines} lines, ${errors} errors, ${(bytes / 1024).toFixed(1)} KiB`);

function log(msg: string): void {
  console.log(`[record ${new Date().toISOString()}] ${msg}`);
}

function fail(msg: string): never {
  console.error(`record: ${msg}`);
  process.exit(2);
}
