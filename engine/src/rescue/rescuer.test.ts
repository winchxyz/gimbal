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
import type { CreditPort, HlWithdrawPort, LandingPort, Payer, Reducer, RescueDesk, RescuerOptions } from './rescuer.ts';
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
  logs: string[];
  steps(id?: string): RescueProgress['step'][];
  journal(): string[];
}

function world(make: (w: Pick<World, 'clock'> & { sleep: (ms: number) => Promise<void> }) => Omit<RescuerOptions, 'publish' | 'clock' | 'sleep' | 'ended' | 'failure'>): World {
  const w = { t: START, events: [], ended: [], failures: [], logs: [] } as unknown as World;
  w.clock = { now: () => w.t };
  const sleep = async (ms: number) => {
    w.t += ms;
  };
  const o = make({ clock: w.clock, sleep });
  w.rescuer = new Rescuer({
    log: (line) => w.logs.push(line), ...o, clock: w.clock, sleep, publish: (e) => w.events.push(e),
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
      landing: money.landing(),
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
  /** The target venues' ledgers: one entry per delivery (the test may add or hold them). */
  ledger: { venue: VenueId; usd: number; id: string }[];
  /** USDC on the desk's Arbitrum address, × 1e6, and withdraws on their way to it. */
  arb: { e6: bigint; arriving: { at: number; e6: bigint }[] };
  /** Replaces 1Click's status answers from now on. */
  status: ((n: number, depositAddress: string) => StatusAnswer) | null;
  legs: Leg[];
  /** The key 1Click's quotes are signed with here. */
  signer: ReturnType<typeof testSigner>;
  /** The desk's Arbitrum balance cannot be read. */
  arbDown: boolean;
}

interface SyntheticOptions {
  desk?: Partial<RescueDesk>;
  legs?: Leg[];
  freeMargin?: Partial<Record<VenueId, number>>;
  quote?: (body: QuoteRequest, now: number) => Promise<QuoteAnswer>;
  status?: (n: number) => StatusAnswer;
  sign?: () => Promise<void>;
  send?: () => Promise<void>;
  /** A sent payment never shows in the target's ledger. */
  noLanding?: boolean;
  reducer?: boolean;
  signer?: ReturnType<typeof testSigner>;
  /** EIP-3009 validity of the signed payments, ms from signing. */
  usableForMs?: number;
  /** What the signed payments say when asked whether they can still run. */
  neverRuns?: () => Promise<boolean>;
  seedCap?: boolean;
  confirms?: (venue: VenueId) => string | null;
}

const venueOf = (q: VerifiedQuote): VenueId => (q.destinationAsset === ASSETS.hypercoreUsdc ? 'hyperliquid' : q.destinationAsset === ASSETS.solanaUsdc ? 'phoenix' : 'orderly');

function synthetic(o: SyntheticOptions = {}): Synthetic {
  const s: Synthetic = {
    w: undefined as unknown as World, quotes: [], sent: [], withdrawn: [], credited: [], closes: [], ledger: [],
    arb: { e6: 0n, arriving: [] }, status: null, legs: o.legs ?? [leg('hyperliquid', 200), leg('phoenix', 200)], signer: testSigner(), arbDown: false,
  };
  const signer = s.signer;
  const quoteSigner = o.signer ?? signer;
  let statusN = 0;
  s.w = world(({ clock }) => {
    const oneClick: OneClickApi = {
      source: 'test', publicKey: signer.publicKey,
      quote: async (body) => {
        s.quotes.push(body);
        return o.quote?.(body, clock.now()) ?? { ok: true, response: testQuote(quoteSigner, body, clock.now()) };
      },
      submitDeposit: async () => ({ status: 200 }),
      status: async (addr) => {
        statusN++;
        if (s.status !== null) return s.status(statusN, addr);
        return o.status?.(statusN) ?? { status: statusN > 2 ? 'SUCCESS' : 'PROCESSING', body: null };
      },
    };
    const payer = (method: Payer['method']): Payer => ({
      method,
      sign: async (q) => {
        await o.sign?.();
        return {
          tx: [{ chain: 'near', id: `near-${method}`, url: 'https://nearblocks.io/x' }] as TxRef[],
          ...(o.usableForMs === undefined ? {} : { usableUntilMs: clock.now() + o.usableForMs }),
          ...(o.neverRuns === undefined ? {} : { neverRuns: o.neverRuns }),
          send: async () => {
            await o.send?.();
            s.sent.push(q);
            if (method === 'evm_usdc_to_intents') s.arb.e6 -= q.amountIn;
            if (o.noLanding !== true) s.ledger.push({ venue: venueOf(q), usd: Number(q.minAmountOutE8) / 1e8, id: `ledger-${q.depositAddress}` });
            return { tx: [], depositTx: `deposit-${q.depositAddress}` };
          },
        };
      },
    });
    const arrived = () => {
      for (const a of [...s.arb.arriving]) {
        if (clock.now() < a.at) continue;
        s.arb.e6 += a.e6;
        s.arb.arriving.splice(s.arb.arriving.indexOf(a), 1);
      }
      return s.arb.e6;
    };
    const hlWithdraw: HlWithdrawPort = {
      withdraw: async (amountE6) => {
        s.withdrawn.push(amountE6);
        // Shows on Arbitrum 230 s later, less Hyperliquid's 1 USDC.
        s.arb.arriving.push({ at: clock.now() + 230_000, e6: amountE6 - 1_000_000n });
        return { tx: [{ chain: 'hyperliquid', id: '0xwithdraw', url: 'https://app.hyperliquid.xyz/explorer/tx/0xwithdraw' }] };
      },
      arbitrumUsdcE6: async () => {
        if (s.arbDown) throw new Error('arbitrum rpc: connection reset');
        return arrived();
      },
    };
    const credit: CreditPort = {
      credit: async (e6) => {
        s.credited.push(e6);
        return { tx: [] };
      },
    };
    const landing: LandingPort = {
      confirms: (venue) => o.confirms?.(venue) ?? null,
      find: async (venue, q, _since, seen) => {
        const e = s.ledger.find((x) => x.venue === venue && !seen.has(x.id) && x.usd >= Number(q.minAmountOutE8) / 1e8);
        return e === undefined ? null : { id: e.id, usd: e.usd, tx: [] };
      },
    };
    const pos: bigint[] = [100_000_000n, -100_000_000n];
    const reducer: Reducer = {
      legs: s.legs.map((l, i) => ({ venue: l.venue, symbol: l.symbol, lot: 10_000n, replayable: false, position: async () => pos[i]! }) as unknown as TradeLeg) as unknown as [TradeLeg, TradeLeg],
      lot: 10_000n,
      close: async (req) => {
        s.closes.push(req);
        const r: PairResult = {
          status: 'closed', size: '0', notes: [], tx: [], feeUsd: 0, feeUnknown: 0,
          legs: s.legs.map((l, i) => ({ venue: l.venue, symbol: l.symbol, start: String(pos[i]), target: String(req.targets?.[i]), final: String(req.targets?.[i]), orders: [] })) as unknown as PairResult['legs'],
        };
        return r;
      },
    };
    return {
      mode: 'mainnet', oneClick, keyed: true, seedCap: o.seedCap ?? false,
      desk: async () => ({ addresses: rec.desk, policy: rec.policy, reserveUsd: 100, closing: false, ...o.desk }),
      view: () => ({ legs: s.legs, freeMargin: o.freeMargin ?? { phoenix: 100 } }),
      landing,
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
  assert.equal(q.slippageTolerance, 55);
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
  ['the delivery never shows in the ledger', { noLanding: true }, 'deposit', /1Click says SUCCESS but hyperliquid's ledger shows no delivery of at least/],
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
      desk: async () => recordedDesk(), view: () => ({ legs: [], freeMargin: {} }), landing: { confirms: () => null, find: async () => null }, payers: {}, ended: () => {},
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

// ---- paying twice ----

test('a transfer 1Click has not settled in time is held: only reduces run until it settles, then it is journaled late', async () => {
  const s = synthetic({ reducer: true, status: () => ({ status: 'PROCESSING', body: null }), noLanding: true });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.failures[0]!.next, /only reduces run/);
  assert.match(s.w.rescuer.held!, /is PROCESSING at 1Click: it may still deliver/);
  // Still processing: the next rescue reduces, it does not pay again.
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.sent.length, 1);
  assert.equal(s.closes.length, 1);
  // 1Click delivers late and the ledger shows it: the hold ends, and transfers run again.
  s.status = () => ({ status: 'SUCCESS', body: null });
  s.ledger.push({ venue: 'hyperliquid', usd: 31, id: 'late-delivery' });
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  assert.doesNotMatch(s.w.rescuer.held ?? '', /rescue a/, "a's hold ended");
  assert.ok(s.w.journal().some((j) => /rescue a's 31.00 USD landed on hyperliquid late/.test(j)));
  assert.equal(s.sent.length, 2, 'c paid: nothing is held any more');
});

test('a delivery 1Click calls SUCCESS but the ledger does not show is held too; a refund ends the hold', async () => {
  const s = synthetic({ reducer: true, noLanding: true });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /SUCCESS at 1Click but not yet in hyperliquid's ledger/);
  s.status = () => ({ status: 'REFUNDED', body: null });
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.equal(s.w.rescuer.held, null);
  assert.ok(s.w.journal().some((j) => /rescue a's transfer ended REFUNDED at 1Click: refunded, nothing landed/.test(j)));
});

test('a signed EIP-3009 authorization that failed to send is held until it can never run, and 1Click had 10 more minutes', async () => {
  let sendFails = true;
  let dead = false;
  const asked: number[] = [];
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 }, reducer: true,
    usableForMs: 300_000, send: async () => { if (sendFails) throw new Error('arbitrum rpc: connection reset'); },
    neverRuns: async () => { asked.push(s.w.t); return dead; },
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.rescuer.held!, /the signed evm_usdc_to_intents of rescue a was not sent but stays usable until/);
  sendFails = false;
  s.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  // Past validBefore, but authorizationState is not read as unused yet (or the read failed): still held.
  s.w.t += 300_001;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(s.sent.length, 0, 'no second authorization');
  assert.match(s.w.rescuer.held!, /rescue a/);
  // It reads as one that can never run: 1Click still gets 10 minutes to index a deposit it missed.
  dead = true;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'PENDING_DEPOSIT is not final yet');
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'd', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run and 1Click saw no deposit 10 min later: expired unused/.test(j)));
  assert.equal(s.w.rescuer.held, null);
  assert.ok(asked.length >= 2);
});

test('a payer that cannot tell whether its signed payment may still run keeps it held past its validity', async () => {
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 }, reducer: true,
    usableForMs: 300_000, send: async () => { throw new Error('arbitrum rpc: connection reset'); },
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  s.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/);
  assert.equal(s.sent.length, 0);
});

test('an EIP-3009 send whose outcome is unknown (no receipt, or the authorization already used) is held until a restart', async () => {
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 }, reducer: true,
    usableForMs: 300_000, neverRuns: async () => true,
    send: async () => { throw new OutcomeUnknown('arbitrum transferWithAuthorization', 'no receipt for 0xabc', { arbitrumTx: '0xabc' } as OutcomeIds); },
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.rescuer.held!, /the evm_usdc_to_intents of rescue a may have paid .*no receipt for 0xabc.*reconcile it before any other transfer/);
  // Past validBefore, 1Click still PENDING_DEPOSIT, the authorization read as unused: none of it ends this hold.
  s.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /may have paid/);
  assert.equal(s.closes.length, 1, 'only a reduce ran');
});

