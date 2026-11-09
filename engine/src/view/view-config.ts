// The read-only view listener's settings, from the environment (docs/deploy-railway.md, "The read-only view"):
//   GIMBAL_VIEW_TOKEN    the bearer token viewers send; unset = the view is off. At least VIEW_TOKEN_MIN_LENGTH
//                        characters, no whitespace, and not guessable (VIEW_TOKEN_MIN_DISTINCT distinct characters
//                        or VIEW_TOKEN_MIN_BITS estimated)
//   GIMBAL_VIEW_PORT     the port it listens on, on every interface (0.0.0.0); default PORT, which Railway sets
//   GIMBAL_VIEW_ORIGINS  the browser origins allowed to call it (CORS), comma or space separated, e.g.
//                        https://gimbal.example; none = no browser page may call it (curl still can)
//   GIMBAL_OWNER_TOKEN   optional: with it the view also forwards the owner's POST /rotate, POST /close and PUT
//                        /strategy (view-server.ts, "Owner writes"); the same rules as the view token, and not equal
//                        to it. Unset = the view is read-only, as without this variable; a bad value = read-only,
//                        with the reason on the start line
// Off is never an error: serve runs the engine either way, and the start line says why the view is off.

export const VIEW_TOKEN_MIN_LENGTH = 32;
/** A token passes with this many distinct characters, or with VIEW_TOKEN_MIN_BITS estimated. */
export const VIEW_TOKEN_MIN_DISTINCT = 16;
export const VIEW_TOKEN_MIN_BITS = 128;

/**
 * The token's entropy estimated from its own characters: length times the Shannon entropy of their frequencies. It
 * rates "aaaa…" or "abab…" near zero and a random hex string near 4 bits a character. The second test matters for hex:
 * `openssl rand -hex 32` leaves out one of the 16 digits about a quarter of the time, and still has about 250 bits.
 */
/** Runs of this many characters, each one code point above (or below) the last, are a sequence: 012345, abcdef. */
export const VIEW_TOKEN_MAX_RUN = 6;
const MAKE_ONE = 'make one with openssl rand -hex 32 or node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

/**
 * What makes the token an obvious pattern, or null: a shorter piece repeated (abcabc…, a typed word twice), or a
 * sequence of VIEW_TOKEN_MAX_RUN or more (0123456789…, zyxwvu…). The token is the only thing between the internet and
 * the desk's state, so these are refused even when they pass the counts above. A random hex token has a 6-run about
 * once in 10 000.
 */
export function tokenPattern(token: string): string | null {
  for (let p = 1; p <= token.length / 2; p++) {
    let periodic = true;
    for (let i = p; i < token.length && periodic; i++) if (token[i] !== token[i - p]) periodic = false;
    if (periodic) return `it repeats ${JSON.stringify(token.slice(0, Math.min(p, 8)))}${p > 8 ? '…' : ''} every ${p} characters`;
  }
  let run = 1;
  let step = 0;
  for (let i = 1; i < token.length; i++) {
    const d = token.charCodeAt(i) - token.charCodeAt(i - 1);
    if ((d === 1 || d === -1) && (run === 1 || d === step)) {
      run++;
      step = d;
    } else {
      run = d === 1 || d === -1 ? 2 : 1;
      step = d;
    }
    if (run >= VIEW_TOKEN_MAX_RUN) return `a run of ${VIEW_TOKEN_MAX_RUN} characters in sequence at ${i - VIEW_TOKEN_MAX_RUN + 1}`;
  }
  return null;
}

export function tokenBits(token: string): number {
  const counts = new Map<string, number>();
  for (const c of token) counts.set(c, (counts.get(c) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / token.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * token.length;
}

export interface ViewConfig {
  token: string;
  port: number;
  origins: string[];
}

/**
 * What is wrong with a token set in `name`, or null when it may be used: whitespace, too short, too few distinct
 * characters and bits, or an obvious pattern. Never quotes the value.
 */
export function tokenProblem(name: string, token: string): string | null {
  if (/\s/.test(token)) return `${name} has whitespace in it`;
  if (token.length < VIEW_TOKEN_MIN_LENGTH) return `${name} is ${token.length} characters, under the ${VIEW_TOKEN_MIN_LENGTH} required: ${MAKE_ONE}`;
  const distinct = new Set(token).size;
  if (distinct < VIEW_TOKEN_MIN_DISTINCT && tokenBits(token) < VIEW_TOKEN_MIN_BITS) {
    return `${name} looks guessable (${distinct} distinct characters, about ${Math.floor(tokenBits(token))} bits; needs ${VIEW_TOKEN_MIN_DISTINCT} distinct or ${VIEW_TOKEN_MIN_BITS} bits): ${MAKE_ONE}`;
  }
  const pattern = tokenPattern(token);
  if (pattern !== null) return `${name} looks guessable (${pattern}): ${MAKE_ONE}`;
  return null;
}

/**
 * GIMBAL_OWNER_TOKEN: the second credential that lets the view forward the owner's writes (view-server.ts, "Owner
 * writes"). Unset: off, nothing to say (`off` null). Set but unusable: off, with the reason (names only, never the
 * value): the same rules as the view token, and it must not be the view token, which the live host holds.
 */
export function ownerTokenFromEnv(env: (name: string) => string | undefined, viewToken: string): { token: string } | { off: string | null } {
  const token = env('GIMBAL_OWNER_TOKEN');
  if (token === undefined || token === '') return { off: null };
  const problem = tokenProblem('GIMBAL_OWNER_TOKEN', token);
  if (problem !== null) return { off: problem };
  if (token === viewToken) return { off: 'GIMBAL_OWNER_TOKEN is the same as GIMBAL_VIEW_TOKEN: make it a token of its own' };
  return { token };
}

/** The view's settings, or why it is off (`reason` null: GIMBAL_VIEW_TOKEN is not set, nothing to say). */
export function viewConfigFromEnv(
  env: (name: string) => string | undefined, enginePort: number,
): { config: ViewConfig } | { off: string | null } {
  const token = env('GIMBAL_VIEW_TOKEN');
  if (token === undefined || token === '') return { off: null };
  const problem = tokenProblem('GIMBAL_VIEW_TOKEN', token);
  if (problem !== null) return { off: problem };
  const portText = env('GIMBAL_VIEW_PORT') ?? env('PORT');
  if (portText === undefined) return { off: 'GIMBAL_VIEW_TOKEN is set but neither GIMBAL_VIEW_PORT nor PORT is' };
  const port = Number(portText);
  if (!/^\d+$/.test(portText.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) return { off: `bad view port ${JSON.stringify(portText)}` };
  if (port === enginePort) return { off: `the view port ${port} is the engine's own; give the view another one` };
  const origins: string[] = [];
  for (const item of (env('GIMBAL_VIEW_ORIGINS') ?? '').split(/[\s,]+/).filter((s) => s !== '')) {
    const origin = parseOrigin(item);
    if (origin === null) return { off: `GIMBAL_VIEW_ORIGINS: ${JSON.stringify(item)} is not an origin (scheme://host[:port], no path, no *)` };
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { config: { token, port, origins } };
}

/** `item` as a browser sends it in an Origin header, or null when it is not exactly one origin. */
function parseOrigin(item: string): string | null {
  let u: URL;
  try {
    u = new URL(item);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname !== '/') return null;
  if (item.replace(/\/$/, '').toLowerCase() !== u.origin) return null;
  return u.origin;
}
