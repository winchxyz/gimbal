// The rescue executor end to end on a virtual clock: each route's step sequence (the reserve and Phoenix on the
// recorded mainnet 1Click answers, Hyperliquid via Arbitrum on quotes signed by a test key), the cap refusal, the fee
// share falling back to a reduce of both legs, a failure at every step ending the rescue failed, and rescueEnded
// called exactly once per trigger. Then paying twice: holds read again on a simulated Arbitrum (Bridge2 Transfers,
// authorizationState and block times, each read at the block asked) and on a simulated NEAR (get_desk_counters'
// deposit ring and the block time), and the state file across restarts.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Leg, RescueFailure, RescueProgress, StreamEvent, TxRef, VenueId } from '@gimbal/shared';
import { OutcomeUnknown } from '../contract/types.ts';
import { NothingExecuted } from '../relayer/tx.ts';
import type { OutcomeIds } from '../contract/types.ts';
import type { RescueTrigger } from '../risk/engine.ts';
import type { PairResult } from '../trade/pair.ts';
import type { TradeLeg } from '../trade/legs.ts';
import { eip3009Nonce } from '../contract/replay-client.ts';
import { HL_BRIDGE2, SimulatedArbitrum } from './arbitrum-chain.ts';
import { SimulatedNear } from './near-chain.ts';
import type { NearTxFacts } from './near-chain.ts';
import { SimulatedSolana } from './solana-chain.ts';
import type { OneClickApi, QuoteAnswer, QuoteRequest, StatusAnswer, VerifiedQuote } from './oneclick.ts';
import { ASSETS } from './oneclick.ts';
import { RecordedOneClick, SimulatedMoney, loadRescueRecording } from './recorded.ts';
import type { CreditPort, HlWithdrawPort, LandingPort, Payer, Reducer, RescueDesk, RescuerOptions } from './rescuer.ts';
import { Rescuer, operatorMinWithdrawE6 } from './rescuer.ts';
import type { Eip3009Ref, RescueIdentity } from './state.ts';
import { RescueStateStore } from './state.ts';
import { testQuote, testSigner } from './test-quotes.ts';

const rec = loadRescueRecording();
const START = Date.parse('2026-11-03T10:00:00.000Z');
const EVM = rec.desk.evm.toLowerCase();
/** Where 1Click's refunds come from on Arbitrum (any address but Bridge2). */
const ONECLICK_ARB = '0x1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c';

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
  /** A new Rescuer on the same world (the engine restarted): the same ports, store and clock, and `over`. */
  restart(over?: Partial<RescuerOptions>): Rescuer;
}

function world(make: (w: Pick<World, 'clock'> & { sleep: (ms: number) => Promise<void> }) => Omit<RescuerOptions, 'publish' | 'clock' | 'sleep' | 'ended' | 'failure'>): World {
  const w = { t: START, events: [], ended: [], failures: [], logs: [] } as unknown as World;
  w.clock = { now: () => w.t };
  const sleep = async (ms: number) => {
    w.t += ms;
  };
  const o = make({ clock: w.clock, sleep });
  w.restart = (over = {}) => (w.rescuer = new Rescuer({
    log: (line) => w.logs.push(line), ...o, ...over, clock: w.clock, sleep, publish: (e) => w.events.push(e),
    ended: (id, landed) => w.ended.push([id, landed]), failure: (f) => w.failures.push(f),
  }));
  w.restart();
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
    const money = new SimulatedMoney(oneClick, clock, rec.desk);
    const target = (q: VerifiedQuote): VenueId => (q.destinationAsset === ASSETS.hypercoreUsdc ? 'hyperliquid' : 'orderly');
    return {
      mode: 'testnet', oneClick, desk: async () => recordedDesk(desk), view: () => ({ legs, freeMargin }),
      landing: money.landing(),
      payers: { reserve: money.payer('fund_venue', target), phoenix: money.payer('sol_sign_rescue', target), arbitrum: money.payer('evm_usdc_to_intents', target) },
      hlWithdraw: money.hlWithdraw(), arbitrum: money.arbitrum, fixedAmountUsd: (from, to) => oneClick.fixedAmountUsd(from, to), label: 'testnet: recorded',
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
  /** Arbitrum: the desk's USDC, Transfer logs, used authorizations; `down` makes every read fail. */
  chain: SimulatedArbitrum;
  /** Withdraws show on Arbitrum (230 s later, from Bridge2); false: they are accepted and never show (kept in `late`). */
  hlArrives: boolean;
  late: bigint[];
  /** Every quote signed (sent or not), and every EIP-3009 authorization signed, in order. */
  signed: VerifiedQuote[];
  authorizations: Eip3009Ref[];
  /** NEAR: the block time is the clock; each rescue signature writes the deposit ring; `view` false: before C10. */
  near: SimulatedNear;
  /** Solana: a sent sol_sign_rescue's signature lands. */
  solana: SimulatedSolana;
  /** Replaces 1Click's status answers from now on. */
  status: ((n: number, depositAddress: string) => StatusAnswer) | null;
  legs: Leg[];
  /** The key 1Click's quotes are signed with here. */
  signer: ReturnType<typeof testSigner>;
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
  seedCap?: boolean;
  confirms?: (venue: VenueId) => string | null;
  store?: RescueStateStore;
  /** GIMBAL_RESCUE_FRESH, as serve checked it. */
  fresh?: boolean;
  /** false: no NEAR reader is wired (the clock stands in for NEAR time, with no ring). */
  near?: boolean;
}

const venueOf = (q: VerifiedQuote): VenueId => (q.destinationAsset === ASSETS.hypercoreUsdc ? 'hyperliquid' : q.destinationAsset === ASSETS.solanaUsdc ? 'phoenix' : 'orderly');

function synthetic(o: SyntheticOptions = {}): Synthetic {
  const s: Synthetic = {
    w: undefined as unknown as World, quotes: [], sent: [], withdrawn: [], credited: [], closes: [], ledger: [],
    chain: undefined as unknown as SimulatedArbitrum, hlArrives: true, late: [], signed: [], authorizations: [], near: undefined as unknown as SimulatedNear,
    solana: undefined as unknown as SimulatedSolana,
    status: null, legs: o.legs ?? [leg('hyperliquid', 200), leg('phoenix', 200)], signer: testSigner(),
  };
  const signer = s.signer;
  const quoteSigner = o.signer ?? signer;
  let statusN = 0;
  s.w = world(({ clock }) => {
    s.chain = new SimulatedArbitrum(clock);
    s.near = new SimulatedNear(clock);
    s.solana = new SimulatedSolana(clock);
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
      // A Solana message's recent blockhash, good for 150 blocks (60 s).
      ...(method === 'sol_sign_rescue' ? { prepare: async () => ({ solana: { lastValidBlockHeight: s.solana.heightNow() + 150 } }) } : {}),
      sign: async (q) => {
        await o.sign?.();
        s.signed.push(q);
        const n = s.signed.length;
        const validBefore = Math.floor((clock.now() + (o.usableForMs ?? 300_000)) / 1000);
        let authorization: Eip3009Ref | undefined;
        if (method === 'evm_usdc_to_intents') {
          // The contract signs with the desk's next counter and moves it, as evm_usdc_to_intents does.
          authorization = { from: EVM, nonce: eip3009Nonce(rec.desk.deskId, s.near.eip3009Next), validBefore };
          s.authorizations.push(authorization);
        }
        // The rescue methods' signature writes the desk's deposit ring; fund_venue writes its own and transfers in the
        // same transaction (final at once here).
        const hash = `near-${method}-${n}`;
        if (method === 'fund_venue') {
          s.near.fundSpend(q.depositAddress);
          s.near.txs.set(hash, { final: true, paidTo: [q.depositAddress], noPay: null });
        } else {
          s.near.spend(method, q.depositAddress);
        }
        const solanaSignature = method === 'sol_sign_rescue' ? `solana-sig-${n}` : undefined;
        return {
          tx: [{ chain: 'near', id: hash, url: 'https://nearblocks.io/x' }] as TxRef[],
          ...(o.usableForMs === undefined ? {} : { usableUntilMs: clock.now() + o.usableForMs }),
          ...(authorization === undefined ? {} : { authorization }),
          ...(solanaSignature === undefined ? {} : { solanaSignature }),
          send: async () => {
            await o.send?.();
            if (solanaSignature !== undefined) s.solana.land(solanaSignature);
            s.sent.push(q);
            if (authorization !== undefined) {
              s.chain.transfer(EVM, q.depositAddress, q.amountIn);
              s.chain.markUsed(EVM, authorization.nonce);
            }
            if (o.noLanding !== true) s.ledger.push({ venue: venueOf(q), usd: Number(q.minAmountOutE8) / 1e8, id: `ledger-${q.depositAddress}` });
            return { tx: [], depositTx: `deposit-${q.depositAddress}` };
          },
        };
      },
    });
    const hlWithdraw: HlWithdrawPort = {
      withdraw: async (amountE6) => {
        s.withdrawn.push(amountE6);
        // Shows on Arbitrum 230 s later, less Hyperliquid's 1 USDC, as a Transfer from Bridge2.
        if (s.hlArrives) s.chain.transfer(HL_BRIDGE2, EVM, amountE6 - 1_000_000n, clock.now() + 230_000);
        else s.late.push(amountE6 - 1_000_000n);
        return { tx: [{ chain: 'hyperliquid', id: '0xwithdraw', url: 'https://app.hyperliquid.xyz/explorer/tx/0xwithdraw' }] };
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
      mode: 'mainnet', oneClick, keyed: true, ...(o.seedCap === undefined && o.store !== undefined ? {} : { seedCap: o.seedCap ?? false }),
      ...(o.store === undefined ? {} : { store: o.store }),
      ...(o.fresh === undefined ? {} : { fresh: o.fresh }),
      ...(o.near === false ? {} : { near: () => s.near.read(), nearTx: (h: string) => s.near.txFacts(h) }),
      solana: s.solana,
      desk: async () => ({ addresses: rec.desk, policy: rec.policy, reserveUsd: 100, closing: false, ...o.desk }),
      view: () => ({ legs: s.legs, freeMargin: o.freeMargin ?? { phoenix: 100 } }),
      landing,
      payers: { reserve: payer('fund_venue'), phoenix: payer('sol_sign_rescue'), arbitrum: payer('evm_usdc_to_intents') },
      hlWithdraw, arbitrum: s.chain, credit: { phoenix: credit },
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

/** Hyperliquid -> Phoenix with an EIP-3009 send that fails `sendFails` times (the payment is signed, not sent). */
function unsentWorld(send: () => Promise<void>) {
  return synthetic({ desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 }, reducer: true, usableForMs: 300_000, send });
}

test('a signed EIP-3009 authorization that failed to send is held until Arbitrum shows it can never run, and 1Click had 10 more minutes', async () => {
  let sendFails = true;
  const s = unsentWorld(async () => { if (sendFails) throw new Error('arbitrum rpc: connection reset'); });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.rescuer.held!, /the signed evm_usdc_to_intents of rescue a was not sent but stays usable until/);
  assert.equal(s.w.rescuer.arbitrumOwnUsd, 0, 'its Arbitrum USDC is set aside for the signed payment');
  assert.ok(s.chain.balanceNow(EVM) > 20_000_000n, 'though still on the address');
  sendFails = false;
  const aAddress = s.signed[0]!.depositAddress;
  s.status = (_n, addr) => ({ status: addr === aAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  // Past validBefore, but Arbitrum cannot be read: not taken as dead.
  s.w.t += 362_000;
  s.chain.down = 'arbitrum rpc: connection reset';
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(s.sent.length, 0, 'no second authorization');
  assert.match(s.w.rescuer.held!, /rescue a/);
  // The latest block is past validBefore and authorizationState there is false: 1Click still gets 10 minutes.
  s.chain.down = null;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'PENDING_DEPOSIT is not final yet');
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'd', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run and 1Click saw no deposit 10 min later: expired unused; its \d+\.\d\d USDC on Arbitrum is the rescuer's to spend again/.test(j)));
  assert.equal(s.w.rescuer.held, null);
  assert.deepEqual(s.w.ended.at(-1), ['d', true], 'd bridged what a had set aside');
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.w.rescuer.arbitrumOwnUsd, Number(s.chain.balanceNow(EVM)) / 1e6);
});

test('a dead authorization is read again before it is released: one used meanwhile (someone sent it) stays held', async () => {
  const s = unsentWorld(async () => { throw new Error('arbitrum rpc: connection reset'); });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  s.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  s.w.t += 362_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'read dead: the grace starts');
  // The signature was public: someone submits it after all (a reorged block, a slow relayer).
  const a = s.authorizations[0]!;
  s.chain.markUsed(a.from, a.nonce);
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'not released on the first dead read');
  assert.ok(!s.w.journal().some((j) => /expired unused/.test(j)));
  assert.equal(s.sent.length, 0);
});

