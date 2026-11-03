// A scripted list of malicious operator requests against one desk, for `npm run attack` and the MCP try_attack tool.
// Each attack is a request an agent holding the operator key could send; the contract (or the NEAR node, for a
// method outside the key's list) must refuse it. Nothing here checks the request itself: the point is to show what
// the chain answers. A request that comes back signed is the failure this script exists to catch.

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { NearContractClient, NearNetwork, NearTransport } from '../contract/near-client.ts';
import { formatE8, parseE8 } from '../contract/replay-checks.ts';
import type { DeskView, HlOrder } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown, parseRefusal } from '../contract/types.ts';
import { ASSETS, stableStringify } from '../rescue/oneclick.ts';
import { base58 } from '../venues/orderly-signer.ts';

/** A real 1Click quote (signed by 1Click on 2026-10-31) for the contract tests' desk, not for any live desk. */
export const RECORDED_QUOTES = new URL('../../../contract/core/tests/vectors/oneclick-live.json', import.meta.url);

/** An address no desk owns: where every attack tries to send the money. */
export const ATTACKER_EVM = '0x000000000000000000000000000000000000dead';

const REASON = 'attack demo: this request must be refused';
const METER_MAX_ORDERS = 20;

export type AttackContract = Pick<NearContractClient, 'getDesk' | 'prices' | 'hlOrder' | 'fundVenue' | 'evmUsdcToIntents' | 'orderlyRequest'>;

export interface AttackDeps {
  network: NearNetwork;
  contractId: string;
  deskId: string;
  contract: AttackContract;
  /** For the two requests the client has no method for (an extra argument, a method outside the key). */
  transport: Pick<NearTransport, 'call'>;
  now?: () => number;
  /** Where the recorded 1Click quote is read from (tests point it elsewhere). */
  recordedQuotes?: URL | string;
}

/** What one attack would send. */
export interface AttackPlan {
  method: string;
  args: Record<string, unknown>;
  /** The code the chain should answer; NODE for a transaction the node refuses before it runs. */
  expect: string;
  note?: string;
}

export type Outcome =
  | 'refused'          // the contract panicked with a code; the transaction is on chain
  | 'rejected'         // the node refused the transaction: nothing ran, no tx
  | 'signed'           // it got through: the attack worked
  | 'dry'              // not sent
  | 'skipped'
  | 'error';           // something else failed (RPC, unreadable answer)

export interface AttackResult {
  id: string;
  title: string;
  method: string;
  expect: string;
  outcome: Outcome;
  code: string | null;
  tx: string | null;
  detail: string;
  /** The meter attack: how many orders were signed before the refusal. */
  signed?: number;
}

export interface Attack {
  id: string;
  title: string;
  /** Only with --meter: it signs orders first. */
  meter?: true;
  plan(desk: DeskView, d: AttackDeps): Promise<AttackPlan | { skip: string }>;
  send(plan: AttackPlan, d: AttackDeps): Promise<unknown>;
}

const order = (args: Record<string, unknown>) => args.order as HlOrder;

/** A Hyperliquid perp price under `value`: an integer from 10,000 up, else 5 significant figures, 6 − szDecimals decimals. */
export function hlPx(value: number, szDecimals: number): string {
  if (!(value > 0)) throw new Error(`no price for ${value}`);
  if (value >= 10_000) return String(Math.floor(value));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Math.max(0, 5 - Math.floor(Math.log10(value)) - 1);
  const decimals = Math.min(maxDecimals, sig);
  const f = 10 ** decimals;
  return (Math.floor(value * f) / f).toFixed(decimals).replace(/\.?0+$/, '') || '0';
}

/** The first policy asset with no oracle price (an `unpriced` symbol), with its caps. */
function unpricedAsset(desk: DeskView) {
  for (const a of desk.policy.hl_assets) {
    const u = desk.policy.unpriced.find((x) => x.symbol === a.symbol);
    if (u !== undefined) {
      const cap = Math.min(desk.policy.max_notional_usd, desk.policy.unpriced_max_notional_usd);
      const maxSzE8 = parseE8('max_sz', u.max_sz);
      return { asset: a, maxSz: u.max_sz, maxSzE8, cap, px: hlPx(cap / (Number(maxSzE8) / 1e8), a.sz_decimals) };
    }
  }
  return null;
}

