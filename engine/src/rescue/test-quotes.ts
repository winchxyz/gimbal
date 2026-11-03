// Tests only: 1Click-shaped quotes signed with a key of the test's own, for the routes no live quote was recorded
// for (Arbitrum USDC into Solana USDC, any amount). verifyQuote takes the key as QuoteCheck.publicKey.

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { base58 } from '../venues/orderly-signer.ts';
import type { QuoteRequest, QuoteResponse } from './oneclick.ts';
import { DECIMALS, canonicalQuote } from './oneclick.ts';

export interface TestSigner {
  publicKey: string;
  sign(response: Omit<QuoteResponse, 'signature'>): QuoteResponse;
}

export function testSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: base58(raw),
    sign(response) {
      const quote = canonicalQuote({ ...response, signature: '' });
      const message = Buffer.from(base58(createHash('sha256').update(Buffer.from(quote, 'utf8')).digest()), 'utf8');
      return { ...response, signature: `ed25519:${base58(sign(null, message, privateKey))}` };
    },
  };
}

let seq = 0;

/** 1Click's answer to `body` at `nowMs`: `costShare` of amountIn lost to fees, and the slippage asked below that. */
export function testQuote(signer: TestSigner, body: QuoteRequest, nowMs: number, costShare = 0.01): QuoteResponse {
  const inDec = DECIMALS[body.originAsset] ?? 6;
  const outDec = DECIMALS[body.destinationAsset] ?? 6;
  const amountIn = BigInt(body.amount);
  const outIn = (Number(amountIn) / 10 ** inDec) * (1 - costShare);
  const amountOut = BigInt(Math.floor(outIn * 10 ** outDec));
  const minAmountOut = (amountOut * BigInt(10_000 - body.slippageTolerance)) / 10_000n;
  const deadline = new Date(nowMs + 30 * 60_000).toISOString();
  return signer.sign({
    quoteRequest: { ...body },
    quote: {
      amountIn: amountIn.toString(), amountInFormatted: String(Number(amountIn) / 10 ** inDec), amountInUsd: String(Number(amountIn) / 10 ** inDec),
      minAmountIn: amountIn.toString(), amountOut: amountOut.toString(), amountOutFormatted: String(outIn), amountOutUsd: String(outIn),
      minAmountOut: minAmountOut.toString(), timeEstimate: 30, deadline, timeWhenInactive: deadline,
      depositAddress: `test-deposit-${++seq}`,
    },
    timestamp: new Date(nowMs).toISOString(),
  });
}
