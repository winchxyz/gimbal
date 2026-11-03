#!/usr/bin/env node
// Brings a desk's USDC on Hyperliquid back to the desk on NEAR, in two stages (tools/mainnet/README.md, section 8,
// "Return from Hyperliquid"). 1Click quotes nothing out of HyperCore, so the route goes through Arbitrum:
//
//   node tools/mainnet/hl-return.mjs <contract> <desk_id> withdraw <amount USDC | all>
//        [--key-file <owner key json>] [--timeout-s <s, default 900>] [--again] [--send]
//   node tools/mainnet/hl-return.mjs <contract> <desk_id> bridge <amount USDC | all>
//        [--key-file <operator key json>] [--slippage-bps <n, default 100>] [--timeout-s <s, default 900>] [--again] [--send]
//
//   withdraw  Hyperliquid perps -> the desk's own EVM address on Arbitrum. The owner signs hl_withdraw(desk_id,
//             amount) with 1 yoctoNEAR (owner only: --key-file is a full-access key of the desk owner); the contract
//             has the desk's EVM key sign a Hyperliquid withdraw3 to the desk's address, which is posted to
//             /exchange (the engine's HyperliquidSubmitter). Hyperliquid takes its 1 USDC fee out of the amount, so
//             amount - 1 arrives as Arbitrum USDC, usually within a few minutes. `all` = the perps withdrawable.
//   bridge    Arbitrum USDC of the desk's EVM address -> USDC on NEAR credited to the desk. The operator key signs
//             evm_usdc_to_intents(desk_id, quote, quote_signature, reason): an EIP-3009 TransferWithAuthorization of
//             the quote's amountIn to the 1Click deposit address, which the relayer's gas wallet
//             (RELAYER_EVM_PRIVATE_KEY, environment or .env) submits on Arbitrum and pays the gas for (the engine's
//             ArbitrumSubmitter). 1Click then sends USDC on NEAR to the contract with ft_transfer_call and msg
//             {"desk_id":"<id>"}; from a sender other than the owner, ft_on_transfer adds it to idle_usdc only
//             (never to deposited: a return is not principal). `all` = the desk EVM's whole Arbitrum USDC.
//             Refunds go to the desk EVM address on Arbitrum. It counts against the desk's hourly rescue cap and
//             rescue cost budget.
//
// Default: a dry run that reads mainnet (Hyperliquid /info, the Arbitrum RPC, a DRY 1Click quote) and signs
// nothing. --send reads the key file, only then, checks it against the chain and refuses in a linked git worktree.
// The script makes only hl_withdraw (withdraw) and evm_usdc_to_intents (bridge); any other contract call is
// refused before it is signed. No key or .env value is printed. ARBITRUM_RPC_URL (shell environment) replaces the
// public Arbitrum RPC, printed as its host. Every read fails closed. It ends with one block to paste back.
//
// Reruns: withdraw --send refuses while a Hyperliquid withdrawal under 30 min old exists, or while an earlier
// hl_withdraw's withdraw3 (nearblocks, checked against the desk's Hyperliquid nonce) is not booked in the ledger
// and still inside Hyperliquid's nonce window (its time + 2 days). bridge --send refuses while an earlier
// evm_usdc_to_intents's authorization (valid until its block time + 300 s) may still be used or its 1Click deposit
// has not settled (SUCCESS, REFUNDED, or expired unused). --again sends anyway; the dry run lists the same reasons.

import { UsageError, envValues, isMain, parseFlags, run } from './cli.mjs';
import {
  NEARBLOCKS_API, arbitrumBalances, arbitrumGasPrice, hyperliquidLedger, hyperliquidPerps, rpcUrls, unitsText,
} from './balances.mjs';
import { sendRefusal } from './checks.mjs';
import { OPERATOR_METHODS, operatorKeyFile } from './desk.mjs';
import {
  ROOT, act, describeTx, freeBalance, fullAccessVerdict, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp, panicOf,
  readKeyFile, sleep as pause, tgasText, txGasCap, txLink,
} from './near.mjs';
import { DESK_ID, ONE_YOCTO, eventsOf, ledgerOf, ledgerText, moneyContext, parseUsdc, summaryBlock, usdcText } from './money.mjs';
import {
  ASSETS, FINAL_STATUSES, QuoteRefusal, allowedCostE8, canonicalQuote, checkCost, quoteStatus, requestQuote, rescueCostBudgetE8, submitDeposit,
  transferCostE8, usdE8Text, verifyQuote,
} from './oneclick.mjs';
import { ENTRY as RELAYER_ENTRY, ethText, evmAddressOf } from './relayer-wallet.mjs';
import { hlNonceOf } from './retire.mjs';
import { OWNER_GAS_MARGIN } from './withdraw.mjs';

export const STAGES = ['withdraw', 'bridge'];
/** The only contract call each stage may make; anything else is refused before it is signed. */
export const ALLOWED_CALLS = { withdraw: ['hl_withdraw'], bridge: ['evm_usdc_to_intents'] };
/** Hyperliquid's withdrawal fee, USDC x 1e6, taken out of the amount withdrawn. */
export const HL_WITHDRAW_FEE_E6 = 1_000_000n;
/** What these scripts attach to an action method (one that signs through the MPC); the contract refuses under 85. */
export const ACTION_TGAS = 300n;
export const ACTION_MIN_TGAS = 85;
/**
 * The gas the relayer wallet must be able to pay for one transferWithAuthorization: a bound with headroom (one
 * such transfer takes on the order of 100,000 to 200,000 gas on Arbitrum, its L1 data part included).
 */
export const RELAYER_GAS_UNITS = 500_000n;
/** The Hyperliquid ledger is read this far back for withdrawals that may still be on their way to Arbitrum. */
export const LEDGER_LOOKBACK_MS = 24 * 3_600_000;
/** A withdrawal booked this recently may still be on its way (Hyperliquid's bridge usually takes minutes). */
export const IN_FLIGHT_MS = 30 * 60_000;
/** Ledger entries this long before the hl_withdraw was sent still count (clock skew between here and HL). */
const LEDGER_SLACK_MS = 60_000;
/** Polls after 1Click says SUCCESS while the ledger has not shown the credit yet. */
const POLLS_AFTER_SUCCESS = 30;

/** Hyperliquid takes a user-signed action (withdraw3) until about 2 days after its time: its nonce window. */
export const HL_REPLAY_MS = 2 * 86_400_000;
/** evm_usdc_to_intents signs validBefore = block time + 300 s; a minute of slack for clocks and the receipt's block. */
export const AUTH_VALID_MS = 300_000;
const AUTH_SLACK_MS = 60_000;
/** The bridge stage looks this far back for earlier authorizations (1Click's own deposit window is far shorter). */
export const BRIDGE_LOOKBACK_MS = 24 * 3_600_000;
/** A Hyperliquid signature this recent may not be indexed by nearblocks yet. */
const INDEX_LAG_MS = 10 * 60_000;
/** An earlier hl_withdraw's withdraw3 time is the receipt block's (or a little later, when the desk's nonce was ahead). */
const NONCE_AHEAD_MS = 3_000n;
/** The Hyperliquid submitter's own wait for the ledger entry, before this script's announced wait takes over. */
const SUBMIT_CONFIRM_MS = 5_000;

const USAGE = `usage: node tools/mainnet/hl-return.mjs <contract> <desk_id> withdraw <amount USDC | all> [--key-file <owner key json>] [--timeout-s <s>] [--again] [--send]
       node tools/mainnet/hl-return.mjs <contract> <desk_id> bridge <amount USDC | all> [--key-file <operator key json>] [--slippage-bps <n>] [--timeout-s <s>] [--again] [--send]
  default: dry run (reads mainnet and asks a dry 1Click quote; signs nothing, no key needed)
  --again: send although an earlier withdrawal or authorization of the stage may still land (read the printed reasons first)`;
const SPEC = { '--key-file': 'value', '--slippage-bps': 'value', '--timeout-s': 'value', '--send': 'switch', '--again': 'switch' };

