// What the rescue reads on Arbitrum (E9), all at one block: the head, the desk's USDC, USDC Transfer logs and EIP-3009
// authorizationState. Read-only: nothing here signs or sends.
//
// The rescuer counts as its own only USDC it can prove came from its hl_withdraws: a Transfer log from Hyperliquid's
// Bridge2 contract to the desk address, of exactly the amount it expects. A payment of a held deposit is proven by a
// Transfer log from the desk to the 1Click deposit address. Both are read with the balance at the same block number,
// so a stale RPC answer can never make one look absent and the other present.
//
// ViemArbitrumReads is the live reader (ARBITRUM_RPC_URL); SimulatedArbitrum is the same chain in memory for the
// recorded worlds (testnet, replay) and the tests.

import { createPublicClient, http, keccak256, parseAbi, parseAbiItem } from 'viem';
import type { Hex, PublicClient, Transport } from 'viem';
import { arbitrum } from 'viem/chains';
import { redactError } from '../redact.ts';
import { ARBITRUM_USDC } from '../relayer/arbitrum.ts';
import type { Clock } from '../venues/venue.ts';

/** Hyperliquid's bridge on Arbitrum: every withdraw3 pays out of it. */
export const HL_BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
/** getLogs asks for at most this many blocks at a time (providers cap the range). */
export const LOG_CHUNK_BLOCKS = 10_000n;

export interface ArbitrumHead {
  number: bigint;
  /** The block's timestamp, unix seconds. */
  timestampS: number;
}

/** One USDC Transfer log; `id` (tx hash and log index) is unique, so one log is counted once. */
export interface UsdcTransfer {
  id: string;
  from: string;
  to: string;
  value: bigint;
  block: bigint;
}

export interface ArbitrumReads {
  head(): Promise<ArbitrumHead>;
  usdcBalance(address: string, block: bigint): Promise<bigint>;
  /** USDC Transfer logs from `from` to `to`, blocks fromBlock..toBlock inclusive. */
  transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]>;
  /** USDC's authorizationState at `block`: whether the EIP-3009 authorization was used. */
  authorizationUsed(authorizer: string, nonce: string, block: bigint): Promise<boolean>;
}

/** The contract's EIP-3009 nonce for a desk's `counter`: keccak256(utf8(desk_id) ‖ counter as u64 big-endian). */
export function eip3009Nonce(deskId: string, counter: bigint): string {
  const id = new TextEncoder().encode(deskId);
  const pre = new Uint8Array(id.length + 8);
  pre.set(id, 0);
  new DataView(pre.buffer).setBigUint64(id.length, counter, false);
  return keccak256(pre);
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const USDC_VIEWS = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

export class ViemArbitrumReads implements ArbitrumReads {
  readonly #client: PublicClient;
  readonly #token: Hex;
  readonly #rpcUrl: string | undefined;

  constructor(options: { rpcUrl?: string; transport?: Transport } = {}) {
    this.#client = createPublicClient({ chain: arbitrum, transport: options.transport ?? http(options.rpcUrl) }) as PublicClient;
    this.#token = ARBITRUM_USDC.mainnet.token;
    this.#rpcUrl = options.rpcUrl;
  }

  async #safe<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw redactError(err, this.#rpcUrl);
    }
  }

  async head(): Promise<ArbitrumHead> {
    const b = await this.#safe(this.#client.getBlock({ blockTag: 'latest' }));
    if (b.number === null) throw new Error('arbitrum: the latest block has no number');
    return { number: b.number, timestampS: Number(b.timestamp) };
  }

  usdcBalance(address: string, block: bigint): Promise<bigint> {
    return this.#safe(this.#client.readContract({ address: this.#token, abi: USDC_VIEWS, functionName: 'balanceOf', args: [address as Hex], blockNumber: block }));
  }

  authorizationUsed(authorizer: string, nonce: string, block: bigint): Promise<boolean> {
    return this.#safe(this.#client.readContract({ address: this.#token, abi: USDC_VIEWS, functionName: 'authorizationState', args: [authorizer as Hex, nonce as Hex], blockNumber: block }));
  }

  async transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
    const out: UsdcTransfer[] = [];
    for (let a = fromBlock; a <= toBlock; a += LOG_CHUNK_BLOCKS) {
      const b = a + LOG_CHUNK_BLOCKS - 1n < toBlock ? a + LOG_CHUNK_BLOCKS - 1n : toBlock;
      const logs = await this.#safe(this.#client.getLogs({ address: this.#token, event: TRANSFER, args: { from: from as Hex, to: to as Hex }, fromBlock: a, toBlock: b }));
      for (const l of logs) {
        if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        out.push({ id: `${l.transactionHash}:${l.logIndex}`, from: String(l.args.from).toLowerCase(), to: String(l.args.to).toLowerCase(), value: l.args.value ?? 0n, block: l.blockNumber });
      }
    }
    return out;
  }
}

