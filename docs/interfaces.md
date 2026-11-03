# Interfaces

The three parts of Gimbal — `contract/`, `engine/`, `web/` — meet only at the interfaces below.
Change them only through a pull request that updates this file, the Rust types and `shared/` together.

## 1. Contract `gimbal` (Rust, near-sdk 5.29)

### 1.1 Config (set once in `new`)

```rust
pub fn new(network: Network, mpc: AccountId, price_source: PriceSource, treasury: Treasury, fees: FeeConfig, orderly: OrderlyConfig) -> Self
enum Network { Mainnet, Testnet }          // Hyperliquid: source "a"/"b", hyperliquidChain "Mainnet"/"Testnet"
enum PriceSource { OutLayer { contract: AccountId }, Mock }   // Mock: owner-set prices, testnet and demo only
struct Treasury {
    near: AccountId,
    hl_builder: String,                // lowercase 0x address, ≥ 100 USDC in HL perps
    referral_codes: ReferralCodes,     // the only codes a desk can ever use
}
struct ReferralCodes {                 // fixed in `new`; None = that venue's step is skipped
    hyperliquid: Option<String>,       // HL_REFERRAL_CODE (1–20 chars): `hl_set_referrer`, once per desk before its
                                       // first order; None on testnet unless the code exists on HL testnet
    orderly: Option<String>,           // ORDERLY_REFERRAL_CODE: bound once per desk (`referral_bind`, permanent); it must
                                       // belong to `OrderlyConfig.broker_id`; None if Gimbal runs its own broker
    phoenix: Option<String>,           // PHOENIX_REFERRAL_CODE: bound once per desk after registration; it travels in
                                       // the `referral/activate-tx` HTTP body, not in the signed bytes (§1.3)
}
struct OrderlyConfig {
    broker_id: String,                 // testnet "woofi_dex"; mainnet: Gimbal's broker id
    chain_id: u64,                     // Arbitrum: 421614 testnet, 42161 mainnet (EIP-712 chainId, withdrawals, receiver address)
}                                      // the Ledger and USDC addresses follow `network`
struct FeeConfig {
    performance_bps: u16,          // 1000 = 10% of profit above the desk's high-water mark
    hl_builder_tenth_bps: u16,     // 10 = 1 bp per Hyperliquid fill; Hyperliquid caps perps at 100 (0.1%)
}
```

Fees are fixed at `new` and visible in `config()`. Nothing is charged on deposits, `fund_venue`, rescues or losses.

