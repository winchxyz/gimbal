// The scanner's settings and their defaults. Every number here is either measured (with the date it was measured)
// or a stated assumption the owner can change; the strategy defaults are the engine rules a new desk starts with.

import type { ContractPolicy, Mode, StrategyConfig, VenueId } from '@gimbal/shared';
import type { FillFee, Place, TransferCosts } from './costs.ts';

export interface CostParams {
  /**
   * Hours a window is expected to be held: one-off costs (fills, slippage, basis, rescues) are spread over it, and a
   * desk window's expected spread (carry.ts) is counted over it. StrategyConfig has no hold of its own.
   */
  holdHours: number;
  /**
   * What the round trip of a desk window sets aside for the marks moving apart by the exit, bps of the leg, on top of
   * the adverse gap paid at entry (basisCostUsd).
   */
  basisBufferBps: number;
  /** Cost of one taker fill per desk venue. */
  fees: Record<VenueId, FillFee>;
  transfers: TransferCosts;
  /** Rescues expected per hold; each moves rescueAmountUsd from the reserve into the squeezed leg's venue. */
  rescuesPerHold: number;
  /** Where the rescue reserve sits, and where margin comes from and goes back to. */
  reserveAt: Place;
}

export interface ScannerConfig {
  costs: CostParams;
  /**
   * A watch-only leg whose open interest is under this many USD is not ranked; the smaller leg's open interest is the
   * capacity. Desk legs are held to deskMaxOiShare instead.
   */
  oiFloorUsd: number;
  /**
   * A desk leg may be at most this share of its market's open interest (USD); a larger one is shown on its multi-day
   * spread with a failing check, never entered. The book check at the leg size applies on top.
   */
  deskMaxOiShare: number;
  /** A leg whose mark (÷ multiplier) is further than this fraction from the median of the same base elsewhere is dropped. */
  maxMarkDeviation: number;
  /** Watch-only windows are many; at most this many (in rank order) are sent. Desk windows are never cut. */
  maxWatchWindows: number;
  /** What makes a watch-only window's leg a poor reference (quality.ts): a failing check, and a lower rank. */
  quality: QualityConfig;
  /** The contract's policy for the desk, as get_desk returns it; null until a desk exists (nothing can be entered). */
  policy: ContractPolicy | null;
  intervalMs: number;
  /** A desk venue's book is read again once it is this old (the held window's legs and the policy's markets). */
  bookTtlMs: number;
  /**
   * The same for a desk leg off the desk's policy (its windows cannot be entered, the book only prices them): read far
   * less often, so a venue's request budget (Phoenix: about 1 request a second) goes to the books that can trade.
   */
  offDeskBookTtlMs: number;
  bookDepth: number;
  /** A watch-only venue's funding is read again once its last answer is this old (desk venues: every scan). */
  watchIntervalMs: number;
  /** A funding read that takes longer than this counts as "did not answer" for this scan. */
  readTimeoutMs: number;
  /** The same for a book: longer, because Orderly's first book also opens its public WebSocket. */
  bookTimeoutMs: number;
  /** A venue that has not answered for this long drops out: its last good read is too old to show. */
  dropAfterMs: number;
  /** Public funding-history reads started per scan (7-day gross APR and window history); each is one market. */
  historyPerScan: number;
  /** A failed history read waits this long before it is tried again. */
  historyRetryMs: number;
}

/** A venue's funding cap and floor, fractions per hour (the floor < 0). */
export interface FundingLimit {
  capPerHour: number;
  floorPerHour: number;
}

/** One venue's funding limits: for every market, with exceptions by the venue's own symbol. */
export interface VenueFundingLimits {
  all: FundingLimit;
  bySymbol?: Readonly<Record<string, FundingLimit>>;
}

/** A stock exchange's regular session, Monday to Friday in its own time zone ("HH:MM", close excluded). */
export interface MarketSession {
  name: string;
  timeZone: string;
  open: string;
  close: string;
  /** Breaks inside the session, local "HH:MM" (end excluded): the market is shut for them like after the close. */
  breaks?: readonly { from: string; to: string }[];
}

