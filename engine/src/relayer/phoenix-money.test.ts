// Money in and out of Phoenix against a fake chain: the deposit plan is the vector deposit byte for byte, a plan says
// what is missing (registration, USDC, free collateral, SOL with the amount to send), the dry run simulates without
// signing, and sending goes to sol_sign only without refusals (rebuilt on a fresh blockhash when asked again).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TxRef } from '@gimbal/shared';
import type { SolanaMessageBuilder } from './relayer.ts';
import type { MoneyContext, SolanaChain } from './phoenix-money.ts';
import {
  MONEY_TX_LAMPORTS, SYSTEM_ACCOUNT_RENT_LAMPORTS, TOKEN_ACCOUNT_RENT_LAMPORTS, parseUsdc, planDeposit, planWithdraw, sendPlan, solNeeded, usdcText,
} from './phoenix-money.ts';
import { withdrawMessage } from './phoenix-withdraw.ts';
import { PHOENIX_MAINNET } from './phoenix-tx.ts';
import { vectors } from './test-helpers.ts';

const SOL = vectors('solana');
const DESK = { authority: SOL.desk.authority, traderAccount: SOL.desk.phoenix_trader, usdcAta: SOL.desk.usdc_ata, phusdAta: SOL.desk.phusd_ata };
const DEPOSIT = (SOL.cases as { name: string; message_hex: string; parsed: { recent_blockhash: string } }[]).find((c) => c.name === 'deposit 15 USDC (ATA, Ember wrap, Phoenix deposit)')!;
const BLOCKHASH = DEPOSIT.parsed.recent_blockhash;

function chain(state: { sol: number; usdc: bigint | null; phusd: bigint | null; trader: boolean }): SolanaChain & { simulated: number } {
  const c = {
    simulated: 0,
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1234 }),
    balance: async () => state.sol,
    tokenBalance: async (a: string) => (a === DESK.usdcAta ? state.usdc : a === DESK.phusdAta ? state.phusd : null),
    accountExists: async (a: string) => (a === DESK.traderAccount ? state.trader : true),
    simulate: async () => {
      c.simulated++;
      return { err: null, unitsConsumed: 120_000, logs: ['Program log: ok'] };
    },
    signatureSlot: async () => null,
  };
  return c;
}

const ctx = (c: SolanaChain, extra: Partial<MoneyContext> = {}): MoneyContext => ({ chain: c, desk: DESK, traderState: async () => 'cold', ...extra });

test('USDC amounts parse to base units and print back', () => {
  assert.equal(parseUsdc('15'), 15_000_000n);
  assert.equal(parseUsdc('0.5'), 500_000n);
  assert.throws(() => parseUsdc('1.0000001'), /6 decimals/);
  assert.equal(usdcText(15_250_000n), '15.250000');
});

test('the deposit plan is the vector deposit, simulated, with the PhUSD account rent counted when it is missing', async () => {
  const c = chain({ sol: 10_000_000, usdc: 20_000_000n, phusd: null, trader: true });
  const plan = await planDeposit(ctx(c), 15_000_000n);
  // The vector was built with the same 400k / 100,000 µlamports budget.
  assert.equal(Buffer.from(plan.message).toString('hex'), DEPOSIT.message_hex);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.solNeededLamports, MONEY_TX_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + SYSTEM_ACCOUNT_RENT_LAMPORTS);
  assert.equal(c.simulated, 1);
  assert.equal(plan.simulation?.unitsConsumed, 120_000);
});

test('a deposit is refused for an unregistered trader, missing USDC, and short SOL (with the amount to send)', async () => {
  const c = chain({ sol: 0, usdc: 1_000_000n, phusd: null, trader: false });
  const plan = await planDeposit(ctx(c, { traderState: async () => 'uninitialized' }), 15_000_000n);
  assert.equal(plan.refusals.length, 3);
  assert.match(plan.refusals[0]!, /not registered.*sol_sign_register/);
  assert.match(plan.refusals[1]!, /holds 1\.000000 USDC, under the 15\.000000/);
  assert.match(plan.refusals[2]!, new RegExp(`send ${(solNeeded(MONEY_TX_LAMPORTS, 1) / 1e9).toFixed(6)} SOL more`));
  const signed: string[] = [];
  await assert.rejects(sendPlan(plan, ctx(c), { solSign: async () => { signed.push('x'); return []; } }, 'fund'), /refused, nothing signed/);
  assert.deepEqual(signed, []);
});

test('a withdrawal of all takes what Phoenix lets the trader withdraw; over it is refused', async () => {
  const c = chain({ sol: 10_000_000, usdc: 0n, phusd: 0n, trader: true });
  const all = await planWithdraw(ctx(c, { withdrawable: async () => 10_000_000n }), 'all');
  assert.deepEqual([all.amount, all.refusals], [10_000_000n, []]);
  assert.equal(Buffer.from(all.message).toString('hex'), Buffer.from(withdrawMessage(PHOENIX_MAINNET, DESK, 10_000_000n, BLOCKHASH)).toString('hex'));
  const over = await planWithdraw(ctx(c, { withdrawable: async () => 10_000_000n }), 12_000_000n);
  assert.match(over.refusals.join(), /lets the trader withdraw 10\.000000 now/);
});

test('sending a plan: the planned message first, a fresh one on the relayer\'s second ask', async () => {
  const c = chain({ sol: 10_000_000, usdc: 20_000_000n, phusd: 0n, trader: true });
  const plan = await planDeposit(ctx(c), 15_000_000n);
  const seen: string[] = [];
  const tx: TxRef[] = [{ chain: 'solana', id: 'SIG', url: 'https://solscan.io/tx/SIG' }];
  const relayer = {
    solSign: async (build: SolanaMessageBuilder) => {
      seen.push((await build()).messageB64, (await build()).messageB64);
      return tx;
    },
  };
  assert.deepEqual(await sendPlan(plan, ctx(c), relayer, 'fund'), tx);
  assert.equal(Buffer.from(seen[0]!, 'base64').toString('hex'), DEPOSIT.message_hex);
  assert.equal(seen[1], seen[0], 'the same blockhash in the fake: the same bytes');
});
