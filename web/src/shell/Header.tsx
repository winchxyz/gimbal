import type { Mode } from '@gimbal/shared';
import { NOT_CONFIGURED_TEXT, NOT_CONFIGURED_TITLE, useHostedOwnerWrites, usePollHostedLive } from '../remote/hosted.ts';
import { hasOwnLine, needsToken, useProblem } from '../remote/problem.ts';
import { isHostedLive, isOwnerUnlocked, isReadOnly, isRemote, writeControls } from '../remote/readonly.ts';
import { useStream } from '../stream/hub.ts';
import { cx } from '../ui/cx.ts';
import { useNow } from '../ui/useNow.ts';
import { degradedOf, headline } from './headline.ts';
import { CONNECT_HREF, ONBOARDING_HREF, OWNER_HREF, SCREENS, hrefOf, type ScreenId } from './routes.ts';
import { Wordmark } from './Wordmark.tsx';

/**
 * The header: the logo, the four sections (the phone moves them to the bottom tab bar) and the one status line
 * (`Live · mainnet · checked 5 s ago`). A link sits after the line only when it is the way out of what the line says
 * (enter a token, use another engine) or the owner's door on the public live view.
 */
export function Header({ screen }: { screen: ScreenId | null }) {
  return (
    <header className="hdr">
      <a className="brand" href={hrefOf('desk')} aria-label="Gimbal, go to Desk">
        <Wordmark />
      </a>
      <nav className="sections" aria-label="Sections">
        {SCREENS.map((s) => (
          <a key={s.id} href={hrefOf(s.id)} className={s.id === screen ? 'on' : undefined} aria-current={s.id === screen ? 'page' : undefined}>
            {s.label}
          </a>
        ))}
      </nav>
      <HeaderStatus />
    </header>
  );
}

function HeaderStatus() {
  const source = useStream((s) => s.source);
  const connection = useStream((s) => s.connection);
  const mode = useStream((s) => s.desk?.mode ?? s.mode);
  const checkedAt = useStream((s) => s.desk?.updatedAt ?? s.scan?.at ?? null);
  const heardAt = useStream((s) => s.heardAt);
  const now = useNow(1000);
  const pageNow = useNow(1000, 'page');
  const problem = useProblem();
  const hosted = usePollHostedLive();
  const ownerWrites = useHostedOwnerWrites();
  const unlocked = isOwnerUnlocked();
  const degraded = useStream((s) => degradedOf(s.desk, s.health));

  const shown =
    hosted === 'not-configured'
      ? { title: NOT_CONFIGURED_TITLE, text: NOT_CONFIGURED_TEXT }
      : isRemote() && hasOwnLine(problem)
        ? problem
        : null;
  const h = headline({ source, connection, mode, checkedAt, heardAt, now, pageNow, problem: shown, owner: unlocked, readOnly: isReadOnly(), degraded });

  return (
    <div className="right">
      <span className={cx('hl', h.tone)} title={h.more ?? undefined} role="status">
        <span className="hl-long">{h.text}</span>
        <span className="hl-short" aria-hidden="true">{h.short}</span>
        {h.more ? <span className="sr">. {h.more}</span> : null}
      </span>
      {isRemote() && needsToken(problem) ? <a href={CONNECT_HREF}>Enter token</a> : isRemote() ? <a className="quiet" href={CONNECT_HREF}>Settings</a> : null}
      {!isReadOnly() && source === 'sse' && connection === 'retrying' ? <a href={CONNECT_HREF}>Use a remote engine</a> : null}
      {isHostedLive() && (ownerWrites || unlocked) ? <a className="quiet" href={OWNER_HREF}>Owner</a> : null}
    </div>
  );
}

// Adding funds opens onboarding, which reads the chain and lands on the step that is next for this wallet (the funds
// step once the desk exists). Not drawn read-only, and not for a replay, which has no money.
export function MoneyActions({ mode, className = 'money' }: { mode: Mode; className?: string }) {
  if (!writeControls().money || mode === 'replay') return null;
  return (
    <span className={className}>
      {/* In the header it is a link among links; on a screen it is an action, so it takes the button's shape. */}
      <a className={className === 'money' ? undefined : 'btn'} href={ONBOARDING_HREF}>{mode === 'testnet' ? 'Get test USDC' : 'Add funds'}</a>
    </span>
  );
}
