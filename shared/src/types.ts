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
  // Each figure's basis. "This hour": the live rates. "Multi-day": a desk window with its 7 days in, on the smaller of
  // its 7- and 14-day means when they agree in sign, else (the week before loading, the two disagreeing, or no 14
  // days to be had) on its 7 days. "Today's": books and fees now.
  grossAprPct: number;            // this hour
  grossApr7dPct: number | null;   // the last 168 complete hours; null until the history is loaded
  costs: { feesPct: number; slippagePct: number; basisPct: number; rescueReservePct: number };
                                  // today's one-off costs, spread over the hold as APR points. A desk window on the
                                  // multi-day basis: the round trip the gate uses, feesPct the four fills, basisPct
                                  // the basis buffer (adverse mark gap, timing loss, buffer bps), rescueReservePct 0;
                                  // its margin moves and rescue reserve are shown apart, in its checks. Otherwise
                                  // feesPct also has the 1Click fees to move both legs' margin in and out, and
                                  // basisPct the mark gap and timing loss
  netAprPct: number;              // multi-day gross minus costs on a desk window with its 7 days in: the net the gate
                                  // holds to minNetAprPct, once both weeks agree; else this hour's gross minus costs
                                  // (watch windows always). What the list ranks by, the minimum line and the rotation
                                  // gap
  usdPerDayPer1k: number;         // netAprPct as USD a day per 1k a leg: the same basis
  breakevenHours: number;         // multi-day once both weeks are judged: hours of that spread paying the round trip;
                                  // else at this hour's rates, transfers included
  depthUsd: number;               // the smaller leg's open interest now
  intervalsAbove: number;         // hourly: hours in a row whose own gross minus today's costs cleared minNetAprPct
  updatedAt: number;
  tradable: boolean;              // both legs are VenueIds, so a desk could trade it; false = watch only. Structural
                                  // only: policy, oracle and desk reasons go in `refused`, never here
  veto?: { verdict: 'pass' | 'veto'; reasons: string[]; model: string; at: number };   // NEAR AI, can only refuse
  refused?: { code: string; reason: string };   // tradable, but it cannot be entered now: the contract would refuse
                                                // it (E_ORACLE_STALE, E_ASSET, E_SIZE) or no desk exists (E_NO_DESK)
  note?: string;                    // not a refusal: what the desk will do at open for an enterable window, shown on
                                    // the row ("stored ETH price stale: refreshed at open", a trading serve only)
  held: { since: number } | null;   // the desk holds this window now
  checks: { ok: boolean; text: string }[];   // what the engine checked (policy, oracle, rescue path, the carry
                                             // gate on the multi-day spread), one line each, engine-written; the
                                             // first failing one is why it is not entered. Enterable = tradable, not
                                             // refused, not stale, every check ok, no veto
  switchCostUsd: number | null;     // cost to rotate from the held window into this one at strategy.legUsd:
                                    // the fills that change, plus moving margin onto this window's venues and
                                    // back (a desk window's net APR with its 7 days in leaves those moves out);
                                    // null when nothing is held or this is the held one
  stale: boolean;                   // a venue it needs did not answer: the numbers are from the last good read
}

export interface WindowHistory {   // GET /windows/history?id=<window id>: hourly net APR, oldest first
  windowId: string;
  points: { t: number; netAprPct: number }[];   // one per hour, up to 168 (7 days): each hour's own gross minus
                                                // today's costs, the last one this hour's (so it can differ from
                                                // Window.netAprPct, which is multi-day once known)
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
  max_hourly_notional_usd?: number;   // rolling-hour cap on orders that are not reduce-only; absent = 15 × max_notional_usd
}

export interface StrategyConfig {  // engine rules, off-chain: the contract never sees or enforces them
  auto: boolean;                   // the engine enters, exits and rotates by itself; false = it only watches,
                                   // rescues and journals, and the owner acts by hand (POST /rotate, /close)
  minNetAprPct: number;            // "your minimum": enter only above this net APR. The engine's carry gate
                                   // holds a desk window's multi-day spread over the hold, net of the round trip,
                                   // to it: the same number as Window.netAprPct, which the web's minimum line uses
  legUsd: number;                  // notional per leg the engine opens (≤ policy.max_notional_usd)
  maxLeverage: number;             // leverage target per leg
  stopDrawdownPct: number | null;  // close both legs when the desk's drawdown reaches this
  rotate: { minGainPts: number; forHours: number };   // rotate when another window beats the held one by at
                                                      // least minGainPts of net APR for forHours in a row. Net
                                                      // APR is Window.netAprPct, multi-day once known for both, so
                                                      // one hour's swing cannot rotate the held window out; the
                                                      // hours are counted on it scan by scan, not intervalsAbove
  risk: { watchDistancePct: number; rescueDistancePct: number };   // a leg closer to liquidation than these
                                                      // percentages is watch / rescue (defaults 15 and 8)
  enterAfterChecks: number;        // hourly checks in a row a window must pass the entry rules before entry
                                   // (whole, 1..24; default 3). A saved config without it reads as the default
  exitAfterChecks: number;         // hourly checks in a row of compression or a flipped spread before a counted
                                   // exit (whole, 1..24; default 6, docs/backtest-checks.md). PUT /strategy
                                   // answers 400 for a value that is not a whole number in 1..24. A change never
                                   // resets a count in progress: the counts are compared with the new number
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
        | 'orderly_receiver_lookup' | 'orderly_referral_bind' | 'orderly_ip_restriction'   // skipped without an IP list
        | 'phoenix_register' | 'phoenix_referral';
    status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
    detail?: string; tx: TxRef[];
  }[];
}

