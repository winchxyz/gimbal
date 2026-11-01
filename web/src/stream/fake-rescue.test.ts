// The fake must drive the Rescue screen through every state, shaped like the shared types: a run that ends landed, a run
// that ends failed, a page opened mid-run, and the Stress button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RescueProgress } from '@gimbal/shared';
import { emptyBook, failedStep, failureOf, observe, stepStates, STEPS, type StepBook } from '../rescue/model.ts';
import { statusOf } from '../shell/status.ts';
import { FAKE_RESCUE_ID, fakeProgress, fakeRun, requestFakeStress, stressRun, takeFakeStress } from './fake-rescue.ts';
import { startFakeStream } from './fake.ts';
import { RESCUE_SCENARIOS, pickFakeRescue, pickSource } from './source.ts';
import { initialStreamState, parseStreamEvent, reduceStream, type StreamAction } from './store.ts';

const T0 = Date.UTC(2026, 9, 27, 14, 2);

/** The progress events a live run sends if it is looked at every `lookMs`, as the fake stream does. */
function play(run: NonNullable<ReturnType<typeof fakeRun>>, seconds: number, lookMs = 200): RescueProgress[] {
  const out: RescueProgress[] = [];
  let key = '';
  for (let t = 0; t <= seconds * 1000; t += lookMs) {
    const p = fakeProgress(run, run.playedAt + t, 'testnet');
    if (`${p.step}${p.tx.length}` !== key) {
      key = `${p.step}${p.tx.length}`;
      out.push(p);
    }
  }
  return out;
}

test('a run that lands goes through the seven steps in order and ends landed with its transactions', () => {
  const events = play(fakeRun('running', T0)!, 60);
  assert.deepEqual(events.filter((p, i) => i === 0 || p.step !== events[i - 1]!.step).map((p) => p.step), [...STEPS]);
  const last = events[events.length - 1]!;
  assert.equal(last.step, 'landed');
  assert.equal(last.elapsedS, 52);
  assert.deepEqual(last.tx.map((t) => t.chain), ['near', 'solana', 'hyperliquid']);
  assert.ok(last.tx.every((t) => t.url.startsWith('https://')));
  assert.deepEqual(STEPS.map((id) => stepStates(last.step, null)[id]), Array(7).fill('done'));
});

test('a run that fails stops at the quote and ends failed, with no transaction', () => {
  const events = play(fakeRun('failing', T0)!, 12);
  const steps = events.map((p) => p.step);
  assert.deepEqual(steps.filter((s, i) => i === 0 || s !== steps[i - 1]), ['detect', 'source', 'quote', 'failed']);
  const last = events[events.length - 1]!;
  assert.equal(last.elapsedS, 9);
  assert.deepEqual(last.tx, []);
});

test('the page works out per-step times from the events the fake sends', () => {
  let book: StepBook = emptyBook;
  for (const p of play(fakeRun('running', T0)!, 12)) book = observe(book, p);
  assert.equal(book.last, 'deposit');
  assert.ok((book.starts.sign ?? 0) > (book.starts.verify ?? 0));
});

test('a page opened mid-run starts at the Sign step and holds there while its clock keeps going', () => {
  const run = fakeRun('sign', T0)!;
  const a = fakeProgress(run, T0, 'testnet');
  const b = fakeProgress(run, T0 + 20_000, 'testnet');
  assert.equal(a.step, 'sign');
  assert.equal(b.step, 'sign');
  assert.equal(a.startedAt, T0 - 5_000);
  assert.equal(a.elapsedS, 5);
});

test('finished runs do not move', () => {
  const landed = fakeRun('landed', T0)!;
  assert.deepEqual(fakeProgress(landed, T0, 'testnet'), fakeProgress(landed, T0 + 600_000, 'testnet'));
  assert.equal(fakeProgress(landed, T0, 'testnet').step, 'landed');
  const failed = fakeRun('failed', T0)!;
  assert.equal(fakeProgress(failed, T0 + 600_000, 'testnet').step, 'failed');
  assert.equal(fakeProgress(failed, T0, 'testnet').elapsedS, 72);
  assert.equal(fakeRun('idle', T0), null);
});

