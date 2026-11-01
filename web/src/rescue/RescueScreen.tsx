import type { DeskState, JournalEntry, Leg, Mode, RescueProgress, StrategyConfig } from '@gimbal/shared';
import { price, qty } from '../desk/format.ts';
import type { ProofLink } from '../journal/entry.ts';
import { useJournal } from '../journal/useJournal.ts';
import { StatusActions } from '../shell/StatusActions.tsx';
import { VENUE_NAMES } from '../shell/status.ts';
import { useStatus } from '../shell/useStatus.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { useNow } from '../ui/useNow.ts';
import { pct, usd } from '../windows/format.ts';
import { deskMissing } from '../windows/model.ts';
import { useStrategy } from '../windows/useEngine.ts';
import {
  CHAIN_OF,
  STEPS,
  STEP_TITLES,
  clockText,
  distanceNote,
  durationText,
  earlierRows,
  failText,
  failedStep,
  failureOf,
  feesText,
  isRunning,
  movingOf,
  stepSeconds,
  stepStates,
  stepText,
  targetLeg,
  timerSeconds,
  triesText,
  txByStep,
  usualSeconds,
  type StepId,
  type StepState,
} from './model.ts';
import { RescueError, RescueLoading, Standing } from './States.tsx';
import { Stress } from './Stress.tsx';
import { useStepBook } from './useRescue.ts';
import './rescue.css';

/** The Rescue screen: the seven steps of a rescue with a live timer, or "Standing by" while there is none. */
export function RescueScreen() {
  const rescue = useStream((s) => s.rescue);
  const desk = useStream((s) => s.desk);
  const windows = useStream((s) => s.windows);
  const source = useStream((s) => s.source);
  const connection = useStream((s) => s.connection);
  const error = useStream((s) => s.error);
  const engineMode = useStream((s) => s.mode);
  const noDesk = useStream((s) => deskMissing(s.windows));
  const strategy = useStrategy().value;
  const mode = desk?.mode ?? engineMode;

  if (rescue === null) {
    if (desk === null && source === 'sse' && connection === 'retrying') return <RescueError reason={error} />;
    if (desk === null && !noDesk) return <RescueLoading />;
    return <Standing desk={desk} windows={windows} strategy={strategy} mode={mode} />;
  }
  return <Run progress={rescue} desk={desk} strategy={strategy} mode={mode} />;
}

// ---------- a rescue ----------

interface RunProps {
  progress: RescueProgress;
  desk: DeskState | null;
  strategy: StrategyConfig | null;
  mode: Mode | null;
}

function Run({ progress: p, desk, strategy, mode }: RunProps) {
  const now = useNow(1000);
  const book = useStepBook();
  const { entries } = useJournal();
  const status = useStatus('rescue');

  const running = isRunning(p);
  const failure = failureOf(p, desk);
  const failedAt = failedStep(p, failure, book);
  const states = stepStates(p.step, failedAt);
  const leg = targetLeg(desk, p);
  const line = strategy?.risk.rescueDistancePct ?? null;
  const seconds = timerSeconds(p, now);
  const txs = txByStep(p, CHAIN_OF[p.to]);
  const usual = usualSeconds(entries, p.startedAt);
  const moving = movingOf(p, failure);
  const distance = leg?.distanceToLiqPct ?? null;
  const failed = p.step === 'failed';
  // The phone has no buttons in the status line: the owner's choices go under the numbers when the desk needs them.
  const phoneActions = status && status.actions.buttons.length > 0 ? status.actions : null;

  return (
    <div className="r-page" data-step={p.step}>
      <section className="r-hero" aria-label="This rescue">
        <div>
          <div className="r-lab">{running || failed ? 'Time since detected' : 'Detected to landed'}</div>
          <div className="r-timer" role="timer" aria-label="Time since detected" data-testid="rescue-timer">
            {clockText(seconds)}
          </div>
          {usual === null ? null : <div className="r-lab">Usually done in {durationText(usual)}</div>}
        </div>
        <div className="mid">
          <div className="r-lab">{moving.label}</div>
          <div className="val">
            {moving.amount === null ? (
              <b className="say">{moving.text}</b>
            ) : (
              <>
                <b>{moving.amount}</b>
                <span>{moving.text}</span>
              </>
            )}
          </div>
        </div>
        <div className="end">
          <div className="r-lab">{leg ? `${VENUE_NAMES[p.to]} ${leg.side}, distance to liquidation` : `${VENUE_NAMES[p.to]}, distance to liquidation`}</div>
          <div className="val">
            <b className={cx(failed && distance !== null && line !== null && distance < line && 'neg')}>
              <Flash value={distance}>{distance === null ? '—' : pct(distance)}</Flash>
            </b>
            <span>{distanceNote(distance, line)}</span>
          </div>
        </div>
      </section>

      {phoneActions ? <StatusActions view={phoneActions} className="r-btns r-phone" /> : null}

      <ol className="r-steps" aria-label="Steps of the rescue">
        {STEPS.map((id, i) => (
          <Step
            key={id}
            id={id}
            n={i + 1}
            state={states[id]}
            text={states[id] === 'fail' ? failText(failure) : stepText(id, { p, leg, line })}
            time={timeOf(id, states[id], p, book, now, failure?.tries ?? null, failed)}
            replay={mode === 'testnet' && (id === 'quote' || id === 'deposit' || id === 'landed') && (states[id] === 'done' || states[id] === 'now')}
            tx={txs[id]}
          />
        ))}
      </ol>

      <div className="r-bottom">
        <Now leg={leg} desk={desk} p={p} />
        <Earlier entries={entries} before={p.startedAt} />
        <Stress mode={mode} running={running} />
      </div>
    </div>
  );
}

