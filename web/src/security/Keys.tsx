import { netOf, nearUrl } from './explorer.ts';
import { OTHER_CALLERS, OWNER_ONLY, readKeys, RESUME, type OperatorKey } from './keys.ts';
import { ExtLink } from './ExtLink.tsx';
import type { SecurityData } from './load.ts';
import { ReplayNote, Sk, type Reading } from './Sk.tsx';
import { fullAccessText } from './words.ts';

function KeyCard({ k }: { k: OperatorKey }) {
  const count = k.noMethodList ? 'no method list' : `${k.methods.length} ${k.methods.length === 1 ? 'method' : 'methods'}`;
  return (
    <div className="s-key">
      <div className="s-key-id">
        <span className="mono">{k.publicKey}</span>
        <span className="g">
          {count} · {k.allowance === null ? <span className="wt">no allowance limit</span> : `${k.allowance} NEAR of gas allowance left`}
        </span>
      </div>
      {k.noMethodList ? (
        <p className="s-key-warn wt">
          This key lists no methods, which NEAR reads as every method of the contract. The contract still refuses what only you may do, because those calls
          need 1 yoctoNEAR and a function-call key cannot attach a deposit. Replace the key with one that lists the operator methods.
        </p>
      ) : (
        <dl className="s-key-groups">
          {k.groups.map((g) => (
            <div key={g.label}>
              <dt>
                {g.label}
                <small>{g.what}</small>
              </dt>
              <dd className="mono">{g.methods.join(' ')}</dd>
            </div>
          ))}
        </dl>
      )}
      {k.extra.length > 0 && !k.noMethodList ? (
        <p className="s-key-warn wt">
          Also lists <span className="mono">{k.extra.join(' ')}</span>, which the operator does not need. The contract still refuses them from this key.
        </p>
      ) : null}
    </div>
  );
}

function KeyList({ data }: { data: SecurityData }) {
  const net = netOf(data.target.mode);
  const { keys, fullAccess } = readKeys(data.keys, data.target.contractId);
  const operator = data.desk.operator;
  const operatorHref = operator === null ? null : nearUrl(operator, net);
  return (
    <>
      {keys.length === 0 ? (
        <p className="s-note g">
          No function-call key for {data.target.contractId} is on {data.desk.owner}, so the engine cannot place an order until one is added.
        </p>
      ) : (
        keys.map((k) => <KeyCard key={k.publicKey} k={k} />)
      )}
      <p className="s-note g">
        {fullAccessText(data.desk.owner, fullAccess)}
        {operator === null ? null : (
          <>
            {' '}
            A separate operator account is set:{' '}
            {operatorHref === null ? (
              <span className="mono">{operator}</span>
            ) : (
              <ExtLink href={operatorHref} className="mono">
                {operator}
              </ExtLink>
            )}
            . Its own keys are not read here.
          </>
        )}
      </p>
    </>
  );
}

/**
 * What the operator’s key can call and what it cannot. The key lives on the owner’s NEAR account, so it is read from the
 * chain (`view_access_key_list`): NEAR itself refuses a method that is not on its list, before the contract runs. The
 * other column is the contract’s own table (docs/interfaces.md §1.3) of what only the owner may call.
 */
export function Keys({ r }: { r: Reading }) {
  return (
    <section className="s-keys">
      <div>
        <h2>The operator’s key</h2>
        <p className="s-lede g">A key on your NEAR account that can call only these methods of the contract. NEAR checks the list before the contract runs.</p>
        {r.kind === 'ready' ? (
          <KeyList data={r.data} />
        ) : r.kind === 'replay' ? (
          <ReplayNote what="account key" />
        ) : (
          <div className="s-key" aria-busy="true" aria-label="Reading the keys">
            <div className="s-key-id">
              <Sk w={380} h={14} />
              <Sk w={230} h={13} />
            </div>
            <dl className="s-key-groups">
              {[1, 2, 3].map((n) => (
                <div key={n}>
                  <dt>
                    <Sk w={110} h={14} />
                  </dt>
                  <dd>
                    <Sk w={`${40 + n * 15}%`} h={13} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      <div>
        <h2>What no function-call key can call</h2>
        <p className="s-lede g">Only your wallet can, and each call needs 1 yoctoNEAR attached, which a function-call key cannot attach.</p>
        <ul className="s-owner">
          {[...OWNER_ONLY, RESUME].map((m) => (
            <li key={m.method}>
              <span className="mono">{m.method}</span>
              <span className="g">{m.what}</span>
            </li>
          ))}
        </ul>
        <p className="s-note g">
          Not for a desk’s owner at all: <span className="mono">{OTHER_CALLERS.join(' ')}</span>, a deposit hook, the contract owner’s mock price and the oracle’s
          callback.
        </p>
      </div>
    </section>
  );
}
