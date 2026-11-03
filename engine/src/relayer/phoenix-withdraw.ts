// The desk's Solana messages that take USDC out of Phoenix, for `sol_sign` (a withdrawal) and `sol_sign_rescue` (the
// C6 rescue, one transaction): the compute budget, the Phoenix SDK's withdrawal (create the desk PhUSD account,
// Approve Ember on it, create the desk USDC account, Phoenix withdraw_funds, the Ember unwrap PhUSD -> USDC), then
// for a rescue the deposit owner's USDC account and the TransferChecked of amountIn into it, and last a Revoke of the
// desk PhUSD account: since contract commit 31f5bab an unwrap that spends an Approve needs that Revoke after it, so
// no allowance outlives the message. The shapes are the contract's accepted ones (vectors/solana.json withdraw and
// rescue with the Revoke appended, solana-review.json review 6).
//
// A paused desk's rescue is leaner (pausedRescueMessage): sol_sign_rescue signs one for a paused desk only when it
// frees and pays amountIn and nothing else, with a priority fee only for a compute-unit limit of at most 400,000 units
// (at most 1,000,000 µlamports per CU; phoenix.rs check_message, rescue mode). The builder takes: the compute-unit
// limit without a price, the Approve, withdraw_funds and Ember unwrap of at most amountIn, the deposit
// owner's account and the TransferChecked, the Revoke; not the creates of the desk's own token accounts (they exist:
// every deposit went through them). pausedRescueRefusals is that rule on the engine's side, checked before signing.
// Not wired into a flow yet: the withdrawal and rescue callers build their messages here once they exist.

import { buildCreateAssociatedTokenAccountIdempotentSync, buildWithdrawIxsResolved } from '@ellipsis-labs/rise';
import type { BuildWithdrawIxsResolvedInput } from '@ellipsis-labs/rise';
import type { SolInstruction } from './solana-message.ts';
import { TOKEN_PROGRAM, asSolInstructions, compileLegacyMessage, tokenRevoke, tokenTransferChecked } from './solana-message.ts';
import { COMPUTE_BUDGET_PROGRAM, computeBudgetInstructions, parseMessage } from './solana.ts';

/** The most compute units a paused rescue may pay a priority fee for (the contract's RESCUE_MAX_COMPUTE_UNIT_LIMIT). */
export const PAUSED_RESCUE_FEE_MAX_UNITS = 400_000;
/** The most a rescue may pay per unit (the contract's URGENT_MAX_COMPUTE_UNIT_PRICE). */
export const URGENT_MAX_MICROLAMPORTS = 1_000_000n;

/** USDC's decimals: the rescue's TransferChecked states them. */
const USDC_DECIMALS = 6;

export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const EMBER_PROGRAM = 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy';

/** Anchor discriminators (sha256("global:<name>")[0..8]) the paused-rescue rule tells apart, as the contract's. */
const PHOENIX_IX: Record<string, string> = {
  '5a76c0fcc0632791': 'place_market_order',
  '62bf4bdc732847ed': 'cancel_all',
  'ca2734d33514fa58': 'deposit_funds',
  'f1241d6fd01f68d9': 'withdraw_funds',
};
const WITHDRAW_FUNDS = 'f1241d6fd01f68d9';
const EMBER_WRAP = 'f223c68952e1f2b6';      // Ember deposit: USDC into PhUSD
const EMBER_UNWRAP = 'b712469c946da122';    // Ember withdraw: PhUSD back into USDC

/** Phoenix's and Ember's accounts a withdrawal names (base58), as the SDK's exchange cache resolves them. */
export interface PhoenixExchangeAccounts {
  phoenixProgram: string;
  logAuthority: string;
  globalConfiguration: string;
  canonicalMint: string;           // PhUSD
  usdcMint: string;
  perpAssetMap: string;
  globalVault: string;
  withdrawQueue: string;
  globalTraderIndex: readonly string[];
  activeTraderBuffer: readonly string[];
  emberState: string;              // the Ember authority the Approve names
  emberVault: string;
}

/** The desk's own Solana accounts: its authority (the MPC key, fee payer and only signer) and what it owns. */
export interface DeskSolanaAccounts {
  authority: string;
  traderAccount: string;           // the Phoenix trader PDA
  usdcAta: string;
  phusdAta: string;
}

/** Where a rescue sends the USDC: the 1Click deposit owner's USDC account, created in the same message. */
export interface RescueDeposit {
  owner: string;
  usdcAta: string;
  amountIn: bigint;                // USDC base units, the quote's amountIn
}