function timeOf(id: StepId, state: StepState, p: RescueProgress, book: Parameters<typeof stepSeconds>[0], now: number, tries: number | null, failed: boolean): string {
  const nowS = Math.max(p.elapsedS, (now - p.startedAt) / 1000);
  const took = stepSeconds(book, id, state, p, nowS);
  switch (state) {
    case 'done':
      return id === 'landed' ? `${durationText(p.elapsedS)} in all` : took === null ? '' : durationText(took);
    case 'now':
      return took === null ? 'running' : durationText(took);
    case 'fail': {
      const after = took === null ? `failed at ${clockText(p.elapsedS)}` : `failed after ${durationText(took)}`;
      return tries === null ? after : `${after} · ${triesText(tries)}`;
    }
    case 'todo':
      return failed ? 'not started' : '';
  }
}

interface StepProps {
  id: StepId;
  n: number;
  state: StepState;
  text: string;
  time: string;
  replay: boolean;
  tx: ProofLink[];
}

function Step({ id, n, state, text, time, replay, tx }: StepProps) {
  return (
    <li className={state} data-step={id} aria-current={state === 'now' ? 'step' : undefined}>
      <span className="n">{n}</span>
      <b>{STEP_TITLES[id]}</b>
      <p>{text}</p>
      <span className="tm">
        {time}
        {replay ? <span className="rp">{time === '' ? 'replay' : ' · replay'}</span> : null}
      </span>
      {tx.length > 0 ? (
        <span className="tx">
          {tx.map((t, i) => (
            <a key={`${t.chain}-${i}`} href={t.href} target="_blank" rel="noreferrer noopener" aria-label={`${t.label} transaction ${t.short}, opens in a new tab`}>
              {t.label} ↗ <span className="hash">{t.short}</span>
            </a>
          ))}
        </span>
      ) : null}
    </li>
  );
}

// ---------- the three blocks under the steps ----------

/** The leg the margin goes to, as it reads now. Before and after is not in the stream: the table is live, so it shows the landing as it arrives. */
function Now({ leg, desk, p }: { leg: Leg | null; desk: DeskState | null; p: RescueProgress }) {
  const rows: [string, string][] = leg
    ? [
        ['Mark price', price(leg.mark)],
        ['Margin', usd(leg.marginUsd)],
        ['Liquidation price', leg.liqPx === null ? '—' : price(leg.liqPx)],
        ['Distance', leg.distanceToLiqPct === null ? '—' : pct(leg.distanceToLiqPct)],
        ['Net exposure', `${qty(desk?.netDelta ?? 0)} ${leg.symbol}`],
      ]
    : [];
  return (
    <section aria-label="The leg being rescued">
      <h3>
        <span>{leg ? `${VENUE_NAMES[p.to]} ${leg.side}` : VENUE_NAMES[p.to]}</span>
        <span>now</span>
      </h3>
      {leg ? (
        <div className="r-ba">
          {rows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <span>
                <Flash value={value} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="note">The desk has no leg on {VENUE_NAMES[p.to]} to show right now.</p>
      )}
    </section>
  );
}

function Earlier({ entries, before }: { entries: readonly JournalEntry[]; before: number }) {
  const rows = earlierRows(entries, before);
  const usual = usualSeconds(entries, before);
  const fees = feesText(entries, before);
  return (
    <section aria-label="Earlier rescues">
      <h3>
        <span>Earlier rescues</span>
        {usual === null ? null : <span>usually {durationText(usual)}</span>}
      </h3>
      {rows.length === 0 ? <p className="note">None yet. Every rescue is listed here once it ends.</p> : null}
      <div className="r-past">
        {rows.map((r) => (
          <div key={r.id}>
            <span>{r.date}</span>
            <span className="what">{r.text}</span>
            <span>{r.seconds === null ? '' : durationText(r.seconds)}</span>
          </div>
        ))}
      </div>
      {rows.length === 0 ? null : (
        <p className="note">
          {fees ? `${fees} ` : ''}Every rescue is in the <a href="#/journal">Journal</a> with its transactions.
        </p>
      )}
    </section>
  );
}