/** A 1Click-shaped quote paying the attacker, signed by a key of the attacker's own. */
export function fakeQuote(deskOwner: string, nowMs: number): { quote: string; quote_signature: string } {
  const fields = {
    dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: ASSETS.nearUsdc, depositType: 'ORIGIN_CHAIN',
    destinationAsset: ASSETS.arbitrumUsdc, amount: '1000000', refundTo: deskOwner, refundType: 'ORIGIN_CHAIN',
    recipient: ATTACKER_EVM, recipientType: 'DESTINATION_CHAIN', deadline: new Date(nowMs + 30 * 60_000).toISOString(),
    amountIn: '1000000', amountInFormatted: '1.0', amountInUsd: '1.0', minAmountIn: '1000000', amountOut: '990000',
    amountOutFormatted: '0.99', amountOutUsd: '0.99', minAmountOut: '980000', depositAddress: ATTACKER_EVM,
    timestamp: new Date(nowMs).toISOString(),
  };
  const quote = stableStringify(fields);
  const { privateKey } = generateKeyPairSync('ed25519');
  const message = Buffer.from(base58(createHash('sha256').update(Buffer.from(quote, 'utf8')).digest()), 'utf8');
  return { quote, quote_signature: `ed25519:${base58(sign(null, message, privateKey))}` };
}

/** The recorded evm_usdc_to_intents quote (another desk's), or null when the vector file is not there. */
export function recordedQuote(file: URL | string = RECORDED_QUOTES): { quote: string; quote_signature: string; name: string } | null {
  if (!existsSync(file)) return null;
  const json = JSON.parse(readFileSync(file, 'utf8')) as { quotes?: { method?: string; name?: string; canonical_json?: string; signature?: string }[] };
  const q = json.quotes?.find((x) => x.method === 'evm_usdc_to_intents' && typeof x.canonical_json === 'string');
  if (q === undefined || typeof q.signature !== 'string') return null;
  return { quote: q.canonical_json!, quote_signature: q.signature, name: q.name ?? 'evm_usdc_to_intents' };
}

