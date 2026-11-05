// The hosted replay's engine makes no outbound connection: everything it shows comes from the recorded fixtures. This
// enforces it in the process instead of trusting every replay path to stay offline: a TCP or TLS connect to any host
// but this machine (fetch, WebSocket, http.request and tls.connect all end in net.Socket#connect) fails at once, before
// any DNS lookup, with a line saying where it would have gone. Local IPC (a pipe path) and loopback are left alone.

import net from 'node:net';

/** localhost, 127.0.0.0/8 and ::1 (with or without brackets, IPv4-mapped too). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Where a Socket#connect call goes, as `host:port`, or null for an IPC path. Covers connect(options), connect(port,
 * host) and the normalized [options, callback] array that net.connect and tls.connect pass.
 */
export function connectTarget(args: readonly unknown[]): string | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === 'string') return null;
    return `${typeof o.host === 'string' ? o.host : 'localhost'}:${String(o.port)}`;
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`;
}

/** Refuses every non-loopback connect from now on; the function returned puts the original back (tests). */
export function refuseEgress(log: (line: string) => void): () => void {
  const original = net.Socket.prototype.connect;
  const patched = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    const host = target === null ? null : target.slice(0, target.lastIndexOf(':'));
    if (host !== null && !isLoopbackHost(host)) {
      const message = `hosted replay: outbound connection to ${target} refused (the replay reads fixtures only)`;
      log(message);
      process.nextTick(() => this.destroy(new Error(message)));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  };
  net.Socket.prototype.connect = patched as typeof original;
  return () => {
    net.Socket.prototype.connect = original;
  };
}