export interface QualityConfig {
  /** A watch-window leg that traded less than this in 24 h is thin (where the venue publishes volume). */
  minVolume24hUsd: number;
  fundingLimits: Readonly<Record<string, VenueFundingLimits>>;
  /**
   * How a venue's own symbol says a market is a stock perp: the pattern captures the ticker, which must name the
   * leg's base ("4STOCK_USDT" on MEXC is a coin called 4STOCK, not stock number 4).
   */
  equityMarkers: Readonly<Record<string, RegExp>>;
  /** Venues that list traditional assets only (equities, indices, commodities, FX): their markets keep market hours. */
  traditionalVenues: readonly string[];
  /**
   * The bases on a traditional-only venue that are commodities, indices or FX: they keep futures hours
   * (traditionalWeekend). Every other base there is a stock or an ETF, and keeps its exchange's hours.
   */
  traditionalNonEquity: readonly string[];
  /** Each stock exchange's regular session, by a short code. */
  stockExchanges: Readonly<Record<string, MarketSession>>;
  /** The exchange of each stock listed outside New York, by base. */
  stockExchangeOf: Readonly<Record<string, string>>;
  /** The exchange whose hours every other stock keeps (New York: US shares, ADRs and ETFs). */
  defaultStockExchange: string;
  /** Other traditional assets (index, commodity and FX futures) shut from Friday `close` to Sunday `open`, local. */
  traditionalWeekend: { timeZone: string; close: string; open: string };
}

/**
 * Funding caps the scanner can source, for venues whose answer does not carry them. Each is the venue's own
 * statement; a market's own limits from its venue's answer (MarketFunding.fundingCapPerHour / fundingFloorPerHour)
 * come first, side by side, and this table only fills in. Left out, their readers pass each market's limits on: aster
 * (fundingInfo fundingFeeCap/Floor), okx (funding-rate max/minFundingRate), bitget (current-fund-rate
 * max/minFundingRate), gate (contracts funding_rate_limit), kucoin (contracts fundingRateCap/Floor), mexc
 * (funding_rate max/minFundingRate), extended (hourlyFundingRateCap), backpack (fundingRateUpper/LowerBound).
 * Left out, no cap found: binance and bybit (Hyperliquid's predictedFundings carries none), pacifica, paradex, dydx,
 * nado, aevo, variational, gmx-arbitrum, kraken, the hl-* HIP-3 dexes (set by each deployer), phoenix and orderly.
 * A rate several venues share to the digit is caught without a table (quality.ts).
 */
export const FUNDING_LIMITS: Readonly<Record<string, VenueFundingLimits>> = {
  // Hyperliquid docs, Trading > Funding: "Funding on Hyperliquid is capped at 4%/hour"; the cap "does not depend
  // on the asset".
  hyperliquid: { all: { capPerHour: 0.04, floorPerHour: -0.04 } },
  // Lighter docs, Trading > Funding: the BigClamp "limits funding payments to 4% per 8 hours, or 0.5% per hour",
  // "defaults, not universal values". The exceptions are orderBookDetails funding_clamp_big in the recorded sweep
  // (fixtures/watch-wire, 2026-10-31): ARC 20 % and RIVER 16 % per 8 h, the Korean equities 0.02 % per 8 h.
  lighter: {
    all: { capPerHour: 0.04 / 8, floorPerHour: -0.04 / 8 },
    bySymbol: {
      ARC: { capPerHour: 0.2 / 8, floorPerHour: -0.2 / 8 },
      RIVER: { capPerHour: 0.16 / 8, floorPerHour: -0.16 / 8 },
      ...Object.fromEntries(['SAMSUNG', 'HYUNDAI', 'HANMI', 'SKHYNIX', 'KRCOMP'].map((s) => [s, { capPerHour: 0.0002 / 8, floorPerHour: -0.0002 / 8 }])),
    },
  },
};

/**
 * The stock perps of the recorded sweep (2026-10-31) whose shares list outside New York, under the scanner's bases,
 * by exchange (each with its own exchange's ticker). Every other stock keeps New York hours: US shares, ADRs and
 * ETFs, and also the names with no exchange to follow or none sourced here: pre-IPO markets (ANT, SPCX, SHEIN,
 * CXMT, YMTC, UNITREE, JIO, POLYMARKET), MUFG and SONY (their ticker is also their New York ADR's), MELCO, KBLAM.
 */
