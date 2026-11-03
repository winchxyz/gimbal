// The live Phoenix routes on a fake Solana: the rescue payer's three messages (spare USDC, a Phoenix withdrawal, a
// paused desk's lean rescue), each refusal before signing, one sol_sign_rescue per quote and never a second message,
// an MPC timeout held as an outcome unknown; the Phoenix credit's readiness, its delivery check and the sol_sign
// deposit within the 200,000 µlamports cap, and its landing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TxRef } from '@gimbal/shared';
import type { SignedQuote, SolSignedAction } from '../contract/types.ts';
import { MpcTimeoutError, OutcomeUnknown } from '../contract/types.ts';
import type { Simulation, SolanaChain } from '../relayer/phoenix-money.ts';
import type { DeskSolanaAccounts } from '../relayer/phoenix-withdraw.ts';
import type { SolanaMessageBuilder } from '../relayer/relayer.ts';
import type { SolanaSendOptions } from '../relayer/solana.ts';
import { parseMessage } from '../relayer/solana.ts';
import type { VerifiedQuote } from './oneclick.ts';
import { PhoenixDeskCredit, PhoenixRescuePayer, VenueLandings, planPhoenixRescue, usdcAccountOf } from './sol-rescue.ts';
import type { PhoenixDesk } from './sol-rescue.ts';

const VECTORS = fileURLToPath(new URL('../../../contract/core/tests/vectors/solana.json', import.meta.url));
const SOL = JSON.parse(readFileSync(VECTORS, 'utf8')) as { desk: Record<string, string>; cases: { name: string; rescue?: { deposit_owner: string } }[] };
const DESK: DeskSolanaAccounts = { authority: SOL.desk.authority!, traderAccount: SOL.desk.phoenix_trader!, usdcAta: SOL.desk.usdc_ata!, phusdAta: SOL.desk.phusd_ata! };
const OWNER = SOL.cases.find((c) => c.rescue !== undefined)!.rescue!.deposit_owner;
const HASH = 'DmnJBJP8mVBgNwKATxATdJe19x6ridh4pjzzs6SCxRh7';
const LVBH = 300_000_000;
const SOL_OK = 10_000_000;            // 0.01 SOL

interface FakeChain extends SolanaChain {
  sol: number;
  tokens: Map<string, bigint>;
  exists: Set<string>;
  simErr: unknown;
  simulated: Uint8Array[];
  landed: Map<string, number>;
}

function chain(over: Partial<Pick<FakeChain, 'sol' | 'simErr'>> = {}): FakeChain {
  const c: FakeChain = {
    sol: SOL_OK, tokens: new Map([[DESK.usdcAta, 0n], [DESK.phusdAta, 0n]]), exists: new Set([DESK.traderAccount]), simErr: null, simulated: [], landed: new Map(),
    latestBlockhash: async () => ({ blockhash: HASH, lastValidBlockHeight: LVBH }),
    balance: async () => c.sol,
    tokenBalance: async (a) => c.tokens.get(a) ?? null,
    accountExists: async (a) => c.exists.has(a) || c.tokens.has(a),
    simulate: async (m): Promise<Simulation> => {
      c.simulated.push(m);
      return { err: c.simErr, unitsConsumed: 48_000, logs: c.simErr === null ? [] : ['Program log: insufficient funds'] };
    },
    signatureSlot: async (s) => c.landed.get(s) ?? null,
    ...over,
  };
  Object.assign(c, over);
  return c;
}

const desk = (paused = false): (() => Promise<PhoenixDesk>) => async () => ({ accounts: DESK, paused });
const quote = (amountIn = 5_000_000n): VerifiedQuote => ({
  method: 'sol_sign_rescue', quote: '{"q":1}', signature: 'ed25519:sig', depositAddress: OWNER, amountIn, amountInE8: amountIn * 100n,
  amountOut: amountIn * 100n - 32_000_000n, minAmountOut: amountIn * 100n - 33_000_000n, minAmountOutE8: amountIn * 100n - 33_000_000n,
  destinationAsset: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', recipient: '0x06d4', costE8: 33_000_000n, signedAtMs: 0, deadlineMs: 0, timeEstimateS: 30,
});