export const ATTACKS: Attack[] = [
  {
    id: 'over-size',
    title: 'an order 20x over the size cap',
    async plan(desk, d) {
      const u = unpricedAsset(desk);
      if (u !== null) {
        const sz = formatE8(u.maxSzE8 * 20n);
        return {
          method: 'hl_order', expect: 'E_SIZE',
          args: { desk_id: d.deskId, order: { asset: u.asset.index, is_buy: true, px: u.px, sz, reduce_only: false, tif: 'Ioc', cloid: null }, reason: REASON },
          note: `${u.asset.symbol} is unpriced: max_sz ${u.maxSz}, this asks ${sz}`,
        };
      }
      const a = desk.policy.hl_assets[0];
      if (a === undefined) return { skip: 'the policy has no Hyperliquid asset' };
      const p = (await d.contract.prices()).find((x) => x.asset === a.symbol);
      if (p === undefined) return { skip: `no stored price for ${a.symbol}` };
      const px = Number(p.price_e8) / 1e8;
      const sz = ((desk.policy.max_notional_usd * 20) / px).toFixed(a.sz_decimals).replace(/\.?0+$/, '');
      return {
        method: 'hl_order', expect: 'E_SIZE',
        args: { desk_id: d.deskId, order: { asset: a.index, is_buy: true, px: hlPx(px, a.sz_decimals), sz, reduce_only: false, tif: 'Ioc', cloid: null }, reason: REASON },
        note: `${a.symbol} at the oracle price, 20x max_notional_usd ${desk.policy.max_notional_usd}`,
      };
    },
    send: (p, d) => d.contract.hlOrder(d.deskId, order(p.args), REASON),
  },
  {
    id: 'asset',
    title: 'an asset outside the policy',
    async plan(desk, d) {
      const taken = new Set(desk.policy.hl_assets.map((a) => a.index));
      let index = 0;
      while (taken.has(index)) index++;
      return {
        method: 'hl_order', expect: 'E_ASSET',
        args: { desk_id: d.deskId, order: { asset: index, is_buy: true, px: '1', sz: '1', reduce_only: false, tif: 'Ioc', cloid: null }, reason: REASON },
        note: `Hyperliquid asset ${index} is not in the policy (${[...taken].join(', ')})`,
      };
    },
    send: (p, d) => d.contract.hlOrder(d.deskId, order(p.args), REASON),
  },
  {
    id: 'withdraw-destination',
    title: 'hl_withdraw to the attacker\'s address',
    async plan(_desk, d) {
      return {
        method: 'hl_withdraw', expect: 'E_ARGS',
        args: { desk_id: d.deskId, amount: '10', destination: ATTACKER_EVM },
        note: 'hl_withdraw has no destination: the contract denies unknown arguments (a deserialize failure, read as E_ARGS)',
      };
    },
    send: (p, d) => rawCall(p, d),
  },
  {
    id: 'fake-quote',
    title: 'fund_venue with a made-up quote paying the attacker',
    async plan(desk, d) {
      const q = fakeQuote(desk.owner, (d.now ?? Date.now)());
      return {
        method: 'fund_venue', expect: 'E_QUOTE_SIGNATURE',
        args: { desk_id: d.deskId, quote: q.quote, quote_signature: q.quote_signature, reason: REASON },
        note: `recipient and deposit address ${ATTACKER_EVM}, signed by the attacker's own key, not 1Click's`,
      };
    },
    send: (p, d) => d.contract.fundVenue(d.deskId, { quote: p.args.quote, quote_signature: String(p.args.quote_signature) }, REASON),
  },
  {
    id: 'foreign-quote',
    title: 'a real 1Click quote for another desk',
    async plan(_desk, d) {
      const q = recordedQuote(d.recordedQuotes);
      if (q === null) return { skip: 'no recorded evm_usdc_to_intents quote in the repo' };
      return {
        method: 'evm_usdc_to_intents', expect: 'E_QUOTE_FIELDS',
        args: { desk_id: d.deskId, quote: q.quote, quote_signature: q.quote_signature, reason: REASON },
        note: `${q.name}: 1Click's real signature, but recipient and refundTo are another desk's and it is days old`,
      };
    },
    send: (p, d) => d.contract.evmUsdcToIntents(d.deskId, { quote: p.args.quote, quote_signature: String(p.args.quote_signature) }, REASON),
  },
  {
    id: 'owner-method',
    title: 'set_policy: raise its own caps',
    async plan(desk, d) {
      return {
        method: 'set_policy', expect: 'NODE',
        args: { desk_id: d.deskId, policy: { ...desk.policy, max_notional_usd: 1_000_000 } },
        note: 'set_policy is not in the operator key\'s method list: the node refuses the transaction before it runs',
      };
    },
    send: (p, d) => rawCall(p, d),
  },
  {
    id: 'orderly-market',
    title: 'an Orderly MARKET order (no price limit)',
    async plan(desk, d) {
      const symbol = desk.policy.orderly_symbols[0];
      if (symbol === undefined) return { skip: 'the policy has no Orderly symbol' };
      return {
        method: 'orderly_request', expect: d.network === 'testnet' ? 'E_PRICE_BAND' : 'E_ARGS',
        args: {
          desk_id: d.deskId, reason: REASON,
          req: { kind: 'order', symbol, side: 'BUY', order_type: 'MARKET', price: null, quantity: '0.001', reduce_only: false, timestamp_ms: (d.now ?? Date.now)() },
        },
        note: d.network === 'testnet'
          ? 'a MARKET order has no price to check against the band'
          : 'on mainnet an opening Orderly order needs the IP list first (E_ARGS); a MARKET one is E_PRICE_BAND after it',
      };
    },
    send: (p, d) => d.contract.orderlyRequest(d.deskId, p.args.req as never, REASON),
  },
  {
    id: 'hourly-meter',
    title: 'more orders than the hourly notional cap',
    meter: true,
    async plan(desk, d) {
      const u = unpricedAsset(desk);
      if (u === null) return { skip: 'the meter attack uses an unpriced asset; the policy has none' };
      const cap = desk.policy.max_notional_usd * 15;
      return {
        method: 'hl_order', expect: 'E_SIZE',
        args: { desk_id: d.deskId, order: { asset: u.asset.index, is_buy: true, px: u.px, sz: u.maxSz, reduce_only: false, tif: 'Ioc', cloid: null }, reason: REASON },
        note: `${u.asset.symbol} ${u.maxSz} at ${u.px} = ${u.cap} USD each; the hourly cap is 15 x ${desk.policy.max_notional_usd} = ${cap} USD. `
          + 'It signs orders until the contract refuses (none is posted)',
      };
    },
    send: (p, d) => d.contract.hlOrder(d.deskId, order(p.args), REASON),
  },
];

