import { useEffect, useRef } from 'react';
import type { Mode } from '@gimbal/shared';
import { useStream } from '../stream/hub.ts';
import { hrefOf } from '../shell/routes.ts';
import type { FlowState, OnboardingFlow } from './flow.ts';
import type { HeroOptions } from './hero/types.ts';
import { sentence } from './text.ts';

/** The gimbal behind the copy: the WebGL2 phosphor shader, or the 2D version where WebGL2 is missing. Stops with the page. */
function useHero(canvas: React.RefObject<HTMLCanvasElement | null>, quiet: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const control = new AbortController();
    const narrow = window.matchMedia('(max-width: 1023px)').matches;
    const options: HeroOptions = {
      look: 'phosphor',
      cx: narrow ? 0.5 : 0.72,
      cy: narrow ? 0.25 : 0.5,
      size: narrow ? 0.23 : 0.42,
      quiet: quiet.map((r) => r.current).filter((x): x is HTMLElement => x !== null),
      still: new URLSearchParams(window.location.search).has('still'),
      t: 6,
      signal: control.signal,
    };
    void (async () => {
      await Promise.all([import('./hero/gimbal-fx.js'), import('./hero/gimbal.js')]);
      const drawn = await window.GimbalFX?.mount(el, options);
      if (!drawn && !control.signal.aborted) {
        el.classList.add('fallback');
        await window.GimbalAscii?.mount(el, options);
      }
      el.dataset.ready = '1';
    })();
    return () => control.abort();
    // The refs point at this component's own nodes and `quiet` is a new array on every render: the hero is drawn once per mount.
  }, []);
}

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  mode: Mode | null;
}

export function Welcome({ flow, s, mode }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const copy = useRef<HTMLElement>(null);
  const facts = useRef<HTMLElement>(null);
  useHero(canvas, [copy, facts]);

  const windows = useStream((x) => x.windows);
  const scan = useStream((x) => x.scan);
  const best = windows && windows.length > 0 ? Math.max(...windows.map((w) => w.netAprPct)) : null;
  const waiting = s.busy === 'connect';
  const failed = s.errors.connect !== undefined && !waiting;
  const look = mode === 'replay' ? { href: hrefOf('desk'), label: 'Watch the replay first' } : { href: hrefOf('windows'), label: 'Look at the windows first' };

  if (failed) {
    return (
      <div className="ob-statepage">
        <div className="state-msg">
          <div className="lab">Connect</div>
          <h1>No NEAR wallet answered</h1>
          <p>The wallet window closed or was blocked by the browser. Gimbal only asks your wallet to sign; it never sees a key.</p>
          <p className="g3">{sentence(s.errors.connect ?? '')}</p>
          <div className="go">
            <button type="button" className="btn big primary" onClick={() => void flow.connect()}>
              Try again
            </button>
            <a className="btn big" href={look.href}>
              {look.label.replace('first', 'instead')}
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-welcome">
      <canvas ref={canvas} className="gimbal-bg" aria-hidden="true" />
      <section className="hero-copy" ref={copy}>
        <h1>Stays level when the market doesn’t.</h1>
        <p className="wide">
          Hold a long on one exchange and a short on another, earn the funding gap, and move margin before either side can be liquidated. A NEAR contract signs every order. Nobody holds a key.
        </p>
        <p className="narrow">Long on one exchange, short on another. Earn the funding gap while a NEAR contract signs every order. Nobody holds a key.</p>
        <div className="go">
          {waiting ? (
            <span className="g" role="status">
              Waiting for your wallet to confirm…
            </span>
          ) : (
            <>
              <button type="button" className="btn big primary" onClick={() => void flow.connect()}>
                Connect NEAR wallet
              </button>
              <a className="btn big" href={look.href}>
                {look.label}
              </a>
            </>
          )}
        </div>
        <p className="cap">
          <i />
          The rings swing with the market. The green platform is your desk.
        </p>
      </section>
      <section className="hero-facts" ref={facts} aria-label="Facts">
        <div>
          <b style={{ color: 'var(--level)' }}>0</b>
          <span>private keys</span>
        </div>
        {best !== null ? (
          <div>
            <b>{best.toFixed(1)}%</b>
            <span>best window now, net a year</span>
          </div>
        ) : null}
        <div>
          <b>about 1 min</b>
          <span>to move margin before liquidation</span>
        </div>
        {scan ? (
          <div>
            <b>{scan.venues}</b>
            <span>venues scanned</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