test('a Phoenix payment that failed to send: dead once Solana\'s finalized height is past its lastValidBlockHeight and its signature is unknown there; then 1Click gets 10 more minutes', async () => {
  for (const view of [true, false]) {
    let sendFails = true;
    // A cap that a second rescue 20 min later fits in.
    const s = synthetic({ desk: { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } }, reducer: true, send: async () => { if (sendFails) throw new Error('solana rpc: blockhash not found'); } });
    s.near.view = view;
    const lastValid = s.solana.heightNow() + 150;
    await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /the signed sol_sign_rescue of rescue a was not sent/);
    sendFails = false;
    const q = s.signed[0]!;
    s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
    // Finalized height reaches lastValidBlockHeight: the message may still land.
    s.w.t = (lastValid + 32) * 400;
    await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a/, `${view}: not dead yet`);
    // Past it, but the status answer comes from a node behind the slot where the height passed: its "unknown"
    // proves nothing.
    s.w.t = (lastValid + 33) * 400;
    s.solana.statusLag = -1;
    await run(s.w, trigger({ id: 'b2', amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a/, `${view}: a lagging status read is no proof`);
    s.w.t += 11 * 60_000;
    await run(s.w, trigger({ id: 'b3', amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a/, `${view}: nor did it start 1Click's 10 minutes`);
    s.solana.statusLag = 0;
    // Past it, but Solana cannot be read: not taken as dead.
    s.solana.down = 'solana rpc: 503';
    await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
    s.solana.down = null;
    s.w.t += 10 * 60_000;
    await run(s.w, trigger({ id: 'd', amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a/, `${view}: 1Click gets its 10 minutes from the first dead read`);
    s.w.t += 10 * 60_000;
    await run(s.w, trigger({ id: 'e', amountUsd: 30 }));
    assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j)), String(view));
    assert.deepEqual(s.w.ended.at(-1), ['e', true]);
    assert.equal(s.sent.length, 1, 'e paid');
  }
});

test('a Phoenix payment whose signature landed on Solana, or whose signature is not known, is held however long', async () => {
  // Sent with an unknown outcome: it landed.
  const sig = synthetic({ desk: { reserveUsd: 0 }, reducer: true, send: async () => { throw new OutcomeUnknown('solana send', 'no answer', {} as OutcomeIds); } });
  await run(sig.w, trigger({ id: 'a', amountUsd: 30 }));
  sig.solana.land('solana-sig-1');
  const q = sig.signed[0]!;
  sig.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  for (const hours of [1, 5]) {
    sig.w.t += hours * 3_600_000;
    await run(sig.w, trigger({ id: `b${hours}`, amountUsd: 30 }));
    assert.match(sig.w.rescuer.held!, /rescue a/, `landed: held ${hours} h later`);
  }
  assert.equal(sig.sent.length, 0);

  // A crash while signing: no signature known; the contract counted it (the call landed after the crash).
  const store = tmpStore();
  let crashed = false;
  const s = synthetic({ store, fresh: true, seedCap: false, desk: { reserveUsd: 0 }, reducer: true, sign: () => (crashed ? Promise.resolve() : new Promise<void>(() => {})) });
  s.w.rescuer.take(trigger({ id: 'a', amountUsd: 30 }));
  await until(() => s.w.steps('a').includes('sign'));
  const hold = onDisk(store).holds[0]!;
  assert.equal(hold.quote.method, 'sol_sign_rescue');
  assert.equal(hold.solana!.signature, null);
  assert.ok(hold.solana!.lastValidBlockHeight > 0, 'saved before signing');
  crashed = true;
  s.w.restart();
  s.near.spend('sol_sign_rescue', hold.quote.depositAddress);
  s.status = (_n, addr) => ({ status: addr === hold.quote.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  for (const hours of [1, 5]) {
    s.w.t += hours * 3_600_000;
    await run(s.w, trigger({ id: `b${hours}`, amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a/, `no signature: held ${hours} h later`);
  }
  assert.equal(s.quotes.length, 1, 'no second payment');
});

test('an EIP-3009 send whose outcome is unknown is parked like an unsent one: released once Arbitrum shows it never ran, held while it ran', async () => {
  const unknown = () => { throw new OutcomeUnknown('arbitrum transferWithAuthorization', 'no receipt for 0xabc', { arbitrumTx: '0xabc' } as OutcomeIds); };
  const s = unsentWorld(async () => unknown());
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.rescuer.held!, /the evm_usdc_to_intents of rescue a may have paid .*no receipt for 0xabc.*held until 1Click settles it or it is shown never to run/);
  s.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  s.w.t += 362_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /may have paid/);
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j)), 'never ran: released');

  // The same, but the transfer did run (the receipt was lost): authorizationState is true, so it stays held.
  const ran = unsentWorld(async () => unknown());
  await run(ran.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  const a = ran.authorizations[0]!;
  ran.chain.markUsed(a.from, a.nonce);
  ran.status = () => ({ status: 'PENDING_DEPOSIT', body: null });
  ran.w.t += 30 * 60_000;
  await run(ran.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  ran.w.t += 30 * 60_000;
  await run(ran.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(ran.w.rescuer.held!, /may have paid/);
  assert.equal(ran.closes.length, 2, 'only reduces ran');
  assert.ok(ran.w.journal().some((j) => /reconcile needed: rescue a's deposit .*\(evm_usdc_to_intents, .*To clear it by hand once reconciled: holds live in memory here/.test(j)));
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
  assert.match(lines[0]!, /reconcile needed: rescue a's deposit \S+ \(fund_venue, \d+\.\d+ USDC in, at least \d+\.\d+ out to hyperliquid, NEAR tx \S+\) is SUCCESS at 1Click after \d+ min; transfers stay held/);
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

const hlWorld = (o: SyntheticOptions = {}) => {
  let refuse = false;
  const s = synthetic({
    // A cap that several Hyperliquid rescues in a row fit in (each counts about twice its size).
    desk: { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 200 },
    quote: async (body, now) => (refuse ? { ok: false, status: 400, message: 'Quoting for this pair is not available' } : { ok: true, response: testQuote(s.signer, body, now) }),
    ...o,
  });
  return { s, refuse: (r: boolean) => { refuse = r; } };
};

test('Hyperliquid USDC left on Arbitrum by a failed rescue is the rescuer\'s own and spent first; no second hl_withdraw when it covers the next', async () => {
  const { s, refuse } = hlWorld();
  refuse(true);
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.equal(s.withdrawn.length, 1);
  assert.ok(s.chain.balanceNow(EVM) > 0n, 'stranded on Arbitrum');
  assert.equal(s.w.rescuer.arbitrumOwnUsd, Number(s.chain.balanceNow(EVM)) / 1e6, 'all of it the rescuer\'s own');
  assert.equal(s.w.rescuer.hlWithdrawHeld, null, 'it arrived: nothing on its way');
  refuse(false);
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.withdrawn.length, 1, 'no second withdraw');
  assert.match(s.w.journal().join('\n'), /already on the desk's Arbitrum address \(an earlier withdraw\), no new withdraw/);
  assert.equal(s.w.rescuer.arbitrumOwnUsd, Number(s.chain.balanceNow(EVM)) / 1e6, 'what is left there is still its own');
});

test('USDC left on Arbitrum never blocks a withdraw: a short balance, however small, is topped up and bridged along', async () => {
  const { s, refuse } = hlWorld();
  refuse(true);
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 15 }));
  refuse(false);
  // b needs less than what is there: about 2 USDC stays (between 1 and 3.20: the case that used to hold forever).
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 13 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  const left = s.chain.balanceNow(EVM);
  assert.ok(left > 900_000n && left < 3_200_000n, `left ${left}`);
  assert.equal(s.w.rescuer.hlWithdrawHeld, null);
  // c needs more: one withdraw tops it up and the bridge takes both, leaving nothing of the rescuer's.
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 40 }));
  assert.deepEqual(s.w.ended.at(-1), ['c', true]);
  assert.equal(s.withdrawn.length, 2);
  assert.equal(BigInt(s.quotes.at(-1)!.amount), left / 10_000n * 10_000n + s.withdrawn[1]! - 1_000_000n, 'what was there (to the cent) and what arrived');
  assert.match(s.w.journal().join('\n'), /hl_withdraw \d+\.\d\d USDC to the desk's Arbitrum address \(1 USDC fee\), topping up the \d+\.\d\d USDC an earlier withdraw left there/);
  assert.ok(s.w.rescuer.arbitrumOwnUsd < 0.01);
});

test('a withdraw on its way holds the next withdraw, also after a bridge of other USDC lands; 30 min later: reconcile needed, once', async () => {
  const { s, refuse } = hlWorld();
  refuse(true);
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 15 }));
  const own = s.chain.balanceNow(EVM);
  refuse(false);
  s.hlArrives = false;   // Hyperliquid accepts the next withdraw; it does not show on Arbitrum
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 40 }));
  assert.match(s.w.failures.at(-1)!.reason, /did not reach the desk's Arbitrum address/);
  assert.equal(s.withdrawn.length, 2);
  assert.match(s.w.rescuer.hlWithdrawHeld!, /rescue b's hl_withdraw .* not yet seen/);
  // c fits in what a left there: bridged and landed, and b's withdraw still holds the next one.
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 10 }));
  assert.deepEqual(s.w.ended.at(-1), ['c', true]);
  assert.ok(s.chain.balanceNow(EVM) < own);
  assert.match(s.w.rescuer.hlWithdrawHeld ?? '', /rescue b's hl_withdraw/, 'a landed bridge does not end a withdraw on its way');
  await run(s.w, trigger({ id: 'd', venue: 'phoenix', amountUsd: 40 }));
  assert.equal(s.withdrawn.length, 2, 'no second withdraw while one is on its way');
  assert.match(s.w.journal().join('\n'), /no new hl_withdraw: rescue b's hl_withdraw/);
  s.hlArrives = true;
  s.w.t += 30 * 60_000;
  await run(s.w, trigger({ id: 'e', venue: 'phoenix', amountUsd: 40 }));
  await run(s.w, trigger({ id: 'f', venue: 'phoenix', amountUsd: 40 }));
  const lines = s.w.journal().filter((j) => /reconcile needed: rescue b's hl_withdraw/.test(j));
  assert.equal(lines.length, 1, 'said once');
  assert.match(lines[0]!, /is not on the desk's Arbitrum address after \d+ min; it is no longer taken as on its way/);
  assert.ok(s.w.logs.some((l) => /reconcile needed: rescue b's hl_withdraw/.test(l)));
  assert.ok(s.withdrawn.length >= 3, 'withdraws run again');
});

test('a withdraw on its way that shows up late counts as the rescuer\'s own then', async () => {
  const { s } = hlWorld();
  s.hlArrives = false;
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(s.w.rescuer.arbitrumOwnUsd, 0);
  s.hlArrives = true;
  s.chain.transfer(HL_BRIDGE2, EVM, s.late[0]!);   // it lands now, 15 min late
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's hl_withdraw reached the desk's Arbitrum address late/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.withdrawn.length, 1, 'b bridged a\'s USDC with no withdraw of its own');
});

test('USDC of other flows on the desk\'s Arbitrum address is never spent; the own count never exceeds the balance', async () => {
  const { s, refuse } = hlWorld();
  // 50 USDC of an Orderly money-out (or the owner's return) sits on the address before any rescue.
  s.chain.transfer(ONECLICK_ARB, EVM, 50_000_000n);
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended, [['a', true]]);
  assert.equal(s.withdrawn.length, 1, 'withdrawn, though 50 USDC was there');
  assert.equal(BigInt(s.quotes[0]!.amount), s.withdrawn[0]! - 1_000_000n, 'only what its own withdraw brought');
  assert.equal(s.chain.balanceNow(EVM), 50_000_000n, 'the other flow\'s USDC is untouched');
  assert.equal(s.w.rescuer.arbitrumOwnUsd, 0);
  // A failed bridge leaves its own USDC there; then someone else takes most of the address's balance.
  refuse(true);
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.rescuer.arbitrumOwnUsd > 20);
  s.chain.setBalance(EVM, 2_000_000n);
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  refuse(false);
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /holds 2.00 USDC, less than the \d+\.\d\d the rescuer counted as its own \(moved by someone else\)/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['c', true]);
  // c counted only the 2 USDC left as its own and topped that up.
  assert.equal(BigInt(s.quotes.at(-1)!.amount), 2_000_000n + s.withdrawn.at(-1)! - 1_000_000n);
  assert.ok(s.w.rescuer.arbitrumOwnUsd < 0.01);
});

