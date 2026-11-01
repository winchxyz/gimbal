#!/usr/bin/env node
// Sends a desk's idle USDC on NEAR to one of its venues through 1Click (tools/mainnet/README.md, section 8):
//
//   node tools/mainnet/fund.mjs <contract> <desk_id> <hyperliquid|solana|orderly> <amount USDC>
//        [--slippage-bps <n, default 100>] [--key-file <operator key json>] [--timeout-s <s, default 900>] [--send]
//
//   hyperliquid  HyperCore USDC to the desk's EVM address (lands in perps)
//   solana       Solana USDC to the desk's Solana authority
//   orderly      Arbitrum USDC to the desk's pinned Orderly receiver (set_orderly_receiver first; at least 6 USDC out)
//
// The quote: USDC on NEAR -> the venue, refundTo = the desk owner (a refund on NEAR is a plain ft_transfer and
// must not go to the contract), recipient = the desk's venue address. It is checked here with the contract's own
// rules (oneclick.mjs: signature, fields, >= 0.5 % room below amountOut, the policy's cost bound and the hourly
// fund_venue budget), and against what was typed (recipient and destinationAsset of this venue, amountIn = the
// amount in NEAR USDC base units, slippageTolerance = --slippage-bps), before anything is signed; then
// fund_venue(desk_id, quote, quote_signature, reason) goes out, signed with the engine's operator key, 300 TGas.
// After it: POST /deposit/submit, then 1Click's status and the venue balance are read until the transfer lands,
// fails, or --timeout-s passes. "Landed" means 1Click SUCCESS and the venue's own record of the delivery:
// Hyperliquid, an incoming entry to the desk address in its non-funding ledger since the fund_venue, of at least
// minAmountOut (a balance moves with PnL too); Solana, the USDC token account up by at least minAmountOut. Orderly
// holdings are not public, so there it says "unconfirmed".
//
// Default: a dry run with a DRY quote (dry: true reserves no deposit address and cannot be paid). Only --send asks
// for a live quote, and only after every other check passed. ONECLICK_API_KEY (from the environment or .env) is
// sent as a header and never printed. --send reads the operator key file, only then, checks it is the operator
// FunctionCall key for this contract, and refuses in a linked git worktree. It ends with one block to paste back.

import { UsageError, envValues, isMain, parseFlags, run } from './cli.mjs';
import { hyperliquidLedger, hyperliquidPerps, rpcUrls, solanaBalances } from './balances.mjs';
import { sendRefusal } from './checks.mjs';
import { OPERATOR_METHODS, operatorKeyFile } from './desk.mjs';
import {
  ROOT, act, describeTx, isFunctionCallKey, linkedWorktreeOf, mainnetId, near, nearText, nearTextUp, panicOf, readKeyFile, sleep as pause, tgasText,
  txGasCap, txLink,
} from './near.mjs';
import { DESK_ID, FUND_TGAS, MIN_TGAS, eventsOf, ledgerOf, ledgerText, moneyContext, parseUsdc, summaryBlock, usdcText } from './money.mjs';
import {
  ASSETS, FINAL_STATUSES, ORDERLY_MIN_OUT_E6, QuoteRefusal, allowedCostE8, canonicalQuote, checkCost, fundCostBudgetE8, quoteStatus, requestQuote,
  submitDeposit, transferCostE8, usdE8Text, verifyQuote,
} from './oneclick.mjs';

export const VENUES = ['hyperliquid', 'solana', 'orderly'];
const USAGE = `usage: node tools/mainnet/fund.mjs <contract> <desk_id> <${VENUES.join('|')}> <amount USDC>
         [--slippage-bps <n, default 100>] [--key-file <operator key json>] [--timeout-s <s, default 900>] [--send]
  default: dry run with a dry 1Click quote (reserves nothing; no key needed)`;
const SPEC = { '--slippage-bps': 'value', '--key-file': 'value', '--timeout-s': 'value', '--send': 'switch' };
/** The least a HyperCore deposit through 1Click takes (CLAUDE.md: minimum 0.5). */
export const HYPERCORE_MIN_E6 = 500_000n;

