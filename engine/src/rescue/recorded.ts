// The rescue on testnet and in replay: 1Click has no testnet, and a rescue there must never move real money, so the
// 1Click steps come from recorded mainnet answers (fixtures/oneclick/rescue-mainnet-2026-10-31.json: real quotes with
// 1Click's real signatures, copied from the contract's live vectors) and the payments are simulated. Every step the
// live rescue runs still runs: the quote is verified with the same rules as the contract, against the recording's own
// desk addresses and at the time 1Click signed it. Nothing is signed by the contract and nothing is sent anywhere.
//
// The recording has no /deposit/submit or /status answers (none was saved on mainnet), so a transfer's statuses
// follow a timeline shaped like the API's, timed from the measured mainnet transfers; the fixture says so. Each route
// sends what its recorded quote sends (4 to 20 USDC), whatever the trigger asked: the journal labels every line.

import { readFileSync } from 'node:fs';
import type { VenueId } from '@gimbal/shared';
import type { Clock } from '../venues/venue.ts';
import type { DeskAddresses, OneClickApi, QuoteAnswer, QuoteRequest, QuoteResponse, QuotedMethod, StatusAnswer, VerifiedQuote } from './oneclick.ts';
import { DECIMALS, parseTimeMs } from './oneclick.ts';
import { HL_BRIDGE2, SimulatedArbitrum, eip3009Nonce } from './arbitrum-chain.ts';
import type { Source } from './plan.ts';
import type { CreditPort, HlWithdrawPort, LandingPort, Payer, RescueDesk, SignedPayment } from './rescuer.ts';

export const RECORDED_RESCUE_FIXTURE = new URL('../../fixtures/oneclick/rescue-mainnet-2026-10-31.json', import.meta.url);

export interface RecordedRoute {
  from: Source;
  to: VenueId;
  method: QuotedMethod;
  name: string;
  response: QuoteResponse;
  statuses: { afterS: number; status: string }[];
  /** When the delivery shows in the target's ledger, s after the deposit (Orderly credits 1–2 min after arrival). */
  creditAfterS: number;
}

export interface RescueRecording {
  about: string;
  desk: DeskAddresses;
  policy: RescueDesk['policy'];
  routes: RecordedRoute[];
}

export function loadRescueRecording(url: URL = RECORDED_RESCUE_FIXTURE): RescueRecording {
  return JSON.parse(readFileSync(url, 'utf8')) as RescueRecording;
}

/** In this recording, what a quote's amountIn is in USD. */
function amountInUsd(route: RecordedRoute): number {
  const q = route.response.quote as { amountIn?: string };
  const asset = String((route.response.quoteRequest as { originAsset?: string }).originAsset);
  return Number(q.amountIn) / 10 ** (DECIMALS[asset] ?? 6);
}

/** 1Click's answers from a recording; statuses follow each route's timeline from the deposit's submit. */
export class RecordedOneClick implements OneClickApi {
  readonly source: string;
  readonly #rec: RescueRecording;
  readonly #clock: Clock;
  // A recorded route has one deposit address, so every replayed rescue on it submits to the same one: each submit
  // is its own transfer, the latest is the one /status answers for.
  readonly #deposits = new Map<string, { at: number; route: RecordedRoute }[]>();
  /** Every call, in order (tests read it). */
  readonly calls: { call: 'quote' | 'submit' | 'status'; arg: string }[] = [];

  constructor(recording: RescueRecording, clock: Clock, name = 'recorded mainnet 1Click answers of 2026-10-31') {
    this.#rec = recording;
    this.#clock = clock;
    this.source = name;
  }

  route(from: Source, to: VenueId): RecordedRoute | null {
    return this.#rec.routes.find((r) => r.from === from && r.to === to) ?? null;
  }

  /** The amount each recorded route sends (plan.ts fixedAmountUsd). */
  fixedAmountUsd(from: Source, to: VenueId): number | null {
    const r = this.route(from, to);
    return r === null ? null : amountInUsd(r);
  }

  verifyAt(response: QuoteResponse): number {
    return parseTimeMs(response.timestamp) ?? this.#clock.now();
  }