test('a SUCCESS the ledger never shows is held; after 30 min it is journaled once as reconcile needed and stays held', async () => {
  const s = synthetic({ reducer: true, noLanding: true });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /SUCCESS at 1Click but not yet/);
  s.w.t += 31 * 60_000;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  const lines = s.w.journal().filter((j) => /reconcile needed/.test(j));
  assert.equal(lines.length, 1, 'said once');
  assert.match(lines[0]!, /reconcile needed: rescue a's deposit \S+ \(\d+\.\d+ USDC in, at least \d+\.\d+ out to hyperliquid\) is SUCCESS at 1Click after \d+ min; transfers stay held/);
  assert.match(s.w.rescuer.held!, /rescue a/);
  assert.ok(s.w.logs.some((l) => /reconcile needed/.test(l)));
});

test('mainnet says at start that a restart dropped any holds and the cap meter starts full', async () => {
  const s = synthetic({ seedCap: true });
  assert.ok(s.w.logs.some((l) => /rescuer started: holds live in memory, so any transfer held before this restart is no longer held/.test(l)));
  await run(s.w, trigger({ amountUsd: 30 }));
  assert.match(s.w.journal()[0]!, /rescuer started at .*held transfer of an earlier run was dropped by the restart.*cap counts as used in full/);
  assert.ok(!synthetic().w.logs.some((l) => /rescuer started/.test(l)), 'not without the seeded cap');
});

