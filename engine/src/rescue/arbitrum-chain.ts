// What the rescue reads on Arbitrum (E9), all at one block: the head, the desk's USDC, USDC Transfer logs and EIP-3009
// authorizationState. Read-only: nothing here signs or sends.
//
// The rescuer counts as its own only USDC it can prove came from its hl_withdraws: a Transfer log from Hyperliquid's
// Bridge2 contract to the desk address, of exactly the amount it expects. A payment of a held deposit is proven by a
// Transfer log from the desk to the 1Click deposit address. Both are read with the balance at the same block number,
// so a stale RPC answer can never make one look absent and the other present. The head is ARBITRUM_CONFIRMATIONS
// blocks behind the latest, with that block's own timestamp: logs of the newest blocks, which a provider may not have
// indexed yet, are read on the next pass, and a time bound is never judged on a block whose logs were not read.
//
// ViemArbitrumReads is the live reader (ARBITRUM_RPC_URL); SimulatedArbitrum is the same chain in memory for the
// recorded worlds (testnet, replay) and the tests.

import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import type { Hex, PublicClient, Transport } from 'viem';
import { arbitrum } from 'viem/chains';
import { redactError } from '../redact.ts';
import { ARBITRUM_USDC } from '../relayer/arbitrum.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { Clock } from '../venues/venue.ts';

/** Hyperliquid's bridge on Arbitrum: every withdraw3 pays out of it. */
export const HL_BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
/** getLogs asks for at most this many blocks at a time to begin with (providers cap the range). */
export const LOG_CHUNK_BLOCKS = 10_000n;
/** A range a provider refuses is halved down to this many blocks; refused below it, the read fails. */
export const MIN_LOG_CHUNK_BLOCKS = 100n;
/** The head the rescue reads is this many blocks behind the latest (about 1.25 s of Arbitrum). */
export const ARBITRUM_CONFIRMATIONS = 5n;

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
  /** The block ARBITRUM_CONFIRMATIONS behind the latest, with its timestamp. */
  head(): Promise<ArbitrumHead>;
  usdcBalance(address: string, block: bigint): Promise<bigint>;
  /** USDC Transfer logs from `from` to `to`, blocks fromBlock..toBlock inclusive. */
  transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]>;
  /** USDC's authorizationState at `block`: whether the EIP-3009 authorization was used. */
  authorizationUsed(authorizer: string, nonce: string, block: bigint): Promise<boolean>;
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const USDC_VIEWS = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

/** A getLogs refusal that names the range or the result size (each provider words it its own way). */
const RANGE_REFUSAL = /block range|range (is )?too (large|wide|big)|exceed|too many|more than \d+|limit|response size|-32005|-32602/i;
/**
 * A rate limit, which says nothing of the range: HTTP 429 and the providers' wordings (Infura's -32005 is used for
 * both, so the text decides). Checked before RANGE_REFUSAL, whose "limit" and "too many" it would otherwise match.
 */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|request rate|requests? per (second|minute)|\brps\b|compute units|throughput|quota/i;
/** A rate-limited getLogs is asked again this many times, after 1 s, 2 s, 4 s..., then the read fails. */
export const RATE_LIMIT_TRIES = 4;

export class ViemArbitrumReads implements ArbitrumReads {
  readonly #client: PublicClient;
  readonly #token: Hex;
  readonly #rpcUrl: string | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  /** The range getLogs is asked for: halved when a provider refuses one, kept for the next reads. */
  #chunk = LOG_CHUNK_BLOCKS;

