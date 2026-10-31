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

/** The `data` of a successful answer; OrderlyApiError for anything else (non-2xx, success false, not JSON). */
export async function readOrderlyData<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrderlyApiError(what, res.status, null, `not JSON: ${text.slice(0, 120)}`, text);
  }
  const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { success?: unknown; data?: unknown; code?: unknown; message?: unknown };
  if (!res.ok || o.success !== true) {
    throw new OrderlyApiError(what, res.status, typeof o.code === 'number' ? o.code : null, typeof o.message === 'string' ? o.message : text.slice(0, 200), text);
  }
  return o.data as T;
}
