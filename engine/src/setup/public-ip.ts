// The engine's own public IP, for the Orderly IP restriction (interfaces 1.3: `set_orderly_ips`, then `orderly_request`
// kind `ip_restriction`). The engine sends every Orderly request (orders, closes, rescue reads) from this host, so a
// list that leaves its IP out locks the engine out of the desk's Orderly account. The lookup refuses when it cannot
// tell the IP: applying a list on a guess could lock the engine out.
//
// GIMBAL_PUBLIC_IP overrides the lookup (one or more addresses, separated by commas or spaces), for a host whose
// egress IP an echo service cannot see right (a NAT with several addresses, an IPv6 route to Orderly).

import { errorMessage } from '../venues/recorder.ts';

/** Echo services that answer with the caller's IP as plain text, asked in order until one gives an address. */
export const PUBLIC_IP_URLS: readonly string[] = ['https://api.ipify.org', 'https://checkip.amazonaws.com'];

/** The engine's public IPs (canonical form); rejects when they cannot be told. */
export type PublicIps = () => Promise<string[]>;

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * An IP in the canonical form the contract stores (Rust's `IpAddr` display: IPv4 without leading zeros, IPv6
 * lowercase and compressed as RFC 5952 says), or null when the text is not an IP. The URL parser does the IPv6 part.
 */
export function canonicalIp(text: string): string | null {
  const t = text.trim();
  if (V4.test(t)) return t;
  if (!/^[0-9A-Fa-f:.]+$/.test(t) || !t.includes(':')) return null;
  try {
    const host = new URL(`http://[${t}]/`).hostname;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/** The engine IPs a list leaves out, in canonical form. */
export function missingIps(list: readonly string[], engine: readonly string[]): string[] {
  const have = new Set(list.map((ip) => canonicalIp(ip) ?? ip));
  return engine.map((ip) => canonicalIp(ip) ?? ip).filter((ip) => !have.has(ip));
}

export interface PublicIpOptions {
  /** GIMBAL_PUBLIC_IP: used as it is, no lookup. Every entry must be an IP, or this throws at once. */
  override?: string | undefined;
  urls?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function publicIpLookup(o: PublicIpOptions = {}): PublicIps {
  const override = o.override?.trim() ?? '';
  if (override !== '') {
    const ips = override.split(/[\s,]+/).filter((ip) => ip !== '').map((ip) => {
      const c = canonicalIp(ip);
      if (c === null) throw new Error(`GIMBAL_PUBLIC_IP: "${ip}" is not an IP address`);
      return c;
    });
    return async () => ips;
  }
  const urls = o.urls ?? PUBLIC_IP_URLS;
  const fetchImpl = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  // Asked again at every use: the IP that matters is the one the engine has when the list is applied.
  return async () => {
    const tried: string[] = [];
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        const text = (await res.text()).trim();
        const ip = res.ok ? canonicalIp(text) : null;
        if (ip !== null) return [ip];
        tried.push(`${url}: ${res.ok ? `not an IP (${text.slice(0, 60)})` : `HTTP ${res.status}`}`);
      } catch (err) {
        tried.push(`${url}: ${errorMessage(err)}`);
      }
    }
    throw new Error(`the engine's public IP is unknown (${tried.join('; ') || 'no lookup URL'}); set GIMBAL_PUBLIC_IP to it`);
  };
}