export function parseHlReturnArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 4) throw new UsageError('the contract, the desk id, the stage (withdraw or bridge) and the amount (or all) are required');
  if (positional.length > 4) throw new UsageError(`unexpected argument ${positional[4]}`);
  const [contract, deskId, stage, amountText] = positional;
  let amount = null;
  try {
    mainnetId(contract, 'contract');
    if (amountText !== 'all') amount = parseUsdc(amountText);
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  if (!STAGES.includes(stage)) throw new UsageError(`stage ${stage} is not one of ${STAGES.join(', ')}`);
  const send = values['--send'] === true;
  if (stage === 'withdraw' && values['--slippage-bps'] !== undefined) throw new UsageError('--slippage-bps is for the bridge stage (the withdraw stage asks no quote)');
  if (stage === 'withdraw' && send && values['--key-file'] === undefined) throw new UsageError('withdraw --send needs --key-file: only the desk owner can sign hl_withdraw');
  const slippage = values['--slippage-bps'] === undefined ? 100 : Number(values['--slippage-bps']);
  if (!Number.isInteger(slippage) || slippage < 10 || slippage > 300) throw new UsageError('--slippage-bps must be a whole number from 10 to 300');
  const timeoutS = values['--timeout-s'] === undefined ? 900 : Number(values['--timeout-s']);
  if (!Number.isInteger(timeoutS) || timeoutS < 60 || timeoutS > 3600) throw new UsageError('--timeout-s must be a whole number from 60 to 3600');
  return {
    contract, deskId, stage, amount, slippage, timeoutS, send, again: values['--again'] === true,
    keyFile: values['--key-file'] ?? (stage === 'bridge' ? operatorKeyFile(contract) : null),
  };
}

/** Why a transaction is not one this stage may send, or null: the contract only, the stage's one method only. */
export function callProblem(stage, contract, receiver, actions) {
  if (receiver !== contract) return `a transaction to ${receiver}: this script calls ${contract} only; refused, nothing was signed`;
  for (const a of actions) {
    if (a.type !== 'FunctionCall' || !(ALLOWED_CALLS[stage] ?? []).includes(a.method)) {
      return `${a.type === 'FunctionCall' ? a.method : a.type} is not a call of the ${stage} stage (${(ALLOWED_CALLS[stage] ?? []).join(', ')}): refused, nothing was signed`;
    }
  }
  return null;
}

/** client.send, but only for the stage's call (callProblem); refused before anything is signed. */
export function guardedSend(client, stage, contract) {
  return (signer, receiver, actions, options) => {
    const problem = callProblem(stage, contract, receiver, actions);
    if (problem !== null) return Promise.reject(new Error(problem));
    return client.send(signer, receiver, actions, options);
  };
}

// --- withdraw ---

/**
 * The amount to withdraw, USDC x 1e6, and what reaches Arbitrum: `asked` (null = all of `withdrawableE6`), at most
 * the withdrawable, more than Hyperliquid's 1 USDC fee.
 */
export function withdrawPlan(asked, withdrawableE6) {
  const amount = asked ?? withdrawableE6;
  if (amount > withdrawableE6) {
    throw new Error(`${usdcText(amount)} USDC is over the desk's Hyperliquid perps withdrawable, ${usdcText(withdrawableE6)}: Hyperliquid refuses it`);
  }
  if (amount <= HL_WITHDRAW_FEE_E6) {
    throw new Error(`${usdcText(amount)} USDC ${asked === null ? '(all of the withdrawable) ' : ''}is not more than Hyperliquid's ${usdcText(HL_WITHDRAW_FEE_E6)} USDC withdrawal fee: nothing would arrive`);
  }
  return { amount, arrival: amount - HL_WITHDRAW_FEE_E6 };
}

/** hl_withdraw's call: the amount as the contract takes it, a canonical decimal string (at most 6 decimals). */
export const hlWithdrawActions = (deskId, amountE6) => [act.call('hl_withdraw', { desk_id: deskId, amount: usdcText(amountE6) }, ACTION_TGAS, ONE_YOCTO)];

/** Why the SignedAction hl_withdraw returned is not the withdrawal asked for (an empty list when it is). */
/** The signatureChainId the contract signs user-signed Hyperliquid actions with (contract/core/src/hl.rs). */
export const HL_SIGNATURE_CHAIN_ID = '0x66eee';

export function withdrawActionProblems(signed, { deskId, evm, amountText, hyperliquidChain = 'Mainnet' }) {
  const out = [];
  const action = signed?.payload?.action ?? {};
  if (signed?.desk_id !== deskId) out.push(`signed for desk ${signed?.desk_id}, not ${deskId}`);
  if (signed?.venue !== 'hyperliquid') out.push(`venue ${signed?.venue}, not hyperliquid`);
  if (action.type !== 'withdraw3') out.push(`action type ${action.type}, not withdraw3`);
  if (action.hyperliquidChain !== hyperliquidChain) out.push(`hyperliquidChain ${JSON.stringify(action.hyperliquidChain)} is not ${JSON.stringify(hyperliquidChain)}`);
  if (typeof action.signatureChainId !== 'string' || action.signatureChainId.toLowerCase() !== HL_SIGNATURE_CHAIN_ID) {
    out.push(`signatureChainId ${JSON.stringify(action.signatureChainId)} is not ${JSON.stringify(HL_SIGNATURE_CHAIN_ID)}`);
  }
  if (typeof action.destination !== 'string' || action.destination.toLowerCase() !== evm.toLowerCase()) out.push(`destination ${action.destination} is not the desk EVM address ${evm}`);
  if (action.amount !== amountText) out.push(`amount ${JSON.stringify(action.amount)} is not ${JSON.stringify(amountText)}`);
  if (!Number.isSafeInteger(Number(action.time)) || Number(action.time) <= 0) out.push(`time ${JSON.stringify(action.time)} is not a time in ms`);
  return out;
}

/** USDC text as Hyperliquid writes it ("1.0", "10.682396") in 1e-6 units, or null. */
function micros(value) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value ?? '').trim());
  return m === null ? null : BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/**
 * The withdraw3 time (ms, BigInt) a ledger `withdraw` entry's nonce names, or null when it has none. Hyperliquid
 * books the action's time x 1000 ({"usdc":"10.682396","nonce":1793669928713000,"fee":"1.0"} for time
 * 1793669928713); a bare ms time is read as itself, in case that changes.
 */
export function withdrawNonceMs(delta) {
  if (delta?.nonce === undefined || delta.nonce === null) return null;
  let n;
  try {
    n = BigInt(String(delta.nonce));
  } catch {
    return -1n;
  }
  if (n >= 10n ** 14n) return n % 1000n === 0n ? n / 1000n : -1n;
  return n;
}

/** Whether a ledger entry without a nonce is a withdrawal of `amountE6`: its usdc plus its own fee. */
const isWithdrawOf = (e, amountE6) => {
  const fee = micros(e.delta?.fee ?? '0');
  return e.usdcE6 !== null && fee !== null && e.usdcE6 + fee === amountE6;
};

/**
 * The Hyperliquid ledger entry of this withdrawal, or null: a `withdraw` booked since `since` whose nonce is the
 * action's `time` (withdrawNonceMs), or, for an entry without a nonce, whose usdc + fee is the amount.
 */
export function hlWithdrawEntry(entries, { since, time, amountE6 }) {
  return entries.find((e) => {
    if (e.type !== 'withdraw' || e.time < since) return false;
    const ms = withdrawNonceMs(e.delta);
    return ms === null ? isWithdrawOf(e, amountE6) : ms === BigInt(time);
  }) ?? null;
}

const iso = (ms) => new Date(Number(ms)).toISOString();

/** A nearblocks transaction's receipt block time, ms (the contract's block_timestamp_ms for the call), or null. */
function receiptMs(t) {
  const rb = t?.receipt_block?.block_timestamp;
  if (typeof rb === 'number' && Number.isFinite(rb)) return Math.floor(rb / 1e6);
  if (typeof rb === 'string' && /^\d+$/.test(rb)) return Number(BigInt(rb) / 1_000_000n);
  const tb = t?.block_timestamp;
  if (typeof tb === 'string' && /^\d+$/.test(tb)) return Number(BigInt(tb) / 1_000_000n);
  return null;
}

/**
 * The contract's calls of `method` for `deskId` since `sinceMs`, newest first, from nearblocks:
 * { hash, ms (the receipt block's), accepted (false when the contract refused it: nothing was signed), args }.
 * A call whose desk cannot be read is kept (it may be this desk's). Throws when nearblocks cannot be read.
 */
