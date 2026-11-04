// pair-mainnet refuse-band / refuse-notional on fakes: the orders the contract must refuse (checked with its own
// arithmetic), a dry run that signs and refreshes nothing, --send reporting the refusal with its nearblocks link (through
// the real NearContractClient over a fake chain), a stale price refreshed first and one NEAR call at a time, and an
// unexpected signature printed loudly and never forwarded anywhere.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import { YOCTO_PER_NEAR } from '../contract/budget.ts';
import type { NearCallOutcome, NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { toQty } from '../trade/lots.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { newPriceState, refreshLanded } from './pair-mainnet-lib.ts';
import { storedPrice } from './pair-ops.ts';
import type { RefusalKind } from './refuse-lib.ts';
import { EXIT_OTHER_REFUSAL, EXIT_REFUSED, EXIT_SIGNED, deskRefusal, insideBand, notionalE16, refusalOrder, refuse } from './refuse-lib.ts';

const ETH = { index: 1, symbol: 'ETH', sz_decimals: 4 };
const CLOID = `0x${'ab'.repeat(16)}`;
const SECP = { scheme: 'Secp256k1', big_r: { affine_point: `02${'11'.repeat(32)}` }, s: { scalar: '22'.repeat(32) }, recovery_id: 0 };
const panicked = (text: string): NearCallOutcome => ({ txHash: '', ok: false, failure: `{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}` });

function policy(over: Partial<ContractPolicy> = {}): ContractPolicy {
  return {
    hl_assets: [ETH, { index: 0, symbol: 'BTC', sz_decimals: 5 }], phoenix_markets: [], orderly_symbols: [],
    max_notional_usd: 20, price_band_bps: 100, oracle_max_age_s: 900, rescue_cap_usd_per_hour: 0,
    unpriced: [{ symbol: 'BTC', max_sz: '0.001' }], unpriced_max_notional_usd: 10, max_transfer_cost_bps: 0, max_transfer_cost_flat_e6: 0,
    ...over,
  };
}

/** A chain with one stored ETH price; each call answers from `answer`, or as the contract would refuse the order. */
class Chain implements NearTransport {
  readonly accountId = 'operator.near';
  calls: string[] = [];
  /** How many calls are on the chain at once, at most. */
  peak = 0;
  #open = 0;
  pxE8 = 250_000_000_000;
  atMs = Date.now() - 400_000;
  answer: (method: string, args: Record<string, unknown>) => NearCallOutcome = (method) =>
    method === 'refresh_prices' ? { txHash: '', ok: true, value: true } : panicked('E_PRICE_BAND: px 2550 is 2% from oracle 2500, outside price_band_bps 100');

  async call(_contract: string, method: string, args: object): Promise<NearCallOutcome> {
    this.calls.push(method);
    this.#open++;
    this.peak = Math.max(this.peak, this.#open);
    await new Promise((r) => setImmediate(r));
    this.#open--;
    if (method === 'refresh_prices') this.atMs = Date.now() - 1000;
    return { ...this.answer(method, args as Record<string, unknown>), txHash: `hash${this.calls.length}` };
  }
  async view<T>(_contract: string, method: string): Promise<T> {
    if (method !== 'prices') throw new Error(`no view ${method}`);
    return [{ asset: 'ETH', price_e8: this.pxE8, at_ms: this.atMs }] as T;
  }
  async account() {
    return { amount: 5n * YOCTO_PER_NEAR, locked: 0n, storageUsage: 0 };
  }
  async allowance() {
    return null;
  }
}

function deps(chain: Chain, kind: RefusalKind, send: boolean, over: { ask?: number; policy?: Partial<ContractPolicy>; paused?: boolean } = {}) {
  const client = new NearContractClient({ contractId: 'gimbal.near', network: 'mainnet', transport: chain, sleep: async () => {} });
  const lines: string[] = [];
  const say = (line = '') => lines.push(line);
  const p = policy(over.policy);
  const prices: PriceDeps = {
    maxAgeS: p.oracle_max_age_s, send, read: (s) => storedPrice(client, s), refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }),
    now: () => Date.now(), log: say, landed: refreshLanded, ...newPriceState(),
  };
  return {
    lines,
    d: {
      kind, symbol: 'ETH', send, deskId: 'carry', desk: { paused: over.paused ?? false, closing: false, policy: p }, client, prices,
      bestAsk: async () => over.ask ?? 2501, say, cloid: CLOID,
    },
  };
}

