// RPC URLs out of error texts: providers put API keys in the path or the query (…/v2/<key>, ?apiKey=…), and client
// libraries quote the URL in their errors (near-api-js, viem). What may be shown is the origin, with "/…" when a
// path, query or credentials were cut.

/** What may be shown of an RPC URL: its origin, with "/…" when a path or query (where API keys go) was cut. */
export function rpcLabel(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.pathname.replace(/\/+$/, '') !== '' || u.search !== '' || u.username !== '' || u.password !== '';
    return hidden ? `${u.protocol}//${u.host}/…` : `${u.protocol}//${u.host}`;
  } catch {
    return '<RPC URL>';
  }
}

/** `text` with the RPC URL shown only as rpcLabel(url), and its path, query and credentials cut wherever they appear. */
export function redact(text: string, url: string | undefined): string {
  if (url === undefined || url === '') return text;
  let out = text.split(url).join(rpcLabel(url));
  try {
    const u = new URL(url);
    const secrets = [u.href, `${u.pathname}${u.search}`, u.pathname, u.search, u.username, u.password,
      ...[...u.searchParams.values()], ...u.pathname.split('/')]
      .filter((s) => s.length >= 6 && s !== '/');
    for (const s of secrets.sort((a, b) => b.length - a.length)) out = out.split(s).join('…');
  } catch {
    // not a URL: nothing more to cut
  }
  return out;
}

/**
 * `text` with every copy of `secret` (an API key sent in a header) cut to "…". A service may quote the key back in
 * an error ("invalid key sk-…"), and such a text ends up in logs and HTTP answers.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === '') return text;
  return text.split(secret).join('…');
}

/** The error itself when its text holds nothing of the URL to hide; else an Error of the same name with the text cut. */
export function redactError(err: unknown, url: string | undefined): unknown {
  if (!(err instanceof Error)) return err;
  const text = redact(err.message, url);
  if (text === err.message) return err;
  const safe = new Error(text);
  safe.name = err.name;
  return safe;
}
