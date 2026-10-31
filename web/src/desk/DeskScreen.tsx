import type { DeskState, JournalEntry, Leg, ScanStatus, StrategyConfig, VenueId, Window as FundingWindow } from '@gimbal/shared';
import { MoneyActions } from '../shell/Header.tsx';
import { StatusActions } from '../shell/StatusActions.tsx';
import { downVenues, type StatusActionsView } from '../shell/status.ts';
import { useStatus } from '../shell/useStatus.ts';
import { useStream } from '../stream/hub.ts';
import { Flash } from '../ui/Flash.tsx';
import { cx } from '../ui/cx.ts';
import { dotColor } from '../ui/dot.ts';
import { notify } from '../ui/notice.ts';
import { useNow } from '../ui/useNow.ts';
import { pct, usd } from '../windows/format.ts';
import { bestEnterable, deskMissing, heldWindow } from '../windows/model.ts';
import { useStrategy } from '../windows/useEngine.ts';
import { elapsed, splitUsd, signedUsd } from './format.ts';
import {
  dayRate,
  distanceText,
  exposureOf,
  hoursLeftText,
  isDown,
  latestEvents,
  legRows,
  legTitle,
  moveText,
  nextBest,
  paybackOf,
  placeLegs,
  pnlRows,
  sizeText,
  thresholdText,
  type EventRow,
} from './model.ts';
import { DeskLoading } from './States.tsx';
import './desk.css';

/** The Desk screen: both legs facing each other, the desk value between them, and what the desk did last. */
export function DeskScreen() {
  const desk = useStream((s) => s.desk);
  const windows = useStream((s) => s.windows);
  const scan = useStream((s) => s.scan);
  const journal = useStream((s) => s.journal);
  const health = useStream((s) => s.health);
  const strategy = useStrategy().value;
  const status = useStatus('desk');
  const noDesk = useStream((s) => deskMissing(s.windows));
  const now = useNow(10_000);

  if (desk === null || status === null) return noDesk ? <NoDesk scan={scan} now={now} /> : <DeskLoading />;
  if (desk.legs.length === 0) return <Waiting desk={desk} windows={windows} strategy={strategy} scan={scan} now={now} />;

  return (
    <Stage
      desk={desk}
      windows={windows}
      strategy={strategy}
      journal={journal}
      down={downVenues(desk, health)}
      now={now}
      phoneActions={status.actions}
    />
  );
}

// ---------- the stage ----------

interface StageProps {
  desk: DeskState;
  windows: readonly FundingWindow[] | null;
  strategy: StrategyConfig | null;
  journal: readonly JournalEntry[];
  down: readonly VenueId[];
  now: number;
  /** The status line's buttons, drawn again at the bottom of the page on the phone, where the line has none. */
  phoneActions: StatusActionsView;
}