/**
 * Arbitrum in memory: a block every 250 ms of the clock, USDC balances, Transfer logs and used authorizations. A
 * transfer may be scheduled for a later time (a withdraw that shows 231 s after it was accepted).
 */
export class SimulatedArbitrum implements ArbitrumReads {
  readonly #clock: Clock;
  readonly #balances = new Map<string, bigint>();
  readonly #logs: UsdcTransfer[] = [];
  readonly #scheduled: { at: number; from: string; to: string; value: bigint }[] = [];
  readonly used = new Set<string>();
  #n = 0;
  /** Reads fail while set (an RPC that is down). */
  down: string | null = null;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  blockAt(ms: number): bigint {
    return BigInt(Math.floor(ms / 250));
  }

  /** A USDC transfer now (`from` null: minted, as from another chain), or at `atMs`. */
  transfer(from: string | null, to: string, value: bigint, atMs?: number): void {
    const f = (from ?? '0x0000000000000000000000000000000000000000').toLowerCase();
    if (atMs !== undefined && atMs > this.#clock.now()) {
      this.#scheduled.push({ at: atMs, from: f, to: to.toLowerCase(), value });
      return;
    }
    this.#apply(f, to.toLowerCase(), value, this.#clock.now());
  }

  /** Sets an address's balance with no log (USDC moved by a flow the test does not model). */
  setBalance(address: string, value: bigint): void {
    this.#settle();
    this.#balances.set(address.toLowerCase(), value);
  }

  balanceNow(address: string): bigint {
    this.#settle();
    return this.#balances.get(address.toLowerCase()) ?? 0n;
  }

  #apply(from: string, to: string, value: bigint, at: number): void {
    if (from !== '0x0000000000000000000000000000000000000000' && from !== HL_BRIDGE2) this.#balances.set(from, (this.#balances.get(from) ?? 0n) - value);
    this.#balances.set(to, (this.#balances.get(to) ?? 0n) + value);
    this.#logs.push({ id: `0xsim${++this.#n}:0`, from, to, value, block: this.blockAt(at) });
  }

  #settle(): void {
    const now = this.#clock.now();
    for (const s of [...this.#scheduled].sort((a, b) => a.at - b.at)) {
      if (s.at > now) continue;
      this.#scheduled.splice(this.#scheduled.indexOf(s), 1);
      this.#apply(s.from, s.to, s.value, s.at);
    }
  }

  #check(): void {
    if (this.down !== null) throw new Error(this.down);
    this.#settle();
  }

  async head(): Promise<ArbitrumHead> {
    this.#check();
    const now = this.#clock.now();
    return { number: this.blockAt(now), timestampS: Math.floor(now / 1000) };
  }

  async usdcBalance(address: string): Promise<bigint> {
    this.#check();
    return this.#balances.get(address.toLowerCase()) ?? 0n;
  }

  async transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
    this.#check();
    return this.#logs.filter((l) => l.from === from.toLowerCase() && l.to === to.toLowerCase() && l.block >= fromBlock && l.block <= toBlock);
  }

  async authorizationUsed(authorizer: string, nonce: string): Promise<boolean> {
    this.#check();
    return this.used.has(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
  }
}
