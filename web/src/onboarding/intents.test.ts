import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsdc, NEAR_USDC_ASSET, oneClick, ORIGINS, parseQuote, parseStatus, quoteBody, statusText, usdcUnits, type IntentsRequest } from './intents.ts';

const ARBITRUM = ORIGINS[0]!;
const REQUEST: IntentsRequest = {
  origin: ARBITRUM,
  amountUsdc: '100.5',
  refundTo: '0x1111111111111111111111111111111111111111',
  recipient: 'demo-owner.near',
  now: Date.UTC(2026, 9, 31, 12, 0, 0),
};

test('USDC amounts are read and written in whole units of 1e-6', () => {
  assert.equal(usdcUnits('100'), 100_000_000n);
  assert.equal(usdcUnits(' 250.5 '), 250_500_000n);
  assert.equal(usdcUnits('0.000001'), 1n);
  for (const bad of ['', '0', '0.0000001', '-5', '1e3', '1,000', 'abc', '1.']) assert.equal(usdcUnits(bad), null, bad);
  assert.equal(formatUsdc(250_500_000n), '250.5');
  assert.equal(formatUsdc(100_000_000n), '100');
  assert.equal(formatUsdc(1n), '0.000001');
});

test('the quote request is live, exact-input, to the owner’s NEAR account, with a refund address', () => {
  const body = quoteBody(REQUEST) as Record<string, unknown>;
  assert.equal(body.dry, false, 'a dry quote has no deposit address');
  assert.equal(body.swapType, 'EXACT_INPUT');
  assert.equal(body.originAsset, ARBITRUM.asset);
  assert.equal(body.destinationAsset, NEAR_USDC_ASSET);
  assert.equal(body.amount, '100500000');
  assert.equal(body.refundTo, REQUEST.refundTo);
  assert.equal(body.recipient, 'demo-owner.near');
  assert.equal(body.depositType, 'ORIGIN_CHAIN');
  assert.equal(body.recipientType, 'DESTINATION_CHAIN');
  assert.equal(body.deadline, '2026-10-31T12:30:00.000Z');
  assert.throws(() => quoteBody({ ...REQUEST, amountUsdc: 'x' }), /not a number of USDC/);
});

test('origin address checks', () => {
  assert.equal(ARBITRUM.isAddress('0x1111111111111111111111111111111111111111'), true);
  assert.equal(ARBITRUM.isAddress('0x123'), false);
  const solana = ORIGINS[1]!;
  assert.equal(solana.isAddress('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'), true);
  assert.equal(solana.isAddress('0x1111111111111111111111111111111111111111'), false);
});

test('a quote answer is read; a missing address or non-numeric amount is refused', () => {
  const answer = { quote: { depositAddress: '0xabc', amountIn: '100500000', minAmountOut: '100100000', timeEstimate: 30, deadline: '2026-10-31T12:30:00.000Z' } };
  assert.deepEqual(parseQuote(answer), { depositAddress: '0xabc', depositMemo: null, amountIn: '100500000', minAmountOut: '100100000', timeEstimateS: 30, deadline: '2026-10-31T12:30:00.000Z' });
  assert.equal(parseQuote({ quote: { ...answer.quote, depositMemo: '42' } }).depositMemo, '42');
  assert.throws(() => parseQuote({}), /no quote/);
  assert.throws(() => parseQuote({ quote: { ...answer.quote, depositAddress: '' } }), /depositAddress/);
  assert.throws(() => parseQuote({ quote: { ...answer.quote, amountIn: '1.5' } }), /whole numbers/);
});

test('every status has words, and only the last ones are final', () => {
  const all = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'] as const;
  for (const s of all) assert.ok(statusText(s).text.length > 10, s);
  assert.deepEqual(all.filter((s) => statusText(s).final), ['SUCCESS', 'REFUNDED', 'FAILED']);
  assert.equal(statusText('SUCCESS').tone, 'ok');
  assert.equal(statusText('REFUNDED').tone, 'bad');
  assert.equal(parseStatus({ status: 'PROCESSING' }), 'PROCESSING');
  assert.throws(() => parseStatus({ status: 'WEIRD' }), /unknown status/);
  assert.throws(() => parseStatus(null), /unknown status/);
});

test('the real client posts the quote and reads the status with the deposit address in the query', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return url.includes('/quote')
      ? ({ ok: true, status: 200, json: async () => ({ quote: { depositAddress: '0xabc', amountIn: '1', minAmountOut: '1' } }) } as Response)
      : ({ ok: true, status: 200, json: async () => ({ status: 'SUCCESS' }) } as Response);
  }) as typeof fetch;
  const client = oneClick('https://1click.test/v0', fetcher);
  assert.equal((await client.quote(REQUEST)).depositAddress, '0xabc');
  assert.equal(seen[0]!.url, 'https://1click.test/v0/quote');
  assert.equal(seen[0]!.init?.method, 'POST');
  assert.equal(await client.status('0xabc', null), 'SUCCESS');
  assert.equal(seen[1]!.url, 'https://1click.test/v0/status?depositAddress=0xabc');
  await client.status('0xabc', 'm 1');
  assert.equal(seen[2]!.url, 'https://1click.test/v0/status?depositAddress=0xabc&depositMemo=m+1');
});

test('a quote 1Click refuses is thrown with its message', async () => {
  const fetcher = (async () => ({ ok: false, status: 400, json: async () => ({ message: 'amount is too low' }) }) as Response) as typeof fetch;
  await assert.rejects(oneClick('u', fetcher).quote(REQUEST), /1Click refused the quote: amount is too low/);
  const noBody = (async () => ({ ok: false, status: 500, json: async () => { throw new Error('no json'); } }) as unknown as Response) as typeof fetch;
  await assert.rejects(oneClick('u', noBody).quote(REQUEST), /\(500\)/);
});
