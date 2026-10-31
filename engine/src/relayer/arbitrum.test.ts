// The Arbitrum submitter against a stub RPC: the transferWithAuthorization the gas wallet sends is byte for byte the
// calldata of eip3009.json; an expired, used or foreign authorization costs no gas; once sent, no receipt is
// OutcomeUnknown with the hash, and a send error with a receipt after it is a success; the RPC URL's key never
// reaches an error.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { custom, decodeFunctionData, keccak256, parseTransaction } from 'viem';
import type { Hex } from 'viem';
import { ReplayContractClient } from '../contract/replay-client.ts';
import type { Eip3009SignedAction } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import { ARBITRUM_USDC, ArbitrumSubmitter, USDC_EIP3009_ABI } from './arbitrum.ts';
import { TEST_EVM_ADDRESS, testDesk, vectors } from './test-helpers.ts';
import { NothingExecuted } from './tx.ts';

const V = vectors('eip3009');
const CASE = V.cases.find((c: { network: string; desk_id: string }) => c.network === 'testnet' && c.desk_id === 'alpha');
/** A gas-wallet key for tests only: never funded. */
const GAS_KEY: Hex = `0x${'05'.repeat(32)}`;
const AUTH_STATE = '0xe94a0102';   // authorizationState(address,bytes32)

async function signedCase(): Promise<Eip3009SignedAction> {
  const c = new ReplayContractClient({
    config: { network: 'testnet', hlBuilder: '0x2222222222222222222222222222222222222222', hlBuilderTenthBps: 10 },
    desks: { alpha: testDesk() }, keys: { alpha: { evm: V.keys.deskEvm.private_key } }, now: () => CASE.now_s * 1000,
  });
  const quote = { quote: { depositAddress: CASE.message.to, amountIn: CASE.message.value }, quote_signature: 'ed25519:test' };
  for (let i = 0n; i < BigInt(CASE.counter); i++) await c.evmUsdcToIntents('alpha', quote, 'earlier');
  return c.evmUsdcToIntents('alpha', quote, 'rescue to the deposit address');
}

function chain(options: { used?: boolean; reverted?: boolean; sendFails?: boolean; sendMessage?: string; noReceipt?: boolean } = {}) {
  const sent: Hex[] = [];
  const methods: string[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      methods.push(method);
      const p = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_chainId': return '0x66eee';
        case 'eth_call': {
          const data = (p[0] as { data: Hex }).data;
          if (data.startsWith(AUTH_STATE)) return `0x${(options.used ? '1' : '0').padStart(64, '0')}`;
          return '0x';
        }
        case 'eth_getTransactionCount': return '0x0';
        case 'eth_estimateGas': return '0x30d40';
        case 'eth_gasPrice': return '0x989680';
        case 'eth_maxPriorityFeePerGas': return '0x0';
        case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'11'.repeat(32)}`, baseFeePerGas: '0x989680', timestamp: '0x1', transactions: [] };
        case 'eth_sendRawTransaction': {
          sent.push(p[0] as Hex);
          if (options.sendFails) throw Object.assign(new Error(options.sendMessage ?? 'the request took too long to respond'), { code: -32603 });
          return keccak256(p[0] as Hex);
        }
        case 'eth_getTransactionReceipt': {
          const hash = p[0] as Hex;
          if (options.noReceipt) return null;
          return {
            transactionHash: hash, status: options.reverted ? '0x0' : '0x1', blockNumber: '0x11', blockHash: `0x${'22'.repeat(32)}`,
            transactionIndex: '0x0', from: '0x0', to: ARBITRUM_USDC.testnet.token, cumulativeGasUsed: '0x1', gasUsed: '0x1',
            effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, type: '0x2', contractAddress: null,
          };
        }
        case 'eth_blockNumber': return '0x11';
        // Like most public RPCs: no eth_fillTransaction, so viem fills the transaction itself (-32601 is not retried).
        default: throw Object.assign(new Error(`the method ${method} does not exist`), { code: -32601 });
      }
    },
  });
  return { transport, sent, methods };
}

function submitter(transport: ReturnType<typeof custom>, nowS = CASE.now_s, receiptTimeoutMs?: number) {
  return new ArbitrumSubmitter({
    network: 'testnet', relayerKey: GAS_KEY, transport, now: () => nowS * 1000, ...(receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs }),
  });
}

test('transferWithAuthorization: the gas wallet sends exactly the vector calldata to Arbitrum Sepolia USDC', async () => {
  const c = chain();
  const signed = await signedCase();
  const tx = await submitter(c.transport).submit(signed, TEST_EVM_ADDRESS);
  assert.equal(c.sent.length, 1);
  const raw = parseTransaction(c.sent[0]!);
  assert.equal(raw.chainId, 421614);
  assert.equal(raw.to?.toLowerCase(), ARBITRUM_USDC.testnet.token.toLowerCase());
  assert.equal(raw.data, CASE.calldata);
  assert.equal(decodeFunctionData({ abi: USDC_EIP3009_ABI, data: raw.data! }).functionName, 'transferWithAuthorization');
  const hash = keccak256(c.sent[0]!);
  assert.deepEqual(tx, [{ chain: 'arbitrum', id: hash, url: `https://sepolia.arbiscan.io/tx/${hash}` }]);
  assert.ok(c.methods.indexOf('eth_call') < c.methods.indexOf('eth_sendRawTransaction'));
});

