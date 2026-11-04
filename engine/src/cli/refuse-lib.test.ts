// pair-mainnet refuse-band / refuse-notional and cancel-hl on fakes: the orders the contract must refuse (checked with
// its own arithmetic), a dry run that signs and refreshes nothing, --send reporting the refusal with its nearblocks
// link (through the real NearContractClient over a fake chain), a stale price refreshed first and one NEAR call at a
// time, the ask margin read twice, the key's room, every exit code, an unexpected signature printed loudly and never
// forwarded nor printed itself, and the pair-mainnet wiring: no trader lock, no relayer, no submitter on this path.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContractPolicy } from '@gimbal/shared';
import { YOCTO_PER_NEAR } from '../contract/budget.ts';
import type { NearCallOutcome, NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { toQty } from '../trade/lots.ts';
import type { PriceDeps } from './pair-mainnet-lib.ts';
import { newPriceState, refreshLanded } from './pair-mainnet-lib.ts';
import { storedPrice } from './pair-ops.ts';
import type { RefusalKind, RefuseDeps } from './refuse-lib.ts';
import {
  EXIT_NOT_SENT, EXIT_OTHER_REFUSAL, EXIT_REFUSED, EXIT_SIGNED, EXIT_UNKNOWN, askMarginBps, cancelHl, clearsAsk, deskRefusal, insideBand, notionalE16,
  parseOrderId, refusalOrder, refuse, roomRefusal,
} from './refuse-lib.ts';

const ETH = { index: 1, symbol: 'ETH', sz_decimals: 4 };
const CLOID = `0x${'ab'.repeat(16)}`;
const SIG_R = `02${'11'.repeat(32)}`;
const SIG_S = '22'.repeat(32);
const SECP = { scheme: 'Secp256k1', big_r: { affine_point: SIG_R }, s: { scalar: SIG_S }, recovery_id: 0 };
const panicked = (text: string): NearCallOutcome => ({ txHash: '', ok: false, failure: `{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}` });
const NEAR = YOCTO_PER_NEAR;

function policy(over: Partial<ContractPolicy> = {}): ContractPolicy {
  return {
    hl_assets: [ETH, { index: 0, symbol: 'BTC', sz_decimals: 5 }], phoenix_markets: [], orderly_symbols: [],
    max_notional_usd: 20, price_band_bps: 100, oracle_max_age_s: 900, rescue_cap_usd_per_hour: 0,
    unpriced: [{ symbol: 'BTC', max_sz: '0.001' }], unpriced_max_notional_usd: 10, max_transfer_cost_bps: 0, max_transfer_cost_flat_e6: 0,
    ...over,
  };
}

/** A chain with one stored ETH price; each call answers from `answer`, or as the contract refuses the band order. */
class Chain implements NearTransport {
  readonly accountId = 'operator.near';
  calls: string[] = [];
  /** How many calls are on the chain at once, at most. */
  peak = 0;
  #open = 0;
  stored = true;
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
    return (this.stored ? [{ asset: 'ETH', price_e8: this.pxE8, at_ms: this.atMs }] : []) as T;
  }
  async account() {
    return { amount: 5n * NEAR, locked: 0n, storageUsage: 0 };
  }
  async allowance() {
    return null;
  }
}

interface Over { asks?: number[]; policy?: Partial<ContractPolicy>; paused?: boolean; room?: { spendable: bigint; allowance: bigint | null } }

