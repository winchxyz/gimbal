import { clock } from '../journal/entry.ts';
import { Accounts } from './Accounts.tsx';
import { Columns } from './Columns.tsx';
import { Facts } from './Facts.tsx';
import { Head } from './Head.tsx';
import { Keys } from './Keys.tsx';
import { Refusals } from './Refusals.tsx';
import type { Reading } from './Sk.tsx';
import { SecurityEmpty, SecurityError } from './States.tsx';
import { useSecurity } from './useSecurity.ts';
import './security.css';

/**
 * The Security screen: why no key exists, the policy in plain words, what the operator's key may call, the accounts the
 * contract controls and every refusal it can give. Everything about the desk is read from the contract and the owner's
 * NEAR account, not from the engine (useSecurity.ts).
 */
export function SecurityScreen() {
  const { view, retry } = useSecurity();
  if (view.status === 'empty') return <SecurityEmpty />;
  if (view.status === 'error') return <SecurityError message={view.message} at={view.at} target={view.target} onRetry={retry} />;

  const reading: Reading = view.status === 'ready' ? { kind: 'ready', data: view.data } : { kind: view.status };
  return (
    <div className="s-page" aria-busy={view.status === 'loading'}>
      {view.status === 'ready' && view.stale ? (
        <p className="s-stale wt" role="status">
          Couldn’t read the contract again at {clock(view.stale.at)} UTC ({view.stale.error}). This is what was read at {clock(view.data.at)} UTC; the page
          keeps trying.
        </p>
      ) : null}
      <Head r={reading} />
      <Columns r={reading} />
      <Keys r={reading} />
      <Accounts r={reading} />
      <Facts r={reading} />
      <Refusals />
    </div>
  );
}