async function rawCall(p: AttackPlan, d: AttackDeps): Promise<unknown> {
  const out = await d.transport.call(d.contractId, p.method, p.args, 300);
  if (out.ok) return out.value;
  const refusal = parseRefusal(out.failure);
  if (refusal !== null) throw new ContractRefusal(refusal.code, refusal.message, out.txHash);
  throw new Error(`${p.method} failed in transaction ${out.txHash}: ${out.failure.slice(0, 300)}`);
}

/** A transaction the node refused while validating it: the access key does not allow it, so nothing ran. */
export function isNodeRejection(err: unknown): boolean {
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const text = `${name} ${String((err as Error)?.message ?? err)}`;
  return /AccessKey|MethodNameMismatch|ReceiverMismatch|method name/i.test(text);
}

function classify(err: unknown): Pick<AttackResult, 'outcome' | 'code' | 'tx' | 'detail'> {
  if (err instanceof ContractRefusal) return { outcome: 'refused', code: err.code, tx: err.txHash, detail: err.message };
  if (isNodeRejection(err)) return { outcome: 'rejected', code: 'NODE', tx: null, detail: String((err as Error).message ?? err).slice(0, 300) };
  if (err instanceof OutcomeUnknown) return { outcome: 'error', code: null, tx: err.ids.nearTx ?? null, detail: err.message };
  return { outcome: 'error', code: null, tx: null, detail: String((err as Error)?.message ?? err).slice(0, 300) };
}

function signedTx(value: unknown): string | null {
  if (Array.isArray(value)) return (value[0] as { id?: string } | undefined)?.id ?? null;
  return (value as { nearTx?: { id?: string } } | null)?.nearTx?.id ?? null;
}

/** Runs (or, with dry, only plans) one attack. */
export async function runAttack(attack: Attack, desk: DeskView, d: AttackDeps, options: { dry: boolean }): Promise<AttackResult> {
  const base = { id: attack.id, title: attack.title };
  let plan: AttackPlan | { skip: string };
  try {
    plan = await attack.plan(desk, d);
  } catch (err) {
    return { ...base, method: '?', expect: '?', ...classify(err) };
  }
  if ('skip' in plan) return { ...base, method: '-', expect: '-', outcome: 'skipped', code: null, tx: null, detail: plan.skip };
  const head = { ...base, method: plan.method, expect: plan.expect };
  if (options.dry) return { ...head, outcome: 'dry', code: null, tx: null, detail: `${plan.note ?? ''}\n    args ${JSON.stringify(plan.args)}` };
  if (attack.meter === true) {
    let signed = 0;
    for (let i = 0; i < METER_MAX_ORDERS; i++) {
      try {
        await attack.send(plan, d);
        signed++;
      } catch (err) {
        return { ...head, ...classify(err), signed, detail: `${signed} orders signed (not posted), then: ${classify(err).detail}` };
      }
    }
    return { ...head, outcome: 'signed', code: null, tx: null, signed, detail: `${signed} orders signed and none refused: the meter did not hold` };
  }
  try {
    const value = await attack.send(plan, d);
    return { ...head, outcome: 'signed', code: null, tx: signedTx(value), detail: 'THE CONTRACT SIGNED IT: the attack got through' };
  } catch (err) {
    return { ...head, ...classify(err) };
  }
}

export interface LedgerCheck {
  before: DeskView['ledger'];
  after: DeskView['ledger'];
  /** Sum of |change| over the ledger fields, USDC × 1e6. */
  movedE6: bigint;
}

export function ledgerMoved(before: DeskView['ledger'], after: DeskView['ledger']): bigint {
  let sum = 0n;
  for (const k of ['deposited', 'withdrawn', 'fees_paid', 'idle_usdc'] as const) {
    const delta = BigInt(String(after[k])) - BigInt(String(before[k]));
    sum += delta < 0n ? -delta : delta;
  }
  return sum;
}

export interface AttackRun {
  results: AttackResult[];
  ledger: LedgerCheck;
}

