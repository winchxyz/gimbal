// Venue health: a scan miss or a failed account read is down, a slow read or paused withdrawals (reported by the
// withdraw step, lapsing after a TTL) slow; 1Click's probe;
// changed() hands out a map only when something changed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOW_READ_MS, VenueHealth, WITHDRAWALS_PAUSED_TTL_MS, probeIntents } from './venue-health.ts';

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

test('the pair start\'s word: Phoenix slow while its snapshot lags, NEAR down while the signing client fails; ok once confirmed', () => {
  const h = new VenueHealth();
  h.changed();
  h.pairStart('phoenix', 'slow', 'the trader snapshot is at slot 100, still before slot 120');
  h.pairStart('near', 'down', 'near rpc: 503');
  h.readOk('phoenix', 200);
  assert.deepEqual(h.changed(), { intents: 'ok', near: 'down', hyperliquid: 'ok', phoenix: 'slow', orderly: 'ok' }, 'the worse of the account read and the start');
  assert.equal(h.detail('phoenix').status, 'slow');
  assert.equal(h.detail('phoenix').start, 'the trader snapshot is at slot 100, still before slot 120');
  assert.equal(h.nearDetail, 'near rpc: 503');
  h.pairStart('phoenix', 'down', 'getSlot: fetch failed');
  assert.equal(h.map().phoenix, 'down');
  for (const k of ['hyperliquid', 'phoenix', 'near'] as const) h.pairStart(k, 'ok');
  assert.deepEqual(h.changed(), { intents: 'ok', near: 'ok', hyperliquid: 'ok', phoenix: 'ok', orderly: 'ok' });
  assert.equal(h.detail('phoenix').start, null);
  assert.equal(h.nearDetail, null);
});

test('withdrawals paused: the venue still answers, so slow (it cannot be a rescue source); a withdraw that goes through clears it', () => {
  let t = 0;
  const h = new VenueHealth({ now: () => t });
  // A failed read is down whatever its words: nothing guesses "paused" from an error message any more.
  h.readFailed('hyperliquid', new Error('Withdrawals are temporarily paused'));
  assert.equal(h.map().hyperliquid, 'down');
  assert.equal(h.detail('hyperliquid').withdrawalsPaused, null);
  h.readOk('hyperliquid', 100);
  // The withdraw step reports what the venue said, and clears it once a withdraw goes through.
  h.withdrawals('hyperliquid', 'Withdrawals are temporarily paused');
  assert.equal(h.map().hyperliquid, 'slow');
  assert.equal(h.detail('hyperliquid').withdrawalsPaused, 'Withdrawals are temporarily paused');
  h.withdrawals('hyperliquid', null);
  assert.equal(h.map().hyperliquid, 'ok');
});

test('a withdrawals-paused report with no news lapses after its TTL; a fresh report restarts it', () => {
  let t = 0;
  const h = new VenueHealth({ now: () => t });
  h.withdrawals('phoenix', 'withdrawals suspended');
  t += WITHDRAWALS_PAUSED_TTL_MS - 1;
  assert.equal(h.map().phoenix, 'slow');
  h.withdrawals('phoenix', 'withdrawals suspended');      // reported again: counts from now
  t += WITHDRAWALS_PAUSED_TTL_MS - 1;
  assert.equal(h.detail('phoenix').status, 'slow');
  t += 1;
  assert.equal(h.map().phoenix, 'ok');
  assert.equal(h.detail('phoenix').withdrawalsPaused, null);
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