const runStream = (options: Parameters<typeof startFakeStream>[1]) => {
  const actions: StreamAction[] = [];
  startFakeStream((a) => actions.push(a), { intervalMs: 60_000, drift: false, ...options })();
  return actions.reduce(reduceStream, initialStreamState());
};

test('the fake stream sends the rescue, and the desk\'s status line follows it', () => {
  const landed = runStream({ mode: 'testnet', rescue: 'landed' });
  assert.equal(landed.rescue?.step, 'landed');
  assert.equal(statusOf(landed.desk!).word, 'Level');

  const failed = runStream({ mode: 'testnet', rescue: 'failed' });
  assert.equal(failed.rescue?.step, 'failed');
  assert.equal(statusOf(failed.desk!).word, 'Needs you');
  // the rescue and the desk's failure are the same rescue, so the screen can say which step failed and why
  assert.equal(failed.rescue?.id, FAKE_RESCUE_ID);
  const failure = failureOf(failed.rescue!, failed.desk);
  assert.equal(failure?.step, 'quote');
  assert.equal(failedStep(failed.rescue!, failure, emptyBook), 'quote');
  assert.deepEqual(STEPS.map((id) => stepStates('failed', failure!.step)[id]), ['done', 'done', 'fail', 'todo', 'todo', 'todo', 'todo']);

  const running = runStream({ mode: 'testnet', rescue: 'running' });
  assert.equal(running.rescue?.step, 'detect');
  assert.equal(statusOf(running.desk!).word, 'Rescuing');
});

test('the idle fake sends no rescue; earlier rescues reach the journal; a fake without a rescue option sends neither', () => {
  const idle = runStream({ mode: 'testnet', rescue: 'idle' });
  assert.equal(idle.rescue, null);
  assert.equal(idle.journal.filter((e) => e.kind === 'rescue').length, 3);
  const none = runStream({ mode: 'testnet' });
  assert.equal(none.rescue, null);
  assert.equal(none.journal.some((e) => e.kind === 'rescue'), false);
});

test('an explicit desk scenario beats the rescue', () => {
  const s = runStream({ mode: 'testnet', rescue: 'failed', desk: 'level' });
  assert.equal(statusOf(s.desk!).word, 'Level');
});

test('the Stress button in the fake starts a rescue that lands', async () => {
  takeFakeStress();
  const actions: StreamAction[] = [];
  const stop = startFakeStream((a) => actions.push(a), { mode: 'testnet', intervalMs: 60_000, drift: false, rescue: 'idle' });
  assert.equal(actions.reduce(reduceStream, initialStreamState()).rescue, null);
  requestFakeStress();
  await new Promise((resolve) => setTimeout(resolve, 450));
  stop();
  const s = actions.reduce(reduceStream, initialStreamState());
  const first = actions.find((a) => a.kind === 'event' && a.event.type === 'rescue');
  assert.equal(first?.kind === 'event' && first.event.type === 'rescue' ? first.event.data.step : null, 'detect', 'it begins at the first step');
  assert.match(s.rescue?.id ?? '', /^rescue-stress-/);
  assert.equal(s.desk?.health, 'rescue');
  assert.equal(takeFakeStress(), false, 'the request is used up');
  assert.equal(stressRun(T0, 2).id, 'rescue-stress-2');
});

test('every event the fake sends passes the same parser as the engine\'s stream', () => {
  for (const scenario of RESCUE_SCENARIOS) {
    const run = fakeRun(scenario, T0);
    if (run === null) continue;
    for (const p of play(run, 60)) assert.notEqual(parseStreamEvent(JSON.stringify({ type: 'rescue', data: p })), null);
  }
});

test('?rescue= picks the fake rescue, and means the fake stream', () => {
  assert.equal(pickFakeRescue('?rescue=failing'), 'failing');
  assert.equal(pickFakeRescue('?rescue=nonsense'), 'idle');
  assert.equal(pickFakeRescue(''), 'idle');
  assert.equal(pickSource('?rescue=landed', true), 'fake');
  assert.equal(pickSource('?rescue=landed', false), 'sse');
});
