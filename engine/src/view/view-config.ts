// The read-only view listener's settings, from the environment (docs/deploy-railway.md, "The read-only view"):
//   GIMBAL_VIEW_TOKEN    the bearer token viewers send; unset = the view is off. At least VIEW_TOKEN_MIN_LENGTH
//                        characters, no whitespace
//   GIMBAL_VIEW_PORT     the port it listens on, on every interface (0.0.0.0); default PORT, which Railway sets
//   GIMBAL_VIEW_ORIGINS  the browser origins allowed to call it (CORS), comma or space separated, e.g.
//                        https://gimbal.example; none = no browser page may call it (curl still can)
// Off is never an error: serve runs the engine either way, and the start line says why the view is off.

export const VIEW_TOKEN_MIN_LENGTH = 32;

export interface ViewConfig {
  token: string;
  port: number;
  origins: string[];
}

/** The view's settings, or why it is off (`reason` null: GIMBAL_VIEW_TOKEN is not set, nothing to say). */
export function viewConfigFromEnv(
  env: (name: string) => string | undefined, enginePort: number,
): { config: ViewConfig } | { off: string | null } {
  const token = env('GIMBAL_VIEW_TOKEN');
  if (token === undefined || token === '') return { off: null };
  if (/\s/.test(token)) return { off: 'GIMBAL_VIEW_TOKEN has whitespace in it' };
  if (token.length < VIEW_TOKEN_MIN_LENGTH) {
    return { off: `GIMBAL_VIEW_TOKEN is ${token.length} characters, under the ${VIEW_TOKEN_MIN_LENGTH} required (openssl rand -hex 32 makes one)` };
  }
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
