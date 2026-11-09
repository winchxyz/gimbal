// What the MCP server's five tools do, without MCP. Each one is a call to the gimbal contract through the operator's
// FunctionCall key (docs/interfaces.md §1.3), plus the venue post of what the contract signed. Nothing here decides
// whether an action is allowed: the contract does, on chain. A refusal comes back as the contract's E_* code with the
// NEAR transaction. The server holds no venue key; the NEAR operator key signs, and only the methods it allows.

import type { NearContractClient, NearNetwork, NearTransport } from '../contract/near-client.ts';
import { nearTxRef } from '../contract/near-client.ts';
import type { DeskView, HlOrder, HlSignedAction } from '../contract/types.ts';
import { ContractRefusal, OutcomeUnknown } from '../contract/types.ts';
import type { HlSubmitResult } from '../relayer/hyperliquid.ts';
import { HlExchangeError } from '../relayer/hyperliquid.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { OneClickApi, QuoteRequest } from '../rescue/oneclick.ts';
import { ASSETS, canonicalQuote, unitsOf } from '../rescue/oneclick.ts';
import { SLIPPAGE_BPS } from '../rescue/plan.ts';
import { HL_MAINNET_URL, HL_TESTNET_URL, hlTradeFetch } from '../venues/hyperliquid.ts';
import type { AttackDeps } from './attacks.ts';
import { ATTACKS, isNodeRejection, runAttack } from './attacks.ts';

/** What every tool answers: a result, a refusal by the contract, or an error before or after the chain. */
export type ToolAnswer =
  | { ok: true; [field: string]: unknown }
  | { ok: false; refused: true; code: string; message: string; method: string; tx: string | null; explorer: string | null }
  | { ok: false; refused: false; method: string; error: string; tx: string | null; explorer: string | null };

/** The parts of the engine's contract client the tools use (a fake or the replay client in tests). */
export type DeskContract = Pick<NearContractClient,
  'getDesk' | 'prices' | 'hlOrder' | 'hlWithdraw' | 'fundVenue' | 'evmUsdcToIntents' | 'orderlyRequest'>;

/** Posts a contract-signed Hyperliquid action (HyperliquidSubmitter in production). */
export interface HlPoster {
  submit(signed: HlSignedAction, deskAddress: string): Promise<HlSubmitResult>;
}

export interface DeskToolsOptions {
  network: NearNetwork;
  contractId: string;
  deskId: string;
  contract: DeskContract;
  transport: NearTransport;
  hl: HlPoster;
  oneClick: Pick<OneClickApi, 'quote'>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PlaceOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  price: string;
  tif?: 'Ioc' | 'Gtc' | 'Alo' | undefined;
  reduce_only?: boolean | undefined;
  reason?: string | undefined;
  /** false: ask the contract to sign, but do not post the order to Hyperliquid. */
  post?: boolean | undefined;
}

export interface FundVenueInput {
  venue?: 'hyperliquid' | 'phoenix' | 'orderly' | undefined;
  amount_usdc?: number | undefined;
  /** A quote the agent brings itself: the canonical string 1Click signed, and its signature. */
  quote?: string | undefined;
  quote_signature?: string | undefined;
  reason?: string | undefined;
}

const DEFAULT_REASON = 'MCP agent';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errorText = (e: unknown) => String((e as Error)?.message ?? e);

