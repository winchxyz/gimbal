# On-chain evidence

The transactions behind each claim, with what each proves, on NEAR mainnet and testnet. Repeated calls of one kind
share a row. Times are UTC. The README's
[Live on mainnet](../README.md#live-on-mainnet) section has the contract's code hash and reproducible build, and its
[Status](../README.md#status-2026-11-04) section says what has not run yet.

## Mainnet contract `gimbal_dex.near`

The contract is [`gimbal_dex.near`](https://nearblocks.io/address/gimbal_dex.near). It has no access keys, so nobody
can change its code, sign for it or move its NEAR; only the contract's own methods run.

| Action | Time (UTC) | NEAR tx | What it proves |
| --- | --- | --- | --- |
| account created | 2026-11-03 19:34:31 | [GwzYcqsg…](https://nearblocks.io/txns/GwzYcqsgQMZ4Tv6DV79Hhz4Nj9uLjwerpMfHvrjMWHGr) | the contract account exists |
| code deployed, `new()` called | 2026-11-03 19:34:37 | [5xJqg6NR…](https://nearblocks.io/txns/5xJqg6NRApFngnzTDM12ZNH6r2sT5G2zqwrd8Co9MZP9) | the reproducible wasm (README, [Live on mainnet](../README.md#live-on-mainnet)) is the code on chain |
| last key deleted (locked) | 2026-11-03 19:37:15 | [C3vpb1cv…](https://nearblocks.io/txns/C3vpb1cvqJMG8ivPJV9nTeJX9XGGGTfQzH7QVYYuMY4E) | nobody can upgrade or drain the contract |

## Mainnet desk `carry`

**Desk `carry`** on `gimbal_dex.near`, policy [tools/mainnet-final-policy.json](../tools/mainnet-final-policy.json)
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
| `set_orderly_receiver` | 2026-11-04 18:32:59 | [3kRLjLqZ…](https://nearblocks.io/txns/3kRLjLqZ4rxoPVFNZxcYpHXjxkZZ5Swa4KkDyRv72TWd) | the owner pins the Orderly account's receiver address on Arbitrum (read just before by a signed `orderly_request` `receiver_address`); the only non-desk recipient a 1Click quote may name; refunds go to the owner |
| `set_orderly_ips`, then `orderly_request` `ip_restriction` | 2026-11-04 18:46:12, 18:50:44 | [3jbv172w…](https://nearblocks.io/txns/3jbv172w4wrv2vfw6yjtgS2TPuR6rD12BRp8pWm8Tuj8), [3LvAC6Qa…](https://nearblocks.io/txns/3LvAC6QasvGEuBfd762PUXrUKVMuxAmT3w7TgkM2Qa8K) | the owner lists three IPs, the engine server's egress addresses, and an MPC-signed request limits the desk's Orderly key to them (`get_desk_settings`: `orderly_ips_applied: true`) |
| USDC deposit, 16 USDC | 2026-11-04 19:07:51 | [3PT6hN1t…](https://nearblocks.io/txns/3PT6hN1tCNoG69v8TbyHLc44KUTD5CJh3rPZkAVCaxcn) | booked to the desk as principal: 38.681147 USDC deposited in all (`get_desk` ledger) |
| `fund_venue` to Orderly | 2026-11-04 20:30:44 | [6LGEdqp9…](https://nearblocks.io/txns/6LGEdqp9bv7WAWKyAz9VkZLACBh5mJRtK6if6EwKC89K) | a third verified 1Click quote, 13 USDC to the pinned Orderly receiver, sent with the runbook's `tools/mainnet/fund.mjs` (not a rescue); 12.992204 USDC arrived on Arbitrum 33 s later (1Click status SUCCESS, [0x5bfd659b…](https://arbiscan.io/tx/0x5bfd659b44a30325ed4f2708123413ec6c515fae7f269aeae5e96d1232ed8308)) |
| `orderly_ws_auth` ×12, `orderly_request` ×28 more | 2026-11-04 18:28:56 to 2026-11-05 02:29:15 | first session: [7FKrWJzC…](https://nearblocks.io/txns/7FKrWJzCGVyGoKEZkGUAJ3jq6o6w5EcPxjWd5h5APxQa), [H7pjoKoL…](https://nearblocks.io/txns/H7pjoKoL46JDe5TUbv9UTcWBHAEgBaX9WhfcvP9tv5iH) (20:32) | each engine start with Orderly pairs on signs one WebSocket login for the desk's Orderly key and two private reads that seed the session (`holding`, `positions`): 12 starts so far. The other four are setup reads (three `receiver_address`, one `holding`). Three MPC signatures per engine start (the login and two seed reads); reads after that ride the session and sign nothing |
| `set_policy` | 2026-11-05 02:28:21 | [8qaB5a79…](https://nearblocks.io/txns/8qaB5a79diUU6nriYVsMThhTA39z7Cwrpy3wS52c9EMP) | the owner adds ZRO, ETHFI and AAVE on Hyperliquid and Orderly as unpriced symbols: no oracle price, so no band, but a size cap per symbol (`max_sz`) and the 20 USD unpriced cap; every other field is unchanged |
| First live pair, enter: `hl_order`, `sol_sign` | 2026-11-06 05:03:36, 05:04:06 | [6WxR3Yj7…](https://nearblocks.io/txns/6WxR3Yj7p8ZdEYSVaDmYqiKwxD5Bz6Z1rXTdshAe98wr), [4esnzwZZ…](https://nearblocks.io/txns/4esnzwZZKttnXDEncMZ5Ms8MoojBqECY4KCSAYsRtTbV) | an owner demo entry (`POST /rotate`, forecast -3.3 % net APR after costs, profit checks waived, policy checks not): the contract built and MPC signed a Hyperliquid short of 74 XLM (filled at 0.154) and parsed and signed a Phoenix long of 74 XLM (filled at 0.15421, [53EAGjcQ…](https://solscan.io/tx/53EAGjcQ6HLHA4eB7dsNs1mpv9JH6Adxm2BsEGLdPPEqrkGaVtQ5H3NBdE5kgNtuERVNKSUgLYk9hMHnXpfJuwpL)); `get_desk_counters` shows the hourly opening meter at 22.76 USD from 05:04:07 |
| First live pair, exit: `hl_order` ×4, `sol_sign` | 2026-11-07 08:01:15 to 08:03:24 | [97VV8gPy…](https://nearblocks.io/txns/97VV8gPy1xdiCeFE2i1bSwVmKnoFAwJYixtETDiRt9uM), [77u9amDR…](https://nearblocks.io/txns/77u9amDRKrPEGBnEf9TMHqsS63Zp8f6GacT6pU6ZGMmt), [5gjNEXuN…](https://nearblocks.io/txns/5gjNEXuNNTemhX7S3aTgpnSTsi1j8hxqY5xmac5heQ4L), [22rYMiTe…](https://nearblocks.io/txns/22rYMiTeSCDcCFNypDt7pmNWtm3TLQNmawgQDQ437iTa), [CyCZ26LQ…](https://nearblocks.io/txns/CyCZ26LQpKNaAzNfFfZPEgf7dALYJNo8dojvVnDxkcio) | the strategy loop's own exit after 24 hourly checks under the owner's temporary 1000 % net minimum, set to hold this pair about a day: three reduce-only post-only Hyperliquid buys did not fill (two cancelled unfilled, one would have crossed), the fourth, a reduce-only taker buy, filled 74 at 0.15446 ([0x41d7faa3…](https://app.hyperliquid.xyz/explorer/tx/0x41d7faa359f21f254351044841c9750201c60088f4f53df7e5a0a5f618f5f90f)); then a reduce-only Phoenix sell filled 74 at 0.15443 ([2sAhXsbq…](https://solscan.io/tx/2sAhXsbqpNGp6pfsK6yWW9XtqDKnPtTxDCWioLbGGSRzQ5VtHtuj9x5ggQu9tEZUUjUYjn6NEgRKuEHmYsfDqfMf)). Booked over 27 h (funding read to 07:00 UTC; the last hour was still settling): funding +0.0085 USD, fees -0.0169 (entry 0.0068, exit 0.0101), price -0.0178, net -0.026 USD |

## Mainnet canary `gimbal-canary2.near`

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

## Testnet

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

## Refusals on chain: the recorded attack run

How the run works and how to start it: README, [Refusals on chain](../README.md#refusals-on-chain-npm-run-attack).

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
