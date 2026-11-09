// A scripted list of malicious operator requests against one desk, for `npm run attack` and the MCP try_attack tool.
// Each attack is a request an agent holding the operator key could send; the contract (or the NEAR node, for a
// method outside the key's list) must refuse it. Nothing here checks the request itself: the point is to show what
// the chain answers.
//
// A row passes only on exactly the expected answer: the contract's refusal with the expected code (and, where a code
// is shared, the expected message), or for the method outside the key's list the node's MethodNameMismatch. Anything
// else fails with the code or error it got, so a paused desk (E_PAUSED on every row), an exhausted allowance, a
// deleted key or an RPC error never reads as "the desk held".

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AccessKeyMethodNameMismatchActionError } from 'near-api-js/rpc-errors';
import type { NearContractClient, NearNetwork, NearTransport } from '../contract/near-client.ts';
import { formatE8, parseE8 } from '../contract/replay-checks.ts';
import type { DeskView, HlOrder } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown, parseRefusal } from '../contract/types.ts';
import { unpricedCapUsd, unpricedEntry } from '../contract/unpriced.ts';
import { ASSETS, stableStringify } from '../rescue/oneclick.ts';
import { base58 } from '../venues/orderly-signer.ts';

/** A real 1Click quote (signed by 1Click on 2026-10-31) for the contract tests' desk, not for any live desk. */
export const RECORDED_QUOTES = new URL('../../../contract/core/tests/vectors/oneclick-live.json', import.meta.url);

/** An address no desk owns: where every attack tries to send the money. */
export const ATTACKER_EVM = '0x000000000000000000000000000000000000dead';

const REASON = 'attack demo: this request must be refused';
/** The contract's default hourly notional cap while max_hourly_notional_usd is null (policy.rs). */
export const DEFAULT_HOURLY_NOTIONAL_MULTIPLE = 15;
/** The code of a node refusal for a method outside the FunctionCall key's list. */
export const NODE_METHOD = 'NODE_METHOD';
/** The meter attack never signs more than this, whatever the cap says. */
const METER_HARD_STOP = 60;

export type AttackContract = Pick<NearContractClient, 'getDesk' | 'prices' | 'hlOrder' | 'fundVenue' | 'evmUsdcToIntents' | 'orderlyRequest'>;

export interface AttackDeps {
  network: NearNetwork;
  contractId: string;
  deskId: string;
  contract: AttackContract;
  /** For the requests the client has no method for, and the desk's counters view. */
  transport: Pick<NearTransport, 'call' | 'view'>;
  /** A keyless Hyperliquid /info read: the meter's market price and the account-value check. Without it both are skipped. */
  hlInfo?: (body: object) => Promise<unknown>;
  now?: () => number;
  /** Where the recorded 1Click quote is read from (tests point it elsewhere). */
  recordedQuotes?: URL | string;
}