/** The contract's sol_sign_rescue: signs what it is given (a fixed 64-byte signature) and records the call. */
function contract(fail?: Error) {
  const calls: { messageB64: string; quote: SignedQuote; reason: string }[] = [];
  return {
    calls,
    solSignRescue: async (deskId: string, messageB64: string, q: SignedQuote, reason: string): Promise<SolSignedAction> => {
      calls.push({ messageB64, quote: q, reason });
      if (fail !== undefined) throw fail;
      return {
        desk_id: deskId, request_id: 1, venue: 'solana', kind: 'rescue', payload: { message_b64: messageB64 },
        signature: { scheme: 'Ed25519', signature: Array.from({ length: 64 }, (_, i) => i + 1) },
        nearTx: { chain: 'near', id: 'NEARTX1', url: '' } as TxRef,
      };
    },
  };
}

function sender() {
  const sent: { signed: SolSignedAction; options: SolanaSendOptions }[] = [];
  return { sent, submit: async (signed: SolSignedAction, options: SolanaSendOptions) => (sent.push({ signed, options }), [{ chain: 'solana', id: 'SOLSIG', url: '' } as TxRef]) };
}

const kinds = (m: Uint8Array) => parseMessage(m).instructions.map((ix) => ix.program.slice(0, 8));

test('a rescue paid from spare USDC: no Phoenix withdrawal, the deposit owner account and one TransferChecked, simulated', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 7_000_000n);
  const plan = await planPhoenixRescue({ chain: c, desk: desk(), withdrawable: async () => assert.fail('no Phoenix read is needed') }, OWNER, 5_000_000n);
  assert.equal(plan.kind, 'spare');
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.withdrawE6, 0n);
  assert.equal(plan.deposit.usdcAta, await usdcAccountOf(OWNER));
  assert.deepEqual(kinds(plan.message), ['ComputeB', 'ComputeB', 'ATokenGP', 'Tokenkeg']);
  const m = parseMessage(plan.message);
  assert.deepEqual([m.computeUnitLimit, m.computeUnitPrice, m.keys[0]], [100_000, 100_000n, DESK.authority]);
  assert.equal(plan.lastValidBlockHeight, LVBH);
  assert.equal(c.simulated.length, 1);
  // The fee, the deposit owner's account rent and the rent-exempt reserve.
  assert.equal(plan.solNeededLamports, 5_000 + 10_000 + 2_039_280 + 890_880);
});

test('a rescue that needs Phoenix: withdraw what the USDC account lacks, Ember unwrap, the transfer of amountIn, the Revoke', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 1_000_000n);
  const plan = await planPhoenixRescue({ chain: c, desk: desk(), withdrawable: async () => 20_000_000n }, OWNER, 5_000_000n);
  assert.equal(plan.kind, 'withdraw');
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.withdrawE6, 4_000_000n);
  const ixs = parseMessage(plan.message).instructions;
  const withdraw = ixs.find((ix) => Buffer.from(ix.data).subarray(0, 8).toString('hex') === 'f1241d6fd01f68d9')!;
  assert.equal(Buffer.from(withdraw.data).readBigUInt64LE(8), 4_000_000n);
  const transfer = ixs.filter((ix) => ix.program.startsWith('Tokenkeg') && ix.data[0] === 12).at(-1)!;
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(1), 5_000_000n);
  assert.equal(transfer.accounts[2], plan.deposit.usdcAta);
  assert.equal(ixs.at(-1)!.data[0], 5, 'the Revoke last');
});

test('a paused desk gets the lean rescue: no priority fee, no create of a desk account', async () => {
  const plan = await planPhoenixRescue({ chain: chain(), desk: desk(true), withdrawable: async () => 20_000_000n }, OWNER, 5_000_000n);
  assert.equal(plan.kind, 'paused');
  assert.deepEqual(plan.refusals, []);
  const m = parseMessage(plan.message);
  assert.equal(m.computeUnitPrice, null);
  assert.ok(!m.instructions.some((ix) => ix.program.startsWith('ATokenGP') && ix.accounts[2] === DESK.authority));
});

