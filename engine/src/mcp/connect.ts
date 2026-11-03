// Wires the real desk tools from a DeskEnv: one keyed NEAR transport (NearApiTransport), the shared NearContractClient,
// a HyperliquidSubmitter and the live 1Click client. The operator key file's private key goes into the transport only;
// it is never printed. The same transport backs both the MCP server and the attack CLI.

import { NearContractClient } from '../contract/near-client.ts';
import { NearApiTransport } from '../contract/near-transport.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { HttpOneClick } from '../rescue/oneclick.ts';
import { DeskTools } from './desk-tools.ts';
import type { DeskEnv } from './env.ts';
import { loadOperatorKey } from './env.ts';

export interface Connected {
  tools: DeskTools;
  client: NearContractClient;
  transport: NearApiTransport;
  operatorAccount: string;
}

/** The keyed transport and the desk tools for `env`. `fetch` and `oneClickApiKey` are optional. */
export function connectDesk(env: DeskEnv, options: { fetch?: typeof fetch; oneClickApiKey?: string | null } = {}): Connected {
  const key = loadOperatorKey(env.keyFile, env.network);
  const transport = new NearApiTransport({
    network: env.network, accountId: key.accountId, privateKey: key.privateKey,
    ...(env.rpcUrl === undefined ? {} : { rpcUrl: env.rpcUrl }),
  });
  const client = new NearContractClient({ contractId: env.contractId, network: env.network, transport });
  const hl = new HyperliquidSubmitter({ network: env.network });
  const oneClick = new HttpOneClick({ ...(options.fetch === undefined ? {} : { fetch: options.fetch }), apiKey: options.oneClickApiKey ?? null });
  const tools = new DeskTools({
    network: env.network, contractId: env.contractId, deskId: env.deskId, contract: client, transport, hl, oneClick,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return { tools, client, transport, operatorAccount: key.accountId };
}