/** What one attack would send. */
export interface AttackPlan {
  method: string;
  args: Record<string, unknown>;
  /** The code the chain should answer; NODE_METHOD for a method the operator key's list does not allow. */
  expect: string;
  /** Where a code is shared (E_SIZE, E_ARGS, E_NOT_ALLOWED), the refusal's message must match this too. */
  expectDetail?: RegExp;
  note?: string;
  /** Prepaid gas; default 300 TGas. */
  tgas?: number;
  /** The meter attack: orders that fit the room left, plus the one that must be refused. */
  maxOrders?: number;
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
  /**
   * true only for exactly the expected answer: the expected code (and message, where given), or for the
   * out-of-list method the node's MethodNameMismatch. null when nothing was sent (dry, skipped).
   */
  pass: boolean | null;
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
    const u = unpricedEntry(desk.policy, 'hyperliquid', a.symbol);
    if (u !== undefined) {
      const cap = unpricedCapUsd(desk.policy);
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
          method: 'hl_order', expect: 'E_SIZE', expectDetail: /is over its max_sz|USD is over (max_notional_usd|the unpriced cap)/,
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
        method: 'hl_order', expect: 'E_SIZE', expectDetail: /is over its max_sz|USD is over (max_notional_usd|the unpriced cap)/,
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
        method: 'hl_withdraw', expect: 'E_ARGS', expectDetail: /unknown field `destination`/,
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
        method: 'set_policy', expect: NODE_METHOD,
        args: { desk_id: d.deskId, policy: { ...desk.policy, max_notional_usd: 1_000_000 } },
        note: 'set_policy is not in the operator key\'s method list: the node refuses the transaction before it runs',
      };
    },
    send: (p, d) => rawCall(p, d),
  },
  {
    id: 'unpause',
    title: 'resume a desk the owner paused',
    async plan(_desk, d) {
      return {
        method: 'set_paused', expect: 'E_NOT_ALLOWED',
        expectDetail: /set_paused\(false\) needs exactly 1 yoctoNEAR|may pause desk \S+ but never unpause it/,
        args: { desk_id: d.deskId, paused: false }, tgas: 30,
        note: 'unpausing needs exactly 1 yoctoNEAR, which a FunctionCall key cannot attach: the agent cannot undo a pause by the owner',
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
        expectDetail: d.network === 'testnet' ? /MARKET order/ : /relayer IP list/,
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
      if (d.network === 'mainnet') return { skip: 'the meter attack signs real orders: never on mainnet' };
      const u = unpricedAsset(desk);
      if (u === null) return { skip: 'the meter attack uses an unpriced asset; the policy has none' };
      if (d.hlInfo === undefined) return { skip: 'no Hyperliquid read to price the post-only orders far from the market' };
      const mids = await d.hlInfo({ type: 'allMids' }) as Record<string, string> | null;
      const mid = Number(mids?.[u.asset.symbol]);
      if (!(mid > 0)) return { skip: `no Hyperliquid mid for ${u.asset.symbol}` };
      // A post-only buy under half the mid and under half the unpriced cap's price: it can only rest (Hyperliquid
      // cancels a post-only order that would cross), never fill, so its public signature is harmless. sz = max_sz.
      const px = hlPx(Math.min(mid / 2, u.cap / (Number(u.maxSzE8) / 1e8) / 2), u.asset.sz_decimals);
      // The meter counts an unpriced order at max(px, unpriced cap / max_sz) per unit (interfaces §1.2): with
      // sz = max_sz and px under that floor, each order counts exactly the unpriced cap.
      const perOrder = u.cap;
      const counters = await d.transport.view<Record<string, unknown> | null>(d.contractId, 'get_desk_counters', { desk_id: d.deskId }).catch(() => null);
      const capUsd = Number(counters?.notional_cap_usd ?? desk.policy.max_hourly_notional_usd ?? desk.policy.max_notional_usd * DEFAULT_HOURLY_NOTIONAL_MULTIPLE);
      const leftUsd = counters?.notional_left_e8 === undefined ? capUsd : Number(String(counters.notional_left_e8)) / 1e8;
      const fit = Math.floor(leftUsd / perOrder);
      if (fit < 1) return { skip: `${leftUsd} USD of the hourly cap is left, under one order: the cap refusal could not be told from the size check; run it later` };
      return {
        method: 'hl_order', expect: 'E_SIZE', expectDetail: /max_hourly_notional_usd/, maxOrders: fit + 1,
        args: { desk_id: d.deskId, order: { asset: u.asset.index, is_buy: true, px, sz: u.maxSz, reduce_only: false, tif: 'Alo', cloid: null }, reason: REASON },
        note: `${u.asset.symbol} ${u.maxSz}, post-only buy at ${px} (mid ${mid}), counted ${perOrder} USD each; hourly cap ${capUsd} USD, ${leftUsd} left: `
          + `${fit} should sign, order ${fit + 1} must be refused. None is posted`,
      };
    },
    send: (p, d) => d.contract.hlOrder(d.deskId, order(p.args), REASON),
  },
];

async function rawCall(p: AttackPlan, d: AttackDeps): Promise<unknown> {
  const out = await d.transport.call(d.contractId, p.method, p.args, p.tgas ?? 300);
  if (out.ok) return out.value;
  const refusal = parseRefusal(out.failure);
  if (refusal !== null) throw new ContractRefusal(refusal.code, refusal.message, out.txHash);
  throw new Error(`${p.method} failed in transaction ${out.txHash}: ${out.failure.slice(0, 300)}`);
}

const errName = (err: unknown) => `${(err as { name?: string })?.name ?? ''} ${(err as { constructor?: { name?: string } })?.constructor?.name ?? ''}`;
const errMessage = (err: unknown) => String((err as Error)?.message ?? err);

/**
 * The code of a transaction the node refused while validating it (nothing ran, no tx), or null when the error is
 * not such a refusal. NODE_METHOD only for a method outside the FunctionCall key's list (MethodNameMismatch); any
 * other access-key refusal (allowance, a deleted key, a wrong receiver) gets its own NODE_<kind> code, which no
 * attack expects. The name is read as well as the class: the transport may rebuild the error to redact its URL.
 */
export function nodeRejection(err: unknown): string | null {
  if (err instanceof AccessKeyMethodNameMismatchActionError) return NODE_METHOD;
  const text = `${errName(err)} ${errMessage(err)}`;
  if (/MethodNameMismatch/i.test(text)) return NODE_METHOD;
  const kind = /(AccessKey\w*|NotEnoughAllowance\w*|InvalidAccessKey\w*)/.exec(text)?.[1];
  return kind === undefined ? null : `NODE_${kind.replace(/(ActionError|Error)$/, '')}`;
}

