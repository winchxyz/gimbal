import type { OnboardingFlow, FlowState, StepView } from './flow.ts';
import { isPublicKey, OPERATOR_GROUPS, OPERATOR_METHODS } from './operator.ts';
import { Act, Err, Field, Page } from './ui.tsx';

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  steps: StepView[];
}

export function KeyPanel({ flow, s, steps }: Props) {
  const valid = isPublicKey(s.operatorKey);
  return (
    <Page
      steps={steps}
      title="Let the engine trade"
      lead="The engine acts through a key on your account that may call only the trading methods of the contract, listed below. It cannot move your money out: those methods need your wallet, and a key like this cannot attach the deposit they ask for."
      note={`The key may spend up to ${s.config.allowanceNear} NEAR of your balance on gas over its life. Each call holds up to 0.3 NEAR while it runs, so keep at least 1 NEAR free.`}
      end={
        <Act busy={s.busy} mine="key" primary disabled={!valid} onClick={() => void flow.addEngineKey()}>
          Add engine key
        </Act>
      }
    >
      <div className="ob-body">
        <Field label="Engine public key" htmlFor="engine-key" hint={s.config.operatorKey ? 'Read from this page’s settings. It is the engine’s public key; a public key opens nothing.' : 'The engine’s public key, ed25519: and then 43 or 44 characters. A public key opens nothing.'}>
          <input
            id="engine-key"
            className="ob-input ob-mono"
            value={s.operatorKey}
            placeholder="ed25519:…"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={s.operatorKey !== '' && !valid}
            onChange={(e) => flow.setOperatorKey(e.target.value)}
          />
        </Field>
        {s.operatorKey !== '' && !valid ? <p className="ob-err">That is not an ed25519 public key.</p> : null}
        <Err text={s.errors.key} />

        <h3 className="ob-h3">
          <span>It may call these {OPERATOR_METHODS.length} methods, on the gimbal contract only</span>
          <span>{s.config.contractId}</span>
        </h3>
        <div className="ob-groups">
          {OPERATOR_GROUPS.map((g) => (
            <div key={g.label}>
              <b>{g.label}</b>
              <span>{g.what}</span>
              <p className="ob-mono">{g.methods.join('  ')}</p>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}