MPC: `v1.signer` (mainnet), `v1.signer-prod.testnet` (testnet). OutLayer oracle: `price-oracle.near`.
USDC on NEAR (Circle, 6 decimals), following `network`: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
(mainnet; 1Click names it `nep141:<id>`), `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (testnet;
1Click has no testnet, so there the contract only takes deposits and pays out).

**Deploy note.** The treasury's NEAR account must be registered on USDC on NEAR (`storage_deposit`) before the
first payout. Otherwise every fee transfer fails, and the fee stays with the desk (back in its `idle_usdc`, due again
at the next payout).

### 1.2 Desks

A desk belongs to one owner. Its venue addresses are MPC keys derived for the contract account:

| Venue account | Derivation path | MPC domain |
|---|---|---|
| Hyperliquid master (EVM address) | `gimbal/<desk_id>/evm` | 0 (secp256k1) |
| Solana authority (Phoenix) and Orderly key | `gimbal/<desk_id>/sol` | 1 (Ed25519) |

The engine computes the addresses with the MPC contract's `derived_public_key({path, predecessor: <contract>, domain_id})`
and the owner passes them to `create_desk`. The contract checks them: `create_desk` asks the MPC contract's
`derived_public_key` for both paths (a cross-contract call) and stores the desk only in the callback, when the EVM
address and the Solana authority match; otherwise it refunds the whole deposit, stores nothing and ends the
transaction as a refusal (`E_MPC`, `E_ARGS`, `E_DESK_EXISTS` or `E_DEPOSIT`). Attach about **100 TGas**: the
call and its callback burn ~18 TGas (measured on testnet 2026-10-30), and `create_desk` refuses less than its
floor (2 × the MPC derive gas + the callback gas + its own cost: 2 × 15 + 20 + 14 = 64 TGas, the last an estimate from a unit test) with `E_ARGS`. The transaction's result
is the callback's. Desk ids are global, so another owner can take an id between the call and its callback: after
`create_desk` a client reads `get_desk(desk_id)` and checks that `owner` is its own account before it funds the
desk's addresses.
Without that check an owner could register their own wallet as the desk's address and take profit out through
`hl_withdraw` or `orderly_withdraw` without the performance fee. The Solana token accounts and the Phoenix trader
account are derived from the authority and checked from day 4 (Solana parser). They can never change afterwards.
Owner and operator can never be the contract itself, the MPC contract or the oracle (`E_ARGS`). The Solana key is also the desk's
Orderly key; the contract builds every payload either key signs, so the two uses cannot be confused.

**Desk storage.** `create_desk` charges the storage it writes (the desk record with its policy, its Hyperliquid
nonce, two fixed-size counter records of about 1.3 KB each, one for rescues and one for `fund_venue`, and its money
record), plus a 2,592-byte reserve (32 entries × 81 bytes) for the desk's share of the contract-wide map of deposit
addresses `fund_venue` paid, so `fund_venue` never adds storage the owner did not pay for. Measured in the unit
tests: 3,611 bytes written + 2,592 = 6,203 bytes (0.062 NEAR) with the fixtures' policy, 11,213 + 2,592 = 13,805
bytes (0.138 NEAR) with the largest valid policy. The 0.5 NEAR the deploy guide attaches covers either; the rest is
refunded.

```rust
struct Policy {
    hl_assets: Vec<HlAsset>,                 // { index: u32, symbol: String, sz_decimals: u8 }
    phoenix_markets: Vec<PhoenixMarket>,     // { symbol, orderbook: String /*base58*/, base_lot_e8: u64, tick_e8: u64 /*USD per tick ×1e8*/ }
    orderly_symbols: Vec<String>,            // e.g. "PERP_SOL_USDC"
    max_notional_usd: u64,                   // per leg, whole USD
    price_band_bps: u32,                     // order price vs oracle price
    oracle_max_age_s: u32,                   // 1–3600 on testnet; 900–3600 on a Mainnet contract (E_ARGS in create_desk
                                             // and set_policy): a stored price is dated at its oldest report, up to
                                             // 10 min before the oracle's read (§1.3, Views); drafts and the web take 900
    rescue_cap_usd_per_hour: u64,            // a sliding hour, with a cost budget and a deposit-address ring (§1.3)
    max_transfer_cost_bps: u32,              // 1Click: minAmountOut ≥ amountIn − max(bps share, flat); default 100
    max_transfer_cost_flat_e6: u64,          // USDC ×1e6; default 500000 (0.5 USDC; measured 0.21–0.32 on 4–7 USDC)
    unpriced: Vec<UnpricedAsset>,            // { symbol: String, max_sz: String /*canonical decimal, base units*/ }:
                                             // symbols WITHOUT an oracle price the owner explicitly allowed
    unpriced_max_notional_usd: u64,          // their own cap per leg (default 100); an unpriced order must fit
                                             // min(max_notional_usd, unpriced_max_notional_usd) at its own price
}
// Every u64 in Policy is at most 2^53 − 1 (E_ARGS above), so JavaScript reads it exactly.
// policy_sha256 (event policy_set) = hex sha256 of the policy JSON exactly as get_desk returns it.
struct SolanaAccounts {                      // registered by the owner; Solana programs enforce them
    authority: String, usdc_ata: String, phusd_ata: String, phoenix_trader: String,
}
struct Ledger {                              // USDC in 1e-6; money in and out passes through the contract on NEAR
    deposited: u128,                         // principal: only the owner's own deposits (base of the high-water mark)
    withdrawn: u128,                         // every payout whole, the fee included: withdrawn − fees_paid is
                                             // what the owner received
    fees_paid: u128, hwm: u128,
    idle_usdc: u128,                         // USDC on NEAR the contract holds for the desk: owner deposits not yet
                                             // sent out, plus 1Click returns and refunds; fund_venue and
                                             // withdraw_to_owner spend from it
}
```

**USDC on NEAR in.** `ft_on_transfer` accepts USDC on NEAR from any sender with `msg` = `{"desk_id":"<id>"}`.
From the desk owner it adds to `deposited` and `idle_usdc`; from anyone else (1Click returns and refunds) it
adds to `idle_usdc` only, never to `deposited`. Any other token, a malformed `msg` or an unknown desk_id:
the whole amount is refunded (returned as unused). A 1Click quote that delivers to the contract sets
`customRecipientMsg` to that same `msg`, so 1Click delivers with `ft_transfer_call`.

Performance fee on a payout `x` to the owner (`x` comes out of `idle_usdc`, the fee included):
`profit = withdrawn + x − deposited` (signed: negative after a loss). Fees are cumulative: the fees a mark stands for
are `⌊bps × mark / 10⁴⌋` (`bps` = `performance_bps`), so the fee on a payout is
`fee = ⌊bps × max(hwm, profit) / 10⁴⌋ − ⌊bps × hwm / 10⁴⌋`, and `hwm` rises to `max(hwm, profit)`. A fee is never
more than `x`: when it is cut to the payout amount, `hwm` rises only to the highest mark that fee covers, and the rest
stays due. A payout split into parts charges exactly the fee of the same payout unsplit, and rounding never favours
the treasury.

**Order size cap.** An order's notional is valued at a reference price, never at the caller's limit price
alone (a sell at a tiny limit price would otherwise fit any size): `notional = sz × max(px, oracle_px)`, buys and
sells alike, and it must fit `max_notional_usd` (`E_SIZE`). The same rule holds for Phoenix orders (lots × base lot ×
max(price, oracle_px)) and Orderly orders.

**Unpriced assets.** An order for a symbol in `unpriced` skips the oracle band (there is no trusted price), so
its size is capped in base units instead: `sz ≤ max_sz` of that symbol, and `sz × px` must also fit
min(`max_notional_usd`, `unpriced_max_notional_usd`) (`E_SIZE`). The `signed` event carries `oracle_px: null,
unpriced: true`. Only the owner can add a symbol to `unpriced` (it is part of `set_policy`); the UI asks for the
cap in USD, converts it to `max_sz` at the current price, and shows such symbols as "no price protection". Any
other symbol without a fresh oracle price is refused (`E_ORACLE_STALE` / `E_ASSET`): the engine calls
`refresh_prices` before an order when the stored price is too old.

### 1.3 Who may call what

The owner's NEAR account controls the desk. The engine acts through a **FunctionCall access key** on the
owner's account that may call only the operator methods below (receiver = the gimbal contract). That key
cannot attach deposits, so operator methods are not payable; the contract pays MPC and oracle deposits
from its own balance. Gas is paid by the calling account: a 300 TGas call reserves ~0.3 NEAR until the
refund (the real fee is ~0.001 NEAR), so that account needs ≥ 0.3 NEAR free per call in flight. The operator
key has an allowance, set at onboarding from config (default 5 NEAR); each call is charged against it. The
unused-gas refund comes back to the allowance (measured on testnet 2026-10-30: a 300 TGas call held ~0.30 NEAR
of it while in flight, and the allowance went down only by the tokens burnt, 0.0002 NEAR). The engine checks the
remaining allowance (`view_access_key`) before every signature and keeps at most min(balance, allowance) / 0.3
NEAR signatures in flight. A separate `operator` account can also be set.

**Owner methods need 1 yoctoNEAR.** The operator key lives on the owner's account, so the contract sees the
owner as the caller either way. Every owner method (no ✓ in the Operator column, except `ft_on_transfer`), and
`set_paused` with `paused: false`, requires exactly 1 yoctoNEAR attached. A FunctionCall key cannot attach a
deposit, so the operator key is refused (`E_NOT_ALLOWED`); only the owner's wallet (a full-access key) can
call them. Onboarding adds the operator key with `method_names` = the operator methods only. `create_desk`,
`set_policy`, `set_operator`, `set_orderly_receiver` and `set_orderly_ips` take a storage deposit instead: at least 1 yocto (no deposit at all is the
FunctionCall-key path, `E_NOT_ALLOWED`) and at least the storage the call adds (`E_DEPOSIT`, measured as the
change in storage usage); the excess is refunded to the caller, and storage freed later is not refunded. The
contract never pays for storage a caller adds. Pausing takes no deposit, or the 1 yocto a wallet may attach to
every owner call; more would stay in the contract and is refused (`E_DEPOSIT`).

**Paused desks.** While a desk is paused every operator action method refuses `E_PAUSED`, except actions that
only reduce risk, which `panic_close` and a rescue rely on: reduce-only orders (`hl_order` / an `orderly_request`
order with `reduce_only: true`), cancels, rescue transfers (`hl_send_to_intents`, `sol_sign_rescue`,
`evm_usdc_to_intents`, the operator's `hl_withdraw`, within `rescue_cap_usd_per_hour`), `panic_close` and `fund_venue` (it only adds margin; within its own limits,
"fund_venue" below). `withdraw_to_owner` and `clear_payout_lock` also work on a paused desk. A paused desk's `sol_sign_rescue` passes
only what frees and pays out the quote's `amountIn`: Phoenix withdrawals and Ember unwraps of at most `amountIn` in
all (with the unwrap's `Approve` and `Revoke`), the idempotent create of the deposit owner's USDC account and the one
transfer; no priority fee, order, cancel, deposit, wrap or create of a desk account. On Solana a paused desk's `sol_sign` accepts only, besides
the compute budget: Phoenix `cancel_all`, reduce-only Phoenix orders, a token `Revoke` of a desk token account and a
`Transfer` / `TransferChecked` into a desk token account; deposits, withdrawals, Ember, ATA creates and Approves
need a running desk. A paused desk's message may carry a priority fee only when it cancels or reduces. On Orderly a
paused desk still signs reads (every read kind of `orderly_request`), cancels, reduce-only orders and
`orderly_ws_auth`; `orderly_register`, `orderly_add_key`, `orderly_settle_pnl`, `orderly_withdraw`, `settle_pnl`
and `withdraw_request` need a running desk.

**Gas.** Every action method (one that signs through the MPC) needs at least **85 TGas** prepaid, else `E_ARGS`:
the MPC `sign` gets 50 TGas plus the unused gas, and `on_signed` 15. Measured on testnet 2026-10-31: a max-size
(≈1,160-byte) `sol_sign` succeeds at exactly 85 TGas. The engine attaches 300. `set_paused` signs nothing; the
engine sends it at 30 TGas. The NEAR money methods sign nothing and have floors of their own (`E_ARGS` below them):
`fund_venue` 115 TGas, `withdraw_to_owner` 150 TGas, `refresh_prices` 240 TGas; the engine attaches 300.
`set_policy` and `set_operator` work on a paused desk.

Mutating methods use `#[deny_unknown_arguments]`, so a misspelt argument is refused instead of read as `None`.

