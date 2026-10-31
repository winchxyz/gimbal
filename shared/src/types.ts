// Mirrors docs/interfaces.md section 2 (engine <-> web). Change both, and the Rust types,
// in the same PR.

export type VenueId = 'hyperliquid' | 'phoenix' | 'orderly';   // the venues a desk can trade
export type ScanVenueId = string;   // any venue the scanner reads: the 3 above plus the watch-only ones (33 ids in all)
export type Mode = 'replay' | 'testnet' | 'mainnet';

export interface FundingRate {
  venue: ScanVenueId; symbol: string;
  ratePerHour: number;            // fraction per hour; > 0 means longs pay shorts
  settlement: 'hourly' | '2h' | '4h' | '8h' | 'daily' | 'continuous';
                                  // HL hourly; Phoenix accrues hourly, settles daily; Orderly 8 h (4 h on some symbols);
                                  // continuous = accrues every block (GMX v2, Paradex)
  nextAt: number;                 // ms; for continuous funding, the time of the read
}

export interface Window {
  id: string; symbol: string; longVenue: ScanVenueId; shortVenue: ScanVenueId;
  grossAprPct: number;
  grossApr7dPct: number | null;   // over the last 7 days; null until the history is loaded
  costs: { feesPct: number; slippagePct: number; basisPct: number; rescueReservePct: number };
                                  // feesPct: venue fees on four fills plus the 1Click fees to move both legs' margin
                                  // in and out while the desk holds none there; basisPct includes the timing loss
                                  // when the legs settle on different schedules
  netAprPct: number; usdPerDayPer1k: number; breakevenHours: number; depthUsd: number;
  intervalsAbove: number; updatedAt: number;
  tradable: boolean;              // both legs are VenueIds, so a desk could trade it; false = watch only. Structural
                                  // only: policy, oracle and desk reasons go in `refused`, never here
  veto?: { verdict: 'pass' | 'veto'; reasons: string[]; model: string; at: number };   // NEAR AI, can only refuse
  refused?: { code: string; reason: string };   // tradable, but it cannot be entered now: the contract would refuse
                                                // it (E_ORACLE_STALE, E_ASSET, E_SIZE) or no desk exists (E_NO_DESK)
  held: { since: number } | null;   // the desk holds this window now
  checks: { ok: boolean; text: string }[];   // what the engine checked (policy, oracle, rescue path), one line
                                             // each, engine-written; the first failing one is why it is not entered
  switchCostUsd: number | null;     // cost to rotate from the held window into this one at strategy.legUsd;
                                    // null when nothing is held or this is the held one
  stale: boolean;                   // a venue it needs did not answer: the numbers are from the last good read
}

export interface WindowHistory {   // GET /windows/history?id=<window id>: hourly net APR, oldest first
  windowId: string;
  points: { t: number; netAprPct: number }[];   // one per hour, up to 168 (7 days)
}

export interface ScanStatus {      // one per scan, next to the windows it produced
  venues: number;                  // venues the scanner read
  failed: ScanVenueId[];           // venues that did not answer this time
  at: number;                      // ms
}

export interface ContractPolicy {  // the contract's Policy (§1.2), same snake_case fields: passed as is to set_policy
  hl_assets: { index: number; symbol: string; sz_decimals: number }[];
  phoenix_markets: { symbol: string; orderbook: string; base_lot_e8: number; tick_e8: number }[];
  orderly_symbols: string[];
  max_notional_usd: number; price_band_bps: number; oracle_max_age_s: number;
  rescue_cap_usd_per_hour: number;
  unpriced: { symbol: string; max_sz: string }[];   // no oracle price: max_sz caps the size in base units (canonical decimal)
  unpriced_max_notional_usd: number;
  max_transfer_cost_bps: number; max_transfer_cost_flat_e6: number;
}

export interface StrategyConfig {  // engine rules, off-chain: the contract never sees or enforces them
  auto: boolean;                   // the engine enters, exits and rotates by itself; false = it only watches,
                                   // rescues and journals, and the owner acts by hand (POST /rotate, /close)
  minNetAprPct: number;            // "your minimum": enter only above this net APR
  legUsd: number;                  // notional per leg the engine opens (≤ policy.max_notional_usd)
  maxLeverage: number;             // leverage target per leg
  stopDrawdownPct: number | null;  // close both legs when the desk's drawdown reaches this
  rotate: { minGainPts: number; forHours: number };   // rotate when another window beats the held one by at
                                                      // least minGainPts of net APR for forHours in a row
  risk: { watchDistancePct: number; rescueDistancePct: number };   // a leg closer to liquidation than these
                                                      // percentages is watch / rescue (defaults 15 and 8)
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
        | 'orderly_receiver_lookup' | 'orderly_referral_bind' | 'phoenix_register' | 'phoenix_referral';
    status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
    detail?: string; tx: TxRef[];
  }[];
}

