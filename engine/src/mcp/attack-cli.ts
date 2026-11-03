// `npm run attack`: run the scripted malicious operator requests (attacks.ts) against one desk and print a table —
// attack, the code the chain answered, and the NEAR transaction or "rejected before the chain, no tx" — then a
// before/after ledger check. Configure it like the MCP server (GIMBAL_CONTRACT_ID, DESK_ID, NEAR_NETWORK,
// OPERATOR_KEY_FILE, NEAR_RPC_URL) or with flags.
//
//   node engine/src/mcp/attack-cli.ts --contract <id> --desk <id> [--dry] [--meter] [--only a,b]
//   npm run attack -w engine -- --contract gimbal-final-fcf135.testnet --desk final-1 --dry
//
// --dry (the default when no operator key file exists): build every request, print what would be sent and the code
// it expects, send nothing. --meter: also run the hourly-cap attack, which signs real orders first (none posted).

import { parseArgs } from 'node:util';
import { NearContractClient } from '../contract/near-client.ts';
import { NearViewTransport } from '../contract/near-transport.ts';
import type { AttackDeps } from './attacks.ts';
import { held, report, runAttacks } from './attacks.ts';
import { connectDesk } from './connect.ts';
import { deskEnv, processEnv } from './env.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      contract: { type: 'string' }, desk: { type: 'string' }, network: { type: 'string' },
      'key-file': { type: 'string' }, 'env-file': { type: 'string' },
      dry: { type: 'boolean' }, meter: { type: 'boolean' }, only: { type: 'string' },
    },
  });
  if (values['env-file'] !== undefined) process.loadEnvFile(values['env-file']);
  const env = deskEnv(processEnv, {
    ...(values.contract === undefined ? {} : { contract: values.contract }),
    ...(values.desk === undefined ? {} : { desk: values.desk }),
    ...(values.network === undefined ? {} : { network: values.network }),
    ...(values['key-file'] === undefined ? {} : { keyFile: values['key-file'] }),
  });
  const dry = values.dry === true || !env.keyExists;
  const only = values.only === undefined ? undefined : values.only.split(',').map((s) => s.trim()).filter((s) => s !== '');

  let deps: AttackDeps;
  if (dry) {
    // Views only: no key is loaded, nothing can be sent.
    const transport = new NearViewTransport({ network: env.network, ...(env.rpcUrl === undefined ? {} : { rpcUrl: env.rpcUrl }) });
    const client = new NearContractClient({ contractId: env.contractId, network: env.network, transport });
    deps = { network: env.network, contractId: env.contractId, deskId: env.deskId, contract: client, transport };
    if (!env.keyExists && values.dry !== true) say(`(no operator key file at ${env.keyFile}: dry run)`);
  } else {
    const c = connectDesk(env);
    deps = { network: env.network, contractId: env.contractId, deskId: env.deskId, contract: c.client, transport: c.transport };
  }

  const run = await runAttacks(deps, { dry, meter: values.meter === true, ...(only === undefined ? {} : { only }) });
  for (const line of report(run, env, dry)) say(line);
  if (dry) return 0;
  const ok = held(run);
  say(ok ? '\nPASS: the desk held — nothing signed, no USDC moved.' : '\nFAIL: an attack got through or USDC moved.');
  return ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('attack-cli.ts')) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; setTimeout(() => process.exit(), 300).unref(); })
    .catch((err) => { process.stderr.write(`attack: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); });
}