export async function deskCalls(fetchImpl, contract, method, deskId, sinceMs) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = `${NEARBLOCKS_API}/account/${contract}/txns?method=${method}&per_page=25${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.txns)) throw new Error(`nearblocks ${method} calls: HTTP ${res.status}`);
    let older = false;
    for (const t of body.txns) {
      const ms = receiptMs(t);
      if (ms === null) throw new Error(`nearblocks: ${t?.transaction_hash} has no block time`);
      if (ms < sinceMs) {
        older = true;
        continue;
      }
      for (const x of t.actions ?? []) {
        if (x?.method !== method) continue;
        const raw = typeof x.args === 'string' ? x.args : JSON.stringify(x.args ?? null);
        let args = null;
        try {
          args = JSON.parse(raw);
        } catch {
          // read the fields below from the text
        }
        const desk = typeof args?.desk_id === 'string' ? args.desk_id : (/desk_id[^a-z0-9-]*([a-z0-9-]{1,32})/.exec(raw)?.[1] ?? null);
        if (desk !== null && desk !== deskId) continue;
        out.push({
          hash: t.transaction_hash, ms, accepted: t.receipt_outcome?.status !== false, args, deskKnown: desk !== null,
          amount: typeof args?.amount === 'string' ? args.amount : null,
          depositAddress: /depositAddress[^0-9a-zA-Z]*(0x[0-9a-fA-F]{40})/.exec(raw)?.[1] ?? null,
        });
      }
    }
    if (older || !body.cursor || body.txns.length === 0) return out.sort((x, y) => y.ms - x.ms);
    cursor = body.cursor;
  }
  throw new Error(`nearblocks: more than 20 pages of ${method} calls`);
}

/**
 * What stops withdraw --send (without --again): a Hyperliquid withdrawal under 30 min old (it may still be on its
 * way to Arbitrum), or an hl_withdraw whose withdraw3 the ledger has not booked (Hyperliquid would still take it
 * until its time + 2 days). `calls` (deskCalls of hl_withdraw, or the Error nearblocks gave), `entries` (the
 * ledger since now - 2 days), `hlNonce` (the desk's last Hyperliquid nonce, BigInt ms, or null if unread).
 * Returns { lines, refusals }.
 */
export function withdrawGuards({ calls, entries, hlNonce, nowMs }) {
  const lines = [];
  const refusals = [];
  const withdraws = entries.filter((e) => e.type === 'withdraw');
  for (const w of recentWithdraws(withdraws, nowMs).filter((x) => x.inFlight)) {
    refusals.push(`a Hyperliquid withdrawal of ${w.usdcE6 === null ? '?' : usdcText(w.usdcE6)} USDC booked at ${iso(w.time)} is under 30 min old: it may still be on its way to Arbitrum (bridge it first)`);
  }
  const bookedAt = (ms, amountText) => withdraws.find((e) => {
    const n = withdrawNonceMs(e.delta);
    if (n !== null) return n >= BigInt(ms) - 1n && n <= BigInt(ms) + NONCE_AHEAD_MS;
    const amount = amountText === null ? null : micros(amountText);
    return amount !== null && e.time >= ms - LEDGER_SLACK_MS && isWithdrawOf(e, amount);
  }) ?? null;
  const replayEnd = (ms) => iso(Number(ms) + HL_REPLAY_MS);
  if (calls instanceof Error) {
    lines.push(`hl_withdraw calls not read: ${calls.message}`);
    if (hlNonce === null) refusals.push(`nearblocks (${calls.message}) and the desk's Hyperliquid nonce could not be read: an earlier hl_withdraw signature cannot be ruled out`);
    else if (hlNonce > 0n && nowMs - Number(hlNonce) < HL_REPLAY_MS && bookedAt(Number(hlNonce), null) === null) {
      refusals.push(`nearblocks could not be read (${calls.message}) and the desk signed a Hyperliquid action at ${iso(hlNonce)} that the ledger does not show as a withdraw: `
        + `if it was an hl_withdraw, Hyperliquid takes it until ${replayEnd(hlNonce)}`);
    }
    return { lines, refusals };
  }
  for (const c of calls) {
    if (!c.accepted) {
      lines.push(`hl_withdraw ${c.hash} at ${iso(c.ms)}: refused by the contract (nothing signed)`);
      continue;
    }
    const hit = bookedAt(c.ms, c.amount);
    if (hit !== null) {
      lines.push(`hl_withdraw ${c.hash} (${c.amount ?? '?'} USDC) at ${iso(c.ms)}: booked, ledger ${hit.hash}${hit.delta.nonce === undefined ? '' : ` (nonce ${hit.delta.nonce})`}`);
      continue;
    }
    const open = nowMs < c.ms + HL_REPLAY_MS;
    lines.push(`hl_withdraw ${c.hash} (${c.amount ?? '?'} USDC) at ${iso(c.ms)}: not in the Hyperliquid ledger${open ? `; its withdraw3 can still be posted until about ${replayEnd(c.ms)}` : ''}`);
    if (open) {
      refusals.push(`hl_withdraw ${c.hash} (${c.amount ?? '?'} USDC${c.deskKnown ? '' : ', desk not readable'}) signed a withdraw3 at about ${iso(c.ms)} that the Hyperliquid ledger does not show: `
        + `Hyperliquid takes it until about ${replayEnd(c.ms)} (its nonce window); read userNonFundingLedgerUpdates before withdrawing again`);
    }
  }
  if (hlNonce !== null && hlNonce > 0n) {
    const newest = calls.find((c) => c.accepted)?.ms ?? 0;
    lines.push(`desk Hyperliquid nonce ${hlNonce} (${iso(hlNonce)}): the time of the last Hyperliquid action the contract signed for the desk`);
    if (Number(hlNonce) > newest + Number(NONCE_AHEAD_MS) && nowMs - Number(hlNonce) < INDEX_LAG_MS && bookedAt(Number(hlNonce), null) === null) {
      refusals.push(`the desk signed a Hyperliquid action at ${iso(hlNonce)} that nearblocks does not list yet: if it is an hl_withdraw it is not checked here; wait ${INDEX_LAG_MS / 60_000} min`);
    }
  }
  return { lines, refusals };
}

/**
 * Why an earlier evm_usdc_to_intents (deskCalls) stops bridge --send, or null: its authorization can still be
 * used (validBefore = its block time + 300 s) or 1Click has not settled its deposit. `status` is the 1Click
 * status text (or 'unread ...'). Settled: SUCCESS, REFUNDED, or expired while still PENDING_DEPOSIT.
 */
export function authorizationProblem(c, status, nowMs) {
  const until = c.ms + AUTH_VALID_MS + AUTH_SLACK_MS;
  if (status === 'SUCCESS' || status === 'REFUNDED') return null;
  if (nowMs >= until && status === 'PENDING_DEPOSIT') return null;
  const what = `evm_usdc_to_intents ${c.hash} at ${iso(c.ms)} (deposit address ${c.depositAddress ?? 'not readable'})`;
  if (nowMs < until) return `${what}: its authorization is valid until about ${iso(until)} and 1Click says ${status}: do not bridge again before then`;
  if (status === 'FAILED') return `${what}: 1Click says FAILED; read GET /v0/status for it (a refund goes to the desk EVM address) before bridging again`;
  return `${what}: 1Click says ${status}: its deposit has not settled`;
}

/** The desk's earlier authorizations and what 1Click says of each: { lines, refusals }. Fails closed. */
async function bridgeGuards({ fetchImpl, contract, deskId, nowMs, apiKey }) {
  const lines = [];
  const refusals = [];
  let calls;
  try {
    calls = await deskCalls(fetchImpl, contract, 'evm_usdc_to_intents', deskId, nowMs - BRIDGE_LOOKBACK_MS);
  } catch (e) {
    refusals.push(`earlier evm_usdc_to_intents calls could not be read (${e.message}): an authorization still valid cannot be ruled out`);
    return { lines, refusals };
  }
  if (calls.length === 0) lines.push('no evm_usdc_to_intents for the desk in the last 24 h');
  for (const c of calls) {
    if (!c.accepted) {
      lines.push(`evm_usdc_to_intents ${c.hash} at ${iso(c.ms)}: refused by the contract (nothing signed)`);
      continue;
    }
    let status = 'unread (no deposit address in its quote)';
    if (c.depositAddress !== null) {
      const s = await quoteStatus(fetchImpl, c.depositAddress, apiKey).catch((e) => ({ status: 0, body: { status: `unread (${e.message})` } }));
      status = s.body?.status ?? `unread (HTTP ${s.status})`;
    }
    lines.push(`evm_usdc_to_intents ${c.hash} at ${iso(c.ms)} to ${c.depositAddress ?? '?'}: 1Click ${status}`);
    const p = authorizationProblem(c, status, nowMs);
    if (p !== null) refusals.push(p);
  }
  return { lines, refusals };
}

