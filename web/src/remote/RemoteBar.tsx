import { CONNECT_HREF } from '../shell/routes.ts';
import { hasOwnLine, needsToken, useProblem } from './problem.ts';
import { isReadOnly, READ_ONLY_LINE, remoteSettings } from './readonly.ts';

const hostOf = (base: string | null): string => {
  try {
    return base === null ? '' : new URL(base).host;
  } catch {
    return '';
  }
};

/**
 * Remote mode only: one plain line saying the page is read-only and where it reads from, and under it the amber line
 * when the engine refuses (a token it does not accept, a site it does not list, a pause it asked for).
 */
export function RemoteBar() {
  const problem = useProblem();
  if (!isReadOnly()) return null;
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
