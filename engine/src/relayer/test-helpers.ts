// Shared by the relayer and contract tests (excluded from the build): the public vectors in contract/core/tests/vectors,
// a desk whose addresses are the vectors' public test keys, and a fetch stub that answers by URL and body.

import { readFileSync } from 'node:fs';
import type { ContractPolicy } from '@gimbal/shared';
import type { Hex } from 'viem';
import type { DeskView } from '../contract/types.ts';
import type { ReplayContractConfig } from '../contract/replay-client.ts';
import { ReplayContractClient } from '../contract/replay-client.ts';

/** A vector file by name ('hl', 'eip3009', 'orderly', 'solana'): public test keys only, never funded. */
export function vectors(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../../contract/core/tests/vectors/${name}.json`, import.meta.url), 'utf8'));
}

/** Public test keys of the vectors (secp256k1 0x01..01, Ed25519 seed 0x07..07): never funded. */
export const TEST_EVM_KEY: Hex = `0x${'01'.repeat(32)}`;
export const TEST_EVM_ADDRESS = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1';
export const TEST_SOL_SEED = Uint8Array.from(Buffer.from('07'.repeat(32), 'hex'));
export const TEST_SOL_AUTHORITY = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
export const TEST_DEPOSIT_EVM = '0x3325a78425F17a7E487Eb5666b2bFd93aBb06c70';

/** hl.json's order_policy as the contract's Policy (HYPE unpriced with max_sz 3). */
export function testPolicy(): ContractPolicy {
  const p = vectors('hl').order_policy.policy;
  return {
    hl_assets: p.hl_assets,
    phoenix_markets: [],
    orderly_symbols: ['PERP_ETH_USDC', 'PERP_BTC_USDC', 'PERP_SOL_USDC'],
    max_notional_usd: p.max_notional_usd,
    price_band_bps: p.price_band_bps,
    oracle_max_age_s: p.oracle_max_age_s,
    rescue_cap_usd_per_hour: 2000,
    unpriced: (p.unpriced as string[]).map((symbol) => ({ symbol, max_sz: '3' })),
    unpriced_max_notional_usd: p.unpriced_max_notional_usd,
    max_transfer_cost_bps: 50,
    max_transfer_cost_flat_e6: 1_000_000,
  };
}

export function testDesk(overrides: Partial<DeskView> = {}): DeskView {
  const sol = vectors('solana').desk;
  return {
    owner: 'owner.testnet', operator: 'owner.testnet', paused: false, policy: testPolicy(), evm_address: TEST_EVM_ADDRESS,
    solana: { authority: sol.authority, usdc_ata: sol.usdc_ata, phusd_ata: sol.phusd_ata, phoenix_trader: sol.phoenix_trader },
    orderly_receiver: null,
    ledger: { deposited: 0, withdrawn: 0, fees_paid: 0, hwm: 0, idle_usdc: 0 },
    ...overrides,
  };
}

export const TEST_CONFIG: ReplayContractConfig = {
  network: 'testnet', hlBuilder: '0x2222222222222222222222222222222222222222', hlBuilderTenthBps: 10,
  hlReferralCode: 'GIMBAL', orderlyReferralCode: 'GIMBAL',
};

/** A replay contract with desk "alpha" signing with the public test keys, prices stamped at `now()`. */
export function testContract(now: () => number, config: Partial<ReplayContractConfig> = {}): ReplayContractClient {
  const at = now();
  return new ReplayContractClient({
    config: { ...TEST_CONFIG, ...config },
    desks: { alpha: testDesk() },
    prices: [
      { asset: 'ETH', price_e8: '250000000000', at_ms: at }, { asset: 'BTC', price_e8: '8125000000000', at_ms: at },
      { asset: 'SOL', price_e8: '10380000000', at_ms: at },
    ],
    keys: { alpha: { evm: TEST_EVM_KEY, sol: TEST_SOL_SEED } },
    now,
  });
}

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
}

/** A fetch whose answers come from `route`; every request is recorded in `calls`. */
export function stubFetch(route: (call: StubCall) => unknown | Response): { fetch: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let json: unknown;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    const call: StubCall = {
      url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> | undefined) }, body, json,
    };
    calls.push(call);
    const answer = route(call);
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

/** A clock whose sleep moves it forward instantly. */
export function fakeTime(start: number): { now: () => number; clock: { now: () => number }; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    clock: { now: () => t },
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
