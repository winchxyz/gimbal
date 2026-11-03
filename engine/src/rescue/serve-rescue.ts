// serve's rescue (E9): builds the Rescuer the risk engine hands its triggers to, and the panic_close watch.
//
//   replay    recorded 1Click answers and simulated money (recorded.ts); the replay desk's legs gain what lands
//   testnet   the same recorded world: 1Click has no testnet, and a testnet rescue never moves real money; the desk's
//             reserve, policy and `closing` are read from get_desk
//   mainnet   live only with GIMBAL_RESCUE=1, since it is the part of serve that moves money: it loads the operator
//             key (OPERATOR_PRIVATE_KEY) and the relayer's gas wallet (RELAYER_EVM_PRIVATE_KEY) by name, never printed,
//             and calls 1Click (ONECLICK_API_KEY optional: it only lowers the fee). Without it the risk engine only
//             detects (the trigger is published at `detect`) and the owner acts. Its holds and cap meter are kept in
//             GIMBAL_STATE_DIR, by default the per-user state directory (lock.ts: %LOCALAPPDATA%/gimbal/state, else
//             ~/.local/state/gimbal), outside any checkout, in rescue-mainnet-<contract>-<desk>-<evm>.json (state.ts).
//             A missing file holds every transfer; GIMBAL_RESCUE_FRESH=<contract>/<desk> starts a first run with an
//             empty one (any other value is ignored, so one left in an env file never re-arms another desk), refused
//             while the contract counted a rescue or a fund_venue of the desk, or the state directory shows a
//             trace of its rescuers, in the last 65 min (freshStart). Only one live rescuer runs per contract and desk
//             on this machine: it starts only with the lock (lock.ts), which hl-return.mjs and fund.mjs take too.
//             The deposit rings, the time of a final NEAR block and a fund_venue's final transaction outcome
//             (near-chain.ts) tell whether a held payment was ever signed or paid. Off mainnet nothing real can be
//             held, so the recorded worlds keep theirs in memory.
//
// Live routes on mainnet (MAINNET_ROUTES, printed at start):
//   reserve -> Hyperliquid    fund_venue into HyperCore USDC, the landing read in the Hyperliquid ledger;
//   reserve -> Phoenix        fund_venue into Solana USDC for the desk authority, then a sol_sign deposit into
//                             Phoenix (sol-rescue.ts PhoenixDeskCredit), the landing the confirmed deposit;
//   Phoenix -> Hyperliquid    sol_sign_rescue of one Solana transaction to the 1Click deposit address (sol-rescue.ts
//                             PhoenixRescuePayer), the landing read in the Hyperliquid ledger.
// The Phoenix routes need the Solana RPC (SOLANA_RPC_URL, default the public mainnet one) to serve transaction
// history: a held sol_sign_rescue is released only on getSignatureStatuses with searchTransactionHistory
// (solana-chain.ts). It is probed at start; without it both Phoenix routes are refused and the start line says why.
// Replay only (wired, run in the recorded worlds): Hyperliquid -> Phoenix (not yet dry-run on mainnet), and anything
// into Orderly (its landing needs Orderly's private API, which serve does not open). Not built: Hyperliquid ->
// Orderly (Arbitrum USDC into Arbitrum USDC, which 1Click does not quote). The legs are reduced only where a pair
// trader holds them, which serve does not yet (TODO(day 10), as for ADL).

