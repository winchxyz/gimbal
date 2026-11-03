// The rescue executor end to end on a virtual clock: each route's step sequence (the reserve and Phoenix on the
// recorded mainnet 1Click answers, Hyperliquid via Arbitrum on quotes signed by a test key), the cap refusal, the fee
// share falling back to a reduce of both legs, a failure at every step ending the rescue failed, and rescueEnded
// called exactly once per trigger.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Leg, RescueFailure, RescueProgress, StreamEvent, TxRef, VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import type { OutcomeIds } from '../contract/types.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import type { OneClickApi, QuoteAnswer, QuoteRequest, StatusAnswer, VerifiedQuote } from './oneclick.ts';
import { ASSETS } from './oneclick.ts';
import { RecordedOneClick, SimulatedMoney, loadRescueRecording } from './recorded.ts';
import type { CreditPort, HlWithdrawPort, Payer, Reducer, RescueDesk, RescuerOptions } from './rescuer.ts';
import { Rescuer } from './rescuer.ts';
import { testQuote, testSigner } from './test-quotes.ts';

const rec = loadRescueRecording();
const START = Date.parse('2026-11-03T10:00:00.000Z');

function leg(venue: VenueId, marginUsd: number): Leg {
  return {
    venue, symbol: venue === 'orderly' ? 'PERP_ETH_USDC' : 'ETH', side: venue === 'hyperliquid' ? 'long' : 'short', size: 1, lotSize: 0.0001,
    entry: 3000, mark: 3000, liqPx: 2800, marginUsd, marginRatio: 0.8, distanceToLiqPct: 5,
    fundingEarnedUsd: 0, unsettledFundingUsd: 0, feesUsd: 0, unpriced: false,
  };
}

function trigger(over: Partial<RescueTrigger> = {}): RescueTrigger {
  return {
    id: 'rescue-1', venue: 'hyperliquid', symbol: 'ETH', distancePct: 5, rescuePct: 8, watchPct: 15, amountUsd: 15, amountKnown: true,
    from: 'reserve', stress: false, attempt: 0, at: START, ...over,
  };
}

interface World {
  clock: { now(): number };
  t: number;
  events: StreamEvent[];
  ended: [string, boolean][];
  failures: (RescueFailure | null)[];
  rescuer: Rescuer;
  steps(id?: string): RescueProgress['step'][];
  journal(): string[];
}

function world(make: (w: Pick<World, 'clock'> & { sleep: (ms: number) => Promise<void> }) => Omit<RescuerOptions, 'publish' | 'clock' | 'sleep' | 'ended' | 'failure'>): World {
  const w = { t: START, events: [], ended: [], failures: [] } as unknown as World;
  w.clock = { now: () => w.t };
  const sleep = async (ms: number) => {
    w.t += ms;
  };
  const o = make({ clock: w.clock, sleep });
  w.rescuer = new Rescuer({
    ...o, clock: w.clock, sleep, publish: (e) => w.events.push(e),
    ended: (id, landed) => w.ended.push([id, landed]), failure: (f) => w.failures.push(f),
  });
  w.steps = (id = 'rescue-1') => w.events.filter((e): e is Extract<StreamEvent, { type: 'rescue' }> => e.type === 'rescue' && e.data.id === id).map((e) => e.data.step);
  w.journal = () => w.events.filter((e): e is Extract<StreamEvent, { type: 'journal' }> => e.type === 'journal').map((e) => e.data.summary);
  return w;
}

const recordedDesk = (over: Partial<RescueDesk> = {}): RescueDesk => ({ addresses: rec.desk, policy: rec.policy, reserveUsd: 100, closing: false, ...over });

/** The recorded world, as serve builds it off mainnet. */
function recorded(desk: Partial<RescueDesk> = {}, legs: Leg[] = [leg('hyperliquid', 200), leg('phoenix', 200)], freeMargin: Partial<Record<VenueId, number>> = { phoenix: 100 }) {
  let oneClick!: RecordedOneClick;
  const w = world(({ clock }) => {
    oneClick = new RecordedOneClick(rec, clock);
    const money = new SimulatedMoney(oneClick, clock);
    const target = (q: VerifiedQuote): VenueId => (q.destinationAsset === ASSETS.hypercoreUsdc ? 'hyperliquid' : 'orderly');
    return {
      mode: 'testnet', oneClick, desk: async () => recordedDesk(desk), view: () => ({ legs, freeMargin }),
      margin: (v) => money.margin(v),
      payers: { reserve: money.payer('fund_venue', target), phoenix: money.payer('sol_sign_rescue', target), arbitrum: money.payer('evm_usdc_to_intents', target) },
      hlWithdraw: money.hlWithdraw(), fixedAmountUsd: (from, to) => oneClick.fixedAmountUsd(from, to), label: 'testnet: recorded',
    };
  });
  return { w, oneClick: () => oneClick };
}

