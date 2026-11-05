# Backtest: the strategy loop's entry and exit check counts

The strategy loop (`engine/src/strategy/decide.ts`) enters a window only after it passes the entry rules on
`enterAfterChecks` hourly checks in a row, and leaves a held pair after `exitAfterChecks` hourly checks in a row of
compression or a flipped spread. Both were 3 (engine constants) when this ran. This backtest measures what each pair of
counts from 1 to 4 nets in USD on real funding history, with the engine's own scanner, gate and cost model. The
[decision](#decision) it led to: enter 3, exit 6, now owner settings in `StrategyConfig`.

```bash
npm run backtest:checks                                    # every scope, 12 and 1000 USD a leg, enter and exit 1..4
npm run backtest:checks -- --scope live --leg-usd 12       # one scope and leg size
npm run backtest:checks -- --enter 1,3 --exit 5,6,8,12,24  # other counts
npm run backtest:checks -- --no-fetch --json results.json  # cache only; every trade as JSON
```

Public reads only: no keys, no account, nothing signed, no `.env`. The first run reads each policy leg's funding
history and one snapshot of today's markets, books, marks and open interest (Phoenix at most 0.77 requests a second,
Hyperliquid one per 1.2 s, a 429 waited out), and caches them in `engine/.cache/backtest-checks/` (gitignored). A
rerun reads nothing. A full run takes about an hour on one core; each scope and leg size can run in its own process.

## Method

- **Data.** Hourly funding history of the policy markets (`tools/mainnet-final-policy.json`: BTC, ETH, SOL, DOGE,
  LTC, XLM, ZEC on Hyperliquid and Phoenix; the same but XLM on Orderly), read through the engine's own venue readers
  (`marketFundingHistory`), and one snapshot of today's funding rows, `markets()` and 20-level books.
- **Venues at a past hour** (`src/backtest/checks-sim.ts`, `HistoryVenue`). At the virtual time `t`, each venue's
  `funding()` answers today's row with the rate of the last print booked at or before `t` (the hour that just ended:
  what Phoenix's own `funding()` reports, and no lookahead), and its history read returns prints up to `t` only.
  Books, marks, open interest and lots are today's.
- **The real scanner.** `Scanner` runs with the mainnet costs (`MAINNET_COSTS`: taker fees with the Hyperliquid
  builder fee, slippage on the books at the leg size, the basis buffer of adverse mark gap + timing loss + 10 bps,
  spread over the assumed 168 h hold: the round trip and hold the pair trader's open is held to, `deskRoundTrip`.
  The "Results on the one round trip" grid below is on these; every section after it was run before 2026-11-04 on
  5 bps over 240 h, a hurdle the trader's open never applied), the desk policy, the 2 % open-interest cap, the 7- and 14-day multi-day gate
  and its ranking. The contract's oracle prices count as fresh (serve refreshes them at the open). The margin sits on
  the desk's venues: no 1Click move is priced.
- **The real decide().** Every hour: two scans (the first loads that hour's history, the second is priced on it, as
  the live scanner has its history long before the hourly check at +60 s), then one hourly `decide()` with the live
  engine rules `{"minNetAprPct":5,"legUsd":12,"maxLeverage":3,"stopDrawdownPct":10,"rotate":{"minGainPts":3,"forHours":4}}`,
  `auto` on, and LOOP_RULES as they are (cooldown 6 h, time stop 14 d, at most 2 rotations a day, the 1.5x no-rescue
  leverage cap) except the two counts, which `DecideInput.rules` sets (serve never passes it). Lots are the venues'
  `Market.lotSize` at the mean of today's marks, so a leg is sized and rounded as `sizeFor` sizes it. Free margin is
  set high enough never to bind. The NEAR AI risk check is not run: the backtest takes every entry as passed. Live it
  fails closed (a refusal holds the window out 6 h; no answer holds the entry until the next hourly check), so live
  can only enter less often than the backtest, never more.
- **Booking.** A pair held over an hour books that hour's funding on both legs from the venues' booked rates:
  `legUsd x (short leg's rate - long leg's rate)`. Each entry and each rotation books the round trip the scanner
  priced for that window (4 fills, slippage, basis buffer) at the size `decide()` opened. Price P&L is not counted
  (both legs are the same notional of one base). A pair still held at the end keeps its full round trip.
- **Scopes.** `live`: only long Phoenix / short Hyperliquid windows reach `decide()`, the one direction serve opens
  (`serve-loop.ts windowSymbol`), with Hyperliquid and Phoenix read. `all`: every direction on Hyperliquid, Phoenix
  and Orderly, every window sizable, for context.
- **Checks.** From 14.5 days after both venues' first print (so the 14-day gate can pass) to the last hour every leg
  has booked. A market listed later (Phoenix LTC, XLM, DOGE, ZEC) is a younger market, judged by the scanner as live.
- **Test.** `src/backtest/checks-sim.test.ts` runs the core on a synthetic market whose spread flips at a known hour:
  the entry hour, exit hour, funding, round trip, waited hours, late-exit hours and a missed window are all known.

Columns: **missed** = runs of passing checks of the top, sizable window while the desk was flat and out of cooldown
that ended before the entry count, valued at what the 1-check entry (same exit count) netted on the trade it entered
at that hour; **waited-hours funding** = what the hours between a window's first passing check (while the desk was
free) and its entry paid; **late-exit hours / funding** = hours held after the first bad check of a counted exit, and
what they paid (negative = cost); **bad runs held through** = runs of bad checks that recovered before the exit count.

## Data

