import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HL_INFO, hyperliquidData, parseMeta, parseMids } from './marks.ts';

test('allMids keeps symbols with a positive price and drops the rest', () => {
  const mids = parseMids({ BTC: '64000.5', kPEPE: '0.0075', JUNK: 'abc', ZERO: '0', '@12': '3' });
  assert.equal(mids.get('BTC'), 64000.5);
  assert.equal(mids.get('kPEPE'), 0.0075);
  assert.equal(mids.has('JUNK'), false);
  assert.equal(mids.has('ZERO'), false);
  assert.throws(() => parseMids([]), /not an object/);
});

test('meta: the position in the universe is the asset index; delisted assets are left out', () => {
  const assets = parseMeta({ universe: [{ name: 'BTC', szDecimals: 5 }, { name: 'OLD', szDecimals: 1, isDelisted: true }, { name: 'ETH', szDecimals: 4 }, { bad: true }] });
  assert.deepEqual(assets, [
    { index: 0, symbol: 'BTC', sz_decimals: 5 },
    { index: 2, symbol: 'ETH', sz_decimals: 4 },
  ]);
  assert.throws(() => parseMeta({}), /no universe/);
});

test('the exchange’s public data is read per network and cached for a few seconds', async () => {
  let clock = 1_000;
  const asked: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({ url, body });
    return { ok: true, status: 200, json: async () => (body.type === 'allMids' ? { BTC: '64000' } : { universe: [{ name: 'BTC', szDecimals: 5 }] }) } as Response;
  }) as typeof fetch;
  const data = hyperliquidData('testnet', fetcher, () => clock, 10_000);
  assert.equal(await data.mark('BTC'), 64000);
  assert.equal(await data.mark('NOPE'), null);
  assert.equal(asked.length, 1, 'the second mark came from the cache');
  assert.equal(asked[0]!.url, HL_INFO.testnet);
  clock += 11_000;
  await data.mark('BTC');
  assert.equal(asked.length, 2);
  assert.deepEqual(await data.hlAssets(), [{ index: 0, symbol: 'BTC', sz_decimals: 5 }]);
  assert.notEqual(HL_INFO.mainnet, HL_INFO.testnet);
});

test('an exchange that answers with an error rejects, so the form can fall back to typing', async () => {
  const fetcher = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
  await assert.rejects(hyperliquidData('mainnet', fetcher).mark('BTC'), /allMids: 503/);
});
