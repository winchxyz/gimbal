#!/usr/bin/env node
// Pays a desk's idle USDC on NEAR out to its owner (tools/mainnet/README.md, section 8):
//
//   node tools/mainnet/withdraw.mjs <contract> <desk_id> <amount USDC | all> [--key-file <owner key json>] [--send]
//
// The owner signs withdraw_to_owner(desk_id, amount) with 1 yoctoNEAR and 300 TGas (the contract refuses under
// 150). The contract sends the owner's share first and the performance fee to the treasury once that landed
// (contract/src/money.rs). The dry run prints the fee the ledger gives (contract/core/src/fees.rs, ported) before
// anything is sent; --send prints the payout and fee_charged events after.
//
// Default: a dry run that reads mainnet and signs nothing. --send reads the owner's key file, only then, checks it is
// a full-access key of the desk's owner and refuses in a linked git worktree. It ends with one block to paste back.

import { UsageError, isMain, parseFlags, run } from './cli.mjs';
import { nearUsdcBalance, nearUsdcRegistered } from './balances.mjs';
import { sendRefusal } from './checks.mjs';
import {
  ROOT, act, describeTx, freeBalance, fullAccessVerdict, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp, panicOf, readKeyFile, tgasText,
  txGasCap, txLink,
} from './near.mjs';
import {
  DESK_ID, MIN_TGAS, ONE_YOCTO, WITHDRAW_TGAS, eventsOf, expectedPayout, ledgerOf, ledgerText, moneyContext, parseUsdc, summaryBlock, usdcText,
} from './money.mjs';

const USAGE = `usage: node tools/mainnet/withdraw.mjs <contract> <desk_id> <amount USDC | all> [--key-file <owner key json>] [--send]
  default: dry run (reads mainnet, prints the transaction and the expected fee; no key needed)`;
const SPEC = { '--key-file': 'value', '--send': 'switch' };
/** NEAR the owner keeps free: 300 TGas reserved until the refund, at 1e8 yocto per gas (0.03 NEAR), and margin. */
export const OWNER_GAS_MARGIN = 5n * 10n ** 22n;

export function parseWithdrawArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 3) throw new UsageError('the contract, the desk id and the amount (or all) are required');
  if (positional.length > 3) throw new UsageError(`unexpected argument ${positional[3]}`);
  const [contract, deskId, amountText] = positional;
  let amount = null;
  try {
    mainnetId(contract, 'contract');
    if (amountText !== 'all') amount = parseUsdc(amountText);
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  const send = values['--send'] === true;
  if (send && values['--key-file'] === undefined) throw new UsageError('--send needs --key-file: only the desk owner can withdraw');
  return { contract, deskId, amount, keyFile: values['--key-file'] ?? null, send };
}

export const withdrawActions = (deskId, amount) => [act.call('withdraw_to_owner', { desk_id: deskId, amount: amount.toString() }, WITHDRAW_TGAS, ONE_YOCTO)];

/** The payout and fee lines of a planned withdrawal. */
export function payoutLines(p, treasury) {
  return [
    `expected  payout ${usdcText(p.amount)} USDC: ${usdcText(p.toOwner)} to the owner, fee ${usdcText(p.fee)} to the treasury ${treasury}`,
    `          profit after it ${usdcText(p.profit)} (withdrawn + amount - deposited); high-water mark ${usdcText(p.hwmBefore)} -> ${usdcText(p.hwmAfter)}`,
  ];
}