export function parseFundArgs(argv) {
  const { positional, values } = parseFlags(argv, SPEC);
  if (positional.length < 4) throw new UsageError('the contract, the desk id, the venue and the amount are required');
  if (positional.length > 4) throw new UsageError(`unexpected argument ${positional[4]}`);
  const [contract, deskId, venue, amountText] = positional;
  let amount;
  try {
    mainnetId(contract, 'contract');
    amount = parseUsdc(amountText);
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (!DESK_ID.test(deskId)) throw new UsageError(`desk id ${JSON.stringify(deskId)} is not 1 to 32 characters of a-z, 0-9 and -`);
  if (!VENUES.includes(venue)) throw new UsageError(`venue ${venue} is not one of ${VENUES.join(', ')}`);
  const slippage = values['--slippage-bps'] === undefined ? 100 : Number(values['--slippage-bps']);
  // fund_venue needs >= 50 bps of room below amountOut, and 1Click derives minAmountOut from the tolerance.
  if (!Number.isInteger(slippage) || slippage < 60 || slippage > 200) throw new UsageError('--slippage-bps must be a whole number from 60 to 200 (fund_venue needs at least 50 bps of room)');
  const timeoutS = values['--timeout-s'] === undefined ? 900 : Number(values['--timeout-s']);
  if (!Number.isInteger(timeoutS) || timeoutS < 60 || timeoutS > 3600) throw new UsageError('--timeout-s must be a whole number from 60 to 3600');
  return {
    contract, deskId, venue, amount, slippage, timeoutS, send: values['--send'] === true,
    keyFile: values['--key-file'] ?? operatorKeyFile(contract),
  };
}

/** Where a venue's money goes: { recipient, destinationAsset, what }, or why it cannot. */
export function venueTarget(venue, desk) {
  if (venue === 'hyperliquid') return { recipient: desk.evm_address, destinationAsset: ASSETS.hypercoreUsdc, what: `HyperCore USDC to the desk EVM address ${desk.evm_address} (perps)` };
  if (venue === 'solana') return { recipient: desk.solana.authority, destinationAsset: ASSETS.solanaUsdc, what: `Solana USDC to the desk Solana authority ${desk.solana.authority}` };
  if (desk.orderly_receiver === null || desk.orderly_receiver === undefined) {
    throw new Error('the desk has no pinned Orderly receiver: the owner pins it with set_orderly_receiver first (README section 6); fund_venue refuses '
      + 'any other Arbitrum recipient');
  }
  return { recipient: desk.orderly_receiver, destinationAsset: ASSETS.arbitrumUsdc, what: `Arbitrum USDC to the pinned Orderly receiver ${desk.orderly_receiver}` };
}

/** The 1Click quote request of a fund_venue transfer. */
export function fundQuoteBody({ dry, amount, owner, target, slippage, now }) {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippage,
    originAsset: ASSETS.nearUsdc,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: target.destinationAsset,
    amount: amount.toString(),
    refundTo: owner,
    refundType: 'ORIGIN_CHAIN',
    recipient: target.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 30 * 60_000).toISOString(),
  };
}

/** The checks of a quote answer, as fund_venue makes them, plus the policy's cost and the hourly budget. */
export function checkFundQuote(response, { contract, deskId, desk, policy, now, dry }) {
  if (typeof response?.signature !== 'string') throw new Error('1Click answered without a signature');
  const quote = canonicalQuote(response);
  const q = verifyQuote(quote, response.signature, 'fund_venue', {
    desk: { desk_id: deskId, evm: desk.evm_address, sol: desk.solana.authority, orderly_receiver: desk.orderly_receiver ?? null, owner: desk.owner },
    contract, now_ms: now, remaining_cap_e8: 0n, dry_ok: dry,
  });
  checkCost(q, policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6);
  const cost = transferCostE8(q);
  const budget = fundCostBudgetE8(Math.max(policy.max_notional_usd, policy.unpriced_max_notional_usd), policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6);
  if (cost > budget) throw new QuoteRefusal('E_RESCUE_CAP', `the fund_venue may cost ${usdE8Text(cost)} USD, over the whole hourly fund_venue cost budget of ${usdE8Text(budget)} USD`);
  const roomBps = q.amountOut === 0n ? 0n : ((q.amountOut - q.minAmountOut) * 10_000n) / q.amountOut;
  return { quote, signature: response.signature, q, cost, budget, allowed: allowedCostE8(q.amountInE8, policy.max_transfer_cost_bps, policy.max_transfer_cost_flat_e6), roomBps };
}

/**
 * Why a verified quote is not the transfer the human asked for (an empty list when it is): the venue's recipient
 * and destination asset, the typed amount in NEAR USDC base units (6 decimals), the requested slippage, EXACT_INPUT.
 */