/** The Hyperliquid ledger's withdrawals, each with whether it may still be on its way to Arbitrum. */
export function recentWithdraws(entries, nowMs) {
  return entries.filter((e) => e.type === 'withdraw').map((e) => ({ ...e, inFlight: nowMs - e.time <= IN_FLIGHT_MS }));
}

const withdrawLine = (w) => `withdraw of ${w.usdcE6 === null ? '?' : usdcText(w.usdcE6)} USDC at ${new Date(w.time).toISOString()}${w.inFlight ? ' (under 30 min ago: may still be on its way to Arbitrum)' : ''}, ${w.hash}`;

// --- bridge ---

export const customRecipientMsg = (deskId) => JSON.stringify({ desk_id: deskId });

/** The 1Click quote request of a bridge: Arbitrum USDC -> USDC on NEAR to the contract for the desk. */
export function bridgeQuoteBody({ dry, amount, contract, deskId, evm, slippage, now }) {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippage,
    originAsset: ASSETS.arbitrumUsdc,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: ASSETS.nearUsdc,
    amount: amount.toString(),
    refundTo: evm,
    refundType: 'ORIGIN_CHAIN',
    recipient: contract,
    recipientType: 'DESTINATION_CHAIN',
    customRecipientMsg: customRecipientMsg(deskId),
    deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

/**
 * evm_usdc_to_intents's checks of a quote answer, as the contract makes them (oneclick.mjs: signature, fields,
 * the rescue cap, the policy's cost bound), plus the hourly rescue cost budget. What earlier rescues used of the
 * cap and the budget is not readable, so the whole of each is assumed left; the contract checks the rest.
 */
export function checkBridgeQuote(response, { contract, deskId, desk, policy, now, dry }) {
  if (typeof response?.signature !== 'string') throw new Error('1Click answered without a signature');
  const quote = canonicalQuote(response);
  const capE8 = BigInt(policy.rescue_cap_usd_per_hour) * 100_000_000n;
  const q = verifyQuote(quote, response.signature, 'evm_usdc_to_intents', {
    desk: { desk_id: deskId, evm: desk.evm_address, sol: desk.solana.authority, orderly_receiver: desk.orderly_receiver ?? null, owner: desk.owner },
    contract, now_ms: now, remaining_cap_e8: capE8, dry_ok: dry,
  });
  checkCost(q, policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6);
  const cost = transferCostE8(q);
  const budget = rescueCostBudgetE8(policy.rescue_cap_usd_per_hour, policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6);
  if (cost > budget) throw new QuoteRefusal('E_RESCUE_CAP', `the bridge may cost ${usdE8Text(cost)} USD, over the whole hourly rescue cost budget of ${usdE8Text(budget)} USD`);
  const roomBps = q.amountOut === null || q.amountOut === 0n ? null : ((q.amountOut - q.minAmountOut) * 10_000n) / q.amountOut;
  return { quote, signature: response.signature, q, cost, budget, capE8, allowed: allowedCostE8(q.amountInE8, policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6), roomBps };
}

/** Why a verified quote is not the bridge asked for (an empty list when it is). */
export function bridgeMismatch(quote, { contract, deskId, evm, amount, slippage }) {
  const f = JSON.parse(quote);
  const out = [];
  if (f.originAsset !== ASSETS.arbitrumUsdc) out.push(`originAsset ${f.originAsset} is not Arbitrum USDC (${ASSETS.arbitrumUsdc})`);
  if (f.destinationAsset !== ASSETS.nearUsdc) out.push(`destinationAsset ${f.destinationAsset} is not USDC on NEAR (${ASSETS.nearUsdc})`);
  if (f.recipient !== contract) out.push(`recipient ${f.recipient} is not the contract ${contract}`);
  if (f.customRecipientMsg !== customRecipientMsg(deskId)) out.push(`customRecipientMsg ${JSON.stringify(f.customRecipientMsg)} is not ${customRecipientMsg(deskId)}`);
  if (typeof f.refundTo !== 'string' || f.refundTo.toLowerCase() !== evm.toLowerCase()) out.push(`refundTo ${f.refundTo} is not the desk EVM address ${evm}`);
  if (f.amountIn !== amount.toString()) out.push(`amountIn ${f.amountIn} is not the ${usdcText(amount)} USDC asked (${amount})`);
  if (Number(f.slippageTolerance) !== slippage) out.push(`slippageTolerance ${f.slippageTolerance} is not the ${slippage} asked`);
  if (f.swapType !== 'EXACT_INPUT') out.push(`swapType ${f.swapType} is not EXACT_INPUT`);
  return out;
}

/** Arbitrum's chain id and Circle USDC there, as the contract signs them. */
export const ARBITRUM_ONE = 42161;
export const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';

/** Why the SignedAction evm_usdc_to_intents returned is not the transfer of the verified quote (empty when it is). */
export function transferActionProblems(signed, { deskId, evm, depositAddress, amountIn }) {
  const out = [];
  const p = signed?.payload ?? {};
  const same = (x, y) => typeof x === 'string' && typeof y === 'string' && x.toLowerCase() === y.toLowerCase();
  if (signed?.desk_id !== deskId) out.push(`signed for desk ${signed?.desk_id}, not ${deskId}`);
  if (signed?.venue !== 'arbitrum' || signed?.kind !== 'transfer_with_authorization') out.push(`${signed?.venue} ${signed?.kind}, not arbitrum transfer_with_authorization`);
  if (!same(p.from, evm)) out.push(`from ${p.from} is not the desk EVM address ${evm}`);
  if (!same(p.to, depositAddress)) out.push(`to ${p.to} is not the quote's deposit address ${depositAddress}`);
  if (String(p.value) !== amountIn.toString()) out.push(`value ${p.value} is not the quote's amountIn ${amountIn}`);
  if (!same(p.token, ARBITRUM_USDC)) out.push(`token ${p.token} is not Circle USDC on Arbitrum ${ARBITRUM_USDC}`);
  if (Number(p.chainId) !== ARBITRUM_ONE) out.push(`chainId ${p.chainId} is not ${ARBITRUM_ONE}`);
  return out;
}

/** The ETH the relayer wallet needs for one transfer at `gasPrice` (wei), and whether `wei` covers it. */
export function relayerGas(wei, gasPrice) {
  const need = gasPrice * RELAYER_GAS_UNITS;
  return { need, ok: wei >= need };
}

/** The 1Click status body's NEAR transaction hashes of the delivery (swapDetails.destinationChainTxHashes). */
export function deliveryHashes(body) {
  const list = body?.swapDetails?.destinationChainTxHashes;
  return Array.isArray(list) ? list.map((h) => (typeof h === 'string' ? h : h?.hash)).filter((h) => typeof h === 'string' && h !== '') : [];
}

/** The contract's `deposit` events for the desk in a NEAR transaction (nearblocks for its signer, then the RPC). */
async function depositEventsOf(client, fetchImpl, contract, deskId, hash) {
  const res = await fetchImpl(`https://api.nearblocks.io/v1/txns/${hash}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => null);
  const signer = body?.txns?.[0]?.signer_account_id;
  if (!res.ok || typeof signer !== 'string') throw new Error(`nearblocks has no transaction ${hash} yet (HTTP ${res.status})`);
  const outcome = await client.rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  const logs = (outcome.receipts_outcome ?? []).filter((r) => r.outcome.executor_id === contract).flatMap((r) => r.outcome.logs ?? []);
  return eventsOf(logs).filter((e) => e.event === 'deposit' && e.data?.desk_id === deskId);
}

// --- the run ---

/** The engine modules --send uses: the SignedAction parser and the two submitters. */
const defaultEngine = async () => ({
  ...(await import('../../engine/src/contract/near-client.ts')),
  ...(await import('../../engine/src/relayer/hyperliquid.ts')),
  ...(await import('../../engine/src/relayer/arbitrum.ts')),
});

/**
 * Runs one stage. deps: near, fetch, say, now, tree, readKey(file, accountId), env (Map of ONECLICK_API_KEY and
 * RELAYER_EVM_PRIVATE_KEY), urls (rpcUrls()), engine() (the engine modules), sleep, pollMs, checkQuote (tests).
 * Returns the block.
 */
export async function runHlReturn(argv, deps = {}) {
  const a = parseHlReturnArgs(argv);
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);
  const ctx = {
    a,
    tree,
    client: deps.near ?? near,
    fetchImpl: deps.fetch ?? ((...x) => globalThis.fetch(...x)),
    say: deps.say ?? ((s = '') => console.log(s)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? pause,
    pollMs: deps.pollMs ?? 10_000,
    urls: deps.urls ?? rpcUrls(),
    deps,
  };
  ctx.at = () => new Date(ctx.now()).toISOString();
  ctx.say(`gimbal hl-return ${a.stage} ${a.amount === null ? 'all' : `${usdcText(a.amount)} USDC`} for ${a.contract} desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) ctx.say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await ctx.client.rpc('status', []);
  ctx.say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const method = ALLOWED_CALLS[a.stage][0];
  const { desk, config } = await moneyContext(ctx.client, a.contract, a.deskId, [method]);
  ctx.desk = desk;
  ctx.hyperliquidChain = config?.network === 'Testnet' ? 'Testnet' : 'Mainnet';
  ctx.say(`contract  ${a.contract}: Mainnet Gimbal, its code has ${method}`);
  ctx.say(`desk      ${a.deskId}: owner ${desk.owner}, operator ${desk.operator ?? 'none (the operator key is on the owner\'s account)'}, paused ${desk.paused}, EVM ${desk.evm_address}`);
  ctx.say(`ledger    ${ledgerText(ledgerOf(desk))}`);
  return a.stage === 'withdraw' ? withdrawStage(ctx) : bridgeStage(ctx);
}

/** The NEAR transaction's gas lines, printed after describeTx. */
async function gasLine(client, signer, receiver, actions) {
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer, receiver, actions });
  return `  gas       at most ${tgasText(cap.total)} TGas, ${nearTextUp(cap.total * gasPrice, 4)} NEAR (an action method needs at least ${ACTION_MIN_TGAS}); the unused part is refunded`;
}