test('refused before signing: too little SOL, too little to withdraw, an unreadable Phoenix, a failed simulation', async () => {
  const poor = await planPhoenixRescue({ chain: chain({ sol: 1_000_000 }), desk: desk(), withdrawable: async () => 20_000_000n }, OWNER, 5_000_000n);
  assert.match(poor.refusals.join('\n'), /holds 0.001000 SOL; this rescue needs .* send .* more/);
  const short = await planPhoenixRescue({ chain: chain(), desk: desk(), withdrawable: async () => 3_000_000n }, OWNER, 5_000_000n);
  assert.match(short.refusals.join('\n'), /needs 5.000000 USDC out of Phoenix, but Phoenix lets the trader withdraw 3.000000/);
  const unread = await planPhoenixRescue({ chain: chain(), desk: desk(), withdrawable: async () => { throw new Error('HTTP 503'); } }, OWNER, 5_000_000n);
  assert.match(unread.refusals.join('\n'), /could not be read \(HTTP 503\): nothing is signed unread/);
  const failed = await planPhoenixRescue({ chain: chain({ simErr: { InstructionError: [5, 'Custom'] } }), desk: desk(), withdrawable: async () => 20_000_000n }, OWNER, 5_000_000n);
  assert.match(failed.refusals.join('\n'), /fails in simulation .*insufficient funds/);
  // The payer turns any refusal into a prepare() failure, before the hold and before any signature.
  const k = contract();
  const payer = new PhoenixRescuePayer({ deskId: 'canary', chain: chain({ sol: 0 }), desk: desk(), withdrawable: async () => 20_000_000n, contract: k, sender: sender() });
  await assert.rejects(payer.prepare(quote()), /the Phoenix rescue is refused: the desk authority/);
  assert.equal(k.calls.length, 0);
});

test('the payer signs exactly the prepared message once, sends it with its lastValidBlockHeight, and never builds another', async () => {
  const k = contract();
  const s = sender();
  const c = chain();
  c.tokens.set(DESK.usdcAta, 9_000_000n);
  const payer = new PhoenixRescuePayer({ deskId: 'canary', chain: c, desk: desk(), withdrawable: async () => 0n, contract: k, sender: s });
  const q = quote();
  const prepared = await payer.prepare(q);
  assert.deepEqual(prepared, { solana: { lastValidBlockHeight: LVBH } });
  const signed = await payer.sign(q, 'rescue r1', prepared);
  assert.equal(k.calls.length, 1);
  assert.equal(k.calls[0]!.messageB64, Buffer.from(c.simulated[0]!).toString('base64'), 'the simulated message is the one signed');
  assert.deepEqual(k.calls[0]!.quote, { quote: q.quote, quote_signature: q.signature });
  assert.equal(typeof signed.solanaSignature, 'string');
  assert.deepEqual(signed.tx.map((t) => t.id), ['NEARTX1']);
  const sent = await signed.send();
  assert.equal(sent.depositTx, signed.solanaSignature, '1Click is told the Solana signature');
  assert.deepEqual(s.sent[0]!.options, { authority: DESK.authority, lastValidBlockHeight: LVBH });
  // The same quote again: nothing prepared is left, so nothing is signed.
  await assert.rejects(payer.sign(q, 'rescue r1', prepared), /no prepared Phoenix rescue message/);
  assert.equal(k.calls.length, 1);
});

test('an MPC timeout is an outcome unknown with the message digest and its height bound: the rescuer holds it', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 9_000_000n);
  const k = contract(new MpcTimeoutError('sol_sign_rescue', 'no answer in 120 s', 'NEARTX9'));
  const payer = new PhoenixRescuePayer({ deskId: 'canary', chain: c, desk: desk(), withdrawable: async () => 0n, contract: k, sender: sender() });
  const q = quote();
  const prepared = await payer.prepare(q);
  const err = await payer.sign(q, 'r', prepared).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof OutcomeUnknown, String(err));
  assert.equal(err.ids.nearTx, 'NEARTX9');
  assert.equal(err.ids.solLastValidBlockHeight, LVBH);
  assert.match(err.ids.solMessage ?? '', /^[0-9a-f]{64}$/);
});

// ---- Phoenix as the target ----

function credit(c: FakeChain, over: { paused?: boolean; state?: string | null } = {}) {
  const signedMessages: Uint8Array[] = [];
  let t = 0;
  const k = new PhoenixDeskCredit({
    network: 'mainnet', chain: c, desk: desk(over.paused ?? false), traderState: async () => over.state ?? 'active',
    clock: { now: () => t }, sleep: async (ms) => { t += ms; }, deliveryTimeoutMs: 30_000,
    solSign: async (build: SolanaMessageBuilder) => {
      const { messageB64 } = await build();
      signedMessages.push(Buffer.from(messageB64, 'base64'));
      return [{ chain: 'near', id: 'NEARDEP', url: '' } as TxRef, { chain: 'solana', id: 'DEPSIG', url: '' } as TxRef];
    },
  });
  return { k, signedMessages };
}

