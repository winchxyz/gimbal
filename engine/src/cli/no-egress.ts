// The hosted replay's engine makes no outbound connection: everything it shows comes from the recorded fixtures. This
// enforces it in the process instead of trusting every replay path to stay offline:
// - TCP and TLS (fetch, WebSocket, http.request and tls.connect all end in net.Socket#connect): a connect to a host
//   that is not this machine fails at once, before any DNS lookup; a loopback name that resolves elsewhere (a custom
//   `lookup`) is stopped when the lookup answers, before the connect starts, and checked again on connect;
// - DNS: dns.lookup and every resolver query (dns.resolve*, reverse, dns.promises, dns.Resolver) for a name that is
//   not this machine fail without asking any server;
// - UDP (dgram): send and connect to an address that is not loopback fail.
// Local IPC (a pipe path) and loopback are left alone. A refused socket that has no error listener gets a quiet one,
// so a trip never crashes the engine with an unhandled 'error'; every trip is logged with where it would have gone.

import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
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

type Emitter = { listenerCount(event: string): number; on(event: string, fn: (...a: unknown[]) => void): unknown };

/** Gives `target` a quiet error listener when it has none, so failing it cannot throw an unhandled 'error'. */
function quiet(target: Emitter): void {
  if (target.listenerCount('error') === 0) target.on('error', () => {});
}

const refusal = (what: string): Error =>
  Object.assign(new Error(`hosted replay: ${what} refused (the replay reads fixtures only)`), { code: 'ECONNREFUSED' });

/** Refuses every non-loopback connection, lookup and datagram from now on; the function returned undoes it (tests). */
export function refuseEgress(log: (line: string) => void): () => void {
  const undo: (() => void)[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const o = obj as Record<string, unknown>;
    const original = o[key];
    o[key] = value;
    undo.push(() => {
      o[key] = original;
    });
  };

  // TCP / TLS.
  const connect = net.Socket.prototype.connect as (...a: unknown[]) => net.Socket;
  patch(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    const host = target === null ? null : target.slice(0, target.lastIndexOf(':'));
    if (host !== null && !isLoopbackHost(host)) {
      const err = refusal(`outbound connection to ${target}`);
      log(err.message);
      // On the next tick, as a failed connect would: the caller attaches its listeners after connect() returns.
      process.nextTick(() => {
        quiet(this);
        this.destroy(err);
      });
      return this;
    }
    if (host !== null) {
      // An allowed name can still resolve elsewhere (a custom lookup). Destroyed inside the 'lookup' event, the socket
      // never connects: net checks for that right after emitting it.
      const check = (address: unknown) => {
        if (typeof address !== 'string' || address === '' || isLoopbackHost(address) || this.destroyed) return;
        const err = refusal(`outbound connection to ${address} (looked up for ${host})`);
        log(err.message);
        quiet(this);
        this.destroy(err);
      };
      this.on('lookup', (_err: unknown, address: unknown) => check(address));
      this.on('connectionAttempt', (address: unknown) => check(address));
      this.once('connect', () => check(this.remoteAddress));
    }
    return connect.apply(this, args);
  });

  // DNS: no query leaves for a name that is not this machine.
  const lookup = dns.lookup as (...a: unknown[]) => unknown;
  patch(dns, 'lookup', function (this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (typeof hostname === 'string' && isLoopbackHost(hostname)) return lookup.call(this, hostname, ...rest);
    const err = refusal(`DNS lookup of ${String(hostname)}`);
    log(err.message);
    const cb = rest.at(-1);
    if (typeof cb === 'function') process.nextTick(() => cb(err));
    return {};
  });
  const promiseLookup = dns.promises.lookup as (...a: unknown[]) => unknown;
  patch(dns.promises, 'lookup', function (this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (typeof hostname === 'string' && isLoopbackHost(hostname)) return promiseLookup.call(this, hostname, ...rest);
    const err = refusal(`DNS lookup of ${String(hostname)}`);
    log(err.message);
    return Promise.reject(err);
  });
  const queries = (obj: object): string[] => Object.getOwnPropertyNames(obj).filter((k) => /^(resolve|reverse)/.test(k));
  const refuseQueries = (owner: object, promised: boolean) => {
    for (const key of queries(owner)) {
      if (typeof (owner as Record<string, unknown>)[key] !== 'function') continue;
      patch(owner, key, function (name: unknown, ...rest: unknown[]) {
        const err = refusal(`DNS query ${key}(${String(name)})`);
        log(err.message);
        if (promised) return Promise.reject(err);
        const cb = rest.at(-1);
        if (typeof cb === 'function') process.nextTick(() => cb(err));
        return undefined;
      });
    }
  };
  refuseQueries(dns, false);
  refuseQueries(dns.promises, true);
  refuseQueries(dns.Resolver.prototype, false);
  refuseQueries(dns.promises.Resolver.prototype, true);

  // UDP: send(msg, [offset, length,] port, [address], [cb]) and connect(port, [address], [cb]); no address = loopback.
  const udp = (what: 'send' | 'connect') => {
    const original = dgram.Socket.prototype[what] as (...a: unknown[]) => unknown;
    patch(dgram.Socket.prototype, what, function (this: dgram.Socket, ...args: unknown[]): unknown {
      const address = args.slice(what === 'send' ? 1 : 0).find((a) => typeof a === 'string');
      if (address === undefined || isLoopbackHost(address as string)) return original.apply(this, args);
      const err = refusal(`UDP ${what} to ${String(address)}`);
      log(err.message);
      const cb = args.at(-1);
      process.nextTick(() => {
        if (typeof cb === 'function') return void cb(err);
        quiet(this);
        this.emit('error', err);
      });
      return undefined;
    });
  };
  udp('send');
  udp('connect');

  // `import { lookup } from 'node:dns'` in a module loaded later sees the patched functions too.
  syncBuiltinESMExports();
  return () => {
    for (const u of undo.reverse()) u();
    syncBuiltinESMExports();
  };
}