/** Whether the node refused the transaction before it ran, for any access-key reason. */
export function isNodeRejection(err: unknown): boolean {
  return nodeRejection(err) !== null;
}

function classify(err: unknown): Pick<AttackResult, 'outcome' | 'code' | 'tx' | 'detail'> {
  if (err instanceof ContractRefusal) return { outcome: 'refused', code: err.code, tx: err.txHash, detail: err.message };
  const node = nodeRejection(err);
  if (node !== null) return { outcome: 'rejected', code: node, tx: null, detail: errMessage(err).slice(0, 300) };
  if (err instanceof OutcomeUnknown) return { outcome: 'error', code: null, tx: err.ids.nearTx ?? null, detail: err.message };
  return { outcome: 'error', code: null, tx: null, detail: errMessage(err).slice(0, 300) };
}

/** Exactly the expected answer, or not: the strict rule every row is judged by. */
export function judge(plan: Pick<AttackPlan, 'expect' | 'expectDetail'>, r: Pick<AttackResult, 'outcome' | 'code' | 'detail'>): boolean {
  if (plan.expect === NODE_METHOD) return r.outcome === 'rejected' && r.code === NODE_METHOD;
  if (r.outcome !== 'refused' || r.code !== plan.expect) return false;
  return plan.expectDetail === undefined || plan.expectDetail.test(r.detail);
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
    return { ...base, method: '?', expect: '?', ...classify(err), pass: false };
  }
  if ('skip' in plan) return { ...base, method: '-', expect: '-', outcome: 'skipped', code: null, tx: null, detail: plan.skip, pass: null };
  const head = { ...base, method: plan.method, expect: plan.expect };
  if (options.dry) return { ...head, outcome: 'dry', code: null, tx: null, detail: `${plan.note ?? ''}\n    args ${JSON.stringify(plan.args)}`, pass: null };
  if (attack.meter === true) {
    let signed = 0;
    const stop = Math.min(plan.maxOrders ?? METER_HARD_STOP, METER_HARD_STOP);
    for (let i = 0; i < stop; i++) {
      try {
        await attack.send(plan, d);
        signed++;
      } catch (err) {
        const c = classify(err);
        // E_SIZE is shared with the per-order size check: the meter passes only once it let orders through first.
        return { ...head, ...c, signed, detail: `${signed} orders signed (post-only, far from the market, not posted), then: ${c.detail}`, pass: signed > 0 && judge(plan, c) };
      }
    }
    return { ...head, outcome: 'signed', code: null, tx: null, signed, detail: `${signed} orders signed and none refused: the meter did not hold`, pass: false };
  }
  try {
    const value = await attack.send(plan, d);
    return { ...head, outcome: 'signed', code: null, tx: signedTx(value), detail: 'THE CONTRACT SIGNED IT: the attack got through', pass: false };
  } catch (err) {
    const c = classify(err);
    return { ...head, ...c, pass: judge(plan, c) };
  }
}

export interface LedgerCheck {
  /** The contract's NEAR-side ledger of the desk (get_desk). */
  before: DeskView['ledger'];
  after: DeskView['ledger'];
  /** The desk's Hyperliquid account value, USDC × 1e6 (clearinghouseState); null when it could not be read. */
  hlBeforeE6: bigint | null;
  hlAfterE6: bigint | null;
  /** Sum of |change| over the NEAR ledger fields and the Hyperliquid account value, USDC × 1e6. */
  movedE6: bigint;
}

/** The desk's Hyperliquid perps account value in USDC × 1e6, or null when the read fails. */
export async function hlAccountValueE6(d: Pick<AttackDeps, 'hlInfo'>, evm: string): Promise<bigint | null> {
  if (d.hlInfo === undefined) return null;
  try {
    const s = await d.hlInfo({ type: 'clearinghouseState', user: evm }) as { marginSummary?: { accountValue?: string } } | null;
    const v = s?.marginSummary?.accountValue;
    if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) return null;
    const [i, f = ''] = v.split('.');
    return BigInt(i!) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  } catch {
    return null;
  }
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
  const hlBeforeE6 = options.dry ? null : await hlAccountValueE6(d, desk.evm_address);
  const results: AttackResult[] = [];
  for (const a of ATTACKS) {
    if (options.only !== undefined && !options.only.includes(a.id)) continue;
    if (a.meter === true && !options.meter) {
      results.push({ id: a.id, title: a.title, method: 'hl_order', expect: 'E_SIZE', outcome: 'skipped', code: null, tx: null, pass: null, detail: 'only with --meter (it signs post-only orders up to the hourly cap first; testnet only)' });
      continue;
    }
    results.push(await runAttack(a, desk, d, options));
  }
  const after = options.dry ? desk : await read();
  const hlAfterE6 = options.dry ? null : await hlAccountValueE6(d, desk.evm_address);
  let movedE6 = ledgerMoved(desk.ledger, after.ledger);
  if (hlBeforeE6 !== null && hlAfterE6 !== null) movedE6 += hlAfterE6 > hlBeforeE6 ? hlAfterE6 - hlBeforeE6 : hlBeforeE6 - hlAfterE6;
  return { results, ledger: { before: desk.ledger, after: after.ledger, hlBeforeE6, hlAfterE6, movedE6 } };
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