test('Phoenix credit: ready says why no deposit could follow, before anything is paid', async () => {
  assert.equal(await credit(chain()).k.ready(), null);
  assert.match((await credit(chain(), { paused: true }).k.ready())!, /paused/);
  assert.match((await credit(chain(), { state: 'uninitialized' }).k.ready())!, /not registered \(sol_sign_register\)/);
  assert.match((await credit(chain({ sol: 1_000 })).k.ready())!, /holds 0.000001 SOL, under the/);
});

test('Phoenix credit: the delivery confirmed on Solana and on the desk USDC account, then one sol_sign deposit at 100,000 µlamports', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 10_500_000n);
  c.landed.set('5'.repeat(88), 123);
  const { k, signedMessages } = credit(c);
  const { tx } = await k.credit(10_000_000n, 'rescue r2: into Phoenix', { deliveryTx: ['5'.repeat(88)] });
  assert.deepEqual(tx.map((x) => x.id), ['NEARDEP', 'DEPSIG']);
  assert.equal(signedMessages.length, 1);
  const m = parseMessage(signedMessages[0]!);
  assert.ok(m.computeUnitPrice !== null && m.computeUnitPrice <= 200_000n, 'within the plain sol_sign cap');
  const deposit = m.instructions.find((ix) => Buffer.from(ix.data).subarray(0, 8).toString('hex') === 'ca2734d33514fa58');
  assert.ok(deposit !== undefined, 'a Phoenix deposit_funds');
  // The landing is that deposit, once.
  const landing = new VenueLandings({ phoenix: k.landing() });
  const q = { minAmountOut: 10_000_000n } as VerifiedQuote;
  const entry = await landing.find('phoenix', q, 0, new Set());
  assert.equal(entry?.id, 'phoenix:DEPSIG');
  assert.equal(await landing.find('phoenix', q, 0, new Set([entry!.id])), null);
  assert.match(landing.confirms('orderly')!, /cannot be confirmed here/);
});

test('Phoenix credit: no deposit when 1Click\'s delivery is not on Solana, or the USDC never shows on the desk account', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 10_500_000n);
  await assert.rejects(credit(c).k.credit(10_000_000n, 'r', { deliveryTx: ['4'.repeat(88)] }), /is not on Solana: nothing was deposited/);
  const empty = chain();
  const { k, signedMessages } = credit(empty);
  await assert.rejects(k.credit(10_000_000n, 'r'), /holds 0.000000 USDC, under the 0.000000 before the payment plus the 10.000000 delivered: nothing was deposited/);
  assert.equal(signedMessages.length, 0);
});

test('Phoenix credit: USDC already on the desk account (dust) is not the delivery: the wait counts above the baseline saved before the payment', async () => {
  const c = chain();
  c.tokens.set(DESK.usdcAta, 400_000n);
  const { k, signedMessages } = credit(c);
  assert.equal(await k.baseline(), 400_000n);
  // 10 USDC on the account is not 10 delivered on top of the 0.4 dust.
  c.tokens.set(DESK.usdcAta, 10_000_000n);
  await assert.rejects(k.credit(10_000_000n, 'r', { baseE6: 400_000n }), /holds 10.000000 USDC, under the 0.400000 before the payment plus the 10.000000 delivered: nothing was deposited/);
  assert.equal(signedMessages.length, 0);
  c.tokens.set(DESK.usdcAta, 10_400_000n);
  await k.credit(10_000_000n, 'r', { baseE6: 400_000n });
  assert.equal(signedMessages.length, 1, 'deposited once the delivery is there');
  // No account yet: the baseline is zero.
  assert.equal(await credit(chain()).k.baseline(), 0n);
  assert.match(k.manual(10_000_000n), /pair-mainnet fund-phoenix 10.000000 \(dry\), then again with --send/);
});

test('Phoenix credit: a stop while the delivery is awaited gives up at once with nothing signed', async () => {
  const c = chain();
  const { k, signedMessages } = credit(c);
  let polls = 0;
  await assert.rejects(k.credit(10_000_000n, 'r', { stopping: () => ++polls >= 2 }), /the engine is stopping while the delivery was awaited: nothing was deposited/);
  assert.equal(polls, 2);
  assert.equal(signedMessages.length, 0);
});