import type { ContractPolicy, Mode, StreamEvent, VenueId } from '@gimbal/shared';
import type { Hex } from 'viem';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import type { DeskView } from '../contract/types.ts';
import { errorMessage } from '../venues/recorder.ts';
import { checkContractNetwork, contractEnv } from '../cli/serve-contract.ts';
import { ArbitrumSubmitter } from '../relayer/arbitrum.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { solanaChain } from '../relayer/phoenix-money.ts';
import { Relayer } from '../relayer/relayer.ts';
import { SolanaSubmitter } from '../relayer/solana.ts';
import { sleep } from '../relayer/tx.ts';
import { parseTraderSnapshot, phoenixTraderApi } from '../trade/phoenix-leg.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import type { RiskEngine } from '../risk/engine.ts';
import type { ReplayDesk } from '../risk/sources.ts';
import type { Clock } from '../venues/venue.ts';
import { ViemArbitrumReads } from './arbitrum-chain.ts';
import { ClosingWatch } from './closing.ts';
import type { ClosingWatchOptions } from './closing.ts';
import { HlLedgerLanding } from './hl-ledger.ts';
import { HttpOneClick } from './oneclick.ts';
import type { VerifiedQuote } from './oneclick.ts';
import { acquireRescueLock, lockText, rescueLockName, userStateDir } from './lock.ts';
import { FRESH_WAIT_MS, NearDeskReads, recentRescue } from './near-chain.ts';
import { RecordedOneClick, SimulatedMoney, loadRescueRecording, steadyClock } from './recorded.ts';
import type { Payer, Reducer, RescueDesk, RescuerOptions } from './rescuer.ts';
import { Rescuer } from './rescuer.ts';
import type { PhoenixDesk } from './sol-rescue.ts';
import { PhoenixDeskCredit, PhoenixRescuePayer, VenueLandings } from './sol-rescue.ts';
import { RpcSolanaReads } from './solana-chain.ts';
import type { Source } from './plan.ts';
import type { Eip3009Ref } from './state.ts';
import type { FreshEvidence } from './state.ts';
import { RescueStateStore, freshEvidence, rescueStateFile } from './state.ts';
import type { NearRead } from './near-chain.ts';

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
  /** --state-dir or GIMBAL_STATE_DIR when set: where a live rescuer keeps its holds and counters (default: userStateDir). */
  stateDir?: string;
}

export interface ServeRescue {
  /** The risk engine's `rescuer`; undefined: detect only. */
  rescuer: ((trigger: Parameters<Rescuer['take']>[0]) => void) | undefined;
  closing: ClosingWatch;
  /** One line for serve's log. */
  summary: string;
  /** The rescue running now (RiskEngine's rescuerRunning). */
  running: () => string | null;
  /** serve's shutdown: nothing new is signed; resolves when the running rescue ended (Rescuer.stop). */
  stop: () => Promise<void>;
  /** The start lines that name the routes live here and the ones that are not. */
  routes: string[];
}

/** The rescue routes on mainnet: live with GIMBAL_RESCUE=1, run only in the recorded worlds, and not built. */
export const MAINNET_ROUTES = {
  live: [
    'reserve -> Hyperliquid (fund_venue)',
    'reserve -> Phoenix (fund_venue to the desk Solana authority, then a sol_sign deposit)',
    'Phoenix -> Hyperliquid (sol_sign_rescue)',
  ],
  replayOnly: [
    'Hyperliquid -> Phoenix (hl_withdraw, evm_usdc_to_intents, then a sol_sign deposit: wired, not yet dry-run on mainnet)',
    'reserve -> Orderly and Phoenix -> Orderly (an Orderly landing needs its private API, which serve does not open)',
  ],
  notBuilt: ['Hyperliquid -> Orderly (Arbitrum USDC into Arbitrum USDC, which 1Click does not quote)'],
} as const;

/** On mainnet: what is not run although every part is wired. */
export function mainnetRouteLimit(from: Source, to: VenueId): string | null {
  return from === 'hyperliquid' && to === 'phoenix' ? 'Hyperliquid -> Phoenix runs only in replay: it is not yet dry-run on mainnet' : null;
}

/** serve's start lines for the routes: on mainnet the live ones (less Phoenix's when `phoenixProblem`), in replay all recorded. */
export function routeLines(mode: Mode, live: boolean, phoenixProblem: string | null): string[] {
  if (mode !== 'mainnet') {
    return [`rescue routes (${mode}): every recorded route, payments simulated; on mainnet live: ${MAINNET_ROUTES.live.join('; ')}`];
  }
  if (!live) return [`rescue routes: none live (detect only); with GIMBAL_RESCUE=1: ${MAINNET_ROUTES.live.join('; ')}`];
  const liveNow = phoenixProblem === null ? MAINNET_ROUTES.live : MAINNET_ROUTES.live.filter((r) => !r.includes('Phoenix'));
  const lines = [`rescue routes LIVE on mainnet: ${liveNow.join('; ')}`];
  if (phoenixProblem !== null) lines.push(`rescue routes REFUSED on mainnet: reserve -> Phoenix and Phoenix -> Hyperliquid, because ${phoenixProblem}`);
  lines.push(`rescue routes in replay only: ${MAINNET_ROUTES.replayOnly.join('; ')}`, `rescue routes not built: ${MAINNET_ROUTES.notBuilt.join('; ')}`);
  return lines;
}

