// Mirrors docs/interfaces.md section 2 (engine <-> web). Change both, and the Rust types,
// in the same PR.

export type VenueId = 'hyperliquid' | 'phoenix' | 'orderly';   // the venues a desk can trade
export type ScanVenueId = string;   // any venue the scanner reads (the 3 above plus the watch-only ones, 32 in all)
export type Mode = 'replay' | 'testnet' | 'mainnet';

export interface FundingRate {
  venue: ScanVenueId; symbol: string;
  ratePerHour: number;            // fraction per hour; > 0 means longs pay shorts
  settlement: 'hourly' | '4h' | '8h' | 'daily'; // HL hourly; Phoenix accrues hourly, settles daily; Orderly 8 h (4 h on some symbols)
  nextAt: number;                 // ms
}

export interface Window {
  id: string; symbol: string; longVenue: ScanVenueId; shortVenue: ScanVenueId;
  grossAprPct: number;
  grossApr7dPct: number | null;   // over the last 7 days; null until the history is loaded
  costs: { feesPct: number; slippagePct: number; basisPct: number; rescueReservePct: number };
  netAprPct: number; usdPerDayPer1k: number; breakevenHours: number; depthUsd: number;
  intervalsAbove: number; updatedAt: number;
  tradable: boolean;              // true only if both legs are VenueIds and the symbol has an oracle price
                                  // (or is in policy.unpriced); false = watch only
  veto?: { verdict: 'pass' | 'veto'; reasons: string[]; model: string; at: number };   // NEAR AI, can only refuse
}

export interface ContractPolicy {  // the contract's Policy (§1.2), same snake_case fields: passed as is to set_policy
  hl_assets: { index: number; symbol: string; sz_decimals: number }[];
  phoenix_markets: { symbol: string; orderbook: string; base_lot_e8: number; tick_e8: number }[];
  orderly_symbols: string[];
  max_notional_usd: number; price_band_bps: number; oracle_max_age_s: number;
  rescue_cap_usd_per_hour: number; unpriced: string[]; unpriced_max_notional_usd: number;
  max_transfer_cost_bps: number; max_transfer_cost_flat_e6: number;
}

export interface StrategyConfig {  // engine rules, off-chain: the contract never sees or enforces them
  maxLeverage: number;             // leverage target per leg
  stopDrawdownPct: number | null;  // close both legs when the desk's drawdown reaches this
}

export interface PolicyDraft {     // NEAR AI turns the owner's words into this; the owner edits and confirms
  policy: ContractPolicy;          // shown as "enforced by the contract"; becomes real only through set_policy
  strategy: StrategyConfig;        // shown as "engine rules"; saved with PUT /strategy
  notes: string[];                 // what the model could not map
  model: string;
}

export interface SetupProgress {   // venue setup the engine runs through operator methods after create_desk
  deskId: string;
  steps: {
    step: 'hl_set_referrer' | 'hl_approve_builder_fee' | 'orderly_register' | 'orderly_add_key'
        | 'orderly_receiver_lookup' | 'orderly_referral_bind' | 'phoenix_login' | 'phoenix_invite' | 'phoenix_register';
    status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
    detail?: string; tx: TxRef[];
  }[];
}

export interface Leg {
  venue: VenueId; symbol: string; side: 'long' | 'short'; size: number;
  entry: number; mark: number; liqPx: number | null;
  marginUsd: number; marginRatio: number; distanceToLiqPct: number | null;
  fundingEarnedUsd: number; unsettledFundingUsd: number;
  unpriced: boolean;              // opened under policy.unpriced: no oracle price band
}

export interface DeskState {
  deskId: string; owner: string; contract: string; mode: Mode;
  legs: Leg[]; netDelta: number; equityUsd: number; reserveUsd: number;
  pnl: { fundingUsd: number; feesUsd: number; priceUsd: number; netUsd: number };
  health: 'level' | 'watch' | 'rescue';
  updatedAt: number;
}

export interface TxRef { chain: 'near' | 'hyperliquid' | 'solana' | 'arbitrum'; id: string; url: string }

export interface JournalEntry {
  id: string; t: number;
  kind: 'window' | 'enter' | 'exit' | 'rotate' | 'rescue' | 'refused' | 'veto' | 'adl' | 'error' | 'funding'
      | 'deposit' | 'withdraw' | 'fee';
  summary: string;                // one line, written by the engine
  why?: string;                   // optional plain-language reason from NEAR AI; never used for decisions
  numbers: Record<string, number | string>;
  tx: TxRef[];
}

export interface RescueProgress {
  id: string; from: VenueId | 'reserve'; to: VenueId; amountUsd: number;
  step: 'detect' | 'source' | 'quote' | 'verify' | 'sign' | 'deposit' | 'landed' | 'failed';
  startedAt: number; elapsedS: number; tx: TxRef[];
}

export type StreamEvent =
  | { type: 'windows'; data: Window[] }
  | { type: 'desk'; data: DeskState }
  | { type: 'journal'; data: JournalEntry }
  | { type: 'rescue'; data: RescueProgress }
  | { type: 'setup'; data: SetupProgress }
  | { type: 'health'; data: Record<VenueId | 'intents' | 'near', 'ok' | 'slow' | 'down'> };
