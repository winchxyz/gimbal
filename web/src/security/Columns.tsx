import { cx } from '../ui/cx.ts';
import { usd } from '../windows/format.ts';
import { Figure, ReplayNote, Sk, type Reading } from './Sk.tsx';
import { policyLines, policyShort } from './words.ts';

/** Placeholder rows for a policy that is still being read: the widths differ, as the lines will. */
const POLICY_BARS = [250, 330, 190, 300, 270, 230, 330, 200];

function PolicyList({ r }: { r: Reading }) {
  if (r.kind === 'replay') return <ReplayNote what="policy" />;
  if (r.kind === 'loading') {
    return (
      <ul className="s-list" aria-busy="true" aria-label="Reading the policy">
        {POLICY_BARS.map((w, i) => (
          <li key={i}>
            <Sk w={w} h={16} />
          </li>
        ))}
      </ul>
    );
  }
  const { desk } = r.data;
  return (
    <>
      <p className="s-pshort">{policyShort(desk.policy)}</p>
      <details className="s-more">
        <summary>
          The full policy<i className="chev" aria-hidden="true" />
        </summary>
        <ul className="s-list">
          {policyLines(desk.policy, desk.owner).map((line) => (
            <li key={line.key} className={cx(line.tone === 'watch' && 'wt')}>
              {line.text}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** Your policy in short, the full list one tap away (brand book C, Safety). */
export function Policy({ r }: { r: Reading }) {
  return (
    <div className="s-policy">
      <h2>Your policy</h2>
      <PolicyList r={r} />
      {r.kind === 'replay' ? null : (
        <>
          <p className="s-engine g">Leverage and the minimum net APR are engine rules. The contract does not enforce them.</p>
          <p className="s-sign g">
            Signed by <Figure r={r} w={110} h={12}>{(d) => d.desk.owner}</Figure>. A change is a new signature from that wallet.
          </p>
        </>
      )}
    </div>
  );
}

/** What the operator can and cannot do, and what only you can (three columns). */
export function Columns({ r }: { r: Reading }) {
  return (
    <section className="s-cols">
      <div>
        <h2>The operator can</h2>
        <ul className="s-yn">
          <li className="yes">
            Propose an order
            <small>The contract builds it, checks it, then signs or refuses.</small>
          </li>
          <li className="yes">
            Propose a margin move
            <small>
              Only between the desk’s own accounts, through a signed Intents quote, up to{' '}
              <Figure r={r} w={56} h={12} replay="the hourly cap in your policy">
                {(d) => `${usd(d.desk.policy.rescue_cap_usd_per_hour, 0)} an hour`}
              </Figure>
              .
            </small>
          </li>
          <li className="yes">
            Set up the desk’s exchange accounts
            <small>What it signs for them is fixed by the contract’s own settings.</small>
          </li>
          <li className="yes">
            Pause the desk
            <small>It can stop trading. Only you can resume.</small>
          </li>
          <li className="yes">
            Refresh oracle prices
            <small>Read-only; costs gas, moves no money.</small>
          </li>
        </ul>
      </div>

      <div>
        <h2>The operator cannot</h2>
        <ul className="s-yn">
          <li className="no">Withdraw to any address but yours</li>
          <li className="no">Trade an asset or size outside the policy</li>
          <li className="no">Change the policy or resume the desk</li>
          <li className="no">Get a key to an exchange account: there is none to give</li>
        </ul>
      </div>

      <div>
        <h2>Only you can</h2>
        <ul className="s-yn">
          <li className="yes">
            Resume a paused desk
            <small>The engine can pause it; only your wallet can resume it.</small>
          </li>
          <li className="yes">
            Pause and close at once
            <small>Panic close pauses the desk, then both legs are closed.</small>
          </li>
          <li className="yes">
            Withdraw
            <small>
              Always to{' '}
              <Figure r={r} w={110} h={12} replay="your account">
                {(d) => d.desk.owner}
              </Figure>
              .
            </small>
          </li>
          <li className="yes">
            Change the policy
            <small>A new signature from your wallet each time.</small>
          </li>
          <li className="yes">Replace the operator</li>
        </ul>
      </div>
    </section>
  );
}
