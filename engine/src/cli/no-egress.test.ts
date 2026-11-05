// The hosted replay's engine connects to nothing but this machine: fetch, http, raw TCP, DNS and UDP to another host
// fail at once, loopback still works, and no refusal can crash the process.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { test } from 'node:test';
import { connectTarget, isLoopbackHost, refuseEgress } from './no-egress.ts';

/** Reads the named import when called, so it sees whatever the binding holds then. */
const dnsLookup = (host: string): Promise<unknown> => promisify(dnsLookupCb)(host);

test('connect targets and loopback names', () => {
  assert.equal(connectTarget([{ host: 'api.hyperliquid.xyz', port: 443 }]), 'api.hyperliquid.xyz:443');
  assert.equal(connectTarget([[{ host: '1.2.3.4', port: 80 }, () => {}]]), '1.2.3.4:80');
  assert.equal(connectTarget([8790, '127.0.0.1']), '127.0.0.1:8790');
  assert.equal(connectTarget([8790]), 'localhost:8790');
  assert.equal(connectTarget([{ path: '/tmp/s.sock' }]), null);
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['example.com', '10.0.0.1', '0.0.0.0', '::', '128.0.0.1']) assert.ok(!isLoopbackHost(h), h);
});

test('every outbound connection is refused before DNS; loopback is not', async () => {
  const lines: string[] = [];
  const restore = refuseEgress((l) => lines.push(l));
  const server = createServer((_req, res) => res.end('local'));
  try {
    await assert.rejects(fetch('https://api.hyperliquid.xyz/info', { signal: AbortSignal.timeout(5_000) }));
    const tcp = await new Promise<string>((done) => {
      const s = connect({ host: '203.0.113.7', port: 443 });
      s.on('error', (err) => done(err.message));
      s.on('connect', () => done('connected'));
    });
    assert.match(tcp, /outbound connection to 203\.0\.113\.7:443 refused/);
    assert.ok(lines.some((l) => l.includes('api.hyperliquid.xyz:443')), lines.join('\n'));

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'local');
    const viaHttp = await new Promise<string>((done, bad) => {
      get({ host: 'localhost', port, family: 4 }, (res) => {
        let t = '';
        res.on('data', (c: Buffer) => (t += c.toString()));
        res.on('end', () => done(t));
      }).on('error', bad);
    });
    assert.equal(viaHttp, 'local');
  } finally {
    restore();
    server.close();
  }
});

test('a loopback name whose lookup answers another address never connects', async () => {
  const lines: string[] = [];
  const restore = refuseEgress((l) => lines.push(l));
  const server = createServer((_req, res) => res.end('local'));
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    // A custom lookup sends "localhost" to a documentation address (RFC 5737): stopped at the lookup.
    const elsewhere = (_h: string, opts: unknown, cb: (e: null, a: string | { address: string; family: number }[], f?: number) => void) =>
      (opts as { all?: boolean }).all === true ? cb(null, [{ address: '203.0.113.9', family: 4 }]) : cb(null, '203.0.113.9', 4);
    const outcome = await new Promise<string>((done) => {
      const s = connect({ host: 'localhost', port, lookup: elsewhere as never });
      s.on('error', (err) => done(err.message));
      s.on('connect', () => done('connected'));
    });
    assert.match(outcome, /outbound connection to 203\.0\.113\.9 \(looked up for localhost\) refused/);
    // The same lookup answering loopback still connects.
    const local = (_h: string, opts: unknown, cb: (e: null, a: string | { address: string; family: number }[], f?: number) => void) =>
      (opts as { all?: boolean }).all === true ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
    const ok = await new Promise<string>((done) => {
      const s = connect({ host: 'localhost', port, lookup: local as never });
      s.on('error', (err) => done(err.message));
      s.on('connect', () => {
        s.destroy();
        done('connected');
      });
    });
    assert.equal(ok, 'connected');
  } finally {
    restore();
    server.close();
  }
});

test('a refused socket with no error listener does not crash the process', async () => {
  const restore = refuseEgress(() => {});
  const crashed: unknown[] = [];
  const onCrash = (err: unknown) => crashed.push(err);
  process.on('uncaughtException', onCrash);
  try {
    const s = connect({ host: '203.0.113.8', port: 443 });
    await new Promise<void>((r) => s.once('close', () => r()));
    assert.equal(s.destroyed, true);
    const elsewhere = (_h: string, opts: unknown, cb: (e: null, a: string | { address: string; family: number }[], f?: number) => void) =>
      (opts as { all?: boolean }).all === true ? cb(null, [{ address: '203.0.113.9', family: 4 }]) : cb(null, '203.0.113.9', 4);
    const t = connect({ host: 'localhost', port: 9, lookup: elsewhere as never });
    await new Promise<void>((r) => t.once('close', () => r()));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(crashed, []);
  } finally {
    process.off('uncaughtException', onCrash);
    restore();
  }
});

test('DNS lookups and resolver queries for other names fail without asking a server; UDP out is refused', async () => {
  const lines: string[] = [];
  const restore = refuseEgress((l) => lines.push(l));
  try {
    const viaCallback = await new Promise<string>((done) => dns.lookup('api.hyperliquid.xyz', (err) => done(err?.message ?? 'resolved')));
    assert.match(viaCallback, /DNS lookup of api\.hyperliquid\.xyz refused/);
    await assert.rejects(dns.promises.lookup('rpc.mainnet.near.org'), /DNS lookup of rpc\.mainnet\.near\.org refused/);
    await assert.rejects(dnsLookup('example.com'), /refused/, 'a named import made after the patch is patched too');
    const resolved = await new Promise<string>((done) => dns.resolve4('example.com', (err) => done(err?.message ?? 'resolved')));
    assert.match(resolved, /DNS query resolve4\(example\.com\) refused/);
    await assert.rejects(dns.promises.resolveTxt('example.com'), /refused/);
    await assert.rejects(new dns.promises.Resolver().resolve4('example.com'), /refused/);
    assert.equal((await dns.promises.lookup('localhost', { family: 4 })).address.startsWith('127.'), true);
    // Reverse lookups of an address that is not this machine: refused; loopback goes to the system as before.
    const service = await new Promise<string>((done) => dns.lookupService('203.0.113.5', 443, (err) => done(err?.message ?? 'resolved')));
    assert.match(service, /DNS lookupService of 203\.0\.113\.5 refused/);
    await assert.rejects(dns.promises.lookupService('8.8.8.8', 53), /DNS lookupService of 8\.8\.8\.8 refused/);
    const local = await dns.promises.lookupService('127.0.0.1', 80).then(() => 'answered', (err: Error) => err.message);
    assert.doesNotMatch(local, /refused/);

    const sock = dgram.createSocket('udp4');
    const sent = await new Promise<string>((done) => sock.send('x', 53, '8.8.8.8', (err) => done(err?.message ?? 'sent')));
    assert.match(sent, /UDP send to 8\.8\.8\.8 refused/);
    // No callback, no error listener: the refusal must not crash.
    sock.send('x', 53, '8.8.4.4');
    await new Promise((r) => setTimeout(r, 20));
    sock.close();
    assert.ok(lines.some((l) => l.includes('8.8.4.4')), lines.join('\n'));
  } finally {
    restore();
  }
});