export function quoteMismatch(quote, { venue, amount, slippage, target }) {
  const f = JSON.parse(quote);
  const out = [];
  const same = (x, y) => typeof x === 'string' && typeof y === 'string' && (x === y || (x.startsWith('0x') && x.toLowerCase() === y.toLowerCase()));
  if (!same(f.recipient, target.recipient)) out.push(`recipient ${f.recipient} is not ${venue}'s (${target.recipient})`);
  if (f.destinationAsset !== target.destinationAsset) out.push(`destinationAsset ${f.destinationAsset} is not ${venue}'s (${target.destinationAsset})`);
  if (f.amountIn !== amount.toString()) out.push(`amountIn ${f.amountIn} is not the ${usdcText(amount)} USDC asked (${amount})`);
  if (Number(f.slippageTolerance) !== slippage) out.push(`slippageTolerance ${f.slippageTolerance} is not the ${slippage} asked`);
  if (f.swapType !== 'EXACT_INPUT') out.push(`swapType ${f.swapType} is not EXACT_INPUT`);
  return out;
}

/**
 * A venue's balance that only a transfer changes, USDC x 1e6, and its name: Hyperliquid's main perps totalRawUsd
 * (cash: without unrealized PnL), the Solana USDC token account; null for Orderly (holdings need a signed read).
 */
export const VENUE_BALANCE = { hyperliquid: 'totalRawUsd', solana: 'USDC token account', orderly: null };
async function venueBalanceE6(venue, desk, fetchImpl, urls) {
  if (venue === 'hyperliquid') return (await hyperliquidPerps(fetchImpl, desk.evm_address)).totalRawE6;
  if (venue === 'solana') return (await solanaBalances(fetchImpl, urls.solana, { authority: desk.solana.authority, tokenAccounts: { usdc: desk.solana.usdc_ata } })).tokens.usdc.amount;
  return null;
}
/** Polls after 1Click says SUCCESS while the venue has not shown the delivery yet. */
const POLLS_AFTER_SUCCESS = 30;
/** Ledger entries this long before the fund_venue was sent still count (clock skew between this machine and HL). */
const LEDGER_SLACK_MS = 60_000;
/** Ledger entry types that bring USDC into an address. */
export const HL_INCOMING = ['deposit', 'send', 'internalTransfer', 'spotTransfer'];

/**
 * The Hyperliquid ledger entry that is the 1Click delivery, or null: incoming (HL_INCOMING), booked since `since`,
 * to the desk address (a `deposit` has no destination: the bridge credits the address itself), not sent by the
 * desk, of at least `minOutE6` USDC.
 */
export function hlDelivery(entries, { desk, since, minOutE6 }) {
  const me = desk.toLowerCase();
  return entries.find((e) => e.time >= since && HL_INCOMING.includes(e.type) && e.usdcE6 !== null && e.usdcE6 >= minOutE6 && e.user !== me
    && (e.destination === null ? e.type === 'deposit' : e.destination === me)) ?? null;
}

/**
 * Runs the funding; deps: near, fetch, say, now, tree, readKey(file, accountId), env (Map of ONECLICK_API_KEY),
 * sleep, pollMs. Returns the summary block.
 */