// Nothing in these tests may reach a network: a fetch would be a venue post (or a leak out of the fakes).
let fetches = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error('no network in tests');
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the band order is outside the band and within the cap; the notional order is inside the band and over the cap', () => {
  const band = refusalOrder({ kind: 'band', asset: ETH, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 20 }, CLOID);
  assert.deepEqual(band.order, { asset: 1, is_buy: true, px: '2550', sz: '0.0044', reduce_only: false, tif: 'Alo', cloid: CLOID });
  assert.equal(insideBand(band.pxE8, band.oracleE8, 100), false);
  assert.ok(notionalE16(band.pxE8, band.szE8, band.oracleE8) <= 20n * 10n ** 16n);
  assert.equal(Math.round(band.distanceBps), 200, 'twice the band');

  const cap = refusalOrder({ kind: 'notional', asset: ETH, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 20 }, CLOID);
  assert.deepEqual([cap.order.px, cap.order.sz, cap.order.tif, cap.order.reduce_only], ['2522.5', '0.0159', 'Alo', false]);
  assert.equal(insideBand(cap.pxE8, cap.oracleE8, 100), true);
  assert.ok(notionalE16(cap.pxE8, cap.szE8, cap.oracleE8) > 20n * 10n ** 16n);

  // The contract's edges: exactly the band is inside, one tick past it is not.
  assert.equal(insideBand(toQty('2525'), toQty('2500'), 100), true);
  assert.equal(insideBand(toQty('2525.1'), toQty('2500'), 100), false);
  // A cap too small for one lot leaves no band-only order.
  assert.throws(() => refusalOrder({ kind: 'band', asset: { ...ETH, sz_decimals: 1 }, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 1 }), /no order fits/);
});

test('a desk or symbol where another check would refuse first is refused before anything is read or sent', async () => {
  const p = policy();
  assert.match(deskRefusal({ symbol: 'ETH', desk: { paused: true, policy: p } }) ?? '', /E_PAUSED/);
  assert.match(deskRefusal({ symbol: 'BTC', desk: { paused: false, policy: p } }) ?? '', /unpriced/);
  assert.match(deskRefusal({ symbol: 'SOL', desk: { paused: false, policy: p } }) ?? '', /E_ASSET/);
  assert.equal(deskRefusal({ symbol: 'ETH', desk: { paused: false, policy: p } }), null);
  const chain = new Chain();
  await assert.rejects(refuse(deps(chain, 'band', true, { paused: true }).d), /E_PAUSED/);
  assert.deepEqual(chain.calls, []);
});