async function run(w: World, t: RescueTrigger = trigger()): Promise<void> {
  w.rescuer.take(t);
  await w.rescuer.current;
}

const FULL = ['detect', 'source', 'quote', 'verify', 'sign', 'deposit', 'landed'];

test('reserve -> Hyperliquid (fund_venue, recorded): quote, verify, sign, deposit, 1Click SUCCESS, the margin up, landed', async () => {
  const { w, oneClick } = recorded();
  await run(w);
  assert.deepEqual(w.steps(), FULL);
  assert.deepEqual(w.ended, [['rescue-1', true]]);
  assert.deepEqual(w.failures, [null]);
  const calls = oneClick().calls.map((c) => c.call);
  assert.deepEqual(calls.slice(0, 2), ['quote', 'submit']);
  assert.ok(calls.slice(2).every((c) => c === 'status') && calls.length > 3);
  const j = w.journal();
  assert.equal(j.length, 3, j.join('\n'));
  assert.match(j[0]!, /rescue rescue-1 started: hyperliquid ETH needs 15.00 USD of margin; from reserve: 20.00 USD/);
  assert.match(j[1]!, /source reserve, fund_venue sent 20.00 USDC to 1Click for hyperliquid \(at least 19.48 arrives\)/);
  assert.match(j[2]!, /rescue rescue-1 landed in \d+ s: 19.48 USD landed on hyperliquid \[testnet: recorded\]/);
  const landed = w.events.at(-1)!;
  assert.ok(landed.type === 'journal' && landed.data.kind === 'rescue' && landed.data.numbers.from === 'reserve' && Number(landed.data.numbers.landedS) >= 60);
  assert.equal(w.rescuer.capUsed(), 0, 'fund_venue is not in the rescue cap');
});

test('Phoenix -> Orderly receiver (sol_sign_rescue, recorded): the reserve is short, Phoenix pays; Orderly credits later', async () => {
  const { w } = recorded({ reserveUsd: 2 }, [leg('orderly', 200), leg('phoenix', 200)]);
  await run(w, trigger({ venue: 'orderly', symbol: 'PERP_ETH_USDC', amountUsd: 9 }));
  assert.deepEqual(w.steps(), FULL);
  assert.deepEqual(w.ended, [['rescue-1', true]]);
  assert.match(w.journal()[0]!, /from phoenix: 10.00 USD.*passed over: reserve: 2.00 USD idle/);
  const progress = w.events.filter((e) => e.type === 'rescue').at(-1)!;
  assert.ok(progress.type === 'rescue' && progress.data.from === 'phoenix' && progress.data.elapsedS >= 135);
  // Counted when signed; the sliding hour has taken off what the 2+ minutes since weigh.
  assert.ok(w.rescuer.capUsed() <= 10 && w.rescuer.capUsed() > 9.5, 'the 10 USDC counts against the cap');
});

test('the cap: a source over the hour\'s cap is refused before any quote, with the reason', async () => {
  const { w, oneClick } = recorded({ reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 3 } });
  await run(w);
  assert.deepEqual(w.steps(), ['detect', 'failed']);
  assert.deepEqual(w.ended, [['rescue-1', false]]);
  assert.equal(oneClick().calls.length, 0);
  assert.equal(w.failures[0]?.step, 'source');
  assert.match(w.failures[0]!.reason, /phoenix: over the rescue cap: it would count 4.00 USD, and 3.00 of the 3 USD an hour is left/);
});

// ---- a world on quotes signed by a test key, any amount, any route ----

interface Synthetic {
  w: World;
  quotes: QuoteRequest[];
  sent: VerifiedQuote[];
  withdrawn: bigint[];
  credited: bigint[];
  closes: { targets?: [bigint, bigint]; reduceOnly?: boolean }[];
}

