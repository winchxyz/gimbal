// Captures the raw HTTP exchanges of one pass over the Hyperliquid reader, as a test fixture.
//   npm run capture -w engine -- --out fixtures/hl-wire/<name>.jsonl.gz [--testnet] [--address 0x...] [--coins ETH,BTC]
// It calls markets, funding, a book per coin, and one unknown coin (to keep the venue's real answer to it).
// With --address it adds that account's state and its whole funding history (all pages), from time 0.
// Public data only.

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import type { WireLine } from '../venues/recorder.ts';
import { JsonlGzWriter, errorMessage, recordingFetch } from '../venues/recorder.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    testnet: { type: 'boolean', default: false },
    address: { type: 'string' },
    coins: { type: 'string', default: 'ETH,BTC' },
  },
});

if (values.out === undefined) fail('--out <path.jsonl.gz> is required');
if (!values.out.endsWith('.jsonl.gz')) fail('--out must end in .jsonl.gz');
const coins = values.coins.split(',').map((c) => c.trim()).filter((c) => c !== '');

const out = resolve(values.out);
const writer = new JsonlGzWriter<WireLine>(out);
const reader = new HyperliquidReader({
  network: values.testnet ? 'testnet' : 'mainnet',
  fetch: recordingFetch(fetch, writer),
});

await step('markets', () => reader.markets());
await step('funding', () => reader.funding());
for (const coin of coins) await step(`book ${coin}`, () => reader.book(coin));
await step('book NOT_A_COIN', () => reader.book('NOT_A_COIN'));   // expected to fail: the failure is what is recorded
if (values.address !== undefined) {
  const address = values.address;
  await step('account', () => reader.account(address));
  await step('userFunding', () => reader.userFunding(address, 0));
}

await writer.close();
console.log(`${reader.network}: ${writer.lines} exchanges, ${(statSync(out).size / 1024).toFixed(1)} KiB -> ${values.out}`);

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
