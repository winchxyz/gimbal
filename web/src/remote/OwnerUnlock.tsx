import { useState, type FormEvent } from 'react';
import { hrefOf } from '../shell/routes.ts';
import { Wordmark } from '../shell/Wordmark.tsx';
import { forgetOwnerToken, ownerStore, ownerToken, unlockOwner } from './owner.ts';
import './remote.css';

/** The page reads the owner token once at load, so an unlock or a lock reloads it: the API and every control start over. */
const apply = (hash: string): void => {
  window.location.hash = hash;
  window.location.reload();
};

/**
 * The public live view's owner unlock: one question, the owner token. It is checked with GET /owner (which writes
 * nothing) before it is kept, and kept in this tab only. Unlocked, the page offers Lock instead.
 */
export function OwnerUnlock() {
  const unlocked = ownerToken() !== null;
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (checking) return;
    setChecking(true);
    setError(null);
    void unlockOwner(token, { session: ownerStore() }).then((answer) => {
      setChecking(false);
      if (answer.ok) return apply(hrefOf('markets'));
      setError(answer.reason);
    });
  };

  return (
    <div className="app cx-app">
      <header className="hdr cx-hdr">
        <a className="brand" href={hrefOf('desk')} aria-label="Gimbal, go to Desk">
          <Wordmark />
        </a>
      </header>
      <main className="cx-page">
        {unlocked ? (
          <div className="cx-form">
            <div className="lab">Owner</div>
            <h1>Unlocked in this tab</h1>
            <p>You can enter a market and close the held pair from this tab. The engine checks every request, and the contract checks every order against your policy.</p>
            <div className="cx-go">
              <a className="btn primary" href={hrefOf('markets')}>Markets</a>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  forgetOwnerToken(ownerStore());
                  apply(hrefOf('desk'));
                }}
              >
                Lock
              </button>
            </div>
          </div>
        ) : (
          <form className="cx-form" onSubmit={submit} autoComplete="off">
            <div className="lab">Owner</div>
            <h1>Unlock this desk</h1>
            <p>For the desk’s owner. Visitors read only; with the owner token this tab can enter a market and close the held pair.</p>
            <div className="cx-field">
              <label htmlFor="ow-token">Owner token</label>
              <input
                id="ow-token"
                className="cx-input"
                type="password"
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
              <p className="cx-hint">Kept in this tab only, until it closes or you lock it. It is never put in the address bar.</p>
            </div>
            {error ? (
              <p className="cx-err" role="alert">
                {error}
              </p>
            ) : null}
            <div className="cx-go">
              <button type="submit" className="btn primary" disabled={checking}>
                {checking ? 'Checking…' : 'Unlock'}
              </button>
              <a className="btn quiet" href={hrefOf('desk')}>Cancel</a>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