interface SyntheticOptions {
  desk?: Partial<RescueDesk>;
  legs?: Leg[];
  freeMargin?: Partial<Record<VenueId, number>>;
  quote?: (body: QuoteRequest, now: number) => Promise<QuoteAnswer>;
  status?: (n: number) => StatusAnswer;
  sign?: () => Promise<void>;
  send?: () => Promise<void>;
  /** The target's margin never moves. */
  noLanding?: boolean;
  reducer?: boolean;
  signer?: ReturnType<typeof testSigner>;
}

function synthetic(o: SyntheticOptions = {}): Synthetic {
  const s: Synthetic = { w: undefined as unknown as World, quotes: [], sent: [], withdrawn: [], credited: [], closes: [] };
  const signer = testSigner();
  const quoteSigner = o.signer ?? signer;
  let landed = 0;
  let statusN = 0;
  let arbE6 = 7_000_000n;
  s.w = world(({ clock }) => {
    const oneClick: OneClickApi = {
      source: 'test', publicKey: signer.publicKey,
      quote: async (body) => {
        s.quotes.push(body);
        return o.quote?.(body, clock.now()) ?? { ok: true, response: testQuote(quoteSigner, body, clock.now()) };
      },
      submitDeposit: async () => ({ status: 200 }),
      status: async () => o.status?.(++statusN) ?? { status: ++statusN > 2 ? 'SUCCESS' : 'PROCESSING', body: null },
    };
    const payer = (method: Payer['method']): Payer => ({
      method,
      sign: async (q) => {
        await o.sign?.();
        return {
          tx: [{ chain: 'near', id: `near-${method}`, url: 'https://nearblocks.io/x' }] as TxRef[],
          send: async () => {
            await o.send?.();
            s.sent.push(q);
            if (o.noLanding !== true && method !== 'evm_usdc_to_intents') landed += Number(q.minAmountOutE8) / 1e8;
            return { tx: [], depositTx: `deposit-${q.depositAddress}` };
          },
        };
      },
    });
    const hlWithdraw: HlWithdrawPort = {
      withdraw: async (amountE6) => {
        s.withdrawn.push(amountE6);
        const t0 = clock.now();
        const arrive = amountE6 - 1_000_000n;
        const old = arbE6;
        // Shows on Arbitrum 230 s later.
        hlWithdraw.arbitrumUsdcE6 = async () => (clock.now() - t0 >= 230_000 ? old + arrive : old);
        return { tx: [{ chain: 'hyperliquid', id: '0xwithdraw', url: 'https://app.hyperliquid.xyz/explorer/tx/0xwithdraw' }] };
      },
      arbitrumUsdcE6: async () => arbE6,
    };
    void arbE6;
    arbE6 = 7_000_000n;
    const credit: CreditPort = {
      credit: async (e6) => {
        s.credited.push(e6);
        if (o.noLanding !== true) landed += Number(e6) / 1e6;
        return { tx: [] };
      },
    };
    const legs = o.legs ?? [leg('hyperliquid', 200), leg('phoenix', 200)];
    const pos: bigint[] = [100_000_000n, -100_000_000n];
    const reducer: Reducer = {
      legs: legs.map((l, i) => ({ venue: l.venue, symbol: l.symbol, lot: 10_000n, replayable: false, position: async () => pos[i]! }) as unknown as TradeLeg) as unknown as [TradeLeg, TradeLeg],
      lot: 10_000n,
      close: async (req) => {
        s.closes.push(req);
        const r: PairResult = {
          status: 'closed', size: '0', notes: [], tx: [],
          legs: legs.map((l, i) => ({ venue: l.venue, symbol: l.symbol, start: String(pos[i]), target: String(req.targets?.[i]), final: String(req.targets?.[i]), orders: [] })) as unknown as PairResult['legs'],
        };
        return r;
      },
    };
    return {
      mode: 'mainnet', oneClick, keyed: true,
      desk: async () => ({ addresses: rec.desk, policy: rec.policy, reserveUsd: 100, closing: false, ...o.desk }),
      view: () => ({ legs, freeMargin: o.freeMargin ?? { phoenix: 100 } }),
      margin: async () => landed,
      payers: { reserve: payer('fund_venue'), phoenix: payer('sol_sign_rescue'), arbitrum: payer('evm_usdc_to_intents') },
      hlWithdraw, credit: { phoenix: credit },
      ...(o.reducer === true ? { reducer: () => reducer } : {}),
    };
  });
  return s;
}

