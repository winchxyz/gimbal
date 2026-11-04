// How an account id is shown in the remote view: first 4, an ellipsis, last 4, as the engine's view masks the owner's and
// the operator's ids (engine/src/view/view-redact.ts, `maskAccount`; the two must stay the same). The one place the page
// does it, so the Security screen, which reads those ids from the chain itself, shows them the way the engine's own
// payloads arrive.

/** An account id as the remote view shows it. Ids of 9 characters or fewer are cut whole, like the engine's. */
export function maskAccount(id: string): string {
  return id.length > 9 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '…';
}

/** `id` masked when it is one of `secret`, as it is. */
export function maskIf(id: string, secret: readonly (string | null)[]): string {
  return secret.includes(id) ? maskAccount(id) : id;
}

/** `text` with every whole occurrence of each of `ids` masked: an RPC error may quote the account it was asked about. */
export function maskIn(text: string, ids: readonly (string | null)[]): string {
  let out = text;
  for (const id of ids) if (id !== null && id !== '') out = out.split(id).join(maskAccount(id));
  return out;
}
