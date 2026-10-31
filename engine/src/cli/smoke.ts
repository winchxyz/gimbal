// Live smoke checks against a venue's public API; no keys, nothing is written anywhere.
//   npm run smoke -w engine -- hl [--testnet]
//   npm run smoke -w engine -- phoenix            (mainnet only: Phoenix has no public testnet API)
//   npm run smoke -w engine -- orderly [--testnet]
//   npm run smoke -w engine -- sol                SOL funding per hour and APR on Hyperliquid, Phoenix and Orderly

import { parseArgs } from 'node:util';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { PhoenixReader } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import { smokeHl } from './smoke-hl.ts';
import { smokeOrderly, smokePhoenix, smokeSol } from './smoke-venues.ts';

const USAGE = 'usage: npm run smoke -w engine -- hl|orderly [--testnet]  |  phoenix  |  sol';

const { values, positionals } = parseArgs({
  options: { testnet: { type: 'boolean', default: false } },
  allowPositionals: true,
});

const target = positionals[0];
if (positionals.length !== 1 || !['hl', 'phoenix', 'orderly', 'sol'].includes(target ?? '')) fail(USAGE, 2);
if (values.testnet && (target === 'phoenix' || target === 'sol')) fail(`smoke ${target}: mainnet only`, 2);
const network = values.testnet ? 'testnet' : 'mainnet';

const phoenix = new PhoenixReader();
const orderly = new OrderlyReader({ network });
try {
  if (target === 'hl') await smokeHl(new HyperliquidReader({ network }));
  else if (target === 'phoenix') await smokePhoenix(phoenix);
  else if (target === 'orderly') await smokeOrderly(orderly);
  else if (!(await smokeSol({ hyperliquid: new HyperliquidReader(), phoenix, orderly }))) process.exitCode = 1;
} catch (err) {
  console.error(`smoke ${target} failed: ${errorMessage(err)}`);
  process.exitCode = 1;
} finally {
  phoenix.close();
  orderly.close();
}

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}