// Money is signed USD: income positive, costs negative (fees are < 0 a cost, > 0 a maker rebate).
export interface Leg {
  venue: VenueId; symbol: string; side: 'long' | 'short';
  size: number;                   // base units, always positive; side gives the direction
  lotSize: number;                // base units per lot on this venue (Phoenix base lot, HL 10^-szDecimals)
  entry: number; mark: number; liqPx: number | null;   // USD per base unit
  marginUsd: number;              // margin held for this leg on its venue
  marginRatio: number;            // maintenance margin ÷ margin, a fraction: 0.31 = 31 %, 1 = liquidation
  distanceToLiqPct: number | null;   // how far mark must move to reach liqPx, in percent: 32.6 = 32.6 %
  fundingEarnedUsd: number; unsettledFundingUsd: number;
  feesUsd: number;                // trading fees on this leg since it opened (< 0 a cost, > 0 a maker rebate); live:
                                  // what the engine's position book booked for the open position's fills, 0 when it
                                  // booked none
  feesPositionId?: string;        // live: the book position those fees are of (a late-read fill fee's `fee` journal
                                  // entry names it: the Journal does not count that entry again while a leg names it)
  unpriced: boolean;              // opened under policy.unpriced: no oracle price band
}

export interface DeskState {
  deskId: string; owner: string; contract: string; mode: Mode;
  legs: Leg[];
  netDelta: number;               // base units, long minus short; 0 when level
  equityUsd: number;              // the desk value: reserve + the equity (with open P&L) of every venue account in
                                  // `accounts` that has been read, with or without a position; one not read yet adds 0
  reserveUsd: number;             // the part of equityUsd held back for rescues
  pnl: { fundingUsd: number; feesUsd: number; priceUsd: number; netUsd: number };
  health: 'level' | 'watch' | 'rescue';
  paused: { by: string; at: number } | null;   // set_paused / panic_close: the NEAR account that paused, ms; null = running
  rescueFailure: RescueFailure | null;         // a rescue failed and the owner must act; cleared once margin is safe again
  updatedAt: number;
  accounts?: VenueAccount[];      // every venue account the engine reads for this desk, read or not; absent from an
                                  // engine that does not list them (equityUsd then cannot say what it left out)
}

// One venue account of the desk as the engine last read it. A read that fails keeps the last value (and its `at`).
export interface VenueAccount {
  venue: VenueId;
  equityUsd: number | null;       // account value with open P&L; null: not read since the engine started
  at: number | null;              // ms, when equityUsd was read; null with it
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
      | 'deposit' | 'withdraw' | 'fee' | 'wait';   // wait: the strategy's reason not to act changed
  summary: string;                // one line, written by the engine
  why?: string;                   // optional plain-language reason from NEAR AI; never used for decisions
  // Keys the web reads; numbers may come as decimal strings ("1050.00"). Every key is optional.
  //   usd                     the signed money effect in USD (income > 0, cost < 0)
  //   feeUsd                  a fee on top of `usd`, ≤ 0
  //   unpriced, venue         1 or "true" when an order went out without the oracle price band, and on which venue
  //   from, signedS, landedS  on a rescue: "reserve" or the venue id the margin came from, then the seconds the
  //                           MPC signature and the landing took
  //   fillFee, position, stage  on a `fee` for a fill's fee read from the venue later: 1, the book position, and
  //                           'enter' | 'fill' | 'exit'; counted under fees, but not while a desk leg on its `venue`
  //                           names that position (Leg.feesPositionId: the desk's P&L already holds it)
  numbers: Record<string, number | string>;
  tx: TxRef[];
}

export interface RescueProgress {
  // amountUsd: at `detect` what the leg needs; from `source` on what the planned transfer sends (a capped or
  // fixed-size move can be less than the need); at `landed` what reached the margin after 1Click's fees.
  // sentUsd: what the planned transfer sends, from `source` on and still at `landed` (the quote row keeps it).
  id: string; from: VenueId | 'reserve'; to: VenueId; amountUsd: number; sentUsd?: number;
  step: 'detect' | 'source' | 'quote' | 'verify' | 'sign' | 'deposit' | 'landed' | 'failed';
  startedAt: number; elapsedS: number; tx: TxRef[];
}

export type HealthMap = Record<VenueId | 'intents' | 'near', 'ok' | 'slow' | 'down'>;

// The strategy loop's latest decision (engine/src/strategy/): the web's decision line. Published when it changes.
export interface StrategyDecision {
  action: 'off' | 'wait' | 'enter' | 'hold' | 'exit' | 'rotate';   // off: auto false or GIMBAL_TRADE not 1
  reason: string;                 // one line, engine-written, with the numbers ("XLM 14.2 % net, 2 of 3 hours above 10 %")
  windowId: string | null;        // the window entered, rotated into or waited for
  heldId: string | null;          // the window the desk holds, if any
  at: number;                     // ms
  // The act the loop is carrying out now ("enter mon-phoenix-hyperliquid", "POST /rotate <id> (owner demo entry, at
  // most $1.00)", "POST /close"), or null when none runs: POST /rotate and POST /close are refused (409) meanwhile.
  // Published again when it starts and ends. Absent: an engine from before it.
  acting?: string | null;
}

export type StreamEvent =
  | { type: 'windows'; data: Window[] }
  | { type: 'scan'; data: ScanStatus }
  | { type: 'desk'; data: DeskState }
  | { type: 'journal'; data: JournalEntry }
  | { type: 'rescue'; data: RescueProgress }
  | { type: 'setup'; data: SetupProgress }
  | { type: 'health'; data: HealthMap }
  | { type: 'decision'; data: StrategyDecision };

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
  decision: StrategyDecision | null;
  at: number;                     // ms, when the engine built the response
}
