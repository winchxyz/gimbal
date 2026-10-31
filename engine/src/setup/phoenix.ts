// Phoenix onboarding for a desk (interfaces 1.3): no wallet login, no invite.
//   register: POST /v1/exchange/build-register-ixs (the desk as authority and fee payer) -> the engine compiles the
//             instructions into a legacy message -> sol_sign_register -> POST /v1/exchange/send-register-ixs, where
//             Phoenix's onboarder adds its signature and sends it.
//   referral: only with referral_codes.phoenix set. rise builds the activation (a v0 message with one
//             set_trader_capabilities_delegated); sol_sign_register signs it; POST /v1/referral/activate-tx carries the
//             code in its body (it is not in the signed bytes, so the engine sends only the configured code).
// The combined includeRegisterTrader transaction is never built: the contract refuses it (E_SOL_PROGRAM).
// Phoenix runs on mainnet only; the engine reaches this path on testnet only through recorded answers.

import { buildReferralActivationTransaction, referralActivationExchangeAccountsFromSnapshot } from '@ellipsis-labs/rise';
import type { TxRef } from '@gimbal/shared';
import type { SolSignedAction } from '../contract/types.ts';
import { base58Decode, parseMessage, verifyEd25519 } from '../relayer/solana.ts';
import { solanaTxRef } from '../relayer/tx.ts';

export const PHOENIX_API = 'https://perp-api.phoenix.trade';
/** register_trader's max_positions: the contract pins 128 (solana-onboarding.json). */
export const PHOENIX_MAX_POSITIONS = 128;

export interface RegisterIx {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: number[];
}

export interface PhoenixSigner {
  solSignRegister(deskId: string, messageB64: string): Promise<SolSignedAction>;
}

export interface SolanaReads {
  latestBlockhash(): Promise<string>;
  /** Whether an account exists (has data); throws when the RPC does not answer, never "no". */
  accountExists(address: string): Promise<boolean>;
}

export interface PhoenixOnboardingOptions {
  deskId: string;
  authority: string;             // the desk's Solana authority (fee payer)
  traderPda: string;             // get_desk solana.phoenix_trader
  referralCode: string | null;   // treasury.referral_codes.phoenix
  signer: PhoenixSigner;
  solana: SolanaReads;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PhoenixRegisterResult {
  signature: string | null;      // Solana transaction signature Phoenix sent
  tx: TxRef[];                   // the NEAR signature, then the Solana transaction
}

export interface PhoenixReferralResult {
  status: string;                // activated | submitted | already_activated
  signature: string | null;
  tx: TxRef[];
}

export class PhoenixOnboarding {
  readonly #o: PhoenixOnboardingOptions;
  readonly #api: string;
  readonly #fetch: typeof fetch;

  constructor(options: PhoenixOnboardingOptions) {
    this.#o = options;
    this.#api = (options.apiUrl ?? PHOENIX_API).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** The desk's trader account exists: registration is done. */
  isRegistered(): Promise<boolean> {
    return this.#o.solana.accountExists(this.#o.traderPda);
  }

  async register(): Promise<PhoenixRegisterResult> {
    const { authority } = this.#o;
    // maxPositions is left to Phoenix's default (128, what the contract pins); a different answer is refused below.
    const built = await this.#post<{ instructions?: RegisterIx[]; traderPda?: string; txFeePayer?: string; maxPositions?: number }>(
      '/v1/exchange/build-register-ixs', { traderAuthority: authority, txFeePayer: authority });
    if (!Array.isArray(built.instructions) || built.instructions.length === 0) throw new Error(`phoenix build-register-ixs: no instructions in ${JSON.stringify(built).slice(0, 200)}`);
    if (built.txFeePayer !== undefined && built.txFeePayer !== authority) throw new Error(`phoenix build-register-ixs: fee payer ${built.txFeePayer}, not the desk`);
    if (built.maxPositions !== undefined && built.maxPositions !== PHOENIX_MAX_POSITIONS) throw new Error(`phoenix build-register-ixs: maxPositions ${built.maxPositions}, the contract pins ${PHOENIX_MAX_POSITIONS}`);
    if (built.traderPda !== undefined && built.traderPda !== this.#o.traderPda) {
      throw new Error(`phoenix build-register-ixs: trader PDA ${built.traderPda}, the desk's is ${this.#o.traderPda}`);
    }
    const message = compileLegacyMessage(built.instructions, authority, await this.#o.solana.latestBlockhash());
    const { signature, nearTx } = await this.#sign(message);
    const sent = await this.#post<{ signature?: string }>('/v1/exchange/send-register-ixs', {
      transaction: twoSignerTransaction(signature, message), traderAuthority: authority, txFeePayer: authority, maxPositions: PHOENIX_MAX_POSITIONS,
    });
    return { signature: sent.signature ?? null, tx: [...nearTx, ...(sent.signature === undefined ? [] : [solanaTx(sent.signature)])] };
  }

