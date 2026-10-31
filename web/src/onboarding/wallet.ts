// The wallet behind a small interface: the flow asks it to connect and to sign one transaction, and never sees a
// key. `near-wallet.ts` is the real one (near-connect); `fake-wallet.ts` stands in for it in tests and in the
// development fake, because a real wallet cannot be driven headlessly.

export type NearNetwork = 'mainnet' | 'testnet';

/** The two actions onboarding sends, in the shape near-connect takes (its `ConnectorAction`). */
export type WalletAction =
  | { type: 'FunctionCall'; params: { methodName: string; args: object; gas: string; deposit: string } }
  | {
      type: 'AddKey';
      params: { publicKey: string; accessKey: { permission: { receiverId: string; allowance: string; methodNames: string[] } } };
    };

export interface WalletTx {
  receiverId: string;
  actions: WalletAction[];
}

/** What came of a signed transaction. `failure` is the contract's panic text when it was refused; `value` is the JSON it returned. */
export interface TxOutcome {
  hash: string | null;
  value: unknown;
  failure: string | null;
}

export interface Wallet {
  readonly network: NearNetwork;
  /** The connected account, or null. */
  accountId(): string | null;
  /** Picks up a session the wallet kept from an earlier visit, without opening anything. Resolves with the account or null. */
  restore?(): Promise<string | null>;
  /** Opens the wallet's own connect flow; resolves with the account id, rejects (`WalletError`) when nothing answers. */
  connect(): Promise<string>;
  /** Signs and sends one transaction. Rejects with `WalletError` when the wallet did not sign; resolves with the outcome otherwise. */
  signAndSend(tx: WalletTx): Promise<TxOutcome>;
  disconnect(): Promise<void>;
  /** Called when the wallet signs out by itself (the user removed access in the wallet). Returns the unsubscribe. */
  onSignOut(listener: () => void): () => void;
}

/** The wallet did not answer or the owner closed it: nothing was signed. */
export class WalletError extends Error {
  override name = 'WalletError';
}

// ---------- reading what a wallet returns ----------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Looks for the text a NEAR execution error carries (`ExecutionError`, or the panic inside a `Failure`). */
function failureText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return null;
  if (typeof value.ExecutionError === 'string') return value.ExecutionError;
  for (const inner of Object.values(value)) {
    const found = failureText(inner);
    if (found !== null) return found;
  }
  return null;
}

/** "Smart contract panicked: E_DEPOSIT: …" → "E_DEPOSIT: …". The code comes first in every refusal (§1.5). */
export function panicOf(text: string): string {
  const at = text.search(/\bE_[A-Z_]+/);
  const panic = text.replace(/^.*?panicked:\s*/s, '');
  return at >= 0 ? text.slice(at).trim() : panic.trim();
}

/** A wallet's `FinalExecutionOutcome` as a `TxOutcome`; anything that is not one is read as "no hash, no value, no failure". */
export function outcomeOf(raw: unknown): TxOutcome {
  if (!isObject(raw)) return { hash: null, value: null, failure: null };
  const hash = isObject(raw.transaction) && typeof raw.transaction.hash === 'string' ? raw.transaction.hash : null;
  const status = isObject(raw.status) ? raw.status : {};
  if (status.Failure !== undefined) {
    return { hash, value: null, failure: panicOf(failureText(status.Failure) ?? JSON.stringify(status.Failure)) };
  }
  let value: unknown = null;
  if (typeof status.SuccessValue === 'string' && status.SuccessValue !== '') {
    try {
      value = JSON.parse(atob(status.SuccessValue));
    } catch {
      value = null;
    }
  }
  // A refusal that came back through a callback is a `refuse` result rather than a failed transaction on some
  // nodes: a string value that starts with a refusal code is treated as one.
  if (typeof value === 'string' && /^E_[A-Z_]+/.test(value)) return { hash, value: null, failure: value };
  return { hash, value, failure: null };
}

/** The refusal codes of docs/interfaces.md §1.5 that onboarding can meet, in the owner's words. */
const REFUSALS: Record<string, string> = {
  E_NOT_ALLOWED: 'the contract did not accept the wallet’s call',
  E_DEPOSIT: 'the attached NEAR did not cover the storage',
  E_DESK_EXISTS: 'a desk with this id exists already',
  E_NO_DESK: 'there is no desk with this id',
  E_ARGS: 'the contract did not accept the arguments',
  E_MPC: 'the MPC network did not confirm the desk’s addresses',
  E_PAUSED: 'the desk is paused',
};

/** The code of a refusal text, e.g. "E_DESK_EXISTS: …" → "E_DESK_EXISTS"; null when it carries none. */
export const refusalCode = (text: string): string | null => /\b(E_[A-Z_]+)/.exec(text)?.[1] ?? null;

/** One sentence for a refusal: what the contract said, in words, then the contract's own text. */
export function refusalText(text: string): string {
  const code = refusalCode(text);
  const plain = code !== null ? REFUSALS[code] : undefined;
  return plain === undefined ? text : `${plain[0]!.toUpperCase()}${plain.slice(1)} (${text}).`;
}