const LISTED_OUTSIDE_NEW_YORK: Readonly<Record<string, readonly string[]>> = {
  // Samsung Electronics 005930 (SMSN on hl-xyz, same mark), Samsung Electro-Mechanics 009150, SK hynix 000660 (SKHX
  // on hl-xyz), Hyundai Motor 005380, Hanmi Semiconductor 042700, Hanwha Aerospace 012450, KB Financial 105560,
  // Naver 035420, SK Innovation 096770, SK Square 402340.
  KRX: ['SAMSUNG', 'SMSN', 'SAMSUNGEM', 'SKHYNIX', 'SKHX', 'HYUNDAI', 'HANMI', 'HANWHAAERO', 'KBFIN', 'NAVER', 'SKINNOV', 'SKSQUARE'],
  // Advantest 6857, Ajinomoto 2802, Disco 6146, Fanuc 6954, Fast Retailing 9983, Fujikura 5803, Furukawa Electric
  // 5801, Hitachi 6501, Ibiden 4062, Keyence 6861, Kioxia 285A, Kokusai Electric 6525, Lasertec 6920, MITSUBISHI (a
  // Mitsubishi group share; the listing does not say which, all trade in Tokyo), Murata 6981, NEC 6701, Nintendo
  // 7974, Panasonic 6752, Recruit 6098, Renesas 6723, Shin-Etsu 4063, SoftBank Group 9984, Sumitomo Electric 5802,
  // Taiyo Yuden 6976, Takeda 4502, Tokyo Electron 8035, Toyota 7203.
  TSE: [
    'ADVANTEST', 'AJINOMOTO', 'DISCO', 'FANUC', 'FASTRETAIL', 'FUJIKURA', 'FURUKAWA', 'HITACHI', 'IBIDEN', 'KEYENCE',
    'KIOXIA', 'KOKUSAI', 'LASERTEC', 'MITSUBISHI', 'MURATA', 'NEC', 'NINTENDO', 'PANASONIC', 'RECRUIT', 'RENESAS',
    'SHINETSU', 'SOFTBANK', 'SUMIELEC', 'TAIYOYUDEN', 'TAKEDA', 'TOKYOEL', 'TOYOTA',
  ],
  // Akeso 9926, Alibaba's Hong Kong line 9988 (BABA is its New York ADR), GenScript 1548, Innovent 1801, Kuaishou
  // 1024, Meituan 3690, MiniMax, Pop Mart 9992, SMIC 0981 (its 5.45 USD mark is the Hong Kong line's), Tencent 0700,
  // WuXi Biologics 2269, Xiaomi 1810, Zhipu (Knowledge Atlas).
  HKEX: ['AKESO', 'BABAHK', 'GENSCRIPT', 'INNOVENT', 'KUAISHOU', 'MEITUAN', 'MINIMAX', 'POPMART', 'SMIC', 'TENCENT', 'WUXIBIO', 'XIAOMI', 'ZHIPU'],
  // Alchip 3661, ASE Technology 3711 (ASX is its New York ADR), Asia Vital Components 3017, BizLink 3665, Delta
  // Electronics 2308, Elite Material 2383, GlobalWafers 6488 (TPEx), Gold Circuit 2368, Global Unichip 3443, Innolux
  // 3481, Kinsus 3189, Largan 3008, MediaTek 2454, Nan Ya PCB 8046, Nan Ya Plastics 1303, Nanya Technology 2408,
  // Powerchip 6770, TSMC 2330 (TSM is its New York ADR), Unimicron 3037, Winbond 2344, Yageo 2327, Zhen Ding 4958.
  TWSE: [
    'ALCHIP', 'ASE', 'AVC', 'BIZLINK', 'DELTAELEC', 'ELITEMAT', 'GLOBALWFR', 'GOLDCIR', 'GUC', 'INNOLUX', 'KINSUS',
    'LARGAN', 'MEDIATEK', 'NANYAPCB', 'NANYAPLST', 'NANYATECH', 'POWERCHIP', 'TSMC', 'UNIMICRON', 'WINBOND', 'YAGEO',
    'ZHENDING',
  ],
  // Cambricon 688256 (SSE STAR), GigaDevice 603986 (SSE), Zhongji Innolight 300308 (SZSE).
  SSE: ['CAMBRICON', 'GIGADEV', 'ZHONGJI'],
  // Reliance Industries.
  NSE: ['RELIANCE'],
};

