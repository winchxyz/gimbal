import { useStream } from '../stream/hub.ts';
import { ago, useNow } from '../ui/useNow.ts';
import { connectionNotice } from './connection.ts';

/** The amber line that says the engine stopped answering, on every screen. It goes by itself when the stream is back. */
export function ConnectionBar() {
  const source = useStream((s) => s.source);
  const connection = useStream((s) => s.connection);
  const error = useStream((s) => s.error);
  const heardAt = useStream((s) => s.heardAt);
  const now = useNow(1000, 'page');

  const notice = connectionNotice({ source, connection, error }, heardAt === null ? null : ago(heardAt, now));
  if (!notice) return null;
  return (
    <div className="notice" role="status">
      <b>{notice.title}</b>
      <span>{notice.text}</span>
    </div>
  );
}
