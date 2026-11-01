// Development only: a stream of StreamEvent-shaped events so the shell can run without an engine.
// Every value here is made up; the UI labels this source "Fake stream". Each event goes through
// JSON and the same parser as the SSE client, so it exercises the real path into the store.
import type { JournalEntry, Mode, RescueProgress, SetupProgress, StreamEvent } from '@gimbal/shared';
import { fakeDesk, fakeDeskHealth, fakeLatest } from './fake-desk.ts';
import { fakeScan, fakeWindows, type Scenario } from './fake-windows.ts';
import { fakeDeskFor, fakeEarlierRescues, fakeProgress, fakeRun, stressRun, takeFakeStress, type FakeRun } from './fake-rescue.ts';
import { deskFor, type DeskScenario, type RescueScenario } from './source.ts';
import { parseStreamEvent, type StreamAction } from './store.ts';

/** How often the fake looks at its rescue: a step change is sent within this long of when it happens. */
const RESCUE_LOOK_MS = 200;

export interface FakeOptions {
  mode: Mode;
  intervalMs?: number;
  /** What the Windows screen shows (`?state=`); the default is the mockup's full list. */
  scenario?: Scenario;
  /** What the Desk screen shows (`?desk=`); by default it follows `scenario`, see `deskFor`. */
  desk?: DeskScenario;
  /** A slow swing in every funding rate and mark, so the lists re-sort and the numbers move. Off for a still picture. */
  drift?: boolean;
  /**
   * What the Rescue screen shows (`?rescue=`). When it is given, the three rescues before it reach the journal, and
   * the desk's status line follows the rescue unless `desk` is given too. Without it the fake sends no rescue.
   */
  rescue?: RescueScenario;
}

export function startFakeStream(dispatch: (action: StreamAction) => void, options: FakeOptions): () => void {
  const intervalMs = options.intervalMs ?? 800;
  const scenario = options.scenario ?? 'normal';
  const desk = options.desk ?? deskFor(scenario);
  const drift = options.drift ?? true;
  // A desk with no position waits because nothing clears the minimum, so the windows say the same.
  const windowsOptions = { scenario: desk === 'waiting' && scenario === 'normal' ? ('empty' as const) : scenario, startedAt: Date.now(), drift };
  let tick = 0;

  const send = (event: StreamEvent) => {
    const parsed = parseStreamEvent(JSON.stringify(event));
    dispatch(parsed ? { kind: 'event', event: parsed, at: Date.now() } : { kind: 'rejected', at: Date.now() });
  };

  // The rescue: the one the address asks for, then any the Stress button starts. A step change is sent once, when it
  // happens, as the engine will; the page counts the seconds itself.
  // With a rescue the desk's status follows its step, unless the desk was asked for by name.
  const followsRescue = options.rescue !== undefined && options.desk === undefined;
  let run: FakeRun | null = options.rescue === undefined ? null : fakeRun(options.rescue, Date.now());
  let stresses = 0;
  let sent = '';
  let lastStep: RescueProgress['step'] | null = null;
  const sendDesk = (now: number) => {
    const deskNow = (followsRescue && lastStep !== null ? fakeDeskFor(lastStep) : null) ?? desk;
    if (deskNow !== 'loading') send({ type: 'desk', data: fakeDesk(now, tick, { mode: options.mode, scenario: deskNow, drift }) });
  };
  const lookAtRescue = () => {
    if (options.rescue === undefined) return;
    if (takeFakeStress()) {
      stresses += 1;
      run = stressRun(Date.now(), stresses);
    }
    if (run === null) return;
    const progress = fakeProgress(run, Date.now(), options.mode);
    const key = `${progress.id}:${progress.step}:${progress.tx.length}`;
    if (key === sent) return;
    sent = key;
    lastStep = progress.step;
    send({ type: 'rescue', data: progress });
    // The status line changes with the step, not at the next desk tick (the first look comes before the first desk event).
    if (followsRescue && tick > 0) sendDesk(Date.now());
  };

  const step = () => {
    const now = Date.now();
    if (tick === 0) {
      send({ type: 'setup', data: fakeSetup() });
      for (const entry of fakeLatest(now, desk, options.mode)) send({ type: 'journal', data: entry });
      if (options.rescue !== undefined) {
        for (const entry of fakeEarlierRescues(now, options.mode)) send({ type: 'journal', data: entry });
        lookAtRescue();
      }
    }
    if (tick % 3 === 0) send({ type: 'health', data: fakeDeskHealth(tick, desk) });
    // The scanner sends its windows and its status together; `loading` sends neither.
    if (tick % 4 === 0 && scenario !== 'loading') {
      send({ type: 'windows', data: fakeWindows(now, tick, windowsOptions) });
      send({ type: 'scan', data: fakeScan(now, scenario) });
    }
    // A new funding line now and then; a still picture keeps the three entries it starts with.
    if (drift && desk !== 'waiting' && desk !== 'loading' && tick % 6 === 5) send({ type: 'journal', data: fakeFunding(now, tick) });
    sendDesk(now);
    tick += 1;
  };

  dispatch({ kind: 'connection', source: 'fake', connection: 'open' });
  step();
  const timer = setInterval(step, intervalMs);
  const rescueTimer = setInterval(lookAtRescue, RESCUE_LOOK_MS);
  return () => {
    clearInterval(timer);
    clearInterval(rescueTimer);
    dispatch({ kind: 'connection', source: 'fake', connection: 'idle' });
  };
}

function fakeFunding(now: number, tick: number): JournalEntry {
  return {
    id: `fake-funding-${tick}`,
    t: now,
    kind: 'funding',
    summary: 'Funding paid on both legs (fake stream)',
    numbers: { usd: 0.03, symbol: 'DOGE' },
    tx: [],
  };
}

function fakeSetup(): SetupProgress {
  const steps: SetupProgress['steps'][number]['step'][] = [
    'hl_set_referrer',
    'hl_approve_builder_fee',
    'orderly_register',
    'orderly_add_key',
    'orderly_receiver_lookup',
    'orderly_referral_bind',
    'phoenix_register',
    'phoenix_referral',
  ];
  return { deskId: 'desk-07', steps: steps.map((step) => ({ step, status: 'done', tx: [] })) };
}
