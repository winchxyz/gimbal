// The NEAR and Hyperliquid wiring of pair-mainnet refuse-band / refuse-notional (refuse-lib.ts): a contract client over
// the operator key (--send) or views only, the stored price reads, and Hyperliquid's book. pair-mainnet.ts calls it
// before it takes the trader lock and before it builds any relayer or submitter; nothing imported here can post to a
// venue (refuse-lib.test.ts walks these imports).

import { formatNear, spendable } from '../contract/budget.ts';
import type { NearTransport } from '../contract/near-client.ts';
import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport, NearViewTransport } from '../contract/near-transport.ts';
import { HL_MAINNET_URL, HyperliquidReader } from '../venues/hyperliquid.ts';
import type { Args, StoredPrice } from './pair-mainnet-lib.ts';
import { UsageError, newPriceState, refreshLanded } from './pair-mainnet-lib.ts';
import type { RefusalKind } from './refuse-lib.ts';
import { refuse } from './refuse-lib.ts';
import { checkContractNetwork, contractEnv } from './serve-contract.ts';

export async function runRefuse(kind: RefusalKind, args: Args, envVar: (name: string) => string | undefined, say: (line?: string) => void, tree: boolean): Promise<number> {
  const symbolArg = args.positional[0];
  if (symbolArg === undefined || args.positional.length > 1) throw new UsageError(`${args.command} needs one <symbol>`);
  if (Object.keys(args.flags).some((f) => f !== '--send')) throw new UsageError(`${args.command} takes no option but --send`);
  const cfg = contractEnv(envVar, 'mainnet', { signing: args.send });
  if (cfg === null) throw new Error('GIMBAL_CONTRACT_ID is not set: pass the engine env file with node --env-file');
  if (cfg.network !== 'mainnet') throw new Error('mainnet only');
  if (args.send && (cfg.privateKey === undefined || cfg.accountId === undefined)) throw new Error('--send needs OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY in the env file');
  const hlUrl = (envVar('HL_API_URL') ?? HL_MAINNET_URL).replace(/\/+$/, '').replace(/\/info$/, '');
  if (/testnet/.test(hlUrl)) throw new Error(`HL_API_URL ${hlUrl} is a testnet URL; this is mainnet`);

  const transport: NearTransport = args.send
    ? new NearApiTransport({ network: 'mainnet', accountId: cfg.accountId!, privateKey: cfg.privateKey!, ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) })
    : new NearViewTransport({ network: 'mainnet', ...(cfg.accountId === undefined ? {} : { accountId: cfg.accountId }), ...(cfg.rpcUrl === undefined ? {} : { rpcUrl: cfg.rpcUrl }) });
  const client = new NearContractClient({ contractId: cfg.contractId, network: 'mainnet', transport });
  checkContractNetwork(cfg.contractId, await client.config(), 'mainnet');
  const desk = await client.getDesk(cfg.deskId);
  if (desk === null) throw new Error(`${cfg.contractId} has no desk ${cfg.deskId}`);
  say(`gimbal pair-mainnet ${args.command} ${symbolArg} for ${cfg.contractId} desk ${cfg.deskId}: ${args.send ? 'SEND' : 'dry run'}`);
  if (tree) say('warning   this checkout is a linked git worktree: --send refuses here; run it from the main checkout');
  say(`desk      ${desk.paused ? 'PAUSED' : 'running'}${desk.closing === true ? ', CLOSING (panic_close)' : ''}; operator ${desk.operator ?? 'none (the owner signs)'}`);
  say('safe      no trader lock, no venue order, one NEAR call at a time: it runs beside serve on the same key');
  const room = async () => {
    const [account, allowance] = await Promise.all([transport.account(), transport.allowance()]);
    say(`signer    ${cfg.accountId}: ${formatNear(account.amount)}, allowance ${allowance === null ? 'unlimited' : formatNear(allowance)}`);
    return { spendable: spendable(account), allowance };
  };
  const read = async (symbol: string): Promise<StoredPrice | null> => {
    const row = (await client.prices()).find((p) => p.asset === symbol);
    return row === undefined ? null : { px: Number(row.price_e8) / 1e8, ageS: (Date.now() - row.at_ms) / 1000 };
  };
  const hl = new HyperliquidReader({ network: 'mainnet', url: `${hlUrl}/info` });
  return refuse({
    kind, symbol: symbolArg.toUpperCase(), send: args.send, deskId: cfg.deskId, desk, client, room,
    prices: {
      maxAgeS: desk.policy.oracle_max_age_s, send: args.send, read, refresh: (symbol, maxAgeS) => client.refreshPrices([symbol], { maxAgeS }),
      now: () => Date.now(), log: say, landed: refreshLanded, ...newPriceState(),
    },
    bestAsk: async (symbol) => {
      const px = (await hl.book(symbol, 5)).asks[0]?.px;
      if (px === undefined) throw new Error(`no asks on Hyperliquid ${symbol}`);
      return px;
    },
    say,
  });
}