The owner's wallet signs only what needs the owner: `create_desk`, `set_policy`, `set_operator`, adding the
operator key, `set_orderly_receiver`, deposits, payouts and `clear_payout_lock`. Venue setup runs from the engine through operator
methods, and its content is fixed by the policy, `Treasury`, `FeeConfig` and `OrderlyConfig`, so the operator
chooses nothing:
- Hyperliquid: `hl_set_referrer` (if a code is set), `hl_approve_builder_fee`.
- Orderly: `orderly_register`, `orderly_add_key`, the `receiver_address` lookup (the owner then pins it),
  `referral_bind` (if a code is set; Orderly says none is needed under Gimbal's own broker), and the key's IP
  restriction (`orderly_request` kind `ip_restriction`, if the owner set a list with `set_orderly_ips`).
- Phoenix (no wallet login, no invite): `POST /v1/exchange/build-register-ixs` with the desk as authority and fee
  payer, `sol_sign_register` over the compiled message, then `send-register-ixs` (Phoenix's onboarder
  co-signs). If `referral_codes.phoenix` is set, `referral/activate-tx` with that code in the HTTP body; its
  transaction is signed through `sol_sign_register` too. The code is not in the signed bytes, so the contract
  cannot enforce it; the engine sends only the configured code. Verify on day 6 whether `activate-tx` still
  binds a code after registration (it may answer `already_activated`).

| Method | Owner | Operator | Notes |
|---|---|---|---|
| `create_desk(desk_id, policy, evm_address, solana)` | ✓ | | payable: storage deposit; ~100 TGas; the desk is stored in the callback after the MPC address check, and the transaction's result is the callback's (§1.2) |
| `set_policy(desk_id, policy)` | ✓ | | payable: storage deposit for a larger policy (≥ 1 yocto) |
| `set_operator(desk_id, operator: Option<AccountId>)` | ✓ | | payable: storage deposit (≥ 1 yocto) |
| `set_paused(desk_id, paused)` | ✓ | pause only | pausing: 0 or 1 yocto (more → `E_DEPOSIT`); unpausing needs exactly 1 yocto attached, so the operator key cannot unpause |
| `ft_on_transfer(sender_id, amount, msg)` | any sender | | USDC on NEAR only (`ft_transfer_call`, msg `{"desk_id"}`): owner → `deposited` + `idle_usdc`; others → `idle_usdc`; unknown desk → full refund (§1.2) |
| `fund_venue(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | sends `amountIn` (≤ `idle_usdc`, `E_SIZE`) of the desk's USDC on NEAR to a verified 1Click deposit address (recipient = a desk venue address or the pinned Orderly receiver; `refundTo` = the desk owner); own ring and hourly cost budget; ≥ 115 TGas; returns `bool` ("fund_venue" below) |
| `withdraw_to_owner(desk_id, amount)` | ✓ | | pays `amount` (1 to `idle_usdc`, else `E_SIZE`) of the USDC on NEAR the contract holds for the desk: the owner's share first, the performance fee to the treasury after it lands; `E_ARGS` while a payout is in flight; ≥ 150 TGas; returns `bool` ("Payouts" below) |
| `clear_payout_lock(desk_id)` | ✓ | | exactly 1 yocto; only once the payout lock is ≥ 1 h old; re-credits and rolls back nothing; event `payout_lock_cleared` ("Payouts" below) |
| `hl_approve_builder_fee(desk_id)` | ✓ | ✓ | `ApproveBuilderFee` for the treasury builder at `maxFeeRate` from `FeeConfig` |
| `hl_set_referrer(desk_id)` | ✓ | ✓ | L1 action `{type:"setReferrer", code}` with `code = treasury.referral_codes.hyperliquid`; setup calls it once per desk, before its first order (the contract does not refuse a repeat; Hyperliquid does); no other code can be signed; with no code configured it refuses (`E_ARGS`) and setup skips it |
| `hl_withdraw(desk_id, amount)` | ✓ | ✓ | `withdraw3` of `amount` (Hyperliquid takes its 1 USDC fee out of it) to the desk's own EVM address on Arbitrum only, also on a paused desk. Owner: exactly 1 yocto attached, no limit (emergency). Operator (no deposit; it is how a rescue leaves Hyperliquid while 1Click quotes nothing out of HyperCore): counts `amount` against the rescue amount cap ("Rescue limits"), not the cost budget or the deposit ring. The owner's engine key is a FunctionCall key on the owner's account, so it takes the operator path; the contract tells the two apart by the attached deposit |
| `set_mock_price(asset, price_e8)` | contract owner | | only with `PriceSource::Mock` |
| `refresh_prices(assets: Vec<String>)` | ✓ | ✓ | 1–7 symbols, each once, of the oracle assets BTC, DOGE, ETH, LTC, SOL, XLM, ZEC (OutLayer ids `nbtc.bridge.near`, `doge.omft.near`, `eth.bridge.near`, `ltc.omft.near`, `22.contract.portalbridge.near`, `xlm`, `zec.omft.near`; any other symbol `E_ASSET`). Callers: any desk owner (so its engine key), any desk's separate operator account and the contract account; anyone else `E_NOT_ALLOWED`, so strangers cannot spend the contract's deposit. Needs ≥ 240 TGas (`E_ARGS`; the engine attaches 300). Asks the OutLayer oracle with `request_price_data`, which gets 200 TGas plus all the unused gas, while the callback `on_prices` gets a fixed 15 TGas; there is no `oracle_call` fallback (it would need as much gas again). It stores each price newer than the stored one; the oracle deposit (0.02 NEAR, mostly refunded) comes from the contract balance; event `prices`. The contract remembers when each symbol was last asked for: when every symbol asked for had a price stored, or was asked for by an earlier call, under 30 s before the block time, it asks nothing and returns `true` at once (a skip means "nothing to do now", not "priced": a caller that needs a newer price reads `prices()` again). Otherwise it asks the oracle for all of them and returns `true` only when every symbol got a price from that answer |
| `oracle_on_call(sender_id, data, msg)` | the oracle only | | unused: `refresh_prices` no longer makes an `oracle_call`. The method stays for the interface; any predecessor other than the configured oracle, or a `sender_id` other than the contract, → `E_NOT_ALLOWED` |
| `hl_order(desk_id, order: HlOrder, reason)` | ✓ | ✓ | price band vs stored oracle price; size cap at the reference price (§1.2); reduce-only passes a paused desk |
| `hl_cancel(desk_id, asset: u32, oid: u64, reason)` | ✓ | ✓ | L1 action `{type:"cancel", cancels:[{a, o}]}`; passes a paused desk, so a pause can stop resting orders |
| `hl_usd_class_transfer(desk_id, amount, to_perp, reason)` | ✓ | ✓ | |
| `hl_send_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Hyperliquid |
| `sol_sign(desk_id, message_b64, reason)` | ✓ | ✓ | Phoenix / Ember / own transfers, legacy messages, one signer (the desk). Every Phoenix and Ember instruction has an exact account list with its fixed accounts pinned: an order or cancel has 10 accounts, the orderbook at [8] (a policy market) and its spline PDA `["spline", book]` at [9]; deposit 10, withdraw 12, Ember wrap / unwrap 8. A token Approve only on the desk PhUSD account to Ember, for exactly the amount an unwrap after it takes; a Revoke may follow that unwrap. No empty (zero-amount) or self transfers; a Phoenix withdraw of 0 or an Ember unwrap of 0 is `E_SOL_PROGRAM` here and in `sol_sign_rescue` (an unwrap of the whole balance, no amount, still passes `sol_sign`). A compute-unit price needs a unit limit; priority fee ≤ 600,000 lamports (on a paused desk only with a cancel or a reduce, §1.3). A message of compute budget only is refused |
| `sol_sign_register(desk_id, message_b64)` | ✓ | ✓ | Phoenix onboarding only, two shapes: registration (`register_trader` + `set_trader_capabilities_delegated`) and referral activation (`set_trader_capabilities_delegated` alone); registration is a legacy message, referral activation a v0 message with no address-table lookups (the other format → `E_SOL_MESSAGE`); two signers, keys[0] = the desk as fee payer and Phoenix's pinned onboarder (the desk authority itself is not a signer of `register_trader`); accounts are checked through each instruction's positions, instruction data is pinned |
| `sol_sign_rescue(desk_id, message_b64, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Solana |
| `orderly_register(desk_id, registration_nonce)` | ✓ | ✓ | EIP-712 `Registration` (nonce from `GET /v1/registration_nonce`, block time as timestamp, broker and chain from `OrderlyConfig`) |
| `orderly_add_key(desk_id, expiration_ms)` | ✓ | ✓ | EIP-712 `AddOrderlyKey`: the desk's Ed25519 MPC key as orderly key, scope `read,trading`, ≤ 365 days |
| `set_orderly_receiver(desk_id, receiver)` | ✓ | | payable: storage deposit (≥ 1 yocto). Pins the Orderly account's exclusive receiver address on Arbitrum (below), a lowercase `0x` address; once (`E_ARGS` the second time); event `orderly_receiver_set`. Owner only: a wrong receiver would redirect every deposit into Orderly |
| `set_orderly_ips(desk_id, ips: Vec<String>)` | ✓ | | payable: storage deposit (≥ 1 yocto). The relayer IPs the desk's orderly key may be used from: 1–10 distinct IPv4 / IPv6 addresses in canonical form (else `E_ARGS`); replaceable; event `orderly_ips_set`. The operator can only apply the stored list (`orderly_request` kind `ip_restriction`) |
| `orderly_request(desk_id, req: OrderlyRequest, reason)` | ✓ | ✓ | private REST call signed with the orderly key after policy checks: orders, cancels, reads, and the money-path requests below |
| `orderly_ws_auth(desk_id, timestamp)` | ✓ | ✓ | one signature per private WebSocket session (positions, balances); kind `ws_auth`, payload `method` is `""` and the signed message is the timestamp alone. Orderly's streams send no snapshot on subscribe, so a session starts with the `positions` and `holding` reads |
| `orderly_settle_pnl(desk_id, settle_nonce)` | ✓ | ✓ | EIP-712 `SettlePnl`; runs before every withdraw, or the withdrawable balance is short |
| `orderly_withdraw(desk_id, amount, withdraw_nonce)` | ✓ | ✓ | EIP-712 `Withdraw` to the desk's own EVM address only (Arbitrum) |
| `evm_usdc_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | EIP-712 USDC `TransferWithAuthorization` (EIP-3009) from the desk's EVM address to a verified 1Click deposit address on Arbitrum; the relayer submits it and pays the gas |
| `panic_close(desk_id)` | ✓ | ✓ | pauses the desk and sets `closing: true` (event `paused` with `paused: true`, then `panic_close`); 0 or 1 yocto (more → `E_DEPOSIT`); on an already paused desk it only sets `closing`. The engine, on reading `closing`, cancels resting orders and closes every leg reduce-only (the paused-desk rules above let exactly that through). `set_paused(desk_id, false)` clears `closing` |

**Orderly money path.** In: 1Click delivers Arbitrum USDC straight to the account's *exclusive receiver
address* (`GET /v1/client/asset/receiver_address?chain_id=<id>&token=USDC`, pinned with `set_orderly_receiver`;
minimum 5 USDC — less is lost, so the contract requires the quote's `minAmountOut` ≥ 6 USDC); Orderly sweeps it
into the vault and credits it in 1–2 min, the desk signs nothing. Out, run by the engine, each Orderly REST
call signed through `orderly_request`: `settle_nonce` → `orderly_settle_pnl` → `settle_pnl` → `withdraw_nonce`
→ `orderly_withdraw` → `withdraw_request` → USDC on the desk's Arbitrum address (40–52 s) →
`evm_usdc_to_intents` → 1Click. The relayer's Arbitrum gas wallet holds a few dollars of ETH and can never
move desk money (it only submits authorizations the contract signed). Orderly's answers (2026-10-31): the receiver
address is exclusive to each account (whether `gimbal_dex` has it on mainnet is checked on the canary); a withdrawal
costs 1 USD and takes 30–60 s; unsettled PnL cannot be withdrawn, so settle first.

**1Click quotes.** `quote: String` is the canonical JSON the relayer hashed, passed exactly as hashed:
json-stable-stringify (sorted keys, no spaces) of the signed request fields, the signed quote fields and
`timestamp` (field lists in `contract/core/tests/vectors/oneclick.json`, `signed_fields`). `quote_signature: String`
is 1Click's `ed25519:<base58>`. The contract verifies the signature with 1Click's key (CLAUDE.md) over the UTF-8 of
base58(sha256(`quote`)) before it parses anything (`E_QUOTE_SIGNATURE`), then applies the field rules (`field_rule`
in the same file; `E_QUOTE_FIELDS`, `E_RESCUE_CAP`). Only live quotes pass: a dry quote has no `depositAddress`
(`E_QUOTE_FIELDS`). A live quote's signed message also carries `depositAddress`, the quote's own `deadline` (it
replaces the request's), `timeWhenInactive`, `timeEstimate`, `refundFee` and `withdrawFee` (when truthy), as recorded
in `oneclick-live.json` (2026-10-31). 1Click sets a live quote's `deadline` to the requested one + 72 h, so the age
limit uses the signed `timestamp` instead: a quote is refused when its `timestamp` is more than 1 h before or more
than 5 min after the block time (`E_QUOTE_FIELDS`, checked inside `verify_quote`, so every quoted method gets it). A
quote can therefore be paid in a window of 65 min at most. On 2026-10-31 1Click refused every quote out of HyperCore, dry ones too
("Quoting for this pair is not available"), so a route out of Hyperliquid can be missing at times; the engine
treats "no quote" as a normal answer.

**Rescue limits.** Every quoted transfer out of a venue (`hl_send_to_intents`, `sol_sign_rescue`,
`evm_usdc_to_intents`) counts against three per-desk limits, all stored in a fixed-size record written by
`create_desk`:
- **Amount.** `rescue_cap_usd_per_hour` over a sliding hour: each transfer weighs `amountIn × (1 − elapsed / 1 h)`,
  so the full cap is back an hour after the last transfer and 2 × the cap can never move within a moment
  (`E_RESCUE_CAP`). The operator's `hl_withdraw` counts here too (its `amount`, no quote), so a rescue out of
  Hyperliquid (`hl_withdraw`, then `evm_usdc_to_intents` from Arbitrum) uses about twice its size of the cap.
- **Cost.** The quotes' cost (`amountIn` − `minAmountOut`) over the same sliding hour, against
  max(`rescue_cap_usd_per_hour` × `max_transfer_cost_bps` / 10⁴, 2 × `max_transfer_cost_flat_e6`), so many small
  transfers cannot pay the cap away in fees (`E_RESCUE_CAP`). Hyperliquid's 1 USDC send fee is not counted: it is
  burnt like a trading fee.
- **Deposit addresses.** The last 32 deposit addresses a desk paid, each with the time it was paid; a quote pays once,
  so a quote to one of them is refused (`E_QUOTE_FIELDS`). A rescue that would push out an address paid 65 min ago or
  less (a quote's whole payable window) is refused (`E_RESCUE_CAP`) and counts nothing, so a desk makes at most 32
  rescues in any 65 min and no quote can be replayed after the ring forgets it.

A signature the MPC returns late still counts, so nothing is given back after `E_MPC`. A quote whose
`destinationAsset` is its `originAsset` is refused (`E_QUOTE_FIELDS`): it moves nothing and only pays fees.

**fund_venue.** `fund_venue(desk_id, quote, quote_signature, reason)` pays a live 1Click quote out of the desk's
`idle_usdc`: origin USDC on NEAR, recipient the desk EVM address (HyperCore USDC), the desk Solana authority (Solana
USDC) or the pinned Orderly receiver (Arbitrum USDC, `minAmountOut` ≥ 6 USDC), all other quote rules as above.
Owner or operator, also on a paused desk. Rules of its own:
- **refundTo** is the desk **owner's** NEAR account, not the contract (`E_QUOTE_FIELDS`). A 1Click refund on NEAR is a
  plain `ft_transfer`, which calls nothing in the receiver, so a refund to the contract would credit no desk.
  `fund_venue` registers the deposit address and the owner on USDC (`storage_deposit`) before the transfer, so the
  refund can land.
- **Room.** The quote must leave `amountOut − minAmountOut ≥ 0.5 % × amountOut` (`E_QUOTE_FIELDS`), so a quote cannot
  be built to fail and refund. That room counts in the transfer cost (`amountIn − minAmountOut`), which is checked
  against `max_transfer_cost_bps` / `max_transfer_cost_flat_e6` as for every quote. A policy therefore needs a cost
  cap above 50 bps plus the 1Click fee, and whoever requests the quote must ask for a slippage inside that window
  (at least 50 bps, at most the cap minus the fee).
- **Amount.** `amountIn` ≤ `idle_usdc` (`E_SIZE`), taken from `idle_usdc` before the transfer goes out. There is no
  hourly amount cap: it only moves the desk's money into the desk's own accounts.
- **Limits of its own**, separate from the rescues' (funding can never block a rescue): a per-desk ring of 32 slots,
  each held for 65 min after it paid (a 33rd `fund_venue` within 65 min is `E_RESCUE_CAP`), and an hourly cost budget
  over the same sliding hour, `4 × max(max(max_notional_usd, unpriced_max_notional_usd) × max_transfer_cost_bps / 10⁴,
  max_transfer_cost_flat_e6)` (both legs funded twice; `E_RESCUE_CAP`). Replay protection of deposit addresses is
  contract-wide: a deposit address any desk's `fund_venue` paid within 65 min is `E_QUOTE_FIELDS`.
- **Gas.** At least 115 TGas (`E_ARGS`).
- **Result.** `true` once the transfer landed; `false` when it failed, and the amount is back in `idle_usdc`. The
  deposit address stays in the ring and the cost stays counted either way.

Residual: a genuine refund goes to the owner and leaves the books as spent, so if the owner deposits it again it
counts as principal. That under-charges the treasury by at most `performance_bps` (10 %) of the refund; nobody but
the owner can gain.

**Payouts.** `withdraw_to_owner(desk_id, amount)`: owner only, exactly 1 yocto, also on a paused desk; `amount` from 1
to `idle_usdc` (`E_SIZE` for 0 or more), one payout per desk in flight (`E_ARGS` while one is), at least 150 TGas
(`E_ARGS`). The payout is booked at once (`idle_usdc` down by `amount`, `withdrawn` up by `amount`, `fees_paid` up by
the fee, the new `hwm`). The owner's share (`amount − fee`) is sent first; the fee goes to the treasury only after
that transfer landed (a payout that is all fee goes straight to the fee transfer). If the owner's transfer fails, the
whole payout is taken back and the call returns `false`. If only the fee transfer fails, the fee goes back into
`idle_usdc` (and out of `withdrawn` and `fees_paid`) and `hwm` goes back to where it was, so the next payout charges
it once; the call returns `true` (`false` for a payout that was all fee). Events `payout` and `fee_charged` are emitted only after the transfers settled.
Each payout carries a sequence number: a late callback of an older payout gives back only its own amounts and leaves
`hwm` and the lock to the payout in flight.

`clear_payout_lock(desk_id)` (owner only, exactly 1 yocto; `E_NOT_ALLOWED` otherwise) clears a payout lock that its
callbacks never released, once the lock is at least 1 h old (`E_ARGS` before then or with no payout in flight). It
re-credits nothing and rolls nothing back: the ledger stays as `withdraw_to_owner` booked it, because the contract
cannot know whether the transfers landed. Event `payout_lock_cleared`. Residual: if an old payout fails late, after the
owner cleared its lock, that payout's fee is forgiven (its amounts come back, the mark stays). This needs a receipt
delayed more than 1 h, and only the treasury loses.

**Accepted residuals of the NEAR money path.**
- Each `fund_venue` pays 0.00125 NEAR from the contract's balance to register a new deposit address on USDC (the
  owner's registration, when it exists already, comes back). Spammed, that is at most 32 per 65 min per desk, about
  0.9 NEAR a day, and each attempt also costs the desk real 1Click fees.
- A callback that panics (out of gas, say) leaves its USDC outside the sum of the desks' `idle_usdc`, and there is no
  sweep to recover it. The callbacks get several times the gas they use.

Views: `config()`, `get_desk(desk_id)`, `desks_of(owner)`, `prices()`, `version()`. `get_desk` also returns
`orderly_account_id` (keccak of the desk EVM address and the broker hash, fixed at `create_desk`),
`orderly_receiver` (null until pinned), `orderly_ips` (empty until set) and `closing` (true from `panic_close`
until the owner unpauses). `prices()` returns the same shape as the
`prices` event, `[{ asset, price_e8, at_ms }]` sorted by asset. `at_ms` is the oldest a report behind the price can
be: the oracle answer's `timestamp` − its `recency_duration_sec` (600 s on mainnet), never later than the block that
stored it. A price fresh from the oracle is therefore up to 10 min old already, so `oracle_max_age_s` must be well
above 600 on mainnet; 900 is the default. With `PriceSource::Mock`, `at_ms` is the block time.

```rust
struct HlOrder { asset: u32, is_buy: bool, px: String, sz: String, reduce_only: bool, tif: String /* Ioc|Gtc|Alo */, cloid: Option<String> }
struct OrderlyRequest {                      // the contract builds path and body; the engine never passes raw JSON
    kind: String,                            // "order" | "cancel" | "cancel_all"
                                             // | "receiver_address" (GET /v1/client/asset/receiver_address?chain_id=<OrderlyConfig.chain_id>&token=USDC)
                                             // | "settle_nonce" (GET /v1/settle_nonce) | "withdraw_nonce" (GET /v1/withdraw_nonce)
                                             // | "settle_pnl" (POST /v1/settle_pnl) | "withdraw_request" (POST /v1/withdraw_request;
                                             //   amount in 1e-6 USDC units as a string, "2000000" = 2 USDC)
                                             // | "referral_bind" (POST /v1/referral/bind {referral_code}, code = referral_codes.orderly
                                             //   only; once per desk, permanent; unused while Gimbal runs its own broker)
                                             // | "funding_fee_history" (GET /v1/funding_fee/history?symbol&start_t&end_t&page&size;
                                             //   rows: symbol, funding_rate, mark_price, funding_fee, payment_type, status,
                                             //   created_time, updated_time, margin_mode; seen live: a long paying funding_fee
                                             //   0.001232, payment_type "Pay", status "Accrued"; a "Receive" row not seen yet.
                                             //   The account's accruedFundingFee > 0 means it pays)
                                             // | "positions" (GET /v1/positions) | "holding" (GET /v1/client/holding)
                                             // Every read kind passes a paused desk.
                                             // | "ip_restriction" (POST /v1/client/set_orderly_key_ip_restriction): the body
                                             //   is built from the desk's orderly key and its `set_orderly_ips` list (none
                                             //   set → E_ARGS); it only narrows who can use the key, so it passes a paused desk
    symbol: Option<String>,
    start_t: Option<u64>, end_t: Option<u64>, page: Option<u32>, size: Option<u32>,   // funding_fee_history only (ms)
    side: Option<String> /* BUY|SELL */, order_type: Option<String> /* IOC|LIMIT; MARKET → E_PRICE_BAND */,
    price: Option<String>, quantity: Option<String>, reduce_only: bool,
    client_order_id: Option<String>,         // must be None (E_ARGS): the contract sets "g<request_id>"
    order_id: Option<u64>,
    timestamp_ms: u64,                       // at most 300 s before the block time and 5 s after it (E_ARGS)
    // settle_pnl / withdraw_request only: the fields of the EIP-712 message signed earlier and its signature.
    // The contract rebuilds the message itself (receiver = desk EVM, token USDC, broker and chain from config)
    // and recovers eip712_signature from it: v 27/28, and a signer other than the desk is E_ARGS.
    amount: Option<String>, nonce: Option<u64>, signed_at_ms: Option<u64>, eip712_signature: Option<String>,
}
```

Decimal strings are canonical: no sign, no leading zeros, no trailing zeros after the dot, at most 8
decimals. `reason` is at most 280 characters; the event carries its sha256.

Every Hyperliquid order the contract builds carries `builder: {b: treasury.hl_builder, f: hl_builder_tenth_bps}`
after `grouping` (part of the signed msgpack). Withdrawals from venues to the owner go venue → 1Click →
USDC on NEAR with the **contract** as recipient, then `withdraw_to_owner`. 1Click leaves `appFees` out of the
signed quote, so the contract cannot see them; it bounds every transfer's cost through the signed `minAmountOut`
instead (`minAmountOut` ≥ `amountIn` − max(`amountIn` × `max_transfer_cost_bps` / 10⁴, `max_transfer_cost_flat_e6`),
else `E_QUOTE_FIELDS`). Small transfers pay a near-flat fee, so the flat part matters. Gimbal sends no `appFees`. A quote's `recipient` must be a desk address
(EVM address or Solana authority), the pinned Orderly receiver, or the contract itself (owner payouts, with
`customRecipientMsg` = `{"desk_id":"<this desk>"}`).

### 1.4 What an action method returns

Every action method returns a `SignedAction` (from the `on_signed` callback) that the engine submits as is:

```json
{
  "desk_id": "alpha", "request_id": 42, "venue": "hyperliquid", "kind": "order",
  "payload": { "action": { "type": "order", "orders": [ ... ], "grouping": "na" }, "nonce": 1762000000000, "vaultAddress": null },
  "signature": { "scheme": "Secp256k1", "big_r": { "affine_point": "02…" }, "s": { "scalar": "…" }, "recovery_id": 0 }
}
```

`request_id` is a counter in contract state, one per signing call. Every secp256k1 signature comes back low-s
(`on_signed` turns s > n/2 into n − s and flips the recovery id), which Circle's USDC requires.

- Hyperliquid: POST `/exchange` with `payload` + `signature: { r: "0x" + affine_point[2..], s: "0x" + scalar, v: 27 + recovery_id }`.
  The low-s flip negates R as well, so `on_signed` flips `affine_point`'s 02/03 prefix with the recovery id and
  the two always agree; consumers still take v from `recovery_id`. Orders and cancels carry `expiresAfter` = block
  time + 60 s (ms) in `payload` and in the signed hash: keccak256(msgpack(action) ‖ nonce u64 BE ‖ `0x00` (no vault)
  ‖ `0x00` ‖ expiresAfter u64 BE), so a signature the MPC returns late dies on its own. `setReferrer` carries none
  (Hyperliquid does not list it there), and user-signed actions (`usdClassTransfer`, `sendAsset`, `withdraw3`,
  `approveBuilderFee`) refuse it: their nonce bounds them (inside block time − 2 days … + 1 day, above the smallest
  of the signer's 100 highest nonces).
- Solana: `payload = { "message_b64": "…" }`, `signature = { "scheme": "Ed25519", "signature": [64 bytes] }`;
  the transaction is `[1][signature][message]`. `sol_sign_register` is the exception: two signers, and
  Phoenix's API adds its onboarder signature and sends it.
- Orderly: `payload = { "method", "path", "body", "timestamp", "message": "<timestamp + METHOD + path + body, exactly as signed>" }`,
  Ed25519 as above; the relayer sends headers `orderly-timestamp`, `orderly-account-id`, `orderly-key`
  (`ed25519:<base58 public key>`) and `orderly-signature` (base64url of the 64 bytes). The signed message and
  signature are public (in the call's result and the MPC's respond transaction), so anyone can resend them inside
  Orderly's window: Orderly refuses a copy of an order that is still open (-1007, the same `client_order_id`), but
  accepts a copy of a filled IOC or a cancelled LIMIT. That is an accepted residual risk on testnet. The engine
  reconciles positions after every order and closes any excess reduce-only (seen live on testnet 2026-10-31: a
  resent IOC open was accepted and closed back to the intent). On mainnet the owner also limits the key to the
  relayer's IPs (`set_orderly_ips`, then `orderly_request` kind `ip_restriction`). EIP-712 actions
  (`Registration`, `AddOrderlyKey`, `SettlePnl`, `Withdraw`) come back as secp256k1 signatures like Hyperliquid's,
  with `payload = { "message": { <the typed fields, including timestamp> }, "userAddress": "<desk EVM address>" }`;
  the relayer posts `{ message, signature, userAddress }` (e.g. `POST /v1/register_account`, `/v1/orderly_key`), and
  Orderly takes the signature as `0x` + r ‖ s ‖ v (65 bytes, v = 27 + recovery_id).
- Arbitrum (`evm_usdc_to_intents`, venue `arbitrum`, kind `transfer_with_authorization`): `validAfter` 0,
  `validBefore` = block time + 300 s, `nonce` = keccak256(utf8(desk_id) ‖ a per-desk counter as u64 big-endian) kept
  by the contract (never the relayer's); `payload` = the typed-data message plus the token and chain:
  `{ from, to, value, validAfter, validBefore, nonce, token, chainId }`, where `from`, `to`, `nonce` and `token` are
  lowercase `0x` hex, `value` (USDC 1e-6 units), `validAfter` and `validBefore` (s) are decimal strings and `chainId`
  is a number (42161, or 421614 on testnet). The `signed` event carries the quote's `deposit_address`, the same as
  `to`. The relayer's gas wallet calls the USDC contract's
  `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`.

### 1.5 Refusals

A refusal is a panic with a stable code first: `"E_PRICE_BAND: px 2500 is 4.3% from oracle 2397.1"`.
One exception: arguments that do not deserialize (wrong type, unknown field, out-of-range integer) panic inside
near-sdk before the method runs ("Failed to deserialize input from JSON"); clients treat that as `E_ARGS`.

| Code | When |
|---|---|
| `E_NOT_ALLOWED` | caller is neither owner nor operator, operator called an owner method, an owner method came without exactly 1 yocto attached, or a storage method (`create_desk`, `set_policy`, `set_operator`, `set_orderly_receiver`, `set_orderly_ips`) came with no deposit (§1.3); `refresh_prices` from an account that owns and operates no desk |
| `E_PAUSED` | desk paused |
| `E_NO_DESK` / `E_DESK_EXISTS` | |
| `E_ARGS` | malformed argument: desk_id outside `[a-z0-9-]{1,32}`, bad address or base58/hex, `reason` over 280 characters, a once-only setting set twice, `create_desk` with less prepaid gas than its floor (§1.2), an action method with less than 85 TGas (§1.3), an Orderly `client_order_id` from the caller, an Orderly timestamp outside [block − 300 s, block + 5 s], an `eip712_signature` that does not recover to the desk, `oracle_max_age_s` under 900 on a Mainnet contract, `fund_venue` under 115 TGas, `withdraw_to_owner` under 150 TGas or while a payout of the desk is in flight, `refresh_prices` under 240 TGas, `clear_payout_lock` with no payout in flight or a lock under 1 h old |
| `E_DEPOSIT` | attached deposit below the storage cost (`create_desk`, `set_policy`, `set_operator`, `set_orderly_receiver`, `set_orderly_ips`), or a pause carrying more than 1 yocto |
| `E_ASSET` | asset, symbol or market not in the policy |
| `E_SIZE` | notional at the reference price over `max_notional_usd`, an unpriced size over its `max_sz` or its notional over the unpriced cap (§1.2), or zero; a `fund_venue` `amountIn` over `idle_usdc`; a `withdraw_to_owner` amount of 0 or over `idle_usdc` |
| `E_DECIMAL` | non-canonical decimal string |
| `E_PRICE_BAND` | price outside `price_band_bps` of the oracle price |
| `E_ORACLE_STALE` | no oracle price younger than `oracle_max_age_s` |
| `E_QUOTE_SIGNATURE` | 1Click quote signature does not verify |
| `E_QUOTE_FIELDS` | quote recipient / refundTo / assets / deadline not acceptable, a quote `timestamp` more than 1 h before or 5 min after the block time, a dry quote, a cost over the policy's transfer bound, a deposit address one of the desk's last 32 rescues paid, or any desk's `fund_venue` paid within 65 min, a destination asset equal to the origin asset, a `fund_venue` quote whose `refundTo` is not the desk owner or that leaves less than 0.5 % between `amountOut` and `minAmountOut` |
| `E_RESCUE_CAP` | over what is left of `rescue_cap_usd_per_hour` or of the hourly cost budget in the sliding hour, or a 33rd rescue within 65 min (it would push out a deposit address whose quote may still be payable) (§1.3, "Rescue limits"); for `fund_venue`, over what is left of its own hourly cost budget or a 33rd `fund_venue` within 65 min (§1.3, "fund_venue") |
| `E_SOL_MESSAGE` | not the accepted message format (legacy; v0 without lookups only for referral activation), trailing bytes, wrong signer count or fee payer, no instruction besides the compute budget |
| `E_SOL_PROGRAM` | instruction for a program outside the allowlist, or instruction data not accepted (extra bytes, an Approve without its matching unwrap, a Phoenix withdraw or Ember unwrap of 0, a priority fee without a unit limit or over the cap; changed registration arguments are `E_ARGS`). The code for each case is pinned in `contract/core/tests/vectors/solana*.json` |
| `E_SOL_ACCOUNT` | wrong account count, or an account that is not the pinned one or the desk's own at its position |
| `E_MPC` | the MPC network did not return a signature |

### 1.6 Events (NEP-297)

`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"<name>","data":[{…}]}`

| Event | Data |
|---|---|
| `desk_created` | desk_id, owner, evm_address, sol_authority |
| `policy_set` | desk_id, policy_sha256 (also emitted by `create_desk`, for the first policy) |
| `operator_set` | desk_id, operator |
| `orderly_receiver_set` | desk_id, receiver |
| `orderly_ips_set` | desk_id, ips |
| `paused` | desk_id, paused, by |
| `panic_close` | desk_id, by |
| `prices` | [{ asset, price_e8, at_ms }] |
| `signed` | desk_id, request_id, venue, kind, asset?, side?, size?, px?, oracle_px?, amount?, deposit_address?, reason_sha256 |
| `deposit` | desk_id, sender, amount, principal (true when the sender is the owner), deposited_total, idle_usdc |
| `payout` | desk_id, to, amount (gross: the owner's share plus the fee), fee, profit (signed, before fees), hwm (after the payout) |
| `fee_charged` | desk_id, kind (`performance`), amount, treasury |
| `payout_lock_cleared` | desk_id, locked_since_ms, ledger (`"unchanged"`) |

`signed` is emitted in `on_signed`, only when the MPC returned a signature. Amounts in `deposit`, `payout` and
`fee_charged` (and `profit`, which may start with `-`) are decimal strings of USDC × 1e6; `locked_since_ms` is a
number. `payout` and `fee_charged` are emitted only after the transfers settled: when only the fee transfer failed,
`payout` says what the owner received, with `fee` "0" and `hwm` as before the payout, and no `fee_charged` follows.

## 2. Engine ↔ web (`shared/src/types.ts`)

```ts
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
  held: { since: number } | null;   // the desk holds this window now
  checks: { ok: boolean; text: string }[];   // what the engine checked (policy, oracle, rescue path, the carry
                                             // gate on the multi-day spread), one line each, engine-written; the
                                             // first failing one is why it is not entered. Enterable = tradable, not
                                             // refused, not stale, every check ok, no veto
  switchCostUsd: number | null;     // cost to rotate from the held window into this one at strategy.legUsd:
                                    // the fills that change, plus moving margin onto this window's venues and
                                    // back (its net APR leaves those moves out);
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
```

HTTP (engine, `127.0.0.1:8790`; it refuses a Host other than localhost and a foreign Origin, and POST / PUT bodies must be `application/json`): `GET /events` (SSE, one `StreamEvent` per message), `GET /state` (`EngineState`),
`GET /windows/history?id=<window id>` (`WindowHistory`, for the Windows chart; kept out of the stream because
it is 168 points per window), `POST /stress` (testnet and replay only: raises the rescue line of the nearest leg above its distance to force a
rescue; no body or `{}` turns it on, `{ "on": false }` off; it answers `{ ok: true }` or `{ ok: false, reason }`:
403 on mainnet, whatever the request, 503 when no risk engine runs or after it stopped, 409 when no leg with a
liquidation price is open, 400 for a bad body; 1Click has no testnet, so on testnet the rescue's 1Click steps are
replayed from recorded mainnet responses),
`GET /journal?before=<id>` (`JournalEntry[]`: up to 100 entries older than that id, newest first; `[]` past the
oldest or for an id the engine no longer holds), `POST /policy/draft` `{ text }` → `PolicyDraft` (NEAR AI; nothing is applied until the owner signs `set_policy`
and confirms the engine rules), `GET` / `PUT /strategy` (`StrategyConfig`), `POST /setup` `{ deskId }` (starts
venue setup; progress arrives as `setup` events), `POST /rotate` `{ windowId }` (manual override: close the held
window and open this one, with the same checks as auto; refused with the reason when a check fails) and
`POST /close` (close both legs with reduce-only orders). Both answer `{ ok: true }` or `{ ok: false, reason }`
at once; progress arrives as `journal` and `desk` events. Pause and Resume are not engine calls: the owner's
wallet signs `set_paused` (§1.3).

**Health** (`HealthMap`, published on change; `engine/src/risk/venue-health.ts`):
- a desk venue is `down` when the last scan could not read it or the risk engine's last account read failed, `slow`
  when the account read took over 5 s or withdrawals are reported paused there, else `ok`;
- `intents` (1Click) is probed with `GET /v0/tokens`: an error or a non-2xx is `down`, an answer over 5 s `slow`;
- `near` is the worse of the contract client's own health (the operator key's budget, slow MPC signatures) and the age
  of the engine's `get_desk` read: `down` when it was never read or the last good read is 60 s old or more (the desk
  then stays at watch at least), `slow` when the latest read failed or is late.

"Withdrawals paused" is not something any venue API the engine reads states. It is set and cleared explicitly by the
withdraw step (a venue refusing a withdraw because withdrawals are paused, and a withdraw that goes through) and
expires after 15 min without news. `HealthMap` has no separate field for it yet: it shows only as `slow` for that
venue. Nothing reports it yet either: the rescuer (E9) whose withdraw step will call `VenueHealth.withdrawals` is not
merged.

**NEAR AI rule:** the model drafts and refuses, never acts. A policy draft becomes real only through the
owner's own `set_policy` transaction (and the engine rules only after the owner confirms them); a veto can
only remove a window from consideration; nothing a model returns is ever sent to the contract or a venue. Model: a NEAR AI Cloud TEE model with JSON output
(`Qwen/Qwen3-VL-30B-A3B-Instruct`, no reasoning, ~1 s); if NEAR AI is down, drafting is unavailable and
windows pass without a veto check.

## 3. Engine internals

```ts
export interface VenueReader {           // engine/src/venues/venue.ts; readers only read
  readonly id: VenueId;
  markets(): Promise<Market[]>;          // symbol, tick, lot, szDecimals, maxLeverage, venue asset index
  funding(): Promise<MarketFunding[]>;
  book(symbol: string, depth?: number): Promise<Book>;   // best levels first
  account(address: string): Promise<AccountState>;   // equity, free margin, positions incl. unsettled funding
  userFunding(address: string, startTime: number, endTime?: number): Promise<FundingPayment[]>;
                                         // FundingHistorySource: every payment with startTime ≤ time ≤ endTime (ms;
                                         // no end = up to now), oldest first, deduplicated across pages
}

export interface FundingPayment {
  time: number;                          // ms, when the venue booked it
  symbol: string;
  fundingUsd: number;                    // received > 0, paid < 0 (same sign as a position's funding since open)
  size: number;                          // position size at that time, base units, signed
  ratePerHour: number;                   // the rate it was priced at; > 0 means longs pay shorts
  samples: number | null;                // a row the venue aggregated (Hyperliquid: one row per day after a week):
                                         // how many hourly payments it sums; null on an ordinary hourly row
}

export interface MarketFunding extends FundingRate {   // the prices the rate applies to, from the same read,
  markPx: number | null;                               // so the scanner prices basis and size without a book
  oraclePx: number | null;                             // per market; null where the venue does not say
  openInterest: number | null;           // units of `symbol` (what markPx prices); USD = openInterest × markPx
  volume24hUsd: number | null;
  base?: string;                         // cross-venue key the scanner pairs on: quote, suffixes, broker tags stripped,
                                         // aliases applied ("kPEPE" → "PEPE", "PERP_SOL_USDC" → "SOL", "XBT" → "BTC")
  multiplier?: number;                   // base units per unit of `symbol` ("kPEPE" 1000); absent = 1
  shortRatePerHour?: number;             // what a short receives where it differs from ratePerHour (GMX v2)
  fundingCapPerHour?: number;            // the venue's own per-market rate limits, per hour, from the same answer
  fundingFloorPerHour?: number;          // where it gives them; absent = unknown (the scanner then falls back to its
                                         // sourced caps and the same-rate rule for "At the cap")
}

export interface WatchReader {           // a watch-only venue: public funding and marks, no account, no orders;
  readonly id: ScanVenueId;              // its windows are ranked but never traded ("pacifica", "hl-xyz", "okx")
  readonly kind: 'dex' | 'cex';          // CEX legs are reference only: CEX-vs-CEX pairs are not ranked
  funding(): Promise<MarketFunding[]>;
}

export interface ContractClient {                      // NearContractClient | ReplayContractClient
  refreshPrices(assets: string[], options: { maxAgeS: number }): Promise<TxRef[]>;
                                                       // maxAgeS required, > 0: a stored price that young counts as
                                                       // refreshed (see below)
  fundVenue(deskId: string, quote: SignedQuote, reason: string): Promise<TxRef[]>;
  hlOrder(deskId: string, order: HlOrder, reason: string): Promise<SignedAction>;
  solSign(deskId: string, messageB64: string, reason: string): Promise<SignedAction>;
  // … one method per contract action method
}
```

**refreshPrices.** `NearContractClient.refreshPrices(assets, { maxAgeS })` calls `refresh_prices`, throws when it
returns `false`, and then reads `prices()` back: every asset asked for must show a newer stored price, or one younger
than `maxAgeS` (there is no default, so an old price never counts as fresh by accident). When the contract skipped
the oracle because an earlier call asked under 30 s ago, that answer may still be on its way, so `prices()` is polled
every 1 s for up to 35 s before a price counts as missing (an error naming the assets). It returns the NEAR
transaction's `TxRef`.

**Risk engine** (`engine/src/risk/`). Every 5 s it reads the desk's legs from the venues and computes each leg's
margin ratio and distance to liquidation (`margin.ts`). The leg uses the nearer of the venue's liquidation price and
the one computed from its account; on an account with several positions the computed one does not apply, and when
the venue gives none either the distance is the account basis, (equity − maintenance) ÷ the account's whole
notional. Lines (`thresholds.ts`):
- rescue line = `max(rescueDistancePct, (exp(4 σ √185 s) − 1) × 100)`, where σ is the leg's realised volatility per
  √s over the last 30 min (at least 10 returns, else the owner's line alone) and 185 s is the slow rescue measured on
  mainnet (a 120 s MPC signature plus a 65 s 1Click transfer);
- watch line = `max(watchDistancePct, rescue line + (watchDistancePct − rescueDistancePct))`;
- a leg leaves a level only once its distance clears the line by 1 point (hysteresis).

Rescue triggers are per leg: a leg that reaches rescue is triggered once; while it stays in rescue it is triggered
again only when its rescue failed or lapsed (no end within 370 s), after a backoff of 30 s doubling up to 10 min. A
leg that leaves rescue starts afresh.

**The pair in serve (mainnet).** `serve` adopts the carry pair `pair-mainnet open` made from the venues at start
(`engine/src/cli/serve-pair.ts`: the Hyperliquid and Phoenix legs and the relayer of `pair-mainnet-lib.ts`) and
holds it in a `PairTrader` behind `ProtectedPair` (`engine/src/trade/protected-pair.ts`). Every order it sends is
reduce-only and IOC, after the stored price is refreshed to last the order and its retry (the 300 s price-life rule):
panic_close (the contract flips the desk to `closing`) closes both legs, a rescue's `reduce` route makes both
smaller, a confirmed ADL unwinds both. Serve never opens or grows a pair. It trades only with `GIMBAL_TRADE=1`, from
the main checkout, holding the per-desk lock (`pair-mainnet --send` refuses while serve holds it); otherwise every
protection only alerts and says so. At start serve prints which legs are live, which protections trade, which only
alert, and which rescue routes run on mainnet.

**ADL** (`engine/src/risk/adl.ts`). A leg that shrank toward zero against the trader's baseline (the positions after
the last close, adopt or restored state; never what a watch read or reconciled) with no order of ours in flight,
confirmed by a second read 3 s later, is ADL: the pair is paused and both legs are unwound reduce-only. There is no
partial re-hedge. Each pair has one budget of 3 unwind attempts across all events and restarts, counted on disk
before the attempt's first order; a failed attempt raises the `unhedged` alert and is retried after 60 s doubling up
to 10 min; when the budget is spent the owner is alerted (journal `error`, `owner: ...`) and nothing more is sent.
Every stage is journaled (`adl` with `numbers.stage`: unwound, flat, failed, gave-up, alert, not-adl), and the
alert is cleared when the event ends. A leg that grew or flipped, or a pair that was not hedged before, is not ADL:
it is journaled once for the owner and nothing is traded.

**Trader state.** The trader's open pair, orders that may still run, Hyperliquid post-only orders not settled, the
order in flight and the ADL budget and pause are saved in `GIMBAL_STATE_DIR` (default: the per-user state directory,
`%LOCALAPPDATA%/gimbal/state` or `$XDG_STATE_HOME/gimbal`) as
`trader-<mode>-<contract>-<desk>-<desk evm>.json`, written atomically (temporary file, fsync, rename) and refused
for another contract, desk or address. A missing or unreadable file is not a fresh start: serve then only alerts
until it is started once with `GIMBAL_TRADER_FRESH=1` after both legs were checked on the venues.

**Monitor** (`engine/src/risk/monitor.ts`). Every 30 min serve prints each leg (size, mark, liquidation price,
distance, margin) and the net; a leg under 25 % from liquidation raises an alert in the journal (`error`) and the
console when it crosses, and again every 30 min while it stays under. `npm run monitor -w engine -- --mainnet` prints
the same once, read-only, with the trader's saved state.

**Outcome unknown.** Signing and sending never guess. When the engine cannot prove an action did not run, it
throws `OutcomeUnknown` (`engine/src/contract/types.ts`) with every id it knows: the NEAR tx hash, the HL cloid
and nonce, the Solana signature or message sha256, the Arbitrum tx hash, the EIP-3009 nonce, the Orderly
`client_order_id` or withdraw nonce. The caller reconciles from venue state before anything else, and never
retries or rebuilds. In particular:
- Money moves are never retried after an MPC timeout. A retry would take a fresh contract nonce, while the
  first signature can still be published late.
- A NEAR refusal counts as "nothing ran" only after its hash is looked up and found absent. Congested or stuck
  shards are followed, with the same signed bytes rebroadcast.
- Solana is `NothingExecuted` only on an on-chain failure, or past `lastValidBlockHeight` (with the slot read from
  the same node) with an empty signature lookup at or after that slot.
- HL: `/exchange` with no clear answer is unknown, and a 4xx is a refusal. `/info` errors after an accepted order
  only leave it unconfirmed.
- Orderly orders and `withdraw_request`: a timeout, a 5xx or an unclear body is unknown, and `success:false` under
  500 is a refusal.
- `set_paused` goes out at 30 TGas, outside the signature budget, and is never refused for budget.

**Record / replay.** `engine/fixtures/replay/<name>.jsonl.gz`, one line per call:
`{"t": <ms>, "venue": "hyperliquid", "method": "funding", "args": [], "ms": <how long the venue took>, "result": …}`,
with `"error": "<message>"` in place of `result` when the call threw (replay throws it again). `t` is when the
answer arrived; replay serves it from that moment on. A `ReplayVenue` answers
from the file on a virtual clock; `npm run demo` plays a recorded day at ×N speed, with a scripted
margin squeeze, and its `ReplayContractClient` applies the same policy checks and refusal codes as the
contract (signatures marked as replay).