| venue | symbol | first print | last print | days |
|---|---|---|---|---|
| hyperliquid | BTC | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | ETH | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | SOL | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | DOGE | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | LTC | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | XLM | 2025-09-30 06h | 2026-11-04 05h | 400.0 |
| hyperliquid | ZEC | 2025-10-02 14h | 2026-11-04 05h | 397.6 |
| phoenix | BTC | 2025-11-18 03h | 2026-11-04 06h | 351.1 |
| phoenix | ETH | 2025-11-18 03h | 2026-11-04 06h | 351.1 |
| phoenix | SOL | 2025-11-18 03h | 2026-11-04 06h | 351.1 |
| phoenix | DOGE | 2026-03-13 20h | 2026-11-04 06h | 235.4 |
| phoenix | LTC | 2026-09-22 15h | 2026-11-04 06h | 42.6 |
| phoenix | XLM | 2026-06-02 17h | 2026-11-04 06h | 154.5 |
| phoenix | ZEC | 2026-03-13 20h | 2026-11-04 06h | 235.4 |
| orderly | PERP_BTC_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |
| orderly | PERP_ETH_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |
| orderly | PERP_SOL_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |
| orderly | PERP_DOGE_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |
| orderly | PERP_LTC_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |
| orderly | PERP_ZEC_USDC | 2025-11-09 08h | 2026-11-04 00h | 359.7 |

