// Arbitrum submitter for `evm_usdc_to_intents` (docs/interfaces.md §1.3, §1.4): the contract signed an EIP-3009
// TransferWithAuthorization from the desk's EVM address; the relayer's gas-only wallet (RELAYER_EVM_PRIVATE_KEY, a
// few dollars of ETH, never desk money) calls the USDC contract's transferWithAuthorization with it. The wallet can
// only submit what the contract signed: USDC itself checks the signature.
// Before paying any gas: the token and chain are the network's USDC, `from` is the desk, the authorization is not
// expired or already used, and its signature recovers to `from`. Then simulate, sign the transaction locally (so its
// hash is known before it leaves), send, and wait for the receipt. Once sent, no receipt in time (or a send error,
// which may come after the node took it) is OutcomeUnknown with the hash and the EIP-3009 nonce. An authorization
// already used means the transfer ran somewhere (anyone may submit it): OutcomeUnknown too, never NothingExecuted.
// viem quotes the RPC URL in its errors; ARBITRUM_RPC_URL's path and query (API keys) are cut from every error text.

import type { TxRef } from '@gimbal/shared';
import { createPublicClient, createWalletClient, encodeFunctionData, hashTypedData, http, isAddressEqual, keccak256, parseAbi } from 'viem';
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import type { Eip3009SignedAction, OutcomeIds } from '../contract/types.ts';
import { OutcomeUnknown } from '../contract/types.ts';
import { redact, redactError } from '../redact.ts';
import { hlSignature, recoverSigner } from './hl-wire.ts';
import type { ChainNetwork } from './tx.ts';
import { NothingExecuted, arbitrumTxRef } from './tx.ts';

export const ARBITRUM_USDC: Record<ChainNetwork, { token: Hex; chain: Chain }> = {
  mainnet: { token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chain: arbitrum },
  testnet: { token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', chain: arbitrumSepolia },
};

export const USDC_EIP3009_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

/** The EIP-3009 digest USDC verifies: domain "USD Coin" / "2" / chain / the token. */
export function eip3009Digest(p: Eip3009SignedAction['payload']): Hex {
  return hashTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: p.chainId, verifyingContract: p.token as Hex },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: p.from as Hex, to: p.to as Hex, value: BigInt(p.value), validAfter: BigInt(p.validAfter),
      validBefore: BigInt(p.validBefore), nonce: p.nonce as Hex,
    },
  });
}

export interface ArbitrumSubmitterOptions {
  network: ChainNetwork;
  rpcUrl?: string;
  /** The relayer's gas wallet key (0x + 32 bytes); read from the environment by the caller, never logged. */
  relayerKey: Hex;
  /** A viem transport in place of http(rpcUrl): tests. */
  transport?: Transport;
  /** How long to wait for the receipt; default 120 s. */
  receiptTimeoutMs?: number;
  /** Seconds an authorization must still be valid for to be worth sending; default 60. */
  minValidityS?: number;
  now?: () => number;
}

export class ArbitrumSubmitter {
  readonly network: ChainNetwork;
  readonly relayerAddress: Hex;
  readonly #token: Hex;
  readonly #chain: Chain;
  readonly #public: PublicClient;
  readonly #wallet: WalletClient<Transport, Chain, Account>;
  readonly #receiptTimeoutMs: number;
  readonly #minValidityS: number;
  readonly #now: () => number;
  readonly #rpcUrl: string | undefined;

