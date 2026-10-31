// Orderly REST submitter: sends a contract-signed private REST call with Orderly's four headers
// (docs/interfaces.md §1.4): orderly-timestamp, orderly-account-id, orderly-key (ed25519:<base58>) and
// orderly-signature (base64url of the 64 bytes). The action is checked first (venue, desk, kind, a message that is
// exactly timestamp + METHOD + path + body, inside the 300 s window), so an action that would be refused is not sent.

import type { OrderlyRestAction } from '../venues/orderly-signer.ts';
import { checkRestAction, orderlyAuthHeaders } from '../venues/orderly-signer.ts';
import { readOrderlyData } from '../venues/orderly-http.ts';

export interface OrderlyRestTarget {
  apiUrl: string;                // REST root, no trailing slash
  deskId: string;
  accountId: string;             // the desk's Orderly account id
  orderlyKey: string;            // "ed25519:<base58>" of the desk's Ed25519 MPC key
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** The request Orderly receives for a signed action: URL, method, headers and body. */
export function orderlyRequestInit(action: OrderlyRestAction, target: OrderlyRestTarget): { url: string; init: RequestInit } {
  const p = action.payload;
  const method = p.method.toUpperCase();
  const bodyless = method === 'GET' || method === 'DELETE';
  return {
    url: `${target.apiUrl.replace(/\/+$/, '')}${p.path}`,
    init: {
      method,
      headers: {
        ...orderlyAuthHeaders(action, target.accountId, target.orderlyKey),
        'content-type': bodyless ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      ...(bodyless ? {} : { body: p.body }),
      signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
    },
  };
}

/** Checks and sends one signed REST call; resolves with Orderly's `data`, or throws OrderlyApiError. */
export async function sendOrderlyRest<T = unknown>(action: OrderlyRestAction, expectedKind: string, target: OrderlyRestTarget): Promise<T> {
  checkRestAction(action, expectedKind, (target.now ?? Date.now)(), target.deskId);
  const { url, init } = orderlyRequestInit(action, target);
  const res = await (target.fetch ?? fetch)(url, init);
  return readOrderlyData<T>(res, `${expectedKind} ${init.method} ${action.payload.path.split('?')[0]}`);
}
