// serve's rescue (E9): builds the Rescuer the risk engine hands its triggers to, and the panic_close watch.
//
//   replay    recorded 1Click answers and simulated money (recorded.ts); the replay desk's legs gain what lands
//   testnet   the same recorded world: 1Click has no testnet, and a testnet rescue never moves real money; the desk's
//             reserve, policy and `closing` are read from get_desk
//   mainnet   live only with GIMBAL_RESCUE=1, since it is the part of serve that moves money: it loads the operator
//             key (OPERATOR_PRIVATE_KEY) and the relayer's gas wallet (RELAYER_EVM_PRIVATE_KEY) by name, never printed,
//             and calls 1Click (ONECLICK_API_KEY optional: it only lowers the fee). Without it the risk engine only
//             detects (the trigger is published at `detect`) and the owner acts.
//
// Live routes wired here: the reserve (fund_venue) and Hyperliquid (hl_withdraw, then evm_usdc_to_intents). Phoenix
// as a source needs sol_sign_rescue's message (Phoenix withdraw + Ember unwrap + the transfer) built from Phoenix's
// exchange accounts and a fresh blockhash, which the engine does not build yet; Phoenix as a target needs a Phoenix
// deposit after the delivery. Both are refused by the route check with that reason. The legs are reduced only where a
// pair trader holds them, which serve does not yet (TODO(day 10), as for ADL).

import type { ContractPolicy, Mode, StreamEvent, VenueId } from '@gimbal/shared';
import type { Hex } from 'viem';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { checkContractNetwork, contractEnv } from '../cli/serve-contract.ts';
import { ArbitrumSubmitter } from '../relayer/arbitrum.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { sleep } from '../relayer/tx.ts';
import type { RiskEngine } from '../risk/engine.ts';
import type { ReplayDesk } from '../risk/sources.ts';
import type { Clock } from '../venues/venue.ts';
import { ClosingWatch } from './closing.ts';
import type { ClosingWatchOptions } from './closing.ts';
import { HlLedgerLanding } from './hl-ledger.ts';
import { HttpOneClick } from './oneclick.ts';
import type { VerifiedQuote } from './oneclick.ts';
import { RecordedOneClick, SimulatedMoney, loadRescueRecording, steadyClock } from './recorded.ts';
import type { Payer, Reducer, RescueDesk, RescuerOptions } from './rescuer.ts';
import { Rescuer } from './rescuer.ts';

export interface ServeRescueInput {
  mode: Mode;
  env: (name: string) => string | undefined;
  clock: Clock;
  publish: (event: StreamEvent) => void;
  log: (line: string) => void;
  risk: () => RiskEngine | null;
  /** serve's read-only contract client (testnet, mainnet): get_desk. */
  getDesk?: () => Promise<DeskView>;
  /** panic_close's resting-order cancel and why nothing trades here (serve-pair.ts), for the ClosingWatch. */
  closing?: Pick<ClosingWatchOptions, 'cancelResting' | 'notTrading'>;
  contractId?: string;
  deskId?: string;
  replayDesk?: ReplayDesk;
  /** The policy serve runs with (replay: the policy file, else the recording's). */
  policy: ContractPolicy | null;
  reducer?: () => Reducer | null;
}

export interface ServeRescue {
  /** The risk engine's `rescuer`; undefined: detect only. */
  rescuer: ((trigger: Parameters<Rescuer['take']>[0]) => void) | undefined;
  closing: ClosingWatch;
  /** One line for serve's log. */
  summary: string;
  /** The rescue running now (RiskEngine's rescuerRunning). */
  running: () => string | null;
}

const targetOf = (q: VerifiedQuote): VenueId => (q.destinationAsset.startsWith('1cs_v1:hypercore') ? 'hyperliquid' : q.destinationAsset.includes('arb-') ? 'orderly' : 'phoenix');

