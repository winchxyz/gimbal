# Gimbal

**Autonomous funding-carry desk: a keyless NEAR contract that is built to trade perps on Hyperliquid, Phoenix and
Orderly and to move its own margin across chains before a leg is liquidated.**

**Guards cap what an agent spends. Gimbal checks every order it signs.**

Live on mainnet: a locked contract with no access keys, desk accounts on all three venues set up with MPC signatures
the contract built, three 1Click payments whose quote signatures it verified, an on-chain refusal, and the engine
running against the desk. Not yet: a live pair or a live rescue (on-chain counters 0; [Status](#status-2026-11-04)).

Tracks: DeFi (main); Agents and Security. Built for NEAR HACKATHON, Nov 1–14, 2026, by winch
([@winchxyz](https://x.com/winchxyz)). This repository started on Oct 30, 2026, inside the build window (Oct 19 to
Nov 14, rule Q-001 of the hackathon).

<!-- SUBMISSION: fill the three lines below on submit day, then delete this comment. -->
- **Demo video:** TODO(submission): video link
- **X post:** TODO(submission): X post link
- **Status:** TODO(submission): one line read from the chain on submit day (for example the first live pair or the
  first live rescue); the dated details are under [Status](#status-2026-11-04)

## 30 seconds for a judge

```bash
npm ci                     # the four workspaces from the lockfile; npm audit's 2 "high" are one zod advisory (below)
npm run ci -- --only npm   # ci: green - npm ci, build, test, typecheck (node tests 1426 + 504 + 233) in N s
npm run demo               # demo: ready. Open http://localhost:5190 (recorded mainnet data, nothing signed)
```

On chain: [the contract's last key deleted](https://nearblocks.io/txns/C3vpb1cvqJMG8ivPJV9nTeJX9XGGGTfQzH7QVYYuMY4E),
[`create_desk` deriving the venue accounts from MPC](https://nearblocks.io/txns/DMUGLvkVTtf6Atim4jneLvWTmFsbhfDetxcwgHCdWSfN),
[`fund_venue` paying a verified 1Click quote](https://nearblocks.io/txns/BvJDHBC2SoWduBCSYAynPX1QvYMmqhs8tf7T2HpcYMqi),
[`E_PRICE_BAND` on a deliberately mispriced test order](https://nearblocks.io/txns/33K2sHAd7TzJrEoAav6JymkuvPG7sUbtDcfRrPf74NSj),
and the [testnet attack run](#refusals-on-chain-npm-run-attack): 8 of 8 refused, 0 USDC moved, a tx per row.

## What it does

A funding carry is two positions that cancel out: short a perp on the venue that pays high funding, long the same
coin on a venue that pays less, and collect the difference every hour. It breaks in two ways: one leg is liquidated
because its margin sits on the wrong venue, and whoever runs it holds keys to both accounts.

Gimbal runs the whole loop without a private key:

- **One NEAR contract owns the venue accounts.** Each desk's Hyperliquid and Orderly account (EVM) and its Phoenix
  account (Solana) are keys of NEAR's MPC network, derived for the contract. No private key for them exists anywhere.
- **The contract checks every order before it is signed.** It builds each Hyperliquid action and each Orderly request
  itself and parses every Solana transaction byte by byte, then checks it against the owner's policy, and only then
  asks the MPC network for a signature.
- **An engine trades it.** It ranks funding windows across venues after fees, slippage, basis and funding timing,
  opens both legs, holds them, exits or rotates, and books every hour of funding from the venues' own ledgers. It
  runs on mainnet; it has not opened a live pair yet (see [Status](#status-2026-11-04)).
- **It moves its own margin.** When a leg nears liquidation, the engine moves USDC to it across chains through
  NEAR Intents (1Click); the contract verifies 1Click's quote signature and pays only the desk's own accounts. The
  payment path ran on mainnet; no rescue has run there yet.

## Why it matters

Agent guards usually cap what an agent may spend. A trading desk needs more: an order inside a spending cap can
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
  risk check** reads the window's facts and may refuse it (held out for 6 h); it cannot pick a pair, a size or an
  order, and nothing it returns reaches the contract or a venue. By default the pair is short Hyperliquid and long
  Phoenix. With `GIMBAL_ORDERLY_PAIRS=1` (off in the code by default; on in the mainnet engine since 2026-11-04) it
  can be any two of Hyperliquid, Orderly and Phoenix, in the direction the window pays. The pair opens maker first on
  Hyperliquid (post-only) when Hyperliquid is a leg, then the other leg as IOC; Orderly takes IOCs only. The loop
  moves money only with `GIMBAL_TRADE=1` and auto turned on by the owner.
- **Owner demo entry** (`POST /rotate` with `demo: {maxLossUsd}`, [docs/deploy-railway.md](docs/deploy-railway.md)).
  One small real pair the owner asks for, to show the loop: only the profit checks are waived (the spread need not
  cover the round trip); the policy, the NEAR AI risk check, sizing, a flat desk and funding not against the position
  still count, and its estimated round trip may cost at most 1 USD. It has never opened a pair (two tries on
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

### Rescue routes: live on mainnet or replay only

On mainnet `serve` moves real money only with `GIMBAL_RESCUE=1`, and only on the routes marked live; it prints the
list at start. Steps and checks: [tools/mainnet/README.md](tools/mainnet/README.md), "The live rescue".

| route | on mainnet | how |
|---|---|---|
| reserve (the desk's idle USDC on NEAR) → Hyperliquid | live | `fund_venue` into HyperCore USDC |
| reserve → Phoenix | live | `fund_venue` into the desk's Solana USDC, then a deposit into Phoenix |
| Phoenix → Hyperliquid | live | one Solana transaction (`sol_sign_rescue`) to the 1Click deposit address |
| Hyperliquid → Phoenix | replay only | wired (`hl_withdraw`, `evm_usdc_to_intents`, the deposit), not yet dry-run on mainnet |
| reserve or Phoenix → Orderly | replay only | an Orderly landing needs Orderly's private API, which the rescuer does not read yet (the owner's one-off `fund_venue` to Orderly is below) |
| Hyperliquid → Orderly | not built | Arbitrum USDC into Arbitrum USDC, which 1Click does not quote |

The Phoenix routes also need a Solana RPC that serves transaction history; without one `serve` refuses them and
says why. A leg without a live rescue route is opened at 1.5x leverage at most (`engine/src/trade/carry-plan.ts`).

## Live on mainnet

The contract is [`gimbal_dex.near`](https://nearblocks.io/address/gimbal_dex.near). It has no access keys, so nobody
can change its code, sign for it or move its NEAR; only the contract's own methods run.

| Action | Time (UTC) | NEAR tx | What it proves |
| --- | --- | --- | --- |
| account created | 2026-11-03 19:34:31 | [GwzYcqsg…](https://nearblocks.io/txns/GwzYcqsgQMZ4Tv6DV79Hhz4Nj9uLjwerpMfHvrjMWHGr) | the contract account exists |
| code deployed, `new()` called | 2026-11-03 19:34:37 | [5xJqg6NR…](https://nearblocks.io/txns/5xJqg6NRApFngnzTDM12ZNH6r2sT5G2zqwrd8Co9MZP9) | the reproducible wasm below is the code on chain |
| last key deleted (locked) | 2026-11-03 19:37:15 | [C3vpb1cv…](https://nearblocks.io/txns/C3vpb1cvqJMG8ivPJV9nTeJX9XGGGTfQzH7QVYYuMY4E) | nobody can upgrade or drain the contract |

The code on chain has code_hash `8SJ968Gyuwx9PAkU3v2ujJcdC7As4KX5SrqE8eqaQKaR` (sha256
`6e7cb556b86ab64414196d76243bce6e04bd9a5da0ce49b7093a0d279cc15482`, 675,664 bytes). Its NEP-330 `build_info`
names a reproducible build of commit
[`eed9a99`](https://github.com/winchxyz/gimbal/tree/eed9a9930306cd61f6219f53a2c34afd5e7c731c) in the image
`sourcescan/cargo-near:0.22.0-rust-1.99.1@sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb`.
To check it, run `cargo near build reproducible-wasm` in `contract/` at that commit and compare the sha256.

**Desk `carry`** on `gimbal_dex.near`, policy [tools/mainnet-final-policy.json](tools/mainnet-final-policy.json)
(20 USD per order, price band 100 bps, oracle at most 900 s old, rescues at most 50 USD per hour, opening orders at
most 300 USD per hour), plus since 2026-11-05 three unpriced symbols (the `set_policy` row):

| Action | Time (UTC) | NEAR tx | What it proves |
| --- | --- | --- | --- |
| `create_desk` | 2026-11-03 19:46:16 | [DMUGLvkV…](https://nearblocks.io/txns/DMUGLvkVTtf6Atim4jneLvWTmFsbhfDetxcwgHCdWSfN) | the desk's EVM and Solana accounts are derived from the MPC network for this contract (two `derived_public_key` calls); no key was created |
| USDC deposit | 2026-11-03 19:51:13 | [5wA87LhQ…](https://nearblocks.io/txns/5wA87LhQuMYHYK3TzdabTdYuQmbWCbW3v3ARDLdebJiE) | USDC on NEAR is booked to the desk (`ft_on_transfer`) |
| `orderly_register`, `orderly_add_key` | 2026-11-03 19:55:48 | [CkzBDxER…](https://nearblocks.io/txns/CkzBDxERRpqnDY4rvBDjqFhy6sgx5ehA9dizqA4nszJj), [8azYasTE…](https://nearblocks.io/txns/8azYasTEYXdTXSoo7P9nFF2mQZzyMhnQ4K5WCfut7GJs) | MPC signs Orderly EIP-712 messages the contract built: the account under broker `gimbal_dex` and its Ed25519 key |
| `sol_sign_register` | 2026-11-03 19:57:44 | [9YCsKaxv…](https://nearblocks.io/txns/9YCsKaxvBGJ3Tb12jMGDgmwZSpFdbjhzbzyjrFDjwqhU) | MPC signs a Phoenix registration transaction the contract parsed |
| `fund_venue` to Hyperliquid | 2026-11-03 20:09:15 | [BvJDHBC2…](https://nearblocks.io/txns/BvJDHBC2SoWduBCSYAynPX1QvYMmqhs8tf7T2HpcYMqi) | the contract verified a signed 1Click quote and paid it; 7.683406 USDC landed in the desk's Hyperliquid perps about 42 s later (Hyperliquid ledger `send`) |
| `hl_set_referrer`, `hl_approve_builder_fee` | 2026-11-03 20:10:05 | [6hPqfFKM…](https://nearblocks.io/txns/6hPqfFKMZgy261xuhjR9sSRzRbMJchGfaLAXu4V3hQd5), [7AA2AeUa…](https://nearblocks.io/txns/7AA2AeUahAHB6K57zqZfqBWeLqoYv2EjpDHCY7Fv5MvR) | MPC signs a Hyperliquid L1 action and a user-signed action the contract built |
| `fund_venue` to Solana | 2026-11-03 20:19:37 | [97DivxqnJ…](https://nearblocks.io/txns/97DivxqnJgiA3r4t9Kwjcq62bhVvVBWa4bkDtXFyhVKp) | a second verified quote: USDC to the desk's own Solana account, the Phoenix leg's margin |
| `sol_sign` Phoenix deposit | 2026-11-04 03:09:46 | [BBABoMmY…](https://nearblocks.io/txns/BBABoMmYvHx6os8Nmg8fz1Gek9zsX9FMbF1KamDTjUFS) | MPC signs a Phoenix deposit transaction the contract parsed; 9.75 USDC is now the desk's Phoenix equity |
| `refresh_prices` | 2026-11-04 07:00:30 | [7RpGjfP4…](https://nearblocks.io/txns/7RpGjfP4YNL7bxiqA682FR7mdARCQo7wZc4X5JDyQJ8e) | the contract stores fresh OutLayer TEE oracle prices |
| `hl_order` refused: `E_PRICE_BAND` | 2026-11-04 07:00:43 | [33K2sHAd…](https://nearblocks.io/txns/33K2sHAd7TzJrEoAav6JymkuvPG7sUbtDcfRrPf74NSj) | a deliberately mispriced test order, sent on purpose (`pair-mainnet refuse-band ETH`): an ETH buy at 2343.5, 2.0007 % above the stored oracle price 2297.535, is refused on chain (band 100 bps); nothing is signed |
| `set_orderly_receiver` | 2026-11-04 18:32:59 | [3kRLjLqZ…](https://nearblocks.io/txns/3kRLjLqZ4rxoPVFNZxcYpHXjxkZZ5Swa4KkDyRv72TWd) | the owner pins the Orderly account's receiver address on Arbitrum (read just before by a signed `orderly_request` `receiver_address`); the only non-desk address a 1Click quote may pay |
| `set_orderly_ips`, then `orderly_request` `ip_restriction` | 2026-11-04 18:46:12, 18:50:44 | [3jbv172w…](https://nearblocks.io/txns/3jbv172w4wrv2vfw6yjtgS2TPuR6rD12BRp8pWm8Tuj8), [3LvAC6Qa…](https://nearblocks.io/txns/3LvAC6QasvGEuBfd762PUXrUKVMuxAmT3w7TgkM2Qa8K) | the owner lists three IPs, the engine server's egress addresses, and an MPC-signed request limits the desk's Orderly key to them (`get_desk_settings`: `orderly_ips_applied: true`) |
| USDC deposit, 16 USDC | 2026-11-04 19:07:51 | [3PT6hN1t…](https://nearblocks.io/txns/3PT6hN1tCNoG69v8TbyHLc44KUTD5CJh3rPZkAVCaxcn) | booked to the desk as principal: 38.681147 USDC deposited in all (`get_desk` ledger) |
| `fund_venue` to Orderly | 2026-11-04 20:30:44 | [6LGEdqp9…](https://nearblocks.io/txns/6LGEdqp9bv7WAWKyAz9VkZLACBh5mJRtK6if6EwKC89K) | a third verified 1Click quote, 13 USDC to the pinned Orderly receiver, sent with the runbook's `tools/mainnet/fund.mjs` (not a rescue); 12.992204 USDC arrived on Arbitrum 35 s later (1Click status SUCCESS, [0x5bfd659b…](https://arbiscan.io/tx/0x5bfd659b44a30325ed4f2708123413ec6c515fae7f269aeae5e96d1232ed8308)) |
| `orderly_ws_auth` ×12, `orderly_request` ×28 more | 2026-11-04 18:28:56 to 2026-11-05 02:29:15 | first session: [7FKrWJzC…](https://nearblocks.io/txns/7FKrWJzCGVyGoKEZkGUAJ3jq6o6w5EcPxjWd5h5APxQa), [H7pjoKoL…](https://nearblocks.io/txns/H7pjoKoL46JDe5TUbv9UTcWBHAEgBaX9WhfcvP9tv5iH) (20:32) | each engine start with Orderly pairs on signs one WebSocket login for the desk's Orderly key and two private reads that seed the session (`holding`, `positions`): 12 starts so far. The other four are setup reads (three `receiver_address`, one `holding`). One MPC signature per session, never one per read |
| `set_policy` | 2026-11-05 02:28:21 | [8qaB5a79…](https://nearblocks.io/txns/8qaB5a79diUU6nriYVsMThhTA39z7Cwrpy3wS52c9EMP) | the owner adds ZRO, ETHFI and AAVE on Hyperliquid and Orderly as unpriced symbols: no oracle price, so no band, but a size cap per symbol (`max_sz`) and the 20 USD unpriced cap; every other field is unchanged |

**Canary `gimbal-canary2.near`** (an earlier build of the contract, before the audit fixes; emptied on 2026-11-03).
It carried the first real money around the full cross-chain path: NEAR → Hyperliquid → Arbitrum → NEAR.

| Action | Time (UTC) | NEAR tx | What it proves |
| --- | --- | --- | --- |
| USDC deposit, 29 USDC | 2026-11-01 22:07:50 | [ArcSi2Vy…](https://nearblocks.io/txns/ArcSi2Vy7TJGCe9iYmAc4mszAAcEQEJ7sKBqzL18KTMw) | the desk's ledger on NEAR |
| `fund_venue` to Hyperliquid, 12 USDC | 2026-11-01 22:09:02 | [uPP67mZg…](https://nearblocks.io/txns/uPP67mZgkxy9NmHyau5WotYu2yATT8UVqXpdbHqRDgv) | 11.682396 USDC landed on Hyperliquid through 1Click (0.32 USDC cost) |
| `hl_withdraw` | 2026-11-03 01:38:48 | [GpyueMBc…](https://nearblocks.io/txns/GpyueMBcWoDZQNb535LKPy1hQPvQc7xG5jntqARjjjyi) | an MPC-signed Hyperliquid withdrawal can only go to the desk's own Arbitrum address; 10.682396 USDC arrived (1 USDC Hyperliquid fee) |
| `evm_usdc_to_intents`, twice | 2026-11-03 01:52:32, 01:55:24 | [2ugwGTYu…](https://nearblocks.io/txns/2ugwGTYu4jAZnnihKwJ9u6FvqiJqBBoBpsoUQZhv1Yd8), [5Aj4kaFP…](https://nearblocks.io/txns/5Aj4kaFPXd4qtj2DFKtgWLLzom4g7qLXomKDjJHRCMdT) | MPC signs EIP-3009 USDC authorizations on Arbitrum to verified 1Click addresses; both came back to the desk on NEAR within a minute ([4aLX5NfV…](https://nearblocks.io/txns/4aLX5NfVbTiE5qDApCvR52U6ewGVQWDuSVVwQsYGcKtY), [231oHMYf…](https://nearblocks.io/txns/231oHMYfLJsjK33quXA17iE7MS9dtywvmbv5YjipGkCm)) |
| `withdraw_to_owner` | 2026-11-03 19:50:57 | [6tpfUnHk…](https://nearblocks.io/txns/6tpfUnHkTnvsrY9mHhVQGD9vmxU3AHh2Le479eQuHthf) | money leaves a desk only to its owner |

The full round trip cost 1.32 USDC: 0.32 into Hyperliquid, Hyperliquid's 1.00 withdrawal fee, about 0.003 back to
NEAR, plus a little Arbitrum gas paid by a gas-only relayer wallet that never holds desk money.

<a id="status-2026-11-04"></a>

## Status (2026-11-05)

Done (read from the chain and the venues' public APIs at about 03:00 UTC):

- The contract code is frozen after three internal review rounds (no external audit), deployed from a reproducible
  build and locked.
- Desk `carry` is set up on all three venues and funded (38.68 USDC deposited): 7.68 USDC on Hyperliquid, 9.75 USDC
  on Phoenix, 12.99 USDC sent to Orderly, 7.68 USDC idle on NEAR as the rescue reserve.
- The engine runs on a server (`docs/deploy-railway.md`) with the operator key and a gas-only relayer wallet, with
  the strategy loop on, live rescue enabled and, since 2026-11-04, Orderly pairs on (12 Orderly sessions signed on
  chain). Its NEAR AI model is `Qwen/Qwen3-VL-30B-A3B-Instruct`, for policy drafts and the risk check.
- On testnet the same contract code refused 8 of 8 scripted malicious requests, 0 USDC moved (below).
- On mainnet `gimbal_dex.near` refused a deliberately mispriced test Hyperliquid order with `E_PRICE_BAND`
  (2026-11-04 07:00:43 UTC, in the desk table above).
- The NEAR AI risk check runs on the mainnet engine before every enter and rotate, with a 5 s timeout; without an
  answer in time the window passes, and the journal says "risk check timed out: passed". `npm run report` books
  every outcome (refusals as helped or hurt, estimated); each pass shows the position its act opened, with that
  position's net.

Not done yet:

- **The strategy loop has not opened its first live pair.** The contract has signed no opening order on
  `gimbal_dex.near` yet (`get_desk_counters`: hourly notional meter at 0), and the desk's Hyperliquid account holds
  no position. The owner's threshold is 5 % net APR at 12 USD a leg, and the loop opens only a window inside the
  desk's policy. The two owner demo entry tries of 2026-11-05 were refused by the engine; nothing was signed.
- **No margin rescue has run on mainnet yet.** The desk's rescue counters on chain are zero; the three `fund_venue`
  payments above were setup transfers, not rescues. The live routes have
  been dry-run against mainnet; the money path itself ran on the canary (above).
- The money is small on purpose. At 12 USD a leg, funding earns about a cent a day while each one-off transfer costs
  about 0.3 to 1.3 USD, so the desk's record will stay negative through Nov 14; the book shows funding and costs
  apart.

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
policy, with legs of 12 USD and auto on. It needs no keys and no chain: a replay has no contract, so nothing is signed
or sent, and the demo drops every key and chain variable of your shell. The engine's state goes to a temp folder that
is removed on exit. Ports 5190 (dashboard) and 8790 (engine) must be free; `npm run demo -- --web-port <n>` moves
the dashboard (the engine's allowed browser Origin follows it) and `--engine-port <n>` the engine.

| Do | You see |
| --- | --- |
| `npm run demo` | within a few seconds `demo: engine rules set: legs 12 USD at up to 3x, enter above 5 % net APR, auto on`, then `demo: ready. Open http://localhost:5190` |
| Open http://localhost:5190 | **Desk**: a Replay badge, "Both legs are safe", a scripted ETH pair (Hyperliquid short, Phoenix long, each about 31 % from liquidation) and a Waiting line with the loop's reason: no window clears the entry rules, and the best one, NEAR, is refused `E_ASSET` because NEAR is not in the policy |
| Click **Windows** | "Nothing clears your 5% right now"; **Show windows below my minimum** lists every window by net APR, and the selected one shows its costs from gross to net and its checks, such as "The contract would refuse it (E_ASSET)" |
| Click **Journal** | the loop's Waiting decisions with their reasons, and the counters: 1 action signed by the contract, 0 by a private key |
| Click **Rescue**, then **Run a stress test** | the Hyperliquid short is pushed inside a raised rescue line, and steps 1 Detect to 7 Landed run on recorded mainnet 1Click answers; within about a minute a few reserve → Hyperliquid moves land (about 1 min 40 s each in replay time), and Earlier rescues lists them, each marked "no funds moved" |
| Click **Security** | "0 private keys exist for this desk", how an order gets signed, and what the operator can and cannot do; the policy and key panels say a replay has no contract to read |
| Ctrl+C in the terminal | both stop |

### For reviewers

Each command from the repo root of a fresh clone, and what it prints when it works (the reproducible run, rule
Q-012). None needs a key, an account or a chain; only the last row needs Docker.

| Command | Prints |
| --- | --- |
| `npm ci` | installs the four workspaces (`engine`, `web`, `shared`, `tools`) from the lockfile, no errors; npm audit's "2 high" are one advisory, zod 4.4.3 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)), pinned exactly by the Phoenix SDK 0.6.2 (`npm audit fix` without `--force` changes nothing). The fix is SDK 0.6.8, outside the pinned version, taken after the hackathon demo; until then an oversized Phoenix answer could stop the engine, never sign or move funds (the engine's own MCP server reads only its local stdio client) ([docs/security.md](docs/security.md#oversized-phoenix-answers-zod--466)) |
| `npm run ci -- --only npm` | `ci: green - npm ci, build, test, typecheck (node tests N + N + N) in N s`, the engine, web and tools test counts (1426 + 504 + 233 at this commit) |
| `npm run demo` | `demo: ready. Open http://localhost:5190`, then the steps above (`-- --web-port <n>` if 5190 is taken) |
| `cd contract && cargo test -p gimbal-core` | `test result: ok.` for the 126 unit tests and for each vector file (decimal, EIP-3009, Hyperliquid, 1Click, Orderly, Solana, Solana fuzz): 190 passed, 0 failed |
| `npm run ci -- --only contract` | `ci: green - cargo fmt, clippy, cargo test, wasm (cargo tests 439; wasm 674,490 bytes) in N s` |
| `cd contract && cargo near build non-reproducible-wasm --no-abi` | writes `contract/target/near/gimbal.wasm`, sha256 `da4bff79edb36baec4a4c5a636a267abe9c0505fa30790a2771584a14b2e30fa`, the code on the testnet deploy |
| `git checkout eed9a99`, then `cd contract && cargo near build reproducible-wasm` (needs Docker) | sha256 `6e7cb556b86ab64414196d76243bce6e04bd9a5da0ce49b7093a0d279cc15482`, the code on `gimbal_dex.near` |

On Windows the full contract tests need the MSVC Rust toolchain (`npm run ci -- --only contract` picks it);
`cargo test -p gimbal-core` runs on the default one.

### Read the mainnet desk (no keys)

```bash
near contract call-function as-read-only gimbal_dex.near config json-args '{}' network-config mainnet now
near contract call-function as-read-only gimbal_dex.near get_desk json-args '{"desk_id":"carry"}' network-config mainnet now
near contract call-function as-read-only gimbal_dex.near get_desk_counters json-args '{"desk_id":"carry"}' network-config mainnet now
```

### Testnet

The frozen contract code also runs on NEAR testnet (deploy and `new`:
[EjKZNnRj…](https://testnet.nearblocks.io/txns/EjKZNnRjS8AUkuL9s3kMtVmLFHLbQTW8WdrkeTrdSsTD), desk `final-1`:
[5MLj2NfS…](https://testnet.nearblocks.io/txns/5MLj2NfSMYh54kYWvjLDM9DBuXndRgqkRPyGge4DLJtw)), with Mock prices
because the testnet oracle returns none. Its first MPC signature,
[`hl_order` 9RgCHtyJ…](https://testnet.nearblocks.io/txns/9RgCHtyJ4g8PBoHd4fMPivaJrckoBQMPRPTVbnzC3ARQ), is an order
Hyperliquid testnet recovered the desk's address from. Same wasm (sha256
`da4bff79edb36baec4a4c5a636a267abe9c0505fa30790a2771584a14b2e30fa`, `cargo near build non-reproducible-wasm --no-abi`);
the mainnet build differs only by its embedded build info.

```bash
node tools/testnet/desk.mjs <contract> <desk_id> --owner <account>.testnet          # create a desk (0.5 NEAR storage, refunded in part)
node tools/testnet/live.mjs <contract> <desk_id> hl --owner <account>.testnet       # one MPC-signed order, digest re-checked locally
```

The contract id is the receiver of the deploy transaction above. `live.mjs` recomputes the EIP-712 digest itself,
without trusting the contract, prints the address it recovers to, and posts the order to Hyperliquid testnet, which
names the same address.

### Refusals on chain: `npm run attack`

`npm run attack` sends a scripted list of malicious operator requests to a desk with the operator key and prints
PASS/FAIL, the refusal code and the NEAR transaction, then compares the desk's NEAR ledger and Hyperliquid account
value before and after. A row passes only on exactly its expected refusal. It refuses mainnet unless started with
`--mainnet`; `--dry` builds every request and sends nothing. Flags are at the top of
[engine/src/mcp/attack-cli.ts](engine/src/mcp/attack-cli.ts).

```bash
npm run attack -w engine -- --contract <contract> --desk <desk> --dry
```

**Recorded live run**, 2026-11-03 16:05 UTC, desk `final-1` on the testnet deploy above. The operator key is a
FunctionCall key for the 21 operator methods with 1 NEAR allowance
([AddKey](https://testnet.nearblocks.io/txns/496dM6TPyYggn37UJ4yBf7dPsyyfcriH3TTFfJGuvygY)). Result: 8 of 8 PASS,
`0 USDC moved (NEAR ledger + Hyperliquid account)`.

| Attack | Method | Refusal | NEAR tx |
| --- | --- | --- | --- |
| an order 20x over the size cap | `hl_order` | `E_SIZE` | [74qDfhFW…](https://testnet.nearblocks.io/txns/74qDfhFW27u8FzW2B4MGjy3U3wD1dZV4ZG1Y7XxZ938n) |
| an asset outside the policy | `hl_order` | `E_ASSET` | [GRD7CqNC…](https://testnet.nearblocks.io/txns/GRD7CqNCwPQPoMKLLUCRa5BPzVSBXR8jLnAn6uZoxEEi) |
| `hl_withdraw` to the attacker's address | `hl_withdraw` | `E_ARGS` (unknown field `destination`) | [7shw8Vtj…](https://testnet.nearblocks.io/txns/7shw8VtjKqP55CMhWvQG9Jx4t9Dx4mHbhhXXR9mAZEz3) |
| a made-up quote paying the attacker | `fund_venue` | `E_QUOTE_SIGNATURE` | [R3JguFEX…](https://testnet.nearblocks.io/txns/R3JguFEXBoaGrjUASBKiBierDFsHf3RrZHMUbpW3WJP) |
| a real 1Click quote for another desk | `evm_usdc_to_intents` | `E_QUOTE_FIELDS` | [6ySbdhLq…](https://testnet.nearblocks.io/txns/6ySbdhLqBnd81HTt6VpoVWCWQ5zJ5YdJMP9BBYDFxhVt) |
| raise its own caps | `set_policy` | rejected by the node (not in the key's methods) | no tx |
| resume a desk the owner paused | `set_paused` | `E_NOT_ALLOWED` (needs 1 yoctoNEAR) | [2NR9UKQk…](https://testnet.nearblocks.io/txns/2NR9UKQk752b1QcD9UL3UW2tRYyCT3iPJsUAwrSWrWH6) |
| an Orderly `MARKET` order (no limit price inside the band) | `orderly_request` | `E_PRICE_BAND` | [CryW9jNZ…](https://testnet.nearblocks.io/txns/CryW9jNZKyDEgRYaDcG58kM1yvi6kvgQnRUSN8gmvQBi) |

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
| NEAR AI Cloud | `engine/src/nearai/`, `engine/src/strategy/` | drafts the desk policy from the owner's words (the owner signs it); the NEAR AI risk check before every enter and rotate, which can only refuse. Never in the signing path |

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
  (about 0.3 USDC, plus Hyperliquid's 1 USDC withdrawal fee), so small desks lose a large share of a transfer.
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

## Repo map

| Folder | What |
|---|---|
| `contract/core/` | `gimbal-core`: pure Rust logic (decimals, policy checks, venue builders and digests, Solana parser, 1Click quote verification) |
| `contract/` | the `gimbal` NEAR contract: desks, MPC calls, money methods, events |
| `engine/` | TypeScript engine: venue readers, scanner, strategy loop, risk engine, rescue, position book, journal, HTTP/SSE server, replay, MCP server |
| `web/` | the dashboard: Windows, Desk, Journal, Rescue, Security and onboarding screens; `shared/` holds the types it shares with the engine |
| `tools/` | mainnet and testnet scripts (dry run by default), policies, and the runbook [tools/mainnet/README.md](tools/mainnet/README.md) |
| `docs/`, `design/` | [interfaces.md](docs/interfaces.md) (every method, rule, refusal code and event), [security.md](docs/security.md), the server setup; the designer's tokens and mockups |

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
running desks with your own funds; offering it to others as a hosted, managed or operated service needs permission.
It becomes MIT on 2028-11-14. Why BSL: anyone can read, check and run the code on their own money today, while a
hosted Gimbal that others run for third parties needs the builder's permission until that date.
