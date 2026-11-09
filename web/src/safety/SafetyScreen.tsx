import type { Leg, StrategyConfig } from '@gimbal/shared';
import { ClosePair } from '../desk/DeskScreen.tsx';
import { qty } from '../desk/format.ts';
import { clock } from '../journal/entry.ts';
import { useJournal } from '../journal/useJournal.ts';
import { Earlier, Run } from '../rescue/Run.tsx';
import { Stress } from '../rescue/Stress.tsx';
import { Accounts } from '../security/Accounts.tsx';
import { Columns, Policy } from '../security/Columns.tsx';
import { Facts } from '../security/Facts.tsx';
import { Head } from '../security/Head.tsx';
import { Keys } from '../security/Keys.tsx';
import { Refusals } from '../security/Refusals.tsx';
import type { Reading } from '../security/Sk.tsx';
import { SecurityEmpty, SecurityError } from '../security/States.tsx';
import { useSecurity, type SecurityView } from '../security/useSecurity.ts';
import { VENUE_NAMES } from '../shell/status.ts';
import { useStream } from '../stream/hub.ts';
import { cx } from '../ui/cx.ts';
import { Flash } from '../ui/Flash.tsx';
import { pct, usd } from '../windows/format.ts';
import { deskMissing, heldWindow } from '../windows/model.ts';
import { useStrategy } from '../windows/useEngine.ts';
import { distanceTone } from '../desk/answer.ts';
import { rescueEstimate, safetyAnswer } from './answer.ts';
import '../security/security.css';
import './safety.css';

type Risk = StrategyConfig['risk'];

/**
 * Safety (Rescue and Security in one, brand book C): the sentence; each leg's distance to liquidation on a line with
 * the rescue and watch marks; the reserve and "Standing by", or the rescue in progress; then who can do what: no
 * private key, how an order gets signed, the policy in short, the operator's and the owner's powers, and the
 * contract's own record (the operator's key, the accounts, the facts, every refusal).
 */
export function SafetyScreen() {
  const rescue = useStream((s) => s.rescue);
  const desk = useStream((s) => s.desk);
  const engineMode = useStream((s) => s.mode);
  const windows = useStream((s) => s.windows);
  const noDesk = deskMissing(windows);
  const strategy = useStrategy().value;
  const security = useSecurity();
  const { entries } = useJournal();
  const mode = desk?.mode ?? engineMode;
  const risk = strategy?.risk ?? null;
  const shownDesk = noDesk ? null : desk;
  const loading = desk === null && !noDesk;
  const a = safetyAnswer({ desk: shownDesk, rescue, risk });
  const held = windows ? heldWindow(windows) : null;
  const estimate = rescueEstimate(held?.checks);
  const capPerHour = security.view.status === 'ready' ? security.view.data.desk.policy.rescue_cap_usd_per_hour : null;
  const running = rescue !== null && rescue.step !== 'landed' && rescue.step !== 'failed';

  return (
    <div className="sf">
      <section className="sf-hero" aria-label="How far from liquidation">
        {loading ? (
          <>
            <i className="d-sk" style={{ width: '62%', height: 64 }} />
            <i className="d-sk" style={{ width: '38%', height: 64, marginTop: 8 }} />
          </>
        ) : (
          <h1 className="answer wide" data-testid="safety-answer">
            {a.lead}
            {a.figure === null ? null : <span className={a.tone ?? undefined}>{a.figure}</span>}
            {a.rest}
          </h1>
        )}
      </section>

      {shownDesk ? (
        <div className="sf-two">
          <div className="sf-legs">
            {shownDesk.legs.length === 0 ? <p className="sf-none g">No position is open, so no leg can be liquidated.</p> : null}
            {shownDesk.legs.map((leg) => (
              <LegDistance key={leg.venue + leg.side} leg={leg} risk={risk} />
            ))}
          </div>

          <div className="sf-guard">
            <div className="sf-stand">
              <b>{shownDesk.rescueFailure ? 'Needs the owner' : running ? 'Rescue running' : 'Standing by'}</b>
              <span>
                {/* A rescue running is a watch state (amber); one that could not finish needs the owner (coral). */}
                <span className={cx('sf-dot', shownDesk.rescueFailure ? 'down' : running ? 'watch-t' : 'up')} aria-hidden="true" />
                {shownDesk.rescueFailure ? 'a rescue could not finish' : running ? 'started at the line' : 'nothing to rescue'}
              </span>
            </div>
            <div className="kv">
              <span>Rescue reserve</span>
              <span>
                <Flash value={shownDesk.reserveUsd}>{usd(shownDesk.reserveUsd)}</Flash>
              </span>
            </div>
            {risk ? (
              <>
                <div className="kv">
                  <span>A rescue starts</span>
                  <span>inside {pct(risk.rescueDistancePct, 0)} of liquidation</span>
                </div>
                <div className="kv">
                  <span>Watched from</span>
                  <span>{pct(risk.watchDistancePct, 0)}</span>
                </div>
              </>
            ) : null}
            {held && estimate ? (
              <div className="kv">
                <span>A rescue for {held.symbol}</span>
                <span>
                  {usd(estimate.amountUsd)}, up to {usd(estimate.costUsd)} a move
                </span>
              </div>
            ) : null}
            {capPerHour === null ? null : (
              <div className="kv">
                <span>Margin moves, at most</span>
                <span>{usd(capPerHour, 0)} an hour</span>
              </div>
            )}
            {shownDesk.rescueFailure && shownDesk.legs.length > 0 ? (
              <div className="sf-close">
                <ClosePair symbol={held?.symbol ?? shownDesk.legs[0]!.symbol} urgent />
              </div>
            ) : null}
            <p className="sf-lead g">A rescue moves margin from the reserve or the other leg through NEAR Intents, usually in about a minute.</p>
            {rescue ? null : (
              <div className="sf-standing">
                <Earlier entries={entries} before={Number.POSITIVE_INFINITY} />
                <Stress mode={mode} running={false} />
              </div>
            )}
          </div>
        </div>
      ) : null}

      {rescue ? <Run progress={rescue} desk={shownDesk} strategy={strategy} mode={mode} /> : null}

      <Security view={security.view} retry={security.retry} />
    </div>
  );
}

