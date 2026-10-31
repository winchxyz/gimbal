// The withdrawal and rescue messages against the shapes the contract accepts: byte for byte the vector withdrawal
// with its Revoke (solana-review.json, review 6) and the vector rescue with the Revoke appended (solana.json; the
// contract's kinds_and_the_pause_gate test accepts it so).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DeskSolanaAccounts, PhoenixExchangeAccounts } from './phoenix-withdraw.ts';
import { rescueInstructions, rescueMessage, withdrawInstructions, withdrawMessage } from './phoenix-withdraw.ts';
import { TOKEN_PROGRAM, tokenTransferChecked } from './solana-message.ts';
import { parseMessage } from './solana.ts';

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

test('a TransferChecked of nothing is refused before it is built: the contract refuses empty transfers', () => {
  assert.throws(() => tokenTransferChecked(DESK.usdcAta, EXCHANGE.usdcMint, DESK.phusdAta, DESK.authority, 0n, 6), /not a u64 above 0/);
  assert.throws(() => tokenTransferChecked(DESK.usdcAta, EXCHANGE.usdcMint, DESK.phusdAta, DESK.authority, 1n << 64n, 6), /not a u64 above 0/);
});
