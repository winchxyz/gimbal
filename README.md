# Gimbal

**A trading desk that earns the gap in funding rates between two exchanges, with its money in accounts only a NEAR
contract can sign for.**

Perpetual-futures exchanges make one side of the market pay the other a small regular fee, called funding, and the
rate differs from one exchange to the next. A funding carry is short a coin where funding pays more and long the same
coin where it pays less: the price moves cancel out, and the gap is the income. As an illustration (not a measured
figure): if one exchange pays 20 % a year on a short and the other charges 8 % on a long, the pair earns the 12 % gap
on the leg size, before trading costs; whether that pays at real sizes: [Does it make money?](#does-it-make-money).

The hard part is that the two legs sit on different chains. One leg can be liquidated while the spare money sits on
the other, and the bot that runs them usually holds keys that could send any order or move the money anywhere.

In Gimbal a NEAR contract holds the trading accounts and checks every order and transfer against the owner's policy
before NEAR's MPC network signs it. The engine that trades and moves margin can act only inside that policy.

**Built and verified on mainnet** (the transactions behind each claim, with what each proves:
[docs/onchain-evidence.md](docs/onchain-evidence.md)):

- The contract [`gimbal_dex.near`](https://nearblocks.io/address/gimbal_dex.near) is deployed from a reproducible
  build and locked: its [last access key is deleted](https://nearblocks.io/txns/C3vpb1cvqJMG8ivPJV9nTeJX9XGGGTfQzH7QVYYuMY4E),
  so nobody can change its code.
- The desk's accounts on Hyperliquid, Orderly and Phoenix are
  [derived from NEAR's MPC network](https://nearblocks.io/txns/DMUGLvkVTtf6Atim4jneLvWTmFsbhfDetxcwgHCdWSfN) for the
  contract; no private key for them exists.
- Three cross-chain payments into the desk's venues were paid only after the contract verified 1Click's quote
  signature: [Hyperliquid](https://nearblocks.io/txns/BvJDHBC2SoWduBCSYAynPX1QvYMmqhs8tf7T2HpcYMqi),
  [Phoenix (paid to the desk's Solana account)](https://nearblocks.io/txns/97DivxqnJgiA3r4t9Kwjcq62bhVvVBWa4bkDtXFyhVKp),
  [Orderly](https://nearblocks.io/txns/6LGEdqp9bv7WAWKyAz9VkZLACBh5mJRtK6if6EwKC89K).
- A deliberately mispriced test order was
  [refused on chain with `E_PRICE_BAND`](https://nearblocks.io/txns/33K2sHAd7TzJrEoAav6JymkuvPG7sUbtDcfRrPf74NSj);
  on testnet the same code [refused 8 of 8 scripted attacks](#refusals-on-chain-npm-run-attack), 0 USDC moved.
- The engine runs against the mainnet desk: each start signs an Orderly session through the contract
  ([the first](https://nearblocks.io/txns/7FKrWJzCGVyGoKEZkGUAJ3jq6o6w5EcPxjWd5h5APxQa); 12 by 2026-11-05).
- The first live pair ran its whole cycle on mainnet: 74 XLM a leg (about 11.4 USD), short on Hyperliquid and long
  on Phoenix, every order checked and signed through the contract. The owner opened it by hand on 2026-11-06 05:04
  UTC as an owner demo entry, forecast at -3.3 % net APR after costs, below any threshold the loop would open on (the
  profit checks are waived, the contract's policy checks are not;
  [Hyperliquid leg](https://nearblocks.io/txns/6WxR3Yj7p8ZdEYSVaDmYqiKwxD5Bz6Z1rXTdshAe98wr),
  [Phoenix leg](https://nearblocks.io/txns/4esnzwZZKttnXDEncMZ5Ms8MoojBqECY4KCSAYsRtTbV)). The strategy loop held it
  27 hours and closed it on 2026-11-07 08:03 UTC with reduce-only orders
  ([Hyperliquid](https://nearblocks.io/txns/22rYMiTeSCDcCFNypDt7pmNWtm3TLQNmawgQDQ437iTa),
  [Phoenix](https://nearblocks.io/txns/CyCZ26LQpKNaAzNfFfZPEgf7dALYJNo8dojvVnDxkcio)), under a temporary owner rule
  (a 1000 % net minimum, exit after 24 hourly checks) set so the pair would close after about a day; by its own
  numbers the pair's forward rate was still 5.1 % net APR after exit costs. Booked (funding read to 07:00 UTC; the last hour was still settling):
  funding +0.0085 USD, fees -0.0169, price -0.0178, net -0.026 USD ([Status](#status-2026-11-04)).
- A second live pair has been held since 2026-11-09 03:08 UTC: 716 MON a leg (about 11.5 USD), short on Hyperliquid
  (a post-only order that filled as maker) and long on Phoenix, about 40 % net APR forecast at entry. The owner opened
  it from the hosted demo's owner console, again as an owner demo entry, after the NEAR AI risk check passed
  ([Hyperliquid leg](https://nearblocks.io/txns/SdYWNMUp4gyqjx3nBQibUKbnXffLum6pj6fChwV2z9q),
  [Phoenix leg](https://nearblocks.io/txns/2Gk3rxrpsDyuwJQoyRBSyVscsPpppX9hEtQRN6Fr22Nh)).

Not yet: a live margin rescue on mainnet (the desk's rescue counters on chain are 0; [Status](#status-2026-11-04)).

Tracks: DeFi (main) and Security. Built for NEAR HACKATHON, Nov 1–14, 2026, by winch
([@winchxyz](https://x.com/winchxyz)). This repository started on Oct 30, 2026, inside the build window (Oct 19 to
Nov 14, rule Q-001 of the hackathon).

**Hosted demo:** https://gimbal-production-1b10.up.railway.app — the live mainnet desk, read-only: the real engine
as it trades now, through a host that refuses every visitor's write ([docs/deploy-live-view.md](docs/deploy-live-view.md);
only the owner, with the owner token, can unlock entering and closing). With
no pair held it shows a flat desk and the scanner's windows, which is the truth. For the recorded replay (mainnet hour
of 2026-10-31, x10, a stress test from Rescue), run `npm run demo`.

<!-- SUBMISSION: fill the two link lines below on submit day, then delete this comment. -->
- **Demo video:** TODO(submission): video link
- **X post:** TODO(submission): X post link
- **Status (2026-11-09):** the first live pair opened (by the owner) and closed (by the loop) on mainnet, net
  -0.026 USD after fees; a second (MON, opened from the owner console) is held; no live margin rescue yet. The dated details are under [Status](#status-2026-11-04)

## 30 seconds for a judge

```bash
npm ci                     # the four workspaces from the lockfile; one zod advisory (see docs/reviewer-checks.md)
npm run ci -- --only npm   # ci: green - npm ci, build, test, typecheck (node tests 1527 + 525 + 233) in N s
npm run demo               # demo: ready. Open http://localhost:5190 (recorded mainnet data, nothing signed)
```

On chain: [the contract's last key deleted](https://nearblocks.io/txns/C3vpb1cvqJMG8ivPJV9nTeJX9XGGGTfQzH7QVYYuMY4E),
[`create_desk` deriving the venue accounts from MPC](https://nearblocks.io/txns/DMUGLvkVTtf6Atim4jneLvWTmFsbhfDetxcwgHCdWSfN),
[`fund_venue` paying a verified 1Click quote](https://nearblocks.io/txns/BvJDHBC2SoWduBCSYAynPX1QvYMmqhs8tf7T2HpcYMqi),
[`E_PRICE_BAND` on a deliberately mispriced test order](https://nearblocks.io/txns/33K2sHAd7TzJrEoAav6JymkuvPG7sUbtDcfRrPf74NSj),
and the [testnet attack run](#refusals-on-chain-npm-run-attack): 8 of 8 refused, 0 USDC moved, a tx per row.

## Does it make money?

**Not at the size it runs today.** Today's 38.68 USDC desk shows that the controls hold with real money; it is not
an income.

**What a pair earns:** the funding gap between the two venues while it is held, minus its round trip (four fills,
slippage on the order books and a buffer for the price gap between the venues), minus any cross-chain transfer of
margin. The round trip is paid once and funding comes in over time, so a pair pays only if the gap lasts. The
strategy loop opens one only when the gap, held for 7 days, is forecast to pay the round trip and still clear the
owner's minimum of 5 % net APR.

**Backtest** ([docs/backtest-checks.md](docs/backtest-checks.md#results-on-the-one-round-trip-2026-11-04-168-h-hold-10-bps-buffer)):
336 days of real funding history (2025-12-02 to 2026-11-04), run through the engine's own scanner, rules and costs
and today's order books. At 12 USD a leg, the live desk's size, those rules entered 3 pairs and netted 0.123 USD
(0.241 USD funding, 0.118 USD costs). At 1000 USD a leg they entered 2 pairs and netted 1.10 USD (7.58 USD funding,
6.48 USD costs), 0.55 USD a pair, holding a pair for 363 of the 8,080 hours checked.

**Not in the backtest:** moving margin between chains. On mainnet a 1Click transfer into Hyperliquid cost about
0.3 USDC, and the recorded transfer into Orderly on Arbitrum under 0.01 USDC; a withdrawal from Hyperliquid costs
1 USDC more. The engine budgets each transfer at a fixed part plus 20 bps of the amount. One transfer into
Hyperliquid costs more than the 12 USD desk netted in the whole backtest, and one withdrawal from Hyperliquid more
than an average 1000 USD pair netted.

**How much to read into it:** neither size tested (12 or 1000 USD a leg) is an income, and with 2 to 4 trades per
setting the numbers record the entry hurdle, not a strategy's return.

The main risks, and the guard for each:

- **One leg is liquidated.** The legs cancel on price, but each has its own margin on its own venue, so a sharp move
  can push one toward liquidation while the other gains. The risk engine reads the desk every 5 s and sets a rescue
  line for each leg (8 % from liquidation by default, wider when the market moves fast). A leg that crosses it gets
  USDC from the desk's reserve or the other leg through 1Click (the contract pays only the desk's own accounts, at
  most 50 USD an hour on this desk); if no route can pay, both legs are cut by the same size. Legs open at 2x
  leverage at most (the engine caps the owner's 3x setting), and at 1.5x where no live rescue route exists. No rescue
  has run on mainnet yet.
- **The spread flips.** The venue that paid can start charging. The loop exits after 6 hourly checks in a row of a
  flipped or shrunken spread, and closes both legs at once when the pair's loss reaches the owner's stop drawdown
  (10 % of a leg on this desk) or after 14 days.
- **A bad entry.** Before every entry and rotation the NEAR AI risk check reads the window's facts and can refuse it;
  it cannot pick a pair, a size or an order. It fails closed: only a readable pass lets the entry go ahead. With no
  answer within 15 s (asked twice), NEAR AI unreachable, or no working key, the entry is held, not passed: the
  journal says the risk check did not answer, and the window is asked again at the next hourly check. An answer that
  cannot be read counts as a refusal. Exits, stops, `POST /close`, `panic_close` and rescues never ask it, and none
  waits for it: a close, a drawdown or time stop, or a shutdown cancels an entry still waiting on its check, with
  nothing sent. Whatever the engine asks, the contract refuses an order above the policy's size caps, or on a priced
  symbol more than 1 % from the oracle price.

## What it does

Gimbal runs the whole loop with no private key for the venue accounts:

- **One NEAR contract owns the venue accounts.** Each desk's Hyperliquid and Orderly account (EVM) and its Phoenix
  account (Solana) are keys of NEAR's MPC network, derived for the contract. No private key for them exists anywhere.
- **The contract checks every order before it is signed.** It builds each Hyperliquid action and each Orderly request
  itself and parses every Solana transaction byte by byte, then checks it against the owner's policy, and only then
  asks the MPC network for a signature.
- **An engine trades it.** It ranks funding windows across venues after fees, slippage, basis and funding timing,
  opens both legs, holds them, exits or rotates, and books every hour of funding from the venues' own ledgers. It
  runs on mainnet; it held and closed its first live pair, which the owner opened by hand (see
  [Status](#status-2026-11-04)).
- **It moves its own margin.** When a leg nears liquidation, the engine moves USDC to it across chains through
  NEAR Intents (1Click); the contract verifies 1Click's quote signature and pays only the desk's own accounts. The
  payment path ran on mainnet; no rescue has run there yet.

## Why it matters

Guards on automated trading usually cap only how much may be spent. A trading desk needs more: an order inside a spending cap can
still be priced far from the market, sized past the plan, or open risk when it should only close. Gimbal's contract
checks the order itself, per venue, for every signature:

| Check | What the contract does | Refusal |
|---|---|---|
| Per-venue order parsing | builds Hyperliquid msgpack actions and EIP-712 digests and Orderly requests itself; decodes every Solana instruction against pinned programs and accounts (Phoenix, Ember, and token transfers only to the desk's own accounts or a verified 1Click address) | `E_ARGS`, `E_SOL_MESSAGE`, `E_SOL_PROGRAM`, `E_SOL_ACCOUNT` |
| Oracle price band | the limit price must be within `price_band_bps` of the stored OutLayer TEE oracle price, which must be younger than the policy's `oracle_max_age_s` (900 s on the mainnet desk) | `E_PRICE_BAND`, `E_ORACLE_STALE` |
| Notional cap | each order's notional, size × max(limit price, oracle price), is capped (`max_notional_usd`), and a sliding-hour meter caps the sum of orders that are not reduce-only, on all three venues (`max_hourly_notional_usd`) | `E_SIZE` |
| Pause and reduce-only | on a paused desk (after `panic_close` or the owner's pause) only orders flagged reduce-only and cancels are signed. The flag is part of the signed order, so the venue enforces it against the position; the contract cannot see positions. Reduce-only orders still pass the band and size checks but skip the hourly meter, so a desk can always close | `E_PAUSED` |
| Policy | only the assets and markets the owner listed | `E_ASSET` |
| Transfers | a 1Click quote is paid only if 1Click's signature verifies on chain and its recipient is one of the desk's own accounts (or the Orderly receiver the owner pinned); margin moves are capped per sliding hour by amount and cost | `E_QUOTE_SIGNATURE`, `E_QUOTE_FIELDS`, `E_RESCUE_CAP` |

Every rule and its code are in [docs/interfaces.md](docs/interfaces.md) §1.3 and §1.5; each has a contract unit test
that proves the refusal.

## How it works

```
 owner ──signs policy──▶ gimbal contract (NEAR) ──sign request──▶ MPC network (v1.signer)
                           ▲   builds / parses, checks             │ secp256k1 + Ed25519 signatures
 engine ──operator key────┘   policy, band, caps                   ▼
   scanner · strategy loop · risk engine · rescuer · position book   Hyperliquid · Orderly · Phoenix
   └──────────── margin moves: fund_venue / sol_sign_rescue / hl_withdraw + EIP-3009 ──▶ NEAR Intents 1Click
```

- **Contract** (`contract/`, logic in `contract/core/`). Desks, policies and every signing method. The engine calls
  it with a FunctionCall key on the owner's account limited to the 21 operator methods; that key can trade inside the
  policy and move margin between the desk's own accounts, and cannot pay anyone else, change the policy or resume a
  paused desk. Every action is a NEP-297 event.
- **Engine** (`engine/`). The scanner reads funding, books and fees on Hyperliquid, Phoenix and Orderly (and 23
  watch-only venues for context) and ranks windows by net APR over the hold, with 7-day and 14-day funding history.
  The risk engine reads the desk every 5 s and sets each leg's watch and rescue lines from its distance to
  liquidation and recent volatility (`engine/src/risk/thresholds.ts`).
- **Strategy loop** (`engine/src/strategy/`). After each scan and each funding payment it decides: enter, hold, exit,
  rotate or wait. Entry needs 3 hourly checks in a row and exit 6 (owner settings, `enterAfterChecks` and
  `exitAfterChecks`, picked on [a backtest](docs/backtest-checks.md)); then a 6 h cooldown, a 14-day time stop and at
  most 2 rotations a day. The pair is the top allowed window; its size is the smallest of the owner's leg size, the
  policy cap less the band, free margin and book depth, in whole lots. Before every enter and rotate the **NEAR AI
  risk check** reads the window's facts and may refuse it (held out for 6 h); only a readable pass lets the act go
  ahead, and no answer holds it until the next hourly check (no 6 h hold). It cannot pick a pair, a size or an
  order, and nothing it returns reaches the contract or a venue. By default the pair is short Hyperliquid and long
  Phoenix. With `GIMBAL_ORDERLY_PAIRS=1` (off in the code by default; on in the mainnet engine since 2026-11-04) it
  can be any two of Hyperliquid, Orderly and Phoenix, in the direction the window pays. The pair opens maker first on
  Hyperliquid (post-only) when Hyperliquid is a leg, then the other leg as IOC; Orderly takes IOCs only. The loop
  moves money only with `GIMBAL_TRADE=1` and auto turned on by the owner.
- **Owner demo entry** (`POST /rotate` with `demo: {maxLossUsd}`, [docs/deploy-railway.md](docs/deploy-railway.md)).
  One small real pair the owner asks for, to show the loop: only the profit checks are waived (the spread need not
  cover the round trip); the policy, the NEAR AI risk check (never waived: no answer holds the entry), sizing, a flat
  desk and funding not against the position still count, and its estimated round trip may cost at most 1 USD. It has never opened a pair (two tries on
  2026-11-05 were refused by the engine's checks; nothing was signed). Such an entry is labeled an owner demo entry in
  the journal, the book and the risk ledger.
- **Rescue** (`engine/src/rescue/`). When a leg crosses its rescue line, the rescuer pays it from the first source that
  can: the desk's idle USDC on NEAR (`fund_venue`), free margin on the other leg (`sol_sign_rescue` out of Phoenix, or
  `hl_withdraw` and an EIP-3009 transfer out of Hyperliquid), else it cuts both legs reduce-only by the same size. A
  route whose fees exceed 10 % of the amount is skipped. One rescue at a time, payments held across restarts until the
  chain proves them settled or impossible.
- **Position book** (`engine/src/book/`). Every position the loop holds: entry, hourly funding per leg read from the
  venues' ledgers (never estimated), fees from fills, transfers, exit and reason, net USD and actual APR against the
  forecast. `npm run report` prints it.

Which rescue routes run live on mainnet and which only in replay: [docs/rescue-routes.md](docs/rescue-routes.md).

## Live on mainnet

The contract is [`gimbal_dex.near`](https://nearblocks.io/address/gimbal_dex.near). It has no access keys, so nobody
can change its code, sign for it or move its NEAR; only the contract's own methods run.

The code on chain has code_hash `8SJ968Gyuwx9PAkU3v2ujJcdC7As4KX5SrqE8eqaQKaR` (sha256
`6e7cb556b86ab64414196d76243bce6e04bd9a5da0ce49b7093a0d279cc15482`, 675,664 bytes). Its NEP-330 `build_info`
names a reproducible build of commit
[`eed9a99`](https://github.com/winchxyz/gimbal/tree/eed9a9930306cd61f6219f53a2c34afd5e7c731c) in the image
`sourcescan/cargo-near:0.22.0-rust-1.99.1@sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb`.
To check it, run `cargo near build reproducible-wasm` in `contract/` at that commit and compare the sha256.

**Desk `carry`** on `gimbal_dex.near` runs under the policy
[tools/mainnet-final-policy.json](tools/mainnet-final-policy.json) (20 USD per order, price band 100 bps, rescues at
most 50 USD per hour), plus unpriced symbols (no oracle price, so a size cap each and a 20 USD cap): three since
2026-11-05, 16 since 2026-11-09, when the owner also widened the lists to 23 Hyperliquid assets, 15 Phoenix markets
and 21 Orderly symbols. The canary `gimbal-canary2.near`, an earlier
build, carried the first real money around the full path NEAR → Hyperliquid → Arbitrum → NEAR for 1.32 USDC.
The transactions of the contract, the desk and the canary, with what each proves:
[docs/onchain-evidence.md](docs/onchain-evidence.md).

<a id="status-2026-11-04"></a>

## Status (2026-11-07)

Done (read from the chain and the venues' public APIs at about 08:10 UTC on 2026-11-07; the 2026-11-09 item on
2026-11-09):

- The contract code is frozen after three internal review rounds (no external audit), deployed from a reproducible
  build and locked.
- Desk `carry` is set up on all three venues and funded (38.68 USDC deposited): 7.64 USDC on Hyperliquid, 9.76 USDC
  on Phoenix, 12.99 USDC sent to Orderly, 7.68 USDC idle on NEAR as the rescue reserve; 38.08 USDC in all after the
  transfer costs and the first pair.
- The engine runs on a server (`docs/deploy-railway.md`) with the operator key and a gas-only relayer wallet, with
  the strategy loop on, live rescue enabled and, since 2026-11-04, Orderly pairs on (one Orderly session signed on
  chain at every engine start). Its NEAR AI model is `Qwen/Qwen3-VL-30B-A3B-Instruct`, for policy drafts and the
  risk check.
- **The first live pair ran its whole cycle.** XLM, 74 a leg (about 11.4 USD), short on Hyperliquid, long on
  Phoenix. The owner opened it by hand on 2026-11-06 05:04 UTC as an owner demo entry, forecast at -3.3 % net APR
  after costs, below any threshold the loop would open on (the profit checks are waived; the contract still checked
  every order against the policy) and, to close it after about a day, set a temporary rule for it: a 1000 % net
  minimum, exit after 24 hourly checks under it. The strategy loop held it 27 hours, booked each funding hour from
  the venues' ledgers, and closed both legs under that rule on 2026-11-07 08:03 UTC, when by its own numbers the
  pair's forward rate was still 5.1 % net APR after exit costs: three post-only Hyperliquid buys did not fill, a reduce-only taker buy did, then
  Phoenix by a reduce-only IOC. Booked result (funding read to 07:00 UTC; the last hour was still settling):
  funding +0.0085 USD, fees -0.0169 (entry 0.0068, exit 0.0101), price -0.0178 (the entry and exit fills gave up about
  0.00024 USD per XLM in spread and basis between the two venues), net -0.026 USD. The transactions:
  [docs/onchain-evidence.md](docs/onchain-evidence.md#mainnet-desk-carry).
- **2026-11-09: a second live pair, opened from the owner console.** The owner widened the desk's policy on chain
  (16 unpriced symbols; 23 Hyperliquid assets, 15 Phoenix markets, 21 Orderly symbols), then opened MON from the hosted
  demo with the owner token: 716 MON a leg (about 11.5 USD), short on Hyperliquid, long on Phoenix, about 40 % net
  APR forecast at entry, NEAR AI risk check passed. The Hyperliquid post-only order was repriced three times before it
  filled as maker at 0.016013; Phoenix filled by IOC at 0.016012; entry fees 0.0068 USD. The strategy loop holds it.
  The transactions: [docs/onchain-evidence.md](docs/onchain-evidence.md#mainnet-desk-carry).
- On testnet the same contract code refused 8 of 8 scripted malicious requests, 0 USDC moved
  ([below](#refusals-on-chain-npm-run-attack)).
- On mainnet `gimbal_dex.near` refused a deliberately mispriced test Hyperliquid order with `E_PRICE_BAND`
  (2026-11-04 07:00:43 UTC, in the desk table of [docs/onchain-evidence.md](docs/onchain-evidence.md#mainnet-desk-carry)).
- The NEAR AI risk check runs on the mainnet engine before every enter and rotate and fails closed: each ask waits
  15 s and is asked once more; with still no answer (or no working key) the entry is held, not passed, and the
  journal says "the NEAR AI risk check did not answer ... held, not passed: the act waits"; the window is asked
  again at the next hourly check, with no 6 h hold. `npm run report` books every outcome (refusals as helped or hurt,
  estimated); each pass shows the position its act opened, with that position's net.

Not done yet:

- **The strategy loop has not opened a pair on its own.** The owner's threshold is 5 % net APR at 12 USD a leg,
  the loop opens only a window inside the desk's policy, and only after it holds for 3 hourly checks in a row. Both live
  pairs so far were owner demo entries.
- **No margin rescue has run on mainnet yet.** The desk's rescue counters on chain are zero; the three `fund_venue`
  payments were setup transfers, not rescues. The live routes have
  been dry-run against mainnet; the money path itself ran on the canary
  ([docs/onchain-evidence.md](docs/onchain-evidence.md#mainnet-canary-gimbal-canary2near)).
- The money is small on purpose. At 12 USD a leg, funding earns about a cent a day while each one-off transfer costs
  about 0.3 USDC into Hyperliquid (under 0.01 into Orderly), plus 1 USDC to withdraw from Hyperliquid, so the desk's
  record will stay negative through Nov 14; the book shows funding and costs apart.

## Run it

Node 24 with npm; nothing installed globally. Rust with cargo-near only to build or test the contract.

### Demo: `npm run demo`

```bash
npm ci
npm run demo
```

`npm run demo` ([tools/demo.mjs](tools/demo.mjs)) starts the engine in replay mode and the dashboard, waits until both
answer, and prints the URL. Replay plays a recorded hour of mainnet venue answers (2026-10-31, 16:15 to 17:19 UTC,
`engine/fixtures/replay/`) at ×10 through the real scanner, strategy loop and risk engine, under the final mainnet
policy, with legs of 12 USD and auto on. The strategy loop trades a simulated 40 USD replay desk (10 USD on
Hyperliquid, 10 USD on Phoenix, 20 USD in reserve) that fills at the recorded best bid and ask with the venues' taker
fees. The recorded hour is too short for the loop to enter or exit on its own, so a short script, labelled on the
Journal, plays the owner's demo entry and close. It needs no keys and no chain: a replay has no contract, so nothing is
signed or sent, and the demo drops every key and chain variable of your shell. The engine's state goes to a temp folder
that is removed on exit. Ports 5190 (dashboard) and 8790 (engine) must be free; `npm run demo -- --web-port <n>` moves
the dashboard (the engine's allowed browser Origin follows it) and `--engine-port <n>` the engine.

| Do | You see |
| --- | --- |
| `npm run demo` | within a few seconds `demo: engine rules set: legs 12 USD at up to 3x, enter above 5 % net APR, auto on` (the engine caps legs at 2x), then `demo: ready. Open http://localhost:5190` |
| Open http://localhost:5190 | **Desk**: a Replay badge and the flat 40 USD replay desk. Within about a minute the script's owner demo entry tries the windows the policy allows: ZEC and BTC are refused at 12 USD legs (a ZEC lot is over a leg; BTC's whole lots size a leg under the 10 USD venue minimum), and SOL enters, short Hyperliquid and long Phoenix, 0.12 SOL a leg at recorded prices. Latest keeps the labels in view: "owner demo entry: the profit checks are waived", and SOL's spread pays the other way this hour, so "the demo shows the cycle, not a profit" |
| Click **Windows** | every window by net APR after costs, the held SOL window marked Held, and NEAR refused because it is not in the policy; the selected one shows its costs from gross to net and its checks |
| Click **Journal** | the whole loop in order: the script's lines, the two sizing refusals, the open (the recording holds no NEAR AI risk check reply for its prompt, so its line says "passed in replay only; live, the entry would wait"), one hourly funding line at 17:00, the scripted close at 17:05 (`POST /close`, as the owner would) with the realized net, about −$0.02 (funding, fees, price), and the counters: "N simulated actions. Nothing signed or sent." |
| Click **Rescue**, then **Run a stress test** while the pair is held (about 30 s to 5 min after the start) | the Hyperliquid short comes inside a line the stress test raised to just above its distance ("The stress test raised this leg's rescue line from your 8% to …"), and steps 1 Detect to 7 Landed run on recorded mainnet 1Click answers, Verify and Sign saying what the contract would do (replay: no contract, nothing signed). The recorded quote moves a fixed $20 from the reserve, more than the leg needs, and its 0.52 USD fee is the recording's, not the engine's estimate; it lands in about 1 min 40 s of replay time and Earlier rescues lists it, marked "no funds moved" |
| Click **Security** | "0 private keys exist for this desk", how an order gets signed, and what the operator can and cannot do; the policy and key panels say a replay has no contract to read |
| Ctrl+C in the terminal | both stop, and the temp state folder is removed |

### For reviewers

Every check a reviewer can run from a fresh clone, with no key, account or chain, and what each prints when it
works (the reproducible run, rule Q-012): [docs/reviewer-checks.md](docs/reviewer-checks.md).

### Read the mainnet desk (no keys)

```bash
near contract call-function as-read-only gimbal_dex.near config json-args '{}' network-config mainnet now
near contract call-function as-read-only gimbal_dex.near get_desk json-args '{"desk_id":"carry"}' network-config mainnet now
near contract call-function as-read-only gimbal_dex.near get_desk_counters json-args '{"desk_id":"carry"}' network-config mainnet now
```

### Testnet

The frozen contract code also runs on NEAR testnet, with the same wasm and Mock prices. Its deploy, its first MPC
signature and the scripts to make your own desk there: [docs/onchain-evidence.md](docs/onchain-evidence.md#testnet).

### Refusals on chain: `npm run attack`

`npm run attack` sends a scripted list of malicious operator requests to a desk with the operator key and prints
PASS/FAIL, the refusal code and the NEAR transaction, then compares the desk's NEAR ledger and Hyperliquid account
value before and after. A row passes only on exactly its expected refusal. It refuses mainnet unless started with
`--mainnet`; `--dry` builds every request and sends nothing. Flags are at the top of
[engine/src/mcp/attack-cli.ts](engine/src/mcp/attack-cli.ts).

```bash
npm run attack -w engine -- --contract <contract> --desk <desk> --dry
```

**Recorded live run**, 2026-11-03 16:05 UTC, desk `final-1` on the testnet deploy: 8 of 8 PASS,
`0 USDC moved (NEAR ledger + Hyperliquid account)`. Each attack, its refusal code and its transaction:
[docs/onchain-evidence.md](docs/onchain-evidence.md#refusals-on-chain-the-recorded-attack-run).

The desk is also a stdio MCP server with five tools (`read_desk`, `place_hl_order`, `fund_venue`, `withdraw`,
`try_attack`; `npm run mcp -w engine`, configured by `GIMBAL_CONTRACT_ID`, `DESK_ID`, `NEAR_NETWORK` and the
operator key file). Each tool returns the contract's answer: a result, or a refusal with its code and transaction.

## NEAR features used

| Feature | Where | What for |
|---|---|---|
| Chain Signatures (MPC, `v1.signer`) | `contract/src/mpc.rs`, `contract/src/hl.rs`, `contract/src/orderly.rs`, `contract/src/sol.rs` | signs Hyperliquid and Orderly EIP-712 (secp256k1), Orderly API requests and Solana transactions (Ed25519), and Arbitrum USDC transfers (EIP-3009) |
| NEAR Intents / 1Click | `contract/core/src/oneclick.rs`, `contract/src/rescue.rs`, `engine/src/rescue/` | cross-chain margin moves; the quote signature is checked on chain |
| FunctionCall access keys | `docs/interfaces.md` §1.3 | the engine's key can call only the operator methods and cannot attach deposits |
| NEP-297 events | `contract/src/events.rs` | an auditable on-chain journal |
| OutLayer TEE price oracle | `contract/src/prices.rs`, `contract/core/src/oracle.rs` | the price band on every order |
| NEAR AI Cloud | `engine/src/nearai/`, `engine/src/strategy/` | drafts the desk policy from the owner's words (the owner signs it); the NEAR AI risk check before every enter and rotate, which can only refuse and fails closed (no answer holds the act). Never in the signing path |

## Security model

The contract builds every payload the desk's MPC keys sign and refuses anything outside the owner's policy;
[docs/interfaces.md](docs/interfaces.md) §1.3 and §1.5 list each rule and its refusal code, and the contract's unit
tests pin them. The operator key (a FunctionCall key on the owner's account) can trade inside the policy and move
margin between the desk's own venue accounts; it cannot pay anyone else, change the policy or resume a paused desk.
The full text, with each bound and why it is accepted, is in [docs/security.md](docs/security.md).

**What cannot be stolen.** There is [no key to leak](docs/security.md#no-key-to-leak): the venue accounts are MPC
keys of the contract, and the engine holds only the operator key and a gas-only relayer wallet that never holds desk
money. [Owner methods stay the owner's](docs/security.md#owner-methods-stay-the-owners): each needs a deposit a
FunctionCall key cannot attach. [Money moves only to the desk's own accounts](docs/security.md#money-moves-only-to-the-desks-own-accounts-with-two-owner-side-exceptions)
(a 1Click quote is paid only when its signature verifies on chain), except the owner's pinned Orderly receiver and
refunds [to the owner](docs/security.md#out-to-the-owner-only); transfers out of a venue are [capped per sliding
hour](docs/security.md#how-fast). A [rogue operator](docs/security.md#what-a-rogue-operator-can-still-do), or a stolen
server key, can lose money inside those bounds and nothing more.

**Accepted risks and bounded residuals** ([docs/security.md](docs/security.md#accepted-risks)). The largest:
[wash trading](docs/security.md#wash-trading) at the band's edges, about 2 × `max_hourly_notional_usd` ×
`price_band_bps` / 10⁴ an hour, because reduce-only closes skip the hourly meter; the
[1Click `appFees` skim](docs/security.md#1click-appfees-skim), at most 1 USDC + 25 bps a quote; an
[Orderly order repeat](docs/security.md#orderly-order-repeat) for 300 s, only from the IPs the owner listed; and
unpriced symbols (owner-listed, [docs/interfaces.md](docs/interfaces.md) §1.2), which trade without the band under
their own size cap. The rest are listed there with their own bounds.

## Fees

10% of profit above the owner's high-water mark, charged by the contract when profit is paid out;
0.01% per Hyperliquid fill through Hyperliquid's builder code; and 0.01% per Orderly taker fill as Gimbal's
Orderly broker markup (maker fills carry none). Nothing on deposits, margin rescues or
losses; no management fee. Every charge is a `fee_charged` event on NEAR. Each desk also uses the referral
codes fixed in the contract's config, where a venue has one: on Hyperliquid the desk pays 4% less in fees, and
Hyperliquid pays the code's owner 10% of the fees the desk pays.

## Limits

- **Not for speed.** An MPC signature usually takes 5–6 s; one took 120 s on mainnet. A rescue is sized to land
  within about 3 minutes (the slow signature plus the slow 1Click transfer), so the rescue line sits far from
  liquidation (8 % by default).
- **Small carries.** Funding spreads on liquid coins are small, and 1Click fees are roughly flat per transfer
  (about 0.3 USDC into Hyperliquid, under 0.01 into Orderly, plus 1 USDC to withdraw from Hyperliquid), so small desks lose a large share of a transfer
  ([Does it make money?](#does-it-make-money)).
- **Orderly is a trading venue without a live rescue.** Orderly pairs run only with `GIMBAL_ORDERLY_PAIRS=1`
  (off in the code by default, on in the mainnet engine since 2026-11-04); without it the desk trades short
  Hyperliquid and long Phoenix only. No rescue can move margin into Orderly live yet (the Orderly routes run in
  replay; Hyperliquid → Orderly is not built; the owner funds it with a one-off `fund_venue`), and Orderly is never a
  rescue source, so an Orderly leg is opened at 1.5x at most. It takes IOC orders only. A pair with an Orderly leg is
  not rotated out of: it is held until its own exit. Money comes back out of Orderly through the one-shot
  `GIMBAL_ORDERLY_WITHDRAW` run ([docs/deploy-railway.md](docs/deploy-railway.md#bringing-usdc-back-from-orderly)),
  which needs every Orderly position flat and no trading loop.
- **No testnets for part of the path.** Phoenix and 1Click have no testnet, so those run live only on
  mainnet and are replayed elsewhere.
- **Trust.** Gimbal trusts NEAR's MPC network, the OutLayer oracle, 1Click and the venues themselves.

## Roadmap (after the hackathon)

Nothing in this section is built. Every item keeps the rule Gimbal already follows: a venue joins only if the
contract itself can sign its orders and check each one against the owner's policy.

- **More markets on Hyperliquid.** Hyperliquid's builder-deployed (HIP-3) markets, such as trade.xyz's equities and
  commodities, are signed the same way as Hyperliquid's own. The scanner already reads them as watch-only venues,
  and the contract already accepts their asset ids. What they still need:
  - a trusted price for each. The oracle lists none of them, so today they could enter only as unpriced symbols;
  - USDC moved into each market's own balance;
  - each market's margin mode and collateral checked.

  Some of the widest funding gaps on the Windows screen show up on new, thin listings. A gap is a snapshot, and
  each needs its history and depth checked before a policy lists it.
- **More on-chain perp venues.** Venues whose orders are signed with a key NEAR's MPC network can hold (secp256k1
  or Ed25519). Each one needs its own order builder, digest and policy check in `contract/core`, the way Phoenix
  and Orderly were added. Lighter is not one yet: its orders use a Schnorr key on a curve the MPC network does not
  sign with.
- **A prediction-market module.** The desk would buy "yes" on one market and "no" on another when the two prices of
  the same event add up to less than 1. Polymarket fits first: its orders are EIP-712 messages that an MPC-derived
  EVM key can sign. It needs setup the desk does not have yet: USDC and gas on Polygon, one-time token approvals,
  and API credentials the engine holds, which authenticate requests but cannot sign orders. The risks differ from
  a funding carry. Two venues can resolve the same question differently,
  and the money stays locked until the event resolves. So the policy would list events and their resolution
  sources, not coins.
- **Not planned: centralized exchanges and bookmakers.**
  - A centralized exchange trades through an API secret on a KYC account. The secret cannot live in a contract, so
    no policy could check its orders. Holding it in a TEE is possible, but that is a weaker, different guarantee.
    Kalshi is an exchange of this kind.
  - Most sports bookmakers forbid arbitrage in their terms and limit the accounts that do it.

## Repo map

| Folder | What |
|---|---|
| `contract/core/` | `gimbal-core`: pure Rust logic (decimals, policy checks, venue builders and digests, Solana parser, 1Click quote verification) |
| `contract/` | the `gimbal` NEAR contract: desks, MPC calls, money methods, events |
| `engine/` | TypeScript engine: venue readers, scanner, strategy loop, risk engine, rescue, position book, journal, HTTP/SSE server, replay, MCP server |
| `web/` | the dashboard: Windows, Desk, Journal, Rescue, Security and onboarding screens; `shared/` holds the types it shares with the engine |
| `tools/` | mainnet and testnet scripts (dry run by default), policies, and the runbook [tools/mainnet/README.md](tools/mainnet/README.md) |
| `docs/`, `design/` | [interfaces.md](docs/interfaces.md) (every method, rule, refusal code and event), [security.md](docs/security.md), [onchain-evidence.md](docs/onchain-evidence.md) (the transactions behind each claim), [reviewer-checks.md](docs/reviewer-checks.md), [rescue-routes.md](docs/rescue-routes.md), [backtest-checks.md](docs/backtest-checks.md), the server setup; the designer's tokens and mockups |

## Built with

The code was written with Claude Code.

**Timeline (rules Q-001 to Q-003).** The first commit, `eb66ed1`, is from 2026-10-30, inside the build window
(Oct 19 to Nov 14); every commit in the history is from the window. No code written before the window is in this
repository. Before the first commit, from 2026-10-20, the builder wrote throwaway experiments and the test-vector
generators outside the repository; only the generators' outputs, the JSON vectors, are committed.

**Main dependencies** (Q-005), at the versions in `contract/Cargo.lock` and `package-lock.json`:

| Package | Version | Used for |
| --- | --- | --- |
| near-sdk (Rust) | 5.29.1 | the contract; feature `unstable` only for `env::ecrecover`, which checks the MPC signatures |
| borsh, serde, serde_json (Rust) | 1.8.1, 1.0.229, 1.0.154 | the contract's state and 1Click quote JSON in `gimbal-core` |
| hex, bs58 (Rust) | 0.4.3, 0.5.1 | address and signature encodings |
| sha2, sha3, curve25519-dalek, ed25519-dalek (Rust, tests only) | 0.10.9, 0.10.9, 4.1.3, 2.2.0 | hashes, the Solana off-curve cross-check and 1Click signature checks in tests; the contract uses NEAR's host functions |
| viem | 2.57.7 | EVM signing and encoding: Hyperliquid wire, Arbitrum USDC transfers, the relayer |
| @ellipsis-labs/rise | 0.6.2 | the Phoenix SDK: Phoenix orders, deposits, withdrawals and setup |
| near-api-js | 7.3.1 | the engine's NEAR calls and the `npm run attack` script |
| @modelcontextprotocol/sdk, zod | 1.32.1, 4.4.3 | the desk's MCP server |
| react, react-dom | 19.3.1 | the dashboard |
| vite, @vitejs/plugin-react | 8.3.5, 6.1.2 | the dashboard's dev server and build |
| @hot-labs/near-connect | 0.12.0 | wallet sign-in for onboarding |
| @noble/hashes | 2.4.0 | onboarding: the desk's addresses computed from the MPC keys, the way `create_desk` checks them |
| typescript, @types/node | 7.0.2, 24.19.2 | type checking; the engine runs its TypeScript directly on Node 24 |

**Test vectors and fixtures.** The contract's vectors (`contract/core/tests/vectors/`) were generated by scripts
that call each venue's own SDK and cross-check in a second language; each file names its generator and references,
among them nktkas/hyperliquid 0.33.3, hyperliquid-python-sdk 0.24.0, ethers 6.17.0, viem 2.57.7, the Orderly docs,
defuse-protocol/one-click-sdk-typescript 0.1.26 with live 1Click quotes of 2026-10-27, ellipsis-labs/rise 0.6.2,
solana/web3.js 1.99.0 and solana/kit 8.5.0. `solana-review.json` holds review cases, each one message of
`solana.json` edited, written by the contract's own tests. The engine's fixtures (`engine/fixtures/`) are mostly
recorded answers from the venues, 1Click and NEAR on mainnet and testnet (2026-10-30 to 2026-11-03), dated in
their file names; a few are generated by a venue SDK or the contract's tests, and the three hand-written ones (a book
ledger and two NEAR AI answers) are named `SYNTHETIC`.

## License

Business Source License 1.1 (see `LICENSE`). Free for evaluation, testing, research and judging, and for
running desks that hold only your own funds; offering it to others as a hosted, managed or operated service needs permission.
It becomes MIT on 2028-11-14. Why BSL: anyone can read, check and run the code on their own money today, while a
hosted Gimbal that others run for third parties needs the builder's permission until that date.
