// The desk's Solana messages that take USDC out of Phoenix, for `sol_sign` (a withdrawal) and `sol_sign_rescue` (the
// C6 rescue, one transaction): the compute budget, the Phoenix SDK's withdrawal (create the desk PhUSD account,
// Approve Ember on it, create the desk USDC account, Phoenix withdraw_funds, the Ember unwrap PhUSD -> USDC), then
// for a rescue the deposit owner's USDC account and the TransferChecked of amountIn into it, and last a Revoke of the
// desk PhUSD account: since contract commit 31f5bab an unwrap that spends an Approve needs that Revoke after it, so
// no allowance outlives the message. The shapes are the contract's accepted ones (vectors/solana.json withdraw and
// rescue with the Revoke appended, solana-review.json review 6).
// Not wired into a flow yet: the withdrawal and rescue callers build their messages here once they exist.

import { buildCreateAssociatedTokenAccountIdempotentSync, buildWithdrawIxsResolved } from '@ellipsis-labs/rise';
import type { BuildWithdrawIxsResolvedInput } from '@ellipsis-labs/rise';
import type { SolInstruction } from './solana-message.ts';
import { asSolInstructions, compileLegacyMessage, tokenRevoke, tokenTransferChecked } from './solana-message.ts';
import { computeBudgetInstructions } from './solana.ts';

/** USDC's decimals: the rescue's TransferChecked states them. */
const USDC_DECIMALS = 6;

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
  const createDepositAta = buildCreateAssociatedTokenAccountIdempotentSync({
    payer: desk.authority,
    ataAddress: deposit.usdcAta,
    owner: deposit.owner,
    mint: exchange.usdcMint,
  } as Parameters<typeof buildCreateAssociatedTokenAccountIdempotentSync>[0]);
  return [
    ...asSolInstructions(computeBudgetInstructions()),
    ...sdkWithdraw(exchange, desk, amount),
    createDepositAta,
    tokenTransferChecked(desk.usdcAta, exchange.usdcMint, deposit.usdcAta, desk.authority, deposit.amountIn, USDC_DECIMALS),
    tokenRevoke(desk.phusdAta, desk.authority),
  ];
}

export function withdrawMessage(exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, recentBlockhash: string): Uint8Array {
  return compileLegacyMessage(desk.authority, withdrawInstructions(exchange, desk, amount), recentBlockhash);
}

export function rescueMessage(
  exchange: PhoenixExchangeAccounts, desk: DeskSolanaAccounts, amount: bigint, deposit: RescueDeposit, recentBlockhash: string,
): Uint8Array {
  return compileLegacyMessage(desk.authority, rescueInstructions(exchange, desk, amount, deposit), recentBlockhash);
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
