import { hrefOf } from '../shell/routes.ts';
import type { FlowState, StepView } from './flow.ts';
import { dollars } from './intents.ts';
import { coinsOf } from './policy.ts';
import { Mono, Page, Rows } from './ui.tsx';

export function DonePanel({ s, steps }: { s: FlowState; steps: StepView[] }) {
  const desk = s.desk;
  return (
    <Page
      steps={steps}
      title="Your desk is ready"
      lead="The contract holds your rules and the engine follows them. It enters a window when one clears your minimum, and rescues margin before a leg can be liquidated."
      note="A change to the rules needs your signature again. This page does not reopen them yet."
      end={
        <a className="btn primary big" href={hrefOf('desk')}>
          Go to Desk
        </a>
      }
    >
      <div className="ob-body">
        <Rows
          rows={[
            { label: 'Desk', value: s.deskId },
            { label: 'Owner', value: s.account ?? '' },
            { label: 'Deposited', value: desk ? dollars(desk.ledger.deposited) : '' },
            { label: 'Assets', value: desk ? coinsOf(desk.policy).join(', ') || 'none' : '' },
            { label: 'Size per leg', value: desk ? `up to $${desk.policy.max_notional_usd.toLocaleString('en-US')}` : '' },
            { label: 'Hyperliquid and Orderly address', value: desk ? <Mono>{desk.evm_address}</Mono> : '' },
          ]}
        />
      </div>
    </Page>
  );
}