/** Every attack in order (the meter only with `meter`), then the desk's ledger read again. */
export async function runAttacks(d: AttackDeps, options: { dry: boolean; meter: boolean; only?: string[] }): Promise<AttackRun> {
  const read = async () => {
    const desk = await d.contract.getDesk(d.deskId);
    if (desk === null) throw new Error(`${d.contractId} has no desk ${d.deskId}`);
    return desk;
  };
  const desk = await read();
  const results: AttackResult[] = [];
  for (const a of ATTACKS) {
    if (options.only !== undefined && !options.only.includes(a.id)) continue;
    if (a.meter === true && !options.meter) {
      results.push({ id: a.id, title: a.title, method: 'hl_order', expect: 'E_SIZE', outcome: 'skipped', code: null, tx: null, detail: 'only with --meter (it signs up to 16 orders first)' });
      continue;
    }
    results.push(await runAttack(a, desk, d, options));
  }
  const after = options.dry ? desk : await read();
  return { results, ledger: { before: desk.ledger, after: after.ledger, movedE6: ledgerMoved(desk.ledger, after.ledger) } };
}

const usdc = (e6: bigint) => {
  const s = (e6 < 0n ? -e6 : e6).toString().padStart(7, '0');
  const frac = s.slice(-6).replace(/0+$/, '');
  return `${s.slice(0, -6)}${frac === '' ? '' : `.${frac}`}`;
};

function got(r: AttackResult, network: NearNetwork): string {
  switch (r.outcome) {
    case 'refused': return `${r.code}  tx ${r.tx === null ? '(none)' : `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${r.tx}`}`;
    case 'rejected': return 'rejected before the chain, no tx';
    case 'signed': return `SIGNED${r.tx === null ? '' : ` in ${r.tx}`}: the attack got through`;
    case 'dry': return 'not sent (dry run)';
    case 'skipped': return `skipped: ${r.detail}`;
    default: return `error: ${r.detail}`;
  }
}

/** The run as printed lines: one row per attack, then the ledger check. */
export function report(run: AttackRun, d: Pick<AttackDeps, 'network' | 'contractId' | 'deskId'>, dry: boolean): string[] {
  const lines = [`${dry ? 'DRY RUN, nothing is sent. ' : ''}desk ${d.deskId} on ${d.contractId} (${d.network})`, ''];
  const w = Math.max(...run.results.map((r) => r.title.length), 6);
  lines.push(`${'attack'.padEnd(w)}  ${'method'.padEnd(20)}  ${'expect'.padEnd(17)}  answer`);
  for (const r of run.results) {
    const expect = r.expect === 'NODE' ? 'node rejects' : r.expect;
    lines.push(`${r.title.padEnd(w)}  ${r.method.padEnd(20)}  ${expect.padEnd(17)}  ${got(r, d.network)}`);
    if (r.outcome === 'dry') lines.push(`    ${r.detail}`);
    if (r.outcome === 'refused' && r.code !== r.expect) lines.push(`    note: expected ${r.expect}; ${r.detail}`);
  }
  const l = run.ledger;
  lines.push('');
  lines.push(`ledger before  idle ${usdc(BigInt(String(l.before.idle_usdc)))}  deposited ${usdc(BigInt(String(l.before.deposited)))}  withdrawn ${usdc(BigInt(String(l.before.withdrawn)))}  fees ${usdc(BigInt(String(l.before.fees_paid)))} USDC`);
  if (!dry) lines.push(`ledger after   idle ${usdc(BigInt(String(l.after.idle_usdc)))}  deposited ${usdc(BigInt(String(l.after.deposited)))}  withdrawn ${usdc(BigInt(String(l.after.withdrawn)))}  fees ${usdc(BigInt(String(l.after.fees_paid)))} USDC`);
  lines.push(dry ? 'ledger check runs after a live run' : `${usdc(l.movedE6)} USDC moved`);
  const through = run.results.filter((r) => r.outcome === 'signed');
  if (through.length > 0) lines.push(`${through.length} attack(s) got through: ${through.map((r) => r.id).join(', ')}`);
  return lines;
}

/** True when no attack got signed and no USDC moved. */
export function held(run: AttackRun): boolean {
  return run.results.every((r) => r.outcome !== 'signed') && run.ledger.movedE6 === 0n;
}
