// Orderly endpoints and the answer envelope every REST call shares: {"success", "data", "timestamp"} on success,
// {"success": false, "code", "message"} on a refusal (often with HTTP 200 or 400).

export type OrderlyNetwork = 'mainnet' | 'testnet';

export interface OrderlyEndpoints {
  api: string;                   // REST
  publicWs: string;              // public stream; an account id is appended (order book)
  privateWs: string;             // private stream; the desk's account id is appended (positions, balances)
}

export const ORDERLY_ENDPOINTS: Record<OrderlyNetwork, OrderlyEndpoints> = {
  mainnet: {
    api: 'https://api.orderly.org',
    publicWs: 'wss://ws-evm.orderly.org/ws/stream/',
    privateWs: 'wss://ws-private-evm.orderly.org/v2/ws/private/stream/',
  },
  testnet: {
    api: 'https://testnet-api.orderly.org',
    publicWs: 'wss://testnet-ws-evm.orderly.org/ws/stream/',
    privateWs: 'wss://testnet-ws-private-evm.orderly.org/v2/ws/private/stream/',
  },
};

/** An Orderly account id: 0x + 32 bytes of hex (keccak of the wallet address and the broker id). */
export function normalizeAccountId(accountId: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountId)) throw new Error(`orderly: not an account id: ${accountId}`);
  return accountId.toLowerCase();
}

/** A non-success answer from Orderly: the HTTP status, and the venue's own code and message when it gave them. */
export class OrderlyApiError extends Error {
  status: number;
  code: number | null;
  body: string;
  constructor(what: string, status: number, code: number | null, message: string, body: string) {
    super(`orderly ${what}: HTTP ${status}${code === null ? '' : ` code ${code}`} ${message}`.trim());
    this.name = 'OrderlyApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * What one answer says:
 *   - data: HTTP 2xx with success true;
 *   - refused: Orderly's own refusal, success false under a status below 500 (a 4xx, or a 200 that says no). The
 *     request was turned down;
 *   - unclear: anything else (a 5xx, a body that is not JSON, no success flag). It does not say whether the request
 *     was carried out.
 */
export function orderlyAnswer<T>(status: number, text: string, what: string):
  { kind: 'data'; data: T } | { kind: 'refused' | 'unclear'; error: OrderlyApiError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unclear', error: new OrderlyApiError(what, status, null, `not JSON: ${text.slice(0, 120)}`, text) };
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { success?: unknown; data?: unknown; code?: unknown; message?: unknown };
  const ok = status >= 200 && status < 300;
  if (ok && o.success === true) return { kind: 'data', data: o.data as T };
  const error = new OrderlyApiError(what, status, typeof o.code === 'number' ? o.code : null, typeof o.message === 'string' ? o.message : text.slice(0, 200), text);
  return { kind: status < 500 && o.success === false ? 'refused' : 'unclear', error };
}

/** The `data` of a successful answer; OrderlyApiError for anything else (non-2xx, success false, not JSON). */
export async function readOrderlyData<T>(res: Response, what: string): Promise<T> {
  const answer = orderlyAnswer<T>(res.status, await res.text(), what);
  if (answer.kind === 'data') return answer.data;
  throw answer.error;
}
