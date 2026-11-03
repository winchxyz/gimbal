// The Arbitrum reads: the live reader's head (5 blocks behind the latest, with that block's own time) and its getLogs
// ranges (chunked, every block once, halved down to 100 blocks when a provider refuses a range), on a viem transport
// that answers like an RPC; and the simulated chain answering each read at the block asked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { custom, encodeAbiParameters, encodeEventTopics, numberToHex, parseAbiItem } from 'viem';
import { ARBITRUM_USDC } from '../relayer/arbitrum.ts';
import { ARBITRUM_CONFIRMATIONS, HL_BRIDGE2, LOG_CHUNK_BLOCKS, MIN_LOG_CHUNK_BLOCKS, SimulatedArbitrum, ViemArbitrumReads } from './arbitrum-chain.ts';

const DESK = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** An RPC on viem's custom transport: getLogs ranges are recorded, refused over `maxRange`, one log at `logAt`. */
function rpc(o: { latest: bigint; maxRange?: bigint; refusal?: string; logAt?: bigint }) {
  const ranges: [bigint, bigint][] = [];
  const blocks: bigint[] = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_blockNumber') return numberToHex(o.latest);
      if (method === 'eth_getBlockByNumber') {
        const n = BigInt(params![0] as string);
        blocks.push(n);
        return {
          number: numberToHex(n), timestamp: numberToHex(1_700_000_000n + n / 4n), hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'cd'.repeat(32)}`,
          transactions: [], uncles: [], logsBloom: `0x${'00'.repeat(256)}`, gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1',
        };
      }
      if (method === 'eth_getLogs') {
        const f = params![0] as { fromBlock: string; toBlock: string; address: string };
        const a = BigInt(f.fromBlock);
        const b = BigInt(f.toBlock);
        if (o.maxRange !== undefined && b - a + 1n > o.maxRange) throw Object.assign(new Error(o.refusal ?? 'query exceeds max block range'), { code: -32602 });
        ranges.push([a, b]);
        assert.equal(f.address.toLowerCase(), ARBITRUM_USDC.mainnet.token.toLowerCase());
        if (o.logAt === undefined || o.logAt < a || o.logAt > b) return [];
        return [{
          address: ARBITRUM_USDC.mainnet.token, blockNumber: numberToHex(o.logAt), blockHash: `0x${'ab'.repeat(32)}`, transactionHash: `0x${'12'.repeat(32)}`,
          transactionIndex: '0x0', logIndex: '0x3', removed: false,
          topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: HL_BRIDGE2, to: DESK } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [19_000_000n]),
        }];
      }
      throw new Error(`unexpected ${method}`);
    },
  }, { retryCount: 0 });
  return { transport, ranges, blocks };
}

test('the live head is 5 blocks behind the latest, with that block\'s own timestamp', async () => {
  const r = rpc({ latest: 1_000_000n });
  const head = await new ViemArbitrumReads({ transport: r.transport }).head();
  assert.equal(ARBITRUM_CONFIRMATIONS, 5n);
  assert.equal(head.number, 999_995n);
  assert.deepEqual(r.blocks, [999_995n], 'the timestamp is read at that block, not at the latest');
  assert.equal(head.timestampS, 1_700_000_000 + Math.floor(999_995 / 4));
});

test('getLogs: chunks of 10 000 blocks that cover the range exactly once, both ends included; a log is decoded with its id', async () => {
  const r = rpc({ latest: 100_000n, logAt: 25_000n });
  const reads = new ViemArbitrumReads({ transport: r.transport });
  const logs = await reads.transfers(HL_BRIDGE2, DESK, 5n, 25_004n);
  assert.deepEqual(r.ranges, [[5n, 10_004n], [10_005n, 20_004n], [20_005n, 25_004n]]);
  assert.equal(LOG_CHUNK_BLOCKS, 10_000n);
  assert.deepEqual(logs, [{ id: `0x${'12'.repeat(32)}:3`, from: HL_BRIDGE2, to: DESK, value: 19_000_000n, block: 25_000n }]);
  r.ranges.length = 0;
  assert.deepEqual(await reads.transfers(HL_BRIDGE2, DESK, 7n, 7n), []);
  assert.deepEqual(r.ranges, [[7n, 7n]], 'a one-block range');
  r.ranges.length = 0;
  assert.deepEqual(await reads.transfers(HL_BRIDGE2, DESK, 8n, 7n), []);
  assert.deepEqual(r.ranges, [], 'an empty range asks nothing');
});

test('getLogs: a range the provider refuses is halved (and stays halved) down to 100 blocks; below that, or another error, the read fails', async () => {
  const r = rpc({ latest: 100_000n, maxRange: 2_500n, logAt: 4_000n });
  const reads = new ViemArbitrumReads({ transport: r.transport });
  const logs = await reads.transfers(HL_BRIDGE2, DESK, 0n, 4_999n);
  assert.equal(reads.chunkBlocks, 2_500n, '10 000 -> 5 000 -> 2 500');
  assert.deepEqual(r.ranges, [[0n, 2_499n], [2_500n, 4_999n]]);
  assert.equal(logs.length, 1);
  r.ranges.length = 0;
  await reads.transfers(HL_BRIDGE2, DESK, 0n, 4_999n);
  assert.deepEqual(r.ranges, [[0n, 2_499n], [2_500n, 4_999n]], 'the next read starts at the halved size');

  const tight = rpc({ latest: 100_000n, maxRange: 50n, refusal: 'Log response size exceeded' });
  const t = new ViemArbitrumReads({ transport: tight.transport });
  await assert.rejects(t.transfers(HL_BRIDGE2, DESK, 0n, 999n), /Log response size exceeded/);
  assert.equal(t.chunkBlocks, MIN_LOG_CHUNK_BLOCKS, 'halved to the floor, never below');

  const down = rpc({ latest: 100_000n, maxRange: 1n, refusal: 'connection reset by peer' });
  const d = new ViemArbitrumReads({ transport: down.transport });
  await assert.rejects(d.transfers(HL_BRIDGE2, DESK, 0n, 999n), /connection reset/);
  assert.equal(d.chunkBlocks, LOG_CHUNK_BLOCKS, 'not a range refusal: not halved');
});

test('the simulated chain answers balance, logs and authorizationState at the block asked; its head trails the latest by 5 blocks', async () => {
  let now = 1_000_000;
  const chain = new SimulatedArbitrum({ now: () => now });
  const b0 = chain.blockAt(now);
  chain.transfer(null, DESK, 10_000_000n);
  now += 10_000;
  const b1 = chain.blockAt(now);
  chain.transfer(DESK, '0x00000000000000000000000000000000000000d1', 4_000_000n);
  chain.markUsed(DESK, '0xAB');
  now += 10_000;
  chain.setBalance(DESK, 1n);
  assert.equal(await chain.usdcBalance(DESK, b0 - 1n), 0n);
  assert.equal(await chain.usdcBalance(DESK, b0), 10_000_000n);
  assert.equal(await chain.usdcBalance(DESK, b1 - 1n), 10_000_000n, 'before the second transfer');
  assert.equal(await chain.usdcBalance(DESK, b1), 6_000_000n);
  assert.equal(await chain.usdcBalance(DESK, chain.blockAt(now)), 1n);
  assert.equal(chain.balanceNow(DESK), 1n);
  assert.equal(await chain.authorizationUsed(DESK, '0xab', b1 - 1n), false, 'not yet used at an earlier block');
  assert.equal(await chain.authorizationUsed(DESK, '0xab', b1), true);
  assert.equal((await chain.transfers(DESK, '0x00000000000000000000000000000000000000d1', b1, b1)).length, 1);
  assert.equal((await chain.transfers(DESK, '0x00000000000000000000000000000000000000d1', b0, b1 - 1n)).length, 0);
  const head = await chain.head();
  assert.equal(head.number, chain.blockAt(now) - ARBITRUM_CONFIRMATIONS);
  // A withdraw scheduled for later shows only from its block.
  chain.transfer(HL_BRIDGE2, DESK, 5_000_000n, now + 231_000);
  assert.equal((await chain.transfers(HL_BRIDGE2, DESK, 0n, chain.blockAt(now + 300_000))).length, 0, 'not before its time');
  now += 231_000;
  assert.equal((await chain.transfers(HL_BRIDGE2, DESK, 0n, chain.blockAt(now))).length, 1);
  assert.equal(await chain.usdcBalance(DESK, chain.blockAt(now) - 1n), 1n);
});
