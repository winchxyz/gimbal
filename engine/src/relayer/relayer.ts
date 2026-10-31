// The relayer: has the contract sign one action for the desk and delivers it to its venue, confirmed, as TxRef[]
// (the NEAR signature first, then what the venue's chain recorded). The contract client admits each signature
// against the operator key's budget and retries an MPC timeout where it can; inputs only the relayer can renew (a
// Solana message's blockhash) are rebuilt here and signed once more, but only once the first message is proven
// expired. OutcomeUnknown (sent, no proof either way) goes up with every id the relayer adds (the order's cloid):
// the caller reconciles from the venue's state before it does anything else.
//
//   Hyperliquid  contract.hl_*        -> POST /exchange, confirmed in userFills / the ledger      (hyperliquid.ts)
//   Solana       contract.sol_sign*   -> sendTransaction, rebroadcast every 2 s until it lands   (solana.ts)
//   Orderly      contract.orderly_*   -> REST with the orderly-* headers                         (orderly.ts)
//   Arbitrum     evm_usdc_to_intents  -> transferWithAuthorization from the gas-only wallet      (arbitrum.ts)

import type { TxRef } from '@gimbal/shared';
import type { ContractClient, DeskView, HlOrder, HlSignedAction, OutcomeIds, SignedQuote, SolSignedAction } from '../contract/types.ts';
import { MpcTimeoutError, OutcomeUnknown, solMessageDigest } from '../contract/types.ts';
import type { OrderlyRequest, OrderlyRequestKind } from '../venues/orderly-signer.ts';
import { signedClientOrderId } from '../venues/orderly-signer.ts';
import type { ArbitrumSubmitter } from './arbitrum.ts';
import { newCloid } from './hl-order.ts';
import type { HlSubmitResult, HyperliquidSubmitter } from './hyperliquid.ts';
import type { OrderlyRestTarget } from './orderly.ts';
import { sendOrderlyRest } from './orderly.ts';
import type { SolanaSubmitter } from './solana.ts';

/** A Solana message to sign, built with a fresh blockhash each time it is asked for. */
export type SolanaMessageBuilder = () => Promise<{ messageB64: string; lastValidBlockHeight?: number }>;

export interface RelayerOptions {
  contract: ContractClient;
  deskId: string;
  hyperliquid?: HyperliquidSubmitter;
  solana?: SolanaSubmitter;
  arbitrum?: ArbitrumSubmitter;
  orderly?: Omit<OrderlyRestTarget, 'deskId'>;
}

export class Relayer {
  readonly deskId: string;
  readonly #contract: ContractClient;
  readonly #hl: HyperliquidSubmitter | undefined;
  readonly #sol: SolanaSubmitter | undefined;
  readonly #arb: ArbitrumSubmitter | undefined;
  readonly #orderly: OrderlyRestTarget | undefined;
  #desk: DeskView | null = null;

  constructor(options: RelayerOptions) {
    this.deskId = options.deskId;
    this.#contract = options.contract;
    this.#hl = options.hyperliquid;
    this.#sol = options.solana;
    this.#arb = options.arbitrum;
    this.#orderly = options.orderly === undefined ? undefined : { ...options.orderly, deskId: options.deskId };
  }

  /** The desk as get_desk returns it, read once; `fresh` reads it again (a pause, a new policy). */
  async desk(fresh = false): Promise<DeskView> {
    if (this.#desk === null || fresh) {
      const d = await this.#contract.getDesk(this.deskId);
      if (d === null) throw new Error(`relayer: the contract has no desk ${this.deskId}`);
      this.#desk = d;
    }
    return this.#desk;
  }

  // ---- Hyperliquid ----

