// Development only: the Rescue screen's fake stream, shaped exactly like `RescueProgress`. Until the engine sends real
// rescues (day 9) it plays the mockup's rescue (design/screens/shared: DOGE, $120.00 from Phoenix to Hyperliquid) and a
// run that fails at the quote. Every value here is made up; the fake's transactions have the shape of real ones but
// name nothing on any chain.
import type { JournalEntry, Mode, RescueProgress } from '@gimbal/shared';
import { fakeTx } from './fake-explorer.ts';
import type { RescueScenario } from './source.ts';

/** The rescue the desk's `needs` scenario names in `rescueFailure` (fake-desk.ts), so the two agree. */
export const FAKE_RESCUE_ID = 'rescue-demo-1';

const AMOUNT_USD = 120;
const LANDED_AFTER_S = 52;
/** Seconds after detection at which each step begins in a rescue that lands (the mockup's times). */
const BEGINS_S = { detect: 0, source: 0.1, quote: 0.5, verify: 1.7, sign: 2, deposit: 8.2, landed: LANDED_AFTER_S } as const;
type Step = keyof typeof BEGINS_S;
const ORDER: readonly Step[] = ['detect', 'source', 'quote', 'verify', 'sign', 'deposit', 'landed'];

interface Spec {
  plan: 'lands' | 'fails';
  /** How old the rescue is when the page opens, in seconds. */
  startAgeS: number;
  /** Whether time keeps moving; a finished rescue does not. */
  live: boolean;
  /** Stop on the step reached at this age (a page opened mid-run). */
  holdS?: number;
  /** Seconds after detection at which a failing rescue gives up. */
  failAtS?: number;
}

const SPECS: Record<Exclude<RescueScenario, 'idle'>, Spec> = {
  running: { plan: 'lands', startAgeS: 0, live: true },
  failing: { plan: 'fails', startAgeS: 0, live: true, failAtS: 9 },
  sign: { plan: 'lands', startAgeS: 5, live: true, holdS: 5 },
  landed: { plan: 'lands', startAgeS: LANDED_AFTER_S, live: false },
  failed: { plan: 'fails', startAgeS: 72, live: false, failAtS: 72 },
};

export interface FakeRun {
  id: string;
  spec: Spec;
  /** When the page began playing it (ms): the rescue's own start is `startAgeS` before this. */
  playedAt: number;
}

/** A rescue as the page sees it when it opens: null for `idle`. */
export function fakeRun(scenario: RescueScenario, now: number, id?: string): FakeRun | null {
  if (scenario === 'idle') return null;
  return { id: id ?? FAKE_RESCUE_ID, spec: SPECS[scenario], playedAt: now };
}

/** A rescue the Stress button started: it lands, in real time, from now. */
export const stressRun = (now: number, n: number): FakeRun => ({ id: `rescue-stress-${n}`, spec: SPECS.running, playedAt: now });

/** The `RescueProgress` of a run at a moment. */
export function fakeProgress(run: FakeRun, now: number, mode: Mode): RescueProgress {
  const { spec } = run;
  const age = spec.startAgeS + (spec.live ? Math.max(0, now - run.playedAt) / 1000 : 0);
  const startedAt = run.playedAt - spec.startAgeS * 1000;
  const failed = spec.plan === 'fails' && age >= (spec.failAtS ?? 0);
  const at = Math.min(age, spec.holdS ?? Infinity);
  // A rescue that fails never gets past the quote (it begins at 0.5 s).
  const reached = ORDER.filter((s) => BEGINS_S[s] <= (spec.plan === 'fails' ? Math.min(at, BEGINS_S.quote) : at));
  const step = failed ? 'failed' : reached[reached.length - 1]!;
  const elapsedS = Math.round(Math.min(at, failed ? (spec.failAtS ?? at) : LANDED_AFTER_S) * 10) / 10;
  const tx = failed
    ? []
    : [
        ...(reached.includes('sign') ? [fakeTx('near', 'Lq3v', '8kRd', mode)] : []),
        ...(reached.includes('deposit') ? [fakeTx('solana', '4uZp', 'Qe1x', mode)] : []),
        ...(reached.includes('landed') ? [fakeTx('hyperliquid', '88b2', '14d0', mode)] : []),
      ];
  return { id: run.id, from: 'phoenix', to: 'hyperliquid', amountUsd: AMOUNT_USD, step, startedAt, elapsedS, tx };
}

/** What the fake desk should read for a run: the status line follows the rescue. */
export function fakeDeskFor(step: RescueProgress['step'] | null): 'rescuing' | 'level' | 'needs' | null {
  if (step === null) return null;
  if (step === 'failed') return 'needs';
  return step === 'landed' ? 'level' : 'rescuing';
}

/** Earlier rescues for the Journal-backed list, newest first (the mockup's three). */
export function fakeEarlierRescues(now: number, mode: Mode): JournalEntry[] {
  const day = 86_400_000;
  const rescue = (id: string, daysAgo: number, summary: string, fee: number, from: string, landedS: number): JournalEntry => ({
    id,
    t: now - daysAgo * day,
    kind: 'rescue',
    summary,
    numbers: { usd: -fee, from, signedS: 6.1, landedS },
    tx: [fakeTx('near', id.slice(-4), 'Ea2f', mode)],
  });
  return [
    rescue('fake-rescue-earlier-1', 1, 'Moved $120.00 to Hyperliquid margin from the reserve', 0.32, 'reserve', 52),
    rescue('fake-rescue-earlier-2', 5, 'Moved $20.00 to Phoenix margin from the reserve', 0.21, 'reserve', 107),
    rescue('fake-rescue-earlier-3', 5.4, 'Moved $25.00 to Hyperliquid margin from Phoenix free margin', 0.28, 'phoenix', 51),
  ];
}

// ---------- the Stress button, in the fake ----------

let stressAsked = false;

/** `POST /stress` in the fake: the fake stream starts a rescue on its next look. */
export function requestFakeStress(): void {
  stressAsked = true;
}

/** Whether the Stress button was pressed since the last look; reading it clears it. */
export function takeFakeStress(): boolean {
  const asked = stressAsked;
  stressAsked = false;
  return asked;
}