test('Hyperliquid -> Phoenix: hl_withdraw to the desk\'s Arbitrum, then evm_usdc_to_intents, 1Click, a Phoenix deposit', async () => {
  const s = synthetic({ desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 } });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.steps(), ['detect', 'source', 'sign', 'deposit', 'quote', 'verify', 'sign', 'deposit', 'landed']);
  assert.deepEqual(s.w.ended, [['rescue-1', true]]);
  assert.equal(s.withdrawn.length, 1);
  const q = s.quotes[0]!;
  assert.equal(q.originAsset, ASSETS.arbitrumUsdc);
  assert.equal(q.destinationAsset, ASSETS.solanaUsdc);
  assert.equal(q.recipient, rec.desk.sol);
  assert.equal(q.refundTo, rec.desk.evm);
  assert.equal(q.slippageTolerance, 50);
  assert.equal(BigInt(q.amount), s.withdrawn[0]! - 1_000_000n, 'what arrived on Arbitrum is bridged');
  assert.equal(s.credited.length, 1, 'the delivery is deposited into Phoenix');
  const capWeight = Number(s.withdrawn[0]!) / 1e6 + Number(q.amount) / 1e6;
  // The hour slides while the withdraw arrives (about 4 min): both still weigh over 90 %.
  assert.ok(s.w.rescuer.capUsed() <= capWeight && s.w.rescuer.capUsed() > 0.9 * capWeight, 'hl_withdraw and the bridge both count');
  const tx = s.w.events.filter((e) => e.type === 'rescue').at(-1)!;
  assert.ok(tx.type === 'rescue' && tx.data.tx.some((x) => x.chain === 'hyperliquid'));
  assert.match(s.w.journal().join('\n'), /source hyperliquid, hl_withdraw/);
});

test('the fee share: a small rescue whose fees are over 10 % reduces both legs reduce-only by the same size', async () => {
  const s = synthetic({ reducer: true });
  await run(s.w, trigger({ amountUsd: 1.5 }));
  assert.deepEqual(s.w.steps(), ['detect', 'source', 'sign', 'landed']);
  assert.deepEqual(s.w.ended, [['rescue-1', true]]);
  assert.equal(s.quotes.length, 0);
  assert.equal(s.closes.length, 1);
  const c = s.closes[0]!;
  assert.equal(c.reduceOnly, true);
  const [a, b] = c.targets!;
  const cut = 100_000_000n - a;
  assert.equal(b, -100_000_000n + cut, 'both legs by the same size: the hedge stays flat');
  assert.ok(cut > 0n && cut % 10_000n === 0n);
  // 1.5 × 1.1 more margin on 200: cut about 0.82 % of 1 ETH, rounded up to the lot.
  assert.equal(cut, 820_000n);
  assert.match(s.w.journal()[0]!, /fees of about 0.32 USD are \d+ % .* over the 10 %/);
});