export class DeskTools {
  readonly network: NearNetwork;
  readonly contractId: string;
  readonly deskId: string;
  readonly #o: DeskToolsOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(o: DeskToolsOptions) {
    this.network = o.network;
    this.contractId = o.contractId;
    this.deskId = o.deskId;
    this.#o = o;
    // On the network (no fetch passed) its /info reads are charged to the host's weight budget, never waiting for it.
    this.#fetch = o.fetch ?? hlTradeFetch(o.network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL);
    this.#now = o.now ?? Date.now;
  }

  get hlApi(): string {
    return this.network === 'mainnet' ? HL_MAINNET_URL : HL_TESTNET_URL;
  }

  #explorer(tx: string | null): string | null {
    return tx === null ? null : nearTxRef(this.network, tx).url;
  }

  /** A thrown error as a tool answer: the contract's refusal with its code and tx, or what else went wrong. */
  failure(method: string, err: unknown): ToolAnswer {
    if (err instanceof ContractRefusal) {
      return { ok: false, refused: true, code: err.code, message: err.message, method, tx: err.txHash, explorer: this.#explorer(err.txHash) };
    }
    if (isNodeRejection(err)) {
      return { ok: false, refused: true, code: 'NODE_REJECTED', message: `the NEAR node refused the transaction (the operator key does not allow it): ${errorText(err).slice(0, 300)}`, method, tx: null, explorer: null };
    }
    const tx = err instanceof OutcomeUnknown ? err.ids.nearTx ?? null : null;
    return { ok: false, refused: false, method, error: errorText(err).slice(0, 600), tx, explorer: this.#explorer(tx) };
  }

  async #desk(): Promise<DeskView> {
    const d = await this.#o.contract.getDesk(this.deskId);
    if (d === null) throw new Error(`the contract ${this.contractId} has no desk ${this.deskId}`);
    return d;
  }

  async #hlInfo(body: object): Promise<unknown> {
    const res = await this.#fetch(`${this.hlApi}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Hyperliquid /info ${res.status}`);
    return res.json();
  }

  /** read_desk: the policy, the ledger, the hourly meters, and the desk's Hyperliquid positions (public reads only). */
  async status(): Promise<ToolAnswer> {
    try {
      const desk = await this.#desk();
      const [counters, prices, allowance, hl] = await Promise.all([
        this.#o.transport.view<Record<string, unknown> | null>(this.contractId, 'get_desk_counters', { desk_id: this.deskId }).catch(() => null),
        this.#o.contract.prices().catch(() => []),
        this.#o.transport.allowance().catch(() => null),
        this.#hlInfo({ type: 'clearinghouseState', user: desk.evm_address }).catch((e: unknown) => ({ error: errorText(e) })),
      ]);
      const c = counters ?? {};
      const e8 = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? Number(v) / 1e8 : null);
      return {
        ok: true,
        network: this.network,
        contract: this.contractId,
        desk_id: this.deskId,
        owner: desk.owner,
        operator_account: this.#o.transport.accountId,
        operator_key_allowance_near: allowance === null ? null : Number(allowance / 10n ** 21n) / 1000,
        paused: desk.paused,
        closing: desk.closing === true,
        ledger_usdc_e6: desk.ledger,
        policy: desk.policy,
        addresses: { evm: desk.evm_address, solana_authority: desk.solana.authority, orderly_receiver: desk.orderly_receiver },
        meters: {
          hourly_notional_cap_usd: c.notional_cap_usd ?? null,
          hourly_notional_left_usd: e8(c.notional_left_e8),
          rescue_cap_left_usd: e8(c.rescue_cap_left_e8),
        },
        prices,
        hyperliquid: summariseHl(hl),
        not_read: 'Orderly and Phoenix positions need signed reads; they are not read here',
      };
    } catch (err) {
      return this.failure('get_desk', err);
    }
  }

  /**
   * The asset index of `symbol`: the policy's, else Hyperliquid's own list, else a number as given. A symbol outside
   * the policy is sent as is, so the contract, not this server, refuses it.
   */
  async #hlAsset(desk: DeskView, symbol: string): Promise<number> {
    const s = symbol.trim().toUpperCase();
    const inPolicy = desk.policy.hl_assets.find((a) => a.symbol === s);
    if (inPolicy !== undefined) return inPolicy.index;
    if (/^\d+$/.test(s)) return Number(s);
    const meta = await this.#hlInfo({ type: 'meta' }) as { universe?: { name?: string }[] };
    const i = meta.universe?.findIndex((u) => u.name?.toUpperCase() === s) ?? -1;
    if (i < 0) throw new Error(`Hyperliquid has no perp ${s}`);
    return i;
  }

  /** place_hl_order: hl_order through the contract, then the signed order posted to Hyperliquid. */
  async placeOrder(input: PlaceOrderInput): Promise<ToolAnswer> {
    const method = 'hl_order';
    try {
      const desk = await this.#desk();
      const order: HlOrder = {
        asset: await this.#hlAsset(desk, input.symbol), is_buy: input.side === 'buy', px: input.price, sz: input.size,
        reduce_only: input.reduce_only === true, tif: input.tif ?? 'Ioc', cloid: null,
      };
      const signed = await this.#o.contract.hlOrder(this.deskId, order, input.reason ?? DEFAULT_REASON);
      return await this.#post(method, signed, desk, input.post !== false, { order });
    } catch (err) {
      return this.failure(method, err);
    }
  }

  /** withdraw: hl_withdraw, always to the desk's own EVM address on Arbitrum (the method has no destination). */
  async withdraw(input: { amount: string; post?: boolean | undefined }): Promise<ToolAnswer> {
    const method = 'hl_withdraw';
    try {
      const desk = await this.#desk();
      const signed = await this.#o.contract.hlWithdraw(this.deskId, input.amount);
      return await this.#post(method, signed, desk, input.post !== false, { amount: input.amount, to: desk.evm_address });
    } catch (err) {
      return this.failure(method, err);
    }
  }

  async #post(method: string, signed: HlSignedAction, desk: DeskView, post: boolean, extra: Record<string, unknown>): Promise<ToolAnswer> {
    const tx = signed.nearTx?.id ?? null;
    const head = { ok: true as const, method, signed: true, tx, explorer: this.#explorer(tx), ...extra };
    if (!post) return { ...head, posted: false };
    try {
      const r = await this.#o.hl.submit(signed, desk.evm_address);
      return { ...head, posted: true, hyperliquid: { statuses: r.statuses, oid: r.oid, filled: r.filled, resting: r.resting, confirmed: r.confirmed, tx: r.tx.map((t) => t.url) } };
    } catch (err) {
      // The contract signed; the venue said no (an empty account, no match for an IOC). Not a contract refusal.
      if (err instanceof HlExchangeError || err instanceof NothingExecuted) {
        return { ok: false, refused: false, method, error: `signed by the contract, then Hyperliquid: ${errorText(err).slice(0, 400)}`, tx, explorer: this.#explorer(tx) };
      }
      throw err;
    }
  }

  /** fund_venue: a live 1Click quote from the desk's idle USDC on NEAR to one of its venues, or a quote the agent brings. */
  async fundVenue(input: FundVenueInput): Promise<ToolAnswer> {
    const method = 'fund_venue';
    try {
      let quote: string;
      let signature: string;
      if (input.quote !== undefined || input.quote_signature !== undefined) {
        if (input.quote === undefined || input.quote_signature === undefined) throw new Error('give both quote and quote_signature, or venue and amount_usdc');
        quote = input.quote;
        signature = input.quote_signature;
      } else {
        if (input.venue === undefined || input.amount_usdc === undefined || !(input.amount_usdc > 0)) throw new Error('give venue and amount_usdc (above 0), or quote and quote_signature');
        const desk = await this.#desk();
        const [destination, recipient] = input.venue === 'hyperliquid' ? [ASSETS.hypercoreUsdc, desk.evm_address]
          : input.venue === 'phoenix' ? [ASSETS.solanaUsdc, desk.solana.authority] : [ASSETS.arbitrumUsdc, desk.orderly_receiver];
        if (recipient === null) throw new Error('the desk has no Orderly receiver pinned yet (set_orderly_receiver)');
        const body: QuoteRequest = {
          dry: false, swapType: 'EXACT_INPUT', slippageTolerance: SLIPPAGE_BPS, originAsset: ASSETS.nearUsdc, depositType: 'ORIGIN_CHAIN',
          destinationAsset: destination, amount: unitsOf(input.amount_usdc, ASSETS.nearUsdc).toString(), refundTo: desk.owner,
          refundType: 'ORIGIN_CHAIN', recipient, recipientType: 'DESTINATION_CHAIN', deadline: new Date(this.#now() + 30 * 60_000).toISOString(),
        };
        const answer = await this.#o.oneClick.quote(body);
        if (!answer.ok) throw new Error(`1Click gave no quote: ${answer.message} (HTTP ${answer.status})`);
        quote = canonicalQuote(answer.response);
        signature = answer.response.signature;
      }
      const refs = await this.#o.contract.fundVenue(this.deskId, { quote, quote_signature: signature }, input.reason ?? DEFAULT_REASON);
      const tx = refs[0]?.id ?? null;
      return { ok: true, method, tx, explorer: this.#explorer(tx), quote: safeJson(quote) ?? quote };
    } catch (err) {
      return this.failure(method, err);
    }
  }

  /** try_attack: one scripted malicious request (attacks.ts), sent or only planned; the chain's answer. */
  async tryAttack(input: { attack: string; dry?: boolean | undefined }): Promise<ToolAnswer> {
    const attack = ATTACKS.find((a) => a.id === input.attack);
    if (attack === undefined) {
      return { ok: false, refused: false, method: 'try_attack', error: `no attack ${input.attack}; one of ${ATTACKS.filter((a) => a.meter !== true).map((a) => a.id).join(', ')}`, tx: null, explorer: null };
    }
    if (attack.meter === true) {
      // Refused here, whatever schema the caller used: the meter attack signs real orders, so only a human runs it (npm run attack -- --meter).
      return { ok: false, refused: false, method: 'try_attack', error: `${attack.id} signs real orders before the refusal; run it from the attack CLI with --meter, not through the agent`, tx: null, explorer: null };
    }
    try {
      const desk = await this.#desk();
      const deps: AttackDeps = {
        network: this.network, contractId: this.contractId, deskId: this.deskId, contract: this.#o.contract, transport: this.#o.transport, now: this.#now,
      };
      const r = await runAttack(attack, desk, deps, { dry: input.dry === true });
      return {
        ok: true, attack: r.id, title: r.title, method: r.method, expected: r.expect, outcome: r.outcome, code: r.code,
        tx: r.tx, explorer: this.#explorer(r.tx), no_tx_reason: r.outcome === 'rejected' ? 'rejected before the chain, no tx' : null,
        detail: r.detail, ...(r.signed === undefined ? {} : { signed_before_refusal: r.signed }),
        pass: r.pass, got_through: r.outcome === 'signed',
      };
    } catch (err) {
      return this.failure(attack.id, err);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** The account value, withdrawable USDC and open positions of a clearinghouseState answer. */
export function summariseHl(state: unknown): unknown {
  if (!isObject(state)) return null;
  if ('error' in state) return state;
  const margin = isObject(state.marginSummary) ? state.marginSummary : {};
  const positions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
  return {
    account_value: margin.accountValue ?? null,
    withdrawable: state.withdrawable ?? null,
    positions: positions.map((p) => {
      const pos = isObject(p) && isObject(p.position) ? p.position : {};
      return { coin: pos.coin, size: pos.szi, entry_px: pos.entryPx, unrealized_pnl: pos.unrealizedPnl, liquidation_px: pos.liquidationPx };
    }),
  };
}
