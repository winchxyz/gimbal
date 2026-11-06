import { useHostedLive } from '../remote/hosted.ts';
import { hasOwnLine, useProblem } from '../remote/problem.ts';
import { isReadOnly } from '../remote/readonly.ts';
import { useStream } from '../stream/hub.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { connectionNotice } from './connection.ts';
import { CONNECT_HREF } from './routes.ts';

/** The amber line that says the engine stopped answering, on every screen. It goes by itself when the stream is back. */
export function ConnectionBar() {
  const source = useStream((s) => s.source);
  const connection = useStream((s) => s.connection);
  const error = useStream((s) => s.error);
  const heardAt = useStream((s) => s.heardAt);
  const now = useNow(1000, 'page');
  const problem = useProblem();
  const hosted = useHostedLive();

  const notice = connectionNotice({ source, connection, error }, heardAt === null ? null : ago(heardAt, now));
  if (!notice) return null;
  // Remote: a refusal with its own wording (token, site, pause) is said once, by the remote bar.
  if (isReadOnly() && hasOwnLine(problem)) return null;
  // The public live view with no engine configured: the remote bar says so; "not answering" would only repeat it.
  if (hosted === 'not-configured') return null;
  return (
    <div className="notice" role="status">
      <b>{notice.title}</b>
      <span>{notice.text}</span>
      {isReadOnly() ? null : (
        <a className="btn quiet" href={CONNECT_HREF}>
          Use a remote engine
        </a>
      )}
    </div>
  );
}
