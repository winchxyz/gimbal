// The Gimbal MCP server over stdio: five tools an AI agent can call against one desk (read it, place a Hyperliquid
// order, fund a venue, withdraw, and try an attack). Every tool returns the contract's answer — a result, or a
// refusal with its E_* code and the NEAR transaction. The server holds no venue key; the NEAR operator key signs,
// and only the methods that key allows (tools/testnet/operator-key.mjs adds it). Configure it with env:
//   GIMBAL_CONTRACT_ID, DESK_ID, NEAR_NETWORK (default testnet), OPERATOR_KEY_FILE (default
//   .keys/operator-<contract>.json), NEAR_RPC_URL (optional), ONECLICK_API_KEY (optional).
//
//   node engine/src/mcp/server.ts        # or: npm run mcp -w engine

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { DeskTools, FundVenueInput, PlaceOrderInput, ToolAnswer } from './desk-tools.ts';
import { connectDesk } from './connect.ts';
import { deskEnv, processEnv } from './env.ts';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent: Record<string, unknown>;
  [k: string]: unknown;
}

const json = (answer: ToolAnswer): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(answer, null, 2) }],
  isError: answer.ok === false,
  structuredContent: answer as Record<string, unknown>,
});

/**
 * registerTool, typed against the engine's zod. The MCP SDK carries its own zod copy, so the two are nominally
 * incompatible to the type checker though identical at runtime; this wrapper is the one cast that bridges them.
 */
type RegisterTool = (name: string, config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny> }, cb: (input: Record<string, unknown>) => Promise<ToolResult>) => void;

/** Registers the five tools on `server`. Exposed so a test can list and call them without a transport. */
export function registerDeskTools(server: McpServer, tools: DeskTools): void {
  const where = `desk ${tools.deskId} on ${tools.contractId} (${tools.network})`;
  const register = server.registerTool.bind(server) as unknown as RegisterTool;

  register('read_desk', {
    title: 'Read the desk',
    description: `Read ${where}: its policy, ledger, hourly meters, addresses, oracle prices and Hyperliquid positions. No signature, no change.`,
    inputSchema: {},
  }, async () => json(await tools.status()));

  register('place_hl_order', {
    title: 'Place a Hyperliquid order',
    description: 'Ask the contract to sign a Hyperliquid order and post it. The contract checks it against the policy (asset, size, price band, hourly cap) and refuses with an E_* code if it is outside. Prices and sizes are canonical decimal strings.',
    inputSchema: {
      symbol: z.string().describe('a perp symbol, e.g. BTC, ETH, SOL (or a Hyperliquid asset index)'),
      side: z.enum(['buy', 'sell']),
      size: z.string().describe('base size, canonical decimal (no trailing zeros)'),
      price: z.string().describe('limit price, canonical decimal'),
      tif: z.enum(['Ioc', 'Gtc', 'Alo']).optional().describe('time in force, default Ioc'),
      reduce_only: z.boolean().optional(),
      reason: z.string().max(280).optional(),
      post: z.boolean().optional().describe('false: sign but do not post to Hyperliquid (default true)'),
    },
  }, async (input) => json(await tools.placeOrder(input as unknown as PlaceOrderInput)));

  register('fund_venue', {
    title: 'Fund a venue with a 1Click quote',
    description: 'Move the desk\'s idle USDC on NEAR to one of its own venue accounts through a 1Click quote. Give venue + amount_usdc and the server fetches a live quote, or bring your own quote + quote_signature. The contract verifies the 1Click signature and the recipient; a quote that pays anyone but the desk is refused (E_QUOTE_SIGNATURE / E_QUOTE_FIELDS).',
    inputSchema: {
      venue: z.enum(['hyperliquid', 'phoenix', 'orderly']).optional(),
      amount_usdc: z.number().positive().optional(),
      quote: z.string().optional().describe('the canonical quote string 1Click signed (instead of venue+amount)'),
      quote_signature: z.string().optional(),
      reason: z.string().max(280).optional(),
    },
  }, async (input) => json(await tools.fundVenue(input as unknown as FundVenueInput)));

  register('withdraw', {
    title: 'Withdraw from Hyperliquid',
    description: 'Ask the contract to sign a Hyperliquid withdraw (withdraw3). It can only go to the desk\'s own EVM address on Arbitrum — the method takes no destination — and the operator path has a minimum and counts against the rescue cap. amount is a canonical USDC decimal string.',
    inputSchema: {
      amount: z.string().describe('USDC, canonical decimal (Hyperliquid takes its 1 USDC fee out of it)'),
      post: z.boolean().optional().describe('false: sign but do not post (default true)'),
    },
  }, async (input) => json(await tools.withdraw(input as unknown as { amount: string; post?: boolean })));

  register('try_attack', {
    title: 'Try to make the desk steal',
    description: 'Send one deliberately bad request and return the contract\'s refusal. attacks: over-size (E_SIZE), asset (E_ASSET), withdraw-destination (E_ARGS), fake-quote (E_QUOTE_SIGNATURE), foreign-quote (E_QUOTE_FIELDS), owner-method (node rejects, no tx), orderly-market (E_PRICE_BAND). dry: true builds the request and returns what would be sent without sending it.',
    inputSchema: {
      attack: z.enum(['over-size', 'asset', 'withdraw-destination', 'fake-quote', 'foreign-quote', 'owner-method', 'orderly-market']),
      dry: z.boolean().optional(),
    },
  }, async (input) => json(await tools.tryAttack(input as unknown as { attack: string; dry?: boolean })));
}

export async function main(): Promise<void> {
  const env = deskEnv(processEnv);
  if (!env.keyExists) {
    throw new Error(`no operator key file at ${env.keyFile}. Add it with: node tools/testnet/operator-key.mjs ${env.contractId} --owner <owner>.testnet --send`);
  }
  const { tools } = connectDesk(env, { oneClickApiKey: processEnv('ONECLICK_API_KEY') ?? null });
  const server = new McpServer({ name: 'gimbal', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerDeskTools(server, tools);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; everything human goes to stderr.
  process.stderr.write(`gimbal MCP server: desk ${env.deskId} on ${env.contractId} (${env.network}), operator key ${env.keyFile}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) {
  main().catch((err) => {
    process.stderr.write(`gimbal MCP server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
