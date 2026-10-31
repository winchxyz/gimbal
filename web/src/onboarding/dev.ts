// Development only (reached through `?ob=<stage>`): a fake world driven to a stage of onboarding, so every screen of the
// design can be seen without an engine, a wallet or a testnet account. Nothing here is a real address or balance.
import { OnboardingFlow } from './flow.ts';
import { FakeWorld } from './fakes.ts';
import type { NearNetwork } from './wallet.ts';

export const STAGES = [
  'welcome',
  'welcome-loading',
  'welcome-error',
  'desk',
  'key',
  'setup',
  'setup-running',
  'setup-receiver',
  'funds',
  'rules',
  'rules-loading',
  'rules-error',
  'rules-unavailable',
  'rules-draft',
  'rules-edit',
  'done',
] as const;

/** The words of design/screens/desktop/onboarding-rules.html. */
export const EXAMPLE_WORDS =
  'I want steady income from funding, nothing fancy. Big coins plus DOGE and NEAR are fine. Never more than $1,500 a side and never more than 3x. If prices look weird, don’t trade. Money only ever comes back to me.';

export async function presetFlow(stage: string, network: NearNetwork): Promise<OnboardingFlow> {
  const world = new FakeWorld({ network, contractId: network === 'mainnet' ? 'gimbal.near' : undefined, usdcToken: network === 'mainnet' ? 'usdc.near' : undefined, account: network === 'mainnet' ? 'demo-owner.near' : 'demo-owner.testnet' });
  world.autoAdvanceMs = 1100;
  // The fake's own `sleep` returns at once, so a step that waits for the chain does not hold the page up.
  const flow = new OnboardingFlow(world.deps());

  if (stage === 'welcome') return flow;
  if (stage === 'welcome-loading') {
    world.walletHangs = true;
    void flow.connect();
    return flow;
  }
  if (stage === 'welcome-error') {
    world.walletSilent = true;
    await flow.connect();
    return flow;
  }

  await flow.connect();
  if (stage === 'desk') {
    await flow.setDeskId('desk-07');
    return flow;
  }
  await flow.setDeskId('desk-07');
  await flow.createDesk();
  if (stage === 'key') return flow;
  await flow.addEngineKey();
  if (stage === 'setup') return flow;

  world.autoAdvanceMs = 0;
  await flow.startSetup();
  if (stage === 'setup-running') {
    for (let i = 0; i < 4; i++) world.advanceSetup();
    return flow;
  }
  world.finishSetup();
  if (stage === 'setup-receiver') return flow;
  await flow.pinReceiver();
  if (stage === 'funds') {
    world.giveUsdc(1050);
    await flow.refreshBalance();
    flow.setFund({ depositText: '1050' });
    return flow;
  }
  world.giveUsdc(1050);
  await flow.refreshBalance();
  flow.setFund({ depositText: '1050' });
  await flow.deposit();

  if (stage === 'rules') return flow;
  if (stage === 'rules-loading') {
    flow.setWords(EXAMPLE_WORDS);
    world.draftMode = 'hang';
    void flow.draftRules();
    return flow;
  }
  if (stage === 'rules-error') {
    flow.setWords(EXAMPLE_WORDS);
    world.draftMode = 'silent';
    await flow.draftRules();
    return flow;
  }
  if (stage === 'rules-unavailable') {
    flow.setWords(EXAMPLE_WORDS);
    world.draftMode = 'unavailable';
    await flow.draftRules();
    return flow;
  }
  flow.setWords(EXAMPLE_WORDS);
  await flow.draftRules();
  if (stage === 'rules-draft') return flow;
  if (stage === 'rules-edit') {
    flow.setEditing(true);
    return flow;
  }
  await flow.signPolicy();
  return flow;
}