export const DEFAULT_QUALITY: QualityConfig = {
  // The watch-unit audit of 2026-10-31: every leg it found too thin to trust (HMSTR on Hyperliquid, UNITREE on
  // hl-para, GTC and NIL on Aster) traded under 0.1M USD a day.
  minVolume24hUsd: 100_000,
  fundingLimits: FUNDING_LIMITS,
  // Each venue's naming of its stock perps, from its listing in the recorded sweep (2026-10-31).
  equityMarkers: {
    mexc: /^([A-Z0-9]+)STOCK_USDT$/,           // AAPLSTOCK_USDT
    bitget: /^([A-Z0-9]+)STOCKUSDT$/,          // ACNSTOCKUSDT
    extended: /^([A-Z0-9]+)_24_5-USD$/,        // AAPL_24_5-USD: traded 24 hours, 5 days a week
    backpack: /^([A-Z0-9]+)\.US_USDC_PERP$/,   // AAPL.US_USDC_PERP
  },
  // hl-xyz (trade.xyz) lists only equities, ETFs, indices, commodities and FX: all 120 of its markets in the
  // recorded sweep.
  traditionalVenues: ['hl-xyz'],
  // hl-xyz's commodities (Brent, WTI, natural gas, heating oil, copper, gold, silver, palladium, platinum), indices
  // (S&P 500, its own XYZ100, Nikkei 225, KOSPI 200, Nifty 50) and FX (EUR, GBP, JPY) in the recorded sweep, under
  // the scanner's bases. The rest of its listing is stocks and ETFs.
  traditionalNonEquity: [
    'BRENT', 'WTI', 'NATGAS', 'HO', 'COPPER', 'XAU', 'XAG', 'XPD', 'XPT',
    'SPX500', 'XYZ100', 'JP225', 'KR200', 'NIFTY',
    'EUR', 'GBP', 'JPY',
  ],
  // Each exchange's published regular session, with its lunch break where it has one: no price is set over lunch,
  // so a stock perp then drifts as it does after the close. KRX, TWSE and NSE trade straight through. Holidays are
  // not modelled.
  stockExchanges: {
    NYSE: { name: 'NYSE and Nasdaq (New York)', timeZone: 'America/New_York', open: '09:30', close: '16:00' },
    KRX: { name: 'KRX (Seoul)', timeZone: 'Asia/Seoul', open: '09:00', close: '15:30' },
    // Morning 09:00-11:30, afternoon 12:30-15:30 (the close moved from 15:00 on 5 Nov 2024).
    TSE: { name: 'the Tokyo Stock Exchange', timeZone: 'Asia/Tokyo', open: '09:00', close: '15:30', breaks: [{ from: '11:30', to: '12:30' }] },
    // Morning 09:30-12:00, afternoon 13:00-16:00.
    HKEX: { name: 'HKEX (Hong Kong)', timeZone: 'Asia/Hong_Kong', open: '09:30', close: '16:00', breaks: [{ from: '12:00', to: '13:00' }] },
    TWSE: { name: 'TWSE and TPEx (Taipei)', timeZone: 'Asia/Taipei', open: '09:00', close: '13:30' },
    // Morning 09:30-11:30, afternoon 13:00-15:00, the same on Shenzhen.
    SSE: { name: 'SSE and SZSE (Shanghai, Shenzhen)', timeZone: 'Asia/Shanghai', open: '09:30', close: '15:00', breaks: [{ from: '11:30', to: '13:00' }] },
    // IST is UTC+5:30 all year: 03:45-10:00 UTC.
    NSE: { name: 'NSE (Mumbai)', timeZone: 'Asia/Kolkata', open: '09:15', close: '15:30' },
  },
  stockExchangeOf: Object.fromEntries(Object.entries(LISTED_OUTSIDE_NEW_YORK).flatMap(([x, bases]) => bases.map((b) => [b, x]))),
  defaultStockExchange: 'NYSE',
  // CME Globex trades Sunday 18:00 to Friday 17:00 New York time; spot FX closes and opens about then too.
  traditionalWeekend: { timeZone: 'America/New_York', close: '17:00', open: '18:00' },
};