/** Runs the withdrawal; deps: near, say, now, tree, readKey(file, accountId). Returns the summary block. */
export async function runWithdraw(argv, deps = {}) {
  const a = parseWithdrawArgs(argv);
  const client = deps.near ?? near;
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);

  say(`gimbal withdraw from ${a.contract} desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const { config, desk } = await moneyContext(client, a.contract, a.deskId, ['withdraw_to_owner']);
  const owner = desk.owner;
  const treasury = config.treasury.near;
  const before = ledgerOf(desk);
  say(`contract  ${a.contract}: Mainnet Gimbal, its code has withdraw_to_owner; performance fee ${config.fees.performance_bps} bps to ${treasury}`);
  say(`desk      ${a.deskId}: owner ${owner}, paused ${desk.paused}`);
  say(`ledger    ${ledgerText(before)}`);
  const amount = a.amount ?? before.idle_usdc;
  if (amount === 0n) throw new Error(`desk ${a.deskId} holds no idle USDC on NEAR: nothing to withdraw`);
  if (amount > before.idle_usdc) {
    throw new Error(`${usdcText(amount)} USDC is over desk ${a.deskId}'s idle USDC on NEAR, ${usdcText(before.idle_usdc)}: the contract refuses it (E_SIZE). `
      + 'Money on a venue must come back to the contract first');
  }
  const p = expectedPayout(before, amount, config.fees.performance_bps);
  for (const line of payoutLines(p, treasury)) say(line);

  if (!(await nearUsdcRegistered(client, owner))) throw new Error(`the owner ${owner} is not registered on USDC on NEAR: the payout transfer would fail`);
  const treasuryOk = await nearUsdcRegistered(client, treasury);
  say(`usdc      the owner is registered on USDC; the treasury ${treasury} is ${treasuryOk ? '' : 'NOT '}registered`);
  if (!treasuryOk && p.fee > 0n) say(`warning   the fee transfer would fail and the fee ${usdcText(p.fee)} would stay in the desk's idle USDC, due again at the next payout`);
  const usdcBefore = await nearUsdcBalance(client, owner);
  const ownerState = await client.account(owner);
  const free = freeBalance(ownerState);
  say(`owner     ${owner}: ${usdcText(usdcBefore)} USDC on NEAR, ${nearText(free, 4)} NEAR free`);
  if (free < OWNER_GAS_MARGIN) throw new Error(`the owner can spend ${nearText(free, 4)} NEAR; withdraw_to_owner reserves 300 TGas (keep ${nearText(OWNER_GAS_MARGIN)} free)`);

  let signer = null;
  let signedBy = 'the owner\'s key, read at --send';
  if (a.send) {
    signer = (deps.readKey ?? readKeyFile)(a.keyFile, owner);
    if (fullAccessVerdict(await client.accessKey(owner, signer.publicKeyString)) !== 'matches') {
      throw new Error(`--key-file is not a full-access key of the desk owner ${owner}: nothing was signed`);
    }
    signedBy = `--key-file, a full-access key of ${owner}`;
  }
  const actions = withdrawActions(a.deskId, amount);
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: owner, receiver: a.contract, actions });
  say();
  say(describeTx(`tx: withdraw ${usdcText(amount)} USDC to the owner`, { signer: owner, signedBy, receiver: a.contract, actions }).join('\n'));
  say(`  gas       at most ${tgasText(cap.total)} TGas, ${nearTextUp(cap.total * gasPrice, 4)} NEAR (the contract needs at least ${MIN_TGAS.withdraw_to_owner}); the unused part is refunded`);
  say(`  then      USDC ft_transfer of ${usdcText(p.toOwner)} to ${owner}${p.fee > 0n ? `, then of ${usdcText(p.fee)} to ${treasury}` : ' (no fee: no profit over the high-water mark)'}; `
    + 'events payout and fee_charged once settled');

  const at = () => new Date(now()).toISOString();
  if (!a.send) {
    const block = summaryBlock('withdraw', {
      at: at(),
      lines: [
        `contract ${a.contract}, desk ${a.deskId}, owner ${owner}, dry run`,
        `withdraw: ${usdcText(amount)} USDC planned; expected ${usdcText(p.toOwner)} to the owner, fee ${usdcText(p.fee)}`,
        `ledger:   ${ledgerText(before)}`,
      ],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent. Add --send and --key-file <owner key json>, from the main checkout, to send it.');
    return block;
  }

  const out = await client.send(signer, a.contract, actions, { onSent: (h) => say(`\ntx sent ${h}; waiting for final`) });
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) say(`  log ${log}`);
  const lines = [`contract ${a.contract}, desk ${a.deskId}, owner ${owner}, SEND`];
  lines.push(`withdraw: tx ${out.hash} ${out.failure === null ? `returned ${JSON.stringify(out.value)}` : `FAILED ${panicOf(out.failure)}`}`);
  lines.push(`expected: ${usdcText(p.toOwner)} to the owner, fee ${usdcText(p.fee)}`);
  for (const e of eventsOf(out.logs)) lines.push(`event:    ${e.event} ${JSON.stringify(e.data)}`);
  const after = ledgerOf(await client.view(a.contract, 'get_desk', { desk_id: a.deskId }));
  const usdcAfter = await nearUsdcBalance(client, owner);
  lines.push(`ledger:   before ${ledgerText(before)}`);
  lines.push(`ledger:   after  ${ledgerText(after)}`);
  lines.push(`owner:    USDC ${usdcText(usdcBefore)} -> ${usdcText(usdcAfter)}`);
  const block = summaryBlock('withdraw', { at: at(), lines });
  say();
  say(block.join('\n'));
  if (out.failure !== null) throw new Error(`withdraw_to_owner ${out.hash}: ${panicOf(out.failure)} (${txLink(out.hash)})`);
  if (out.value !== true) throw new Error(`withdraw_to_owner returned ${JSON.stringify(out.value)}: nothing reached the owner; the ledger is as before`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runWithdraw(process.argv.slice(2)), USAGE);