  async quote(body: QuoteRequest): Promise<QuoteAnswer> {
    this.calls.push({ call: 'quote', arg: `${body.originAsset} -> ${body.destinationAsset}` });
    const r = this.#rec.routes.find((x) => (x.response.quoteRequest as { originAsset?: string }).originAsset === body.originAsset
      && (x.response.quoteRequest as { destinationAsset?: string }).destinationAsset === body.destinationAsset);
    if (r === undefined) return { ok: false, status: 400, message: 'Quoting for this pair is not available (no recorded quote for this route)' };
    return { ok: true, response: structuredClone(r.response) };
  }

  async submitDeposit(txHash: string, depositAddress: string): Promise<{ status: number }> {
    this.calls.push({ call: 'submit', arg: `${txHash} ${depositAddress}` });
    const route = this.#rec.routes.find((r) => (r.response.quote as { depositAddress?: string }).depositAddress === depositAddress);
    if (route === undefined) return { status: 404 };
    const list = this.#deposits.get(depositAddress) ?? [];
    list.push({ at: this.#clock.now(), route });
    this.#deposits.set(depositAddress, list);
    return { status: 200 };
  }

  async status(depositAddress: string): Promise<StatusAnswer> {
    this.calls.push({ call: 'status', arg: depositAddress });
    const d = this.#deposits.get(depositAddress)?.at(-1);
    if (d === undefined) return { status: 'PENDING_DEPOSIT', body: { status: 'PENDING_DEPOSIT', recorded: false } };
    const s = (this.#clock.now() - d.at) / 1000;
    const at = d.route.statuses.filter((x) => x.afterS <= s).at(-1) ?? d.route.statuses[0]!;
    return { status: at.status, body: { status: at.status, swapDetails: { destinationChainTxHashes: [] }, recorded: false, shapedLike: 'GET /v0/status' } };
  }

  /** When the `n`th submitted deposit to an address shows in its target's margin, ms; null if it was not submitted. */
  creditAt(depositAddress: string, n = 0): number | null {
    const d = this.#deposits.get(depositAddress)?.[n];
    return d === undefined ? null : d.at + d.route.creditAfterS * 1000;
  }
}

/**
 * The money side of a recorded rescue: simulated payers that sign and send nothing, the reserve they spend, the desk's
 * Arbitrum address (simulated: a withdraw's Bridge2 Transfer, a bridge's Transfer to the deposit address), and each
 * venue's ledger as the deliveries reach it (one entry per delivery, at its recorded credit time).
 */
export class SimulatedMoney {
  readonly #oneClick: RecordedOneClick;
  readonly #clock: Clock;
  readonly #deskEvm: string;
  readonly #deskId: string;
  readonly #deliveries: { to: VenueId; usd: number; depositAddress: string; n: number }[] = [];
  #reserveSpent = 0;
  #nonces = 0n;
  /** The desk's Arbitrum address as the rescuer reads it (RescuerOptions.arbitrum). */
  readonly arbitrum: SimulatedArbitrum;
  /** Called once a delivery shows (replay raises the scripted leg's margin by it). */
  onCredit: ((venue: VenueId, usd: number) => void) | null = null;
  readonly #credited = new Set<string>();
  /** Called when a simulated fund_venue spends the reserve (replay lowers its scripted reserve). */
  onReserveSpend: ((usd: number) => void) | null = null;

  constructor(oneClick: RecordedOneClick, clock: Clock, desk: { evm: string; deskId: string }) {
    this.#oneClick = oneClick;
    this.#clock = clock;
    this.#deskEvm = desk.evm.toLowerCase();
    this.#deskId = desk.deskId;
    this.arbitrum = new SimulatedArbitrum(clock);
  }

  get reserveSpentUsd(): number {
    return this.#reserveSpent;
  }

  payer(method: QuotedMethod, targetOf: (q: VerifiedQuote) => VenueId): Payer {
    return {
      method,
      sign: async (q: VerifiedQuote): Promise<SignedPayment> => {
        const eip3009 = method === 'evm_usdc_to_intents';
        const authorization = eip3009 ? { from: this.#deskEvm, nonce: eip3009Nonce(this.#deskId, this.#nonces++), validBefore: Math.floor(this.#clock.now() / 1000) + 300 } : undefined;
        return {
          tx: [],
          ...(authorization === undefined ? {} : { authorization, usableUntilMs: authorization.validBefore * 1000 }),
          send: async () => {
            if (authorization !== undefined) {
              this.arbitrum.transfer(this.#deskEvm, q.depositAddress, q.amountIn);
              this.arbitrum.used.add(`${authorization.from}:${authorization.nonce.toLowerCase()}`);
            }
            if (method === 'fund_venue') {
              this.#reserveSpent += Number(q.amountInE8) / 1e8;
              this.onReserveSpend?.(Number(q.amountInE8) / 1e8);
            }
            const n = this.#deliveries.filter((d) => d.depositAddress === q.depositAddress).length;
            this.#deliveries.push({ to: targetOf(q), usd: Number(q.minAmountOutE8) / 1e8, depositAddress: q.depositAddress, n });
            return { tx: [], depositTx: `replayed-${q.depositAddress.slice(0, 12)}` };
          },
        };
      },
    };
  }

  /** hl_withdraw, simulated: the amount less Hyperliquid's 1 USDC comes from Bridge2 to the desk 231 s later (as measured). */
  hlWithdraw(): HlWithdrawPort {
    return {
      withdraw: async (amountE6) => {
        this.arbitrum.transfer(HL_BRIDGE2, this.#deskEvm, amountE6 - 1_000_000n, this.#clock.now() + 231_000);
        return { tx: [] };
      },
    };
  }

  /** A Phoenix deposit, simulated: it moves nothing, the delivery already counts. */
  credit(): CreditPort {
    return { credit: async () => ({ tx: [] }) };
  }

  /** Every delivery shows as one ledger entry on its target once its recorded credit time has passed. */
  landing(): LandingPort {
    return {
      confirms: () => null,
      find: async (venue, q, sinceMs, seen) => {
        const now = this.#clock.now();
        for (const d of this.#deliveries) {
          const id = `replayed-${d.depositAddress}#${d.n}`;
          const at = this.#oneClick.creditAt(d.depositAddress, d.n);
          if (d.to !== venue || seen.has(id) || at === null || now < at || at < sinceMs || d.usd < Number(q.minAmountOutE8) / 1e8) continue;
          if (!this.#credited.has(id)) {
            this.#credited.add(id);
            this.onCredit?.(venue, d.usd);
          }
          return { id, usd: d.usd, tx: [] };
        }
        return null;
      },
    };
  }
}

/**
 * A clock that keeps going when its base stops: the replay clock stops at the end of the recording, and a rescue's
 * waits (1Click's status, the landing) must still end.
 */
export function steadyClock(base: Clock, real: () => number = Date.now): Clock {
  let lastBase = base.now();
  let lastReal = real();
  let value = lastBase;
  return {
    now(): number {
      const b = base.now();
      const r = real();
      value = b > lastBase ? Math.max(value, b) : value + Math.max(0, r - lastReal);
      lastBase = b;
      lastReal = r;
      return value;
    },
  };
}
