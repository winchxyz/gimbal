import type { CSSProperties } from 'react';
import type { DeskState, Mode, StrategyConfig, Window as FundingWindow } from '@gimbal/shared';
import { VENUE_NAMES } from '../shell/status.ts';
import { cx } from '../ui/cx.ts';
import { pct, usd } from '../windows/format.ts';
import { deskMissing } from '../windows/model.ts';
import { StressButton } from './Stress.tsx';
import { STEPS, STEP_TITLES } from './model.ts';

/** A placeholder bar where a figure goes. */
function Sk({ w, h, className, style }: { w: number | string; h: number; className?: string; style?: CSSProperties }) {
  return <i className={cx('r-sk', className)} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/**
 * Loading (design/HANDOFF.md, Rescue: Loading): the labels and the seven step names stay, every figure is a placeholder
 * bar. It has the same frame as a rescue, so nothing jumps when the first one arrives.
 */
export function RescueLoading() {
  return (
    <div className="r-page" aria-busy="true" aria-label="Loading the rescue screen">
      <section className="r-hero">
        <div>
          <div className="r-lab">Time since detected</div>
          <div className="r-timer">
            <Sk w={220} h={92} />
          </div>
          <Sk w={140} h={14} style={{ marginTop: 12 }} />
        </div>
        <div className="mid">
          <div className="r-lab">Moving</div>
          <Sk w={180} h={40} />
          <Sk w={300} h={14} style={{ margin: '10px auto 0' }} />
        </div>
        <div className="end">
          <div className="r-lab">Distance to liquidation</div>
          <Sk w={140} h={40} />
          <Sk w={200} h={14} style={{ margin: '10px 0 0 auto' }} />
        </div>
      </section>

      <ol className="r-steps">
        {STEPS.map((id, i) => (
          <li key={id} className="todo">
            <span className="n">{i + 1}</span>
            <b>{STEP_TITLES[id]}</b>
            <p>
              <Sk w="90%" h={12} />
              <Sk w="60%" h={12} />
            </p>
            <span className="tm">
              <Sk w={44} h={12} />
            </span>
          </li>
        ))}
      </ol>

      <div className="r-bottom">
        <section>
          <h3>
            <span>The leg being rescued</span>
            <span>now</span>
          </h3>
          <div className="r-ba">
            {['Mark price', 'Margin', 'Liquidation price', 'Distance', 'Net exposure'].map((label) => (
              <div key={label}>
                <span>{label}</span>
                <Sk w={64} h={16} />
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>
            <span>Earlier rescues</span>
          </h3>
          <div className="r-past">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Sk w={44} h={14} />
                <Sk w={`${80 - i * 15}%`} h={14} />
                <Sk w={36} h={14} />
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>
            <span>Stress test</span>
            <span>testnet and replay only</span>
          </h3>
          <Sk w="80%" h={14} />
        </section>
      </div>
    </div>
  );
}

const legWord = (desk: DeskState, i: number): string => `${VENUE_NAMES[desk.legs[i]!.venue]} ${desk.legs[i]!.side}`;

interface StandingProps {
  desk: DeskState | null;
  windows: readonly FundingWindow[] | null;
  strategy: StrategyConfig | null;
  mode: Mode | null;
}

/**
 * Empty (design/HANDOFF.md, Rescue: Empty): "Standing by", with both distances and the reserve. With no desk at all it
 * says so instead, because there is no leg or reserve to read.
 */
export function Standing({ desk, windows, strategy, mode }: StandingProps) {
  if (desk === null || deskMissing(windows)) {
    return (
      <div className="r-empty">
        <div className="msg">
          <div className="r-lab">Rescue</div>
          <h1>No desk yet</h1>
          <p>There are no legs and no margin to rescue until a desk exists. When one runs, this screen shows each rescue step by step.</p>
          <div className="go">
            <a className="btn primary" href="#/windows">See all windows</a>
          </div>
        </div>
      </div>
    );
  }

  const line = strategy?.risk.rescueDistancePct ?? null;
  return (
    <div className="r-empty">
      <div className="msg">
        <div className="r-lab">Rescue</div>
        <h1>Standing by</h1>
        <p>
          {desk.legs.length === 0 ? (
            'No position is open, so there is nothing to rescue. If one opens and a leg gets close to liquidation, this screen shows each step.'
          ) : (
            <>
              The desk watches both legs. If one comes within <b>{line === null ? 'your rescue line' : `${line}% of liquidation`}</b>, it moves
              margin from the reserve or the other leg through NEAR Intents, usually in about a minute.
            </>
          )}
        </p>
        <div className="facts">
          {desk.legs.map((leg, i) => (
            <div key={leg.venue}>
              <b>{leg.distanceToLiqPct === null ? '—' : pct(leg.distanceToLiqPct)}</b>
              <span>{legWord(desk, i)} to liquidation</span>
            </div>
          ))}
          <div>
            <b>{usd(desk.reserveUsd)}</b>
            <span>reserve ready</span>
          </div>
        </div>
        <div className="go">
          <a className="btn quiet" href="#/journal">Earlier rescues</a>
          <StressButton mode={mode} running={false} />
        </div>
      </div>
    </div>
  );
}

/** Error: the page cannot reach the engine and has nothing to show (what failed, what is safe, what to do). */
export function RescueError({ reason }: { reason: string | null }) {
  return (
    <div className="r-empty">
      <div className="msg">
        <div className="r-lab">Rescue</div>
        <h1>Can’t reach the engine</h1>
        <p>
          This page cannot read the desk{reason ? ` (${reason})` : ''}, so there is no rescue to show. Your policy still holds on the contract and your
          money stays in the desk’s accounts. While the engine is down nothing is rescued.
        </p>
        <p>This page keeps trying and fills in by itself. You can also check the Desk.</p>
        <div className="go">
          <a className="btn" href="#/desk">Open Desk</a>
        </div>
      </div>
    </div>
  );
}