/** Where a distance sits on the 0 to 100 % line. */
const at = (p: number): string => `${Math.min(100, Math.max(0, p))}%`;

/** One leg: its side, venue and size, the distance in big type, and a line with the rescue and watch marks. */
function LegDistance({ leg, risk }: { leg: Leg; risk: Risk | null }) {
  const d = leg.distanceToLiqPct;
  const tone = distanceTone(d, risk);
  return (
    <div className="sf-leg">
      <div className="t">
        <b>
          {leg.side === 'short' ? 'Short' : 'Long'} {VENUE_NAMES[leg.venue]} · {qty(leg.size)} {leg.symbol}
        </b>
        <span className="d">
          <span className={tone ?? undefined}>
            <Flash value={d}>{d === null ? '—' : pct(d, 0)}</Flash>
          </span>
          <small>from liquidation</small>
        </span>
      </div>
      <div className="sf-dl" aria-hidden="true">
        {risk ? (
          <>
            <i className="mk" style={{ left: at(risk.rescueDistancePct) }} />
            <i className="mk" style={{ left: at(risk.watchDistancePct) }} />
            <span className="lb l" style={{ left: at(risk.rescueDistancePct) }}>
              {pct(risk.rescueDistancePct, 0)}
            </span>
            <span className="lb r" style={{ left: at(risk.watchDistancePct) }}>
              {pct(risk.watchDistancePct, 0)}
            </span>
          </>
        ) : null}
        {d === null ? null : <i className={cx('pt', tone)} style={{ left: at(d) }} />}
      </div>
    </div>
  );
}

/** Who can do what: read from the contract and the owner's NEAR account, not from the engine (security/useSecurity.ts). */
function Security({ view, retry }: { view: SecurityView; retry: () => void }) {
  if (view.status === 'empty') return <SecurityEmpty />;
  if (view.status === 'error') return <SecurityError message={view.message} at={view.at} target={view.target} onRetry={retry} />;
  const reading: Reading = view.status === 'ready' ? { kind: 'ready', data: view.data } : { kind: view.status };
  return (
    <div className="s-page" aria-busy={view.status === 'loading'}>
      {view.status === 'ready' && view.stale ? (
        <p className="s-stale g" role="status">
          Showing the contract as read at {clock(view.data.at)} UTC; the page reads it again by itself.
        </p>
      ) : null}
      <section className="s-head">
        <Head r={reading} />
        <Policy r={reading} />
      </section>
      <Columns r={reading} />
      <details className="s-more s-record">
        <summary>
          The contract’s own record: the operator’s key, the accounts, every refusal
          <i className="chev" aria-hidden="true" />
        </summary>
        <Keys r={reading} />
        <Accounts r={reading} />
        <Facts r={reading} />
        <Refusals />
      </details>
    </div>
  );
}
