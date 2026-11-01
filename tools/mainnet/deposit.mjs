#!/usr/bin/env node
// Deposits USDC on NEAR from the desk owner into a desk (tools/mainnet/README.md, section 8):
//
//   node tools/mainnet/deposit.mjs <contract> <desk_id> <amount USDC> [--key-file <owner key json>] [--send]
//
// The owner signs USDC's ft_transfer_call to the contract with msg {"desk_id":"<desk_id>"} and 1 yoctoNEAR; the
// contract's ft_on_transfer books it as principal (deposited and idle_usdc). When the contract is not registered
// on USDC yet (a new contract never is), a storage_deposit for it goes first, 0.00125 NEAR from the owner: without
// it USDC refuses the transfer.
//
// Default: a dry run. It checks the contract (mainnet Gimbal, code with all four money methods), the desk, the owner's USDC
// and NEAR, and prints every transaction in full. Nothing is signed. --send reads the owner's key file, only then,
// checks it is a full-access key of the desk's owner, sends one transaction at a time, waits for final, and reads
// get_desk after. --send refuses in a linked git worktree. It ends with one block to paste back.

import { UsageError, isMain, parseFlags, run } from './cli.mjs';
import { NEAR_USDC, nearUsdcBalance, nearUsdcRegistered } from './balances.mjs';
import { sendRefusal } from './checks.mjs';
import {
  ROOT, act, describeTx, freeBalance, fullAccessVerdict, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp, panicOf, readKeyFile, tgasText,
  txGasCap, txLink,
} from './near.mjs';
import {
  DESK_ID, FT_TRANSFER_CALL_TGAS, ONE_YOCTO, STORAGE_DEPOSIT_TGAS, USDC_STORAGE_DEPOSIT, eventsOf, ledgerOf, ledgerText, moneyContext, parseUsdc,
  summaryBlock, usdcText,
} from './money.mjs';

const USAGE = `usage: node tools/mainnet/deposit.mjs <contract> <desk_id> <amount USDC> [--key-file <owner key json>] [--send]
  default: dry run (reads mainnet, prints the transactions; no key needed)`;
const SPEC = { '--key-file': 'value', '--send': 'switch' };
/** NEAR the owner keeps free for the gas of both transactions (most of it is refunded). */
export const OWNER_GAS_MARGIN = 5n * 10n ** 22n;