function deps(chain: Chain, kind: RefusalKind, send: boolean, over: Over = {}): { d: RefuseDeps; lines: string[]; askReads: () => number } {
  const client = new NearContractClient({ contractId: 'gimbal.near', network: 'mainnet', transport: chain, sleep: async () => {} });
  const lines: string[] = [];
  const say = (line = '') => lines.push(line);
  const p = policy(over.policy);
  const prices: PriceDeps = {
    maxAgeS: p.oracle_max_age_s, send, read: (s) => storedPrice(client, s), refresh: (s, maxAgeS) => client.refreshPrices([s], { maxAgeS }),
    now: () => Date.now(), log: say, landed: refreshLanded, ...newPriceState(),
  };
  const asks = [...(over.asks ?? [2501])];
  let reads = 0;
  return {
    lines,
    askReads: () => reads,
    d: {
      kind, symbol: 'ETH', send, deskId: 'carry', desk: { paused: over.paused ?? false, closing: false, policy: p }, client, prices,
      bestAsk: async () => {
        reads++;
        return asks.length > 1 ? asks.shift()! : asks[0]!;
      },
      room: async () => over.room ?? { spendable: 5n * NEAR, allowance: null },
      say, cloid: CLOID,
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

test('the band order is outside the band and within the cap; the notional order is inside the band and one lot over the cap', () => {
  const band = refusalOrder({ kind: 'band', asset: ETH, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 20 }, CLOID);
  assert.deepEqual(band.order, { asset: 1, is_buy: true, px: '2550', sz: '0.0044', reduce_only: false, tif: 'Alo', cloid: CLOID });
  assert.equal(insideBand(band.pxE8, band.oracleE8, 100), false);
  assert.ok(notionalE16(band.pxE8, band.szE8, band.oracleE8) <= 20n * 10n ** 16n);
  assert.equal(Math.round(band.distanceBps), 200, 'twice the band');

  // 20 / 2522.5 = 0.00793 -> 0.008 whole lots reach the cap, plus one lot: 0.0081, 20.43 USD.
  const cap = refusalOrder({ kind: 'notional', asset: ETH, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 20 }, CLOID);
  assert.deepEqual([cap.order.px, cap.order.sz, cap.order.tif, cap.order.reduce_only], ['2522.5', '0.0081', 'Alo', false]);
  assert.equal(insideBand(cap.pxE8, cap.oracleE8, 100), true);
  assert.ok(notionalE16(cap.pxE8, cap.szE8, cap.oracleE8) > 20n * 10n ** 16n);
  assert.ok(notionalE16(cap.pxE8, cap.szE8 - 2n * 10n ** 4n, cap.oracleE8) <= 20n * 10n ** 16n, 'two lots fewer is under the cap: just over it');

  // The contract's edges: exactly the band is inside, one tick past it is not.
  assert.equal(insideBand(toQty('2525'), toQty('2500'), 100), true);
  assert.equal(insideBand(toQty('2525.1'), toQty('2500'), 100), false);
  // A cap too small for one lot leaves no band-only order.
  assert.throws(() => refusalOrder({ kind: 'band', asset: { ...ETH, sz_decimals: 1 }, oraclePx: 2500, bandBps: 100, maxNotionalUsd: 1 }), /no order fits/);
});

test('the ask margin is max(25 bps, half the band); the key needs two call reserves', () => {
  assert.equal(askMarginBps(100), 50);
  assert.equal(askMarginBps(20), 25);
  assert.equal(clearsAsk(2512.5, 2500, 100), true);
  assert.equal(clearsAsk(2512.4, 2500, 100), false);
  assert.equal(roomRefusal({ spendable: 6n * NEAR / 10n, allowance: null }), null);
  assert.match(roomRefusal({ spendable: 5n * NEAR / 10n, allowance: null }) ?? '', /spendable 0\.500 NEAR, under 2 call reserves \(0\.600 NEAR\)/);
  assert.match(roomRefusal({ spendable: 5n * NEAR, allowance: NEAR / 2n }) ?? '', /allowance 0\.500 NEAR/);
});

test('a desk or symbol where another check would refuse first is not sent (exit 5) before anything is read or sent', async () => {
  const p = policy();
  assert.match(deskRefusal({ symbol: 'ETH', desk: { paused: true, policy: p } }) ?? '', /E_PAUSED/);
  assert.match(deskRefusal({ symbol: 'BTC', desk: { paused: false, policy: p } }) ?? '', /unpriced/);
  assert.match(deskRefusal({ symbol: 'SOL', desk: { paused: false, policy: p } }) ?? '', /E_ASSET/);
  assert.equal(deskRefusal({ symbol: 'ETH', desk: { paused: false, policy: p } }), null);
  const chain = new Chain();
  const r = deps(chain, 'band', true, { paused: true });
  assert.equal(await refuse(r.d), EXIT_NOT_SENT);
  assert.match(r.lines.join('\n'), /not sent .*E_PAUSED.*hl_order was not sent/);
  assert.deepEqual(chain.calls, []);
});

test('a key short of two call reserves is not sent (exit 5): no refresh, no hl_order', async () => {
  const chain = new Chain();
  chain.atMs = Date.now() - 2_000_000;
  const r = deps(chain, 'band', true, { room: { spendable: NEAR / 2n, allowance: null } });
  assert.equal(await refuse(r.d), EXIT_NOT_SENT);
  assert.deepEqual(chain.calls, []);
  assert.match(r.lines.join('\n'), /under 2 call reserves/);
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
  assert.match(out, /best ask 2501: px 2550 is at least 50 bps above it/);
  assert.match(out, /cost .*0\.001 NEAR/);
  assert.match(out, /dry run: nothing was signed or sent/);

  // No stored price at all: the dry run still shows the order, against the ask as a stand-in.
  const none = new Chain();
  none.stored = false;
  const n = deps(none, 'band', false, { asks: [2500] });
  assert.equal(await refuse(n.d), EXIT_REFUSED);
  assert.deepEqual(none.calls, []);
  const noneOut = n.lines.join('\n');
  assert.match(noneOut, /none stored; the order below is priced against Hyperliquid's ask 2500 as a stand-in/);
  assert.match(noneOut, /BUY 0\.0044 at 2550/);
});

test('--send refreshes a stale price first, then sends hl_order once and reports the refusal with its nearblocks link', async () => {
  const chain = new Chain();
  chain.atMs = Date.now() - 2_000_000;
  const { d, lines, askReads } = deps(chain, 'band', true);
  assert.equal(await refuse(d), EXIT_REFUSED);
  assert.deepEqual(chain.calls, ['refresh_prices', 'hl_order'], 'the refresh lands before the order is priced and sent');
  assert.equal(chain.peak, 1, 'one NEAR call at a time');
  assert.equal(askReads(), 2, 'the ask is read again right before hl_order');
  assert.equal(fetches, 0);
  const out = lines.join('\n');
  assert.match(out, /refused {3}as expected: nothing was signed/);
  assert.match(out, /https:\/\/nearblocks\.io\/txns\/hash2/);
  assert.match(out, /error {5}E_PRICE_BAND: px 2550 is 2% from oracle 2500, outside price_band_bps 100/);
});

test('--send: the notional refusal is expected for refuse-notional; another refusal is exit 1, no proven outcome exit 3', async () => {
  const chain = new Chain();
  chain.answer = () => panicked('E_SIZE: ETH 2522.5 x 0.0081 = 20.43225 USD is over max_notional_usd 20');
  const { d, lines } = deps(chain, 'notional', true);
  assert.equal(await refuse(d), EXIT_REFUSED);
  assert.deepEqual(chain.calls, ['hl_order']);
  assert.match(lines.join('\n'), /nearblocks\.io\/txns\/hash1/);

  const other = new Chain();
  other.answer = () => panicked('E_ORACLE_STALE: no oracle price for ETH younger than 900 s');
  const o = deps(other, 'band', true);
  assert.equal(await refuse(o.d), EXIT_OTHER_REFUSAL);
  assert.match(o.lines.join('\n'), /NOT as expected \(wanted E_PRICE_BAND\); its gas is spent/);

  const unknown = new Chain();
  unknown.answer = () => ({ txHash: '', ok: false, failure: '{"ActionError":{"kind":"something else"}}' });
  const u = deps(unknown, 'band', true);
  assert.equal(await refuse(u.d), EXIT_UNKNOWN);
  assert.match(u.lines.join('\n'), /unknown {3}hl_order has no proven outcome/);
  assert.match(u.lines.join('\n'), /nearblocks\.io\/txns\/hash1/);
  assert.equal(fetches, 0);
});

test('an ask the order does not clear by the margin, or one that moves before the call, is not sent (exit 5)', async () => {
  const chain = new Chain();
  const r = deps(chain, 'band', true, { asks: [2540] });
  assert.equal(await refuse(r.d), EXIT_NOT_SENT);
  assert.match(r.lines.join('\n'), /not 50 bps above the best ask 2540/);
  assert.deepEqual(chain.calls, []);

  const moved = new Chain();
  const m = deps(moved, 'band', true, { asks: [2501, 2545] });
  assert.equal(await refuse(m.d), EXIT_NOT_SENT);
  assert.match(m.lines.join('\n'), /the best ask moved to 2545: px 2550 is no longer 50 bps above it/);
  assert.deepEqual(moved.calls, [], 'hl_order not sent');

  const dry = deps(new Chain(), 'band', false, { asks: [2540] });
  assert.equal(await refuse(dry.d), EXIT_NOT_SENT);
  assert.match(dry.lines.join('\n'), /not 50 bps above the best ask; run again .*\(dry run\)/);
});

test('a signature the contract returns unexpectedly is printed loudly, never forwarded, and never printed itself', async () => {
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
  assert.match(out, /rest until filled\s+or cancelled/);
  assert.match(out, new RegExp(`pair-mainnet cancel-hl ETH ${CLOID} --send`));
  assert.ok(!out.includes('11'.repeat(32)) && !out.includes(SIG_S), 'the signature bytes are not in the output');
});

test('cancel-hl: the status in a dry run, hl_cancel with --send only for an open order', async () => {
  const open = { status: 'order', order: { status: 'open', order: { oid: 77, coin: 'ETH', side: 'B', sz: '0.0044', origSz: '0.0044', limitPx: '2550' } } };
  const canceled = { status: 'order', order: { status: 'canceled', order: { ...open.order.order } } };
  const cancels: number[] = [];
  const lines: string[] = [];
  const base = { symbol: 'ETH', asset: 1, id: parseOrderId(CLOID), say: (l = '') => lines.push(l), cancel: async (_a: number, oid: number) => cancels.push(oid) };
  let answers: unknown[] = [open];
  const status = async () => answers.shift();
  assert.equal(await cancelHl({ ...base, send: false, status }), 0);
  assert.deepEqual(cancels, []);
  assert.match(lines.join('\n'), /oid 77, ETH BUY 0\.0044 of 0\.0044 at 2550: open/);
  answers = [open, canceled];
  assert.equal(await cancelHl({ ...base, send: true, status }), 0);
  assert.deepEqual(cancels, [77]);
  answers = [{ status: 'unknownOid' }];
  assert.equal(await cancelHl({ ...base, send: true, status }), 0);
  assert.deepEqual(cancels, [77], 'nothing to cancel');
  assert.equal(parseOrderId('123'), 123);
  assert.throws(() => parseOrderId('0x12'), /neither an oid/);
});

// ---- the pair-mainnet wiring ----

const here = dirname(fileURLToPath(import.meta.url));

/** Every module refuse-cli.ts loads at run time (value imports, transitively), as paths under src/. */
function runtimeGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, 'utf8');
    seen.set(file, src);
    for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'/gms)) {
      if (m[1] === undefined) walk(resolve(dirname(file), m[2]!));
    }
  };
  walk(entry);
  return seen;
}

