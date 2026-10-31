import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Mode } from '@gimbal/shared';
import { hrefOf } from '../shell/routes.ts';
import { Wordmark } from '../shell/Wordmark.tsx';
import { useStream } from '../stream/hub.ts';
import { dotColor } from '../ui/dot.ts';
import { devFlow, pickStage, realFlow } from './create.ts';
import { DeskPanel } from './DeskPanel.tsx';
import { DonePanel } from './DonePanel.tsx';
import { currentStep, stepsOf, type OnboardingFlow } from './flow.ts';
import { FundsPanel } from './FundsPanel.tsx';
import { KeyPanel } from './KeyPanel.tsx';
import { Rail } from './Rail.tsx';
import { RulesPanel } from './RulesPanel.tsx';
import { SetupPanel } from './SetupPanel.tsx';
import { Welcome } from './Welcome.tsx';
import './onboarding.css';

const NETWORKS: Record<Mode, { label: string; dot: string }> = {
  mainnet: { label: 'Mainnet', dot: 'var(--level)' },
  testnet: { label: 'Testnet', dot: 'var(--testnet)' },
  replay: { label: 'Replay', dot: 'var(--replay)' },
};

function Header({ mode, account, onDisconnect }: { mode: Mode | null; account: string | null; onDisconnect: () => void }) {
  return (
    <header className={account ? 'hdr ob-hdr has-acct' : 'hdr ob-hdr'}>
      <a className="brand" href={hrefOf('desk')} aria-label="Gimbal, go to Desk">
        <Wordmark />
      </a>
      <div className="right">
        {mode ? (
          <span className="dot net" style={dotColor(NETWORKS[mode].dot)} title={NETWORKS[mode].label}>
            <span className="lbl">{NETWORKS[mode].label}</span>
          </span>
        ) : null}
        {account ? (
          <>
            <span className="acct">{account}</span>
            <button type="button" className="btn quiet" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

/** A message that fills the page, as the design's `.state-msg`. */
function Message({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    <div className="ob-statepage">
      <div className="state-msg">
        <div className="lab">{label}</div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Steps({ flow, mode }: { flow: OnboardingFlow; mode: Mode | null }) {
  const s = useSyncExternalStore(flow.store.subscribe, flow.store.getState);
  const steps = stepsOf(s);
  const step = currentStep(s);

  return (
    <>
      <Header mode={mode ?? s.config.network} account={s.account} onDisconnect={() => void flow.disconnect()} />
      {s.account === null ? (
        <Welcome flow={flow} s={s} mode={mode} />
      ) : (
        <div className="ob">
          <Rail steps={steps} />
          {step === 'desk' ? (
            <DeskPanel flow={flow} s={s} steps={steps} />
          ) : step === 'key' ? (
            <KeyPanel flow={flow} s={s} steps={steps} />
          ) : step === 'setup' ? (
            <SetupPanel flow={flow} s={s} steps={steps} />
          ) : step === 'funds' ? (
            <FundsPanel flow={flow} s={s} steps={steps} />
          ) : step === 'rules' || step === 'sign' ? (
            <RulesPanel flow={flow} s={s} steps={steps} />
          ) : (
            <DonePanel s={s} steps={steps} />
          )}
        </div>
      )}
    </>
  );
}

/**
 * Welcome and the five steps behind it. The engine's mode decides the network (a replay has none); the flow is built once
 * for it. Development can ask for a stage of the fake world with `?ob=<stage>` (dev.ts).
 */
export function OnboardingScreen() {
  const mode = useStream((s) => s.mode);
  const [stage] = useState(() => (import.meta.env.DEV ? pickStage(window.location.search) : null));
  const [flow, setFlow] = useState<OnboardingFlow | null>(null);

  useEffect(() => {
    let alive = true;
    let made: OnboardingFlow | null = null;
    const adopt = (f: OnboardingFlow | null) => {
      if (!alive) {
        f?.dispose();
        return;
      }
      made = f;
      setFlow(f);
      void f?.resume();
    };
    if (stage !== null) void devFlow(stage, window.location.search).then(adopt);
    else if (mode !== null) adopt(realFlow(mode));
    return () => {
      alive = false;
      made?.dispose();
      setFlow(null);
    };
  }, [stage, mode]);

  if (flow) return <Steps flow={flow} mode={stage !== null ? null : mode} />;

  return (
    <>
      <Header mode={mode} account={null} onDisconnect={() => undefined} />
      {mode === 'replay' ? (
        <Message label="Set up" title="This engine is replaying a recording">
          <p>A recording has no contract and no money, so there is nothing to set up. Start the engine in testnet or mainnet mode to create a desk.</p>
          <div className="go">
            <a className="btn big primary" href={hrefOf('desk')}>
              Watch the replay
            </a>
          </div>
        </Message>
      ) : (
        <Message label="Set up" title="Connecting to the engine">
          <p>The engine tells the page which network it runs on, and the wallet needs to know.</p>
        </Message>
      )}
    </>
  );
}
