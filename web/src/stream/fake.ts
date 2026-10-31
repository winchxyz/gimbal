// Development only: a stream of StreamEvent-shaped events so the shell can run without an engine.
// Every value here is made up; the UI labels this source "Fake stream". Each event goes through
// JSON and the same parser as the SSE client, so it exercises the real path into the store.
import type { JournalEntry, Mode, SetupProgress, StreamEvent } from '@gimbal/shared';
import { fakeDesk, fakeDeskHealth, fakeLatest } from './fake-desk.ts';
import { fakeScan, fakeWindows, type Scenario } from './fake-windows.ts';
import { deskFor, type DeskScenario } from './source.ts';
import { parseStreamEvent, type StreamAction } from './store.ts';

export interface FakeOptions {
  mode: Mode;
  intervalMs?: number;
  /** What the Windows screen shows (`?state=`); the default is the mockup's full list. */
  scenario?: Scenario;
  /** What the Desk screen shows (`?desk=`); by default it follows `scenario`, see `deskFor`. */
  desk?: DeskScenario;
  /** A slow swing in every funding rate and mark, so the lists re-sort and the numbers move. Off for a still picture. */
  drift?: boolean;
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

  const step = () => {
    const now = Date.now();
    if (tick === 0) {
      send({ type: 'setup', data: fakeSetup() });
      for (const entry of fakeLatest(now, desk)) send({ type: 'journal', data: entry });
    }
    if (tick % 3 === 0) send({ type: 'health', data: fakeDeskHealth(tick, desk) });
    // The scanner sends its windows and its status together; `loading` sends neither.
    if (tick % 4 === 0 && scenario !== 'loading') {
      send({ type: 'windows', data: fakeWindows(now, tick, windowsOptions) });
      send({ type: 'scan', data: fakeScan(now, scenario) });
    }
    // A new funding line now and then; a still picture keeps the three entries it starts with.
    if (drift && desk !== 'waiting' && desk !== 'loading' && tick % 6 === 5) send({ type: 'journal', data: fakeFunding(now, tick) });
    if (desk !== 'loading') send({ type: 'desk', data: fakeDesk(now, tick, { mode: options.mode, scenario: desk, drift }) });
    tick += 1;
  };

  dispatch({ kind: 'connection', source: 'fake', connection: 'open' });
  step();
  const timer = setInterval(step, intervalMs);
  return () => {
    clearInterval(timer);
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
    'phoenix_login',
    'phoenix_invite',
    'phoenix_register',
  ];
  return { deskId: 'desk-07', steps: steps.map((step) => ({ step, status: 'done', tx: [] })) };
}
