// The withdrawal and rescue messages against the shapes the contract accepts: byte for byte the vector withdrawal
// with its Revoke (solana-review.json, review 6) and the vector rescue with the Revoke appended (solana.json; the
// contract's kinds_and_the_pause_gate test accepts it so); a paused desk's rescue against the lean one the contract's
// a_paused_desk_signs_a_rescue_that_only_frees_and_pays_amount_in test accepts, and its rule for each thing it refuses.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts, RescueDeposit } from './phoenix-withdraw.ts';
import {
  ATA_PROGRAM, pausedRescueInstructions, pausedRescueMessage, pausedRescueRefusals, rescueInstructions, rescueMessage, withdrawInstructions,
  withdrawMessage,
} from './phoenix-withdraw.ts';
import type { SolInstruction } from './solana-message.ts';
import { TOKEN_PROGRAM, asSolInstructions, compileLegacyMessage, tokenTransferChecked } from './solana-message.ts';
import { COMPUTE_BUDGET_PROGRAM, computeBudgetInstructions, parseMessage } from './solana.ts';

interface VectorIx { program: string; accounts: string[]; data_hex: string }
interface VectorCase {
  name: string;
  message_hex: string;
  expect: { ok: boolean };
  parsed?: { account_keys: string[]; recent_blockhash: string; instructions: VectorIx[] };
  rescue?: { deposit_owner: string; amount_in: string };
}