test('a 1Click refund landing back on Arbitrum is never the rescuer\'s own: not spent, and not taken for a withdraw of the same amount', async () => {
  // No withdraw in flight: a bridge 1Click refunds; the refund comes back from 1Click, not from Bridge2.
  const { s } = hlWorld();
  s.status = () => ({ status: 'REFUNDED', body: null });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.failures.at(-1)!.reason, /1Click ended the transfer REFUNDED: the refund goes back to the desk's Arbitrum address \(not counted as the rescuer's own/);
  const refunded = BigInt(s.quotes[0]!.amount);
  s.chain.transfer(ONECLICK_ARB, EVM, refunded);
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  s.status = null;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.withdrawn.length, 2, 'b withdrew again rather than spend the refund');
  assert.equal(s.chain.balanceNow(EVM), refunded, 'the refund is still there for the owner');
  assert.equal(s.w.rescuer.arbitrumOwnUsd, 0);

  // A withdraw in flight, and a refund of exactly what it would bring lands first: still on its way.
  const { s: f, refuse } = hlWorld();
  f.hlArrives = false;
  refuse(true);
  await run(f.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.match(f.w.rescuer.hlWithdrawHeld!, /rescue a's hl_withdraw/);
  const expected = f.late[0]!;
  f.chain.transfer(ONECLICK_ARB, EVM, expected);
  f.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  await run(f.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(f.w.rescuer.hlWithdrawHeld!, /rescue a's hl_withdraw/, 'the same amount from 1Click is not the withdraw');
  assert.equal(f.w.rescuer.arbitrumOwnUsd, 0);
  // The withdraw's own Bridge2 Transfer lands: only that counts.
  f.chain.transfer(HL_BRIDGE2, EVM, expected);
  f.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  refuse(false);
  await run(f.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(f.w.journal().some((j) => /rescue a's hl_withdraw reached the desk's Arbitrum address late/.test(j)));
  assert.deepEqual(f.w.ended.at(-1), ['c', true]);
  assert.equal(f.withdrawn.length, 1, 'c bridged the withdraw\'s USDC, not a new one');
  assert.equal(f.chain.balanceNow(EVM), 2n * expected - BigInt(f.quotes.at(-1)!.amount));
  assert.ok(f.chain.balanceNow(EVM) >= expected, 'the refund is untouched');
});

test('an Arbitrum balance that cannot be read stops the Hyperliquid source and is not taken as empty', async () => {
  const { s, refuse } = hlWorld({ reducer: true });
  refuse(true);
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  const own = s.w.rescuer.arbitrumOwnUsd;
  assert.ok(own > 0);
  refuse(false);
  s.chain.down = 'arbitrum rpc: connection reset';
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.journal().join('\n'), /hyperliquid: the desk's Arbitrum USDC could not be read/);
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.quotes.length, 1, 'no bridge either');
  assert.equal(s.w.rescuer.arbitrumOwnUsd, own, 'an unread balance changes nothing');
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

test('a withdraw that never showed: its Hyperliquid tx in the reconcile line, and no new withdraw brings its exact amount, so its late Transfer is never taken for the new one', async () => {
  const { s } = hlWorld();
  s.hlArrives = false;
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  const first = s.withdrawn[0]!;
  s.w.t += 30 * 60_000;
  s.hlArrives = true;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  const line = s.w.journal().find((j) => /reconcile needed: rescue a's hl_withdraw/.test(j))!;
  assert.match(line, /accepted at \S+, Hyperliquid tx 0xwithdraw\)/);
  assert.match(line, /for 24 h no new withdraw brings that exact amount/);
  assert.equal(s.withdrawn.length, 2);
  assert.equal(s.withdrawn[1], first + 10_000n, 'a cent more than the one that never showed');
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  // a's Transfer shows at last: said once, not the rescuer's own, and no longer reserving its amount.
  s.chain.transfer(HL_BRIDGE2, EVM, s.late[0]!);
  s.w.t += 2_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's hl_withdraw \(\d+\.\d\d USDC\) reached the desk's Arbitrum address after it was given up \(log \S+\): not counted as the rescuer's own/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['c', true]);
  assert.ok(s.w.rescuer.arbitrumOwnUsd < 0.01, 'c bridged only its own withdraw');
  assert.ok(s.chain.balanceNow(EVM) >= s.late[0]!, 'a\'s late USDC stays for the owner');
});

test('get_desk naming another desk EVM address mid-run holds every transfer until a restart (the Arbitrum state is the old address\'s)', async () => {
  let evm = rec.desk.evm;
  const s = synthetic({ reducer: true, desk: { get addresses() { return { ...rec.desk, evm }; } } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['a', true]);
  evm = '0x00000000000000000000000000000000000000e2';
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /get_desk names the desk EVM address 0x0+e2, not 0x[0-9a-f]{40} that this rescuer's Arbitrum state belongs to; every transfer is held until the engine is restarted/);
  assert.equal(s.sent.length, 1, 'b only reduced');
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.w.logs.filter((l) => /get_desk names the desk EVM address/.test(l)).length, 1);
});

test('the rescue sizes: logged at the first rescue, and named in the journal when a rescue ends in a reduce', async () => {
  const s = synthetic({ reducer: true });
  await run(s.w, trigger({ amountUsd: 1.5 }));
  assert.ok(s.w.logs.some((l) => /^rescue sizes at this desk's policy \(50 USD an hour, \d+ bps, \d+\.\d\d USD flat\): reserve -> hyperliquid from \d+\.\d\d USD, .*hyperliquid -> phoenix .*; a smaller rescue reduces both legs instead$/.test(l)));
  assert.match(s.w.journal()[0]!, /rescue sizes at this policy: reserve -> hyperliquid from \d+\.\d\d USD, phoenix -> hyperliquid from \d+\.\d\d to \d+\.\d\d USD\)$/);
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

// ---- the state file: holds and counters across restarts ----

const ID: RescueIdentity = { contractId: rec.desk.contract, deskId: rec.desk.deskId, evm: EVM };
const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'gimbal-rescue-')), 'rescue-mainnet-alpha.json');
const tmpStore = () => new RescueStateStore(tmpPath(), ID);
interface OnDisk {
  holds: {
    paying: boolean; status: string | null; authorization: unknown; arbBlock: string | null; scannedTo: string | null; paidLog: string | null;
    counter: string | null; nearTx: string | null; solana: { lastValidBlockHeight: number; signature: string | null } | null; creditBaseE6?: string | null; creditStarted?: boolean;
    quote: { method: string; depositAddress: string; deadlineMs: number; signedAtMs: number };
  }[];
  unknown: string | null;
  hl: { strandedE6: string; inFlight: { tx: TxRef[] } | null; expired: { rescueId: string; tx: TxRef[] }[] };
  cap: unknown[];
}
const onDisk = (store: RescueStateStore) => JSON.parse(readFileSync(store.path, 'utf8')) as OnDisk;

/** Lets a run go on until `done` (a run left hanging in a payment, as a crash would). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(done(), 'the run got there');
}

test('state: a first run (GIMBAL_RESCUE_FRESH) writes an empty state and starts the cap full; a held transfer and the cap meter survive a restart, and the loaded hold is read again before the next plan', async () => {
  const store = tmpStore();
  const s = synthetic({ store, fresh: true, reducer: true, noLanding: true, status: () => ({ status: 'PROCESSING', body: null }) });
  assert.ok(s.w.logs.some((l) => /rescuer first run \(GIMBAL_RESCUE_FRESH\): there is no state file at .*rescue-mainnet-alpha\.json, so an empty one is written now.*cap counts as used in full/.test(l)));
  assert.ok(existsSync(store.path), 'written at once');
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.match(s.w.journal()[0]!, /rescuer started at .*a first run \(GIMBAL_RESCUE_FRESH=\S+\/alpha\).*cap counts as used in full \(50 USD\)/);
  assert.match(s.w.rescuer.held!, /rescue a's transfer to \S+ is PROCESSING at 1Click/);
  const saved = onDisk(store);
  assert.equal(saved.holds.length, 1);
  assert.equal(saved.holds[0]!.paying, false);
  assert.equal(saved.holds[0]!.status, 'PROCESSING');
  const capBefore = s.w.rescuer.capUsed();
  assert.ok(capBefore > 40);

  const again = s.w.restart();
  assert.ok(s.w.logs.some((l) => /rescuer state loaded from .*: 1 held transfer\(s\), 0\.00 USDC of its own on Arbitrum, \d+\.\d\d USD of the rescue cap used; each hold is read again.*GIMBAL_RESCUE_FRESH is ignored: a state file exists/.test(l)));
  assert.match(again.held!, /rescue a's transfer to \S+ is PROCESSING at 1Click/);
  assert.ok(Math.abs(again.capUsed() - capBefore) < 1e-6, 'the cap meter is the saved one, not seeded full again');
  // Still processing: only a reduce runs, and no second "cap counts as used in full".
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.sent.length, 1);
  assert.equal(s.w.journal().filter((j) => /rescuer started at/.test(j)).length, 1);
  // 1Click delivers and the ledger shows it: the loaded hold settles before the next plan, which pays.
  s.status = () => ({ status: 'SUCCESS', body: null });
  s.ledger.push({ venue: 'hyperliquid', usd: 31, id: 'late-delivery' });
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  assert.ok(s.w.journal().some((j) => /rescue a's 31.00 USD landed on hyperliquid late/.test(j)));
  assert.equal(s.sent.length, 2, 'c paid');
});

test('state: a missing file after a hold existed (another checkout, a git clean) holds every transfer, reduces still run; a fresh start only on GIMBAL_RESCUE_FRESH', async () => {
  const store = tmpStore();
  const s = synthetic({ store, fresh: true, seedCap: false, reducer: true, noLanding: true, status: () => ({ status: 'PROCESSING', body: null }) });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.equal(onDisk(store).holds.length, 1, 'a hold is parked on disk');
  unlinkSync(store.path);
  // Started again without the file, and without FRESH: nothing is known, so nothing pays.
  const again = s.w.restart({ fresh: false, seedCap: true });
  assert.ok(s.w.logs.some((l) => /rescuer state missing: there is no file at .*rescue-mainnet-alpha\.json\. A missing file is not taken as a first run.*every transfer is held \(only reduces run\).*start once with GIMBAL_RESCUE_FRESH=\S+\/alpha/.test(l)));
  assert.match(again.held!, /state file could not be used \(there is no state file at .*\).*GIMBAL_RESCUE_FRESH=\S+\/alpha/);
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.equal(s.quotes.length, 1, 'no second payment');
  assert.deepEqual(s.w.ended.at(-1), ['b', true], 'a reduce ran');
  assert.match(s.w.journal().find((j) => /rescuer started at/.test(j))!, /there is no state file .*every transfer is held until the owner starts once with GIMBAL_RESCUE_FRESH=\S+\/alpha/);
  assert.ok(!existsSync(store.path), 'nothing written in its place');
  // The owner reconciled: FRESH starts from an empty state.
  const fresh = s.w.restart({ fresh: true, seedCap: false });
  assert.equal(fresh.held, null);
  assert.ok(existsSync(store.path));
});

test('state: a file of another desk or contract at the same path is unusable: transfers held, the file left as it is', async () => {
  const path = tmpPath();
  const s = synthetic({ store: new RescueStateStore(path, ID), fresh: true, seedCap: false, reducer: true });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  const text = readFileSync(path, 'utf8');
  for (const other of [{ ...ID, deskId: 'beta' }, { ...ID, contractId: 'other.near' }]) {
    const again = s.w.restart({ store: new RescueStateStore(path, other), fresh: true });
    assert.match(again.held!, new RegExp(`belongs to contract ${ID.contractId.replace('.', '\\.')}, desk alpha`));
    assert.ok(s.w.logs.some((l) => /rescuer state unusable: .*belongs to contract/.test(l)));
    await run(s.w, trigger({ id: `b-${other.deskId}-${other.contractId}`, amountUsd: 30 }));
    assert.equal(s.quotes.length, 1, 'no transfer');
    assert.equal(readFileSync(path, 'utf8'), text, 'left for the owner');
  }
});

test('state: the unknown outcome, the rescuer\'s own Arbitrum USDC and a withdraw on its way survive a restart', async () => {
  const store = tmpStore();
  const { s, refuse } = hlWorld({ store, fresh: true, seedCap: false });
  refuse(true);
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  const own = s.w.rescuer.arbitrumOwnUsd;
  assert.ok(own > 20);
  s.hlArrives = false;   // the next withdraw never shows
  refuse(false);
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 40 }));
  assert.ok(s.w.rescuer.hlWithdrawHeld !== null);
  const cap = s.w.rescuer.capUsed();
  assert.ok(onDisk(store).hl.inFlight !== null);
  const again = s.w.restart();
  assert.equal(again.arbitrumOwnUsd, own);
  assert.match(again.hlWithdrawHeld!, /rescue b's hl_withdraw/);
  assert.ok(Math.abs(again.capUsed() - cap) < 1e-6);
  assert.ok(s.w.logs.some((l) => /an hl_withdraw of rescue b on its way/.test(l)));
  // Its Bridge2 Transfer shows after the restart: found from the saved block.
  s.chain.transfer(HL_BRIDGE2, EVM, s.late[0]!);
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue b's hl_withdraw reached the desk's Arbitrum address late/.test(j)));

  const u = synthetic({ store: tmpStore(), fresh: true, seedCap: false, reducer: true, sign: async () => { throw new OutcomeUnknown('fund_venue', 'sent, no answer', {} as OutcomeIds); } });
  await run(u.w, trigger({ id: 'a', amountUsd: 30 }));
  const restarted = u.w.restart();
  assert.match(restarted.held!, /the fund_venue of rescue a may have been signed or paid/);
  await run(u.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.equal(u.quotes.length, 1, 'still held after the restart: only a reduce ran');
});

test('state: a crash while signing fund_venue: held after the restart; released only once NEAR time is past the pay bound and the fund_venue ring lacks it', async () => {
  const store = tmpStore();
  let crashed = false;
  const s = synthetic({ store, fresh: true, seedCap: false, reducer: true, sign: () => (crashed ? Promise.resolve() : new Promise<void>(() => {})) });
  s.w.rescuer.take(trigger({ id: 'a', amountUsd: 30 }));
  await until(() => s.w.steps('a').includes('sign'));
  const saved = onDisk(store);
  assert.equal(saved.holds.length, 1, 'saved before the signature was asked for');
  assert.equal(saved.holds[0]!.paying, true);
  assert.equal(saved.holds[0]!.nearTx, null, 'no transaction known');
  // The engine dies here; a new one starts on the same file.
  crashed = true;
  const again = s.w.restart();
  assert.match(again.held!, /rescue a was paying \S+ \(fund_venue\) when the engine stopped: it may have been signed or sent/);
  const q = saved.holds[0]!.quote;
  const payable = Math.min(q.deadlineMs, q.signedAtMs + 3_600_000);
  s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.equal(s.quotes.length, 1, 'no second payment');
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  // Before the pay bound the call may still land: held.
  s.w.t = payable - 60_000;
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /rescue a was paying/);
  s.w.t = payable + 61_000;
  await run(s.w, trigger({ id: 'd', amountUsd: 30 }));
  assert.ok(s.w.journal().some((j) => /rescue a's fund_venue was never signed: the desk's fund_venue ring on NEAR does not hold/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['d', true]);
  assert.equal(s.quotes.length, 2, 'd paid');
});

test('state: a fund_venue the ring counted, with no transaction known, stays held however long: time alone never releases it', async () => {
  const store = tmpStore();
  let crashed = false;
  const s = synthetic({ store, fresh: true, seedCap: false, reducer: true, sign: () => (crashed ? Promise.resolve() : new Promise<void>(() => {})) });
  s.w.rescuer.take(trigger({ id: 'a', amountUsd: 30 }));
  await until(() => s.w.steps('a').includes('sign'));
  const q = onDisk(store).holds[0]!.quote;
  crashed = true;
  s.w.restart();
  // The call sent before the crash lands: the ring counts it, its transfer may run late.
  s.near.fundSpend(q.depositAddress);
  s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  for (const [i, hours] of [1, 3, 30].entries()) {
    s.w.t = q.signedAtMs + hours * 3_600_000;
    await run(s.w, trigger({ id: `b${i}`, amountUsd: 30 }));
    assert.match(s.w.rescuer.held!, /rescue a was paying/, `held ${hours} h later`);
  }
  assert.equal(s.quotes.length, 1, 'no second payment');
  assert.ok(s.w.journal().some((j) => /reconcile needed: rescue a's deposit/.test(j)));
});

test('state: an unknown fund_venue outcome with its transaction known: released only on proof it paid nothing, never on a missing log or on time', async () => {
  const proof = 'on_fund_venue returned false: the transfer failed and the USDC is back in idle_usdc';
  const cases: { name: string; facts: (addr: string) => NearTxFacts | null; released: boolean }[] = [
    { name: 'final, on_fund_venue false', facts: () => ({ final: true, paidTo: [], noPay: proof }), released: true },
    { name: 'final, no transfer log and no proof', facts: () => ({ final: true, paidTo: [], noPay: null }), released: false },
    { name: 'final, a transfer to the deposit (any amount)', facts: (addr) => ({ final: true, paidTo: [addr], noPay: null }), released: false },
    { name: 'final, a transfer to the deposit beside a proof', facts: (addr) => ({ final: true, paidTo: [addr], noPay: proof }), released: false },
    { name: 'not final yet, with a proof so far', facts: () => ({ final: false, paidTo: [], noPay: proof }), released: false },
  ];
  for (const c of cases) {
    const store = tmpStore();
    const s = synthetic({ store, fresh: true, seedCap: false, reducer: true, sign: async () => {
      throw new OutcomeUnknown('fund_venue', 'sent, no answer', {} as OutcomeIds, [{ chain: 'near', id: 'tx-lost', url: 'https://nearblocks.io/x' }]);
    } });
    await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
    const hold = onDisk(store).holds[0]!;
    assert.equal(hold.nearTx, 'tx-lost', c.name);
    const q = hold.quote;
    const f = c.facts(q.depositAddress);
    if (f !== null) s.near.txs.set('tx-lost', f);
    s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
    s.w.t = c.released ? q.signedAtMs + 60_000 : q.signedAtMs + 30 * 3_600_000;
    await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
    if (c.released) {
      assert.ok(s.w.journal().some((j) => /rescue a's fund_venue transaction tx-lost is final and paid nothing to \S+ \(on_fund_venue returned false/.test(j)), c.name);
      assert.equal(s.quotes.length, 2, `${c.name}: b paid`);
    } else {
      assert.match(s.w.rescuer.held!, /fund_venue of rescue a may have been signed or paid|rescue a was paying/, c.name);
      assert.equal(s.quotes.length, 1, `${c.name}: no second payment`);
    }
  }
  // Its transaction unknown to NEAR (never included): the ring decides, past the pay bound.
  const store = tmpStore();
  const s = synthetic({ store, fresh: true, seedCap: false, reducer: true, sign: async () => {
    throw new OutcomeUnknown('fund_venue', 'sent, no answer', {} as OutcomeIds, [{ chain: 'near', id: 'tx-never', url: 'https://nearblocks.io/x' }]);
  } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  const q = onDisk(store).holds[0]!.quote;
  s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  s.w.t = Math.min(q.deadlineMs, q.signedAtMs + 3_600_000) + 61_000;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.ok(s.w.journal().some((j) => /rescue a's fund_venue was never signed/.test(j)));
});

/** Hyperliquid -> Phoenix on a state file, the EIP-3009 sign never answering (a crash while signing), then a restart. */
async function crashWhileSigning(view = true) {
  const store = tmpStore();
  let crashed = false;
  const { s } = hlWorld({ store, fresh: true, seedCap: false, reducer: true, sign: () => (crashed ? Promise.resolve() : new Promise<void>(() => {})) });
  s.near.view = view;
  s.w.rescuer.take(trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  await until(() => s.w.steps('a').filter((x) => x === 'sign').length === 2);
  const saved = onDisk(store).holds[0]!;
  crashed = true;
  const again = s.w.restart();
  const q = saved.quote;
  s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  return { s, store, saved, again, payable: Math.min(q.deadlineMs, q.signedAtMs + 3_600_000) };
}

test('state: a crash while signing an EIP-3009 payment: never signed once NEAR time is past the quote\'s pay bound and the ring lacks it; without the view, dead 15 min after on Arbitrum', async () => {
  for (const view of [true, false]) {
    const { s, store, saved, again, payable } = await crashWhileSigning(view);
    assert.equal(saved.paying, true);
    assert.ok(saved.arbBlock !== null, 'the Arbitrum block before signing');
    assert.equal(BigInt(onDisk(store).hl.strandedE6), 0n, 'its Arbitrum USDC set aside');
    assert.match(again.held!, /rescue a was paying \S+ \(evm_usdc_to_intents\)/);
    const ranges: [bigint, bigint][] = [];
    const read = s.chain.transfers.bind(s.chain);
    s.chain.transfers = async (from, to, a, b) => {
      if (to.toLowerCase() === saved.quote.depositAddress.toLowerCase()) ranges.push([a, b]);
      return read(from, to, a, b);
    };
    await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
    assert.match(again.held!, /rescue a/, 'too soon either way');
    if (view) {
      // A NEAR call sent before the crash may land until the pay bound: held up to a minute past it.
      s.w.t = payable + 30_000;
      await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
      assert.match(s.w.rescuer.held!, /rescue a/, 'within the margin');
      s.w.t = payable + 61_000;
      await run(s.w, trigger({ id: 'c2', venue: 'phoenix', amountUsd: 20 }));
      assert.ok(s.w.journal().some((j) => /rescue a's evm_usdc_to_intents was never signed: the desk's deposit ring on NEAR does not hold \S+, and the contract signs that quote only until .*its \d+\.\d\d USDC on Arbitrum is the rescuer's to spend again/.test(j)));
    } else {
      // No ring: the latest signature possible is just before the pay bound, so 15 min past it on Arbitrum, no Transfer.
      s.w.t = payable + 14 * 60_000;
      await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
      assert.match(s.w.rescuer.held!, /rescue a/);
      s.w.t = payable + 15 * 60_000 + 2_000;
      await run(s.w, trigger({ id: 'c2', venue: 'phoenix', amountUsd: 20 }));
      assert.match(s.w.rescuer.held!, /rescue a/, '1Click still gets its 10 minutes');
      s.w.t += 10 * 60_000;
      await run(s.w, trigger({ id: 'c3', venue: 'phoenix', amountUsd: 20 }));
      assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused; its \d+\.\d\d USDC on Arbitrum is the rescuer's to spend again/.test(j)));
      // Each pass read only the blocks after the last one.
      assert.ok(ranges.length >= 3, `${ranges.length} reads`);
      for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]![0], ranges[i - 1]![1] + 1n, 'from the block after the last read');
      assert.equal(ranges[0]![0], BigInt(saved.arbBlock!));
    }
    assert.equal(s.w.rescuer.held, null);
    assert.deepEqual(s.w.ended.at(-1)![1], true, s.w.failures.at(-1)?.reason);
    assert.equal(s.withdrawn.length, 1, 'with no second withdraw');
  }
});

test('state: a sign that lands late (a congested NEAR call, after the engine gave up): held while it may, then by the ring; once it ran, held for 1Click', async () => {
  // Lands before the pay bound and is never sent: dead 300 s + 60 s after the ring says it was signed.
  const quiet = await crashWhileSigning();
  quiet.s.w.t = quiet.payable - 5 * 60_000;
  await run(quiet.s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(quiet.s.w.rescuer.held!, /rescue a/, 'it may still land');
  const paidAt = quiet.s.w.t;
  quiet.s.near.spend('evm_usdc_to_intents', quiet.saved.quote.depositAddress);
  quiet.s.w.t = paidAt + 362_000;
  await run(quiet.s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(quiet.s.w.rescuer.held!, /rescue a/, 'past the pay bound, but the ring holds it: signed, so 1Click gets its 10 minutes');
  assert.ok(!quiet.s.w.journal().some((j) => /never signed/.test(j)));
  quiet.s.w.t += 10 * 60_000;
  await run(quiet.s.w, trigger({ id: 'd', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(quiet.s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j)));

  // Lands, and someone submits the public authorization: the Transfer to the deposit address holds it however late.
  const ran = await crashWhileSigning();
  ran.s.w.t = ran.payable - 5 * 60_000;
  ran.s.near.spend('evm_usdc_to_intents', ran.saved.quote.depositAddress);
  ran.s.chain.transfer(EVM, ran.saved.quote.depositAddress, 20_000_000n);
  ran.s.w.t += 3 * 3_600_000;
  await run(ran.s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  ran.s.w.t += 3_600_000;
  await run(ran.s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.match(ran.s.w.rescuer.held!, /rescue a was paying/);
  assert.ok(onDisk(ran.store).holds[0]!.paidLog !== null, 'the Transfer is kept on disk');
  assert.equal(ran.s.quotes.length, 1, 'no second payment');
  assert.ok(ran.s.w.journal().some((j) => /reconcile needed: rescue a's deposit/.test(j)));
});

test('state: another signer moving the EIP-3009 counter (and using that nonce) decides nothing: the ring and the Transfer logs do', async () => {
  const { s, payable } = await crashWhileSigning();
  // hl-return (or another engine) signed and used counter 0 for another deposit address.
  s.near.spend('evm_usdc_to_intents', '0x00000000000000000000000000000000000000d1');
  s.chain.markUsed(EVM, eip3009Nonce(rec.desk.deskId, 0n));
  s.chain.transfer(EVM, '0x00000000000000000000000000000000000000d1', 1_000_000n);
  s.w.t += 2_000;   // the head the rescuer reads trails the latest block by 5
  s.w.t = payable - 60_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/);
  s.w.t = payable + 61_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's evm_usdc_to_intents was never signed/.test(j)), 'its address is not in the ring');
  assert.deepEqual(s.w.ended.at(-1), ['c', true]);
});

test('state: a ring that turned over since the hold (32 later rescues) proves nothing: the no-view bound applies', async () => {
  const { s, payable } = await crashWhileSigning();
  for (let i = 0; i < 32; i++) s.near.spend('evm_usdc_to_intents', `0x${(i + 1).toString(16).padStart(40, '0')}`, s.w.t + 1_000);
  s.w.t = payable + 61_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'not taken as never signed');
  s.w.t = payable + 15 * 60_000 + 2_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'd', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j)));
});

test('a withdraw that never showed, with no room left under the cap for a cent more: the next withdraw is a cent less', async () => {
  for (const [spare, bump] of [[0.005, -10_000n], [0.025, 10_000n]] as const) {
    const desk = { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } };
    const { s } = hlWorld({ desk });
    s.hlArrives = false;
    await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
    const first = s.withdrawn[0]!;
    s.w.t += 30 * 60_000;
    s.hlArrives = true;
    // b plans what a planned: the withdraw plus the bridge of what it brings (1 USDC less) count, and `spare` is left
    // over; a cent more fits only in 0.025.
    const cap = s.w.rescuer.capUsed() + (2 * Number(first) / 1e6 - 1) + spare;
    desk.policy = { ...desk.policy, rescue_cap_usd_per_hour: cap };
    await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
    assert.equal(s.withdrawn.length, 2, s.w.failures.at(-1)?.reason);
    assert.equal(s.withdrawn[1], first + bump, `${spare} USD spare`);
    assert.ok(s.w.rescuer.capUsed() <= cap + 1e-9, 'the cap holds');
  }
});

test('a withdraw that never showed, no room for a cent more and a cent less under the operator minimum: not bumped down, the rescue fails at source and says why', async () => {
  const desk = { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } };
  const { s } = hlWorld({ desk });
  s.hlArrives = false;
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  const first = s.withdrawn[0]!;
  s.w.t += 30 * 60_000;
  s.hlArrives = true;
  // The minimum is 10 x the flat cost: a flat cost of a tenth of the first withdraw puts a cent less under it.
  const cap = s.w.rescuer.capUsed() + (2 * Number(first) / 1e6 - 1) + 0.005;
  desk.policy = { ...desk.policy, rescue_cap_usd_per_hour: cap, max_transfer_cost_flat_e6: Number(first) / 10 };
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(s.withdrawn.length, 1, 'no second hl_withdraw');
  assert.equal(s.w.failures.at(-1)?.step, 'source');
  assert.match(s.w.failures.at(-1)!.reason, /under the operator's minimum of \d+\.\d\d USDC, so it is not bumped down/);
  assert.ok(s.w.logs.some((l) => /^rescue b: no hl_withdraw near .* so it is not bumped down$/.test(l)));
});

test('the operator minimum withdraw is max(10 x the flat cost, 10 USDC)', () => {
  assert.equal(operatorMinWithdrawE6(1_000_000), 10_000_000n);
  assert.equal(operatorMinWithdrawE6(500_000), 10_000_000n);
  assert.equal(operatorMinWithdrawE6(2_500_000), 25_000_000n);
});

test('INCOMPLETE_DEPOSIT keeps the hold: what arrived waits at 1Click for its refund, and only a refund ends it', async () => {
  const s = synthetic({ reducer: true, status: () => ({ status: 'INCOMPLETE_DEPOSIT', body: null }) });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.deepEqual(s.w.ended, [['a', false]]);
  assert.match(s.w.rescuer.held!, /rescue a's deposit \S+ is INCOMPLETE_DEPOSIT at 1Click/);
  // Read again at the next plan: still INCOMPLETE_DEPOSIT, still held.
  s.w.t += 40 * 60_000;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.sent.length, 1, 'no second payment');
  assert.match(s.w.rescuer.held!, /rescue a/);
  assert.ok(!s.w.journal().some((j) => /rescue a's transfer ended/.test(j)));
  s.status = () => ({ status: 'REFUNDED', body: null });
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  assert.ok(s.w.journal().some((j) => /rescue a's transfer ended REFUNDED at 1Click/.test(j)));
  assert.equal(s.sent.length, 2, 'c paid');
});

test('state: an EIP-3009 hold with no authorization in hand stays held while any nonce from its counter read before signing up to eip3009_next is used', async () => {
  for (const used of [true, false]) {
    const { s, saved, payable } = await crashWhileSigning();
    assert.equal(saved.counter, '0', 'eip3009_next read before signing');
    // The ring turned over (it proves nothing) and the counter moved: the logs alone would say nothing ran.
    for (let i = 0; i < 32; i++) s.near.spend('evm_usdc_to_intents', `0x${(i + 1).toString(16).padStart(40, '0')}`, s.w.t + 1_000);
    if (used) s.chain.markUsed(EVM, eip3009Nonce(rec.desk.deskId, 7n));
    s.w.t = payable + 15 * 60_000 + 2_000;
    await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
    s.w.t += 10 * 60_000;
    await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
    const expired = s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j));
    assert.equal(expired, !used, `nonce used: ${used}`);
    if (used) assert.match(s.w.rescuer.held!, /rescue a/);
  }
});

test('state: a signed EIP-3009 authorization saved before a crash is told dead after the restart from Arbitrum; its USDC is the rescuer\'s again', async () => {
  const store = tmpStore();
  let crashed = false;
  const { s } = hlWorld({ store, fresh: true, seedCap: false, reducer: true, usableForMs: 300_000, send: () => (crashed ? Promise.resolve() : new Promise<void>(() => {})) });
  s.w.rescuer.take(trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  await until(() => s.w.steps('a').filter((x) => x === 'deposit').length === 2);
  const saved = onDisk(store);
  assert.equal(saved.holds.length, 1);
  assert.ok(saved.holds[0]!.authorization !== null, 'the authorization is on disk');
  assert.equal(BigInt(saved.hl.strandedE6), 0n, 'its Arbitrum USDC set aside');
  crashed = true;
  const again = s.w.restart();
  assert.match(again.held!, /rescue a was paying/);
  assert.equal(again.arbitrumOwnUsd, 0);
  // a's deposit address never sees a deposit; any later transfer settles.
  const aAddress = saved.holds[0]!.quote.depositAddress;
  s.status = (_n, addr) => ({ status: addr === aAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  s.w.t += 362_000;
  await run(s.w, trigger({ id: 'b', venue: 'phoenix', amountUsd: 20 }));
  assert.match(again.held!, /rescue a/, 'PENDING_DEPOSIT is not final for 10 more minutes');
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'c', venue: 'phoenix', amountUsd: 20 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused; its \d+\.\d\d USDC on Arbitrum is the rescuer's to spend again/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['c', true], s.w.failures.at(-1)?.reason);
  assert.equal(s.withdrawn.length, 1, 'with no second withdraw');
});

test('state: an unusable file is never "no holds": every transfer is held, the cap starts full, and the file is left as it is', async () => {
  for (const text of ['{"version":1,"holds":[', JSON.stringify({ version: 1, identity: ID, savedAt: 0, unknown: null, holds: [{ why: 'x' }], hl: { strandedE6: '0', inFlight: null }, cap: [], seen: [] })]) {
    const store = tmpStore();
    writeFileSync(store.path, text, 'utf8');
    const s = synthetic({ store, fresh: true, reducer: true });
    assert.ok(s.w.logs.some((l) => /rescuer state unusable: .*rescue-mainnet-alpha\.json is not a rescuer state this engine wrote: .*It is not taken as "no holds": every transfer is held/.test(l)));
    assert.match(s.w.rescuer.held!, /state file could not be used/);
    await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
    assert.equal(s.quotes.length, 0, 'no transfer');
    assert.equal(s.closes.length, 1, 'a reduce still runs');
    assert.match(s.w.journal()[0]!, /its state file could not be used, so every transfer is held/);
    assert.ok(s.w.rescuer.capUsed() > 40, 'the cap counts as used in full');
    assert.equal(readFileSync(store.path, 'utf8'), text, 'left for the owner');
  }
});

test('state: a save that fails before a signature or a withdraw (a full disk, a rename Windows keeps refusing) means nothing is signed or sent', async () => {
  class FullDisk extends RescueStateStore {
    override save(): void {
      throw new Error('ENOSPC: no space left on device');
    }
  }
  let signs = 0;
  const s = synthetic({ store: new FullDisk(tmpPath(), ID), fresh: true, seedCap: false, sign: async () => { signs++; } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.equal(signs, 0);
  assert.equal(s.w.failures[0]!.step, 'sign');
  assert.match(s.w.failures[0]!.reason, /the rescuer state could not be saved, so nothing was signed: .*ENOSPC/);
  assert.equal(s.w.rescuer.held, null, 'nothing was signed, so nothing is held');

  const denied = new RescueStateStore(tmpPath(), ID, {
    rename: () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); },
    renameTries: 2,
  });
  const { s: h } = hlWorld({ store: denied, fresh: true, seedCap: false });
  await run(h.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  assert.equal(h.withdrawn.length, 0);
  assert.match(h.w.failures[0]!.reason, /could not be saved, so hl_withdraw was not sent: .*EPERM/);
  assert.equal(h.w.rescuer.hlWithdrawHeld, null);
  assert.ok(h.w.logs.some((l) => /rescuer state not saved .*EPERM.*no signature or withdraw is asked for until a save before it succeeds/.test(l)));
});

// ---- serve's shutdown and a target that cannot take the delivery ----

test('stop before signing: the running rescue signs nothing and ends failed; no rescue starts after it', async () => {
  const s = synthetic();
  s.w.rescuer.take(trigger());
  await s.w.rescuer.stop();
  assert.equal(s.signed.length, 0, 'nothing signed');
  assert.deepEqual(s.w.ended, [['rescue-1', false]]);
  assert.match(JSON.stringify(s.w.failures), /the engine is stopping: nothing was signed/);
  await run(s.w, trigger({ id: 'rescue-2' }));
  assert.equal(s.quotes.length, 1, 'no second quote');
  assert.match(JSON.stringify(s.w.failures.at(-1)), /the engine is stopping: no rescue starts/);
  assert.equal(await Promise.race([s.w.rescuer.stop().then(() => 'done'), new Promise((r) => setTimeout(() => r('hung'), 50))]), 'done', 'nothing running: stop resolves');
});

test('stop while the payment is sent: it is sent and saved as held, then the rescue stops waiting for 1Click', async () => {
  let stopped: Promise<void> | null = null;
  const s = synthetic({
    send: async () => {
      stopped = s.w.rescuer.stop();
    },
    status: () => ({ status: 'PROCESSING', body: null }),
  });
  await run(s.w);
  await stopped;
  assert.equal(s.sent.length, 1, 'the signed payment went out');
  assert.deepEqual(s.w.ended, [['rescue-1', false]]);
  assert.match(JSON.stringify(s.w.failures.at(-1)), /the engine is stopping: the transfer to .* was sent and saved as held/);
  assert.match(s.w.rescuer.held ?? '', /was sent and is PROCESSING at 1Click; the engine stopped before it settled/);
});

test('a target whose credit is not ready (Phoenix: no registered trader) is refused before any quote or payment', async () => {
  const s = synthetic({ legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  let credited = 0;
  s.w.restart({ credit: { phoenix: { ready: async () => 'the desk\'s Phoenix trader is not registered', credit: async () => (credited++, { tx: [] }) } } });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
  assert.equal(s.quotes.length, 0);
  assert.equal(s.signed.length, 0);
  assert.equal(credited, 0);
  assert.deepEqual(s.w.ended, [['rescue-1', false]]);
  assert.match(JSON.stringify(s.w.failures.at(-1)), /phoenix cannot take the USDC into margin now, so nothing was paid: the desk's Phoenix trader is not registered/);
});

test('a route limit refuses a wired route by name (mainnet: Hyperliquid -> Phoenix is replay-only)', async () => {
  const s = synthetic({ desk: { reserveUsd: 0 }, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 100 } });
  s.w.restart({ routeLimit: (from, to) => (from === 'hyperliquid' && to === 'phoenix' ? 'Hyperliquid -> Phoenix runs only in replay' : null) });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 20 }));
  assert.equal(s.withdrawn.length, 0);
  assert.equal(s.quotes.length, 0);
  assert.match(JSON.stringify(s.w.failures.at(-1)) + s.w.journal().join('\n'), /Hyperliquid -> Phoenix runs only in replay/);
});

// ---- review fixes: a Solana payment that can never run, a delivery left on the Phoenix wallet, the baseline ----

test('a sol_sign_rescue whose send proves nothing ran (NothingExecuted: failed on chain or expired) releases its hold at once', async () => {
  let fails = true;
  const s = synthetic({ desk: { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } }, reducer: true, send: async () => { if (fails) throw new NothingExecuted('solana', 'the transaction failed on chain: custom program error 0x1'); } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  assert.equal(s.w.rescuer.held, null, 'nothing held');
  assert.match(JSON.stringify(s.w.failures.at(-1)), /sol_sign_rescue can never pay .*custom program error 0x1.*its hold is released/);
  // The next rescue pays.
  fails = false;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.deepEqual(s.w.ended.at(-1), ['b', true]);
  assert.equal(s.sent.length, 1);
});

test('a Phoenix payment that landed and failed (finalized with an error) is dead; 1Click then gets its 10 minutes; one only confirmed with an error is not', async () => {
  let unknown = true;
  const s = synthetic({ desk: { reserveUsd: 0, policy: { ...rec.policy, rescue_cap_usd_per_hour: 1000 } }, reducer: true, send: async () => { if (unknown) throw new OutcomeUnknown('solana send', 'no answer', {} as OutcomeIds); } });
  await run(s.w, trigger({ id: 'a', amountUsd: 30 }));
  unknown = false;
  assert.match(s.w.rescuer.held!, /rescue a/);
  const q = s.signed[0]!;
  s.status = (_n, addr) => ({ status: addr === q.depositAddress ? 'PENDING_DEPOSIT' : 'SUCCESS', body: null });
  // Landed, no error: held however long.
  s.solana.land('solana-sig-1');
  s.w.t += 3_600_000;
  await run(s.w, trigger({ id: 'b', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'landed and ok: held');
  // Finalized with an error, read from a lagging node: no proof yet.
  s.solana.fail('solana-sig-1');
  s.solana.statusLag = -1;
  s.w.t += 11 * 60_000;
  await run(s.w, trigger({ id: 'c', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /rescue a/, 'a lagging read is no proof');
  s.solana.statusLag = 0;
  await run(s.w, trigger({ id: 'd', amountUsd: 30 }));
  assert.match(s.w.rescuer.held!, /rescue a/, '1Click gets 10 minutes from the first dead read');
  s.w.t += 10 * 60_000;
  await run(s.w, trigger({ id: 'e', amountUsd: 30 }));
  assert.ok(s.w.journal().some((j) => /rescue a's signed payment can no longer run .*expired unused/.test(j)));
  assert.deepEqual(s.w.ended.at(-1), ['e', true]);
});

/** A Phoenix credit port whose wallet the test sets; `credit` may be replaced. */
function phoenixWallet(wallet: { e6: bigint }, credited: bigint[], credit?: CreditPort['credit']): CreditPort {
  return {
    baseline: async () => wallet.e6,
    manual: (e6) => `pair-mainnet fund-phoenix ${Number(e6) / 1e6} --send`,
    credit: credit ?? (async (e6) => (credited.push(e6), { tx: [] })),
  };
}

const ownerLine = (w: World) => w.journal().find((j) => /^owner: rescue a's delivery of at least .* USDC to the desk's phoenix wallet is not seen in margin/.test(j));

test('state: a Phoenix delivery parked before its credit (stopped while 1Click was PROCESSING): after a restart, SUCCESS settles it; the deposit command only while the wallet still holds the delivery', async () => {
  for (const delivered of [true, false]) {
    const store = tmpStore();
    let stopped: Promise<void> | null = null;
    const credited: bigint[] = [];
    const wallet = { e6: 400_000n };
    const s = synthetic({
      store, fresh: true, seedCap: false, noLanding: true, reducer: true, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 },
      send: async () => { stopped = s.w.rescuer.stop(); }, status: () => ({ status: 'PROCESSING', body: null }),
    });
    s.w.restart({ store, fresh: true, credit: { phoenix: phoenixWallet(wallet, credited) } });
    await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
    await stopped;
    assert.match(s.w.rescuer.held ?? '', /PROCESSING at 1Click; the engine stopped before it settled/);
    assert.equal(onDisk(store).holds[0]!.creditBaseE6, '400000', 'the baseline is saved with the hold');
    assert.equal(onDisk(store).holds[0]!.creditStarted, false);
    // The restart: 1Click now says SUCCESS. Delivered: the wallet holds the baseline plus minAmountOut; else less
    // (something moved it, perhaps a deposit).
    const q = s.signed[0]!;
    wallet.e6 = 400_000n + q.minAmountOut - (delivered ? 0n : 1n);
    s.status = () => ({ status: 'SUCCESS', body: null });
    s.w.restart({ store, credit: { phoenix: phoenixWallet(wallet, credited) } });
    await run(s.w, trigger({ id: 'b', venue: 'hyperliquid', amountUsd: 20 }));
    assert.doesNotMatch(s.w.rescuer.held ?? '', /rescue a/, 'settled');
    const line = ownerLine(s.w);
    assert.ok(line !== undefined, s.w.journal().join('\n'));
    if (delivered) {
      assert.match(line, /it waits on the wallet, not in margin; to move it: pair-mainnet fund-phoenix .* --send/);
    } else {
      assert.match(line, /the delivery is not on the wallet yet \(it holds .* USDC, 0.40 before the payment\) and the engine deposited nothing: check the wallet, then phoenix margin, before depositing/);
      assert.doesNotMatch(line, /fund-phoenix/);
    }
    assert.ok(s.w.logs.some((l) => /^owner: rescue a's delivery/.test(l)));
    assert.equal(credited.length, 0, 'never deposited from the restart path');
  }
});

test('state: a crash while the credit signs its deposit (the marker saved): after a restart, SUCCESS says the deposit may have run, never the deposit command', async () => {
  const store = tmpStore();
  const wallet = { e6: 0n };
  let marked = false;
  const hang: CreditPort['credit'] = async (_e6, _r, o) => {
    marked = o?.beforeSign?.() === true;
    return new Promise<never>(() => {});
  };
  const s = synthetic({ store, fresh: true, seedCap: false, noLanding: true, reducer: true, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  s.w.restart({ store, fresh: true, credit: { phoenix: phoenixWallet(wallet, [], hang) } });
  s.w.rescuer.take(trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  await until(() => marked);
  assert.equal(onDisk(store).holds[0]!.creditStarted, true, 'saved before the deposit is signed');
  // The wallet still shows the delivery (the deposit's transaction may not have landed yet): still no command.
  wallet.e6 = s.signed[0]!.minAmountOut;
  s.w.restart({ store, credit: { phoenix: phoenixWallet(wallet, []) } });
  await run(s.w, trigger({ id: 'b', venue: 'hyperliquid', amountUsd: 20 }));
  assert.doesNotMatch(s.w.rescuer.held ?? '', /rescue a/, 'settled');
  const line = ownerLine(s.w);
  assert.ok(line !== undefined, s.w.journal().join('\n'));
  assert.match(line, /the deposit may have run \(it was about to be signed\): check phoenix margin \(and the desk's Solana transactions\) before depositing/);
  assert.doesNotMatch(line, /fund-phoenix/);
});

test('the credit gets the baseline read before the hold; a stop during that read signs nothing; a failed credit says whether to deposit by hand', async () => {
  const seen: (bigint | null | undefined)[] = [];
  const s = synthetic({ legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  s.w.restart({ credit: { phoenix: { baseline: async () => 250_000n, credit: async (_e6, _r, o) => (seen.push(o?.baseE6), { tx: [] }) } } });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
  assert.deepEqual(seen, [250_000n]);
  assert.deepEqual(s.w.ended, [['rescue-1', true]]);

  // Failed before the deposit was signed, the delivery on the wallet: the command. Failed after: check first.
  for (const signedFirst of [false, true]) {
    const wallet = { e6: 0n };
    const f = synthetic({ legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
    f.w.restart({
      credit: {
        phoenix: {
          baseline: async () => wallet.e6, manual: () => 'run the deposit by hand',
          credit: async (e6, _r, o) => {
            wallet.e6 = e6;
            if (signedFirst) o?.beforeSign?.();
            throw new Error('the solana rpc refused the transaction');
          },
        },
      },
    });
    await run(f.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
    assert.equal(f.w.rescuer.held, null);
    const line = f.w.journal().find((j) => /^owner: rescue rescue-1's delivery/.test(j)) ?? '';
    if (signedFirst) {
      assert.match(line, /\(the deposit failed once its signing began: .*\): the deposit may have run \(it was about to be signed\): check phoenix margin/);
      assert.doesNotMatch(line, /by hand/);
    } else {
      assert.match(line, /\(the deposit did not run: .*\): it waits on the wallet, not in margin; to move it: run the deposit by hand/);
    }
  }

  let stopped: Promise<void> | null = null;
  const t = synthetic({ legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  t.w.restart({ credit: { phoenix: { baseline: async () => { stopped = t.w.rescuer.stop(); return 0n; }, credit: async () => ({ tx: [] }) } } });
  await run(t.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
  await stopped;
  assert.equal(t.signed.length, 0, 'nothing signed');
  assert.equal(t.w.rescuer.held, null, 'no hold opened');
  assert.match(JSON.stringify(t.w.failures.at(-1)), /the engine is stopping: nothing was signed/);
});

// ---- the owner line's other branches: the stop before the credit, a proved deposit, no or no readable baseline, a
// failed save ----

/** A store whose saves fail while `fail` is set. */
class FlakyDisk extends RescueStateStore {
  fail = false;
  override save(snapshot: Parameters<RescueStateStore['save']>[0]): void {
    if (this.fail) throw new Error('ENOSPC: no space left on device');
    super.save(snapshot);
  }
}

/** A rescue into Phoenix parked while 1Click is PROCESSING (serve stopped), with `phoenix` as the credit; the state on `store`. */
async function parkedPhoenix(store: RescueStateStore, phoenix: CreditPort) {
  let stopped: Promise<void> | null = null;
  const s = synthetic({
    store, fresh: true, seedCap: false, noLanding: true, reducer: true, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 },
    send: async () => { stopped = s.w.rescuer.stop(); }, status: () => ({ status: 'PROCESSING', body: null }),
  });
  s.w.restart({ store, fresh: true, credit: { phoenix } });
  await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
  await stopped;
  assert.match(s.w.rescuer.held ?? '', /rescue a/);
  return { s, q: s.signed[0]! };
}

/** The restart, SUCCESS at 1Click, and the next pass: the owner line of rescue a. */
async function settleAfterRestart(s: Synthetic, store: RescueStateStore, phoenix: CreditPort, over: Partial<RescuerOptions> = {}): Promise<string> {
  s.status = () => ({ status: 'SUCCESS', body: null });
  s.w.restart({ store, credit: { phoenix }, ...over });
  await run(s.w, trigger({ id: 'b', venue: 'hyperliquid', amountUsd: 20 }));
  const line = ownerLine(s.w);
  assert.ok(line !== undefined, s.w.journal().join('\n'));
  assert.doesNotMatch(line, /fund-phoenix/, 'no deposit command');
  return line;
}

test('the stop before the credit: the wallet is read before the hold is dropped; the command when the delivery is there, "check first" when the read times out', async () => {
  for (const hangs of [false, true]) {
    const store = tmpStore();
    const wallet = { e6: 300_000n };
    let reads = 0;
    const phoenix: CreditPort = {
      baseline: async () => {
        reads++;
        // The first read is the baseline before the hold; a later one may hang.
        return hangs && reads > 1 ? new Promise<never>(() => {}) : wallet.e6;
      },
      manual: (e6) => `pair-mainnet fund-phoenix ${Number(e6) / 1e6} --send`,
      credit: async () => { throw new Error('never called while stopping'); },
    };
    let heldWhileRead = false;
    const s = synthetic({
      store, fresh: true, seedCap: false, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 },
      status: () => {
        // 1Click delivers, and serve begins to stop before the credit.
        wallet.e6 = 300_000n + s.signed[0]!.minAmountOut;
        void s.w.rescuer.stop();
        return { status: 'SUCCESS', body: null };
      },
    });
    s.w.restart({
      store, fresh: true, walletReadMs: 20,
      credit: { phoenix: { ...phoenix, baseline: async () => { if (reads >= 1) heldWhileRead = onDisk(store).holds.length === 1; return phoenix.baseline!(); } } },
    });
    await run(s.w, trigger({ id: 'a', venue: 'phoenix', amountUsd: 20 }));
    assert.ok(heldWhileRead, 'the hold is still saved while the wallet is read');
    assert.equal(s.w.rescuer.held, null);
    assert.equal(onDisk(store).holds.length, 0, 'then dropped and saved');
    assert.match(JSON.stringify(s.w.failures.at(-1)), /the engine is stopping: 1Click delivered/);
    const line = ownerLine(s.w) ?? '';
    if (hangs) {
      assert.match(line, /\(the engine stopped before the deposit\): the engine deposited nothing; the wallet could not be read \(no answer in 0.02 s\): check the wallet, then phoenix margin, before depositing/);
      assert.doesNotMatch(line, /fund-phoenix/);
    } else {
      assert.match(line, /\(the engine stopped before the deposit\): it waits on the wallet, not in margin; to move it: pair-mainnet fund-phoenix/);
    }
  }
});

test('a credit whose deposit is proved to have run nothing (NothingExecuted) after the marker: the command, as if never signed', async () => {
  const wallet = { e6: 0n };
  const s = synthetic({ legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  s.w.restart({
    credit: {
      phoenix: {
        baseline: async () => wallet.e6, manual: () => 'run the deposit by hand',
        credit: async (e6, _r, o) => {
          wallet.e6 = e6;
          assert.equal(o?.beforeSign?.(), true);
          throw new NothingExecuted('solana', 'the deposit failed on chain');
        },
      },
    },
  });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
  const line = s.w.journal().find((j) => /^owner: rescue rescue-1's delivery/.test(j)) ?? '';
  assert.match(line, /\(the deposit did not run: solana: nothing executed: the deposit failed on chain\): it waits on the wallet, not in margin; to move it: run the deposit by hand/);
});

test('state: no baseline saved with the hold, or a wallet read that throws: "check first", never the command', async () => {
  // No baseline: the credit at payment time had no wallet read.
  const store = tmpStore();
  const { s, q } = await parkedPhoenix(store, { credit: async () => ({ tx: [] }) });
  assert.equal(onDisk(store).holds[0]!.creditBaseE6, null);
  const line = await settleAfterRestart(s, store, { baseline: async () => q.minAmountOut * 2n, manual: () => 'pair-mainnet fund-phoenix x --send', credit: async () => ({ tx: [] }) });
  assert.match(line, /the engine deposited nothing; no baseline was saved with this hold, so the delivery cannot be told from other USDC on the wallet \(it holds .* USDC\): check the wallet, then phoenix margin, before depositing/);
  assert.doesNotMatch(s.w.rescuer.held ?? '', /rescue a/, 'settled');

  const store2 = tmpStore();
  const wallet = { e6: 0n };
  const p2 = await parkedPhoenix(store2, phoenixWallet(wallet, []));
  const line2 = await settleAfterRestart(p2.s, store2, { baseline: async () => { throw new Error('solana rpc: 503'); }, manual: () => 'pair-mainnet fund-phoenix x --send', credit: async () => ({ tx: [] }) });
  assert.match(line2, /the engine deposited nothing; the wallet could not be read \(solana rpc: 503\): check the wallet, then phoenix margin, before depositing/);
});

test('state: a SUCCESS settle whose wallet read hangs is bounded: "check first", and the next pass goes on', async () => {
  const store = tmpStore();
  const wallet = { e6: 0n };
  const { s } = await parkedPhoenix(store, phoenixWallet(wallet, []));
  const line = await settleAfterRestart(s, store, { baseline: () => new Promise<never>(() => {}), manual: () => 'pair-mainnet fund-phoenix x --send', credit: async () => ({ tx: [] }) }, { walletReadMs: 20 });
  assert.match(line, /the wallet could not be read \(no answer in 0.02 s\)/);
  assert.ok(s.w.ended.some(([id]) => id === 'b'), 'the rescue after it ran');
});

test('state: a drop whose save fails gives no command (a restart reads the hold again), and says the save failed', async () => {
  const store = new FlakyDisk(tmpPath(), ID);
  const wallet = { e6: 400_000n };
  const { s, q } = await parkedPhoenix(store, phoenixWallet(wallet, []));
  wallet.e6 = 400_000n + q.minAmountOut;
  store.fail = true;
  const line = await settleAfterRestart(s, store, phoenixWallet(wallet, []));
  assert.match(line, /the engine deposited nothing, but the rescuer state could not be saved \(.*ENOSPC.*\), so a restart may read this hold again: check the wallet, then phoenix margin, before depositing/);
  store.fail = false;
  assert.equal(onDisk(store).holds.length, 1, 'still on disk');
});

test('a beforeSign whose save fails leaves the marker false: the owner line says the deposit did not run', async () => {
  const store = new FlakyDisk(tmpPath(), ID);
  const wallet = { e6: 0n };
  let marked: boolean | undefined;
  const s = synthetic({ store, fresh: true, seedCap: false, legs: [leg('phoenix', 200), leg('hyperliquid', 200)], freeMargin: { hyperliquid: 0 } });
  s.w.restart({
    store, fresh: true,
    credit: {
      phoenix: {
        baseline: async () => wallet.e6, manual: () => 'run the deposit by hand',
        credit: async (e6, _r, o) => {
          wallet.e6 = e6;
          store.fail = true;
          marked = o?.beforeSign?.();
          store.fail = false;
          throw new Error('the rescuer state could not be saved before the deposit: nothing was deposited');
        },
      },
    },
  });
  await run(s.w, trigger({ venue: 'phoenix', amountUsd: 10 }));
  assert.equal(marked, false);
  const line = s.w.journal().find((j) => /^owner: rescue rescue-1's delivery/.test(j)) ?? '';
  assert.match(line, /\(the deposit did not run: .*\): it waits on the wallet, not in margin; to move it: run the deposit by hand/);
});