  /** An order without a cloid gets one, so whatever happens to it can be looked up by cloid. */
  async hlOrder(order: HlOrder, reason: string): Promise<HlSubmitResult> {
    const withCloid = order.cloid === null || order.cloid === undefined ? { ...order, cloid: newCloid() } : order;
    try {
      return await this.submitHl(await this.#contract.hlOrder(this.deskId, withCloid, reason));
    } catch (err) {
      if (err instanceof OutcomeUnknown) throw err.with({ hlCloid: withCloid.cloid! });
      throw err;
    }
  }

  async hlCancel(asset: number, oid: number, reason: string): Promise<HlSubmitResult> {
    return this.submitHl(await this.#contract.hlCancel(this.deskId, asset, oid, reason));
  }

  async hlApproveBuilderFee(): Promise<HlSubmitResult> {
    return this.submitHl(await this.#contract.hlApproveBuilderFee(this.deskId));
  }

  async hlSetReferrer(): Promise<HlSubmitResult> {
    return this.submitHl(await this.#contract.hlSetReferrer(this.deskId));
  }

  async hlUsdClassTransfer(amount: string, toPerp: boolean, reason: string): Promise<HlSubmitResult> {
    return this.submitHl(await this.#contract.hlUsdClassTransfer(this.deskId, amount, toPerp, reason));
  }

  async hlSendToIntents(quote: SignedQuote, reason: string): Promise<HlSubmitResult> {
    return this.submitHl(await this.#contract.hlSendToIntents(this.deskId, quote, reason));
  }

  async submitHl(signed: HlSignedAction): Promise<HlSubmitResult> {
    if (this.#hl === undefined) throw new Error('relayer: no Hyperliquid submitter configured');
    return this.#hl.submit(signed, (await this.desk()).evm_address);
  }

  // ---- Solana ----

  /**
   * sol_sign over a message `build` makes. After an MPC timeout it is built again once, only when the first
   * blockhash is proven expired; a second timeout reaches the caller as MpcTimeoutError only on the same proof.
   */
  async solSign(build: SolanaMessageBuilder, reason: string): Promise<TxRef[]> {
    return this.#solana(build, (m) => this.#contract.solSign(this.deskId, m, reason));
  }

  async solSignRescue(build: SolanaMessageBuilder, quote: SignedQuote, reason: string): Promise<TxRef[]> {
    return this.#solana(build, (m) => this.#contract.solSignRescue(this.deskId, m, quote, reason));
  }

  async #solana(build: SolanaMessageBuilder, sign: (messageB64: string) => Promise<SolSignedAction>): Promise<TxRef[]> {
    const sol = this.#sol;
    if (sol === undefined) throw new Error('relayer: no Solana submitter configured');
    const authority = (await this.desk()).solana.authority;
    for (let attempt = 1; ; attempt++) {
      const message = await build();
      let signed: SolSignedAction;
      const lvbh = message.lastValidBlockHeight;
      const ids: OutcomeIds = { solMessage: solMessageDigest(message.messageB64), ...(lvbh === undefined ? {} : { solLastValidBlockHeight: lvbh }) };
      try {
        signed = await sign(message.messageB64);
      } catch (err) {
        if (err instanceof OutcomeUnknown) throw err.with(ids);
        if (err instanceof MpcTimeoutError) {
          // A late MPC signature of this message could still be posted while its blockhash lives: sign a new one
          // (or hand the timeout to the caller, who may build another) only once that blockhash is proven expired.
          if (lvbh !== undefined && await sol.waitPastLastValidHeight(lvbh)) {
            if (attempt < 2) continue;
            throw err;
          }
          throw new OutcomeUnknown('solana', `${err.message}; the ${attempt === 1 ? 'first' : 'second'} message's blockhash is not proven expired${lvbh === undefined ? ' (no lastValidBlockHeight)' : ''}, so no other one is signed`,
            err.txHash === null ? ids : { ...ids, nearTx: err.txHash });
        }
        throw err;
      }
      if (!sameBytes(signed.payload?.message_b64, message.messageB64)) {
        throw new Error(`relayer ${signed.kind}: the contract signed a different message than the one built; nothing sent`);
      }
      return sol.submit(signed, { authority, ...(message.lastValidBlockHeight === undefined ? {} : { lastValidBlockHeight: message.lastValidBlockHeight }) });
    }
  }

  // ---- Orderly ----

  /**
   * One private REST call signed by the contract and sent with Orderly's headers; Orderly's `data`, the NEAR tx, and
   * for an order the client_order_id the contract derived (read from the signed body: the engine never picks one).
   * The timestamp is the current time: the contract refuses one more than a few seconds ahead.
   */
  async orderlyRequest<T = unknown>(kind: OrderlyRequestKind, fields: Partial<OrderlyRequest>, reason: string): Promise<{ data: T; tx: TxRef[]; clientOrderId: string | null }> {
    if (this.#orderly === undefined) throw new Error('relayer: no Orderly target configured');
    if (kind === 'order' && fields.client_order_id !== undefined && fields.client_order_id !== null) {
      throw new Error('relayer: the contract derives an order\'s client_order_id from its request_id; do not pass one');
    }
    const now = this.#orderly.now ?? Date.now;
    const req: OrderlyRequest = { reduce_only: false, ...fields, kind, timestamp_ms: now() };
    const signed = await this.#contract.orderlyRequest(this.deskId, req, reason);
    const data = await sendOrderlyRest<T>(signed, kind, this.#orderly);
    return { data, tx: signed.nearTx === undefined ? [] : [signed.nearTx], clientOrderId: kind === 'order' ? signedClientOrderId(signed) : null };
  }

  // ---- Arbitrum and NEAR ----

  async evmUsdcToIntents(quote: SignedQuote, reason: string): Promise<TxRef[]> {
    if (this.#arb === undefined) throw new Error('relayer: no Arbitrum submitter configured');
    const signed = await this.#contract.evmUsdcToIntents(this.deskId, quote, reason);
    return this.#arb.submit(signed, (await this.desk()).evm_address);
  }

  fundVenue(quote: SignedQuote, reason: string): Promise<TxRef[]> {
    return this.#contract.fundVenue(this.deskId, quote, reason);
  }
}

function sameBytes(a: unknown, b: string): boolean {
  return typeof a === 'string' && Buffer.from(a, 'base64').equals(Buffer.from(b, 'base64'));
}
