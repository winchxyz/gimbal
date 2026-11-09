import { useStream } from '../stream/hub.ts';
import { CONNECT_HREF, OWNER_HREF } from '../shell/routes.ts';
import { NOT_CONFIGURED_TEXT, NOT_CONFIGURED_TITLE, usePollHostedLive } from './hosted.ts';
import { hasOwnLine, needsToken, useProblem } from './problem.ts';
import { HOSTED_LINE, hostedLiveLine, isHostedLive, isHostedReplay, isOwnerUnlocked, isRemote, READ_ONLY_LINE, remoteSettings } from './readonly.ts';

const hostOf = (base: string | null): string => {
  try {
    return base === null ? '' : new URL(base).host;
  } catch {
    return '';
  }
};

/**
 * Remote mode only: one plain line saying the page is read-only and where it reads from, and under it the amber line
 * when the engine refuses (a token it does not accept, a site it does not list, a pause it asked for). The hosted
 * replay's build: one plain line saying the page is a public, read-only replay. The public live view's build: one
 * plain line saying what the engine runs (live mainnet, read-only), a quiet Owner link to the owner's unlock (and Lock),
 * and the amber line when the host has no engine.
 */
export function RemoteBar() {
  if (isHostedLive()) return <HostedLiveBar />;
  return <RemoteOrReplayBar />;
}

function HostedLiveBar() {
  const mode = useStream((s) => s.desk?.mode ?? s.mode);
  const live = usePollHostedLive();
  return (
    <>
      <div className="ro-line">
        <span>{hostedLiveLine(live === 'not-configured' ? null : mode, isOwnerUnlocked())}</span>
        {/* Quiet, at the end of the line: the owner's way in, and to Lock. Nothing else changes for a visitor. */}
        <a href={OWNER_HREF}>Owner</a>
      </div>
      {live === 'not-configured' ? (
        <div className="notice" role="status">
          <b>{NOT_CONFIGURED_TITLE}</b>
          <span>{NOT_CONFIGURED_TEXT}</span>
        </div>
      ) : null}
    </>
  );
}

function RemoteOrReplayBar() {
  const problem = useProblem();
  if (!isRemote()) {
    return isHostedReplay() ? (
      <div className="ro-line">
        <span>{HOSTED_LINE}</span>
      </div>
    ) : null;
  }
  return (
    <>
      <div className="ro-line">
        <span>{READ_ONLY_LINE}</span>
        <span className="g3">{hostOf(remoteSettings().base)}</span>
        <a href={CONNECT_HREF}>Settings</a>
      </div>
      {hasOwnLine(problem) ? (
        <div className="notice" role="status">
          <b>{problem.title}</b>
          <span>{problem.text}</span>
          {needsToken(problem) ? (
            <a className="btn" href={CONNECT_HREF}>
              Enter token
            </a>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