  constructor(options: ArbitrumSubmitterOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.relayerKey)) throw new Error('RELAYER_EVM_PRIVATE_KEY must be 0x + 32 bytes of hex');
    this.network = options.network;
    const { token, chain } = ARBITRUM_USDC[options.network];
    this.#token = token;
    this.#chain = chain;
    const transport = options.transport ?? http(options.rpcUrl);
    const account = privateKeyToAccount(options.relayerKey);
    this.relayerAddress = account.address;
    this.#public = createPublicClient({ chain, transport }) as PublicClient;
    this.#wallet = createWalletClient({ account, chain, transport });
    this.#receiptTimeoutMs = options.receiptTimeoutMs ?? 120_000;
    this.#minValidityS = options.minValidityS ?? 60;
    this.#now = options.now ?? Date.now;
    this.#rpcUrl = options.rpcUrl;
  }

  /** The promise's error with the RPC URL's path and query taken out of its text. */
  async #safe<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw redactError(err, this.#rpcUrl);
    }
  }

  /** Checks, submits and confirms one authorization from the desk at `deskAddress`. */
  async submit(signed: Eip3009SignedAction, deskAddress: string): Promise<TxRef[]> {
    const nearTx = signed.nearTx === undefined ? [] : [signed.nearTx];
    const p = signed.payload;
    for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce', 'token', 'chainId'] as const) {
      if (p?.[field] === undefined || p[field] === null) throw new Error(`arbitrum: the signed authorization has no ${field}`);
    }
    if (p.chainId !== this.#chain.id) throw new Error(`arbitrum: signed for chain ${p.chainId}, the relayer sends on ${this.#chain.id}`);
    if (!isAddressEqual(p.token as Hex, this.#token)) throw new Error(`arbitrum: token ${p.token} is not USDC on ${this.#chain.name}`);
    if (!isAddressEqual(p.from as Hex, deskAddress as Hex)) throw new Error(`arbitrum: from ${p.from} is not the desk's ${deskAddress}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.nonce)) throw new Error('arbitrum: the nonce must be 32 bytes');
    const nowS = Math.floor(this.#now() / 1000);
    if (BigInt(p.validBefore) <= BigInt(nowS + this.#minValidityS)) {
      throw new NothingExecuted('arbitrum', `the authorization expires at ${p.validBefore}, too soon to send`, nearTx);
    }
    if (BigInt(p.validAfter) > BigInt(nowS)) throw new Error(`arbitrum: the authorization is valid only after ${p.validAfter}`);
    const sig = hlSignature(signed.signature);
    const signer = await recoverSigner(eip3009Digest(p), sig);
    if (signer !== deskAddress.toLowerCase()) throw new Error(`arbitrum: the authorization recovers to ${signer}, not the desk's ${deskAddress.toLowerCase()}; nothing sent`);
    const ids: OutcomeIds = { eip3009Nonce: p.nonce, ...(signed.nearTx === undefined ? {} : { nearTx: signed.nearTx.id }) };
    const used = await this.#safe(this.#public.readContract({
      address: this.#token, abi: USDC_EIP3009_ABI, functionName: 'authorizationState', args: [p.from as Hex, p.nonce as Hex],
    }));
    if (used) {
      throw new OutcomeUnknown('arbitrum transferWithAuthorization', `authorization ${p.nonce} is already used: the transfer ran in a transaction this relayer did not see`, ids, nearTx);
    }

    const args = [
      p.from as Hex, p.to as Hex, BigInt(p.value), BigInt(p.validAfter), BigInt(p.validBefore), p.nonce as Hex, sig.v, sig.r, sig.s,
    ] as const;
    await this.#safe(this.#public.simulateContract({
      address: this.#token, abi: USDC_EIP3009_ABI, functionName: 'transferWithAuthorization', args, account: this.#wallet.account,
    }));
    const prepared = await this.#safe(this.#wallet.prepareTransactionRequest({
      account: this.#wallet.account, chain: this.#chain, to: this.#token,
      data: encodeFunctionData({ abi: USDC_EIP3009_ABI, functionName: 'transferWithAuthorization', args }),
    }));
    const serialized = await this.#wallet.signTransaction(prepared);
    const hash = keccak256(serialized);
    const ref = arbitrumTxRef(this.network, hash);
    let sendError: string | null = null;
    try {
      await this.#wallet.sendRawTransaction({ serializedTransaction: serialized });
    } catch (err) {
      // The node may have taken it before the error (a timeout, a retried request answering "already known").
      sendError = redact((err as Error).message, this.#rpcUrl);
    }
    let receipt;
    try {
      receipt = await this.#public.waitForTransactionReceipt({ hash, timeout: this.#receiptTimeoutMs });
    } catch (err) {
      const receiptError = redact((err as Error).message, this.#rpcUrl);
      const why = sendError === null ? receiptError : `send: ${sendError}; then ${receiptError}`;
      throw new OutcomeUnknown('arbitrum transferWithAuthorization', `no receipt for ${hash}: ${oneLine(why)}`, { ...ids, arbitrumTx: hash }, [...nearTx, ref]);
    }
    if (receipt.status !== 'success') throw new NothingExecuted('arbitrum', `transferWithAuthorization reverted in ${hash}`, [...nearTx, ref]);
    return [...nearTx, ref];
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}