  constructor(options: { rpcUrl?: string; transport?: Transport; sleep?: (ms: number) => Promise<void> } = {}) {
    this.#client = createPublicClient({ chain: arbitrum, transport: options.transport ?? http(options.rpcUrl) }) as PublicClient;
    this.#token = ARBITRUM_USDC.mainnet.token;
    this.#rpcUrl = options.rpcUrl;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The range getLogs is asked for now, blocks. */
  get chunkBlocks(): bigint {
    return this.#chunk;
  }

  async #safe<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw redactError(err, this.#rpcUrl);
    }
  }

  async head(): Promise<ArbitrumHead> {
    const latest = await this.#safe(this.#client.getBlockNumber({ cacheTime: 0 }));
    const number = latest > ARBITRUM_CONFIRMATIONS ? latest - ARBITRUM_CONFIRMATIONS : 0n;
    const b = await this.#safe(this.#client.getBlock({ blockNumber: number }));
    return { number, timestampS: Number(b.timestamp) };
  }

  usdcBalance(address: string, block: bigint): Promise<bigint> {
    return this.#safe(this.#client.readContract({ address: this.#token, abi: USDC_VIEWS, functionName: 'balanceOf', args: [address as Hex], blockNumber: block }));
  }

  authorizationUsed(authorizer: string, nonce: string, block: bigint): Promise<boolean> {
    return this.#safe(this.#client.readContract({ address: this.#token, abi: USDC_VIEWS, functionName: 'authorizationState', args: [authorizer as Hex, nonce as Hex], blockNumber: block }));
  }

  async transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
    const out: UsdcTransfer[] = [];
    let a = fromBlock;
    let limited = 0;
    while (a <= toBlock) {
      const b = a + this.#chunk - 1n < toBlock ? a + this.#chunk - 1n : toBlock;
      let logs;
      try {
        logs = await this.#safe(this.#client.getLogs({ address: this.#token, event: TRANSFER, args: { from: from as Hex, to: to as Hex }, fromBlock: a, toBlock: b }));
      } catch (err) {
        const why = errorMessage(err);
        // Rate limited: the same range again after a pause; the chunk stays as it is.
        if (RATE_LIMITED.test(why)) {
          if (++limited >= RATE_LIMIT_TRIES) throw err;
          await this.#sleep(1000 * 2 ** (limited - 1));
          continue;
        }
        // A range the provider will not serve: the same start again with half of it, never below the floor.
        if (!RANGE_REFUSAL.test(why) || this.#chunk <= MIN_LOG_CHUNK_BLOCKS) throw err;
        const half = this.#chunk / 2n;
        this.#chunk = half < MIN_LOG_CHUNK_BLOCKS ? MIN_LOG_CHUNK_BLOCKS : half;
        continue;
      }
      for (const l of logs) {
        if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        out.push({ id: `${l.transactionHash}:${l.logIndex}`, from: String(l.args.from).toLowerCase(), to: String(l.args.to).toLowerCase(), value: l.args.value ?? 0n, block: l.blockNumber });
      }
      a = b + 1n;
      limited = 0;
    }
    return out;
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Arbitrum in memory: a block every 250 ms of the clock, USDC balances with their history, Transfer logs and used
 * authorizations, each read at the block asked. A transfer may be scheduled for a later time (a withdraw that shows
 * 231 s after it was accepted).
 */
export class SimulatedArbitrum implements ArbitrumReads {
  readonly #clock: Clock;
  /** Per address, its balance after each change, oldest first. */
  readonly #balances = new Map<string, { block: bigint; value: bigint }[]>();
  readonly #logs: UsdcTransfer[] = [];
  readonly #scheduled: { at: number; from: string; to: string; value: bigint }[] = [];
  /** `${authorizer}:${nonce}` -> the block it was used in. */
  readonly #used = new Map<string, bigint>();
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
    const f = (from ?? ZERO).toLowerCase();
    if (atMs !== undefined && atMs > this.#clock.now()) {
      this.#scheduled.push({ at: atMs, from: f, to: to.toLowerCase(), value });
      return;
    }
    this.#settle();
    this.#apply(f, to.toLowerCase(), value, this.#clock.now());
  }

  /** Sets an address's balance with no log (USDC moved by a flow the test does not model). */
  setBalance(address: string, value: bigint): void {
    this.#settle();
    this.#set(address.toLowerCase(), value, this.blockAt(this.#clock.now()));
  }

  /** The EIP-3009 authorization was used (transferWithAuthorization ran), now or at `atMs`. */
  markUsed(authorizer: string, nonce: string, atMs?: number): void {
    this.#used.set(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`, this.blockAt(atMs ?? this.#clock.now()));
  }

  balanceNow(address: string): bigint {
    this.#settle();
    return this.#balanceAt(address.toLowerCase(), this.blockAt(this.#clock.now()));
  }

  #balanceAt(address: string, block: bigint): bigint {
    const h = this.#balances.get(address) ?? [];
    let v = 0n;
    for (const e of h) {
      if (e.block > block) break;
      v = e.value;
    }
    return v;
  }

  #set(address: string, value: bigint, block: bigint): void {
    const h = this.#balances.get(address) ?? [];
    h.push({ block, value });
    this.#balances.set(address, h);
  }

  #apply(from: string, to: string, value: bigint, at: number): void {
    const block = this.blockAt(at);
    if (from !== ZERO && from !== HL_BRIDGE2) this.#set(from, this.#balanceAt(from, block) - value, block);
    this.#set(to, this.#balanceAt(to, block) + value, block);
    this.#logs.push({ id: `0xsim${++this.#n}:0`, from, to, value, block });
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
    const latest = this.blockAt(this.#clock.now());
    const number = latest - ARBITRUM_CONFIRMATIONS;
    return { number, timestampS: Math.floor(Number(number * 250n) / 1000) };
  }

  async usdcBalance(address: string, block: bigint): Promise<bigint> {
    this.#check();
    return this.#balanceAt(address.toLowerCase(), block);
  }

  async transfers(from: string, to: string, fromBlock: bigint, toBlock: bigint): Promise<UsdcTransfer[]> {
    this.#check();
    return this.#logs.filter((l) => l.from === from.toLowerCase() && l.to === to.toLowerCase() && l.block >= fromBlock && l.block <= toBlock);
  }

  async authorizationUsed(authorizer: string, nonce: string, block: bigint): Promise<boolean> {
    this.#check();
    const at = this.#used.get(`${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
    return at !== undefined && at <= block;
  }
}
