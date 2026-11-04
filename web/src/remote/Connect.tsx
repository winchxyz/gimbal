import { useEffect, useState, type FormEvent } from 'react';
import { CONNECT_HREF, hrefOf } from '../shell/routes.ts';
import { Wordmark } from '../shell/Wordmark.tsx';
import { hasOwnLine, useProblem } from './problem.ts';
import { remoteSettings } from './readonly.ts';
import { browserStores, forgetToken, parseBase, parseToken, saveSettings, switchToLocal } from './settings.ts';
import { engineReachable } from './view.ts';
import './remote.css';

type Reach = 'unknown' | 'checking' | 'yes' | 'no';

/** The page reads its settings once at load, so a change reloads it: the stream, the API and every control start from the new mode. */
const apply = (hash: string): void => {
  window.location.hash = hash;
  window.location.reload();
};

/**
 * The settings form: the engine's view address and the view token. Without them the app reads the engine on this
 * machine. The token is kept for this tab only and is never put in the address bar.
 */
export function Connect() {
  const saved = remoteSettings();
  const problem = useProblem();
  const [address, setAddress] = useState(saved.base ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach>('unknown');

  // "Reachable / not reachable" for the address as typed, once it is a whole address.
  useEffect(() => {
    const parsed = parseBase(address);
    if (!parsed.ok) {
      setReach('unknown');
      return;
    }
    setReach('checking');
    let current = true;
    const timer = setTimeout(() => {
      void engineReachable(parsed.value).then((ok) => {
        if (current) setReach(ok ? 'yes' : 'no');
      });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [address]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const base = parseBase(address);
    if (!base.ok) return setError(base.reason);
    const secret = parseToken(token);
    if (!secret.ok) return setError(secret.reason);
    saveSettings(browserStores(), base.value, secret.value);
    apply(hrefOf('desk'));
  };

  const shown = error ?? (hasOwnLine(problem) ? `${problem.title}. ${problem.text}` : null);
  const hint =
    reach === 'checking'
      ? 'Checking…'
      : reach === 'yes'
        ? 'Reachable.'
        : reach === 'no'
          ? 'Not reachable.'
          : `The engine has to list ${window.location.origin} as an allowed origin.`;
  return (
    <div className="app cx-app">
      <header className="hdr cx-hdr">
        <a className="brand" href={hrefOf('desk')} aria-label="Gimbal, go to Desk">
          <Wordmark />
        </a>
      </header>
      <main className="cx-page">
        <form className="cx-form" onSubmit={submit} autoComplete="off">
          <div className="lab">Engine</div>
          <h1>Connect to an engine</h1>
          <p>
            Read-only. Enter the address of a running engine’s view and its view token. Without them this page reads the engine on this machine.
          </p>
          <div className="cx-field">
            <label htmlFor="cx-address">Engine address</label>
            <input
              id="cx-address"
              className="cx-input"
              type="url"
              inputMode="url"
              placeholder="https://engine.example"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <p className={reach === 'no' ? 'cx-hint warn' : 'cx-hint'} role="status">
              {hint}
            </p>
          </div>
          <div className="cx-field">
            <label htmlFor="cx-token">View token</label>
            <input
              id="cx-token"
              className="cx-input"
              type="password"
              placeholder={saved.token === null ? '' : 'Entered in this tab'}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
            />
            <p className="cx-hint">Kept in this tab only, until it closes. It is never put in the address bar.</p>
          </div>
          {shown ? (
            <p className="cx-err" role="alert">
              {shown}
            </p>
          ) : null}
          <div className="cx-go">
            <button type="submit" className="btn primary">
              Connect
            </button>
            {saved.token === null ? null : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  forgetToken(browserStores());
                  apply(CONNECT_HREF);
                }}
              >
                Forget token
              </button>
            )}
            {saved.base === null ? null : (
              <button
                type="button"
                className="btn quiet"
                onClick={() => {
                  switchToLocal(browserStores());
                  apply(hrefOf('desk'));
                }}
              >
                Use the local engine
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