/** The `open:` line after hl_withdraw failed on NEAR (near-client.ts signatureMayBePublic, for withdraw3). */
export const withdrawOpenLine = (hash, nowMs) => `open:     hl_withdraw ${hash} failed on NEAR, but a signature of its withdraw3 may be public (the failure can come after the MPC network signed): `
  + `a late withdraw3 can still be posted within Hyperliquid's nonce window (until about ${iso(nowMs + HL_REPLAY_MS)}); check the ledger (userNonFundingLedgerUpdates) before any rerun`;
/** The `open:` line after evm_usdc_to_intents failed on NEAR: the same, for an EIP-3009 authorization. */
export const bridgeOpenLine = (hash, nowMs) => `open:     evm_usdc_to_intents ${hash} failed on NEAR, but a signature of its authorization may be public (the failure can come after the MPC network signed): `
  + `the rescue is counted, and a late authorization is valid until block time + 300 s (about ${iso(nowMs + AUTH_VALID_MS + AUTH_SLACK_MS)}); do not rerun bridge before then`;

/** Guard refusals: refused at --send (and listed by the dry run) unless --again, which only prints them. */
function applyGuard(a, say, refusals, lines, found) {
  for (const r of found) {
    if (a.again) {
      say(`override  ${r} (--again)`);
      lines.push(`override: ${r} (--again)`);
    } else {
      refusals.push(`${r} (--again sends anyway)`);
    }
  }
}