test('refuse-* in pair-mainnet run before the trader lock and load no relayer, no submitter and no lock code', () => {
  const graph = runtimeGraph(join(here, 'refuse-cli.ts'));
  const names = [...graph.keys()].map((f) => f.replace(/\\/g, '/').split('/src/')[1]);
  for (const banned of ['relayer/relayer.ts', 'relayer/hyperliquid.ts', 'trade/trader-state.ts', 'cli/pair-ops.ts', 'trade/legs.ts']) {
    assert.ok(!names.includes(banned), `refuse-cli.ts loads ${banned}`);
  }
  for (const [file, src] of graph) {
    for (const call of ['new Relayer(', 'new HyperliquidSubmitter(', 'new SolanaSubmitter(', 'acquireTraderLock(']) {
      assert.ok(!src.includes(call), `${file} has ${call}`);
    }
  }
  // pair-mainnet.ts dispatches refuse-* in main() before the lock, and run() (the relayer) is never reached for them.
  const main = readFileSync(join(here, 'pair-mainnet.ts'), 'utf8');
  const body = main.slice(main.indexOf('async function main('), main.indexOf('async function run('));
  const dispatch = body.indexOf('await runRefuse(');
  assert.ok(dispatch > 0, 'main() calls runRefuse');
  assert.ok(dispatch < body.indexOf('acquireTraderLock('), 'before the trader lock');
  assert.ok(dispatch < body.indexOf('contractEnv('), 'before the signing setup of the other commands');
  assert.match(body.slice(dispatch, dispatch + 120), /await runRefuse\([^)]*\);\s*return;/, 'and returns');
});
