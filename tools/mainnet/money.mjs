// Shared parts of the money scripts (deposit, fund, withdraw; retire reads some): USDC amounts, the contract's
// gas floors and money methods, the ledger and the performance fee (contract/core/src/fees.rs, ported), the
// contract's events, and the checks every money script runs on the contract and the desk first.

import { MONEY_METHODS, wasmExports } from './deploy.mjs';
import { contractConfigProblems } from './desk.mjs';
import { NO_CODE } from './near.mjs';

/** The least prepaid gas the C8 contract accepts (E_ARGS below it): contract/src/money.rs, prices.rs, lib.rs. */
export const MIN_TGAS = { refresh_prices: 240, fund_venue: 115, withdraw_to_owner: 150, create_desk: 64 };
/** What these scripts attach: the contract recommends 300 for both money methods. */
export const FUND_TGAS = 300n;
export const WITHDRAW_TGAS = 300n;
/** ft_transfer_call on USDC: the token's own work, the contract's ft_on_transfer and ft_resolve_transfer. */
export const FT_TRANSFER_CALL_TGAS = 150n;
export const STORAGE_DEPOSIT_TGAS = 30n;
/** USDC on NEAR's storage registration (storage_balance_bounds, min = max). */
export const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
export const ONE_YOCTO = 1n;

/** "12.5" -> 12500000n (USDC x 1e6); digits with up to 6 decimals, above 0. */
export function parseUsdc(text, what = 'amount') {
  if (typeof text !== 'string' || !/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`${what} ${JSON.stringify(text)} is not a USDC amount (digits, up to 6 decimals)`);
  const [whole, frac = ''] = text.split('.');
  const v = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (v === 0n) throw new Error(`${what} must be above 0`);
  return v;
}

/** USDC x 1e6 as a decimal, trailing zeros cut. */
export function usdcText(e6) {
  const v = BigInt(e6);
  const abs = v < 0n ? -v : v;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v < 0n ? '-' : ''}${abs / 1_000_000n}${frac === '' ? '' : `.${frac}`}`;
}

/** get_desk's ledger as bigints. */
export function ledgerOf(desk) {
  const l = desk?.ledger ?? {};
  const big = (k) => BigInt(String(l[k] ?? 0));
  return { deposited: big('deposited'), withdrawn: big('withdrawn'), fees_paid: big('fees_paid'), hwm: big('hwm'), idle_usdc: big('idle_usdc') };
}

export const ledgerText = (l) => `deposited ${usdcText(l.deposited)}, withdrawn ${usdcText(l.withdrawn)}, fees_paid ${usdcText(l.fees_paid)}, `
  + `hwm ${usdcText(l.hwm)}, idle_usdc ${usdcText(l.idle_usdc)} USDC`;

const shareDown = (value, bps) => (value / 10_000n) * bps + ((value % 10_000n) * bps) / 10_000n;
const MAX = (1n << 128n) - 1n;
const markPaidBy = (fees, bps) => (bps === 0n ? MAX : ((fees + 1n) * 10_000n - 1n) / bps);

/**
 * Books::payout of contract/core/src/fees.rs: the fee withdraw_to_owner charges on `amount`, with the high-water
 * mark it leaves. All bigints.
 */
export function expectedPayout(ledger, amount, performanceBps) {
  const bps = BigInt(performanceBps);
  const paid = ledger.withdrawn + amount;
  const over = paid > ledger.deposited ? paid - ledger.deposited : 0n;
  const target = ledger.hwm > over ? ledger.hwm : over;
  const charged = shareDown(ledger.hwm, bps);
  const due = shareDown(target, bps) - charged;
  let fee;
  let hwmAfter;
  if (due <= amount) {
    fee = due;
    hwmAfter = target;
  } else {
    fee = amount;
    const mark = markPaidBy(charged + amount, bps);
    hwmAfter = mark < ledger.hwm ? ledger.hwm : mark > target ? target : mark;
  }
  return { amount, fee, toOwner: amount - fee, profit: paid - ledger.deposited, hwmBefore: ledger.hwm, hwmAfter };
}

/** The contract's NEP-297 events in a list of logs: [{ event, data }] for standard "gimbal". */
export function eventsOf(logs) {
  const out = [];
  for (const log of logs ?? []) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(log.slice('EVENT_JSON:'.length));
      if (e.standard === 'gimbal') for (const d of e.data ?? []) out.push({ event: e.event, data: d });
    } catch {
      // not an event of ours
    }
  }
  return out;
}

/**
 * What every money script checks first: the contract exists with code, is a mainnet Gimbal contract, and its code
 * has `methods`; the desk exists. Returns { state, config, exported, desk } or throws with every problem.
 */
export async function moneyContext(client, contract, deskId, methods) {
  const state = await client.account(contract);
  if (state === null) throw new Error(`${contract} does not exist on mainnet`);
  if (state.code_hash === NO_CODE) throw new Error(`${contract} has no contract code`);
  const config = await client.view(contract, 'config');
  const bad = contractConfigProblems(config);
  if (bad.length > 0) throw new Error(`${contract} is not a mainnet Gimbal contract:\n  ${bad.join('\n  ')}`);
  const code = await client.code(contract);
  const exported = code === null ? [] : wasmExports(code);
  const missing = methods.filter((m) => !exported.includes(m));
  if (missing.length > 0) {
    throw new Error(`${contract}'s code (code_hash ${state.code_hash}) has no ${missing.join(', ')}: it is not the C8 contract with the money methods `
      + `(${MONEY_METHODS.join(', ')}); nothing can be sent through it. Deploy the C8 code to a new account (README section 8)`);
  }
  const desk = await client.view(contract, 'get_desk', { desk_id: deskId });
  if (desk === null) throw new Error(`${contract} has no desk ${deskId}`);
  return { state, config, exported, desk };
}

/** The block the human pastes back, as checks.mjs prints it. */
export function summaryBlock(name, { at, lines }) {
  return [`=== gimbal ${name} ${at} ===`, ...lines, '=== end ==='];
}

/** The three positional arguments of deposit and withdraw, checked: a mainnet contract, a desk id, a USDC amount. */
export const DESK_ID = /^[a-z0-9-]{1,32}$/;
