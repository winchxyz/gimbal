// Captures the raw exchanges of one pass over a venue reader, as a test fixture.
//   npm run capture -w engine -- --out fixtures/hl-wire/<name>.jsonl.gz [--testnet] [--address 0x...] [--coins ETH,BTC]
//   npm run capture -w engine -- --venue phoenix --out fixtures/phoenix-wire/<name>.jsonl.gz [--coins SOL,ETH,BTC]
//       [--address <authority> [--view <trader key>] [--funding-since <ms>]]
//   npm run capture -w engine -- --venue orderly --out fixtures/orderly-wire/<name>.jsonl.gz [--testnet] [--coins SOL,ETH,BTC]
//   npm run capture -w engine -- --venue watch --out fixtures/watch-wire/<name>.jsonl.gz
// Each pass calls markets, funding, a book per coin, and one unknown coin (to keep the venue's real answer to it).
// The watch pass is one funding sweep over every watch-only venue plus Hyperliquid's main dex (the self-check's
// reference), mainnet only.
// Hyperliquid with --address adds that account's state and its whole funding history (all pages), from time 0.
// Phoenix with --address adds that authority's trader snapshot, the venue's own computed view of the same trader
// (--view, its trader key: tests check the margin math against it) and its funding history since --funding-since.
// Orderly adds the funding-rate history of each coin over the last 3 days. Public data only.

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { OrderlyReader, orderlySymbol } from '../venues/orderly.ts';
import { PhoenixReader, PHOENIX_API_URL, phoenixGet } from '../venues/phoenix.ts';
import type { WireLine } from '../venues/recorder.ts';
import { JsonlGzWriter, errorMessage, recordingFetch, recordingWsRequester } from '../venues/recorder.ts';
import { watchReaders } from '../venues/watch/index.ts';
import { sweep, sweepReport } from '../venues/watch/sweep.ts';
import { WsRequestClient } from '../venues/ws.ts';

const { values } = parseArgs({
  options: {
    venue: { type: 'string', default: 'hl' },
    out: { type: 'string' },
    testnet: { type: 'boolean', default: false },
    address: { type: 'string' },
    view: { type: 'string' },
    'funding-since': { type: 'string' },
    coins: { type: 'string' },
  },
});

if (values.out === undefined) fail('--out <path.jsonl.gz> is required');
if (!values.out.endsWith('.jsonl.gz')) fail('--out must end in .jsonl.gz');
const venue = values.venue;
if (venue !== 'hl' && venue !== 'phoenix' && venue !== 'orderly' && venue !== 'watch') fail('--venue must be hl, phoenix, orderly or watch');
if (venue === 'phoenix' && values.testnet) fail('phoenix has no public testnet API');
if (venue === 'watch' && values.testnet) fail('the watch venues are read on mainnet only');
const coins = (values.coins ?? (venue === 'hl' ? 'ETH,BTC' : 'SOL,ETH,BTC')).split(',').map((c) => c.trim()).filter((c) => c !== '');

const out = resolve(values.out);
const writer = new JsonlGzWriter<WireLine>(out);
const wireFetch = recordingFetch(fetch, writer);
let label: string;

if (venue === 'hl') {
  const reader = new HyperliquidReader({ network: values.testnet ? 'testnet' : 'mainnet', fetch: wireFetch });
  label = `hyperliquid ${reader.network}`;
  await step('markets', () => reader.markets());
  await step('funding', () => reader.funding());
  for (const coin of coins) await step(`book ${coin}`, () => reader.book(coin));
  await step('book NOT_A_COIN', () => reader.book('NOT_A_COIN'));   // expected to fail: the failure is what is recorded
  if (values.address !== undefined) {
    const address = values.address;
    await step('account', () => reader.account(address));
    await step('userFunding', () => reader.userFunding(address, 0));
  }
} else if (venue === 'phoenix') {
  const reader = new PhoenixReader({ fetch: wireFetch });
  label = 'phoenix mainnet';
  await step('markets', () => reader.markets());
  await step('funding', () => reader.funding());
  for (const coin of coins) await step(`book ${coin}`, () => reader.book(coin));
  await step('book NOT_A_COIN', () => reader.book('NOT_A_COIN'));
  if (values.address !== undefined) {
    const address = values.address;
    await step('account', () => reader.account(address));
    if (values.view !== undefined) {
      const path = `/v1/view/trader/${encodeURIComponent(values.view)}`;
      await step('trader view', () => phoenixGet(PHOENIX_API_URL, path, { fetch: wireFetch }));
    }
    const since = Number(values['funding-since'] ?? Date.now() - 20 * 86_400_000);
    if (!Number.isInteger(since)) fail('--funding-since must be a ms timestamp');
    await step(`userFunding since ${new Date(since).toISOString()}`, () => reader.userFunding(address, since));
  }
} else if (venue === 'watch') {
  label = 'watch venues mainnet';
  const result = await sweep([new HyperliquidReader({ fetch: wireFetch }), ...watchReaders({ fetch: wireFetch })]);
  for (const line of sweepReport(result)) console.log(line);
} else {
  const ws = new WsRequestClient();
  const reader = new OrderlyReader({
    network: values.testnet ? 'testnet' : 'mainnet',
    fetch: wireFetch,
    wsRequest: recordingWsRequester(ws.request, writer),
  });
  label = `orderly ${reader.network}`;
  const symbols = coins.map(orderlySymbol);
  try {
    await step('markets', () => reader.markets());
    await step('funding', () => reader.funding());
    for (const symbol of symbols) await step(`book ${symbol}`, () => reader.book(symbol));
    await step('book NOT_A_COIN', () => reader.book('NOT_A_COIN'));
    const end = Date.now();
    for (const symbol of symbols) await step(`funding history ${symbol}`, () => reader.marketFundingHistory(symbol, end - 3 * 86_400_000, end));
  } finally {
    ws.close();
  }
}

await writer.close();
console.log(`${label}: ${writer.lines} exchanges, ${(statSync(out).size / 1024).toFixed(1)} KiB -> ${values.out}`);

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    console.log(`${name}: ok${Array.isArray(result) ? `, ${result.length} rows` : ''}`);
  } catch (err) {
    console.log(`${name}: ${errorMessage(err)}`);
  }
}

function fail(msg: string): never {
  console.error(`capture: ${msg}`);
  process.exit(2);
}
