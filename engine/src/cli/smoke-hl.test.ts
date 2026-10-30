import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HyperliquidReader } from '../venues/hyperliquid.ts';
import { readWireRecording, replayFetch } from '../venues/replay.ts';
import { smokeHl } from './smoke-hl.ts';

const DIR = fileURLToPath(new URL('../../fixtures/hl-wire/', import.meta.url));

async function run(file: string, network: 'mainnet' | 'testnet'): Promise<string[]> {
  const out: string[] = [];
  const reader = new HyperliquidReader({ network, fetch: replayFetch(readWireRecording(join(DIR, file))) });
  await smokeHl(reader, (line) => out.push(line));
  return out;
}

test('smoke prints the ETH funding (per hour and APR) and the top 5 book levels, mainnet', async () => {
  const out = await run('hl-mainnet-2026-10-30.jsonl.gz', 'mainnet');
  assert.match(out[0]!, /Hyperliquid mainnet\s+https:\/\/api\.hyperliquid\.xyz\/info/);
  assert.match(out[1]!, /^ETH\s+asset index 1, 4 size decimals, max leverage 25x/);
  const funding = out.find((l) => l.startsWith('funding'))!;
  assert.match(funding, /per hour .*%\/h\)\s+APR -?\d+\.\d\d %/);
  assert.match(funding, /next payment \d{4}-\d\d-\d\dT\d\d:00:00\.000Z/);
  const bookAt = out.findIndex((l) => l.startsWith('ETH book at'));
  assert.ok(bookAt > 0);
  const levels = out.slice(bookAt + 2, bookAt + 7);
  assert.equal(levels.length, 5);
  for (const l of levels) assert.match(l, /^\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/);
  assert.match(out.at(-1)!, /^spread\s+\d+\.\d{4} \(\d+\.\d\d bps\)$/);
});

test('smoke on the testnet shows the testnet asset index, not the mainnet one', async () => {
  const out = await run('hl-testnet-2026-10-30.jsonl.gz', 'testnet');
  assert.match(out[0]!, /Hyperliquid testnet\s+https:\/\/api\.hyperliquid-testnet\.xyz\/info/);
  assert.match(out[1]!, /^ETH\s+asset index 4,/);
});
