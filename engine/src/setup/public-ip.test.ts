import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIp, missingIps, publicIpLookup } from './public-ip.ts';

const answer = (status: number, text: string) => new Response(text, { status });

test('canonicalIp: IPv4 as it is, IPv6 lowercase and compressed, anything else null', () => {
  assert.equal(canonicalIp(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(canonicalIp('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalIp('2001:db8::1'), '2001:db8::1');
  for (const bad of ['203.0.113', '203.0.113.07', '999.1.1.1', 'localhost', '', '2001:db8::1::2', '<html>']) assert.equal(canonicalIp(bad), null, bad);
});

test('missingIps: the engine IPs a list leaves out', () => {
  assert.deepEqual(missingIps(['203.0.113.7'], ['203.0.113.7']), []);
  assert.deepEqual(missingIps(['203.0.113.7'], ['198.51.100.4']), ['198.51.100.4']);
  assert.deepEqual(missingIps(['2001:db8::1', '203.0.113.7'], ['2001:0db8::0001', '198.51.100.4']), ['198.51.100.4']);
});

test('GIMBAL_PUBLIC_IP overrides the lookup and asks nothing; a bad entry throws at once', async () => {
  const ips = publicIpLookup({ override: '203.0.113.7, 2001:DB8::1', fetch: async () => assert.fail('no lookup with an override') });
  assert.deepEqual(await ips(), ['203.0.113.7', '2001:db8::1']);
  assert.throws(() => publicIpLookup({ override: '203.0.113.7,nope' }), /GIMBAL_PUBLIC_IP: "nope" is not an IP address/);
});

test('the lookup takes the first service that answers with an IP', async () => {
  const asked: string[] = [];
  const ips = publicIpLookup({
    urls: ['https://a.example', 'https://b.example', 'https://c.example'],
    fetch: (async (url: string) => {
      asked.push(url);
      if (url === 'https://a.example') return answer(503, 'busy');
      return answer(200, url === 'https://b.example' ? '198.51.100.4\n' : '203.0.113.9');
    }) as typeof fetch,
  });
  assert.deepEqual(await ips(), ['198.51.100.4']);
  assert.deepEqual(asked, ['https://a.example', 'https://b.example']);
});

test('the lookup refuses when no service gives an IP, naming what each said', async () => {
  const ips = publicIpLookup({
    urls: ['https://a.example', 'https://b.example'],
    fetch: (async (url: string) => {
      if (url === 'https://a.example') throw new Error('getaddrinfo ENOTFOUND');
      return answer(200, '<html>captive portal</html>');
    }) as typeof fetch,
  });
  await assert.rejects(ips(), (err: Error) => {
    assert.match(err.message, /public IP is unknown/);
    assert.match(err.message, /a\.example: getaddrinfo ENOTFOUND/);
    assert.match(err.message, /b\.example: not an IP/);
    assert.match(err.message, /set GIMBAL_PUBLIC_IP/);
    return true;
  });
});