/** Orderly's own taker fee, before the broker's markup. */
const ORDERLY_BASE_TAKER_BPS = 3;

/**
 * The Orderly broker the desk trades under on each network, with its all-in trader fees (Orderly's base fee plus
 * the broker's markup). The scanner prices taker fills only; the maker fee is kept for the record.
 */
export const ORDERLY_BROKERS = {
  // Gimbal's own broker (gimbal_dex broker settings, 2026-10-31): maker 0 bps, taker 4 bps = Orderly's base 3 bps
  // plus Gimbal's 1 bp markup, the same for crypto and RWA perps.
  mainnet: { brokerId: 'gimbal_dex', makerBps: 0, takerBps: 4, markupBps: 1 },
  // The testnet broker. Its markup is not measured: the 1.5 bps assumed before gimbal_dex existed stands.
  testnet: { brokerId: 'woofi_dex', makerBps: null, takerBps: ORDERLY_BASE_TAKER_BPS + 1.5, markupBps: 1.5 },
} as const;

/** Costs on mainnet, and in replay, which plays recorded mainnet answers. */
export const MAINNET_COSTS: CostParams = {
  // A stated assumption: 10 days. The owner's engine rules carry no hold to take it from.
  holdHours: 240,
  // A stated assumption. Hyperliquid and Phoenix marks differed by 0.6 to 7.8 bps on 2026-11-03 (XLM, LTC, SOL, DOGE,
  // NEAR), so an exit can lose a few bps to the gap whatever it was at entry.
  basisBufferBps: 5,
  fees: {
    // Hyperliquid tier-0 taker 4.5 bps, plus the treasury builder fee on every order (FeeConfig.hl_builder_tenth_bps
    // 10 = 1 bp). The referral discount is not counted.
    hyperliquid: { takerBps: 4.5, extraBps: 1 },
    // Phoenix: 3.5 bps taker on every market (its market config, 2026-10-31).
    phoenix: { takerBps: 3.5, extraBps: 0 },
    // Orderly under gimbal_dex: 3 bps base taker plus the 1 bp markup (ORDERLY_BROKERS.mainnet).
    orderly: { takerBps: ORDERLY_BASE_TAKER_BPS, extraBps: ORDERLY_BROKERS.mainnet.markupBps },
  },
  transfers: {
    // Measured on mainnet 2026-10-27: Phoenix -> Hyperliquid 0.32 USD on 4 USD; Hyperliquid -> 1Click 0.21 USD. From
    // Arbitrum (Orderly) nothing is measured yet: the Solana figure stands in.
    oneClickFlatUsd: { solana: 0.32, hypercore: 0.21, arbitrum: 0.32 },
    oneClickBps: 20,             // no 1Click API key: +0.2 %
    hlActivationUsd: 1,
    orderlyWithdrawUsd: 1,
    orderlyMinDepositUsd: 6,
  },
  rescuesPerHold: 1,
  reserveAt: 'reserve',
};

/** Costs on testnet: the same, but Orderly under the testnet broker woofi_dex (ORDERLY_BROKERS.testnet). */
export const TESTNET_COSTS: CostParams = {
  ...MAINNET_COSTS,
  fees: { ...MAINNET_COSTS.fees, orderly: { takerBps: ORDERLY_BASE_TAKER_BPS, extraBps: ORDERLY_BROKERS.testnet.markupBps } },
};

/** The default is mainnet's: the scanner's live data is mainnet, and replay plays recorded mainnet answers. */
export const DEFAULT_COSTS: CostParams = MAINNET_COSTS;

export function costsFor(mode: Mode): CostParams {
  return mode === 'testnet' ? TESTNET_COSTS : MAINNET_COSTS;
}