Hyperliquid is read back 400 days (the tool's cap), Orderly answers about 360, Phoenix starts on 2025-11-18 (BTC,
ETH, SOL), 2026-03-13 (DOGE, ZEC), 2026-06-02 (XLM) and 2026-09-22 (LTC). Checks run 2025-12-02 to 2026-11-04,
336.6 days, 8,080 hourly checks per run (the all-venues scope ends at Orderly's last 8-hour print, 5 hours earlier).

## Results on the one round trip (2026-11-04: 168 h hold, 10 bps buffer)

The scanner's gate now prices the round trip the pair trader's open is held to (`deskRoundTrip`, a 7-day hold, a
10 bps buffer, Hyperliquid's builder fee once). Same cache, scope live (long Phoenix / short Hyperliquid), run with
`npm run backtest:checks -- --no-fetch --scope live --enter 1,2,3,4 --exit 1,2,3,4,6`.

**12 USD a leg (the live desk)**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 4 | 4 | 0 | 814 | 0.236 | 0.160 | **0.077** | 0.019 | 0 | 0.000 | 0 | 0.000 | 0 |
| 1 | 2 | 4 | 4 | 0 | 822 | 0.235 | 0.160 | **0.076** | 0.019 | 0 | 0.000 | 2 | -0.000 | 2 |
| 1 | 3 | 3 | 3 | 0 | 833 | 0.237 | 0.118 | **0.119** | 0.040 | 0 | 0.000 | 2 | -0.000 | 3 |
| 1 | 4 | 3 | 3 | 0 | 834 | 0.237 | 0.118 | **0.119** | 0.040 | 0 | 0.000 | 3 | -0.001 | 3 |
| 1 | 6 | 3 | 3 | 0 | 868 | 0.242 | 0.118 | **0.124** | 0.041 | 0 | 0.000 | 5 | 0.001 | 7 |
| 2 | 1 | 4 | 4 | 0 | 813 | 0.236 | 0.160 | **0.076** | 0.019 | 0 | 0.001 | 0 | 0.000 | 0 |
| 2 | 2 | 4 | 4 | 0 | 820 | 0.234 | 0.160 | **0.075** | 0.019 | 0 | 0.001 | 2 | -0.000 | 2 |
| 2 | 3 | 3 | 3 | 0 | 832 | 0.237 | 0.118 | **0.118** | 0.039 | 0 | 0.001 | 2 | -0.000 | 3 |
| 2 | 4 | 3 | 3 | 0 | 833 | 0.236 | 0.118 | **0.118** | 0.039 | 0 | 0.001 | 3 | -0.001 | 3 |
| 2 | 6 | 3 | 3 | 0 | 867 | 0.241 | 0.118 | **0.123** | 0.041 | 0 | 0.001 | 5 | 0.001 | 7 |
| 3 | 1 | 4 | 4 | 0 | 812 | 0.235 | 0.160 | **0.075** | 0.019 | 0 | 0.002 | 0 | 0.000 | 0 |
| 3 | 2 | 4 | 4 | 0 | 818 | 0.233 | 0.160 | **0.074** | 0.018 | 0 | 0.002 | 2 | -0.000 | 2 |
| 3 | 3 | 3 | 3 | 0 | 831 | 0.236 | 0.118 | **0.118** | 0.039 | 0 | 0.002 | 2 | -0.000 | 3 |
| 3 | 4 | 3 | 3 | 0 | 832 | 0.236 | 0.118 | **0.118** | 0.039 | 0 | 0.002 | 3 | -0.001 | 3 |
| 3 | 6 | 3 | 3 | 0 | 866 | 0.241 | 0.118 | **0.123** | 0.041 | 0 | 0.002 | 5 | 0.001 | 7 |
| 4 | 1 | 4 | 4 | 0 | 811 | 0.235 | 0.160 | **0.075** | 0.019 | 0 | 0.002 | 0 | 0.000 | 0 |
| 4 | 2 | 4 | 4 | 0 | 816 | 0.233 | 0.160 | **0.073** | 0.018 | 0 | 0.003 | 2 | -0.000 | 2 |
| 4 | 3 | 3 | 3 | 0 | 830 | 0.236 | 0.118 | **0.117** | 0.039 | 0 | 0.002 | 2 | -0.000 | 3 |
| 4 | 4 | 3 | 3 | 0 | 831 | 0.235 | 0.118 | **0.117** | 0.039 | 0 | 0.002 | 3 | -0.001 | 3 |
| 4 | 6 | 3 | 3 | 0 | 865 | 0.240 | 0.118 | **0.122** | 0.041 | 0 | 0.002 | 5 | 0.001 | 7 |

**1000 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 4 | 4 | 0 | 237 | 5.87 | 12.96 | **-7.09** | -1.77 | 0 | 0.00 | 0 | 0.00 | 0 |
| 1 | 2 | 2 | 2 | 0 | 329 | 7.42 | 6.48 | **0.94** | 0.47 | 0 | 0.00 | 2 | -0.03 | 7 |
| 1 | 3 | 2 | 2 | 0 | 361 | 7.74 | 6.48 | **1.27** | 0.63 | 0 | 0.00 | 4 | -0.01 | 9 |
| 1 | 4 | 2 | 2 | 0 | 363 | 7.73 | 6.48 | **1.25** | 0.63 | 0 | 0.00 | 6 | -0.03 | 9 |
| 1 | 6 | 2 | 2 | 0 | 367 | 7.70 | 6.48 | **1.22** | 0.61 | 0 | 0.00 | 10 | -0.06 | 9 |
| 2 | 1 | 4 | 4 | 0 | 235 | 5.82 | 12.96 | **-7.14** | -1.78 | 0 | 0.05 | 0 | 0.00 | 0 |
| 2 | 2 | 2 | 2 | 0 | 327 | 7.36 | 6.48 | **0.88** | 0.44 | 0 | 0.05 | 2 | -0.03 | 7 |
| 2 | 3 | 2 | 2 | 0 | 359 | 7.69 | 6.48 | **1.21** | 0.61 | 0 | 0.05 | 4 | -0.01 | 9 |
| 2 | 4 | 2 | 2 | 0 | 361 | 7.68 | 6.48 | **1.20** | 0.60 | 0 | 0.05 | 6 | -0.03 | 9 |
| 2 | 6 | 2 | 2 | 0 | 365 | 7.64 | 6.48 | **1.17** | 0.58 | 0 | 0.05 | 10 | -0.06 | 9 |
| 3 | 1 | 4 | 4 | 0 | 233 | 5.76 | 12.96 | **-7.20** | -1.80 | 0 | 0.11 | 0 | 0.00 | 0 |
| 3 | 2 | 2 | 2 | 0 | 325 | 7.30 | 6.48 | **0.82** | 0.41 | 0 | 0.11 | 2 | -0.03 | 7 |
| 3 | 3 | 2 | 2 | 0 | 357 | 7.63 | 6.48 | **1.15** | 0.58 | 0 | 0.11 | 4 | -0.01 | 9 |
| 3 | 4 | 2 | 2 | 0 | 359 | 7.62 | 6.48 | **1.14** | 0.57 | 0 | 0.11 | 6 | -0.03 | 9 |
| 3 | 6 | 2 | 2 | 0 | 363 | 7.58 | 6.48 | **1.10** | 0.55 | 0 | 0.11 | 10 | -0.06 | 9 |
| 4 | 1 | 4 | 4 | 0 | 231 | 5.69 | 12.96 | **-7.26** | -1.82 | 0 | 0.18 | 0 | 0.00 | 0 |
| 4 | 2 | 2 | 2 | 0 | 323 | 7.24 | 6.48 | **0.76** | 0.38 | 0 | 0.18 | 2 | -0.03 | 7 |
| 4 | 3 | 2 | 2 | 0 | 355 | 7.57 | 6.48 | **1.09** | 0.54 | 0 | 0.18 | 4 | -0.01 | 9 |
| 4 | 4 | 2 | 2 | 0 | 357 | 7.55 | 6.48 | **1.07** | 0.54 | 0 | 0.18 | 6 | -0.03 | 9 |
| 4 | 6 | 2 | 2 | 0 | 361 | 7.52 | 6.48 | **1.04** | 0.52 | 0 | 0.18 | 10 | -0.06 | 9 |

What moved, at the adopted enter 3, exit 6:

| leg | before (240 h, 5 bps) | after (168 h, 10 bps) |
|---|---|---|
| 12 USD | 18 entries, net 0.524 USD (0.029 an entry) | 3 entries, net 0.123 USD (0.041 an entry) |
| 1000 USD | 9 entries, net 17.29 USD (1.92 an entry) | 2 entries, net 1.10 USD (0.55 an entry) |

- **Most entries go.** The 15 entries at 12 USD a leg that drop out paid their round trip only over 10 days of
  spread with a 5 bps buffer; the live trader's open (7 days, 10 bps) would have refused most of them, so the
  desk could not have taken them. What is left is XLM in July 2026 (twice) and LTC in September, two of them to the 14-day time stop.
- **Each entry is worth more** (0.041 against 0.029 USD at 12 USD a leg); the year's net is a quarter of before.
- **The counts still order the same way:** exit 1 loses at 1000 USD a leg and earns least at 12; from exit 3 on the
  net is flat; the entry count moves it by at most 0.003 USD at 12 USD and 0.18 USD at 1000.
- With 2 to 4 trades a setting these numbers say little on their own: they record the hurdle, not a strategy.

## Results: what the live desk can open (long Phoenix / short Hyperliquid), on 240 h and 5 bps

**12 USD a leg (the live desk)**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 48 | 47 | 1 | 3913 | 1.010 | 1.605 | **-0.594** | -0.012 | 0 | 0.010 | 0 | 0.000 | 0 |
| 1 | 2 | 25 | 24 | 0 | 4272 | 1.044 | 0.819 | **0.224** | 0.009 | 0 | 0.010 | 19 | -0.001 | 41 |
| 1 | 3 | 23 | 22 | 0 | 4473 | 1.072 | 0.759 | **0.313** | 0.014 | 0 | 0.010 | 30 | -0.002 | 60 |
| 1 | 4 | 19 | 18 | 0 | 4720 | 1.124 | 0.628 | **0.497** | 0.026 | 0 | 0.010 | 21 | -0.002 | 74 |
| 2 | 1 | 47 | 46 | 1 | 3903 | 1.007 | 1.575 | **-0.568** | -0.012 | 0 | 0.014 | 0 | 0.000 | 0 |
| 2 | 2 | 25 | 24 | 0 | 4264 | 1.041 | 0.819 | **0.222** | 0.009 | 0 | 0.012 | 19 | -0.001 | 41 |
| 2 | 3 | 22 | 21 | 0 | 4472 | 1.074 | 0.723 | **0.351** | 0.016 | 1 (1 valued: -0.031) | 0.013 | 28 | -0.002 | 58 |
| 2 | 4 | 19 | 18 | 0 | 4714 | 1.122 | 0.628 | **0.494** | 0.026 | 0 | 0.012 | 21 | -0.002 | 74 |
| 3 | 1 | 46 | 45 | 1 | 3884 | 1.002 | 1.544 | **-0.542** | -0.012 | 1 (1 valued: -0.031) | 0.019 | 0 | 0.000 | 0 |
| 3 | 2 | 24 | 23 | 0 | 4253 | 1.039 | 0.789 | **0.250** | 0.010 | 1 (1 valued: -0.031) | 0.015 | 18 | -0.001 | 41 |
| 3 | 3 | 21 | 20 | 0 | 4459 | 1.072 | 0.693 | **0.380** | 0.018 | 2 (2 valued: -0.062) | 0.014 | 26 | -0.002 | 56 |
| 3 | 4 | 18 | 17 | 0 | 4700 | 1.120 | 0.597 | **0.524** | 0.029 | 1 (1 valued: -0.031) | 0.014 | 18 | -0.001 | 72 |
| 4 | 1 | 46 | 45 | 1 | 3857 | 0.998 | 1.547 | **-0.549** | -0.012 | 1 (1 valued: -0.031) | 0.023 | 0 | 0.000 | 0 |
| 4 | 2 | 24 | 23 | 0 | 4243 | 1.037 | 0.789 | **0.248** | 0.010 | 1 (1 valued: -0.031) | 0.017 | 18 | -0.001 | 41 |
| 4 | 3 | 21 | 20 | 0 | 4452 | 1.071 | 0.693 | **0.378** | 0.018 | 2 (2 valued: -0.062) | 0.016 | 26 | -0.002 | 56 |
| 4 | 4 | 18 | 17 | 0 | 4695 | 1.119 | 0.597 | **0.522** | 0.029 | 1 (1 valued: -0.031) | 0.016 | 18 | -0.001 | 72 |

**1000 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 43 | 43 | 0 | 1734 | 37.27 | 115.09 | **-77.82** | -1.81 | 0 | 0.00 | 0 | 0.00 | 0 |
| 1 | 2 | 24 | 24 | 0 | 1908 | 39.30 | 64.27 | **-24.97** | -1.04 | 0 | 0.00 | 24 | -0.22 | 28 |
| 1 | 3 | 15 | 15 | 0 | 2082 | 42.08 | 40.17 | **1.91** | 0.13 | 0 | 0.00 | 26 | -0.28 | 41 |
| 1 | 4 | 11 | 11 | 0 | 2073 | 41.91 | 29.52 | **12.40** | 1.13 | 0 | 0.00 | 24 | -0.35 | 46 |
| 2 | 1 | 39 | 39 | 0 | 1724 | 37.26 | 104.47 | **-67.22** | -1.72 | 5 (4 valued: -10.64) | 0.27 | 0 | 0.00 | 0 |
| 2 | 2 | 22 | 22 | 0 | 1889 | 39.10 | 58.96 | **-19.86** | -0.90 | 4 (3 valued: -7.99) | 0.24 | 22 | -0.21 | 26 |
| 2 | 3 | 14 | 14 | 0 | 2067 | 41.90 | 37.51 | **4.39** | 0.31 | 3 (2 valued: 0.65) | 0.21 | 24 | -0.25 | 40 |
| 2 | 4 | 11 | 11 | 0 | 2062 | 41.70 | 29.52 | **12.19** | 1.11 | 2 (1 valued: 3.28) | 0.21 | 24 | -0.35 | 45 |
| 3 | 1 | 37 | 37 | 0 | 1710 | 37.08 | 99.13 | **-62.05** | -1.68 | 7 (6 valued: -15.98) | 0.57 | 0 | 0.00 | 0 |
| 3 | 2 | 21 | 21 | 0 | 1872 | 38.85 | 56.27 | **-17.42** | -0.83 | 6 (5 valued: -13.13) | 0.48 | 21 | -0.21 | 25 |
| 3 | 3 | 13 | 13 | 0 | 2048 | 41.70 | 34.82 | **6.87** | 0.53 | 5 (4 valued: -4.52) | 0.42 | 22 | -0.22 | 37 |
| 3 | 4 | 10 | 10 | 0 | 2044 | 41.53 | 26.83 | **14.70** | 1.47 | 4 (3 valued: -1.91) | 0.42 | 21 | -0.31 | 42 |
| 4 | 1 | 37 | 37 | 0 | 1693 | 36.58 | 99.13 | **-62.55** | -1.69 | 7 (6 valued: -15.98) | 1.07 | 0 | 0.00 | 0 |
| 4 | 2 | 21 | 21 | 0 | 1859 | 38.43 | 56.27 | **-17.85** | -0.85 | 6 (5 valued: -13.13) | 0.90 | 21 | -0.21 | 25 |
| 4 | 3 | 13 | 13 | 0 | 2038 | 41.34 | 34.82 | **6.52** | 0.50 | 5 (4 valued: -4.52) | 0.78 | 22 | -0.22 | 37 |
| 4 | 4 | 10 | 10 | 0 | 2038 | 41.29 | 26.83 | **14.46** | 1.45 | 4 (3 valued: -1.91) | 0.67 | 21 | -0.31 | 42 |

Net USD by when the trade was entered (the checks cut in three equal spans), 12 USD and 1000 USD a leg:

12 USD:

| enter | exit | from 2025-12-02 | from 2026-03-24 | from 2026-07-15 |
|-------|------|-----------------|-----------------|-----------------|
| 1 | 1 | -0.106 | -0.039 | -0.450 |
| 1 | 2 | -0.043 | 0.235 | 0.032 |
| 1 | 3 | -0.011 | 0.254 | 0.071 |
| 1 | 4 | 0.051 | 0.287 | 0.159 |
| 2 | 1 | -0.106 | -0.039 | -0.422 |
| 2 | 2 | -0.043 | 0.234 | 0.031 |
| 2 | 3 | -0.012 | 0.253 | 0.109 |
| 2 | 4 | 0.051 | 0.286 | 0.157 |
| 3 | 1 | -0.076 | -0.041 | -0.426 |
| 3 | 2 | -0.012 | 0.233 | 0.029 |
| 3 | 3 | 0.019 | 0.252 | 0.108 |
| 3 | 4 | 0.082 | 0.285 | 0.156 |
| 4 | 1 | -0.076 | -0.078 | -0.395 |
| 4 | 2 | -0.013 | 0.232 | 0.028 |
| 4 | 3 | 0.019 | 0.252 | 0.107 |
| 4 | 4 | 0.082 | 0.285 | 0.155 |

1000 USD:

| enter | exit | from 2025-12-02 | from 2026-03-24 | from 2026-07-15 |
|-------|------|-----------------|-----------------|-----------------|
| 1 | 1 | -16.85 | -55.37 | -5.59 |
| 1 | 2 | -0.30 | -21.47 | -3.20 |
| 1 | 3 | 2.43 | -0.40 | -0.12 |
| 1 | 4 | 2.39 | 10.13 | -0.12 |
| 2 | 1 | -16.93 | -44.70 | -5.59 |
| 2 | 2 | -0.35 | -16.31 | -3.20 |
| 2 | 3 | 2.38 | 2.15 | -0.14 |
| 2 | 4 | 2.34 | 9.99 | -0.14 |
| 3 | 1 | -14.29 | -42.17 | -5.59 |
| 3 | 2 | 2.29 | -16.52 | -3.20 |
| 3 | 3 | 5.05 | 1.98 | -0.16 |
| 3 | 4 | 5.03 | 9.83 | -0.17 |
| 4 | 1 | -14.36 | -42.59 | -5.59 |
| 4 | 2 | 2.24 | -16.89 | -3.20 |
| 4 | 3 | 5.00 | 1.69 | -0.18 |
| 4 | 4 | 4.98 | 9.66 | -0.18 |

Longer exit counts, for where the curve flattens (same scope):

**12 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 5 | 19 | 18 | 0 | 4764 | 1.126 | 0.628 | **0.498** | 0.026 | 0 | 0.010 | 28 | -0.002 | 83 |
| 1 | 6 | 19 | 18 | 0 | 4776 | 1.124 | 0.628 | **0.497** | 0.026 | 0 | 0.010 | 35 | -0.002 | 84 |
| 1 | 8 | 19 | 18 | 0 | 4808 | 1.126 | 0.628 | **0.498** | 0.026 | 0 | 0.010 | 49 | -0.001 | 86 |
| 1 | 12 | 19 | 18 | 0 | 4948 | 1.127 | 0.628 | **0.499** | 0.026 | 0 | 0.010 | 66 | 0.003 | 107 |
| 1 | 24 | 19 | 18 | 0 | 5063 | 1.143 | 0.628 | **0.516** | 0.027 | 0 | 0.010 | 138 | 0.018 | 105 |
| 3 | 5 | 18 | 17 | 0 | 4743 | 1.122 | 0.597 | **0.525** | 0.029 | 2 (2 valued: 0.000) | 0.015 | 24 | -0.001 | 81 |
| 3 | 6 | 18 | 17 | 0 | 4754 | 1.121 | 0.597 | **0.524** | 0.029 | 1 (1 valued: -0.032) | 0.014 | 30 | -0.001 | 82 |
| 3 | 8 | 18 | 17 | 0 | 4762 | 1.119 | 0.597 | **0.522** | 0.029 | 1 (1 valued: -0.029) | 0.014 | 42 | -0.002 | 82 |
| 3 | 12 | 18 | 17 | 0 | 4898 | 1.119 | 0.597 | **0.523** | 0.029 | 1 (1 valued: -0.028) | 0.014 | 55 | 0.001 | 103 |
| 3 | 24 | 18 | 17 | 0 | 5001 | 1.133 | 0.597 | **0.536** | 0.030 | 1 (1 valued: -0.025) | 0.014 | 115 | 0.013 | 101 |

**1000 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 5 | 10 | 10 | 0 | 2095 | 41.89 | 26.86 | **15.03** | 1.50 | 0 | 0.00 | 28 | -0.43 | 50 |
| 1 | 6 | 10 | 10 | 0 | 2102 | 41.82 | 26.86 | **14.95** | 1.50 | 0 | 0.00 | 35 | -0.51 | 50 |
| 1 | 8 | 10 | 10 | 0 | 2144 | 41.86 | 26.86 | **15.00** | 1.50 | 0 | 0.00 | 49 | -0.28 | 52 |
| 1 | 12 | 10 | 10 | 0 | 2169 | 41.68 | 26.86 | **14.82** | 1.48 | 0 | 0.00 | 77 | -0.46 | 51 |
| 1 | 24 | 9 | 9 | 0 | 2296 | 42.72 | 24.21 | **18.51** | 2.06 | 0 | 0.00 | 92 | -0.81 | 55 |
| 3 | 5 | 9 | 9 | 0 | 2065 | 41.52 | 24.17 | **17.34** | 1.93 | 4 (3 valued: -2.01) | 0.42 | 24 | -0.38 | 46 |
| 3 | 6 | 9 | 9 | 0 | 2071 | 41.47 | 24.17 | **17.29** | 1.92 | 4 (3 valued: -2.06) | 0.42 | 30 | -0.43 | 46 |
| 3 | 8 | 9 | 9 | 0 | 2091 | 41.24 | 24.17 | **17.07** | 1.90 | 3 (3 valued: -1.98) | 0.42 | 42 | -0.38 | 47 |
| 3 | 12 | 9 | 9 | 0 | 2115 | 41.00 | 24.17 | **16.82** | 1.87 | 2 (2 valued: -5.01) | 0.42 | 66 | -0.62 | 47 |
| 3 | 24 | 8 | 8 | 0 | 2238 | 41.96 | 21.52 | **20.44** | 2.56 | 1 (1 valued: -2.20) | 0.28 | 69 | -1.22 | 52 |

### Top trades, 12 USD a leg

Best setting (enter 3, exit 4):

| window | how | entered | exited | hours | funding USD | cost USD | net USD | exit |
|---|---|---|---|---|---|---|---|---|
| xlm-phoenix-hyperliquid | enter | 2026-06-29 05h | 2026-07-13 05h | 336 | 0.117 | 0.035 | 0.082 | Exit XLM: held 14.0 days, the 14-day time stop |
| xlm-phoenix-hyperliquid | enter | 2026-07-13 11h | 2026-07-27 11h | 336 | 0.107 | 0.035 | 0.072 | Exit XLM: held 14.0 days, the 14-day time stop |
| doge-phoenix-hyperliquid | enter | 2026-08-18 06h | 2026-09-01 06h | 336 | 0.089 | 0.033 | 0.056 | Exit DOGE: held 14.0 days, the 14-day time stop |
| doge-phoenix-hyperliquid | enter | 2026-04-18 15h | 2026-05-02 15h | 336 | 0.088 | 0.033 | 0.055 | Exit DOGE: held 14.0 days, the 14-day time stop |
| doge-phoenix-hyperliquid | enter | 2026-05-02 21h | 2026-05-16 21h | 336 | 0.085 | 0.033 | 0.053 | Exit DOGE: held 14.0 days, the 14-day time stop |

Current setting (enter 3, exit 3):

| window | how | entered | exited | hours | funding USD | cost USD | net USD | exit |
|---|---|---|---|---|---|---|---|---|
| xlm-phoenix-hyperliquid | enter | 2026-06-29 05h | 2026-07-13 05h | 336 | 0.117 | 0.035 | 0.082 | Exit XLM: held 14.0 days, the 14-day time stop |
| xlm-phoenix-hyperliquid | enter | 2026-07-13 11h | 2026-07-27 11h | 336 | 0.107 | 0.035 | 0.072 | Exit XLM: held 14.0 days, the 14-day time stop |
| doge-phoenix-hyperliquid | enter | 2026-04-18 15h | 2026-05-02 15h | 336 | 0.088 | 0.033 | 0.055 | Exit DOGE: held 14.0 days, the 14-day time stop |
| xlm-phoenix-hyperliquid | enter | 2026-10-18 06h | 2026-11-01 06h | 336 | 0.088 | 0.035 | 0.052 | Exit XLM: held 14.0 days, the 14-day time stop |
| eth-phoenix-hyperliquid | enter | 2026-02-21 20h | 2026-03-07 20h | 336 | 0.083 | 0.031 | 0.052 | Exit ETH: held 14.0 days, the 14-day time stop |

### Top trades, 1000 USD a leg

Best setting (enter 3, exit 4):

| window | how | entered | exited | hours | funding USD | cost USD | net USD | exit |
|---|---|---|---|---|---|---|---|---|
| btc-phoenix-hyperliquid | enter | 2026-07-07 18h | 2026-07-21 18h | 336 | 8.69 | 2.83 | 5.85 | Exit BTC: held 14.0 days, the 14-day time stop |
| eth-phoenix-hyperliquid | enter | 2026-02-21 20h | 2026-03-07 20h | 336 | 7.24 | 2.69 | 4.55 | Exit ETH: held 14.0 days, the 14-day time stop |
| eth-phoenix-hyperliquid | enter | 2026-06-01 06h | 2026-06-15 06h | 336 | 6.26 | 2.69 | 3.57 | Exit ETH: held 14.0 days, the 14-day time stop |
| zec-phoenix-hyperliquid | enter | 2026-03-27 08h | 2026-04-08 01h | 281 | 5.93 | 2.65 | 3.27 | Exit ZEC: the spread flipped: this hour pays -54.7 %, 4 of 4 hours in a row |
| zec-phoenix-hyperliquid | enter | 2026-05-06 08h | 2026-05-13 23h | 183 | 4.25 | 2.65 | 1.59 | Exit ZEC: the spread flipped: this hour pays -14.1 %, 4 of 4 hours in a row |

Current setting (enter 3, exit 3):

| window | how | entered | exited | hours | funding USD | cost USD | net USD | exit |
|---|---|---|---|---|---|---|---|---|
| btc-phoenix-hyperliquid | enter | 2026-07-07 18h | 2026-07-21 18h | 336 | 8.69 | 2.83 | 5.85 | Exit BTC: held 14.0 days, the 14-day time stop |
| eth-phoenix-hyperliquid | enter | 2026-02-21 20h | 2026-03-07 20h | 336 | 7.24 | 2.69 | 4.55 | Exit ETH: held 14.0 days, the 14-day time stop |
| zec-phoenix-hyperliquid | enter | 2026-03-27 08h | 2026-04-08 00h | 280 | 5.99 | 2.65 | 3.33 | Exit ZEC: the spread flipped: this hour pays -52.0 %, 3 of 3 hours in a row |
| eth-phoenix-hyperliquid | enter | 2026-06-01 06h | 2026-06-12 18h | 276 | 5.69 | 2.69 | 3.00 | Exit ETH: the spread flipped: this hour pays -6.8 %, 3 of 3 hours in a row |
| zec-phoenix-hyperliquid | enter | 2026-03-20 05h | 2026-03-26 16h | 155 | 3.16 | 2.65 | 0.51 | Exit ZEC: the spread flipped: this hour pays -18.1 %, 3 of 3 hours in a row |

## Context: every direction on Hyperliquid, Phoenix and Orderly

**12 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 54 | 53 | 2 | 4536 | 1.284 | 1.745 | **-0.461** | -0.008 | 0 | 0.198 | 0 | 0.000 | 0 |
| 1 | 2 | 40 | 39 | 1 | 4854 | 1.308 | 1.276 | **0.032** | 0.001 | 0 | 0.195 | 34 | -0.001 | 42 |
| 1 | 3 | 34 | 33 | 1 | 5080 | 1.349 | 1.107 | **0.242** | 0.007 | 0 | 0.194 | 52 | -0.001 | 56 |
| 1 | 4 | 29 | 28 | 1 | 5267 | 1.391 | 0.925 | **0.466** | 0.016 | 0 | 0.174 | 57 | -0.000 | 69 |
| 2 | 1 | 54 | 53 | 2 | 4497 | 1.274 | 1.745 | **-0.470** | -0.008 | 1 (1 valued: -0.035) | 0.207 | 0 | 0.000 | 0 |
| 2 | 2 | 40 | 39 | 1 | 4842 | 1.306 | 1.276 | **0.030** | 0.001 | 1 (1 valued: -0.031) | 0.197 | 34 | -0.001 | 41 |
| 2 | 3 | 34 | 33 | 1 | 5072 | 1.347 | 1.107 | **0.240** | 0.007 | 1 (1 valued: -0.031) | 0.196 | 52 | -0.001 | 55 |
| 2 | 4 | 29 | 28 | 1 | 5260 | 1.389 | 0.925 | **0.464** | 0.015 | 0 | 0.176 | 57 | -0.000 | 69 |
| 3 | 1 | 54 | 53 | 2 | 4481 | 1.270 | 1.745 | **-0.475** | -0.008 | 1 (1 valued: -0.035) | 0.211 | 0 | 0.000 | 0 |
| 3 | 2 | 40 | 39 | 1 | 4831 | 1.303 | 1.276 | **0.027** | 0.001 | 1 (1 valued: -0.031) | 0.199 | 34 | -0.001 | 41 |
| 3 | 3 | 34 | 33 | 1 | 5063 | 1.344 | 1.107 | **0.238** | 0.007 | 1 (1 valued: -0.031) | 0.198 | 52 | -0.001 | 55 |
| 3 | 4 | 29 | 28 | 1 | 5252 | 1.386 | 0.925 | **0.461** | 0.015 | 0 | 0.178 | 57 | -0.000 | 69 |
| 4 | 1 | 53 | 52 | 2 | 4452 | 1.265 | 1.712 | **-0.447** | -0.008 | 2 (2 valued: -0.060) | 0.214 | 0 | 0.000 | 0 |
| 4 | 2 | 40 | 39 | 1 | 4808 | 1.298 | 1.276 | **0.023** | 0.001 | 1 (1 valued: -0.031) | 0.202 | 34 | -0.001 | 41 |
| 4 | 3 | 34 | 33 | 1 | 5043 | 1.340 | 1.107 | **0.233** | 0.007 | 1 (1 valued: -0.031) | 0.200 | 52 | -0.001 | 55 |
| 4 | 4 | 29 | 28 | 1 | 5242 | 1.384 | 0.925 | **0.459** | 0.015 | 0 | 0.180 | 57 | -0.000 | 69 |

**1000 USD a leg**

| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |
|-------|------|---------|-------|-----------|------------|-----------|-----------|---------|-------------|------------------------|--------------------------|-----------------|-----------------------|-----------------------|
| 1 | 1 | 77 | 76 | 4 | 5129 | 133.33 | 204.76 | **-71.43** | -0.88 | 0 | 0.00 | 0 | 0.00 | 0 |
| 1 | 2 | 60 | 59 | 3 | 5303 | 131.06 | 159.19 | **-28.13** | -0.45 | 0 | 0.00 | 54 | -0.17 | 32 |
| 1 | 3 | 52 | 51 | 3 | 5362 | 131.28 | 138.84 | **-7.57** | -0.14 | 0 | 0.00 | 88 | -0.32 | 39 |
| 1 | 4 | 47 | 46 | 3 | 5367 | 128.04 | 126.59 | **1.45** | 0.03 | 0 | 0.00 | 117 | -0.60 | 63 |
| 2 | 1 | 72 | 71 | 4 | 5140 | 132.50 | 193.37 | **-60.87** | -0.80 | 4 (4 valued: -9.53) | 0.75 | 0 | 0.00 | 0 |
| 2 | 2 | 57 | 56 | 3 | 5271 | 130.40 | 152.09 | **-21.70** | -0.36 | 3 (3 valued: -7.11) | 0.69 | 51 | -0.14 | 33 |
| 2 | 3 | 50 | 49 | 3 | 5332 | 130.57 | 133.99 | **-3.42** | -0.06 | 2 (2 valued: -4.86) | 0.69 | 84 | -0.31 | 41 |
| 2 | 4 | 46 | 45 | 3 | 5335 | 127.41 | 123.97 | **3.44** | 0.07 | 2 (2 valued: -4.83) | 0.60 | 114 | -0.61 | 63 |
| 3 | 1 | 72 | 71 | 4 | 5113 | 131.87 | 193.37 | **-61.51** | -0.81 | 4 (4 valued: -9.53) | 1.38 | 0 | 0.00 | 0 |
| 3 | 2 | 57 | 56 | 3 | 5249 | 129.82 | 152.09 | **-22.27** | -0.37 | 3 (3 valued: -7.11) | 1.26 | 51 | -0.14 | 33 |
| 3 | 3 | 50 | 49 | 3 | 5310 | 129.94 | 133.99 | **-4.05** | -0.08 | 2 (2 valued: -4.86) | 1.27 | 84 | -0.31 | 41 |
| 3 | 4 | 46 | 45 | 3 | 5313 | 126.77 | 123.97 | **2.80** | 0.06 | 2 (2 valued: -4.83) | 1.20 | 114 | -0.61 | 63 |
| 4 | 1 | 71 | 70 | 4 | 5075 | 131.19 | 191.14 | **-59.95** | -0.80 | 7 (5 valued: -11.77) | 2.04 | 0 | 0.00 | 0 |
| 4 | 2 | 56 | 55 | 3 | 5216 | 129.32 | 149.86 | **-20.54** | -0.35 | 5 (4 valued: -9.36) | 1.87 | 50 | -0.16 | 31 |
| 4 | 3 | 49 | 48 | 3 | 5278 | 129.36 | 131.75 | **-2.39** | -0.05 | 4 (2 valued: -4.86) | 1.95 | 82 | -0.34 | 39 |
| 4 | 4 | 45 | 44 | 3 | 5291 | 126.40 | 121.74 | **4.66** | 0.10 | 4 (2 valued: -4.83) | 1.84 | 111 | -0.66 | 61 |

## What it says

- **The exit count decides the result; the entry count barely matters.** In the live scope, moving the exit count
  from 1 to 4 changes the year's net by 1.07 USD at 12 USD a leg and 77 USD at 1000 USD; at the exit counts worth using
  (3 and 4), moving the entry count from 1 to 4 changes it by at most 0.07 USD and 5 USD.
- **Exit after 1 or 2 checks loses money, on fees.** One hourly print against the pair is common: at enter 3, exit 1,
  40 of the 45 exits are "this hour pays < 0", 29 of the 47 pairs are held under 48 hours, and the round trips (1.54 USD
  at 12 USD a leg, 99 USD at 1000) are worth more than all the funding received.
- **Exit 3 (the current setting) is positive but leaves money.** Exit 4 nets 0.524 against 0.380 USD at 12 USD a leg
  (+38 %) and 14.70 against 6.87 USD at 1000 (2.1x), with 3 fewer round trips; in the all-venues scope it turns
  1000 USD a leg from -4.05 to +2.80 USD. From 4 to 12 checks the net is flat (0.522 to 0.525 USD at 12; 14.7 to
  17.3 at 1000); 24 is a little higher on fewer trades.
- **Late exits cost cents.** Over the year, every hour held after a first bad check before a counted exit paid
  -0.001 to -0.002 USD at 12 USD a leg and -0.22 to -0.43 USD at 1000 USD (exit 3 to 6), against about 2.7 USD for
  each round trip at 1000 USD. The runs of bad checks the pair held through (37 at exit 3, 42 at 4, 46 at 6, 1000
  USD) are what longer counts buy: most of those would otherwise have been an exit and a re-entry.
- **The entry wait pays for itself.** The windows the 3-check entry missed are ones the 1-check entry lost on (5 runs
  at 1000 USD, exit 3; the 4 the 1-check run entered netted -4.52 USD), and the hours waited before an entry forwent
  0.42 USD of funding over the year. Enter 3 is the best or tied entry count at every exit count at 1000 USD; at 12
  USD the entry counts differ by 0.07 USD at most. 4 is no better than 3.
- **Scale.** At the live 12 USD a leg the whole year is worth about half a dollar at best (0.38 USD now); the same
  rules at 1000 USD a leg net 6.87 USD now and 14.70 to 17.34 with a longer exit count, about 1.6 to 1.9 % a year
  on one leg's notional, with the desk flat three quarters of the time.

**Recommendation:** keep `enterAfterChecks` at 3; raise `exitAfterChecks` to 6 (4 if the change should stay inside
the tested 1..4). Confidence: high that 1 and 2 lose and that 4 or more beats 3 (true in both scopes, both leg sizes,
and in each third of the year at 12 USD a leg; at 1000 USD better in one third and within 0.02 USD in the other two); low on how much it adds and on the
exact count, which rests on 10 to 23 trades a setting at exit 3 or more and, at 1000 USD, mostly on ZEC in May 2026.

## Decision

Adopted: **enter after 3, exit after 6** hourly checks in a row. Both counts are now owner settings,
`StrategyConfig.enterAfterChecks` and `exitAfterChecks` (whole numbers 1..24, read and written through `GET` /
`PUT /strategy`, saved with the rest of the strategy), defaulting to 3 and 6; a strategy saved before the settings
existed loads with those defaults. The engine prints them on the strategy loop's start line, the hold lines count
"n of 6 hours before exit", and the onboarding form edits them (docs/interfaces.md §3 "Strategy loop"). A change never
resets a count in progress. `npm run backtest:checks` prints the default setting's top trades when its grid holds it
(`--exit 6`).

## Caveats

- **Sample size.** One year, 10 to 23 trades per setting at exit 3 or more in the live scope, and a few symbols carry the result (DOGE
  and XLM at 12 USD; ETH, BTC and ZEC at 1000 USD, where the 2 % open-interest cap keeps XLM and LTC out). At 1000 USD
  most of the gap between exit 3 and exit 4 is ZEC in May 2026, when exit 3 left and re-entered it four times in ten
  days. The ordering by exit
  count holds in every period at 12 USD; the size of each step does not.
- **Survivorship.** The symbols are today's policy, chosen in late 2026 partly because they were paying. Phoenix
  history is short for its newer markets (LTC 43 days, XLM 155, DOGE and ZEC 235).
- **Today's books and open interest.** Slippage, the open-interest cap and the mark gap are today's for every past
  hour. Phoenix's books and open interest were likely thinner a year ago, which would make every round trip dearer
  and longer holds better still.
- **The current hour.** Live, Hyperliquid's `funding()` reports the predicted rate of the hour under way; here every
  venue's current rate is the last booked one. The "this hour pays < 0" check therefore lags live by up to an hour.
- **Not counted.** Price P&L and basis convergence, 1Click margin moves and their cost, rescues, the NEAR AI risk check,
  Phoenix's daily settlement, the 5 s scan events between hourly checks, order failures and partial fills. Orderly's
  8-hour prints are spread evenly over their hours.
- **Live serve and other directions.** In the live scope only serve's direction reaches `decide()`. Live, serve gives
  lots only to the windows it can open, so a higher-ranked window in another direction makes `decide()` wait rather
  than take the next one ("a lower window is never entered in its place"); this backtest does not measure that.