test('Hyperliquid USDC left on Arbitrum by a failed rescue is spent first; no second hl_withdraw meanwhile', async () => {
  let refuse = true;
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 },
    quote: async (body, now) => (refuse ? { ok: false, status: 400, message: 'Quoting for this pair is not available' } : { ok: true, response: testQuote(s.signer, body, now) }),
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.equal(s.withdrawn.length, 1);
  assert.match(s.w.rescuer.hlWithdrawHeld!, /left its USDC on the desk's Arbitrum address/);
  assert.ok(s.arb.e6 > 0n, 'stranded on Arbitrum');
  refuse = false;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.withdrawn.length, 1, 'no second withdraw');
  assert.match(s.w.journal().join('\n'), /already on the desk's Arbitrum address \(an earlier withdraw\), no new withdraw/);
  assert.equal(s.w.rescuer.hlWithdrawHeld, null, 'bridged: Hyperliquid may be withdrawn from again');
});

test('the hl_withdraw hold: less on Arbitrum than needed is bridged in part; it ends once Arbitrum reads empty with no withdraw on its way', async () => {
  let refuse = true;
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 },
    quote: async (body, now) => (refuse ? { ok: false, status: 400, message: 'Quoting for this pair is not available' } : { ok: true, response: testQuote(s.signer, body, now) }),
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 10 }));
  assert.match(s.w.rescuer.hlWithdrawHeld!, /left its USDC/);
  const stranded = s.arb.e6;
  refuse = false;
  // A bigger rescue: what is on Arbitrum is bridged first, all of it, and no second withdraw.
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 40 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.withdrawn.length, 1);
  assert.equal(BigInt(s.quotes.at(-1)!.amount), stranded / 10_000n * 10_000n, 'the whole stranded balance (to the cent)');
  assert.match(s.w.journal().join('\n'), /only \d+\.\d\d of the \d+\.\d\d USD is on Arbitrum/);
  assert.equal(s.w.rescuer.hlWithdrawHeld, null);

  // A withdraw that never arrives: held while it may still be on its way, then Arbitrum reads empty and it ends.
  const t = synthetic({ desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 } });
  const realPush = t.arb.arriving.push.bind(t.arb.arriving);
  t.arb.arriving.push = () => 0;   // Hyperliquid accepted the withdraw; it never shows on Arbitrum
  await run(t.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.match(t.w.failures.at(-1)!.reason, /did not reach the desk's Arbitrum address/);
  assert.ok(t.w.rescuer.hlWithdrawHeld !== null);
  t.arb.arriving.push = realPush;
  await run(t.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(t.withdrawn.length, 1, 'still on its way: no second withdraw');
  t.w.t += 30 * 60_000;
  await run(t.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(t.w.journal().some((j) => /Arbitrum address reads empty and no hl_withdraw is on its way/.test(j)));
  assert.equal(t.withdrawn.length, 2, 'withdraws run again');
});

test('an Arbitrum balance that cannot be read stops the Hyperliquid source and keeps the hl_withdraw hold', async () => {
  let refuse = true;
  const s = synthetic({
    desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 }, reducer: true,
    quote: async (body, now) => (refuse ? { ok: false, status: 400, message: 'Quoting for this pair is not available' } : { ok: true, response: testQuote(s.signer, body, now) }),
  });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  refuse = false;
  s.arbDown = true;
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.journal().join('\n'), /hyperliquid: the desk's Arbitrum USDC could not be read/);
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.quotes.length, 1, 'no bridge either');
  assert.ok(s.w.rescuer.hlWithdrawHeld !== null, 'an unread balance is not an empty one');
});

