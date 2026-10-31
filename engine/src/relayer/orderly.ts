// Orderly REST submitter: sends a contract-signed private REST call with Orderly's four headers
// (docs/interfaces.md §1.4): orderly-timestamp, orderly-account-id, orderly-key (ed25519:<base58>) and
// orderly-signature (base64url of the 64 bytes). The action is checked first (venue, desk, kind, a message that is
// exactly timestamp + METHOD + path + body, inside the 300 s window), so an action that would be refused is not sent.
// An order or a withdrawal that may have been carried out without saying so (a timeout, a dropped connection, a 5xx,
// an answer that is not Orderly's JSON) is OutcomeUnknown with its client_order_id or withdraw nonce: a new request
// would get a new id from the contract, which Orderly cannot match to the first one. Orderly's own refusal (success
// false under a status below 500) stays OrderlyApiError.

import type { OutcomeIds } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import type { OrderlyRestAction } from '../venues/orderly-signer.ts';
import { checkRestAction, orderlyAuthHeaders, signedClientOrderId } from '../venues/orderly-signer.ts';
import { orderlyAnswer } from '../venues/orderly-http.ts';

export interface OrderlyRestTarget {
  apiUrl: string;                // REST root, no trailing slash
  deskId: string;
  accountId: string;             // the desk's Orderly account id
  orderlyKey: string;            // "ed25519:<base58>" of the desk's Ed25519 MPC key
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Kinds whose lost answer is OutcomeUnknown: they open a position or move money, and a re-request is a new one. */
const UNKNOWN_WHEN_UNCLEAR: ReadonlySet<string> = new Set(['order', 'withdraw_request']);

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

/**
 * Checks and sends one signed REST call; resolves with Orderly's `data`, or throws OrderlyApiError. For an order or
 * a withdrawal, an answer that does not say whether it was carried out is OutcomeUnknown instead.
 */
export async function sendOrderlyRest<T = unknown>(action: OrderlyRestAction, expectedKind: string, target: OrderlyRestTarget): Promise<T> {
  checkRestAction(action, expectedKind, (target.now ?? Date.now)(), target.deskId);
  const { url, init } = orderlyRequestInit(action, target);
  const what = `${expectedKind} ${init.method} ${action.payload.path.split('?')[0]}`;
  const careful = UNKNOWN_WHEN_UNCLEAR.has(expectedKind);
  const unknown = (detail: string) => new OutcomeUnknown(`orderly ${expectedKind}`, detail, orderlyIds(action, expectedKind),
    action.nearTx === undefined ? [] : [action.nearTx]);
  let status: number;
  let text: string;
  try {
    const res = await (target.fetch ?? fetch)(url, init);
    status = res.status;
    text = await res.text();
  } catch (err) {
    if (careful) throw unknown(`no answer from Orderly (${errorText(err)}); it may have taken the request`);
    throw err;
  }
  const answer = orderlyAnswer<T>(status, text, what);
  if (answer.kind === 'data') return answer.data;
  if (answer.kind === 'unclear' && careful) throw unknown(`${answer.error.message}; not a refusal, so it may have taken the request`);
  throw answer.error;
}

/** The ids to reconcile an Orderly request by: the NEAR transaction, an order's client_order_id, a withdrawal's nonce. */
function orderlyIds(action: OrderlyRestAction, kind: string): OutcomeIds {
  const ids: OutcomeIds = action.nearTx === undefined ? {} : { nearTx: action.nearTx.id };
  if (kind === 'order') {
    const id = signedClientOrderId(action);
    if (id !== null) ids.orderlyClientOrderId = id;
  }
  if (kind === 'withdraw_request') {
    try {
      // The EIP-712 message's withdrawNonce, or a top-level nonce: whichever the contract's body carries.
      const body = JSON.parse(action.payload.body) as { message?: { withdrawNonce?: unknown }; nonce?: unknown };
      const raw = body.message?.withdrawNonce ?? body.nonce;
      const nonce = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (Number.isSafeInteger(nonce)) ids.orderlyWithdrawNonce = nonce as number;
    } catch {
      // no nonce to name
    }
  }
  return ids;
}

function errorText(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const text = `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`;
  return e?.cause?.code === undefined ? text : `${text} (${e.cause.code})`;
}
