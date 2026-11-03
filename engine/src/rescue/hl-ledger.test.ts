// A Hyperliquid landing is the delivery in the desk's ledger, not a change of account value: the incoming entry to
// the desk since the transfer began, of at least minAmountOut, sent by someone else, matched once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VerifiedQuote } from './oneclick.ts';
import type { HlLedgerRow } from './hl-ledger.ts';
import { HlLedgerLanding, LEDGER_SLACK_MS, hlDelivery } from './hl-ledger.ts';

const DESK = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';
const SINCE = 1_800_000_000_000;
const row = (hash: string, time: number, delta: HlLedgerRow['delta']): HlLedgerRow => ({ hash, time, delta });

const rows: HlLedgerRow[] = [
  row('0xold', SINCE - LEDGER_SLACK_MS - 1, { type: 'send', usdc: '20.0', destination: DESK, user: '0xsolver' }),
  row('0xmine', SINCE + 1, { type: 'send', usdc: '20.0', destination: '0xelse', user: DESK }),
  row('0xsmall', SINCE + 2, { type: 'send', usdc: '19.48', destination: DESK, user: '0xsolver' }),
  row('0xwithdraw', SINCE + 3, { type: 'withdraw', usdc: '25.0' }),
  row('0xit', SINCE + 4, { type: 'send', usdc: '19.6808', destination: DESK.toUpperCase().replace('0X', '0x'), user: '0xsolver' }),
  row('0xbridge', SINCE + 5, { type: 'deposit', usdc: '30.0' }),
];

test('the delivery: incoming, to the desk, since the transfer, at least minAmountOut, not sent by the desk, once', () => {
  const minOutE8 = 1_948_095_100n;   // the recorded fund_venue quote's 19.480951
  assert.deepEqual(hlDelivery(rows, { desk: DESK, sinceMs: SINCE, minOutE8, seen: new Set() }), { hash: '0xit', usdE8: 1_968_080_000n });
  // Matched once: a second transfer of the same size finds the next entry, not this one.
  assert.equal(hlDelivery(rows, { desk: DESK, sinceMs: SINCE, minOutE8, seen: new Set(['0xit']) })?.hash, '0xbridge');
  assert.equal(hlDelivery(rows, { desk: DESK, sinceMs: SINCE, minOutE8: 4_000_000_000n, seen: new Set() }), null);
});

test('HlLedgerLanding reads userNonFundingLedgerUpdates and confirms only Hyperliquid', async () => {
  const asked: unknown[] = [];
  const landing = new HlLedgerLanding({
    network: 'mainnet', desk: async () => DESK, others: { orderly: 'no Orderly ledger here' },
    fetch: (async (_url: string, init: { body: string }) => {
      asked.push(JSON.parse(init.body));
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(landing.confirms('hyperliquid'), null);
  assert.equal(landing.confirms('orderly'), 'no Orderly ledger here');
  assert.match(landing.confirms('phoenix')!, /cannot be confirmed/);
  const q = { minAmountOutE8: 1_948_095_100n } as VerifiedQuote;
  const hit = await landing.find('hyperliquid', q, SINCE, new Set());
  assert.deepEqual(hit, { id: '0xit', usd: 19.6808, tx: [{ chain: 'hyperliquid', id: '0xit', url: 'https://app.hyperliquid.xyz/explorer/tx/0xit' }] });
  assert.deepEqual(asked, [{ type: 'userNonFundingLedgerUpdates', user: DESK, startTime: SINCE - LEDGER_SLACK_MS }]);
  assert.equal(await landing.find('orderly', q, SINCE, new Set()), null);
});
