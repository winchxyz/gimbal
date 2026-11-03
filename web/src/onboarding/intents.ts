// Funding through NEAR Intents (1Click, https://1click.chaindefuser.com/v0): the owner sends USDC on another chain to a
// deposit address and 1Click delivers USDC on NEAR to the owner's own account. The owner's wallet then deposits it
// into the desk with `ft_transfer_call`, so it counts as principal (docs/interfaces.md §1.2): USDC that 1Click
// delivered straight to the contract would land in `idle_usdc` and count as profit at the first payout.
// Request and answer shapes follow the live quotes in contract/core/tests/vectors/oneclick-live.json.
//
// 1Click has no testnet (CLAUDE.md): on testnet there is no quote, only USDC already on NEAR.

export const ONECLICK = 'https://1click.chaindefuser.com/v0';

/** USDC on NEAR, the asset every quote ends in. */
export const NEAR_USDC_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export interface Origin {
  id: 'arbitrum' | 'solana';
  label: string;
  /** 1Click's id of USDC on that chain. */
  asset: string;
  /** What a refund address looks like, for the field's placeholder. */
  addressHint: string;
  isAddress(text: string): boolean;
}

export const ORIGINS: readonly Origin[] = [
  {
    id: 'arbitrum',
    label: 'Arbitrum',
    asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    addressHint: '0x…',
    isAddress: (t) => /^0x[0-9a-fA-F]{40}$/.test(t),
  },
  {
    id: 'solana',
    label: 'Solana',
    asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    addressHint: 'a Solana address',
    isAddress: (t) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t),
  },
];

/** The smallest amount worth sending: 1Click's fee is near-flat, so a small transfer loses a large share of itself. */
export const MIN_FUND_USDC = 5;

export interface IntentsRequest {
  origin: Origin;
  /** USDC to send from that chain, a decimal such as "100" or "250.5". */
  amountUsdc: string;
  /** Where 1Click returns the money if the swap fails: an address on the origin chain. */
  refundTo: string;
  /** The owner's NEAR account: where the USDC arrives. */
  recipient: string;
  /** ms, the page's clock: the request's own deadline is half an hour on. */
  now: number;
}

export interface IntentsQuote {
  depositAddress: string;
  depositMemo: string | null;
  /** USDC to send, in 1e-6 units. */
  amountIn: string;
  /** The least USDC on NEAR 1Click promises, in 1e-6 units. */
  minAmountOut: string;
  timeEstimateS: number | null;
  deadline: string | null;
}

export type IntentsStatus = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';
export const INTENTS_STATUSES: readonly IntentsStatus[] = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'];

export interface IntentsApi {
  quote(request: IntentsRequest): Promise<IntentsQuote>;
  status(depositAddress: string, depositMemo: string | null): Promise<IntentsStatus>;
}

/** The status in the owner's words, and whether it can still change. */
export function statusText(status: IntentsStatus): { text: string; final: boolean; tone: 'wait' | 'ok' | 'bad' } {
  switch (status) {
    case 'PENDING_DEPOSIT':
      return { text: 'Waiting for your deposit to arrive at that address.', final: false, tone: 'wait' };
    case 'KNOWN_DEPOSIT_TX':
      return { text: 'Your deposit was seen. Waiting for it to be confirmed.', final: false, tone: 'wait' };
    case 'PROCESSING':
      return { text: 'Moving your USDC to NEAR.', final: false, tone: 'wait' };
    case 'SUCCESS':
      return { text: 'Your USDC is on NEAR.', final: true, tone: 'ok' };
    case 'INCOMPLETE_DEPOSIT':
      return { text: 'Less than the quoted amount arrived. Send the rest to the same address, or wait for the refund.', final: false, tone: 'bad' };
    case 'REFUNDED':
      return { text: 'The transfer did not go through and 1Click sent your USDC back to your refund address.', final: true, tone: 'bad' };
    case 'FAILED':
      return { text: 'The transfer failed. Check your refund address for the return of your USDC.', final: true, tone: 'bad' };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** "250.5" → "250500000" (USDC has 6 decimals); null when it is not a positive amount with at most 6 decimals. */
export function usdcUnits(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  return units > 0n ? units : null;
}

/** USDC units as "250.5": no trailing zeros. */
export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** A balance for reading, as the rest of the page shows money: `1,050.00 USDC`. Cents are cut off, as in `dollars`. */
export const balanceText = (units: bigint): string => `${dollars(units).slice(1)} USDC`;

/** USDC units as money for reading: "$1,050.00". Cents are cut off, not rounded, so the page never shows more than the desk holds. */
export function dollars(units: bigint): string {
  const cents = units / 10_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** The body of `POST /v0/quote`: a live quote (it reserves a deposit address), exact input, delivered to the owner's account. */
export function quoteBody(request: IntentsRequest): object {
  const amount = usdcUnits(request.amountUsdc);
  if (amount === null) throw new Error('the amount is not a number of USDC');
  return {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    depositType: 'ORIGIN_CHAIN',
    refundType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(request.now + 30 * 60_000).toISOString(),
    originAsset: request.origin.asset,
    destinationAsset: NEAR_USDC_ASSET,
    amount: amount.toString(),
    refundTo: request.refundTo,
    recipient: request.recipient,
  };
}

/** Checks the answer of `POST /v0/quote`; throws with what is wrong, so the screen can say so. */
export function parseQuote(value: unknown): IntentsQuote {
  if (!isObject(value) || !isObject(value.quote)) throw new Error('1Click: no quote in the answer');
  const q = value.quote;
  const text = (name: string): string => {
    const v = q[name];
    if (typeof v !== 'string' || v === '') throw new Error(`1Click: the quote has no ${name}`);
    return v;
  };
  if (!/^\d+$/.test(text('amountIn')) || !/^\d+$/.test(text('minAmountOut'))) throw new Error('1Click: the quote amounts are not whole numbers');
  return {
    depositAddress: text('depositAddress'),
    depositMemo: typeof q.depositMemo === 'string' && q.depositMemo !== '' ? q.depositMemo : null,
    amountIn: text('amountIn'),
    minAmountOut: text('minAmountOut'),
    timeEstimateS: typeof q.timeEstimate === 'number' && Number.isFinite(q.timeEstimate) ? q.timeEstimate : null,
    deadline: typeof q.deadline === 'string' ? q.deadline : null,
  };
}

/** Checks the answer of `GET /v0/status`. */
export function parseStatus(value: unknown): IntentsStatus {
  const status = isObject(value) ? value.status : undefined;
  if (typeof status !== 'string' || !(INTENTS_STATUSES as readonly string[]).includes(status)) throw new Error('1Click: unknown status');
  return status as IntentsStatus;
}

/** The real 1Click, called from the browser (it answers cross-origin calls; there is no key in the page). */
export function oneClick(base = ONECLICK, fetcher: typeof fetch = fetch): IntentsApi {
  return {
    async quote(request) {
      const response = await fetcher(`${base}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(quoteBody(request)),
        signal: AbortSignal.timeout(20_000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`1Click refused the quote${isObject(body) && typeof body.message === 'string' ? `: ${body.message}` : ` (${response.status})`}`);
      return parseQuote(body);
    },
    async status(depositAddress, depositMemo) {
      const query = new URLSearchParams({ depositAddress });
      if (depositMemo !== null) query.set('depositMemo', depositMemo);
      const response = await fetcher(`${base}/status?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`1Click status: ${response.status}`);
      return parseStatus(await response.json());
    },
  };
}