test('the dry run prints the order, the price and its age, the band and the refusal, and signs or refreshes nothing', async () => {
  const chain = new Chain();
  chain.atMs = Date.now() - 2_000_000;        // stale: --send would refresh it, the dry run only says so
  const { d, lines } = deps(chain, 'band', false);
  assert.equal(await refuse(d), EXIT_REFUSED);
  assert.deepEqual(chain.calls, [], 'no NEAR call at all');
  assert.equal(fetches, 0);
  const out = lines.join('\n');
  assert.match(out, /price_band_bps 100, max_notional_usd 20/);
  assert.match(out, /stale for this .* --send runs refresh_prices first/);
  assert.match(out, /BUY 0\.0044 at 2550, post-only \(Alo\)/);
  assert.match(out, /expected E_PRICE_BAND: px 2550 is 200\.0 bps above 2500, outside price_band_bps 100/);
  assert.match(out, /best ask 2501: px 2550 is above it/);
  assert.match(out, /cost .*0\.001 NEAR/);
  assert.match(out, /dry run: nothing was signed or sent/);

  // No stored price at all: the dry run still shows the order, against the ask as a stand-in.
  const none = new Chain();
  none.view = async <T>() => [] as T;
  const n = deps(none, 'band', false, { ask: 2500 });
  assert.equal(await refuse(n.d), EXIT_REFUSED);
  assert.deepEqual(none.calls, []);
  const noneOut = n.lines.join('\n');
  assert.match(noneOut, /none stored; the order below is priced against Hyperliquid's ask 2500 as a stand-in/);
  assert.match(noneOut, /BUY 0\.0044 at 2550/);
});

test('--send refreshes a stale price first, then sends hl_order once and reports the refusal with its nearblocks link', async () => {
  const chain = new Chain();
  chain.atMs = Date.now() - 2_000_000;
  const { d, lines } = deps(chain, 'band', true);
  assert.equal(await refuse(d), EXIT_REFUSED);
  assert.deepEqual(chain.calls, ['refresh_prices', 'hl_order'], 'the refresh lands before the order is priced and sent');
  assert.equal(chain.peak, 1, 'one NEAR call at a time');
  assert.equal(fetches, 0);
  const out = lines.join('\n');
  assert.match(out, /refused {3}as expected: nothing was signed/);
  assert.match(out, /https:\/\/nearblocks\.io\/txns\/hash2/);
  assert.match(out, /error {5}E_PRICE_BAND: px 2550 is 2% from oracle 2500, outside price_band_bps 100/);
});

test('--send with a fresh price sends only hl_order; a refusal for another reason is reported as not expected', async () => {
  const chain = new Chain();
  chain.answer = () => panicked('E_SIZE: ETH 2522.5 x 0.0159 = 40.10775 USD is over max_notional_usd 20');
  const { d, lines } = deps(chain, 'notional', true);
  assert.equal(await refuse(d), EXIT_REFUSED, 'the notional refusal is the expected one for refuse-notional');
  assert.deepEqual(chain.calls, ['hl_order']);
  assert.match(lines.join('\n'), /nearblocks\.io\/txns\/hash1/);

  const other = new Chain();
  other.answer = () => panicked('E_ORACLE_STALE: no oracle price for ETH younger than 900 s');
  const o = deps(other, 'band', true);
  assert.equal(await refuse(o.d), EXIT_OTHER_REFUSAL);
  assert.match(o.lines.join('\n'), /NOT as expected \(wanted E_PRICE_BAND\)/);
});

test('an order that would not cross the ask is not sent', async () => {
  const chain = new Chain();
  await assert.rejects(refuse(deps(chain, 'band', true, { ask: 2600 }).d), /not above the best ask/);
  assert.deepEqual(chain.calls, []);
  const dry = deps(new Chain(), 'band', false, { ask: 2600 });
  assert.equal(await refuse(dry.d), EXIT_OTHER_REFUSAL);
  assert.match(dry.lines.join('\n'), /would refuse at --send: the price is not above the best ask/);
});

test('a signature the contract returns unexpectedly is printed loudly and never forwarded', async () => {
  const chain = new Chain();
  chain.answer = (method, args) => ({
    txHash: '', ok: true,
    value: { desk_id: args.desk_id, request_id: 9, venue: 'hyperliquid', kind: method, payload: { action: { type: 'order' }, nonce: 1, vaultAddress: null }, signature: SECP },
  });
  const { d, lines } = deps(chain, 'band', true);
  assert.equal(await refuse(d), EXIT_SIGNED);
  assert.deepEqual(chain.calls, ['hl_order'], 'nothing after the signature');
  assert.equal(fetches, 0, 'no venue post');
  const out = lines.join('\n');
  assert.match(out, /WARNING {3}THE CONTRACT SIGNED AN ORDER IT SHOULD HAVE REFUSED/);
  assert.match(out, /NOT forwarded/);
  assert.match(out, /nearblocks\.io\/txns\/hash1/);
});