  /** Activates the configured referral code; nothing (null) without one. */
  async activateReferral(): Promise<PhoenixReferralResult | null> {
    const code = this.#o.referralCode;
    if (code === null) return null;
    const [permission, snapshot] = await Promise.all([
      this.#get<{ trader_onboarder: string; risk_authority: string; permission_account: string }>('/v1/referral/activation-permission'),
      this.#get<{ exchange?: { programId: string; globalConfig: string; globalTraderIndex: string[]; activeTraderBuffer: string[] } }>('/v1/exchange/snapshot'),
    ]);
    if (snapshot.exchange === undefined) throw new Error('phoenix exchange snapshot: no exchange section');
    const build = await buildReferralActivationTransaction({
      referralCode: code, traderAuthority: this.#o.authority, feePayer: this.#o.authority, recentBlockhash: await this.#o.solana.latestBlockhash(),
      permission, exchangeAccounts: await referralActivationExchangeAccountsFromSnapshot(snapshot.exchange as Parameters<typeof referralActivationExchangeAccountsFromSnapshot>[0]),
      traderPdaIndex: 0, traderSubaccountIndex: 0,
    });
    if (build.traderPda !== this.#o.traderPda) throw new Error(`phoenix referral: trader PDA ${build.traderPda}, the desk's is ${this.#o.traderPda}`);
    const message = new Uint8Array(build.transaction.messageBytes);
    const { signature, nearTx } = await this.#sign(message);
    const answer = await this.#post<{ status?: string; signature?: string }>('/v1/referral/activate-tx', {
      ...build.requestFields, referral_code: code, transaction: twoSignerTransaction(signature, message),
    });
    if (typeof answer.status !== 'string') throw new Error(`phoenix activate-tx: no status in ${JSON.stringify(answer).slice(0, 200)}`);
    return { status: answer.status, signature: answer.signature ?? null, tx: [...nearTx, ...(answer.signature === undefined ? [] : [solanaTx(answer.signature)])] };
  }

  /** sol_sign_register over the message; the signature must verify against the desk authority before it is sent. */
  async #sign(message: Uint8Array): Promise<{ signature: Uint8Array; nearTx: TxRef[] }> {
    const messageB64 = Buffer.from(message).toString('base64');
    const signed = await this.#o.signer.solSignRegister(this.#o.deskId, messageB64);
    if (signed.payload.message_b64 !== messageB64) throw new Error('phoenix: the contract signed another message than the one compiled');
    const signature = Uint8Array.from(signed.signature.signature);
    if (signature.length !== 64 || !verifyEd25519(this.#o.authority, message, signature)) {
      throw new Error(`phoenix: the signature does not verify against the desk authority ${this.#o.authority}`);
    }
    return { signature, nearTx: signed.nearTx === undefined ? [] : [signed.nearTx] };
  }

  async #get<T>(path: string): Promise<T> {
    return this.#answer<T>(await this.#fetch(`${this.#api}${path}`, { signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000) }), `GET ${path}`);
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#api}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.#o.timeoutMs ?? 30_000),
    });
    return this.#answer<T>(res, `POST ${path}`);
  }

  async #answer<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new Error(`phoenix ${what}: HTTP ${res.status} ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`phoenix ${what}: not JSON: ${text.slice(0, 200)}`);
    }
  }
}