// Money is signed USD: income positive, costs negative (fees are ≤ 0).
export interface Leg {
  venue: VenueId; symbol: string; side: 'long' | 'short';
  size: number;                   // base units, always positive; side gives the direction
  lotSize: number;                // base units per lot on this venue (Phoenix base lot, HL 10^-szDecimals)
  entry: number; mark: number; liqPx: number | null;   // USD per base unit
  marginUsd: number;              // margin held for this leg on its venue
  marginRatio: number;            // maintenance margin ÷ margin, a fraction: 0.31 = 31 %, 1 = liquidation
  distanceToLiqPct: number | null;   // how far mark must move to reach liqPx, in percent: 32.6 = 32.6 %
  fundingEarnedUsd: number; unsettledFundingUsd: number;
  feesUsd: number;                // trading fees paid on this leg since it opened (≤ 0)
  unpriced: boolean;              // opened under policy.unpriced: no oracle price band
}

export interface DeskState {
  deskId: string; owner: string; contract: string; mode: Mode;
  legs: Leg[];
  netDelta: number;               // base units, long minus short; 0 when level
  equityUsd: number;              // the desk value: margin on every venue + reserve + open P&L
  reserveUsd: number;             // the part of equityUsd held back for rescues
  pnl: { fundingUsd: number; feesUsd: number; priceUsd: number; netUsd: number };
  health: 'level' | 'watch' | 'rescue';
  paused: { by: string; at: number } | null;   // set_paused / panic_close: the NEAR account that paused, ms; null = running
  rescueFailure: RescueFailure | null;         // a rescue failed and the owner must act; cleared once margin is safe again
  updatedAt: number;
}

// The status line reads, first match wins: rescueFailure → Needs you, a leg's venue down in HealthMap →
// "<venue> not answering", paused → Paused, health rescue → Rescuing, health watch → Watch, no legs → Waiting,
// else Level.
export interface RescueFailure {
  rescueId: string;
  step: Exclude<RescueProgress['step'], 'landed' | 'failed'>;   // the step that failed
  reason: string;                 // one line: why it failed
  tries: number;
  next: string;                   // one line: what the desk tries next, or that only the owner can act now
  at: number;                     // ms
}

export interface TxRef { chain: 'near' | 'hyperliquid' | 'solana' | 'arbitrum'; id: string; url: string }

export interface JournalEntry {
  id: string; t: number;
  kind: 'window' | 'enter' | 'exit' | 'rotate' | 'rescue' | 'refused' | 'veto' | 'adl' | 'error' | 'funding'
      | 'deposit' | 'withdraw' | 'fee';
  summary: string;                // one line, written by the engine
  why?: string;                   // optional plain-language reason from NEAR AI; never used for decisions
  // Keys the web reads; numbers may come as decimal strings ("1050.00"). Every key is optional.
  //   usd                     the signed money effect in USD (income > 0, cost < 0)
  //   feeUsd                  a fee on top of `usd`, ≤ 0
  //   unpriced, venue         1 or "true" when an order went out without the oracle price band, and on which venue
  //   from, signedS, landedS  on a rescue: "reserve" or the venue id the margin came from, then the seconds the
  //                           MPC signature and the landing took
  numbers: Record<string, number | string>;
  tx: TxRef[];
}

export interface RescueProgress {
  id: string; from: VenueId | 'reserve'; to: VenueId; amountUsd: number;
  step: 'detect' | 'source' | 'quote' | 'verify' | 'sign' | 'deposit' | 'landed' | 'failed';
  startedAt: number; elapsedS: number; tx: TxRef[];
}

export type HealthMap = Record<VenueId | 'intents' | 'near', 'ok' | 'slow' | 'down'>;

export type StreamEvent =
  | { type: 'windows'; data: Window[] }
  | { type: 'scan'; data: ScanStatus }
  | { type: 'desk'; data: DeskState }
  | { type: 'journal'; data: JournalEntry }
  | { type: 'rescue'; data: RescueProgress }
  | { type: 'setup'; data: SetupProgress }
  | { type: 'health'; data: HealthMap };

// GET /state: the latest value of each StreamEvent type, so a client that (re)connects draws at once and
// then applies /events on top. null = the engine has not produced that type yet.
export interface EngineState {
  mode: Mode;
  windows: Window[] | null;
  scan: ScanStatus | null;
  strategy: StrategyConfig | null;   // as GET /strategy returns it
  desk: DeskState | null;
  journal: JournalEntry[];        // the most recent entries, newest first, at most 100; older: GET /journal?before=<id>
  rescue: RescueProgress | null;  // the running rescue, else the last one
  setup: SetupProgress | null;
  health: HealthMap | null;
  at: number;                     // ms, when the engine built the response
}