/** The run as printed lines: one row per attack (PASS / FAIL), the ledger check, the verdict. */
export function report(run: AttackRun, d: Pick<AttackDeps, 'network' | 'contractId' | 'deskId'>, dry: boolean, problems: string[] = []): string[] {
  const lines = [`${dry && problems.length === 0 ? 'DRY RUN, nothing is sent. ' : ''}desk ${d.deskId} on ${d.contractId} (${d.network})`, ''];
  for (const p of problems) lines.push(`FAIL: ${p}`);
  if (problems.length > 0) lines.push('');
  const w = Math.max(...run.results.map((r) => r.title.length), 6);
  lines.push(`${'    '}  ${'attack'.padEnd(w)}  ${'method'.padEnd(20)}  ${'expect'.padEnd(17)}  answer`);
  for (const r of run.results) {
    const mark = r.pass === null ? '    ' : r.pass ? 'PASS' : 'FAIL';
    const expect = r.expect === NODE_METHOD ? 'node: not in key' : r.expect;
    lines.push(`${mark}  ${r.title.padEnd(w)}  ${r.method.padEnd(20)}  ${expect.padEnd(17)}  ${got(r, d.network)}`);
    if (r.outcome === 'dry') lines.push(`      ${r.detail}`);
    if (r.pass === false) {
      const code = r.code ?? r.outcome;
      lines.push(`      got ${code}: ${r.detail.startsWith(`${code}:`) ? r.detail.slice(code.length + 1).trimStart() : r.detail}`);
    }
  }
  const l = run.ledger;
  const near = (x: DeskView['ledger']) => `idle ${usdc(BigInt(String(x.idle_usdc)))}  deposited ${usdc(BigInt(String(x.deposited)))}  withdrawn ${usdc(BigInt(String(x.withdrawn)))}  fees ${usdc(BigInt(String(x.fees_paid)))} USDC`;
  lines.push('');
  lines.push(`NEAR ledger before        ${near(l.before)}`);
  if (dry) {
    lines.push('the ledger check (NEAR ledger and Hyperliquid account value) runs after a live run');
    return lines;
  }
  lines.push(`NEAR ledger after         ${near(l.after)}`);
  lines.push(l.hlBeforeE6 === null || l.hlAfterE6 === null
    ? 'Hyperliquid account value not read: the check covers the NEAR ledger only'
    : `Hyperliquid account value ${usdc(l.hlBeforeE6)} -> ${usdc(l.hlAfterE6)} USDC`);
  lines.push(`${usdc(l.movedE6)} USDC moved (NEAR ledger${l.hlBeforeE6 === null || l.hlAfterE6 === null ? '' : ' + Hyperliquid account'})`);
  const failed = run.results.filter((r) => r.pass === false);
  if (failed.length > 0) lines.push(`${failed.length} row(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  return lines;
}

/**
 * The desk held: no problem before the run, at least one row ran, every row that ran got exactly its expected
 * answer, the Hyperliquid account was read before and after when a reader was given, and nothing moved.
 */
export function held(run: AttackRun, problems: string[] = [], hlExpected = false): boolean {
  const ran = run.results.filter((r) => r.pass !== null);
  const hlRead = !hlExpected || (run.ledger.hlBeforeE6 !== null && run.ledger.hlAfterE6 !== null);
  return problems.length === 0 && ran.length > 0 && ran.every((r) => r.pass === true) && hlRead && run.ledger.movedE6 === 0n;
}

/** Why a live run cannot prove anything, from the operator key's remaining allowance (null: unlimited or full access). */
export async function keyProblems(allowance: () => Promise<bigint | null>, minYocto = 3n * 10n ** 23n): Promise<string[]> {
  let left: bigint | null;
  try {
    left = await allowance();
  } catch (err) {
    return [`the operator key is not on chain or cannot be read: ${errMessage(err).slice(0, 200)}`];
  }
  if (left === null) return ['the key has no allowance: it is full-access or unlimited, not an operator key'];
  if (left < minYocto) return [`the operator key's allowance is ${Number(left / 10n ** 21n) / 1000} NEAR, under ${Number(minYocto / 10n ** 21n) / 1000} NEAR for one call`];
  return [];
}
