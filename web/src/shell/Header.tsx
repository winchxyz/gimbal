import type { Mode } from '@gimbal/shared';
import { useStream } from '../stream/hub.ts';
import type { Connection } from '../stream/store.ts';
import { dotColor } from '../ui/dot.ts';
import { writeControls } from '../remote/readonly.ts';
import { ONBOARDING_HREF, SCREENS, hrefOf, type ScreenId } from './routes.ts';
import { Wordmark } from './Wordmark.tsx';

const NETWORKS: Record<Mode, { label: string; dot: string }> = {
  mainnet: { label: 'Mainnet', dot: 'var(--level)' },
  testnet: { label: 'Testnet', dot: 'var(--testnet)' },
  replay: { label: 'Replay', dot: 'var(--replay)' },
};

const CONNECTING: Record<Connection, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  open: 'No desk yet',
  retrying: 'Reconnecting',
};

export function Header({ screen }: { screen: ScreenId }) {
  const desk = useStream((s) => s.desk);
  const connection = useStream((s) => s.connection);
  const engineMode = useStream((s) => s.mode);
  // The desk names its network; before a desk exists the engine still knows which one it runs on (`GET /state`).
  const mode = desk?.mode ?? engineMode;

  return (
    <header className="hdr">
      <a className="brand" href={hrefOf('desk')} aria-label="Gimbal, go to Desk">
        <Wordmark />
      </a>
      <nav className="sections" aria-label="Sections">
        {SCREENS.map((s) => (
          <a
            key={s.id}
            href={hrefOf(s.id)}
            className={s.id === screen ? 'on' : undefined}
            aria-current={s.id === screen ? 'page' : undefined}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <div className="right">
        {mode ? (
          <span className="dot net" style={dotColor(NETWORKS[mode].dot)}>
            {NETWORKS[mode].label}
          </span>
        ) : (
          <span className="dot" style={dotColor('var(--ink-3)')}>
            {CONNECTING[connection]}
          </span>
        )}
        {desk && <span>{desk.deskId}</span>}
        {mode && <MoneyActions mode={mode} />}
      </div>
    </header>
  );
}

// design/HANDOFF.md, Network: testnet swaps Add funds for Get test USDC; replay has no money buttons.
// Connecting and adding funds both open onboarding, which reads the chain and lands on the step that is next for this
// wallet (the funds step once the desk exists). The phone has no header buttons: the Desk screen draws the same pair
// under the desk value, with its own `className`.
export function MoneyActions({ mode, className = 'money' }: { mode: Mode; className?: string }) {
  // Read-only view: nothing here is drawn; every one of these opens a wallet or the set-up flow.
  if (!writeControls().money) return null;
  if (mode === 'replay') {
    return (
      <span className={className}>
        <button type="button" className="btn">Exit replay</button>
        <a className="btn primary" href={ONBOARDING_HREF}>Connect wallet</a>
      </span>
    );
  }
  return (
    <span className={className}>
      <button type="button" className="btn">Withdraw</button>
      <a className="btn primary" href={ONBOARDING_HREF}>{mode === 'testnet' ? 'Get test USDC' : 'Add funds'}</a>
    </span>
  );
}