test('mainnet starts its cap meter full: no rescue out of a venue in the first hour after a restart, the reserve still pays', async () => {
  const s = synthetic({ seedCap: true, desk: { reserveUsd: 0 } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.failures[0]!.reason, /phoenix: over the rescue cap/);
  const reserve = synthetic({ seedCap: true });
  await run(reserve.w, trigger({ amountUsd: 30 }));
  assert.deepEqual(reserve.w.ended, [['rescue-1', true]], 'fund_venue is not in the cap');
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
});

test('a reduce is refused when the leg\'s margin is not read (it would size the cut at the whole leg)', async () => {
  const s = synthetic({ reducer: true, desk: { reserveUsd: 0 }, freeMargin: {}, legs: [leg('phoenix', 200), leg('orderly', 200)] });
  await run(s.w, trigger({ amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['rescue-1', false]]);
  assert.match(s.w.failures[0]!.reason, /margin is not read, so the cut cannot be sized/);
  assert.equal(s.closes.length, 0);
});

test('a target whose landing cannot be confirmed takes no transfer', async () => {
  const s = synthetic({ legs: [leg('orderly', 200), leg('phoenix', 200)], confirms: (v) => (v === 'orderly' ? 'a landing on Orderly cannot be confirmed here' : null) });
  await run(s.w, trigger({ venue: 'orderly', symbol: 'PERP_ETH_USDC', amountUsd: 30 }));
  assert.equal(s.quotes.length, 0);
  assert.match(s.w.failures[0]!.reason, /reserve: a landing on Orderly cannot be confirmed here/);
});