async function withdrawStage({ a, client, fetchImpl, say, now, sleep, pollMs, urls, desk, at, deps, hyperliquidChain }) {
  const evm = desk.evm_address;
  // Every read fails closed: nothing here is taken as 0 because it could not be read.
  const perps = await hyperliquidPerps(fetchImpl, evm);
  const arb = await arbitrumBalances(fetchImpl, urls.arbitrum, evm);
  const since = now() - HL_REPLAY_MS - 3_600_000;
  const entries = await hyperliquidLedger(fetchImpl, evm, since);
  const withdraws = recentWithdraws(entries.filter((e) => e.type === 'withdraw' && now() - e.time <= LEDGER_LOOKBACK_MS), now());
  say(`hyperliq  perps withdrawable ${usdcText(perps.withdrawableE6)} USDC, account value ${usdcText(perps.accountValueE6)}, ${perps.positions} open position(s)`);
  say(`arbitrum  desk EVM ${evm} (RPC ${urls.shown.arbitrum}): ${usdcText(arb.usdcE6)} USDC, ${ethText(arb.wei)} ETH`);
  for (const w of withdraws) say(`earlier   ${withdrawLine(w)}`);
  if (withdraws.length === 0) say('earlier   no Hyperliquid withdrawal in the last 24 h');
  // Earlier signatures: the contract's hl_withdraw calls (nearblocks) against the ledger, and the desk's nonce.
  const calls = await deskCalls(fetchImpl, a.contract, 'hl_withdraw', a.deskId, since).catch((e) => e);
  const hlNonce = await hlNonceOf(client, a.contract, a.deskId).catch(() => null);
  const guard = withdrawGuards({ calls, entries, hlNonce, nowMs: now() });
  for (const l of guard.lines) say(`signed    ${l}`);
  if (!(calls instanceof Error) && calls.length === 0) say('signed    no hl_withdraw for the desk in the last 2 days');
  const refusals = [];
  const overrides = [];
  applyGuard(a, say, refusals, overrides, guard.refusals);
  for (const r of refusals) say(`refuses   ${r}`);
  if (a.send && refusals.length > 0) throw new Error(`withdraw --send refused, nothing was signed: ${refusals.join('; ')}`);
  const plan = withdrawPlan(a.amount, perps.withdrawableE6);
  if (perps.positions > 0) say(`warning   the desk has ${perps.positions} open position(s): withdrawing margin raises their liquidation risk`);
  const capE8 = BigInt(desk.policy.rescue_cap_usd_per_hour) * 100_000_000n;
  const overCap = plan.arrival * 100n > capE8;
  const capWarning = `${usdcText(plan.arrival)} USDC arriving is over the desk's hourly rescue cap of ${desk.policy.rescue_cap_usd_per_hour} USD: `
    + `the bridge stage takes it in parts an hour apart (at most ${desk.policy.rescue_cap_usd_per_hour} USDC each)`;
  if (overCap) say(`warning   ${capWarning}`);

  const owner = desk.owner;
  const free = freeBalance(await client.account(owner));
  say(`owner     ${owner}: ${nearText(free, 4)} NEAR free`);
  if (free < OWNER_GAS_MARGIN) throw new Error(`the owner can spend ${nearText(free, 4)} NEAR; hl_withdraw reserves 300 TGas (keep ${nearText(OWNER_GAS_MARGIN)} free)`);

  let signer = null;
  let signedBy = 'the owner\'s full-access key, --key-file, read at --send';
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, owner);
    if (fullAccessVerdict(await client.accessKey(owner, signer.publicKeyString)) !== 'matches') {
      throw new Error(`--key-file is not a full-access key of the desk owner ${owner}: nothing was signed (hl_withdraw is owner only, with 1 yoctoNEAR)`);
    }
    signedBy = `--key-file, a full-access key of ${owner}`;
  }
  const actions = hlWithdrawActions(a.deskId, plan.amount);
  const amountText = actions[0].args.amount;
  say();
  say(describeTx(`tx: hl_withdraw ${amountText} USDC from Hyperliquid to the desk EVM address on Arbitrum`, { signer: owner, signedBy, receiver: a.contract, actions }).join('\n'));
  say(await gasLine(client, owner, a.contract, actions));
  say(`  then      the MPC signs, as the desk's EVM key, Hyperliquid withdraw3 {destination ${evm}, amount "${amountText}", time <the desk's next Hyperliquid nonce>}; `
    + 'the transaction returns that SignedAction, posted to https://api.hyperliquid.xyz/exchange');
  say(`expected  Hyperliquid withdrawable ${usdcText(perps.withdrawableE6)} -> ${usdcText(perps.withdrawableE6 - plan.amount)} USDC; it takes its ${usdcText(HL_WITHDRAW_FEE_E6)} USDC fee, `
    + `so ${usdcText(plan.arrival)} USDC arrives on Arbitrum (desk EVM ${usdcText(arb.usdcE6)} -> ${usdcText(arb.usdcE6 + plan.arrival)}), usually within a few minutes`);
  say(`next      the bridge stage: node tools/mainnet/hl-return.mjs ${a.contract} ${a.deskId} bridge all`);

  const lines = [`contract ${a.contract}, desk ${a.deskId}, withdraw, ${a.send ? 'SEND' : 'dry run'}`];
  lines.push(`hyperliquid: perps withdrawable ${usdcText(perps.withdrawableE6)} USDC, account value ${usdcText(perps.accountValueE6)}, positions ${perps.positions}`);
  lines.push(`arbitrum: desk EVM ${evm} ${usdcText(arb.usdcE6)} USDC`);
  for (const w of withdraws.filter((x) => x.inFlight)) lines.push(`earlier:  ${withdrawLine(w)}`);
  lines.push(...overrides);
  if (overCap) lines.push(`warning:  ${capWarning}`);
  if (!a.send) {
    lines.push(`withdraw: hl_withdraw ${JSON.stringify(actions[0].args)} planned; ${usdcText(plan.arrival)} USDC expected on Arbitrum (amount - ${usdcText(HL_WITHDRAW_FEE_E6)} USDC fee)`);
    for (const x of refusals) lines.push(`would refuse at --send: ${x}`);
    const block = summaryBlock('hl-return', { at: at(), lines });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. Add --send and --key-file <owner key json>, from the main checkout, to send it.');
    if (refusals.length > 0) throw new Error(`--send would refuse: ${refusals.join('; ')}`);
    return block;
  }

  const done = (extra = []) => {
    const block = summaryBlock('hl-return', { at: at(), lines: [...lines, ...extra] });
    say();
    say(block.join('\n'));
    return block;
  };
  const engine = await (deps.engine ?? defaultEngine)();
  const sentAt = now();
  let sentHash = null;
  let out;
  try {
    out = await guardedSend(client, 'withdraw', a.contract)(signer, a.contract, actions, { onSent: (h) => { sentHash = h; say(`\ntx sent ${h}; waiting for final`); } });
  } catch (e) {
    if (sentHash !== null) done([`near:     hl_withdraw tx ${sentHash}: no final outcome (${e.message})`, withdrawOpenLine(sentHash, now())]);
    throw e;
  }
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) say(`  log ${log}`);
  lines.push(`near:     hl_withdraw tx ${out.hash} ${out.failure === null ? 'returned a SignedAction' : `FAILED ${panicOf(out.failure)}`}`);
  if (out.failure !== null) {
    done([withdrawOpenLine(out.hash, now())]);
    throw new Error(`hl_withdraw ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
  }
  let signed;
  try {
    signed = engine.parseSignedAction('hl_withdraw', out.value, a.deskId);
  } catch (e) {
    done([`open:     the transaction ran but its SignedAction cannot be read: ${e.message}; a withdraw3 may still have been signed `
      + `(Hyperliquid takes it until about ${iso(now() + HL_REPLAY_MS)}): look it up and check the ledger before running anything again`]);
    throw e;
  }
  const problems = withdrawActionProblems(signed, { deskId: a.deskId, evm, amountText, hyperliquidChain });
  if (problems.length > 0) {
    done([`refused:  the signed action is not the withdrawal asked for; not posted: ${problems.join('; ')}`]);
    throw new Error(`the signed action is not the withdrawal asked for; nothing was posted:\n  ${problems.join('\n  ')}`);
  }
  const time = Number(signed.payload.action.time);
  const replayEnd = iso(time + HL_REPLAY_MS);
  say(`signed    withdraw3 to ${signed.payload.action.destination}, amount "${signed.payload.action.amount}", time ${time}`);
  say(`posting   to https://api.hyperliquid.xyz/exchange; then up to ${SUBMIT_CONFIRM_MS / 1000} s for its ledger entry (withdraw, nonce ${time}000)`);
  const submitter = new engine.HyperliquidSubmitter({
    network: hyperliquidChain === 'Testnet' ? 'testnet' : 'mainnet', fetch: fetchImpl, clock: { now }, confirmMs: SUBMIT_CONFIRM_MS, pollMs: 2_500, sleep,
  });
  try {
    const r = await submitter.submit(signed, evm);
    lines.push(`hyperliquid: /exchange accepted withdraw3 (time ${time})${r.confirmed ? `; ledger ${r.tx.filter((t) => t.chain === 'hyperliquid').map((t) => t.id).join(', ')}` : ''}`);
  } catch (e) {
    const refused = e.name === 'HlExchangeError';
    done([
      `hyperliquid: ${e.name ?? 'error'}${refused ? ' (Hyperliquid refused it)' : ' (no answer: it may have been taken)'}: ${e.message}`,
      `open:     withdraw3 time ${time} is signed and was sent to Hyperliquid: it can still be posted until about ${replayEnd} (Hyperliquid's nonce window); `
        + `read the ledger (userNonFundingLedgerUpdates, a withdraw with nonce ${time}000) before any rerun; the next withdraw dry run checks it`,
    ]);
    throw e;
  }
  // Hyperliquid's own record (a `withdraw` with nonce time x 1000) and the bridge to Arbitrum (the desk EVM's
  // USDC up by at least amount - fee), read together until --timeout-s; the wait is announced, then reported.
  const deadline = now() + a.timeoutS * 1000;
  say(`waiting   up to ${a.timeoutS} s (--timeout-s) for Hyperliquid's ledger entry (withdraw, nonce ${time}000) and +${usdcText(plan.arrival)} USDC `
    + `at the desk EVM on Arbitrum (usually a few minutes), reading both every ${Math.round(pollMs / 1000)} s`);
  let entry = null;
  let arbNow = arb.usdcE6;
  let arrived = false;
  let pollsAfterArrival = 0;
  let lastNote = now();
  for (;;) {
    if (entry === null) {
      const rows = await hyperliquidLedger(fetchImpl, evm, sentAt - LEDGER_SLACK_MS).catch(() => null);
      entry = rows === null ? null : hlWithdrawEntry(rows, { since: sentAt - LEDGER_SLACK_MS, time, amountE6: plan.amount });
      if (entry !== null) say(`ledger    Hyperliquid booked the withdraw at ${iso(entry.time)}: usdc ${entry.delta.usdc ?? '?'}, fee ${entry.delta.fee ?? '?'}, ${entry.hash}`);
    }
    if (!arrived) {
      arbNow = await arbitrumBalances(fetchImpl, urls.arbitrum, evm).then((b) => b.usdcE6).catch(() => arbNow);
      arrived = arbNow - arb.usdcE6 >= plan.arrival;
      if (arrived) say(`arbitrum  the desk EVM holds ${usdcText(arbNow)} USDC (+${usdcText(arbNow - arb.usdcE6)}) at ${at()}`);
    }
    if (entry !== null && arrived) break;
    // Arrived without a matching ledger entry: a few more reads, not the whole timeout.
    if (arrived && ++pollsAfterArrival > 6) break;
    if (now() >= deadline) break;
    if (now() - lastNote >= 60_000) {
      say(`waiting   ${Math.max(0, Math.round((deadline - now()) / 1000))} s left: ledger entry ${entry === null ? 'not yet' : 'seen'}, Arbitrum ${usdcText(arbNow)} USDC`);
      lastNote = now();
    }
    await sleep(pollMs);
  }
  lines.push(entry === null
    ? `ledger:   no Hyperliquid withdraw with nonce ${time}000 seen: read userNonFundingLedgerUpdates before counting it (Hyperliquid takes the withdraw3 until about ${replayEnd})`
    : `ledger:   Hyperliquid withdraw ${entry.usdcE6 === null ? '' : `${usdcText(entry.usdcE6)} USDC `}${entry.delta.fee === undefined ? '' : `fee ${entry.delta.fee} `}`
      + `nonce ${entry.delta.nonce ?? '-'} at ${iso(entry.time)}, ${entry.hash}`);
  const block = done([
    `arbitrum: desk EVM USDC ${usdcText(arb.usdcE6)} -> ${usdcText(arbNow)} (expected +${usdcText(plan.arrival)})`,
    `arrived:  ${arrived ? 'yes' : `not yet (after ${a.timeoutS} s): Hyperliquid's bridge can take longer; rerun the bridge stage's dry run to read the balance`}`,
  ]);
  return block;
}

async function bridgeStage({ a, client, fetchImpl, say, now, sleep, pollMs, urls, desk, at, deps }) {
  const evm = desk.evm_address;
  const policy = desk.policy;
  const before = ledgerOf(desk);
  const arb = await arbitrumBalances(fetchImpl, urls.arbitrum, evm);
  const withdraws = recentWithdraws(await hyperliquidLedger(fetchImpl, evm, now() - LEDGER_LOOKBACK_MS), now());
  say(`policy    rescues at most ${policy.rescue_cap_usd_per_hour} USD an hour; transfer cost at most max(${policy.max_transfer_cost_bps} bps, ${usdcText(BigInt(policy.max_transfer_cost_flat_e6))} USDC)`);
  say(`arbitrum  desk EVM ${evm} (RPC ${urls.shown.arbitrum}): ${usdcText(arb.usdcE6)} USDC, ${ethText(arb.wei)} ETH (the desk pays no gas: the relayer does)`);
  for (const w of withdraws) say(`earlier   Hyperliquid ${withdrawLine(w)}`);
  const amount = a.amount ?? arb.usdcE6;
  if (amount === 0n) throw new Error(`the desk EVM address holds no USDC on Arbitrum: nothing to bridge${withdraws.some((w) => w.inFlight) ? ' yet (a Hyperliquid withdrawal may still be on its way)' : ' (run the withdraw stage first)'}`);
  const refusals = [];
  if (amount > arb.usdcE6) {
    refusals.push(`${usdcText(amount)} USDC is over the desk EVM's ${usdcText(arb.usdcE6)} USDC on Arbitrum: the transfer would revert${withdraws.some((w) => w.inFlight) ? ' (a Hyperliquid withdrawal may still be on its way)' : ''}`);
  }
  const capE8 = BigInt(policy.rescue_cap_usd_per_hour) * 100_000_000n;
  if (amount * 100n > capE8) refusals.push(`${usdcText(amount)} USDC is over the hourly rescue cap of ${policy.rescue_cap_usd_per_hour} USD: the contract refuses it (E_RESCUE_CAP); bridge it in parts an hour apart`);

  // The relayer's gas wallet: it exists (its key is set) and holds ETH for one transfer.
  const env = deps.env ?? envValues(['ONECLICK_API_KEY', RELAYER_ENTRY]);
  const relayerKey = env.get(RELAYER_ENTRY)?.value ?? null;
  let relayer = null;
  if (relayerKey === null) {
    refusals.push(`no relayer wallet: ${RELAYER_ENTRY} is not set (environment or .env): run node tools/mainnet/relayer-wallet.mjs --write, then send it a little ETH on Arbitrum One (README section 5)`);
    say(`relayer   none: ${RELAYER_ENTRY} is not set; it submits the transfer and pays its Arbitrum gas`);
  } else {
    let address;
    try {
      address = evmAddressOf(relayerKey);
    } catch (e) {
      throw new Error(`${RELAYER_ENTRY} (from ${env.get(RELAYER_ENTRY).from}): ${e.message}`);
    }
    const wallet = await arbitrumBalances(fetchImpl, urls.arbitrum, address);
    const gasPrice = await arbitrumGasPrice(fetchImpl, urls.arbitrum);
    const g = relayerGas(wallet.wei, gasPrice);
    relayer = { address, wei: wallet.wei, gasPrice, ...g };
    say(`relayer   ${address} (${RELAYER_ENTRY} from ${env.get(RELAYER_ENTRY).from}; not shown): ${ethText(wallet.wei)} ETH; one transfer needs at most `
      + `${ethText(g.need)} ETH (${RELAYER_GAS_UNITS.toLocaleString('en-US')} gas at ${unitsText(gasPrice, 9)} gwei)`);
    if (!g.ok) refusals.push(`the relayer wallet ${address} holds ${ethText(wallet.wei)} ETH on Arbitrum, under the ${ethText(g.need)} ETH one transfer may need: send it a little ETH`);
  }
  const apiKey = env.get('ONECLICK_API_KEY')?.value ?? null;
  say(`1click    ${apiKey === null ? 'no ONECLICK_API_KEY: 1Click adds 0.2 % to the fee' : `ONECLICK_API_KEY set (from ${env.get('ONECLICK_API_KEY').from}; not shown)`}`);
  // Earlier authorizations: none may still be usable or its deposit unsettled (each is a counted rescue).
  const guard = await bridgeGuards({ fetchImpl, contract: a.contract, deskId: a.deskId, nowMs: now(), apiKey });
  for (const l of guard.lines) say(`earlier   ${l}`);
  const overrides = [];
  applyGuard(a, say, refusals, overrides, guard.refusals);
  // A live quote reserves a deposit address and the transfer counts against the cap: --send asks one only when it can pay it.
  if (a.send && refusals.length > 0) throw new Error(refusals.join('; '));

  const signerId = desk.operator ?? desk.owner;
  let signer = null;
  let signedBy = `the operator key in ${a.keyFile}, read at --send`;
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, signerId);
    const view = await client.accessKey(signerId, signer.publicKeyString);
    if (!isFunctionCallKey(view, a.contract, OPERATOR_METHODS)) {
      throw new Error(`${signer.publicKeyString} is not ${signerId}'s operator key for ${a.contract} (FunctionCall, the ${OPERATOR_METHODS.length} operator methods): nothing was signed`);
    }
    signedBy = `the operator key ${signer.publicKeyString}, ${nearText(BigInt(view.permission.FunctionCall.allowance ?? 0), 4)} NEAR allowance left`;
  }

  const body = bridgeQuoteBody({ dry: !a.send, amount, contract: a.contract, deskId: a.deskId, evm, slippage: a.slippage, now: now() });
  say(`\nquote     POST https://1click.chaindefuser.com/v0/quote ${a.send ? '(LIVE: reserves a deposit address)' : '(dry: reserves nothing)'}`);
  say(`          ${JSON.stringify(body)}`);
  const r = await requestQuote(fetchImpl, body, apiKey);
  if (r.status < 200 || r.status >= 300 || !r.body?.quote) throw new Error(`1Click refused the quote: HTTP ${r.status} ${JSON.stringify(r.body?.message ?? r.body).slice(0, 300)}`);
  const qt = r.body.quote;
  say(`          -> amountIn ${qt.amountIn}, amountOut ${qt.amountOut} (${qt.amountOutFormatted}), minAmountOut ${qt.minAmountOut}, timeEstimate ${qt.timeEstimate ?? '?'} s`
    + `${qt.refundFee ? `, refundFee ${qt.refundFee}` : ''}${qt.depositAddress ? `, depositAddress ${qt.depositAddress}` : ''}, signed ${r.body.timestamp}`);
  // deps.checkQuote: tests only (a live quote needs 1Click's signature, which no fixture of this route has).
  const checked = (deps.checkQuote ?? checkBridgeQuote)(r.body, { contract: a.contract, deskId: a.deskId, desk, policy, now: now(), dry: !a.send });
  const q = checked.q;
  const mismatch = bridgeMismatch(checked.quote, { contract: a.contract, deskId: a.deskId, evm, amount, slippage: a.slippage });
  if (mismatch.length > 0) throw new Error(`the quote is not the bridge asked for: nothing was signed\n  ${mismatch.join('\n  ')}`);
  say(`verified  1Click's signature over the canonical quote; evm_usdc_to_intents's field rules${a.send ? '' : ' (a dry quote passes here only; the contract takes live quotes)'}`);
  say(`          what was asked: recipient ${a.contract} with customRecipientMsg ${customRecipientMsg(a.deskId)}, USDC on NEAR, refundTo ${evm}, amountIn ${amount}, slippage ${a.slippage} bps, EXACT_INPUT`);
  say(`          cost ${usdE8Text(checked.cost)} USDC (amountIn - minAmountOut), allowed ${usdE8Text(checked.allowed)}; room below amountOut ${checked.roomBps ?? '?'} bps; `
    + `hourly rescue cap ${usdE8Text(checked.capE8)} USD and cost budget ${usdE8Text(checked.budget)} USD (what earlier rescues used is not readable; the contract checks it)`);

  const minOutE6 = q.minAmountOutE8 / 100n;
  const args = { desk_id: a.deskId, quote: checked.quote, quote_signature: checked.signature, reason: `hl-return: bridge ${usdcText(amount)} Arbitrum USDC to the desk on NEAR` };
  const actions = [act.call('evm_usdc_to_intents', args, ACTION_TGAS, 0n)];
  say();
  say(describeTx('tx: evm_usdc_to_intents (operator key)', { signer: signerId, signedBy, receiver: a.contract, actions }).join('\n'));
  say(await gasLine(client, signerId, a.contract, actions));
  say(`  then      the MPC signs, as the desk's EVM key, an EIP-3009 TransferWithAuthorization {from ${evm}, to ${q.depositAddress ?? '<the live quote\'s deposit address>'}, `
    + `value ${q.amountIn}, validAfter 0, validBefore <block time + 300 s>, nonce <the desk's next EIP-3009 nonce>} on Arbitrum USDC ${ARBITRUM_USDC}; `
    + `the relayer ${relayer?.address ?? '<no wallet yet>'} submits transferWithAuthorization and pays the gas; POST /v0/deposit/submit; 1Click sends USDC on NEAR to ${a.contract} `
    + `with ft_transfer_call msg ${customRecipientMsg(a.deskId)}`);
  say(`expected  idle_usdc ${usdcText(before.idle_usdc)} -> at least ${usdcText(before.idle_usdc + minOutE6)} (minAmountOut ${usdcText(minOutE6)}); deposited stays ${usdcText(before.deposited)}: `
    + 'USDC from anyone but the owner is a return, not principal (event deposit with principal false); a refund goes to the desk EVM address on Arbitrum');

  const lines = [`contract ${a.contract}, desk ${a.deskId}, bridge, ${a.send ? 'SEND' : 'dry run'}`];
  lines.push(`arbitrum: desk EVM ${evm} ${usdcText(arb.usdcE6)} USDC; bridge ${usdcText(amount)}`);
  for (const w of withdraws.filter((x) => x.inFlight)) lines.push(`earlier:  Hyperliquid ${withdrawLine(w)}`);
  for (const l of guard.lines) lines.push(`earlier:  ${l}`);
  lines.push(...overrides);
  lines.push(`quote:    ${a.send ? `live, depositAddress ${q.depositAddress}` : 'dry'}, amountIn ${q.amountIn}, amountOut ${q.amountOut}, minAmountOut ${q.minAmountOut}; `
    + `cost ${usdE8Text(checked.cost)} of ${usdE8Text(checked.allowed)} allowed, room ${checked.roomBps ?? '?'} bps`);
  lines.push(relayer === null ? 'relayer:  none (RELAYER_EVM_PRIVATE_KEY not set)' : `relayer:  ${relayer.address} ${ethText(relayer.wei)} ETH, one transfer needs at most ${ethText(relayer.need)}`);
  lines.push(`ledger:   ${ledgerText(before)}`);
  if (!a.send) {
    for (const x of refusals) lines.push(`would refuse at --send: ${x}`);
    const block = summaryBlock('hl-return', { at: at(), lines });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent, and the dry quote reserved nothing. --send asks for a live quote, checks it the same way, '
      + 'sends evm_usdc_to_intents and has the relayer submit the transfer.');
    if (refusals.length > 0) throw new Error(`--send would refuse: ${refusals.join('; ')}`);
    return block;
  }

  const done = (extra = []) => {
    const block = summaryBlock('hl-return', { at: at(), lines: [...lines, ...extra] });
    say();
    say(block.join('\n'));
    return block;
  };
  const engine = await (deps.engine ?? defaultEngine)();
  let sentHash = null;
  let out;
  try {
    out = await guardedSend(client, 'bridge', a.contract)(signer, a.contract, actions, { onSent: (h) => { sentHash = h; say(`\ntx sent ${h}; waiting for final`); } });
  } catch (e) {
    if (sentHash !== null) done([`near:     evm_usdc_to_intents tx ${sentHash}: no final outcome (${e.message})`, bridgeOpenLine(sentHash, now())]);
    throw e;
  }
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) say(`  log ${log}`);
  lines.push(`near:     evm_usdc_to_intents tx ${out.hash} ${out.failure === null ? 'returned a SignedAction' : `FAILED ${panicOf(out.failure)}`}`);
  if (out.failure !== null) {
    done([bridgeOpenLine(out.hash, now())]);
    throw new Error(`evm_usdc_to_intents ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
  }
  let signed;
  try {
    signed = engine.parseSignedAction('evm_usdc_to_intents', out.value, a.deskId);
  } catch (e) {
    done([`open:     the transaction ran but its SignedAction cannot be read: ${e.message}; the rescue is counted, and an authorization it signed is valid until `
      + `about ${iso(now() + AUTH_VALID_MS + AUTH_SLACK_MS)} (block time + 300 s): do not rerun bridge before then; look it up first`]);
    throw e;
  }
  const problems = transferActionProblems(signed, { deskId: a.deskId, evm, depositAddress: q.depositAddress, amountIn: q.amountIn });
  if (problems.length > 0) {
    done([`refused:  the signed authorization is not the transfer of the quote; not submitted: ${problems.join('; ')}`]);
    throw new Error(`the signed authorization is not the transfer of the quote; nothing was submitted:\n  ${problems.join('\n  ')}`);
  }
  const validBefore = new Date(Number(signed.payload.validBefore) * 1000).toISOString();
  say(`signed    TransferWithAuthorization ${signed.payload.value} to ${signed.payload.to}, nonce ${signed.payload.nonce}, valid until ${validBefore}; submitting on Arbitrum`);
  let arbTx;
  try {
    const submitter = new engine.ArbitrumSubmitter({ network: 'mainnet', rpcUrl: urls.arbitrum, relayerKey, now });
    const refs = await submitter.submit(signed, evm);
    arbTx = refs.find((t) => t.chain === 'arbitrum')?.id;
    if (arbTx === undefined) throw new Error('the submitter returned no Arbitrum transaction');
  } catch (e) {
    done([
      `arbitrum: ${e.name ?? 'error'}: ${e.message}`,
      `open:     authorization nonce ${signed.payload.nonce} to ${signed.payload.to} stays valid until ${validBefore}: do not run bridge again before then; `
        + `then read the desk EVM's Arbitrum USDC and GET https://1click.chaindefuser.com/v0/status?depositAddress=${q.depositAddress}`,
    ]);
    throw e;
  }
  lines.push(`arbitrum: transferWithAuthorization ${arbTx} (https://arbiscan.io/tx/${arbTx}), relayer ${relayer.address}`);
  const apiSubmit = await submitDeposit(fetchImpl, arbTx, q.depositAddress, apiKey).catch((e) => ({ status: 0, body: { message: e.message } }));
  say(`1click    POST /deposit/submit {"txHash":"${arbTx}","depositAddress":"${q.depositAddress}"} -> HTTP ${apiSubmit.status}`);

  // "Landed" needs both: 1Click SUCCESS and the desk's ledger: idle_usdc up by at least minAmountOut.
  const deadline = now() + a.timeoutS * 1000;
  let last = null;
  let lastBody = null;
  let after = before;
  let afterSuccess = 0;
  for (;;) {
    const s = await quoteStatus(fetchImpl, q.depositAddress, apiKey).catch((e) => ({ status: 0, body: { status: `unread (${e.message})` } }));
    const st = s.body?.status ?? `HTTP ${s.status}`;
    if (st !== last) say(`1click    status ${st} at ${at()}`);
    last = st;
    lastBody = s.body;
    after = await client.view(a.contract, 'get_desk', { desk_id: a.deskId }).then(ledgerOf).catch(() => after);
    const credited = after.idle_usdc - before.idle_usdc >= minOutE6;
    if (FINAL_STATUSES.includes(st) && (st !== 'SUCCESS' || credited)) break;
    if (st === 'SUCCESS' && ++afterSuccess >= POLLS_AFTER_SUCCESS) break;
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  const up = after.idle_usdc - before.idle_usdc;
  const extra = [`1click:   status ${last}`, `ledger:   after ${ledgerText(after)} (idle_usdc +${usdcText(up)})`];
  if (last === 'SUCCESS') {
    for (const hash of deliveryHashes(lastBody)) {
      try {
        const events = await depositEventsOf(client, fetchImpl, a.contract, a.deskId, hash);
        for (const e of events) extra.push(`event:    deposit ${JSON.stringify(e.data)} (NEAR tx ${hash})`);
        if (events.length === 0) extra.push(`event:    no deposit event for desk ${a.deskId} in NEAR tx ${hash}`);
      } catch (e) {
        extra.push(`event:    deposit event of NEAR tx ${hash} not read: ${e.message}`);
      }
    }
  }
  if (last === 'SUCCESS' && up >= minOutE6) extra.push(`landed:   yes: 1Click SUCCESS and idle_usdc up ${usdcText(up)} USDC (>= minAmountOut ${usdcText(minOutE6)})`);
  else if (last === 'SUCCESS') extra.push(`landed:   not seen: 1Click SUCCESS but idle_usdc is up ${usdcText(up)} USDC (< minAmountOut ${usdcText(minOutE6)}); read get_desk again before counting it`);
  else extra.push(`landed:   no: 1Click status ${last}`);
  if (last !== 'SUCCESS') extra.push(`open:     GET https://1click.chaindefuser.com/v0/status?depositAddress=${q.depositAddress}; a refund goes to the desk EVM address ${evm} on Arbitrum (bridge it again after)`);
  const block = done(extra);
  if (last === 'REFUNDED' || last === 'FAILED') throw new Error(`1Click ended the bridge ${last}: the USDC goes back to the desk EVM address ${evm} on Arbitrum`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runHlReturn(process.argv.slice(2)), USAGE);
