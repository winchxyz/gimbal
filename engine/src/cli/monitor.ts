// The live pair's monitor, once, read-only: what serve prints every 30 min (risk/monitor.ts), from a single read of the
// desk's Hyperliquid and Phoenix accounts (the risk engine's own read and margin math), plus the pair trader's saved
// state (trade/trader-state.ts: the ADL attempts left, a pause, orders that may still run). Signs nothing, loads no key.
//
//   npm run monitor -w engine -- --mainnet [--env-file <engine env file>] [--state-dir <dir>]
//
// It needs GIMBAL_CONTRACT_ID and DESK_ID (from the environment or --env-file; values are never printed).
// Exit code 0: every leg is 25 % or more from liquidation and the legs offset each other; 1: an alert (a leg under
// 25 %, or the legs not offsetting); 2: it could not read.

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import type { DeskState, StreamEvent } from '@gimbal/shared';
import { NearContractClient } from '../contract/near-client.ts';
import { NearViewTransport } from '../contract/near-transport.ts';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import { RiskEngine } from '../risk/engine.ts';
import { ALERT_DISTANCE_PCT, LiquidationAlert, isHedged, legsUnder, monitorLines } from '../risk/monitor.ts';
import { AccountsDeskSource } from '../risk/sources.ts';
import { VenueHealth } from '../risk/venue-health.ts';
import { TraderStateStore, savedShape, traderStateFile, userStateDir } from '../trade/trader-state.ts';
import { signedQtyString } from '../trade/lots.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import { PHOENIX_API_URL, PhoenixReader, SOLANA_MAINNET_RPC_URL } from '../venues/phoenix.ts';
import { errorMessage } from '../venues/recorder.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

