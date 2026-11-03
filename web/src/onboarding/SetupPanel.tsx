import type { SetupProgress } from '@gimbal/shared';
import { cx } from '../ui/cx.ts';
import { receiverFound, setupView, type FlowState, type OnboardingFlow, type StepView } from './flow.ts';
import { isEvmAddress } from './desk-actions.ts';
import { Act, Err, Field, Mono, Page } from './ui.tsx';

type Step = SetupProgress['steps'][number];

// What each engine step is called to the owner, in the order the engine runs them.
const PLAN: { step: Step['step']; title: string; what: string }[] = [
  { step: 'hl_set_referrer', title: 'Hyperliquid: referral', what: 'Links the desk to Gimbal’s referral code.' },
  { step: 'hl_approve_builder_fee', title: 'Hyperliquid: builder fee', what: 'Approves the small fee Gimbal charges on orders.' },
  { step: 'orderly_register', title: 'Orderly: register', what: 'Opens the desk’s Orderly account.' },
  { step: 'orderly_add_key', title: 'Orderly: trading key', what: 'Adds the key the engine trades with.' },
  { step: 'orderly_receiver_lookup', title: 'Orderly: deposit address', what: 'Finds the one address that may fund the account.' },
  { step: 'orderly_referral_bind', title: 'Orderly: referral', what: 'Binds Gimbal’s referral code when one is set.' },
  { step: 'orderly_ip_restriction', title: 'Orderly: IP restriction', what: 'Limits the trading key to your list of IP addresses.' },
  { step: 'phoenix_register', title: 'Phoenix: register', what: 'Opens the desk’s Phoenix trader account.' },
  { step: 'phoenix_referral', title: 'Phoenix: referral', what: 'Activates Gimbal’s referral code when one is set.' },
];

/** The IP list's hint: the engine's own IP must be on it, or Orderly refuses the engine (closes and rescue too). */
function ipsHint(engineIps: readonly string[]): string {
  const base = 'Up to 10 addresses, one per line. Orderly then accepts the desk’s trading key only from them. Leave it empty for no limit.';
  if (engineIps.length === 0) return `${base} This page does not know the engine’s IP address, so it signs no list.`;
  return `${base} Include the engine’s IP address, ${engineIps.join(' and ')}: the engine trades, closes and rescues from there.`;
}

const STATUS_TEXT: Record<Step['status'], string> = { done: 'Done', running: 'Working…', pending: 'Waiting', skipped: 'Skipped', failed: 'Failed' };

interface Props {
  flow: OnboardingFlow;
  s: FlowState;
  steps: StepView[];
}

export function SetupPanel({ flow, s, steps }: Props) {
  const view = setupView(s);
  const progress = s.setup !== null && s.setup.deskId === s.deskId ? s.setup : null;
  const found = receiverFound(s);
  const ipsSigned = s.txs.ips !== undefined;
  const mainnet = s.config.network === 'mainnet';

  const end =
    view === 'needs-receiver' ? (
      <Act busy={s.busy} mine="receiver" primary disabled={found === null && !isEvmAddress(s.receiverText)} onClick={() => void flow.pinReceiver()}>
        Pin receiver
      </Act>
    ) : view === 'running' ? (
      <button type="button" className="btn primary big" disabled>
        Setting up…
      </button>
    ) : (
      <Act busy={s.busy} mine="setup" primary onClick={() => void flow.startSetup()}>
        {view === 'failed' ? 'Try again' : 'Start setup'}
      </Act>
    );

  return (
    <Page
      steps={steps}
      title="Set up the exchanges"
      lead="The engine opens the desk’s account on each exchange, through the contract. You sign once more at the end, to pin the one address that may fund Orderly."
      note={view === 'running' ? 'This takes a minute or two. You can leave this page open.' : 'Each step is signed by the contract for the desk. The engine chooses nothing: the policy and fees decide.'}
      end={end}
    >
      <div className="ob-body">
        {mainnet && view === 'not-started' ? (
          <div className="ob-block">
            <Field label="Orderly IP list (optional)" htmlFor="ips" hint={ipsHint(s.config.relayerIps)}>
              <textarea id="ips" className="ob-input" rows={3} value={s.ipsText} placeholder={s.config.relayerIps[0] ?? '203.0.113.7'} onChange={(e) => flow.setIpsText(e.target.value)} />
            </Field>
            <p className="ob-row">
              <Act busy={s.busy} mine="ips" quiet disabled={s.ipsText.trim() === '' || ipsSigned} onClick={() => void flow.setIps()}>
                {ipsSigned ? 'IP list signed' : 'Sign IP list'}
              </Act>
            </p>
            <Err text={s.errors.ips} />
          </div>
        ) : null}

        <ol className="ob-steps" aria-label="Setup progress">
          {PLAN.map((p, i) => {
            const got = progress?.steps.find((x) => x.step === p.step);
            const status: Step['status'] = got?.status ?? 'pending';
            return (
              <li key={p.step} className={cx(status)}>
                <span className="n">{i + 1}</span>
                <b>{p.title}</b>
                <span className="tm">{STATUS_TEXT[status]}</span>
                <small>{got?.detail && status !== 'done' ? got.detail : p.what}</small>
              </li>
            );
          })}
        </ol>
        <Err text={s.errors.setup} />

        {view === 'needs-receiver' ? (
          <div className="ob-block">
            <h3 className="ob-h3">
              <span>Orderly deposit address</span>
              <span>pin it to your desk</span>
            </h3>
            {found ? (
              <p>
                <Mono>{found}</Mono>
              </p>
            ) : (
              <Field label="Address" htmlFor="receiver" hint="The engine found the address but did not report it here. Paste it: 0x and 40 hex digits.">
                <input id="receiver" className="ob-input ob-mono" value={s.receiverText} placeholder="0x…" autoComplete="off" spellCheck={false} onChange={(e) => flow.setReceiverText(e.target.value)} />
              </Field>
            )}
            <p className="ob-hint">Once pinned, the contract sends Orderly money only to this address.</p>
            <Err text={s.errors.receiver} />
          </div>
        ) : null}
      </div>
    </Page>
  );
}