export async function runFund(argv, deps = {}) {
  const a = parseFundArgs(argv);
  const client = deps.near ?? near;
  const fetchImpl = deps.fetch ?? ((...x) => globalThis.fetch(...x));
  const say = deps.say ?? ((s = '') => console.log(s));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? pause;
  const tree = deps.tree === undefined ? linkedWorktreeOf(ROOT) : deps.tree;
  const refusal = sendRefusal(a.send, tree);
  if (refusal !== null) throw new Error(refusal);

  say(`gimbal fund ${a.venue} with ${usdcText(a.amount)} USDC from ${a.contract} desk ${a.deskId}: ${a.send ? 'SEND' : 'dry run'}`);
  if (tree !== null) say(`warning   ${tree} is a linked git worktree: --send refuses here; run it from the main checkout`);
  const status = await client.rpc('status', []);
  say(`chain     ${status.chain_id}, block ${status.sync_info.latest_block_height}`);
  const { desk } = await moneyContext(client, a.contract, a.deskId, ['fund_venue']);
  const policy = desk.policy;
  const ledger = ledgerOf(desk);
  const signerId = desk.operator ?? desk.owner;
  say(`contract  ${a.contract}: Mainnet Gimbal, its code has fund_venue`);
  say(`desk      ${a.deskId}: owner ${desk.owner}, operator ${desk.operator ?? 'none (the operator key is on the owner\'s account)'}, paused ${desk.paused}`);
  say(`ledger    ${ledgerText(ledger)}`);
  say(`policy    transfer cost at most max(${policy.max_transfer_cost_bps} bps, ${usdcText(BigInt(policy.max_transfer_cost_flat_e6))} USDC) per transfer`);
  const target = venueTarget(a.venue, desk);
  say(`venue     ${a.venue}: ${target.what}`);
  if (a.venue === 'hyperliquid' && a.amount < HYPERCORE_MIN_E6) throw new Error('1Click takes at least 0.5 USDC into HyperCore');
  if (a.venue === 'orderly' && a.amount < ORDERLY_MIN_OUT_E6 + 1_000_000n) throw new Error('the Orderly receiver needs minAmountOut >= 6 USDC: send at least 7 USDC');
  // Checked before the quote: a live quote reserves a deposit address, so --send asks for one only when it can pay it.
  const short = a.amount > ledger.idle_usdc
    ? `${usdcText(a.amount)} USDC is over desk ${a.deskId}'s idle USDC on NEAR, ${usdcText(ledger.idle_usdc)}: the contract refuses it (E_SIZE); deposit first (deposit.mjs)`
    : null;
  if (short !== null && a.send) throw new Error(short);

  const env = deps.env ?? envValues(['ONECLICK_API_KEY']);
  const apiKey = env.get('ONECLICK_API_KEY')?.value ?? null;
  say(`1click    ${apiKey === null ? 'no ONECLICK_API_KEY: 1Click adds 0.2 % to the fee' : `ONECLICK_API_KEY set (from ${env.get('ONECLICK_API_KEY').from}; not shown)`}`);

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

  const urls = rpcUrls();
  const venueBefore = await venueBalanceE6(a.venue, desk, fetchImpl, urls).catch(() => null);
  say(`balance   ${a.venue} now: ${venueBefore === null ? (a.venue === 'orderly' ? 'not public (Orderly holdings need a signed read); 1Click status decides' : 'could not be read') : `${usdcText(venueBefore)} USDC`}`);

  const body = fundQuoteBody({ dry: !a.send, amount: a.amount, owner: desk.owner, target, slippage: a.slippage, now: now() });
  say(`\nquote     POST https://1click.chaindefuser.com/v0/quote ${a.send ? '(LIVE: reserves a deposit address)' : '(dry: reserves nothing)'}`);
  say(`          ${JSON.stringify(body)}`);
  const r = await requestQuote(fetchImpl, body, apiKey);
  if (r.status < 200 || r.status >= 300 || !r.body?.quote) throw new Error(`1Click refused the quote: HTTP ${r.status} ${JSON.stringify(r.body?.message ?? r.body).slice(0, 300)}`);
  const qt = r.body.quote;
  say(`          -> amountIn ${qt.amountIn}, amountOut ${qt.amountOut} (${qt.amountOutFormatted}), minAmountOut ${qt.minAmountOut}, timeEstimate ${qt.timeEstimate ?? '?'} s`
    + `${qt.depositAddress ? `, depositAddress ${qt.depositAddress}` : ''}, signed ${r.body.timestamp}`);
  const checked = checkFundQuote(r.body, { contract: a.contract, deskId: a.deskId, desk, policy, now: now(), dry: !a.send });
  const q = checked.q;
  const mismatch = quoteMismatch(checked.quote, { venue: a.venue, amount: a.amount, slippage: a.slippage, target });
  if (mismatch.length > 0) throw new Error(`the quote is not the transfer asked for: nothing was signed\n  ${mismatch.join('\n  ')}`);
  say(`verified  1Click's signature over the canonical quote; fund_venue's field rules${a.send ? '' : ' (a dry quote passes here only; the contract takes live quotes)'}`);
  say(`          what was asked: recipient ${target.recipient}, ${target.destinationAsset}, amountIn ${a.amount}, slippage ${a.slippage} bps, EXACT_INPUT`);
  say(`          cost ${usdE8Text(checked.cost)} USDC (amountIn - minAmountOut), allowed ${usdE8Text(checked.allowed)}; room below amountOut ${checked.roomBps} bps (>= 50); `
    + `hourly fund_venue budget ${usdE8Text(checked.budget)} USD (what earlier transfers used is not readable; the contract checks it)`);

  const args = { desk_id: a.deskId, quote: checked.quote, quote_signature: checked.signature, reason: `canary: fund ${a.venue} with ${usdcText(a.amount)} USDC` };
  const actions = [act.call('fund_venue', args, FUND_TGAS, 0n)];
  const fees = await client.fees();
  const gasPrice = BigInt((await client.rpc('gas_price', [null])).gas_price);
  const cap = txGasCap(fees, { signer: signerId, receiver: a.contract, actions });
  say();
  say(describeTx(`tx: fund_venue (operator key)`, { signer: signerId, signedBy, receiver: a.contract, actions }).join('\n'));
  say(`  gas       at most ${tgasText(cap.total)} TGas, ${nearTextUp(cap.total * gasPrice, 4)} NEAR (the contract needs at least ${MIN_TGAS.fund_venue}); the unused part is refunded`);
  say(`  then      the contract registers ${q.depositAddress ?? '<the live quote\'s deposit address>'} and ${desk.owner} on USDC (0.00125 NEAR each from its own balance), `
    + `ft_transfer of ${usdcText(q.amountIn)} USDC to the deposit address, on_fund_venue (true, or false with the USDC back in idle_usdc)`);
  say(`expected  idle_usdc ${usdcText(ledger.idle_usdc)} -> ${usdcText(ledger.idle_usdc - (a.amount > ledger.idle_usdc ? ledger.idle_usdc : a.amount))}; `
    + `${a.venue} gets at least ${usdcText(q.minAmountOutE8 / 100n)} USDC (minAmountOut)`);

  const at = () => new Date(now()).toISOString();
  if (!a.send) {
    const block = summaryBlock('fund', {
      at: at(),
      lines: [
        `contract ${a.contract}, desk ${a.deskId}, venue ${a.venue}, dry run`,
        `quote:    dry, amountIn ${q.amountIn}, amountOut ${q.amountOut}, minAmountOut ${q.minAmountOut}; cost ${usdE8Text(checked.cost)} of ${usdE8Text(checked.allowed)} allowed, room ${checked.roomBps} bps`,
        `ledger:   ${ledgerText(ledger)}`,
        ...(short === null ? [] : [`refused:  ${short}`]),
      ],
    });
    say();
    say(block.join('\n'));
    say('\ndry run: nothing was signed or sent, and the dry quote reserved nothing. --send asks for a live quote, checks it the same way and sends fund_venue.');
    if (short !== null) throw new Error(short);
    return block;
  }

  const lines = [`contract ${a.contract}, desk ${a.deskId}, venue ${a.venue}, SEND`];
  lines.push(`quote:    live, depositAddress ${q.depositAddress}, amountIn ${q.amountIn}, amountOut ${q.amountOut}, minAmountOut ${q.minAmountOut}, signed ${r.body.timestamp}`);
  const sentAt = now();
  const out = await client.send(signer, a.contract, actions, { onSent: (h) => say(`\ntx sent ${h}; waiting for final`) });
  say(`tx final: ${txLink(out.hash)} (${out.burntTgas} TGas, ${nearText(out.burntYocto, 6)} NEAR burnt)`);
  for (const log of out.logs) say(`  log ${log}`);
  lines.push(`fund:     tx ${out.hash} ${out.failure === null ? `returned ${JSON.stringify(out.value)}` : `FAILED ${panicOf(out.failure)}`}`);
  for (const e of eventsOf(out.logs)) lines.push(`event:    ${e.event} ${JSON.stringify(e.data)}`);
  const after = ledgerOf(await client.view(a.contract, 'get_desk', { desk_id: a.deskId }));
  lines.push(`ledger:   after ${ledgerText(after)}`);
  const done = (extra = []) => {
    const block = summaryBlock('fund', { at: at(), lines: [...lines, ...extra] });
    say();
    say(block.join('\n'));
    return block;
  };
  if (out.failure !== null || out.value !== true) {
    done();
    throw new Error(`fund_venue ${out.hash}: ${out.failure !== null ? panicOf(out.failure) : `returned ${JSON.stringify(out.value)}: the transfer failed and the USDC is back in idle_usdc`} (${txLink(out.hash)})`);
  }

  const submit = await submitDeposit(fetchImpl, out.hash, q.depositAddress, apiKey).catch((e) => ({ status: 0, body: { message: e.message } }));
  say(`1click    POST /deposit/submit {"txHash":"${out.hash}","depositAddress":"${q.depositAddress}"} -> HTTP ${submit.status}`);
  const deadline = now() + a.timeoutS * 1000;
  // "Landed" needs both: 1Click SUCCESS and the venue's own record of the delivery. Hyperliquid: an incoming entry
  // in the desk's non-funding ledger since the fund_venue, to the desk address, of at least minAmountOut (a balance
  // can move for other reasons, PnL among them). Solana: the USDC token account up by at least minAmountOut.
  // Orderly: not public, so unconfirmed.
  const minOutE6 = q.minAmountOutE8 / 100n;
  const balanceName = VENUE_BALANCE[a.venue];
  let last = null;
  let landed = null;
  let delivery = null;
  let venueNow = venueBefore;
  let afterSuccess = 0;
  for (;;) {
    const s = await quoteStatus(fetchImpl, q.depositAddress, apiKey).catch((e) => ({ status: 0, body: { status: `unread (${e.message})` } }));
    const st = s.body?.status ?? `HTTP ${s.status}`;
    if (st !== last) say(`1click    status ${st} at ${at()}`);
    last = st;
    venueNow = await venueBalanceE6(a.venue, desk, fetchImpl, urls).catch(() => venueNow);
    if (a.venue === 'hyperliquid') {
      const entries = await hyperliquidLedger(fetchImpl, desk.evm_address, sentAt - LEDGER_SLACK_MS).catch(() => []);
      delivery = hlDelivery(entries, { desk: desk.evm_address, since: sentAt - LEDGER_SLACK_MS, minOutE6 });
      if (delivery !== null) landed = delivery.usdcE6;
    } else if (venueBefore !== null && venueNow !== null && venueNow - venueBefore >= minOutE6) {
      landed = venueNow - venueBefore;
    }
    if (FINAL_STATUSES.includes(st) && (st !== 'SUCCESS' || a.venue === 'orderly' || landed !== null)) break;
    if (st === 'SUCCESS' && ++afterSuccess >= POLLS_AFTER_SUCCESS) break;
    if (now() >= deadline) break;
    await sleep(deps.pollMs ?? 10_000);
  }
  const up = venueBefore === null || venueNow === null ? null : venueNow - venueBefore;
  const extra = [
    `1click:   status ${last}`,
    `venue:    ${a.venue} ${balanceName === null || venueBefore === null ? 'balance not public or not read' : `${balanceName} ${usdcText(venueBefore)} -> ${venueNow === null ? '?' : usdcText(venueNow)} USDC`}`
      + `${a.venue === 'hyperliquid' && venueBefore !== null ? ' (shown only: the landing is read from the ledger)' : ''}`,
  ];
  if (last !== 'SUCCESS') extra.push(`landed:   no: 1Click status ${last}`);
  else if (a.venue === 'hyperliquid') {
    extra.push(delivery !== null
      ? `landed:   yes: 1Click SUCCESS and a Hyperliquid ledger ${delivery.type} of ${usdcText(delivery.usdcE6)} USDC to the desk (>= minAmountOut ${usdcText(minOutE6)}), ${delivery.hash}`
      : `landed:   unconfirmed: 1Click SUCCESS, but no Hyperliquid ledger entry to the desk of at least minAmountOut ${usdcText(minOutE6)} USDC since the fund_venue; check the desk's ledger before counting it`);
  } else if (landed !== null) extra.push(`landed:   yes: 1Click SUCCESS and the ${a.venue} ${balanceName} up ${usdcText(landed)} USDC (>= minAmountOut ${usdcText(minOutE6)})`);
  else if (up === null) extra.push(`landed:   unconfirmed: 1Click SUCCESS; the ${a.venue} balance is not public or could not be read, so it is not checked here`);
  else extra.push(`landed:   not seen: 1Click SUCCESS but the ${a.venue} ${balanceName} is up ${usdcText(up)} USDC (< minAmountOut ${usdcText(minOutE6)}); check the venue before counting it`);
  if (last !== 'SUCCESS') extra.push(`open:     not finished within ${a.timeoutS} s or not a success: GET https://1click.chaindefuser.com/v0/status?depositAddress=${q.depositAddress}; a refund goes to ${desk.owner}`);
  const block = done(extra);
  if (last === 'REFUNDED' || last === 'FAILED') throw new Error(`1Click ended the transfer ${last}: the USDC goes back to the owner ${desk.owner}, not to the desk`);
  return block;
}

if (isMain(import.meta.url)) await run(() => runFund(process.argv.slice(2)), USAGE);
