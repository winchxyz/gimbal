import { useEffect } from 'react';
import { NOTICE_MS, clearNotice, useNotice } from './notice.ts';

/** A small note at the foot of the screen that says what a button did: amber when it was not sent. It goes by itself after a few seconds. */
export function NoticeBar() {
  const notice = useNotice();
  const id = notice?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(clearNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [id]);

  if (!notice) return null;
  return (
    <div className={notice.tone === 'ok' ? 'toast ok' : 'toast'} role="status">
      <b>{notice.title}</b>
      <span>{notice.text}</span>
      <button type="button" className="btn quiet" onClick={clearNotice}>Dismiss</button>
    </div>
  );
}