/** DEFAULT_SCANNER_CONFIG with the costs of `mode`'s network. */
export function scannerConfigFor(mode: Mode): ScannerConfig {
  return { ...DEFAULT_SCANNER_CONFIG, costs: costsFor(mode) };
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  costs: DEFAULT_COSTS,
  oiFloorUsd: 500_000,
  // The owner's rule (2026-11-03): a desk leg at most 2 % of its market's open interest.
  deskMaxOiShare: 0.02,
  maxMarkDeviation: 0.1,
  maxWatchWindows: 150,
  quality: DEFAULT_QUALITY,
  policy: null,
  intervalMs: 5_000,
  bookTtlMs: 30_000,
  offDeskBookTtlMs: 5 * 60_000,
  bookDepth: 20,
  // Variational answered HTTP 429 to a 5 s poll on 2026-10-31.
  watchIntervalMs: 30_000,
  readTimeoutMs: 4_000,
  bookTimeoutMs: 8_000,
  dropAfterMs: 10 * 60_000,
  historyPerScan: 4,
  historyRetryMs: 60_000,
};

/** The engine rules a desk starts with. auto is off: the engine only watches until the owner turns it on. */
export const DEFAULT_STRATEGY: StrategyConfig = {
  auto: false,
  minNetAprPct: 5,
  legUsd: 1000,
  maxLeverage: 3,
  stopDrawdownPct: 10,
  rotate: { minGainPts: 3, forHours: 4 },
  risk: { watchDistancePct: 15, rescueDistancePct: 8 },
};

/**
 * Bounds PUT /strategy enforces on top of the policy. They are the engine's own sanity limits, not the contract's:
 * the contract caps every order at policy.max_notional_usd whatever the engine is told.
 */
