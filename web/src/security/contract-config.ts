// `config()` as this screen reads it: which network the contract runs on, who signs for it, where its prices come from
// and what it charges (docs/interfaces.md §1.1). The contract fixes all of it in `new`, so it never changes.
// `onboarding/chain.ts` reads only the network and the MPC contract; the rest is here.

export interface ContractConfig {
  network: 'Mainnet' | 'Testnet';
  /** The NEAR MPC contract that signs for the desk. */
  mpc: string;
  /** `outlayer`: prices come from that oracle contract. `mock`: owner-set prices, testnet and demo only. */
  oracle: { kind: 'outlayer'; contract: string } | { kind: 'mock' };
  /** Receives the performance fee. */
  treasury: string;
  fees: { performanceBps: number; hlBuilderTenthBps: number };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`config(): ${what} is not text`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`config(): ${what} is not a whole number`);
  return value;
}

/** Checks one `config()` answer; throws with what is wrong, so the screen can say so. */
export function parseConfig(value: unknown): ContractConfig {
  if (!isObject(value)) throw new Error('config(): not an object');
  if (value.network !== 'Mainnet' && value.network !== 'Testnet') throw new Error('config(): network is neither Mainnet nor Testnet');
  const { price_source: source, treasury, fees } = value;
  // serde writes a unit variant as its name and a struct variant as { Name: { … } }.
  let oracle: ContractConfig['oracle'];
  if (source === 'Mock') oracle = { kind: 'mock' };
  else if (isObject(source) && isObject(source.OutLayer)) oracle = { kind: 'outlayer', contract: text(source.OutLayer.contract, 'price_source.OutLayer.contract') };
  else throw new Error('config(): price_source is neither Mock nor OutLayer');
  if (!isObject(treasury)) throw new Error('config(): no treasury');
  if (!isObject(fees)) throw new Error('config(): no fees');
  return {
    network: value.network,
    mpc: text(value.mpc, 'mpc'),
    oracle,
    treasury: text(treasury.near, 'treasury.near'),
    fees: { performanceBps: count(fees.performance_bps, 'fees.performance_bps'), hlBuilderTenthBps: count(fees.hl_builder_tenth_bps, 'fees.hl_builder_tenth_bps') },
  };
}