/** The instructions of a withdrawal of `amount` PhUSD base units (1:1 USDC) from Phoenix to the desk's USDC account. */
export function withdrawInstructions(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint): SolInstruction[] {
  return [...asSolInstructions(computeBudgetInstructions()), ...sdkWithdraw(exchange, desk, amount), tokenRevoke(desk.phusdAta, desk.authority)];
}

/** A rescue: the withdrawal, then `amountIn` USDC to the deposit owner, then the Revoke. */
export function rescueInstructions(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, deposit: RescueDeposit): SolInstruction[] {
  return [
    ...asSolInstructions(computeBudgetInstructions()),
    ...sdkWithdraw(exchange, desk, amount),
    ...payDeposit(exchange, desk, deposit),
    tokenRevoke(desk.phusdAta, desk.authority),
  ];
}

/**
 * A paused desk's rescue (see the header): the compute-unit limit, the SDK's withdrawal of `amount` without the
 * creates of the desk's token accounts, the deposit owner's account and amountIn into it, the Revoke. `amount` is at
 * most amountIn: a paused desk frees no more than the rescue pays out.
 */
export function pausedRescueInstructions(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, deposit: RescueDeposit): SolInstruction[] {
  if (amount <= 0n || amount > deposit.amountIn) {
    throw new Error(`a paused rescue withdraws more than 0 and at most amountIn ${deposit.amountIn}, not ${amount}`);
  }
  const [limit] = asSolInstructions(computeBudgetInstructions());
  return [
    limit!,
    ...sdkWithdraw(exchange, desk, amount).filter((ix) => !(ix.programAddress === ATA_PROGRAM && ix.accounts?.[2]?.address === desk.authority)),
    ...payDeposit(exchange, desk, deposit),
    tokenRevoke(desk.phusdAta, desk.authority),
  ];
}

/** The deposit owner's USDC account (the idempotent create, paid by the desk) and the TransferChecked of amountIn. */
function payDeposit(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, deposit: RescueDeposit): SolInstruction[] {
  const createDepositAta = buildCreateAssociatedTokenAccountIdempotentSync({
    payer: desk.authority,
    ataAddress: deposit.usdcAta,
    owner: deposit.owner,
    mint: exchange.usdcMint,
  } as Parameters<typeof buildCreateAssociatedTokenAccountIdempotentSync>[0]);
  return [
    createDepositAta,
    tokenTransferChecked(desk.usdcAta, exchange.usdcMint, deposit.usdcAta, desk.authority, deposit.amountIn, USDC_DECIMALS),
  ];
}

/**
 * Why a paused desk's sol_sign_rescue would refuse `message`, by the contract's rule for it (phoenix.rs check_message
 * in rescue mode: reduces_risk is rescue_pause_ok and a priority fee only for at most 400,000 units); empty when it
 * signs it. Refused on a paused desk: a priority fee with no compute-unit limit, a limit over 400,000 or a price over
 * 1,000,000 µlamports, a create of the desk's own token account, a Phoenix order, cancel or deposit, an Ember wrap,
 * an unwrap of the whole balance, a Transfer or a TransferChecked into a desk account, and withdrawals or unwraps that
 * add up to more than amountIn. The checks every rescue gets (accounts in their places, the one TransferChecked of
 * amountIn) stay the contract's; an instruction outside the rescue's kinds is named here too.
 */