/** [2][desk signature][64 zero bytes for Phoenix's onboarder][message], base64: what Phoenix co-signs and sends. */
export function twoSignerTransaction(deskSignature: Uint8Array, message: Uint8Array): string {
  return Buffer.concat([Buffer.from([2]), Buffer.from(deskSignature), Buffer.alloc(64), Buffer.from(message)]).toString('base64');
}

// web3.js (1.x) sorts account keys this way in Transaction.compileMessage; the vectors' register message was compiled
// by it, and sol_sign_register signs exactly these bytes, so the order must be the same.
const KEY_ORDER = new Intl.Collator('en', { usage: 'sort', sensitivity: 'variant', ignorePunctuation: false, numeric: false, caseFirst: 'lower' });

/**
 * A legacy Solana message from instructions, keys ordered as web3.js orders them: signers first, then writable, then
 * by address (en collation); the fee payer moved to the front as a writable signer.
 */
export function compileLegacyMessage(instructions: RegisterIx[], feePayer: string, recentBlockhash: string): Uint8Array {
  const metas: { pubkey: string; isSigner: boolean; isWritable: boolean }[] = [];
  const programIds: string[] = [];
  for (const ix of instructions) {
    for (const k of ix.keys) metas.push({ ...k });
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
  }
  for (const p of programIds) metas.push({ pubkey: p, isSigner: false, isWritable: false });
  const unique: typeof metas = [];
  for (const m of metas) {
    const seen = unique.find((u) => u.pubkey === m.pubkey);
    if (seen === undefined) unique.push(m);
    else {
      seen.isSigner ||= m.isSigner;
      seen.isWritable ||= m.isWritable;
    }
  }
  unique.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return KEY_ORDER.compare(x.pubkey, y.pubkey);
  });
  const payerAt = unique.findIndex((u) => u.pubkey === feePayer);
  const payer = payerAt === -1 ? { pubkey: feePayer, isSigner: true, isWritable: true } : unique.splice(payerAt, 1)[0]!;
  payer.isSigner = true;
  payer.isWritable = true;
  unique.unshift(payer);

  const signed = unique.filter((u) => u.isSigner);
  const unsigned = unique.filter((u) => !u.isSigner);
  const keys = [...signed, ...unsigned].map((u) => u.pubkey);
  const header = [signed.length, signed.filter((u) => !u.isWritable).length, unsigned.filter((u) => !u.isWritable).length];
  const index = (k: string) => {
    const i = keys.indexOf(k);
    if (i < 0 || i > 255) throw new Error(`solana message: key ${k} has no index`);
    return i;
  };
  const parts: Buffer[] = [Buffer.from(header), compactU16(keys.length)];
  for (const k of keys) parts.push(key32(k));
  parts.push(key32(recentBlockhash), compactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(Buffer.from([index(ix.programId)]), compactU16(ix.keys.length), Buffer.from(ix.keys.map((k) => index(k.pubkey))));
    parts.push(compactU16(ix.data.length), Buffer.from(ix.data));
  }
  const message = new Uint8Array(Buffer.concat(parts));
  parseMessage(message);   // the engine's own parser must read back what it compiled
  return message;
}

function key32(b58: string): Buffer {
  const b = base58Decode(b58);
  if (b.length !== 32) throw new Error(`solana message: ${b58} is not a 32-byte key`);
  return b;
}

function compactU16(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      return Buffer.from(out);
    }
    out.push(byte | 0x80);
  }
}

function solanaTx(signature: string): TxRef {
  return solanaTxRef('mainnet', signature);
}

/** Solana JSON-RPC reads for setup: the latest blockhash and whether an account exists. */
export function solanaReads(rpcUrl: string, fetchImpl: typeof fetch = fetch): SolanaReads {
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json() as { result?: T; error?: { message?: string } };
    if (!res.ok || body.error !== undefined || body.result === undefined) throw new Error(`solana ${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  };
  return {
    latestBlockhash: async () => (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash,
    accountExists: async (address) => (await rpc<{ value: unknown }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value !== null,
  };
}
