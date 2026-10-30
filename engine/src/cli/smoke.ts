// Live smoke checks against a venue's public API; no keys, nothing is written anywhere.
//   npm run smoke -w engine -- hl [--testnet]

import { parseArgs } from 'node:util';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { errorMessage } from '../venues/recorder.ts';
import { smokeHl } from './smoke-hl.ts';

const { values, positionals } = parseArgs({
  options: { testnet: { type: 'boolean', default: false } },
  allowPositionals: true,
});

const venue = positionals[0];
if (venue !== 'hl' || positionals.length !== 1) {
  console.error('usage: npm run smoke -w engine -- hl [--testnet]');
  process.exit(2);
}

try {
  await smokeHl(new HyperliquidReader({ network: values.testnet ? 'testnet' : 'mainnet' }));
} catch (err) {
  console.error(`smoke hl failed: ${errorMessage(err)}`);
  process.exit(1);
}