const VECTORS = fileURLToPath(new URL('../../../contract/core/tests/vectors/', import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(`${VECTORS}${file}`, 'utf8')) as { cases: VectorCase[]; desk: Record<string, string> };
const SOL = load('solana.json');
const REVIEW = load('solana-review.json');
const byName = (doc: { cases: VectorCase[] }, prefix: string) => {
  const c = doc.cases.find((x) => x.name.startsWith(prefix));
  assert.ok(c !== undefined, prefix);
  return c;
};

const WITHDRAW = byName(SOL, 'withdraw 10 USDC (ATA, approve, ATA, Phoenix withdraw, Ember unwrap)');
const RESCUE = byName(SOL, 'rescue in one transaction');
const WITH_REVOKE = byName(REVIEW, 'review 6: withdraw 10 USDC with a Revoke of the desk PhUSD account after the unwrap');
const AMOUNT = 10_000_000n;     // 10 USDC
const BLOCKHASH = WITHDRAW.parsed!.recent_blockhash;

const DESK: DeskSolanaAccounts = {
  authority: SOL.desk.authority!,
  traderAccount: SOL.desk.phoenix_trader!,
  usdcAta: SOL.desk.usdc_ata!,
  phusdAta: SOL.desk.phusd_ata!,
};

/** Phoenix's and Ember's accounts, read off the vector withdrawal by their places in withdraw_funds and the unwrap. */
function exchangeOf(c: VectorCase): PhoenixExchangeAccounts {
  const ixs = c.parsed!.instructions;
  const withdraw = ixs.find((ix) => ix.data_hex.startsWith('f1241d6fd01f68d9'))!.accounts;
  const unwrap = ixs.find((ix) => ix.data_hex.startsWith('b712469c946da122'))!.accounts;
  assert.equal(withdraw.length, 12, 'one global trader index and one active trader buffer account');
  return {
    phoenixProgram: withdraw[0]!, logAuthority: withdraw[1]!, globalConfiguration: withdraw[2]!,
    perpAssetMap: withdraw[5]!, globalVault: withdraw[6]!, globalTraderIndex: [withdraw[9]!], activeTraderBuffer: [withdraw[10]!],
    withdrawQueue: withdraw[11]!,
    emberState: unwrap[1]!, usdcMint: unwrap[2]!, canonicalMint: unwrap[3]!, emberVault: unwrap[6]!,
  };
}
const EXCHANGE = exchangeOf(WITHDRAW);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * A vector message with Revoke [token program, (desk PhUSD account, authority), data 5] appended, as the contract's
 * kinds_and_the_pause_gate test builds the shapes it accepts: every key is already in the message, so only the
 * instruction count (after the keys and the blockhash) and the tail change.
 */
function withRevokeAppended(c: VectorCase): string {
  const keys = c.parsed!.account_keys;
  const bytes = Buffer.from(c.message_hex, 'hex');
  const at = 3 + 1 + keys.length * 32 + 32;
  const count = bytes[at]!;
  assert.equal(count, c.parsed!.instructions.length);
  return Buffer.concat([
    bytes.subarray(0, at), Buffer.of(count + 1), bytes.subarray(at + 1),
    Buffer.of(keys.indexOf(TOKEN_PROGRAM), 2, keys.indexOf(DESK.phusdAta), keys.indexOf(DESK.authority), 1, 5),
  ]).toString('hex');
}

test('the withdrawal is the vector withdrawal with the Revoke of the desk PhUSD account after the unwrap', () => {
  assert.equal(WITH_REVOKE.expect.ok, true);
  // Review 6's accepted withdrawal is exactly the SDK's vector withdrawal plus the appended Revoke.
  assert.equal(withRevokeAppended(WITHDRAW), WITH_REVOKE.message_hex);
  const built = withdrawMessage(EXCHANGE, DESK, AMOUNT, BLOCKHASH);
  assert.equal(hex(built), WITH_REVOKE.message_hex);
  // The last instruction is the Revoke: SPL Token 5 on the desk PhUSD account, by the desk authority.
  const last = withdrawInstructions(EXCHANGE, DESK, AMOUNT).at(-1)!;
  assert.deepEqual(
    { program: last.programAddress, accounts: last.accounts!.map((a) => a.address), data: [...(last.data as Uint8Array)] },
    { program: TOKEN_PROGRAM, accounts: [DESK.phusdAta, DESK.authority], data: [5] },
  );
  const m = parseMessage(built);
  assert.deepEqual([m.version, m.signers, m.keys[0], m.computeUnitLimit, m.computeUnitPrice], ['legacy', 1, DESK.authority, 400_000, 100_000n]);
  assert.equal(m.instructions.length, 8);
});

test('the rescue is the vector rescue with the Revoke appended, after the unwrap and the TransferChecked', () => {
  const r = RESCUE.rescue!;
  const deposit = { owner: r.deposit_owner, usdcAta: RESCUE.parsed!.instructions.at(-1)!.accounts[2]!, amountIn: BigInt(r.amount_in) };
  assert.deepEqual(exchangeOf(RESCUE), EXCHANGE);
  const built = rescueMessage(EXCHANGE, DESK, AMOUNT, deposit, RESCUE.parsed!.recent_blockhash);
  assert.equal(hex(built), withRevokeAppended(RESCUE));
  assert.ok(built.length <= 1232, `${built.length} bytes, over Solana's 1232`);
  const programs = rescueInstructions(EXCHANGE, DESK, AMOUNT, deposit).map((ix) => ix.programAddress.slice(0, 8));
  assert.deepEqual(programs, ['ComputeB', 'ComputeB', 'ATokenGP', 'Tokenkeg', 'ATokenGP', 'EtrnLzgb', 'EMBERpYN', 'ATokenGP', 'Tokenkeg', 'Tokenkeg']);
});

// ---- A paused desk's rescue ----

const R = RESCUE.rescue!;
const DEPOSIT: RescueDeposit = { owner: R.deposit_owner, usdcAta: RESCUE.parsed!.instructions.at(-1)!.accounts[2]!, amountIn: BigInt(R.amount_in) };
const RESCUE_HASH = RESCUE.parsed!.recent_blockhash;
const parsedShape = (m: Uint8Array) => parseMessage(m).instructions.map((ix) => ({ program: ix.program, accounts: ix.accounts, data: Buffer.from(ix.data).toString('hex') }));
const refusals = (ixs: readonly SolInstruction[]) => pausedRescueRefusals(compileLegacyMessage(DESK.authority, ixs, RESCUE_HASH), EXCHANGE, DESK, DEPOSIT);
/** A vector instruction as a SolInstruction: the desk authority signs, every other account is writable (the rule reads no roles). */
const fromVector = (ix: VectorIx): SolInstruction => ({
  programAddress: ix.program,
  accounts: ix.accounts.map((address) => ({ address, role: address === DESK.authority ? 3 : 1 })),
  data: Buffer.from(ix.data_hex, 'hex'),
});
const vectorIx = (casePrefix: string, program: string, dataPrefix: string) => {
  const ix = byName(SOL, casePrefix).parsed!.instructions.find((x) => x.program === program && x.data_hex.startsWith(dataPrefix));
  assert.ok(ix !== undefined, `${casePrefix}: ${dataPrefix}`);
  return fromVector(ix);
};
const PHOENIX = EXCHANGE.phoenixProgram;
const LEAN = pausedRescueInstructions(EXCHANGE, DESK, AMOUNT, DEPOSIT);
const at = (ixs: readonly SolInstruction[], program: string, dataPrefix: string) => {
  const i = ixs.findIndex((ix) => ix.programAddress === program && Buffer.from(ix.data ?? []).toString('hex').startsWith(dataPrefix));
  assert.ok(i >= 0, dataPrefix);
  return i;
};
const withData = (ix: SolInstruction, edit: (data: Buffer) => Buffer): SolInstruction => ({ ...ix, data: edit(Buffer.from(ix.data ?? [])) });
const u64At = (offset: number, value: bigint) => (data: Buffer) => {
  const d = Buffer.from(data);
  d.writeBigUInt64LE(value, offset);
  return d;
};

test('a paused rescue is the contract\'s lean rescue: the full one without the priority fee and the desk-account creates', () => {
  assert.equal(DEPOSIT.amountIn, AMOUNT);
  const built = pausedRescueMessage(EXCHANGE, DESK, AMOUNT, DEPOSIT, RESCUE_HASH);
  // The contract's a_paused_desk_signs_a_rescue_that_only_frees_and_pays_amount_in builds its accepted message so:
  // the vector rescue with the Revoke appended, less SetComputeUnitPrice and the creates whose owner is the desk.
  const lean = [...RESCUE.parsed!.instructions, { program: TOKEN_PROGRAM, accounts: [DESK.phusdAta, DESK.authority], data_hex: '05' }]
    .filter((ix) => !(ix.program === COMPUTE_BUDGET_PROGRAM && ix.data_hex.startsWith('03')))
    .filter((ix) => !(ix.program === ATA_PROGRAM && ix.accounts[2] === DESK.authority))
    .map((ix) => ({ program: ix.program, accounts: ix.accounts, data: ix.data_hex }));
  assert.equal(lean.length, RESCUE.parsed!.instructions.length + 1 - 3);
  assert.deepEqual(parsedShape(built), lean);
  const m = parseMessage(built);
  assert.deepEqual([m.computeUnitLimit, m.computeUnitPrice, m.keys[0], m.signers], [400_000, null, DESK.authority, 1]);
  assert.deepEqual(pausedRescueRefusals(built, EXCHANGE, DESK, DEPOSIT), []);
  // Less than amountIn may be withdrawn (the desk USDC account holds the rest); more never.
  assert.deepEqual(refusals(pausedRescueInstructions(EXCHANGE, DESK, AMOUNT - 1n, DEPOSIT)), []);
  assert.throws(() => pausedRescueInstructions(EXCHANGE, DESK, AMOUNT + 1n, DEPOSIT), /at most amountIn 10000000, not 10000001/);
  assert.throws(() => pausedRescueInstructions(EXCHANGE, DESK, 0n, DEPOSIT), /more than 0/);
});

test('a paused desk refuses the rescue as the SDK builds it: both desk-account creates (its priority fee is for 400,000 units)', () => {
  const full = refusals(rescueInstructions(EXCHANGE, DESK, AMOUNT, DEPOSIT));
  assert.equal(full.length, 2, full.join('; '));
  assert.match(full[0]!, new RegExp(`^instruction 2: a create of the desk's own token account ${DESK.phusdAta}$`));
  assert.match(full[1]!, new RegExp(`^instruction 4: a create of the desk's own token account ${DESK.usdcAta}$`));
});

test('a paused rescue may pay a priority fee for at most 400,000 units, at most 1,000,000 µlamports per CU', () => {
  const priced = (units: number, price: number) => {
    const [limit, fee] = asSolInstructions(computeBudgetInstructions(units, price));
    return [limit!, fee!, ...LEAN.slice(1)];
  };
  assert.deepEqual(refusals(priced(400_000, 100_000)), []);
  assert.deepEqual(refusals(priced(400_000, 1_000_000)), []);
  assert.deepEqual(refusals(priced(400_001, 100_000)), ['instruction 1: a priority fee of 100000 µlamports per CU with a limit of 400001 units, over 400000']);
  assert.deepEqual(refusals(priced(400_000, 1_000_001)), ['instruction 1: a priority fee of 1000001 µlamports per CU, over 1000000']);
  assert.deepEqual(refusals([asSolInstructions(computeBudgetInstructions())[1]!, ...LEAN.slice(1)]), ['instruction 0: a priority fee of 100000 µlamports per CU with no compute-unit limit']);
});

// One case per thing a paused rescue may not carry, each the lean rescue with that one thing put back or made larger.
const REFUSED: [string, () => SolInstruction[], RegExp][] = [
  ['a compute-unit price over 400,000 units', () => {
    const [limit, fee] = asSolInstructions(computeBudgetInstructions(400_001));
    return [limit!, fee!, ...LEAN.slice(1)];
  }, /a priority fee of 100000 µlamports per CU with a limit of 400001 units/],
  ['a create of the desk USDC account', () => [...LEAN.slice(0, 1), rescueInstructions(EXCHANGE, DESK, AMOUNT, DEPOSIT)[4]!, ...LEAN.slice(1)], /a create of the desk's own token account/],
  ['an order', () => [...LEAN, vectorIx('market sell 0.005 ETH', PHOENIX, '5a76c0fcc0632791')], /a Phoenix place_market_order/],
  ['a cancel', () => [...LEAN, vectorIx('cancel all ETH', PHOENIX, '62bf4bdc732847ed')], /a Phoenix cancel_all/],
  ['a deposit', () => [...LEAN, vectorIx('deposit 15 USDC', PHOENIX, 'ca2734d33514fa58')], /a Phoenix deposit_funds/],
  ['a wrap', () => [...LEAN, vectorIx('deposit 15 USDC', 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy', 'f223c68952e1f2b6')], /an Ember wrap/],
  ['a withdrawal of amountIn + 1', () => {
    const ixs = [...LEAN];
    const w = at(ixs, PHOENIX, 'f1241d6fd01f68d9');
    ixs[w] = withData(ixs[w]!, u64At(8, AMOUNT + 1n));
    return ixs;
  }, /^Phoenix withdrawals of 10000001 in all, over amountIn 10000000$/],
  ['two withdrawals of amountIn', () => {
    const ixs = [...LEAN];
    const w = at(ixs, PHOENIX, 'f1241d6fd01f68d9');
    ixs.splice(w, 0, ixs[w]!);
    return ixs;
  }, /^Phoenix withdrawals of 20000000 in all/],
  ['an unwrap of amountIn + 1', () => {
    const ixs = [...LEAN];
    const u = at(ixs, 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy', 'b712469c946da122');
    ixs[u] = withData(ixs[u]!, u64At(9, AMOUNT + 1n));
    const a = at(ixs, TOKEN_PROGRAM, '04');
    ixs[a] = withData(ixs[a]!, u64At(1, AMOUNT + 1n));
    return ixs;
  }, /^Ember unwraps of 10000001 in all, over amountIn 10000000$/],
  ['an unwrap of the whole balance', () => {
    const ixs = LEAN.filter((ix) => !(ix.programAddress === TOKEN_PROGRAM && Buffer.from(ix.data ?? []).toString('hex').startsWith('04')));
    const u = at(ixs, 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy', 'b712469c946da122');
    ixs[u] = withData(ixs[u]!, (d) => Buffer.concat([d.subarray(0, 8), Buffer.of(0)]));
    return ixs;
  }, /an Ember unwrap of the whole balance/],
  ['a transfer into a desk account', () => [...LEAN, tokenTransferChecked(DESK.usdcAta, EXCHANGE.usdcMint, DESK.phusdAta, DESK.authority, 1n, 6)], /a TransferChecked into the desk account/],
];

for (const [what, build, refusal] of REFUSED) {
  test(`a paused rescue may not carry ${what}`, () => {
    const got = refusals(build());
    assert.equal(got.length, 1, got.join('; '));
    assert.match(got[0]!, refusal);
  });
}

test('a TransferChecked of nothing is refused before it is built: the contract refuses empty transfers', () => {
  assert.throws(() => tokenTransferChecked(DESK.usdcAta, EXCHANGE.usdcMint, DESK.phusdAta, DESK.authority, 0n, 6), /not a u64 above 0/);
  assert.throws(() => tokenTransferChecked(DESK.usdcAta, EXCHANGE.usdcMint, DESK.phusdAta, DESK.authority, 1n << 64n, 6), /not a u64 above 0/);
});
