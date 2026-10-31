import type { ReactNode } from 'react';
import { ExtLink } from './ExtLink.tsx';
import { nearUrl, netOf } from './explorer.ts';
import type { SecurityData } from './load.ts';
import { ReplayNote, Sk, type Reading } from './Sk.tsx';
import { feeLines, oracleTrust } from './words.ts';

/** An account name, linked to its page when it is a NEAR account id. */
function Account({ id, net }: { id: string; net: ReturnType<typeof netOf> }) {
  const href = nearUrl(id, net);
  return href === null ? (
    <span className="mono">{id}</span>
  ) : (
    <ExtLink href={href} className="mono">
      {id}
    </ExtLink>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="g">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function ContractRows({ data }: { data: SecurityData }) {
  const { config, target } = data;
  const net = netOf(target.mode);
  return (
    <div className="s-facts">
      <Row label="Contract">
        <Account id={target.contractId} net={net} />
        <small className="g">{config.network}; it never changes after it is deployed</small>
      </Row>
      <Row label="Signs through">
        <Account id={config.mpc} net={net} />
        <small className="g">the NEAR MPC contract</small>
      </Row>
      <Row label="Prices from">
        {config.oracle.kind === 'outlayer' ? (
          <>
            <Account id={config.oracle.contract} net={net} />
            <small className="g">the OutLayer price oracle</small>
          </>
        ) : (
          <>
            Prices set by the contract’s owner
            <small className="g">the mock price source, for testnet and demos only</small>
          </>
        )}
      </Row>
      <Row label="Fees">
        {feeLines(config.fees).map((line) => (
          <span key={line} className="s-fee">
            {line}
          </span>
        ))}
        <small className="g">
          The exchanges charge their own trading fees on top. Paid to <Account id={config.treasury} net={net} />.
        </small>
      </Row>
    </div>
  );
}

function PlaceholderRows() {
  return (
    <div className="s-facts" aria-busy="true" aria-label="Reading the contract">
      {['Contract', 'Signs through', 'Prices from', 'Fees'].map((label, i) => (
        <Row key={label} label={label}>
          <Sk w={[230, 150, 150, 330][i]!} h={16} />
          <small>
            <Sk w={[260, 130, 160, 260][i]!} h={12} />
          </small>
        </Row>
      ))}
    </div>
  );
}

/** The contract's own settings, and what the owner still has to trust (design: What you still trust). */
export function Facts({ r }: { r: Reading }) {
  const policy = r.kind === 'ready' ? r.data.desk.policy : null;
  return (
    <section className="s-trust">
      <div>
        <h2>The contract</h2>
        {r.kind === 'ready' ? <ContractRows data={r.data} /> : r.kind === 'replay' ? <ReplayNote what="contract" /> : <PlaceholderRows />}
      </div>
      <div>
        <h2>What you still trust</h2>
        <ul className="s-list">
          <li>The NEAR MPC network to sign only what the contract asks</li>
          <li>NEAR Intents to deliver a quoted transfer; the contract checks the quote’s signature</li>
          <li>Each exchange to stay solvent and honour withdrawals</li>
          <li>
            {policy !== null ? (
              oracleTrust(policy)
            ) : r.kind === 'loading' ? (
              <>
                The oracle price, within <Sk w={150} h={14} />
              </>
            ) : (
              'The oracle price, within the band and age your policy sets'
            )}
          </li>
        </ul>
      </div>
    </section>
  );
}