const failures: [string, SyntheticOptions, RescueProgress['step'], RegExp][] = [
  ['1Click quotes nothing', { quote: async () => ({ ok: false, status: 400, message: 'Quoting for this pair is not available' }) }, 'quote', /no quote reserve -> hyperliquid: Quoting for this pair is not available/],
  ['1Click does not answer', { quote: async () => { throw new Error('fetch failed'); } }, 'quote', /did not answer the quote: fetch failed/],
  ['a quote signed by another key', { signer: testSigner() }, 'verify', /refused before signing: E_QUOTE_SIGNATURE/],
  ['the contract refuses to sign', { sign: async () => { throw new Error('E_PAUSED: desk is paused'); } }, 'sign', /fund_venue: E_PAUSED/],
  ['the payment cannot be sent', { send: async () => { throw new Error('rpc down'); } }, 'deposit', /fund_venue deposit: rpc down/],
  ['1Click refunds', { status: () => ({ status: 'REFUNDED', body: null }) }, 'deposit', /1Click ended the transfer REFUNDED: the refund goes back to the desk owner on NEAR/],
  ['1Click never settles', { status: () => ({ status: 'PROCESSING', body: null }) }, 'deposit', /1Click says PROCESSING after 600 s/],
  ['the margin never shows', { noLanding: true }, 'deposit', /1Click says SUCCESS but hyperliquid's margin is up 0.00 USD/],
];

for (const [name, options, step, reason] of failures) {
  test(`a failure at ${step} (${name}): failed, the reason, rescueEnded(false) once`, async () => {
    const s = synthetic(options);
    await run(s.w, trigger({ amountUsd: 30 }));
    assert.equal(s.w.steps().at(-1), 'failed');
    assert.equal(s.w.steps().filter((x) => x === 'failed' || x === 'landed').length, 1);
    assert.deepEqual(s.w.ended, [['rescue-1', false]]);
    assert.equal(s.w.failures.length, 1);
    assert.equal(s.w.failures[0]!.step, step);
    assert.match(s.w.failures[0]!.reason, reason);
    assert.match(s.w.journal().at(-1)!, new RegExp(`rescue rescue-1 failed at ${step}: `));
  });
}

test('exactly once: a trigger while one runs ends at once as failed; each rescue ends once', async () => {
  const s = synthetic();
  s.w.rescuer.take(trigger({ id: 'a', amountUsd: 30 }));
  const first = s.w.rescuer.current;
  s.w.rescuer.take(trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['b', false]]);
  assert.match(s.w.failures[0]!.reason, /rescue a of hyperliquid ETH is still running/);
  await first;
  assert.deepEqual(s.w.ended, [['b', false], ['a', true]]);
  s.w.rescuer.take(trigger({ id: 'c', amountUsd: 30 }));
  await s.w.rescuer.current;
  assert.deepEqual(s.w.ended.map(([id]) => id), ['b', 'a', 'c']);
});

test('an unknown outcome holds every later transfer: only reduces run', async () => {
  const s = synthetic({ reducer: true, sign: async () => { throw new OutcomeUnknown('fund_venue', 'sent, no answer', {} as OutcomeIds); } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.failures[0]!.next, /only reduces run/);
  assert.ok(s.w.rescuer.held !== null);
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['a', false], ['b', true]]);
  assert.equal(s.quotes.length, 1, 'no second quote');
  assert.equal(s.closes.length, 1);
});

test('a closing desk (panic_close) starts no rescue; unknown amounts fail, nothing needed lands', async () => {
  const closing = synthetic({ desk: { closing: true } });
  await run(closing.w);
  assert.deepEqual(closing.w.ended, [['rescue-1', false]]);
  assert.match(closing.w.failures[0]!.reason, /the desk is closing/);
  assert.equal(closing.quotes.length, 0);
  await run(closing.w, trigger({ id: 'again' }));
  assert.equal(closing.w.journal().filter((j) => /closing/.test(j)).length, 1, 'said once');

  const unknown = synthetic();
  await run(unknown.w, trigger({ amountKnown: false, amountUsd: 0 }));
  assert.deepEqual(unknown.w.ended, [['rescue-1', false]]);
  assert.match(unknown.w.failures[0]!.reason, /the amount is unknown/);

  const nothing = synthetic();
  await run(nothing.w, trigger({ amountUsd: 0 }));
  assert.deepEqual(nothing.w.ended, [['rescue-1', true]]);
});

test('the rescue runs live only on mainnet: a live 1Click is refused on testnet and in replay', () => {
  for (const mode of ['testnet', 'replay'] as const) {
    assert.throws(() => new Rescuer({
      mode, publish: () => {}, clock: { now: () => 0 }, sleep: async () => {},
      oneClick: { source: 'live', quote: async () => ({ ok: false, status: 0, message: '' }), submitDeposit: async () => ({ status: 0 }), status: async () => ({ status: '', body: null }) },
      desk: async () => recordedDesk(), view: () => ({ legs: [], freeMargin: {} }), margin: async () => 0, payers: {}, ended: () => {},
    }), /runs live only on mainnet/);
  }
});

test('recorded: a second rescue on the same recorded route is its own transfer: it waits for its own SUCCESS', async () => {
  const { w } = recorded({ reserveUsd: 100 });
  await run(w, trigger({ id: 'a' }));
  const t1 = w.t;
  await run(w, trigger({ id: 'b' }));
  assert.deepEqual(w.ended, [['a', true], ['b', true]]);
  assert.ok(w.t - t1 >= 60_000, 'the second waited for its own timeline');
  assert.match(w.journal().at(-1)!, /rescue b landed in \d{2,} s: 19.48 USD/);
});