test('no gas spent on an authorization that is used, expiring, from someone else or signed for another chain', async () => {
  const signed = await signedCase();
  const used = chain({ used: true });
  // Used means the transfer ran somewhere (anyone may submit it): never "nothing executed".
  await assert.rejects(submitter(used.transport).submit(signed, TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.match(err.message, /already used/);
    assert.equal(err.ids.eip3009Nonce, signed.payload.nonce);
    return true;
  });
  const late = chain();
  await assert.rejects(submitter(late.transport, Number(CASE.message.validBefore) - 30).submit(signed, TEST_EVM_ADDRESS), /too soon to send/);
  const other = chain();
  await assert.rejects(submitter(other.transport).submit(signed, '0x000000000000000000000000000000000000dEaD'), /is not the desk's/);
  const forged = { ...signed, payload: { ...signed.payload, value: '9999999999' } };
  await assert.rejects(submitter(other.transport).submit(forged, TEST_EVM_ADDRESS), /recovers to .* nothing sent/);
  const mainnet = { ...signed, payload: { ...signed.payload, chainId: 42161 } };
  await assert.rejects(submitter(other.transport).submit(mainnet, TEST_EVM_ADDRESS), /signed for chain 42161/);
  for (const c of [used, late, other]) assert.equal(c.sent.length, 0);
});

test('a reverted transfer is NothingExecuted with the transaction that paid the gas', async () => {
  const c = chain({ reverted: true });
  await assert.rejects(submitter(c.transport).submit(await signedCase(), TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof NothingExecuted);
    assert.match(err.message, /reverted/);
    assert.equal(err.tx[0]?.chain, 'arbitrum');
    return true;
  });
});

test('sent but no receipt in time: OutcomeUnknown with the transaction hash, known before it was sent', async () => {
  const c = chain({ noReceipt: true });
  const signed = await signedCase();
  await assert.rejects(submitter(c.transport, CASE.now_s, 50).submit(signed, TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    const hash = keccak256(c.sent[0]!);
    assert.equal(err.ids.arbitrumTx, hash);
    assert.equal(err.ids.eip3009Nonce, signed.payload.nonce);
    assert.equal(err.tx.at(-1)?.id, hash);
    return true;
  });
  assert.equal(c.sent.length, 1);
});

test('a send error after the node took the transaction: its receipt still decides', async () => {
  const c = chain({ sendFails: true });
  const tx = await submitter(c.transport).submit(await signedCase(), TEST_EVM_ADDRESS);
  assert.equal(tx.at(-1)?.id, keccak256(c.sent[0]!));
});

test('the RPC URL viem quotes in an error loses its path and query (the API key) before it reaches OutcomeUnknown', async () => {
  const rpcUrl = 'https://arb-sepolia.example.org/v2/0123456789abcdefSECRET';
  const c = chain({ sendFails: true, noReceipt: true, sendMessage: `HTTP request failed. URL: ${rpcUrl} Details: timeout` });
  const s = new ArbitrumSubmitter({
    network: 'testnet', relayerKey: GAS_KEY, transport: c.transport, rpcUrl, now: () => CASE.now_s * 1000, receiptTimeoutMs: 50,
  });
  await assert.rejects(s.submit(await signedCase(), TEST_EVM_ADDRESS), (err: unknown) => {
    assert.ok(err instanceof OutcomeUnknown, String(err));
    assert.ok(!err.message.includes('0123456789abcdefSECRET'), err.message);
    assert.ok(!err.detail.includes('0123456789abcdefSECRET'), err.detail);
    assert.match(err.message, /arb-sepolia\.example\.org\/…/);
    return true;
  });
});