export function pausedRescueRefusals(message: Uint8Array, exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, deposit: RescueDeposit): string[] {
  const refused: string[] = [];
  let withdrawn = 0n;
  let unwrapped = 0n;
  let limit: number | null = null;
  let fee: { n: number; price: bigint } | null = null;
  const deskAccount = (a: string | undefined) => a === desk.usdcAta || a === desk.phusdAta;
  for (const [n, ix] of parseMessage(message).instructions.entries()) {
    const no = (what: string) => refused.push(`instruction ${n}: ${what}`);
    const data = Buffer.from(ix.data);
    const disc = data.subarray(0, 8).toString('hex');
    if (ix.program === COMPUTE_BUDGET_PROGRAM) {
      if (data[0] === 2 && data.length === 5) limit = data.readUInt32LE(1);
      if (data[0] === 3 && data.length === 9 && data.readBigUInt64LE(1) > 0n) fee = { n, price: data.readBigUInt64LE(1) };
    } else if (ix.program === ATA_PROGRAM) {
      if (ix.accounts[2] === desk.authority) no(`a create of the desk's own token account ${ix.accounts[1]}`);
      else if (ix.accounts[2] !== deposit.owner) no(`a create of a token account for ${ix.accounts[2]}, not the deposit owner`);
    } else if (ix.program === TOKEN_PROGRAM) {
      const op = data[0];
      if (op === 12 && deskAccount(ix.accounts[2])) no(`a TransferChecked into the desk account ${ix.accounts[2]}`);
      else if (op === 12 && ix.accounts[2] !== deposit.usdcAta) no(`a TransferChecked into ${ix.accounts[2]}, not the deposit owner's account`);
      else if (op === 3) no('a Transfer');
      else if (op !== 4 && op !== 5 && op !== 12) no(`token instruction ${op}`);   // Approve and Revoke go with the unwrap
    } else if (ix.program === EMBER_PROGRAM) {
      if (disc === EMBER_UNWRAP && data[8] === 1 && data.length === 17) unwrapped += data.readBigUInt64LE(9);
      else if (disc === EMBER_UNWRAP) no('an Ember unwrap of the whole balance');
      else no(disc === EMBER_WRAP ? 'an Ember wrap (USDC into PhUSD)' : `Ember instruction ${disc}`);
    } else if (ix.program === exchange.phoenixProgram) {
      if (disc === WITHDRAW_FUNDS && data.length === 16) withdrawn += data.readBigUInt64LE(8);
      else no(`a Phoenix ${PHOENIX_IX[disc] ?? disc}`);
    } else {
      no(`program ${ix.program}`);
    }
  }
  if (fee !== null && (limit === null || limit > PAUSED_RESCUE_FEE_MAX_UNITS)) {
    refused.unshift(`instruction ${fee.n}: a priority fee of ${fee.price} µlamports per CU with ${limit === null ? 'no compute-unit limit' : `a limit of ${limit} units, over ${PAUSED_RESCUE_FEE_MAX_UNITS}`}`);
  } else if (fee !== null && fee.price > URGENT_MAX_MICROLAMPORTS) {
    refused.unshift(`instruction ${fee.n}: a priority fee of ${fee.price} µlamports per CU, over ${URGENT_MAX_MICROLAMPORTS}`);
  }
  if (withdrawn > deposit.amountIn) refused.push(`Phoenix withdrawals of ${withdrawn} in all, over amountIn ${deposit.amountIn}`);
  if (unwrapped > deposit.amountIn) refused.push(`Ember unwraps of ${unwrapped} in all, over amountIn ${deposit.amountIn}`);
  return refused;
}

export function withdrawMessage(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, recentBlockhash: string): Uint8Array {
  return compileLegacyMessage(desk.authority, withdrawInstructions(exchange, desk, amount), recentBlockhash);
}

export function rescueMessage(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, deposit: RescueDeposit, recentBlockhash: string,
): Uint8Array {
  return compileLegacyMessage(desk.authority, rescueInstructions(exchange, desk, amount, deposit), recentBlockhash);
}

/** The paused desk's rescue message, checked against the paused-rescue rule before it goes to sol_sign_rescue. */
export function pausedRescueMessage(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, deposit: RescueDeposit, recentBlockhash: string,
): Uint8Array {
  const message = compileLegacyMessage(desk.authority, pausedRescueInstructions(exchange, desk, amount, deposit), recentBlockhash);
  const refused = pausedRescueRefusals(message, exchange, desk, deposit);
  if (refused.length > 0) throw new Error(`a paused desk's sol_sign_rescue would refuse this rescue: ${refused.join('; ')}`);
  return message;
}

function sdkWithdraw(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint): SolInstruction[] {
  // The SDK's address types are branded strings; these are plain base58 strings of the same addresses.
  const input = {
    exchange: {
      phoenixProgramAddress: exchange.phoenixProgram,
      logAuthorityAddress: exchange.logAuthority,
      globalConfigurationAddress: exchange.globalConfiguration,
      canonicalMint: exchange.canonicalMint,
      usdcMint: exchange.usdcMint,
      perpAssetMap: exchange.perpAssetMap,
      globalVault: exchange.globalVault,
      withdrawQueue: exchange.withdrawQueue,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
      emberState: exchange.emberState,
      emberVault: exchange.emberVault,
    },
    trader: { authority: desk.authority, traderAccount: desk.traderAccount, usdcTokenAccount: desk.usdcAta, phoenixTokenAccount: desk.phusdAta },
    amount,
  } as unknown as BuildWithdrawIxsResolvedInput;
  return buildWithdrawIxsResolved(input).instructions as unknown as SolInstruction[];
}