/** The desk's Solana side as get_desk names it. */
export function phoenixDeskOf(d: DeskView): PhoenixDesk {
  return {
    accounts: { authority: d.solana.authority, traderAccount: d.solana.phoenix_trader, usdcAta: d.solana.usdc_ata, phusdAta: d.solana.phusd_ata },
    paused: d.paused,
  };
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

/**
 * Whether GIMBAL_RESCUE_FRESH starts a first run. Only when it names this desk exactly (`<contract>/<desk>`), and
 * refused (logged; the rescuer then holds every transfer) while:
 *   - the contract counted a rescue or a fund_venue of the desk in the last FRESH_WAIT_MS (a payment of an earlier
 *     run may still be held), or NEAR or the fund_venue ring cannot be read;
 *   - the state directory shows a trace of one of the desk's rescuers in the last FRESH_WAIT_MS (state.ts
 *     freshEvidence): a NEAR call sent before it stopped may still land, and nothing on chain shows it yet. With no
 *     trace at all, when the last rescuer stopped cannot be told here: the first FRESH writes a marker and is
 *     refused, and a FRESH FRESH_WAIT_MS after that marker is allowed (the strictest rule that still lets a desk start
 *     with no state file at all; no rescuer of the desk may run anywhere meanwhile, which the refusal says).
 * With this desk's state file present it returns true and the rescuer loads the file (and says FRESH is ignored).
 */
export async function freshStart(value: string | undefined, want: string, read: () => Promise<NearRead>, log: (line: string) => void, evidence: FreshEvidence, nowMs: number): Promise<boolean> {
  if (value === undefined || value === '') return false;
  if (value !== want) {
    log(`GIMBAL_RESCUE_FRESH=${JSON.stringify(value)} is ignored: a first run is asked for by naming the desk, GIMBAL_RESCUE_FRESH=${want}`);
    return false;
  }
  if (evidence.stateExists) return true;
  let n: NearRead;
  try {
    n = await read();
  } catch (err) {
    log(`GIMBAL_RESCUE_FRESH is refused: the desk's counters on NEAR could not be read (${errorMessage(err)}); start again once they can`);
    return false;
  }
  const recent = recentRescue(n);
  if (recent !== null) {
    log(`GIMBAL_RESCUE_FRESH is refused: ${recent}`);
    return false;
  }
  const waitMin = Math.round(FRESH_WAIT_MS / 60_000);
  const last = evidence.last;
  if (last === null) {
    evidence.mark();
    log(`GIMBAL_RESCUE_FRESH is refused: ${evidence.dir} holds no trace of when a rescuer of this desk last ran (no state file, no marker), so a NEAR call it sent before it stopped `
      + `cannot be ruled out (one may land until its quote is ${waitMin} min old, and nothing on chain shows it before then). A marker was written now: start again with `
      + `GIMBAL_RESCUE_FRESH=${want} after ${new Date(nowMs + FRESH_WAIT_MS).toISOString()}, and run no rescuer of this desk anywhere until then`);
    return false;
  }
  if (nowMs - last.ms < FRESH_WAIT_MS) {
    log(`GIMBAL_RESCUE_FRESH is refused: ${last.file} was written at ${new Date(last.ms).toISOString()}, under ${waitMin} min ago, so a NEAR call of the rescuer that wrote it may still land: `
      + `start again with GIMBAL_RESCUE_FRESH=${want} after ${new Date(last.ms + FRESH_WAIT_MS).toISOString()}`);
    return false;
  }
  if (n.counters === null) log('GIMBAL_RESCUE_FRESH: the contract has no get_desk_counters yet, so a rescue of the last hour cannot be ruled out on chain here; reconcile by hand first');
  evidence.clear();
  return true;
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
    const money = new SimulatedMoney(oneClick, clock, recording.desk);
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
      hlWithdraw: money.hlWithdraw(), arbitrum: money.arbitrum, near: () => money.near.read(), nearTx: (h) => money.near.txFacts(h), solana: money.solana,
      credit: { phoenix: money.credit() },
      fixedAmountUsd: (from, to) => oneClick.fixedAmountUsd(from, to),
      label: `${mode}: ${oneClick.source}, no funds moved`,
    });
    return {
      rescuer: (t) => rescuer.take(t), closing, running: () => rescuer.runningId, stop: () => rescuer.stop(), routes: routeLines(mode, true, null),
      summary: `rescue: ${mode}, 1Click steps from ${oneClick.source} (fixtures/oneclick), payments simulated: nothing is signed or sent`,
    };
  }

  if (env('GIMBAL_RESCUE') !== '1') {
    return {
      rescuer: undefined, closing, running: () => null, stop: async () => {}, routes: routeLines(mode, false, null),
      summary: 'rescue: detect only on mainnet (GIMBAL_RESCUE=1 runs it live: it moves real money)',
    };
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
  // The desk's EVM address names the state file; one failed read at start (an RPC hiccup) is tried once more.
  const first = await readDesk().catch(async (err: unknown) => {
    log(`rescue: get_desk failed at start (${errorMessage(err)}); trying once more in 2 s`);
    await sleep(2_000);
    return readDesk();
  });
  const evm = async () => (view ?? first).evm_address;
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
      const authorization: Eip3009Ref = { from: signed.payload.from, nonce: signed.payload.nonce, validBefore: Number(signed.payload.validBefore) };
      return {
        tx: signed.nearTx === undefined ? [] : [signed.nearTx],
        // The authorization is public once signed and anyone may submit it until validBefore.
        usableUntilMs: authorization.validBefore * 1000,
        authorization,
        send: async () => {
          const tx = await arb.submit(signed, await evm());
          return { tx, depositTx: tx.find((x) => x.chain === 'arbitrum')?.id ?? '' };
        },
      };
    },
  };
  // get_desk_counters comes with C10; until it is deployed only the block time is read and the no-view bounds apply.
  const nearReads = new NearDeskReads({ network: cfg.network, contractId: cfg.contractId, deskId, signerId: cfg.accountId!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
  const stateDir = input.stateDir ?? userStateDir(env);
  const identity = { contractId: cfg.contractId, deskId, evm: first.evm_address.toLowerCase() };
  const store = new RescueStateStore(rescueStateFile(stateDir, mode, identity), identity);
  // One live rescuer per contract and desk: two would each take the other's payments as not held.
  const lock = await acquireRescueLock(rescueLockName(env, mode, cfg.contractId, deskId));
  const fresh = await freshStart(env('GIMBAL_RESCUE_FRESH'), `${cfg.contractId}/${deskId}`, () => nearReads.read(), log, freshEvidence(stateDir, mode, identity), input.clock.now());
  // The Phoenix routes: only on a Solana RPC that serves transaction history (a held sol_sign_rescue is released on it).
  const solRpcUrl = env('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL;
  const solRpcName = env('SOLANA_RPC_URL') === undefined ? 'the public Solana mainnet RPC' : 'the Solana RPC of SOLANA_RPC_URL';
  const solanaReads = new RpcSolanaReads({ rpcUrl: solRpcUrl });
  const history = await solanaReads.historyProblem();
  const phoenixProblem = history === null ? null : `${solRpcName} cannot back the Solana hold rule: ${history}`;
  const chain = solanaChain(solRpcUrl);
  const phoenixApi = env('PHOENIX_API_URL') ?? PHOENIX_API_URL;
  const phoenixReader = new PhoenixReader({ apiUrl: phoenixApi, rpcUrl: solRpcUrl });
  const phoenixDesk = async () => phoenixDeskOf(await readDesk());
  const solSubmitter = new SolanaSubmitter({ rpcUrl: solRpcUrl, network: 'mainnet' });
  const traderState = async () => parseTraderSnapshot(await phoenixTraderApi(phoenixApi).traderState((view ?? first).solana.authority), '').state;
  const phoenixPayer = new PhoenixRescuePayer({
    deskId, chain, desk: phoenixDesk, contract, sender: solSubmitter, log,
    withdrawable: async () => BigInt(Math.floor((await phoenixReader.account((view ?? first).solana.authority)).freeMarginUsd * 1e6)),
  });
  const relayer = new Relayer({ contract, deskId, solana: solSubmitter });
  const phoenixCredit = new PhoenixDeskCredit({
    network: 'mainnet', chain, desk: phoenixDesk, traderState, clock: input.clock, sleep,
    solSign: (build, reason) => relayer.solSign(build, reason),
  });
  const hlLanding = new HlLedgerLanding({ network: 'mainnet', desk: evm });
  const refusedLandings = {
    orderly: 'a landing on Orderly cannot be confirmed here (its ledger needs the private API, which serve does not open)',
    ...(phoenixProblem === null ? {} : { phoenix: `Phoenix is refused: ${phoenixProblem}` }),
  };
  const rescuer = new Rescuer({
    ...common, clock: input.clock, sleep, oneClick, keyed: apiKey !== null,
    store, fresh, near: () => nearReads.read(), nearTx: (h) => nearReads.txFacts(h), arbitrum: new ViemArbitrumReads(arbitrumRpc === undefined ? {} : { rpcUrl: arbitrumRpc }),
    // Without history a landed signature could read as never landed: no Solana reads, so a Solana hold stays held.
    ...(phoenixProblem === null ? { solana: solanaReads, credit: { phoenix: phoenixCredit } } : {}),
    routeLimit: (from, to) => mainnetRouteLimit(from, to)
      ?? (phoenixProblem !== null && (from === 'phoenix' || to === 'phoenix') ? `Phoenix is refused: ${phoenixProblem}` : null),
    desk: async () => {
      const d = await readDesk();
      return {
        addresses: { deskId, contract: cfg.contractId, owner: d.owner, evm: d.evm_address, sol: d.solana.authority, orderlyReceiver: d.orderly_receiver },
        policy: policyOf(d.policy, d.policy),
        reserveUsd: Number(d.ledger.idle_usdc) / 1e6,
        closing: d.closing === true || closing.blocked() !== null,
      };
    },
    // Landings are confirmed in the target's ledger (Hyperliquid) or by the confirmed deposit (Phoenix). Orderly's
    // needs its private API, which serve does not open: refused as a target.
    landing: new VenueLandings({ hyperliquid: hlLanding, ...(phoenixProblem === null ? { phoenix: phoenixCredit.landing() } : {}) }, refusedLandings),
    payers: { reserve, arbitrum, ...(phoenixProblem === null ? { phoenix: phoenixPayer } : {}) },
    hlWithdraw: {
      withdraw: async (amountE6) => {
        const r = await hl.submit(await contract.hlWithdraw(deskId, usdcDecimal(amountE6)), await evm());
        return { tx: r.tx };
      },
    },
    withdrawals: (venue, paused) => log(`rescue: ${venue} withdrawals ${paused === null ? 'ran' : `refused: ${paused}`}`),
  });
  return {
    rescuer: (t) => rescuer.take(t), closing, running: () => rescuer.runningId, stop: () => rescuer.stop(), routes: routeLines(mode, true, phoenixProblem),
    summary: `rescue: LIVE on mainnet (GIMBAL_RESCUE=1), operator ${cfg.accountId}, 1Click ${apiKey === null ? 'without a key (+0.2 %)' : 'with a key'}; `
      + `Solana holds read on ${solRpcName} (${history === null ? 'serves transaction history' : 'NO transaction history: Phoenix routes refused'}); `
      + `holds and the cap meter kept in ${store.path}, lock ${lockText(lock.name)}${fresh ? ' (GIMBAL_RESCUE_FRESH: a first run)' : ''}`,
  };
}