function Stage({ desk, windows, strategy, journal, down, now, phoneActions }: StageProps) {
  const { left, right } = placeLegs(desk.legs);
  const rate = dayRate(windows ? heldWindow(windows) : null, desk.legs);
  const payback = paybackOf(desk.pnl, rate?.perDayUsd ?? null);
  const exposure = exposureOf(desk);
  const value = splitUsd(desk.equityUsd);

  return (
    <div className="d-page">
      <div className="d-grid">
        <section className="d-hero" aria-label="Desk value">
          <div className="lab">Desk value</div>
          <div className="d-value" data-testid="desk-value">
            <Flash value={desk.equityUsd}>
              {value.dollars}
              <small>{value.cents}</small>
            </Flash>
          </div>
          {rate ? (
            <p className="d-rate">
              <span className={rate.perDayUsd < 0 ? 'neg' : 'pos'}>
                <Flash value={rate.perDayUsd}>{signedUsd(rate.perDayUsd)}</Flash> a day
              </span>{' '}
              <span className="g">· {pct(rate.netAprPct)} a year after costs</span>
            </p>
          ) : null}
          <div className="d-payback">
            {payback.earnedBack ? null : (
              <div className="t" role="progressbar" aria-label="Entry costs earned back" aria-valuemin={0} aria-valuemax={100} aria-valuenow={payback.pct}>
                <i style={{ width: `${payback.pct}%` }} />
              </div>
            )}
            <div className="c">
              <span>{payback.earnedBack ? 'Entry costs earned back' : `Entry costs ${payback.pct}% earned back`}</span>
              {payback.hoursLeft !== null && !payback.earnedBack ? <span>{hoursLeftText(payback.hoursLeft)}</span> : null}
            </div>
          </div>
          <p className="d-reserve">Includes {usd(desk.reserveUsd)} held in reserve for rescues</p>
          <MoneyActions mode={desk.mode} className="btns d-phone" />
        </section>

        <Half side="left" leg={left} down={down} now={now} risk={strategy?.risk ?? null} />
        <Half side="right" leg={right} down={down} now={now} risk={strategy?.risk ?? null} />

        <section className="d-exposure" aria-label="Net exposure">
          <div className="lab">Net exposure</div>
          <div className={cx('d-net', exposure.drift && 'wt')}>
            <Flash value={desk.netDelta}>{exposure.text}</Flash>
          </div>
          <p className={cx('ex', exposure.drift && 'wt')}>{exposure.explain}</p>
        </section>

        <section className="d-pnl" aria-label="Profit and loss">
          <div className="lab d-phone">Profit and loss</div>
          <div className="d-pnl-rows">
            {pnlRows(desk.pnl).map((r) => (
              <div key={r.key} className={cx(r.key === 'net' && 'tot')}>
                <span>{r.label}</span>
                <span className={r.tone ?? undefined}>
                  <Flash value={r.value} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="d-bottom">
        <Latest events={latestEvents(journal, now)} />
        <NextBest windows={windows} strategy={strategy} />
      </div>

      <div className="d-actions d-phone">
        <StatusActions view={phoneActions} skip={['auto']} className="btns" />
      </div>
    </div>
  );
}

// ---------- one leg ----------

interface HalfProps {
  side: 'left' | 'right';
  leg: Leg | null;
  down: readonly VenueId[];
  now: number;
  /** The owner's thresholds (`StrategyConfig.risk`), or null until the strategy has been read. */
  risk: StrategyConfig['risk'] | null;
}

function Half({ side, leg, down, now, risk }: HalfProps) {
  if (leg === null) {
    // One leg only: the desk is not hedged. Say so where the other leg would be.
    return (
      <>
        <div className={cx('d-head', side, 'missing')}>
          <h2>{side === 'left' ? 'No short' : 'No long'}</h2>
          <p className="sub">The desk holds one leg only.</p>
        </div>
        <div className={cx('d-rows', side)} />
      </>
    );
  }

  const stale = isDown(leg, down);
  return (
    <>
      <div className={cx('d-head', side, stale && 'stale')}>
        <div className="d-title">
          <h2>{legTitle(leg)}</h2>
          <p className="sub">
            {stale ? (
              'Figures may be out of date · the desk keeps trying'
            ) : (
              <>
                {sizeText(leg)}
                <span className="d-desk"> · {usd(leg.marginUsd)} margin</span>
              </>
            )}
          </p>
        </div>
        {leg.unpriced ? (
          <p className="d-flag dot wt" style={dotColor('var(--watch)')}>
            No price protection<span className="g"> · opened without an oracle price band</span>
          </p>
        ) : null}
        <div className={cx('dist', leg.unpriced && 'flagged')}>
          <Flash value={leg.distanceToLiqPct}>{distanceText(leg)}</Flash>
        </div>
        <p className="move">{moveText(leg)}</p>
        {thresholdText(risk) ? <p className="thr d-desk">{thresholdText(risk)}</p> : null}
      </div>
      <div className={cx('d-rows', side, stale && 'stale')}>
        {legRows(leg, now).map((r) => (
          <div key={r.key} className={r.only === 'desktop' ? 'd-desk' : r.only === 'phone' ? 'd-phone' : undefined}>
            <span>{r.label}</span>
            <span className={r.tone ?? undefined}>
              <Flash value={r.value} />
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- latest events and the next window ----------

function Latest({ events }: { events: EventRow[] }) {
  return (
    <section className="d-latest" aria-label="Latest">
      <h3>
        <span>Latest</span>
        <a href="#/journal">Journal</a>
      </h3>
      {events.length === 0 ? <p className="g d-none">Nothing yet. What the desk does shows up here.</p> : null}
      {events.map((e) => (
        <div key={e.id} className={cx('ev', e.amountUsd !== null && 'has-amt')}>
          <span className="t">{e.when}</span>
          <span className="what">
            {e.text}
            {e.unprotected ? (
              <>
                <span className="sep"> · </span>
                <span className="flag wt">{e.unprotected}</span>
              </>
            ) : null}
          </span>
          {e.amountUsd !== null ? <span className={cx('amt', 'd-phone', e.amountUsd < 0 ? 'neg' : 'pos')}>{signedUsd(e.amountUsd)}</span> : null}
          {e.proof ? (
            <a className="proof" href={e.proof.href} {...(e.proof.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
              {e.proof.label}
            </a>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function NextBest({ windows, strategy }: { windows: readonly FundingWindow[] | null; strategy: StrategyConfig | null }) {
  const next = windows ? nextBest(windows, strategy) : null;
  return (
    <section className="d-next" aria-label="Next best window">
      <h3>
        <span>Next best window</span>
        <a href="#/windows">All windows</a>
      </h3>
      {windows === null ? (
        <p className="g d-none">Waiting for the scanner…</p>
      ) : next ? (
        <>
          <div className="next">
            <span>
              <b>{next.symbol}</b>
              <span className="g"> {next.pair}</span>
            </span>
            <b>{pct(next.netAprPct)}</b>
          </div>
          <p className="note">{next.text}</p>
        </>
      ) : (
        <p className="g d-none">No other window is open to the desk right now.</p>
      )}
    </section>
  );
}

// ---------- no position ----------

interface WaitingProps {
  desk: DeskState;
  windows: readonly FundingWindow[] | null;
  strategy: StrategyConfig | null;
  scan: ScanStatus | null;
  now: number;
}

/**
 * The engine runs but no desk is loaded (it refuses every desk window with E_NO_DESK): there are no legs, margin or
 * value to draw. The mockups have no screen for it, so it is the Empty screen's frame with what is true.
 */
function NoDesk({ scan, now }: { scan: ScanStatus | null; now: number }) {
  return (
    <div className="d-empty">
      <div className="msg">
        <div className="lab">Desk</div>
        <h1>No desk yet</h1>
        <p>
          The engine is running and reading funding{scan ? ` on ${scan.venues} venues, ${elapsed(now - scan.at)} ago` : ''}, but no desk is
          loaded. There are no legs, margin or value to show until one exists.
        </p>
        <div className="go">
          <a className="btn primary" href="#/windows">See all windows</a>
        </div>
      </div>
    </div>
  );
}

/** No legs (design/HANDOFF.md, Desk: Empty): the desk value, best window now against the owner's minimum, and a way to Windows. */
function Waiting({ desk, windows, strategy, scan, now }: WaitingProps) {
  const best = windows ? bestEnterable(windows) : null;
  const minimum = strategy?.minNetAprPct ?? null;
  const rounded = (n: number) => (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1));
  return (
    <div className="d-empty">
      <div className="msg">
        <div className="lab">Desk value</div>
        <h1 data-testid="desk-value">
          <Flash value={desk.equityUsd}>{usd(desk.equityUsd)}</Flash>
        </h1>
        <p>
          Your money sits in the desk’s accounts and earns nothing until a window pays{' '}
          {minimum === null ? (
            'at least your minimum after costs'
          ) : (
            <>
              at least <b>{rounded(minimum)}% a year after costs</b>
            </>
          )}
          . {scan ? `The scanner checks ${scan.venues} venues every few seconds.` : 'The scanner checks every venue every few seconds.'}
        </p>
        <div className="facts">
          <div>
            <b>{best ? pct(best.netAprPct) : '—'}</b>
            <span>best you allow now{best ? `, ${best.symbol}` : ''}</span>
          </div>
          <div>
            <b>{minimum === null ? '—' : `${rounded(minimum)}%`}</b>
            <span>your minimum</span>
          </div>
          <div>
            <b>{scan ? elapsed(now - scan.at) : '—'}</b>
            <span>since the last scan</span>
          </div>
        </div>
        <div className="go">
          <a className="btn primary" href="#/windows">See all windows</a>
          <button
            type="button"
            className="btn quiet"
            onClick={() => notify('Your minimum is part of the rules. Changing a signed policy is not built yet. Nothing changed.')}
          >
            Change my minimum
          </button>
        </div>
        <MoneyActions mode={desk.mode} className="btns d-phone" />
      </div>
    </div>
  );
}
