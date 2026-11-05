// The hosted replay's engine connects to nothing but this machine: fetch, http and raw TCP to another host fail at
// once, loopback still works.

import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { test } from 'node:test';
import { connectTarget, isLoopbackHost, refuseEgress } from './no-egress.ts';

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