export function parseDepositArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 3) throw new UsageError('the contract, the desk id and the amount are required');
  if (positional.length > 3) throw new UsageError(`unexpected argument ${positional[3]}`);
  const [contract, deskId, amountText] = positional;
  let amount;
  try {
    mainnetId(contract, 'contract');
    amount = parseUsdc(amountText);
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  const send = values['--send'] === true;
  if (send && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: the desk owner signs the deposit');
  return { contract, deskId, amount, keyFile: values['--key-file'] ?? null, send };
}

/** The deposit's transactions: the contract's USDC registration when it has none, then ft_transfer_call. */
export function depositPlan({ contract, deskId, amount, registered }) {
  const txs = [];
  if (!registered) {
    txs.push({
      label: `register ${contract} on USDC (it cannot receive USDC without it)`,
      receiver: NEAR_USDC,
      actions: [act.call('storage_deposit', { account_id: contract, registration_only: true }, STORAGE_DEPOSIT_TGAS, USDC_STORAGE_DEPOSIT)],
    });
  }
  txs.push({
    label: `deposit ${usdcText(amount)} USDC into desk ${deskId}`,
    receiver: NEAR_USDC,
    actions: [act.call('ft_transfer_call', { receiver_id: contract, amount: amount.toString(), msg: JSON.stringify({ desk_id: deskId }) }, FT_TRANSFER_CALL_TGAS, ONE_YOCTO)],
  });
  return txs;
}

/**
 * Runs the deposit; every effect goes through `deps` (tests use fakes). Returns the summary block.
 * deps: near, say, now, tree, readKey(file, accountId).
 */
export async function runDeposit(argv, deps = {}) {
  const a = parseDepositArgs(argv);
  const client = deps.near ?? near;
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);

  say(`gimbal deposit of ${usdcText(a.amount)} USDC into ${a.contract} desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const { desk } = await moneyContext(client, a.contract, a.deskId, ['ft_on_transfer']);
  const owner = desk.owner;
  const before = ledgerOf(desk);
  say(`contract  ${a.contract}: Mainnet Gimbal, its code has the money methods (ft_on_transfer and the other three)`);
  say(`desk      ${a.deskId}: owner ${owner}, paused ${desk.paused}`);
  say(`ledger    ${ledgerText(before)}`);

  const usdc = await nearUsdcBalance(client, owner);
  say(`owner     ${owner}: ${usdcText(usdc)} USDC on NEAR`);
  // The dry run still prints the plan (the USDC may be on its way); --send refuses here.
  const short = usdc < a.amount ? `the owner holds ${usdcText(usdc)} USDC on NEAR, less than the ${usdcText(a.amount)} to deposit` : null;
  if (short !== null && a.send) throw new Error(short);
  if (short !== null) say(`warning   ${short}: --send refuses until it does`);
  const ownerState = await client.account(owner);
  if (ownerState === null) throw new Error(`the desk owner ${owner} does not exist on mainnet`);
  const free = freeBalance(ownerState);
  const registered = await nearUsdcRegistered(client, a.contract);
  say(`usdc      ${a.contract} is ${registered ? '' : 'not '}registered on USDC (${NEAR_USDC})`);

  const txs = depositPlan({ contract: a.contract, deskId: a.deskId, amount: a.amount, registered });
  const need = (registered ? 0n : USDC_STORAGE_DEPOSIT) + OWNER_GAS_MARGIN;
  say(`          ${owner}: ${nearText(BigInt(ownerState.amount), 4)} NEAR, ${nearText(free, 4)} free; the deposit needs ${nearText(need, 5)} free `
    + `(${registered ? '' : '0.00125 registration + '}0.05 for gas, most of it refunded)`);
  if (free < need) throw new Error(`the owner can spend ${nearText(free, 4)} NEAR; the deposit needs ${nearText(need, 5)}`);

  let signer = null;
  let signedBy = 'the owner\'s key, read at --send';
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, owner);
    const verdict = fullAccessVerdict(await client.accessKey(owner, signer.publicKeyString));
    if (verdict !== 'matches') throw new Error(`--key-file is not a full-access key of the desk owner ${owner}: nothing was signed`);
    signedBy = `--key-file, a full-access key of ${owner}`;
  }
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  say();
  txs.forEach((t, i) => {
    say(describeTx(`tx ${i + 1}: ${t.label}`, { signer: owner, signedBy, receiver: t.receiver, actions: t.actions }).join('\n'));
    const cap = txGasCap(fees, { signer: owner, receiver: t.receiver, actions: t.actions });
    say(`  gas       at most ${tgasText(cap.total)} TGas, ${nearTextUp(cap.total * gasPrice, 4)} NEAR; the unused part is refunded`);
  });
  say(`  then      USDC calls ${a.contract}.ft_on_transfer(sender_id ${owner}, amount ${a.amount}, msg {"desk_id":"${a.deskId}"}): principal, `
    + `so deposited and idle_usdc both go up by ${usdcText(a.amount)} (event deposit)`);
  say(`expected  ledger after: deposited ${usdcText(before.deposited + a.amount)}, idle_usdc ${usdcText(before.idle_usdc + a.amount)} USDC; `
    + `the owner's USDC ${usdcText(usdc)} -> ${usdcText(usdc - a.amount)}`);

  const at = () => new Date(now()).toISOString();
  if (!a.send) {
    const block = summaryBlock('deposit', {
      at: at(),
      lines: [
        `contract ${a.contract}, desk ${a.deskId}, owner ${owner}, dry run`,
        `deposit:  ${usdcText(a.amount)} USDC planned in ${txs.length} transaction(s)${registered ? '' : ' (USDC registration first)'}; owner holds ${usdcText(usdc)} USDC`,
        `ledger:   ${ledgerText(before)}`,
        ...(short === null ? [] : [`refused:  ${short}`]),
      ],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. Add --send and --key-file <owner key json>, from the main checkout, to send it.');
    if (short !== null) throw new Error(short);
    return block;
  }

  const lines = [`contract ${a.contract}, desk ${a.deskId}, owner ${owner}, SEND`];
  for (const [i, t] of txs.entries()) {
    const out = await client.send(signer, t.receiver, t.actions, { onSent: (h) => say(`\ntx ${i + 1} sent ${h}; waiting for final`) });
    say(`tx ${i + 1} final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
    for (const log of out.logs) say(`  log ${log}`);
    if (out.failure !== null) {
      lines.push(`tx ${i + 1}:     ${out.hash} FAILED ${panicOf(out.failure)}`);
      throw new Error(`tx ${i + 1} ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
    }
    const method = t.actions[0].method;
    if (method === 'ft_transfer_call') {
      // ft_transfer_call returns the amount the receiver kept; anything less than the deposit went back to the owner.
      const used = out.value === null ? null : BigInt(String(out.value));
      lines.push(`deposit:  tx ${out.hash}, ft_transfer_call returned ${out.value === null ? 'nothing' : `${usdcText(used)} USDC used`}`);
      for (const e of eventsOf(out.logs)) lines.push(`event:    ${e.event} ${JSON.stringify(e.data)}`);
      if (used !== a.amount) {
        lines.push(`refunded: the contract kept ${used === null ? 'an unknown amount' : usdcText(used)} of ${usdcText(a.amount)} USDC; the rest is back with the owner`);
      }
    } else {
      lines.push(`register: tx ${out.hash}, storage_deposit for ${a.contract}`);
    }
  }
  const after = ledgerOf(await client.view(a.contract, 'get_desk', { desk_id: a.deskId }));
  const usdcAfter = await nearUsdcBalance(client, owner);
  lines.push(`ledger:   before ${ledgerText(before)}`);
  lines.push(`ledger:   after  ${ledgerText(after)}`);
  lines.push(`owner:    USDC ${usdcText(usdc)} -> ${usdcText(usdcAfter)}`);
  const block = summaryBlock('deposit', { at: at(), lines });
  say();
  say(block.join('\n'));
  if (after.deposited - before.deposited !== a.amount || after.idle_usdc - before.idle_usdc !== a.amount) {
    throw new Error(`the ledger did not go up by ${usdcText(a.amount)} USDC: compare get_desk with the transaction above`);
  }
  return block;
}

if (isMain(import.meta.url)) await run(() => runDeposit(process.argv.slice(2)), USAGE);
