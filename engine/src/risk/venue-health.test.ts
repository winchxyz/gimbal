// Venue health: a scan miss or a failed account read is down, a slow read or paused withdrawals slow; 1Click's probe;
// changed() hands out a map only when something changed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOW_READ_MS, VenueHealth, probeIntents, saysWithdrawalsPaused } from './venue-health.ts';

test('a scan miss or a failed read is down, a slow read slow; each clears when the venue answers again', () => {
  const h = new VenueHealth();
  assert.deepEqual(h.changed(), { intents: 'ok', near: 'ok', hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok' });
  assert.equal(h.changed(), null, 'nothing changed');
  h.scan({ venues: 3, failed: ['orderly', 'pacifica'], at: 1 });
  h.readFailed('phoenix', new Error('fetch failed: ECONNRESET'));
  h.readOk('hyperliquid', SLOW_READ_MS + 1);
  assert.deepEqual(h.changed(), { intents: 'ok', near: 'ok', hyperliquid: 'slow', phoenix: 'down', orderly: 'down' });
  assert.equal(h.detail('phoenix').readError, 'fetch failed: ECONNRESET');
  h.scan({ venues: 3, failed: [], at: 2 });
  h.readOk('phoenix', 200);
  h.readOk('hyperliquid', 300);
  assert.deepEqual(h.changed(), { intents: 'ok', near: 'ok', hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok' });
});

test('withdrawals paused: the venue still answers, so slow (it cannot be a rescue source), with its words in detail', () => {
  assert.ok(saysWithdrawalsPaused('Withdrawals are temporarily paused for maintenance'));
  assert.ok(saysWithdrawalsPaused('withdraw disabled'));
  assert.ok(saysWithdrawalsPaused('Deposits and withdrawals suspended'));
  assert.ok(!saysWithdrawalsPaused('Insufficient USDC balance for token transfer gas'));
  assert.ok(!saysWithdrawalsPaused('rate limited, retry later'));
  const h = new VenueHealth();
  h.readFailed('hyperliquid', new Error('Withdrawals are temporarily paused'));
  assert.equal(h.map().hyperliquid, 'slow');
  assert.equal(h.detail('hyperliquid').withdrawalsPaused, 'Withdrawals are temporarily paused');
  assert.equal(h.detail('hyperliquid').readError, null);
  h.withdrawals('hyperliquid', null);
  assert.equal(h.map().hyperliquid, 'ok');
});

test('1Click and NEAR come in as given; the 1Click probe is down on an error or a non-2xx, slow over 5 s', async () => {
  const h = new VenueHealth();
  h.intents('down', '1Click /tokens answered 503');
  h.near('slow');
  assert.deepEqual(h.map(), { intents: 'down', near: 'slow', hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok' });
  assert.equal(h.intentsDetail, '1Click /tokens answered 503');

  let t = 0;
  const answer = (status: number, ms: number): typeof fetch => (async (url: string | URL | Request) => {
    assert.equal(String(url), 'https://1click.chaindefuser.com/v0/tokens');
    t += ms;
    return new Response('[]', { status });
  }) as typeof fetch;
  assert.equal((await probeIntents({ fetch: answer(200, 300), now: () => t })).status, 'ok');
  assert.deepEqual(await probeIntents({ fetch: answer(200, 6_000), now: () => t }), { status: 'slow', detail: '1Click /tokens took 6000 ms' });
  assert.deepEqual(await probeIntents({ fetch: answer(503, 10), now: () => t }), { status: 'down', detail: '1Click /tokens answered 503' });
  const broken = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch;
  assert.deepEqual(await probeIntents({ fetch: broken }), { status: 'down', detail: '1Click /tokens: getaddrinfo ENOTFOUND' });
});