export const STRATEGY_LIMITS = {
  // The smallest order the desk venues take: Hyperliquid refuses an order under $10 of value, Orderly's
  // min_notional is 10 USDC on its markets (orderly-wire fixture, 2026-10-31). A leg below it could never be
  // opened, and a tiny one turns every one-off cost into an APR of 1e13 or a null number.
  minLegUsd: 10,
  maxLegUsd: 100_000,
  maxLeverage: 10,
  maxMinNetAprPct: 1_000,
  maxRotateGainPts: 1_000,
  maxRotateHours: 24 * 30,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const between = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;

/**
 * Checks a StrategyConfig from PUT /strategy and returns a clean copy, or throws with the first thing wrong.
 * Unknown fields are refused, so a misspelt rule is never silently ignored; every number must be finite and inside
 * STRATEGY_LIMITS (and legUsd inside the policy's cap when one is loaded).
 */
export function parseStrategyConfig(value: unknown, policy: ContractPolicy | null = null): StrategyConfig {
  if (!isObject(value)) throw new Error('strategy: not an object');
  const known = ['auto', 'minNetAprPct', 'legUsd', 'maxLeverage', 'stopDrawdownPct', 'rotate', 'risk'];
  const extra = Object.keys(value).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new Error(`strategy: unknown field ${extra[0]}`);
  const { auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct, rotate, risk } = value;
  const L = STRATEGY_LIMITS;
  if (typeof auto !== 'boolean') throw new Error('strategy: auto must be a boolean');
  if (!between(minNetAprPct, 0, L.maxMinNetAprPct)) throw new Error(`strategy: minNetAprPct must be a number from 0 to ${L.maxMinNetAprPct}`);
  if (!between(legUsd, L.minLegUsd, L.maxLegUsd)) throw new Error(`strategy: legUsd must be a number from ${L.minLegUsd} to ${L.maxLegUsd}`);
  if (policy !== null && legUsd > policy.max_notional_usd) {
    throw new Error(`strategy: legUsd ${legUsd} is over the policy cap of ${policy.max_notional_usd} USD per leg`);
  }
  if (!between(maxLeverage, 1, L.maxLeverage)) throw new Error(`strategy: maxLeverage must be a number from 1 to ${L.maxLeverage}`);
  if (stopDrawdownPct !== null && (!isNum(stopDrawdownPct) || !(stopDrawdownPct > 0 && stopDrawdownPct <= 100))) {
    throw new Error('strategy: stopDrawdownPct must be null or a percentage in (0, 100]');
  }
  if (!isObject(rotate) || !between(rotate.minGainPts, 0, L.maxRotateGainPts) || !between(rotate.forHours, 0, L.maxRotateHours)) {
    throw new Error(`strategy: rotate needs minGainPts from 0 to ${L.maxRotateGainPts} and forHours from 0 to ${L.maxRotateHours}`);
  }
  const extraRotate = Object.keys(rotate).filter((k) => k !== 'minGainPts' && k !== 'forHours');
  if (extraRotate.length > 0) throw new Error(`strategy: unknown field rotate.${extraRotate[0]}`);
  if (!isObject(risk) || !isNum(risk.watchDistancePct) || !isNum(risk.rescueDistancePct)) {
    throw new Error('strategy: risk needs watchDistancePct and rescueDistancePct');
  }
  const extraRisk = Object.keys(risk).filter((k) => k !== 'watchDistancePct' && k !== 'rescueDistancePct');
  if (extraRisk.length > 0) throw new Error(`strategy: unknown field risk.${extraRisk[0]}`);
  if (!(risk.rescueDistancePct > 0 && risk.rescueDistancePct < risk.watchDistancePct && risk.watchDistancePct < 100)) {
    throw new Error('strategy: risk needs 0 < rescueDistancePct < watchDistancePct < 100');
  }
  return {
    auto, minNetAprPct, legUsd, maxLeverage, stopDrawdownPct,
    rotate: { minGainPts: rotate.minGainPts, forHours: rotate.forHours },
    risk: { watchDistancePct: risk.watchDistancePct, rescueDistancePct: risk.rescueDistancePct },
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Checks a ContractPolicy read from a file (the desk's policy as get_desk returns it) with the shape its type
 * implies, and returns a clean copy; throws with the first thing wrong. A policy without `unpriced` has none.
 */
export function parseContractPolicy(value: unknown): ContractPolicy {
  if (!isObject(value)) throw new Error('policy: not an object');
  const list = (name: string): unknown[] => {
    const v = value[name];
    if (!Array.isArray(v)) throw new Error(`policy: ${name} must be a list`);
    return v;
  };
  const num = (name: string, positive = false): number => {
    const v = value[name];
    if (!isNum(v) || !(positive ? v > 0 : v >= 0)) throw new Error(`policy: ${name} must be a number ${positive ? '> 0' : '>= 0'}`);
    return v;
  };
  const hl_assets = list('hl_assets').map((a, i) => {
    if (!isObject(a) || !isInt(a.index) || !isStr(a.symbol) || !isInt(a.sz_decimals)) {
      throw new Error(`policy: hl_assets[${i}] needs index, symbol and sz_decimals`);
    }
    return { index: a.index, symbol: a.symbol, sz_decimals: a.sz_decimals };
  });
  const phoenix_markets = list('phoenix_markets').map((m, i) => {
    if (!isObject(m) || !isStr(m.symbol) || !isStr(m.orderbook) || !isInt(m.base_lot_e8) || !isInt(m.tick_e8)) {
      throw new Error(`policy: phoenix_markets[${i}] needs symbol, orderbook, base_lot_e8 and tick_e8`);
    }
    return { symbol: m.symbol, orderbook: m.orderbook, base_lot_e8: m.base_lot_e8, tick_e8: m.tick_e8 };
  });
  const orderly_symbols = list('orderly_symbols').map((s, i) => {
    if (!isStr(s)) throw new Error(`policy: orderly_symbols[${i}] must be a symbol`);
    return s;
  });
  const unpricedRaw = value.unpriced === undefined ? [] : list('unpriced');
  const unpriced = unpricedRaw.map((u, i) => {
    if (!isObject(u) || !isStr(u.symbol) || typeof u.max_sz !== 'string' || !DECIMAL.test(u.max_sz)) {
      throw new Error(`policy: unpriced[${i}] needs symbol and max_sz as a decimal string`);
    }
    return { symbol: u.symbol, max_sz: u.max_sz };
  });
  return {
    hl_assets, phoenix_markets, orderly_symbols,
    max_notional_usd: num('max_notional_usd', true),
    price_band_bps: num('price_band_bps'),
    oracle_max_age_s: num('oracle_max_age_s', true),
    rescue_cap_usd_per_hour: num('rescue_cap_usd_per_hour'),
    unpriced,
    unpriced_max_notional_usd: value.unpriced_max_notional_usd === undefined && unpriced.length === 0 ? 0 : num('unpriced_max_notional_usd'),
    max_transfer_cost_bps: num('max_transfer_cost_bps'),
    max_transfer_cost_flat_e6: num('max_transfer_cost_flat_e6'),
  };
}