const say = (line: string) => console.log(line);

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`monitor: ${errorMessage(err)}`);
  process.exitCode = 2;
}
setTimeout(() => process.exit(), 300).unref();

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { mainnet: { type: 'boolean' }, 'env-file': { type: 'string' }, 'state-dir': { type: 'string' } } });
  if (values.mainnet !== true) throw new Error('usage: npm run monitor -w engine -- --mainnet [--env-file <file>] [--state-dir <dir>]');
  if (values['env-file'] !== undefined) process.loadEnvFile(values['env-file']);
  const env = (name: string): string | undefined => {
    const v = process.env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const cfg = contractEnv(env, 'mainnet');
  if (cfg === null) throw new Error('GIMBAL_CONTRACT_ID is not set (pass the engine env file with --env-file)');
  const transport = new NearViewTransport({ network: 'mainnet', ...(cfg.accountId === undefined ? {} : { accountId: cfg.accountId }), ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
  const client = new NearContractClient({ contractId: cfg.contractId, network: 'mainnet', transport });
  checkContractNetwork(cfg.contractId, await client.config(), 'mainnet');
  const desk = await client.getDesk(cfg.deskId);
  if (desk === null) throw new Error(`${cfg.contractId} has no desk ${cfg.deskId}`);
  const hlUrl = (env('HL_API_URL') ?? HL_MAINNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  const hl = new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` });
  const phoenix = new PhoenixReader({ apiUrl: env('PHOENIX_API_URL') ?? PHOENIX_API_URL, rpcUrl: env('SOLANA_RPC_URL') ?? SOLANA_MAINNET_RPC_URL });
  say(`gimbal monitor ${cfg.contractId} desk ${cfg.deskId} at ${new Date().toISOString()}: read-only`);
  say(`desk      ${desk.paused ? 'PAUSED' : 'running'}${desk.closing === true ? ', CLOSING (panic_close)' : ''}; reserve ${(Number(desk.ledger.idle_usdc) / 1e6).toFixed(2)} USDC`);

  let state: DeskState | null = null;
  const risk = new RiskEngine({
    mode: 'mainnet', strategy: () => DEFAULT_STRATEGY, health: new VenueHealth(), log: (l) => say(`risk      ${l}`),
    publish: (e: StreamEvent) => {
      if (e.type === 'desk') state = e.data;
    },
    // No position book here (serve keeps it): the legs' fees are 0 (the lines printed do not show fees or P&L).
    source: new AccountsDeskSource({
      deskId: cfg.deskId, owner: desk.owner, contract: cfg.contractId,
      accounts: [{ reader: hl, address: desk.evm_address }, { reader: phoenix, address: desk.solana.authority }],
      desk: async () => ({ reserveUsd: Number(desk.ledger.idle_usdc) / 1e6, paused: desk.paused ? { by: 'unknown', at: Date.now() } : null }),
    }),
  });
  try {
    await risk.tick();
  } finally {
    await risk.stop();
    phoenix.close();
  }
  const d = state as DeskState | null;
  if (d === null) throw new Error('the desk could not be read');
  for (const line of monitorLines(d)) say(line);
  const alert = new LiquidationAlert().observe(d, Date.now());
  for (const line of alert.console) say(line);

  const identity = { contractId: cfg.contractId, deskId: cfg.deskId, evm: desk.evm_address.toLowerCase() };
  const dir = values['state-dir'] ?? env('GIMBAL_STATE_DIR');
  const store = new TraderStateStore(traderStateFile(dir === undefined ? userStateDir(env) : resolve(dir), 'mainnet', identity), identity);
  const saved = store.load();
  if (saved.kind === 'none') say(`trader    no saved state at ${store.path} (serve has not traded this desk)`);
  else if (saved.kind === 'unusable') say(`trader    ${saved.problem}`);
  else {
    const s = saved.state;
    const base = s.trader?.baselines.map((b) => (b === null ? 'unknown' : signedQtyString(b))).join(' / ') ?? 'none';
    const venues = (savedShape(s)?.legs.map((l) => l.venue) ?? ['hyperliquid', 'phoenix']).join(' / ');
    say(`trader    ${s.symbol ?? 'no pair'}: baselines ${venues} ${base}; ADL ${s.adl.attemptsLeft} attempt(s) left${s.adl.paused === null ? '' : `, PAUSED (${s.adl.paused})`}`
      + `${s.adl.event === null ? '' : `, an ADL event since ${new Date(s.adl.event.at).toISOString()} (${s.adl.event.attempts} attempt(s))`}; saved ${new Date(s.savedAt).toISOString()}`);
    for (const u of s.trader?.unsettled ?? []) say(`open:     ${u.refs.map((r) => `${r.venue} ${r.side} ${r.size} (${r.clientId ?? r.orderId ?? 'no id'})`).join(' and ')} has no answer and may still run until ${new Date(u.until).toISOString()}`);
    for (const p of s.pendingMaker) say(`open:     hyperliquid post-only ${p.side} ${p.size} (oid ${p.oid ?? 'unknown'}, cloid ${p.cloid}) may still rest`);
    for (const f of s.inFlight) say(`open:     ${f.venue} ${f.side} ${f.size}${f.reduceOnly ? ' reduce-only' : ''} (${f.reason}) was sent at ${new Date(f.at).toISOString()} and no saved result holds its outcome`);
    if (s.trader?.unhedged != null) say(`open:     ${s.trader.unhedged}`);
  }
  const under = legsUnder(d);
  const off = d.legs.length > 0 && !isHedged(d);
  say(under.length === 0 && !off
    ? `ok        ${d.legs.length === 0 ? 'no open legs' : `every leg is ${ALERT_DISTANCE_PCT} % or more from liquidation, and the legs offset each other`}`
    : `ALERT     ${[...under.map((l) => `${l.venue} ${l.symbol} under ${ALERT_DISTANCE_PCT} % from liquidation`), ...(off ? [`net delta ${d.netDelta}: the legs do not offset`] : [])].join('; ')}`);
  return under.length === 0 && !off ? 0 : 1;
}
