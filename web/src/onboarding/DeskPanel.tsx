import { createDeskTx, isDeskId } from './desk-actions.ts';
import type { OnboardingFlow, FlowState, StepView } from './flow.ts';
import { formatNear } from './near.ts';
import { starterPolicy } from './policy.ts';
import { Act, Err, Field, Mono, Page, Rows } from './ui.tsx';

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  steps: StepView[];
}

/** What `create_desk` attaches at most, for the owner to read before the wallet opens. */
function storageNear(s: FlowState): string | null {
  if (s.derived === null || s.config.contractId === null) return null;
  const action = createDeskTx(s.config.contractId, s.deskId, starterPolicy(), s.derived).actions[0];
  return action?.type === 'FunctionCall' ? formatNear(BigInt(action.params.deposit)) : null;
}

export function DeskPanel({ flow, s, steps }: Props) {
  const valid = isDeskId(s.deskId);
  const checking = s.busy === 'load';
  const storage = storageNear(s);
  const status =
    s.deskId === '' ? null : !valid ? { text: 'Use 1 to 32 characters: a to z, 0 to 9 and “-”.', bad: true } : checking ? { text: 'Checking the chain…', bad: false } : s.deskCheck === 'free' ? { text: 'This name is free.', bad: false } : s.deskCheck === 'foreign' ? { text: 'A desk with this name exists and belongs to another account. Pick another name.', bad: true } : null;

  return (
    <Page
      steps={steps}
      title="Create your desk"
      lead="A desk is your own account inside the contract. Pick a short name: the contract and the MPC network derive the desk’s addresses on each exchange from it. Nothing is signed until you press Create."
      note={storage ? `Attaches up to ${storage} NEAR for storage; what the desk does not use is returned.` : 'The contract returns the NEAR it does not use.'}
      end={
        <Act busy={s.busy} mine="create" primary waiting="Waiting for your wallet…" disabled={!valid || s.deskCheck !== 'free' || s.derived === null} onClick={() => void flow.createDesk()}>
          Create desk
        </Act>
      }
    >
      <div className="ob-body">
        <Field label="Desk name" htmlFor="desk-id" hint={s.existing.length > 0 ? undefined : 'You can change it until you press Create.'}>
          <input
            id="desk-id"
            className="ob-input"
            value={s.deskId}
            placeholder="desk-07"
            maxLength={32}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={status?.bad === true}
            onChange={(e) => void flow.setDeskId(e.target.value)}
          />
        </Field>
        {s.existing.length > 0 ? (
          <p className="ob-hint">
            Your desks:{' '}
            {s.existing.map((id) => (
              <button key={id} type="button" className="btn quiet" onClick={() => void flow.setDeskId(id)}>
                {id}
              </button>
            ))}
          </p>
        ) : null}
        {status ? <p className={status.bad ? 'ob-err' : 'ob-ok'}>{status.text}</p> : null}
        <Err text={s.errors.load} />
        <Err text={s.errors.create} />

        <h3 className="ob-h3">
          <span>Addresses derived for this desk</span>
          <span>{s.derived ? 'from the MPC network' : ''}</span>
        </h3>
        {s.derived ? (
          <Rows
            rows={[
              { label: 'Hyperliquid and Orderly (Arbitrum)', value: <Mono>{s.derived.evm_address}</Mono> },
              { label: 'Solana authority', value: <Mono>{s.derived.solana.authority}</Mono> },
              { label: 'Solana USDC account', value: <Mono>{s.derived.solana.usdc_ata}</Mono> },
              { label: 'Solana PhUSD account', value: <Mono>{s.derived.solana.phusd_ata}</Mono> },
              { label: 'Phoenix trader', value: <Mono>{s.derived.solana.phoenix_trader}</Mono> },
            ]}
          />
        ) : (
          <p className="ob-hint">{valid ? (checking ? 'Asking the MPC network…' : 'They appear here once the name is checked.') : 'They appear here once you have a name.'}</p>
        )}
        <p className="ob-hint">The contract recomputes these when you create the desk and refuses a desk whose addresses differ.</p>
      </div>
    </Page>
  );
}