/** USDC × 1e6 as the canonical decimal the contract takes: "12.5". */
export function usdcDecimal(e6: bigint): string {
  const frac = (e6 % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${e6 / 1_000_000n}${frac === '' ? '' : `.${frac}`}`;
}

function policyOf(p: ContractPolicy | null, fallback: RescueDesk['policy']): RescueDesk['policy'] {
  // Only the three fields a rescue reads, so a recorded policy (which has no markets) fits too.
  return p === null ? fallback : { rescue_cap_usd_per_hour: p.rescue_cap_usd_per_hour, max_transfer_cost_bps: p.max_transfer_cost_bps, max_transfer_cost_flat_e6: p.max_transfer_cost_flat_e6 };
}

export async function serveRescue(input: ServeRescueInput): Promise<ServeRescue> {
  const { mode, env, log } = input;
  const reducer = input.reducer ?? (() => null);
  const closing = new ClosingWatch({ publish: input.publish, clock: input.clock, reducer, log, ...input.closing });
  const common = {
    mode, publish: input.publish,
    view: () => input.risk()?.legView() ?? { legs: [], freeMargin: {} },
    reducer,
    ended: (id: string, landed: boolean) => input.risk()?.rescueEnded(id, landed),
    failure: (f: Parameters<RiskEngine['setRescueFailure']>[0]) => input.risk()?.setRescueFailure(f),
    log,
  } satisfies Partial<RescuerOptions>;

  if (mode !== 'mainnet') {
    const recording = loadRescueRecording();
    // The replay clock stops at the end of its recording; a rescue's waits must still end.
    const clock = steadyClock(input.clock);
    const oneClick = new RecordedOneClick(recording, clock);
    const money = new SimulatedMoney(oneClick, clock);
    if (input.replayDesk !== undefined) {
      const desk = input.replayDesk;
      money.onCredit = (venue, usd) => desk.credit(venue, usd);
      money.onReserveSpend = (usd) => desk.spendReserve(usd);
    }
    const rescuer = new Rescuer({
      ...common, clock, sleep, oneClick,
      desk: async () => {
        let reserveUsd: number;
        let policy = policyOf(input.policy, recording.policy);
        let isClosing = false;
        if (input.getDesk !== undefined) {
          const view = await input.getDesk();
          reserveUsd = Number(view.ledger.idle_usdc) / 1e6 - money.reserveSpentUsd;
          policy = policyOf(view.policy, recording.policy);
          isClosing = view.closing === true;
        } else {
          // The replay desk's reserve already counts what earlier replayed rescues spent (spendReserve).
          reserveUsd = input.risk()?.desk?.reserveUsd ?? 0;
        }
        return { addresses: recording.desk, policy, reserveUsd: Math.max(0, reserveUsd), closing: isClosing || closing.blocked() !== null };
      },
      landing: money.landing(),
      payers: { reserve: money.payer('fund_venue', targetOf), phoenix: money.payer('sol_sign_rescue', targetOf), arbitrum: money.payer('evm_usdc_to_intents', targetOf) },
      hlWithdraw: money.hlWithdraw(),
      credit: { phoenix: money.credit() },
      fixedAmountUsd: (from, to) => oneClick.fixedAmountUsd(from, to),
      label: `${mode}: ${oneClick.source}, no funds moved`,
    });
    return {
      rescuer: (t) => rescuer.take(t), closing, running: () => rescuer.runningId,
      summary: `rescue: ${mode}, 1Click steps from ${oneClick.source} (fixtures/oneclick), payments simulated: nothing is signed or sent`,
    };
  }

  if (env('GIMBAL_RESCUE') !== '1') {
    return { rescuer: undefined, closing, running: () => null, summary: 'rescue: detect only on mainnet (GIMBAL_RESCUE=1 runs it live: it moves real money)' };
  }
  const cfg = contractEnv(env, mode, { signing: true });
  if (cfg === null) throw new Error('GIMBAL_RESCUE=1 needs GIMBAL_CONTRACT_ID, GIMBAL_DESK_ID and the operator key');
  const relayerKey = env('RELAYER_EVM_PRIVATE_KEY');
  if (relayerKey === undefined) throw new Error('GIMBAL_RESCUE=1 needs RELAYER_EVM_PRIVATE_KEY (the gas wallet that submits evm_usdc_to_intents)');
  const transport = new NearApiTransport({
    network: cfg.network, accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }),
  });
  const contract = new NearContractClient({ contractId: cfg.contractId, network: cfg.network, transport, onHealth: (s, d) => log(`rescue near ${s}: ${d}`) });
  checkContractNetwork(cfg.contractId, await contract.config(), cfg.network);
  const arbitrumRpc = env('ARBITRUM_RPC_URL');
  const arb = new ArbitrumSubmitter({ network: 'mainnet', relayerKey: relayerKey as Hex, ...(arbitrumRpc === undefined ? {} : { rpcUrl: arbitrumRpc }) });
  const hl = new HyperliquidSubmitter({ network: 'mainnet' });
  const apiKey = env('ONECLICK_API_KEY') ?? null;
  const oneClick = new HttpOneClick({ apiKey });
  const deskId = cfg.deskId;
  let view: DeskView | null = null;
  const readDesk = async (): Promise<DeskView> => {
    const d = await contract.getDesk(deskId);
    if (d === null) throw new Error(`get_desk(${deskId}) answered null`);
    view = d;
    return d;
  };
  const evm = async () => (view ?? await readDesk()).evm_address;
  const reserve: Payer = {
    method: 'fund_venue',
    // fund_venue is one call: the contract pays the deposit address itself, so signing is sending.
    sign: async (q, reason) => {
      const tx = await contract.fundVenue(deskId, { quote: q.quote, quote_signature: q.signature }, reason);
      return { tx, send: async () => ({ tx: [], depositTx: tx[0]?.id ?? '' }) };
    },
  };
  const arbitrum: Payer = {
    method: 'evm_usdc_to_intents',
    sign: async (q, reason) => {
      const signed = await contract.evmUsdcToIntents(deskId, { quote: q.quote, quote_signature: q.signature }, reason);
      return {
        tx: signed.nearTx === undefined ? [] : [signed.nearTx],
        // The authorization is public once signed and anyone may submit it until validBefore.
        usableUntilMs: Number(signed.payload.validBefore) * 1000,
        // It can never run once validBefore has passed (by this clock, less a minute for skew) and USDC still reads it
        // unused; a read error is not taken as unused.
        neverRuns: async () => input.clock.now() > Number(signed.payload.validBefore) * 1000 + 60_000
          && !(await arb.authorizationUsed(signed.payload.from, signed.payload.nonce)),
        send: async () => {
          const tx = await arb.submit(signed, await evm());
          return { tx, depositTx: tx.find((x) => x.chain === 'arbitrum')?.id ?? '' };
        },
      };
    },
  };
  const rescuer = new Rescuer({
    ...common, clock: input.clock, sleep, oneClick, keyed: apiKey !== null,
    desk: async () => {
      const d = await readDesk();
      return {
        addresses: { deskId, contract: cfg.contractId, owner: d.owner, evm: d.evm_address, sol: d.solana.authority, orderlyReceiver: d.orderly_receiver },
        policy: policyOf(d.policy, d.policy),
        reserveUsd: Number(d.ledger.idle_usdc) / 1e6,
        closing: d.closing === true || closing.blocked() !== null,
      };
    },
    // Landings are confirmed in the target's ledger. Orderly's needs its private API, which serve does not open, and
    // Phoenix takes no transfer until a deposit into it is built: both are refused as targets.
    landing: new HlLedgerLanding({
      network: 'mainnet', desk: evm,
      others: {
        orderly: 'a landing on Orderly cannot be confirmed here (its ledger needs the private API, which serve does not open)',
        phoenix: 'a landing on Phoenix cannot be confirmed here (no Phoenix deposit is built)',
      },
    }),
    payers: { reserve, arbitrum },
    hlWithdraw: {
      withdraw: async (amountE6) => {
        const r = await hl.submit(await contract.hlWithdraw(deskId, usdcDecimal(amountE6)), await evm());
        return { tx: r.tx };
      },
      arbitrumUsdcE6: async () => arb.usdcBalance(await evm()),
    },
    withdrawals: (venue, paused) => log(`rescue: ${venue} withdrawals ${paused === null ? 'ran' : `refused: ${paused}`}`),
  });
  return {
    rescuer: (t) => rescuer.take(t), closing, running: () => rescuer.runningId,
    summary: `rescue: LIVE on mainnet (GIMBAL_RESCUE=1), operator ${cfg.accountId}, 1Click ${apiKey === null ? 'without a key (+0.2 %)' : 'with a key'}; sources: reserve, Hyperliquid via Arbitrum (Phoenix not wired)`,
  };
}
