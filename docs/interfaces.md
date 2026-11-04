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
`new` checks both against `network` (`E_ARGS`): on mainnet the MPC must be `v1.signer` and an OutLayer oracle
`price-oracle.near`; on testnet the MPC must be `v1.signer-prod.testnet` and an OutLayer oracle a `.testnet` account.
`treasury.near` must not be the contract itself, the MPC contract or the oracle (`E_ARGS`), the accounts an
operator may not be either.
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
nonce, two fixed-size counter records of about 1.3 KB each, one for rescues (with the hourly notional meter) and one
for `fund_venue`, its money record, and its settings record of 338 bytes: the Phoenix accounts, the second 1Click
key and the number of the proposal it accepted, whether the owner distrusted the pinned 1Click key, and whether the
contract signed `ip_restriction` for the current Orderly IP list; "Venue settings" in §1.3), plus a 2,592-byte
reserve (32 entries × 81 bytes) for the desk's share of the contract-wide map of deposit addresses `fund_venue` paid,
so `fund_venue` never adds storage the owner did not pay for. Measured in the unit tests (and pinned there): 4,081
bytes written + 2,592 = 6,673 bytes (0.067 NEAR) with the fixtures' policy, 11,691 + 2,592 = 14,283 bytes (0.143
NEAR) with the largest valid policy. The 0.5 NEAR the deploy guide attaches covers either; the rest is refunded. The
settings setters (`set_phoenix_accounts`, `accept_oneclick_key`, `distrust_pinned_oneclick_key`) rewrite that
prepaid record and add nothing.

```rust
struct Policy {
    hl_assets: Vec<HlAsset>,                 // { index: u32, symbol: String, sz_decimals: u8 }
    phoenix_markets: Vec<PhoenixMarket>,     // { symbol, orderbook: String /*base58*/, base_lot_e8: u64, tick_e8: u64 /*USD per tick ×1e8*/ }
    orderly_symbols: Vec<String>,            // e.g. "PERP_SOL_USDC"
    max_notional_usd: u64,                   // per order, whole USD; one Phoenix message may carry several orders,
                                             // each within it; all orders of an hour: max_hourly_notional_usd
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
    max_hourly_notional_usd: Option<u64>,    // whole USD over a sliding hour, all three venues together, orders
                                             // that are not reduce-only ("Hourly notional cap" below); null or
                                             // absent = 15 × max_notional_usd. Left out of the JSON while null,
                                             // so a policy without it keeps its policy_sha256
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
max(price, oracle_px)) and Orderly orders. A Hyperliquid price has at most 5 significant figures (or is an integer)
and at most `6 − sz_decimals` decimals on a perp, `8 − sz_decimals` on a spot pair (asset ids 10,000 to 99,999)
(`E_DECIMAL`); HIP-3 perps (asset ids from 100,000, e.g. `xyz:` markets) take the perp rule. A spot pair has no
reduce-only orders: `reduce_only: true` on a spot asset id is `E_ARGS`. So after `panic_close` a spot holding can only
be sold once the desk resumes; Gimbal trades no spot today.

**Hourly notional cap.** Every order that is not reduce-only, on all three venues, also adds its notional (the value
the size cap read, rounded up; each order of a Phoenix message on its own) to a meter of the desk's rescue counter
record. The meter decays over a sliding hour like the rescue meters, and an order that would take it over
`max_hourly_notional_usd` (15 × `max_notional_usd` while that is null) is refused (`E_SIZE`) and counts nothing.
Reduce-only orders and cancels are not counted, so `panic_close` and a closing leg never meet the cap. Why: each
order may sit up to `price_band_bps` off the oracle, so an operator trading against itself could lose about
`notional × price_band_bps / 10⁴` per order. With the cap, that wash loss is about
2 × `max_hourly_notional_usd` × `price_band_bps` / 10⁴ per sliding hour on average, and up to about 4 × in a single
hour, plus closing the positions held at its start, plus the venues' trading fees on the same notional. Two causes
make the factors: each counted opening order can be closed reduce-only at the other edge of the band for free (the
close is not counted), which doubles the loss per counted notional; and the meter decays linearly, so a full cap
spent at the start of an hour and the room that comes back during it can both be used within that hour, which
doubles it again for a single hour. Default cap 15 × `max_notional_usd`; with a 1,000 USD order cap and a 50 bps
band, about 150 USD an hour on average, up to about 300 USD in one hour. The engine's
maker repricing on Hyperliquid (cancel and place again) counts each new order, so it must fit the cap: at the
default it can open 15 full-size orders an hour.

**Unpriced assets.** An order for a symbol in `unpriced` skips the oracle band (there is no trusted price), so
its size is capped in base units instead: `sz ≤ max_sz` of that symbol, and `sz × px` must also fit
min(`max_notional_usd`, `unpriced_max_notional_usd`) (`E_SIZE`). The hourly notional meter counts an unpriced order
at max(`px`, min(`max_notional_usd`, `unpriced_max_notional_usd`) × 1e8 / `max_sz`) per unit, its share of that
unpriced cap at least, so a
sell at a far-off limit (1 tick, say) cannot pass the meter for nothing. The `signed` event carries `oracle_px: null,
unpriced: true`. Only the owner can add a symbol to `unpriced` (it is part of `set_policy`); the UI asks for the
cap in USD, converts it to `max_sz` at the current price, and shows such symbols as "no price protection". Any
other symbol without a fresh oracle price is refused (`E_ORACLE_STALE` / `E_ASSET`): the engine calls
`refresh_prices` before an order when the stored price is too old. The scanner shows that refusal on a window, except
while serve can open (mainnet, `GIMBAL_TRADE=1`, the start confirmed, live, not stopping: `PairHands.canOpen`): a
Hyperliquid or Phoenix leg whose symbol the contract prices (`ORACLE_ASSETS`) and whose stored price is missing or
older than `oracle_max_age_s` is then not refused but carries `Window.note` ("stored ETH price stale: refreshed at
open"). The open plans read-only on the price as it is (on the books' mid when none is stored, or when the stored
one is over the band from the books), judges every other refusal first, and only then sends one `refresh_prices`
(`pair-ops.ts` `planOpen`, `refreshForOpen`), holding the size to the cap at the new price before either leg; the
refreshed price must live the first part's margin plus 15 s, so no second refresh is needed before it. When the
refreshed price is over the band from the one the plan was judged on, the read-only plan runs again on it (parts,
SOL, the Hyperliquid minimum, the IOC), and the price must still live that margin plus 15 s when it is done; a
refusal then is a paid one. A refresh is paid when it reached the chain (`refreshReachedChain`: it ran, was sent with
no outcome, or was refused or failed in a transaction, all of which spend gas); one that failed before the chain (the
RPC, HTTP, the prices() read) pays nothing. The 30 s gap between refreshes still follows only one the contract
recorded (`refreshLanded`). The strategy loop holds a window 6 h after an open
refused once it paid for a refresh, its own or one in the size recheck or before a part (the hold is saved, so a
restart keeps it, and cut to at most 6 h from the load), and refreshes a rotate's target before it closes the held
pair. It sends at most 12 refreshes per symbol and 24 over all symbols per UTC day (saved with its state under
`GIMBAL_STATE_DIR`). These caps are soft: they are checked only before an open starts, so one open may spend its
own refresh, the recheck's and one before each part past them, and a part, an unwind or a hedge is never refused
for a cap; every paid refresh is counted, so the next open sees it. A leg's own read during a part may still
refresh a price about to go stale; that one is not counted, on purpose, and is bounded per open by its parts. A price dated ahead of the engine's clock, a symbol outside
`ORACLE_ASSETS`, an Orderly leg and every other refusal stay refused.

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
"fund_venue" below). `withdraw_to_owner` and `clear_payout_lock` also work on a paused desk, and so do the owner's
own (1 yocto) `orderly_settle_pnl` and `orderly_withdraw`, so the owner can take money out of Orderly after
`panic_close` without resuming. A paused desk's `sol_sign_rescue` passes
only what frees and pays out the quote's `amountIn`: Phoenix withdrawals and Ember unwraps of at most `amountIn` in
all (with the unwrap's `Approve` and `Revoke`), the idempotent create of the deposit owner's USDC account (exactly 6
accounts, the system and token programs pinned at [4] and [5]) and the one `TransferChecked` (exactly 4 accounts: [0]
the desk's USDC account, [3] the desk authority); no order, cancel, deposit, wrap or create of a desk account. Its
priority fee needs a unit limit of at most 400,000 (else `E_PAUSED`); like every rescue it may pay the urgent price, up
to 1,000,000 micro-lamports per unit, so at most 0.0004 SOL of priority fee plus the 5,000-lamport base fee per
rescue. Each rescue also pays the rent of the deposit owner's new USDC account (0.00204 SOL), which goes to that
account, not back to the desk. Residual: with at most 32 rescues in 65 min (the deposit ring) an operator can burn at
most 32 × (0.00204 + 0.0004 + 0.000005) ≈ 0.078 SOL of the desk's SOL per 65 min that way; the quotes' share of the
hourly cost budget (1 USD at the defaults, against 1Click's 0.2–0.3 USDC a Solana quote) holds Solana rescues to
about 3–5 an hour after that, about 0.007–0.012 SOL an hour ("Rescue limits"). Residual: an urgent `cancel_all` or
reduce-only `sol_sign` message has no count limit, on a running or a paused desk: each may pay up to 0.000405 SOL
(0.0004 SOL of priority fee and the base fee), bounded only by the operator key's NEAR allowance (each call costs
gas). On Solana a paused desk's `sol_sign` accepts only, besides
the compute budget: Phoenix `cancel_all`, reduce-only Phoenix orders, a token `Revoke` of a desk token account and a
`Transfer` / `TransferChecked` into a desk token account; deposits, withdrawals, Ember, ATA creates and Approves
need a running desk. A paused desk's message may carry a priority fee only when it cancels or reduces. On Orderly a
paused desk still signs reads (every read kind of `orderly_request`), cancels, reduce-only orders,
`orderly_ws_auth`, the owner's (1 yocto) `orderly_settle_pnl` and `orderly_withdraw`, and the `settle_pnl` and
`withdraw_request` posts (they carry an EIP-712 message only those calls sign on a paused desk);
`orderly_register`, `orderly_add_key`, the operator's `orderly_settle_pnl` and `orderly_withdraw` (no deposit) and
`referral_bind` need a running desk.

**Gas.** Every action method (one that signs through the MPC) needs at least **85 TGas** prepaid, else `E_ARGS`:
the MPC `sign` gets 50 TGas plus the unused gas, and `on_signed` 15. Measured on testnet 2026-10-31: a max-size
(≈1,160-byte) `sol_sign` succeeds at exactly 85 TGas. The engine attaches 300. `set_paused` signs nothing; the
engine sends it at 30 TGas. The NEAR money methods sign nothing and have floors of their own (`E_ARGS` below them):
`fund_venue` 115 TGas, `withdraw_to_owner` 150 TGas, `refresh_prices` 240 TGas; the engine attaches 300.
`set_policy` and `set_operator` work on a paused desk.

Mutating methods use `#[deny_unknown_arguments]`, so a misspelt argument is refused instead of read as `None`.

The owner's wallet signs only what needs the owner: `create_desk`, `set_policy`, `set_operator`, adding the
operator key, `set_orderly_receiver`, `set_orderly_ips`, `set_phoenix_accounts`, `accept_oneclick_key`,
`distrust_pinned_oneclick_key`, deposits, payouts, the owner's own (unlimited) `hl_withdraw`, `orderly_settle_pnl`
and `orderly_withdraw`, and `clear_payout_lock`. Venue setup runs from the engine through operator
methods, and its content is fixed by the policy, `Treasury`, `FeeConfig` and `OrderlyConfig`, so the operator
chooses nothing:
- Hyperliquid: `hl_set_referrer` (if a code is set), `hl_approve_builder_fee`.
- Orderly: `orderly_register`, `orderly_add_key`, the `receiver_address` lookup (the owner then pins it),
  `referral_bind` (if a code is set; Orderly says none is needed under Gimbal's own broker), and the key's IP
  restriction (`orderly_request` kind `ip_restriction`, if the owner set a list with `set_orderly_ips`; on mainnet
  it must be signed before the desk's first opening Orderly order, §1.4).
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
| `hl_withdraw(desk_id, amount)` | ✓ | ✓ | `withdraw3` of `amount` (Hyperliquid takes its 1 USDC fee out of it) to the desk's own EVM address on Arbitrum only, also on a paused desk. Owner: exactly 1 yocto attached, no limit (emergency). Operator (no deposit; it is how a rescue leaves Hyperliquid while 1Click quotes nothing out of HyperCore): `amount` at least max(10 × `max_transfer_cost_flat_e6`, 10 USDC) (10 USDC at the default; `E_SIZE`), counted against the rescue amount cap and Hyperliquid's 1 USDC fee against the hourly cost budget ("Rescue limits"; `E_RESCUE_CAP`), not the deposit ring. The owner's engine key is a FunctionCall key on the owner's account, so it takes the operator path; the contract tells the two apart by the attached deposit |
| `set_mock_price(asset, price_e8)` | contract owner | | only with `PriceSource::Mock` |
| `refresh_prices(assets: Vec<String>)` | ✓ | ✓ | 1–7 symbols, each once, of the oracle assets BTC, DOGE, ETH, LTC, SOL, XLM, ZEC (OutLayer ids `nbtc.bridge.near`, `doge.omft.near`, `eth.bridge.near`, `ltc.omft.near`, `22.contract.portalbridge.near`, `xlm`, `zec.omft.near`; any other symbol `E_ASSET`). Callers: any desk owner (so its engine key), any desk's separate operator account and the contract account; anyone else `E_NOT_ALLOWED`, so strangers cannot spend the contract's deposit. Needs ≥ 240 TGas (`E_ARGS`; the engine attaches 300). Asks the OutLayer oracle with `request_price_data`, which gets 200 TGas plus all the unused gas, while the callback `on_prices` gets a fixed 15 TGas; there is no `oracle_call` fallback (it would need as much gas again). It stores each price newer than the stored one; the oracle deposit (0.02 NEAR, mostly refunded) comes from the contract balance; event `prices`. `assets` only names what the caller waits for: the contract always asks the oracle for all seven ids, in the table's order, and at most once per 30 s contract-wide. When anyone asked under 30 s before the block time (that answer may still be on the way), it asks nothing and returns `true` at once (a skip means "nothing to do now", not "priced": a caller that needs a newer price reads `prices()` again). Otherwise the result is `true` only when every symbol of `assets` got a price from that answer |
| `oracle_on_call(sender_id, data, msg)` | the oracle only | | unused: `refresh_prices` no longer makes an `oracle_call`. The method stays for the interface; any predecessor other than the configured oracle, or a `sender_id` other than the contract, → `E_NOT_ALLOWED` |
| `hl_order(desk_id, order: HlOrder, reason)` | ✓ | ✓ | price band vs stored oracle price; size cap at the reference price (§1.2); reduce-only passes a paused desk |
| `hl_cancel(desk_id, asset: u32, oid: u64, reason)` | ✓ | ✓ | L1 action `{type:"cancel", cancels:[{a, o}]}`; passes a paused desk, so a pause can stop resting orders |
| `hl_usd_class_transfer(desk_id, amount, to_perp, reason)` | ✓ | ✓ | |
| `hl_send_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Hyperliquid |
| `sol_sign(desk_id, message_b64, reason)` | ✓ | ✓ | Phoenix / Ember / own transfers, legacy messages, one signer (the desk). Every Phoenix and Ember instruction has an exact account list with its fixed accounts pinned: an order or cancel has 10 accounts, the orderbook at [8] (a policy market) and its spline PDA `["spline", book]` at [9]; deposit 10, withdraw 12, Ember wrap / unwrap 8. A token Approve only on the desk PhUSD account to Ember, for exactly the amount an unwrap after it takes; a Revoke of the desk PhUSD account must follow that unwrap (`E_SOL_PROGRAM`), so no allowance outlives the message. No empty (zero-amount) or self transfers; a Phoenix withdraw of 0 or an Ember unwrap of 0 is `E_SOL_PROGRAM` here and in `sol_sign_rescue` (an unwrap of the whole balance, no amount, still passes `sol_sign`). A compute-unit price needs a unit limit; unit limit ≤ 600,000, price ≤ 200,000 micro-lamports per unit, so a priority fee ≤ 120,000 lamports (0.00012 SOL). A message that only cancels or reduces (a `cancel_all` or reduce-only orders, every order reduce-only, nothing that needs a running desk), and a `sol_sign_rescue` message with no opening order, may pay the urgent price, up to 1,000,000 micro-lamports per unit, with a unit limit of at most 400,000: a priority fee ≤ 400,000 lamports (0.0004 SOL). On a paused desk a priority fee comes only with a cancel or a reduce (§1.3). Phoenix's and Ember's own accounts at their positions are the desk's settings (`set_phoenix_accounts`), Phoenix's published ones until the owner replaces them. A message of compute budget only is refused |
| `sol_sign_register(desk_id, message_b64)` | ✓ | ✓ | Phoenix onboarding only, two shapes: registration (`register_trader` + `set_trader_capabilities_delegated`) and referral activation (`set_trader_capabilities_delegated` alone); registration is a legacy message, referral activation a v0 message with no address-table lookups (the other format → `E_SOL_MESSAGE`); two signers, keys[0] = the desk as fee payer and Phoenix's pinned onboarder (the desk authority itself is not a signer of `register_trader`); accounts are checked through each instruction's positions, instruction data is pinned |
| `sol_sign_rescue(desk_id, message_b64, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Solana; an order it carries (running desk only) counts against the hourly notional meter as `sol_sign`'s do, and an opening order keeps the message at the 200,000 price cap |
| `orderly_register(desk_id, registration_nonce)` | ✓ | ✓ | EIP-712 `Registration` (nonce from `GET /v1/registration_nonce`, block time as timestamp, broker and chain from `OrderlyConfig`) |
| `orderly_add_key(desk_id, expiration_ms)` | ✓ | ✓ | EIP-712 `AddOrderlyKey`: the desk's Ed25519 MPC key as orderly key, scope `read,trading`, ≤ 365 days |
| `set_orderly_receiver(desk_id, receiver)` | ✓ | | payable: storage deposit (≥ 1 yocto). Pins the Orderly account's exclusive receiver address on Arbitrum (below), a lowercase `0x` address; once (`E_ARGS` the second time); event `orderly_receiver_set`. Owner only: a wrong receiver would redirect every deposit into Orderly |
| `set_orderly_ips(desk_id, ips: Vec<String>)` | ✓ | | payable: storage deposit (≥ 1 yocto). The relayer IPs the desk's orderly key may be used from: 1–10 distinct IPv4 / IPv6 addresses in canonical form (else `E_ARGS`); replaceable; event `orderly_ips_set`. The operator can only apply the stored list (`orderly_request` kind `ip_restriction`). A new list clears `orderly_ips_applied` (`get_desk_settings`) until the contract signs `ip_restriction` for it |
| `orderly_request(desk_id, req: OrderlyRequest, reason)` | ✓ | ✓ | private REST call signed with the orderly key after policy checks: orders, cancels, reads, and the money-path requests below |
| `orderly_ws_auth(desk_id, timestamp)` | ✓ | ✓ | one signature per private WebSocket session (positions, balances); kind `ws_auth`, payload `method` is `""` and the signed message is the timestamp alone. Orderly's streams send no snapshot on subscribe, so a session starts with the `positions` and `holding` reads |
| `orderly_settle_pnl(desk_id, settle_nonce)` | ✓ | ✓ | EIP-712 `SettlePnl`; runs before every withdraw, or the withdrawable balance is short. Two paths, as for `orderly_withdraw`: the owner's wallet (exactly 1 yocto) also on a paused desk, the operator (no deposit) on a running one; any other deposit `E_NOT_ALLOWED` |
| `orderly_withdraw(desk_id, amount, withdraw_nonce)` | ✓ | ✓ | EIP-712 `Withdraw` to the desk's own EVM address only (Arbitrum). Two paths, as for `hl_withdraw`, told apart by the deposit. Owner: exactly 1 yocto, no limit, also on a paused desk. Operator (no deposit), running desk: `amount` at least max(10 × `max_transfer_cost_flat_e6`, 10 USDC) (`E_SIZE`), counted against the rescue amount cap and Orderly's 1 USDC fee against the hourly cost budget (`E_RESCUE_CAP`). Any other deposit `E_NOT_ALLOWED` |
| `evm_usdc_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | EIP-712 USDC `TransferWithAuthorization` (EIP-3009) from the desk's EVM address to a verified 1Click deposit address on Arbitrum; the relayer submits it and pays the gas |
| `panic_close(desk_id)` | ✓ | ✓ | pauses the desk and sets `closing: true` (event `paused` with `paused: true`, then `panic_close`); 0 or 1 yocto (more → `E_DEPOSIT`); on an already paused desk it only sets `closing`. The engine, on reading `closing`, cancels resting orders and closes every leg reduce-only (the paused-desk rules above let exactly that through). `set_paused(desk_id, false)` clears `closing` |
| `set_phoenix_accounts(desk_id, accounts: PhoenixAccounts)` | ✓ | | exactly 1 yocto (the record is prepaid); also on a paused desk. Replaces the desk's Phoenix and Ember accounts ("Venue settings" below); event `phoenix_accounts_set` |
| `propose_oneclick_key(key: Option<String>)` | treasury account | | `config.treasury.near` only, exactly 1 yocto (anyone else `E_NOT_ALLOWED`). Proposes a second 1Click quote-signing key (base58, 32 bytes, not zero and not the pinned key, else `E_ARGS`) for every desk, or withdraws it with `null`. Every proposal is numbered: a new one, even of a key proposed before, ends every desk's earlier acceptance, so an old key comes back only with a new acceptance and a new day. Event `oneclick_key_proposed` |
| `accept_oneclick_key(desk_id, key: Option<String>)` | ✓ | | exactly 1 yocto (the record is prepaid). Accepts the treasury's current proposal for the desk (any other key `E_ARGS`), or clears the desk's accepted key with `null`; the key signs quotes for the desk from 24 h after this call, only while that proposal (key and number) is still the current one. Event `oneclick_key_accepted` |
| `distrust_pinned_oneclick_key(desk_id)` | ✓ | | exactly 1 yocto (the record is prepaid); also on a paused desk; one way, for good. From then on 1Click's pinned key no longer verifies the desk's quotes, only an accepted second key does (`E_QUOTE_SIGNATURE`), for the rescues and `fund_venue` alike. For when the pinned key may have leaked; with no live second key no quote passes until one is. Event `pinned_oneclick_key_distrusted` |

**Venue settings.** The contract is frozen after deploy, so two things a venue may change are per-desk settings
the owner controls, in a fixed-size record `create_desk` prepays (§1.2):
- **Phoenix accounts.** `PhoenixAccounts` = `{ log_authority, global_configuration, perp_asset_map, withdraw_queue,
  global_vault, global_trader_index, active_trader_buffer, ember_state, ember_vault }`, each base58 (unknown fields
  `E_ARGS`). They start as Phoenix's published accounts. `set_phoenix_accounts` refuses (`E_ARGS`, naming the field) a
  program id, a mint, Phoenix's onboarder, permission or risk authority, one of the desk's own derived accounts, two
  fields alike, and an on-curve key for the program-derived ones (`log_authority`, `global_configuration`,
  `ember_state`). They are passed only to the pinned Phoenix and Ember programs, at
  their positions; every desk-side account (authority, token accounts, trader account) stays derived and pinned, and
  an `Approve` to `ember_state` is still for exactly the unwrap that follows it. Residual: the shapes (account counts
  per instruction) stay fixed; a Phoenix that changes an instruction's account list needs a new contract, and so
  does a new Phoenix or Ember program id, PhUSD mint, Phoenix onboarder or permission account (they are pinned).
  The on-curve rule covers the program-derived accounts only (`log_authority`, `global_configuration`,
  `ember_state`); `global_vault` and `ember_vault` are token accounts, which may be on the curve.
- **Second 1Click key.** If 1Click rotates its quote key, quotes signed by a second key pass too. The treasury
  account proposes one key for every desk (`propose_oneclick_key`), each owner accepts that exact key for the desk
  (`accept_oneclick_key`), and it signs that desk's quotes 24 h after the acceptance, while it is still the
  proposal. Two parties because a quote signed by an accepted key passes every check the pinned key's does
  (deposit address included): a key only the owner set would let the owner pay itself past the performance fee, one
  only the treasury set would let the treasury pay itself out of every desk. The operator can do neither, and the
  24 h give an owner time to clear (`accept_oneclick_key(desk_id, null)`); pausing is no defence, since rescues and
  `fund_venue` pass a paused desk. The field rules, the fee bound and the pinned destinations apply as for the
  pinned key. If the pinned key may have leaked, the owner can stop it for the desk for good
  (`distrust_pinned_oneclick_key`). Liveness residual: after 1Click rotates its key, a desk moves no quoted money
  until the treasury proposes the new key, the owner accepts it and a day passes; the treasury proposes for every
  desk and receives every fee, so it should be a multisig.

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
  (`E_RESCUE_CAP`). The operator's `hl_withdraw` and `orderly_withdraw` count here too (their `amount`, no quote),
  so a rescue out of Hyperliquid or Orderly (the withdrawal, then `evm_usdc_to_intents` from Arbitrum) uses about
  twice its size of the cap. Each operator withdrawal must be at least max(10 × `max_transfer_cost_flat_e6`, 10 USDC)
  (`E_SIZE`; 10 USDC at the default flat bound), so its 1 USDC fee is at most a tenth of it; the owner's (1 yocto) has
  no limit.
- **Cost.** The transfers' cost over the same sliding hour, against the hourly cost budget: the quotes' share,
  max(`rescue_cap_usd_per_hour` × `max_transfer_cost_bps` / 10⁴, 2 × `max_transfer_cost_flat_e6`), plus 4 USD (room for
  four venue fees of 1 USDC an hour, so a failed withdrawal can be retried; 5 USD at the default policy), so many small
  transfers cannot pay the cap away in fees (`E_RESCUE_CAP`). A quote costs `amountIn` − `minAmountOut`, and the
  quotes' costs alone may use only the quotes' share (1 USD at the defaults; a separate meter, `E_RESCUE_CAP`), so
  `appFees` someone adds to a quote can never spend the venue-fee room. `hl_send_to_intents` adds Hyperliquid's 1 USDC
  `sendAsset` fee (every 1Click deposit address is new to Hyperliquid); the operator's `hl_withdraw` and
  `orderly_withdraw` cost the venue's 1 USDC fee each; those fees use the whole budget. At the defaults the rate
  depends on the route: `hl_send_to_intents` (a quote of about 0.36 USDC plus the 1 USDC send fee) about 2–3 an
  hour, Solana rescues (`sol_sign_rescue`, quotes of 0.2–0.3 USDC) about 3–5 an hour, counting what comes back as
  the meters decay. A desk policy with `max_transfer_cost_flat_e6` = 1,000,000 (1.0 USDC) doubles the quotes' share.
- **Deposit addresses.** The last 32 deposit addresses a desk paid, each with the time it was paid; a quote pays once,
  so a quote to one of them is refused (`E_QUOTE_FIELDS`). A rescue that would push out an address paid 65 min ago or
  less (a quote's whole payable window) is refused (`E_RESCUE_CAP`) and counts nothing, so a desk makes at most 32
  rescues in any 65 min and no quote can be replayed after the ring forgets it.

A signature the MPC returns late still counts, so nothing is given back after `E_MPC`; the same holds for the hourly
notional meter: an order whose MPC signature failed stays counted. A quote whose
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
- The owner can skip the performance fee through `set_orderly_receiver`: the contract cannot derive Orderly's receiver
  address, so it takes any lowercase `0x` address the owner pins (once). An owner who pins its own wallet can then
  move the desk's money there with `fund_venue` or a rescue, past `withdraw_to_owner` and its fee. Only the treasury's
  fee is at risk: the money is the owner's own, the operator cannot pin or change the receiver, and a wrong pin is
  permanent for that desk (a new desk is the fix).
- `set_phoenix_accounts` is the owner's too: the accounts it sets are passed only to the pinned Phoenix and Ember
  programs, at their positions, and every desk-side account stays derived, so a wrong one makes those programs fail
  (the desk's Phoenix money waits until the owner sets them right) but cannot redirect money; like the receiver, it
  is the owner's own risk.
- `refresh_prices` is open to every desk owner and operator, and each call that asks the oracle spends the
  contract's 0.02 NEAR deposit, at most one call per 30 s contract-wide: about 2,880 a day, 29–58 NEAR a day
  depending on how much the oracle refunds. The contract account's balance is watched and topped up; a desk costs
  about 0.07 NEAR, so this is the cheapest grief on the contract.
- The seven oracle ids are fixed in the contract and asked together in one request, so they are coupled: if OutLayer
  drops or renames one, the answer may fail for all seven, every desk's priced orders stop, and a new id needs a new
  contract. A desk owner's escape is to move its symbols to `unpriced` (`set_policy`): they then trade under
  `max_sz` and the unpriced cap, without the band.

Views: `config()`, `get_desk(desk_id)`, `desks_of(owner)`, `prices()`, `version()`, `get_desk_counters(desk_id)`, `get_desk_settings(desk_id)`, `oneclick_key_proposal()`. `get_desk` also returns
`orderly_account_id` (keccak of the desk EVM address and the broker hash, fixed at `create_desk`),
`orderly_receiver` (null until pinned), `orderly_ips` (empty until set) and `closing` (true from `panic_close`
until the owner unpauses). `prices()` returns the same shape as the
`prices` event, `[{ asset, price_e8, at_ms }]` sorted by asset. `at_ms` is the oldest a report behind the price can
be: the oracle answer's `timestamp` − its `recency_duration_sec` (600 s on mainnet), never later than the block that
stored it. A price fresh from the oracle is therefore up to 10 min old already, so `oracle_max_age_s` must be well
above 600 on mainnet; 900 is the default. With `PriceSource::Mock`, `at_ms` is the block time.

`get_desk_counters(desk_id)` returns the desk's rescue counter record whole, plus the meters at the block time
(`null` for an unknown desk). The engine reads it after a crash: an EIP-3009 authorization with counter `n` was
signed, or its `sign` call sent, once `eip3009_next` > `n`; a deposit address was paid by a rescue while its sha256 is
in `deposits`. Amounts are decimal strings (U128), times numbers (ms):

```json
{
  "eip3009_next": 1,                         // the counter evm_usdc_to_intents takes next
  "rescue_at_ms": 1762000000000,             // block time the rescue meters were last brought to
  "rescue_spent_e8": "1000000000",           // stored weight of the amount meter, USDC × 1e8
  "rescue_cost_e8": "16000000",              // stored weight of the cost meter, USD × 1e8
  "rescue_spent_now_e8": "500000000",        // the amount meter decayed to the block time
  "rescue_cap_left_e8": "4500000000",        // rescue_cap_usd_per_hour × 1e8 − rescue_spent_now_e8
  "rescue_cost_now_e8": "8000000",           // the cost meter decayed to the block time
  "rescue_cost_left_e8": "492000000",        // rescue_cost_budget_e8 − rescue_cost_now_e8
  "rescue_cost_budget_e8": "500000000",      // the hourly cost budget ("Rescue limits")
  "rescue_quote_cost_e8": "16000000",        // stored weight of the quotes' cost meter (no venue fees), USD × 1e8
  "rescue_quote_cost_left_e8": "92000000",   // rescue_quote_budget_e8 − the quotes' meter at the block time
  "rescue_quote_budget_e8": "100000000",     // the quotes' share of the budget, without the venue-fee room
  "deposits": ["<64 hex>", null, …],         // 32 slots: lowercase hex sha256 of the UTF-8 deposit address as the
                                             // verified quote gives it (lowercase 0x EVM, base58 Solana);
                                             // null for an unused slot
  "deposit_paid_ms": [1762000000000, 0, …],  // 32 slots: block time each slot was paid, 0 when unused
  "deposit_next": 1,                         // the slot the next rescue takes (the oldest)
  "notional_at_ms": 1762000000000,           // block time the notional meter was last brought to
  "notional_e8": "0",                        // stored weight of the hourly notional meter, USD × 1e8
  "notional_cap_usd": 15000,                 // max_hourly_notional_usd, or 15 × max_notional_usd while null
  "notional_now_e8": "0",                    // the notional meter decayed to the block time
  "notional_left_e8": "1500000000000"        // notional_cap_usd × 1e8 − notional_now_e8
}
```

Each meter weighs `weight × (1 − elapsed / 1 h)` (rounded up) since its `_at_ms`. `fund_venue`'s own counter
record (its ring and cost meter) is not in this view; its replay check is the contract-wide map (§1.3, "fund_venue").

`get_desk_settings(desk_id)` returns `{ phoenix_accounts: PhoenixAccounts, oneclick_key: String | null,
oneclick_key_from_ms: u64, oneclick_key_active: bool, pinned_key_trusted: bool, orderly_ips_applied: bool }`
("Venue settings"; `null` for an unknown desk); `oneclick_key_active` is whether the accepted key signs the desk's
quotes at the block time, `pinned_key_trusted` false once the owner called `distrust_pinned_oneclick_key`,
`orderly_ips_applied` whether the contract signed `ip_restriction` for the desk's current Orderly IP list.
`oneclick_key_proposal()` returns the treasury's proposed key, base58, or `null`.

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
else `E_QUOTE_FIELDS`). Small transfers pay a near-flat fee, so the flat part matters. Gimbal sends no `appFees`.
`appFees` come out of `amountOut`, so the contract also bounds the quote's fee: `amountIn − amountOut` (both read as
USDC × 1e8, whatever the destination's decimals) must be at most 1 USDC + 25 bps of `amountIn`, 1Click's own fee
with room for it to move (`E_QUOTE_FIELDS`; measured 0.21–0.32 USDC). The signed `refundFee` is not part of it: it is
charged only on a refund, which lands at the method's pinned `refundTo`. Accepted residual: whoever requests a quote
can still add `appFees` to a stranger inside that bound, at most (1 USDC + 25 bps) − 1Click's real fee per
transfer (about 0.69 USDC on a 4 USDC transfer). The skim is bounded by the hourly cost budget, not per transfer: a
rescue's quote costs count against the quotes' share only (1 USD an hour at the defaults), `fund_venue`'s against
its own budget, and the deposit rings bound how many transfers fit in 65 min. A quote's `recipient` must be a desk address
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
  accepts a copy of a filled IOC or a cancelled LIMIT, so a signed order can be posted again within its 300 s
  window (the request timestamp's). That is an accepted residual risk on testnet. The engine
  reconciles positions after every order and closes any excess reduce-only (seen live on testnet 2026-10-31: a
  resent IOC open was accepted and closed back to the intent). On mainnet the owner also limits the key to the
  relayer's IPs (`set_orderly_ips`, then `orderly_request` kind `ip_restriction`), and the contract enforces both
  halves as far as it can see: on a Mainnet contract an Orderly order that is not reduce-only is refused (`E_ARGS`)
  until the desk has an IP list and the contract signed `ip_restriction` for it (`orderly_ips_applied`; a new list
  clears it). The contract sees the signature, not Orderly's answer, so a relayer that never posts it leaves the key
  unrestricted. The flag is set when the `ip_restriction` request is prepared, before the MPC signature returns, so a
  failed signature also leaves it set (a new `set_orderly_ips` clears it). Reduce-only orders, cancels and reads
  always pass, so a desk without one can still close. EIP-712 actions
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
| `E_NOT_ALLOWED` | caller is neither owner nor operator, operator called an owner method, an owner method came without exactly 1 yocto attached, `propose_oneclick_key` from any account but the treasury's or without exactly 1 yocto, an `hl_withdraw`, `orderly_settle_pnl` or `orderly_withdraw` with a deposit other than 0 or 1 yocto, or a storage method (`create_desk`, `set_policy`, `set_operator`, `set_orderly_receiver`, `set_orderly_ips`) came with no deposit (§1.3); `refresh_prices` from an account that owns and operates no desk |
| `E_PAUSED` | desk paused (§1.3, "Paused desks"), including a paused desk's `sol_sign_rescue` with a priority fee and a unit limit over 400,000 |
| `E_NO_DESK` / `E_DESK_EXISTS` | |
| `E_ARGS` | malformed argument: desk_id outside `[a-z0-9-]{1,32}`, bad address or base58/hex, `reason` over 280 characters, a once-only setting set twice, `create_desk` with less prepaid gas than its floor (§1.2), an action method with less than 85 TGas (§1.3), an Orderly `client_order_id` from the caller, an Orderly timestamp outside [block − 300 s, block + 5 s], an `eip712_signature` that does not recover to the desk, `oracle_max_age_s` under 900 on a Mainnet contract, `fund_venue` under 115 TGas, `withdraw_to_owner` under 150 TGas or while a payout of the desk is in flight, `refresh_prices` under 240 TGas, `clear_payout_lock` with no payout in flight or a lock under 1 h old; `new` with an MPC or oracle that is not `network`'s (§1.1); on a Mainnet contract, an Orderly order that is not reduce-only before `set_orderly_ips` and the signed `ip_restriction` for that list (§1.4); a reduce-only Hyperliquid order on a spot asset id; `new` with a `treasury.near` that is the contract, the MPC contract or the oracle; `set_phoenix_accounts` with an account it refuses ("Venue settings"); a 1Click key that is zero or the pinned one, or an accepted key that is not the current proposal |
| `E_DEPOSIT` | attached deposit below the storage cost (`create_desk`, `set_policy`, `set_operator`, `set_orderly_receiver`, `set_orderly_ips`), or a pause carrying more than 1 yocto |
| `E_ASSET` | asset, symbol or market not in the policy |
| `E_SIZE` | notional at the reference price over `max_notional_usd`, an unpriced size over its `max_sz` or its notional over the unpriced cap (§1.2), or zero; an order that would take the hourly notional meter over `max_hourly_notional_usd` (§1.2); an operator `hl_withdraw` or `orderly_withdraw` under max(10 × `max_transfer_cost_flat_e6`, 10 USDC); a `fund_venue` `amountIn` over `idle_usdc`; a `withdraw_to_owner` amount of 0 or over `idle_usdc` |
| `E_DECIMAL` | non-canonical decimal string; a Hyperliquid price with too many significant figures or decimals (§1.2) |
| `E_PRICE_BAND` | price outside `price_band_bps` of the oracle price |
| `E_ORACLE_STALE` | no oracle price younger than `oracle_max_age_s` |
| `E_QUOTE_SIGNATURE` | 1Click quote signature does not verify (by the pinned key, unless the desk's owner distrusted it, or by the desk's accepted second key) |
| `E_QUOTE_FIELDS` | quote recipient / refundTo / assets / deadline not acceptable, a quote `timestamp` more than 1 h before or 5 min after the block time, a dry quote, a cost over the policy's transfer bound, a fee (`amountIn − amountOut`) over 1 USDC + 25 bps, a deposit address one of the desk's last 32 rescues paid, or any desk's `fund_venue` paid within 65 min, a destination asset equal to the origin asset, a `fund_venue` quote whose `refundTo` is not the desk owner or that leaves less than 0.5 % between `amountOut` and `minAmountOut` |
| `E_RESCUE_CAP` | over what is left of `rescue_cap_usd_per_hour`, of the hourly cost budget or of its quotes' share in the sliding hour (an operator `hl_withdraw` / `orderly_withdraw` included, with its 1 USDC venue fee), or a 33rd rescue within 65 min (it would push out a deposit address whose quote may still be payable) (§1.3, "Rescue limits"); for `fund_venue`, over what is left of its own hourly cost budget or a 33rd `fund_venue` within 65 min (§1.3, "fund_venue") |
| `E_SOL_MESSAGE` | not the accepted message format (legacy; v0 without lookups only for referral activation), trailing bytes, wrong signer count or fee payer, no instruction besides the compute budget |
| `E_SOL_PROGRAM` | instruction for a program outside the allowlist, or instruction data not accepted (extra bytes, an Approve without its matching unwrap, a Phoenix withdraw or Ember unwrap of 0, a priority fee without a unit limit or over the caps (200,000 micro-lamports per unit and 120,000 lamports; for a rescue with no opening order or a message that only cancels or reduces 1,000,000 micro-lamports per unit with a unit limit of at most 400,000, and 400,000 lamports); changed registration arguments are `E_ARGS`). The code for each case is pinned in `contract/core/tests/vectors/solana*.json` |
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
| `pinned_oneclick_key_distrusted` | desk_id |
| `paused` | desk_id, paused, by |
| `panic_close` | desk_id, by |
| `prices` | [{ asset, price_e8, at_ms }] |
| `signed` | desk_id, request_id, venue, kind, asset?, side?, size?, px?, oracle_px?, amount?, deposit_address?, reason_sha256 |
| `deposit` | desk_id, sender, amount, principal (true when the sender is the owner), deposited_total, idle_usdc |
| `payout` | desk_id, to, amount (gross: the owner's share plus the fee), fee, profit (signed, before fees), hwm (after the payout) |
| `fee_charged` | desk_id, kind (`performance`), amount, treasury |
| `payout_lock_cleared` | desk_id, locked_since_ms, ledger (`"unchanged"`) |
| `phoenix_accounts_set` | desk_id, accounts (`PhoenixAccounts`, base58) |
| `oneclick_key_proposed` | key (base58, or null when withdrawn) |
| `oneclick_key_accepted` | desk_id, key (base58, or null when cleared), from_ms (0 when cleared) |

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
                                  // today's one-off costs, spread over the hold as APR points. A desk window, with
                                  // or without its history: the round trip the gate uses, feesPct the four fills,
                                  // basisPct the basis buffer (adverse mark gap, timing loss, buffer bps),
                                  // rescueReservePct 0; its margin moves and rescue reserve are shown apart, in its
                                  // checks. Otherwise (watch windows, which price neither) basisPct is the mark gap
                                  // and timing loss
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
  veto?: { verdict: 'pass' | 'veto'; reasons: string[]; model: string; at: number };   // NEAR AI risk check, can only refuse (verdict "veto": refused)
  refused?: { code: string; reason: string };   // tradable, but it cannot be entered now: the contract would refuse
                                                // it (E_ORACLE_STALE, E_ASSET, E_SIZE) or no desk exists (E_NO_DESK)
  note?: string;                    // not a refusal: what the desk will do at open for an enterable window, shown on
                                    // the row ("stored ETH price stale: refreshed at open", a trading serve only)
  held: { since: number } | null;   // the desk holds this window now
  checks: { ok: boolean; text: string }[];   // what the engine checked (policy, oracle, rescue path, the carry
                                             // gate on the multi-day spread), one line each, engine-written; the
                                             // first failing one is why it is not entered. Enterable = tradable, not
                                             // refused, not stale, every check ok, not refused by the NEAR AI risk check
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
      | 'deposit' | 'withdraw' | 'fee' | 'wait';   // wait: the strategy's reason not to act changed
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
owner's own `set_policy` transaction (and the engine rules only after the owner confirms them); the NEAR AI risk check can
only remove a window from consideration; nothing a model returns is ever sent to the contract or a venue. Model: a NEAR AI Cloud TEE model with JSON output
(`Qwen/Qwen3-VL-30B-A3B-Instruct`, no reasoning, ~1 s); if NEAR AI is down, drafting is unavailable and
windows pass with no NEAR AI risk check.

## 3. Engine internals

**Strategy loop** (E10, `engine/src/strategy/`). The agent finds funding, enters, holds, exits and rotates by itself;
the contract still decides what is possible, so the loop can lose money on a bad trade but cannot move money
anywhere the policy does not allow.

- `decide.ts` (pure): `decide(DecideInput) → Decision` with the shapes in that file. Entry: the top of the
  scanner's ranked list among the windows passing the entry rules (`isEnterable`, `netAprPct ≥ minNetAprPct`, the
  7 d and 14 d spread signs agreeing with this hour's, depth on both legs; not in `DecideInput.unopenable`, the
  windows the loop's hands refuse (serve opens long Phoenix / short Hyperliquid only, on the policy's markets); not in
  `DecideInput.costRefused`, the windows whose open the pair trader refused for cost (its own book reads: the spread
  over the 168 h hold does not cover `deskRoundTrip`, the scanner's own round trip), until the next hourly check, the
  window's count starting again (`skipAct`'s `costRefused`), so the next window is the one entered; and
  free margin on each leg venue, plus what a close frees, opening at least 10 USD a leg at the leverage in whole
  lots, as the size below rounds it: the loop never moves margin to open; a venue whose free margin was not read
  this check is skipped, so a read failure never resets the count), once it has passed them for
  `StrategyConfig.enterAfterChecks` hourly checks in a row (default 3); until then the loop waits on it ("k of N hours") and never
  enters a lower window instead. Size: `legUsd` capped by the policy's `max_notional_usd` less the band, by free
  margin at the leverage and by depth, rounded down to whole common lots; a cap that is not a finite number or is
  ≤ 0 sizes nothing. Leverage ≤ `maxLeverage`, ≤ 1.5 on a leg without a live rescue. Stops, first and at once: the
  time stop (needs only a finite `HeldPair.since`) and drawdown ≥ `stopDrawdownPct` (needs a finite `pnlUsd`,
  `legUsd` > 0 and a finite stop), where drawdown is `HeldPair.pnlUsd` against one leg's notional `HeldPair.legUsd`;
  no other unknown number keeps them from firing. Past the stops, a held pair whose P&L, leg size (≤ 0 included),
  window numbers or rules are not finite gets no act: a `wait`, "held pair numbers unknown", never counted healthy.
  The held window is judged from here (`heldForwardAprPct`): its multi-day gross (`netAprPct` plus the costs the
  scanner took off) less the exit still to pay (half the fees and slippage plus the basis buffer), in the constant
  points the scanner spread them over its hold, never re-spread over the hours left (the exit is paid whenever the
  pair leaves, so it never times the exit); the opening fills are sunk. Exit: that figure under `minNetAprPct`, or a sign
  flip, for `StrategyConfig.exitAfterChecks` hourly checks in a row (default 6: "n of 6 hours before exit"); then `cooldownHours`.
  loop.ts passes both counts to decide() as `DecideInput.rules` (absent = `LOOP_RULES`' defaults, also 3 and 6) and
  prints them on the start line. The counters (`aboveByWindow`, `badChecks`) stay raw counts: a raised number is
  not reached early, and a lowered one is acted on at the next check, a scan event included, once the count already
  reached meets it. Rotation: another window's `netAprPct` beats that held
  figure by `rotate.minGainPts` for `rotate.forHours`
  and `switchCostUsd` pays back within the hold at that gain on the new leg's sized `legUsd` (the switch cost is not
  scaled); the new legs are sized on free margin plus `DecideInput.freedMarginUsd` (loop.ts measures it: the held
  legs' margin plus that leg's P&L, per venue; absent = none); windows on venues that already hold the margin first;
  at most `maxRotationsPerDay`. Every decision carries a one-line reason with the numbers; a `wait` is journaled only
  when its reason or failure category changes.
  - `qty` on an `enter` or `rotate` act is the base units a leg, whole common lots of both venues, and a maximum. The
    executor never derives a size again from `legUsd` (which is `qty` at the price it was sized at). The contract
    values an order at sz × max(limit, oracle) against the cap, so at order time the executor re-checks
    `qty` × max(limit, oracle) ≤ the cap and, if a price move put it over, rounds `qty` down only, to whole common
    lots, the same on both legs, before either leg is sent.
  - On a `rotate`, loop.ts sets `HeldPair.since` to the rotation time: the time stop and the payback horizon start
    again.
  - The hours left for payback are clamped to the whole hold: a `since` in the future (clock skew) never adds hours.
  - A NEAR AI risk check refusal or a failed act: loop.ts saves `skipAct(input, decision)` instead of
    `decision.counters`; on a refusal of the NEAR AI risk check, `skipAct(input, decision, { vetoed: true })` holds
    that window out of entries and rotations for `LOOP_RULES.vetoHoldHours` (6 h, `LoopCounters.vetoedUntil`) and
    starts its counts again, and the wait says so ("refused by the NEAR AI risk check (<why line>), held out for N h
    more"; the why line is kept in `LoopCounters.vetoWhy` while the hold lasts). Saved counters without `vetoedUntil`
    read as none refused.
- `veto.ts`: the NEAR AI risk check before an enter or a rotate (the client behind `POST /policy/draft`). No key, no
  answer in `vetoTimeoutMs`, or a transport/HTTP error = pass, journaled "no NEAR AI risk check" (a 401 or 403 says "NEAR AI
  key rejected", so a bad key shows on every decision). The whole reply is read; one that is not exactly one readable
  verdict (no JSON object, more than one, text around it other than ``` fences, a key given twice, not "pass" or
  "veto" after trimming and lowercasing, a "veto" inside a "pass", cut off at its token limit) fails closed: refused,
  "unreadable reply". A refusal drops the window and writes a journal entry of kind `veto` (the kind keeps its name;
  every text the owner reads says "NEAR AI risk check").
  - The why line (`riskCheckWhy`): every enter, rotate, skip and refusal decision carries one, in its summary and as
    `numbers.riskCheck`: "NEAR AI risk check passed (<attestation>): <reason>", "NEAR AI risk check refused
    (<attestation>): <reason>" (an unreadable reply too), "risk check timed out: passed", "no NEAR AI key: not
    checked", "NEAR AI key rejected (…): not checked, passed" or "NEAR AI risk check unavailable (…): passed".
    `<attestation>` is serve's `Attestor.label()` ("TEE attested <date> UTC" or "TEE not attested: <why>"), shown
    only for a reply that came. It says what the model's TEE instances were when last attested; that the reply came
    from those instances is not verified (per-reply signatures need the key and are not fetched). A refusal before the check is asked (no hands, the window not in the scan, a symbol serve does not trade)
    says "NEAR AI risk check: not asked (refused before it)". The decision event is published again with it, after
    the decision's own reason, so a window whose stored price the open refreshes carries both ("…; stored SOL price
    stale: refreshed at open; NEAR AI risk check passed (TEE attested …): …"). Every outcome after the check carries
    it, the refusals #92 added included (a rotate's prepareOpen refusal, the paid-refresh hold line, the open's
    no-refresh refusal). The order is the check (and its facts), then a rotate's prepareOpen (which may pay for a
    refresh), the close and the open: a refusal never costs a refresh.
  - The journal numbers of every check that was asked: `vetoModel`, `vetoKey`, `vetoSystem` and `vetoPrompt` (the
    exact messages sent), `vetoReply` (the model's text as it came), `vetoMs` (latency), `riskCheckOutcome`
    (passed, refused, unreadable, timeout, unavailable, no-key, key-rejected) and `attestation`. The API key is never
    in an exchange, a line, a reason or the ledger (an error quoting it, or a 200 body quoting it, is redacted).
  - The facts sent (`vetoFacts`): per leg `open_interest_usd` (the carry), `book_depth_usd` and `fill_impact_bps`
    (serve-loop.ts `riskFacts`: 20 levels of the side the leg fills, read when asked, and not read at all when the
    check is not configured (no key); impact = the size's VWAP
    against the mid, null when the levels read do not fill it), `price_move_24h_pct` (the venue's mark against its
    own price 24 h ago: Hyperliquid `prevDayPx`, Orderly `24h_open`, Phoenix `prev_day_mark_price`) and
    `days_since_listing` (Orderly's `created_time` only; the other venues do not give it). Anything a venue does not
    give, or does not answer within 3 s, is null, which the prompt calls unknown; nothing is guessed.
  - Recordings: `RecordedVeto` plays exchanges by prompt key, with their recorded latency.
    `npm run record-nearai -w engine -- --risk-checks` sends the prompts of `fixtures/nearai/SYNTHETIC-veto.json`
    for real (the human's step: it spends tokens) and writes `risk-checks-<date>.json`; serve replay with no key
    plays those.
- `nearai/attestation.ts`: the TEE attestation of the model. `GET https://cloud-api.near.ai/v1/attestation/report
  ?model=…&nonce=<32 fresh bytes>&signing_algo=ecdsa` (public, no key) and NVIDIA NRAS
  (`POST https://nras.attestation.nvidia.com/v3/attest/gpu`) for each model TEE's GPU evidence. For the gateway and
  every model TEE it checks: the Intel TDX quote (v4: its ECDSA P-256 signature by the attestation key, that key
  bound by the quoting enclave's report, the QE report signed by the PCK certificate, the PCK chain to the pinned
  Intel SGX Root CA, each certificate within its dates), not a debug TD, the report data = signing address ‖ 12 zero
  bytes ‖ our nonce (and the echoed nonce), MRCONFIGID = 01 ‖ sha256(app_compose), the event log replaying to
  RTMR0-3 with the compose-hash event equal to the app_compose hash, and the GPUs' evidence carrying our nonce with
  NRAS's overall result true (a model TEE with no GPU evidence is not attested). It does not check: the TCB level or revocation (Intel PCS collateral), an allowlist of
  measurements or images, the NRAS token's signature (read over TLS), or that a given reply came from the attested
  instance (per-reply signatures need the key and are not fetched); every attestation line and journal entry says
  so. serve fetches it in the background once the server runs (never on the start path) and every 24 h, logs and
  journals the line when it lands (kind `wait` when verified, `error` when not, `numbers.stage` "attestation", with
  the steps, signing addresses, MRTD, RTMR3 and compose hashes); until then checks show "TEE not attested: …". A
  check is "TEE attested <date>" only with a live, verified report under 25 h old. Replay plays the newest
  `fixtures/nearai/attestation-<date>.json.gz` (`record-nearai -- --attestation`) and shows "TEE not attested:
  replay plays an attestation recorded <date>". A failed attestation never blocks trading.
- `book/risk-ledger.ts`: every risk check outcome, appended (fsynced) to `risk-checks-<mode>[-<contract>-<desk>]
  .jsonl` next to the position book under GIMBAL_STATE_DIR: a `check` line (prompt, model, reply, latency, verdict,
  attestation, why line, leg size, forecast, the round trip the scanner priced: fees, slippage and basis, the hold);
  an `act` line when the act after it ended (opened, with the book's position id `<window>@<time>`, or not, with
  why); and, for a refusal, `hours` lines on each hourly check with the gross APR the refused window actually paid
  each hour (the scanner's `grossHours`), over `LEDGER_HOLD_HOURS` (the scanner's 168 h cost hold, capped by the time
  stop). The same act asked again within `LEDGER_RETRY_MS` (1 h: a retry after a refusal that passes, same window,
  kind and verdict, not opened) is not booked again; its act is booked only if it opens. Serve keeps in memory only
  the refusals still pricing (at most 500; a refusal fully priced, or 14 days past its hold, is not asked again).
  `npm run report` reads it offline. A refusal's estimated net = Σ gross / 100 × leg / 8760 over the hours priced,
  less the round trip prorated by hours priced / hold; it is pending until the whole hold is priced, then helped
  (< 0: a loss avoided), hurt (> 0: a gain given up) or even. A window refused again inside an earlier refusal's
  hold is a repeat, counted in that first one, so each window-hour counts once. The counterfactual is a full hold: it
  leaves out the exits the loop's own bad checks would have made. A pass (and an unchecked pass) shows the position
  its own act opened (matched by position id, never by time; a pass whose open failed shows none), realised net
  (running while open). Then the totals: the fully priced refusals' sum, and the pending ones' estimate apart.
- `loop.ts` (serve): runs `decide` after each funding payment (the hourly check) and on each scan event, only with
  `GIMBAL_TRADE=1` and `strategy.auto`, one decision at a time under the per-desk trader lock, never while a rescue,
  an ADL unwind (`AdlWatch.unwinding`: its close signs or is in flight), an open ADL event, an ADL check confirming a
  leg off its baseline (`AdlWatch.confirming`) or panic_close runs; the read-only ADL check beside every desk read is
  not one while it sees nothing off. Every open's gate, asked again before its first order and each later part, also
  refuses a pair paused since an ADL (serve-loop.ts `openGateText`). It carries `act` out with the same open and close code as `pair-mainnet` (maker first),
  publishes `decision` events and journals `enter` / `exit` / `rotate` / `veto` / `wait` with numbers and tx links,
  each enter, rotate and refusal with the risk check's why line, books every check in the risk check ledger (a ledger
  that fails is logged, never the act's), and saves `LoopCounters` next to the trader state. `POST /rotate` and `POST /close` go through the same path.

**Position book** (`engine/src/book/`, serve with a contract desk). Every carried-out enter and exit comes in through
the loop's `book` sink (`BookRecord`, with `startedAt`: when the act began), and so do the fills of an open or close
that did not end as asked (kind `fill`); a pair the loop holds that the book never saw enter is adopted from the loop's
own `since` (never one the book closed after that `since`). Closes made outside the loop are booked from what they
return (ProtectedPair's `onProtectionClose`, for a close that names itself `by`): `panic_close`, `rescue reduce` and
`ADL unwind` book an exit with that reason when both legs ended flat, else their fills as a `fill` record (booked on
the next turn of the event loop, so the protection never waits on the book's fsync). One that left no result (it
threw), or whose booking failed, is read at the next sync: the venues' fills over its own time (`userFillsByTime`,
Phoenix trades-history) are booked as a `fill` with its reason while the loop still holds the pair. An open position
the loop no longer holds (`loopHeld()` null, 2 min after its last record; unknown without hands or before the start
is confirmed) gets an exit "closed outside the loop" from the venues' closing fills since its last record, checked
again after the reads. A leg whose fills cannot be read holds that exit for the next sync; after 24 h it is booked
with what was read, "closed outside the loop (fills unread)", `fillsUnread` and `estimated` 1 in the final entry. An
entry into a window the book still holds open closes that stale position first the same way (fills unread). Funding is the venues' own ledgers for the desk's addresses (Hyperliquid and Phoenix `userFunding`),
never a rate times a size: synced at start (a catch-up from the last read less 24 h) and every hour 5 min after the
top of the hour, as background reads below the risk engine's account reads, and read until 24 h after an exit; each
payment stored once (venue, time, symbol; a Phoenix hour whose sum changes later is stored again as the difference)
and counted only on its position's symbol between the act's start (`startedAt`, else the record less 10 min; never
before the previous exit there) and its exit, on the leg side its signed size matches. A Hyperliquid daily aggregate
counts only the hours of its day no hourly row covers; its split per hour is not verified, so its amount is marked
estimated (`estimated` 1 in the funding entry and the final one, "estimated from daily aggregates" in the report).
Orderly (only when serve hands `liveBookSources` its `orderly` reads; the book's `orderly` address is the account id):
funding from the signed `funding_fee_history` read (made only when a funding time on the 4 h UTC grid, plus 1 h to
post, fell after the last read), booked under the book's symbol ("PERP_SOL_USDC" as SOL, 1000X as kX); one row per
funding period (8 h or 4 h), exact, never estimated; owed only on its funding times (each payment interval on that
payment's period, else 8 h): missing there, nothing between (journal "its 8 h funding period"; report "N of M
payment(s)", "not read" for a leg never read). Its fills come from the private session's executionreports
(`OrderlyFillLog`, `book/orderly.ts`: the fills' `fee`, else `totalFee`, in USDC, > 0 a cost; fed `onExecutionReport`,
`heard` per frame, `down` / `up`; fills and gaps kept 48 h); a window it did not hear (before the session started,
reaching back to something it dropped, while down, or not heard 10 s past its end; a read up to now waits up to 30 s
for that, once per silence) is a failed read, and an Orderly leg without the log fails its fill reads. Known limit: a
position opened before serve's last restart starts its close window before the new session, so an Orderly close of it
made outside the loop is booked after 24 h as "fills unread" (price and close fees estimated); the contract has no
fills read kind that could recover it. Fill fees come from the record, else the venue's fills in the
act's window (`userFillsByTime`, Phoenix trades-history, the Orderly fill log); margin-move fees and `addTransfer()` (rescue, fund scripts)
are transfer costs; the desk's Hyperliquid `userNonFundingLedgerUpdates` are booked to the desk, not a position; a tx
hash already booked is never counted twice. Per position: funding per leg and in total, fees and price over every fill
(price: each fill's cash flow, once closed), transfers, net, hours held, and the actual APR next to the forecast net
APR: (funding + fees + price) / leg notional, annualised over the hours the ledgers were read for (open or closed),
transfers left out as the forecast leaves margin moves out. Journal: `funding` once per hour per position (each leg
and the total in `usd`; an hour a leg did not pay is journaled 3 h later with that leg `missing`, a later booking as
`late`, its id naming the first payment time and, for a changed hour, `adjN`), `fee` for fees the loop's entries do not carry, `deposit` / `withdraw` from the Hyperliquid ledger; the
loop's own `enter` / `rotate` / `exit` entries get the book's numbers (position, legs, signed `feeUsd`, forecast; at
an exit funding, net, actual APR, `fundingThrough` and `settling` 1, and "funding read to HH:MM, settling" in its
summary). Once every leg's ledger is read past the exit + 2 h, one settled entry carries the final numbers: kind
`funding`, `final` 1 and `settled` 1, no `usd` (the hourly entries carry the money), "final as of HH:MM" in its summary
and the report; a payment booked after it is a late entry with `afterFinal` 1, an adjustment against the final, and
the report shows it. On disk in `GIMBAL_STATE_DIR`:
`book-<mode>-<contract>-<desk>.jsonl` (append-only events, each append fsynced; a write that fails, short or in its fsync, is cut
back to the size before it and thrown; if that cut fails too, the book is read only until restart, journals one
`error` and says so in the monitor line; a torn last line from a crash is dropped on load, and so is a second copy of
an event, said in the log; a read that stored nothing adds no line) and `.summary.json` derived from it (written atomically after
the call that changed the book). `npm run report [-- --state <dir>] [--sync]` prints it; `--sync` reads the ledgers
(read only) into that report alone.

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
  rateReadAt?: number;                   // ms: the rate is from this earlier read, the venue's latest refresh of it
                                         // having failed (Phoenix serves its last hourly overview up to 10 min); the
                                         // scanner counts the row stale (its windows stale). Absent = read now
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
notional. In serve the venues are the desk's Hyperliquid and Phoenix accounts, plus its Orderly account with
`GIMBAL_ORDERLY_PAIRS=1` (default off; `engine/src/cli/serve-orderly.ts`): serve then keeps the desk's private Orderly
session open from the moment serve listens (one `orderly_ws_auth` and the `positions` and `holding` reads per
session, through the operator key), reopens a session that held 10 min at once and otherwise after 60 s doubling to
15 min (back to 60 s once a session is live; never two opens within 30 s), re-reads a seed read that failed on the
same backoff, and never re-reads one that answered with rows it cannot use (it waits for a push). It reads the Orderly
account as unknown at once, without waiting (a failed read: Orderly down, its legs kept at their last numbers, at
least watched), before the first session, while one is opening, down or unseeded, and when the server has been quiet
for 30 s. A holding read with no USDC row is an empty balance (Orderly omits empty tokens unless `all=true`). The
strategy loop's free margin reads it too, within 7 s, and logs a failed read once per kind of failure. Its listeners
get each session's `onUp` (logged in, every subscription acknowledged), `onFrame` per server frame, and one `onDown`,
in that order across reconnects, and nothing after serve stops. It opens no Orderly window and changes no rescue
route. Lines (`thresholds.ts`):
- rescue line = `max(rescueDistancePct, (exp(4 σ √185 s) − 1) × 100)`, where σ is the leg's realised volatility per
  √s over the last 30 min (at least 10 returns, else the owner's line alone) and 185 s is the slow rescue measured on
  mainnet (a 120 s MPC signature plus a 65 s 1Click transfer);
- watch line = `max(watchDistancePct, rescue line + (watchDistancePct − rescueDistancePct))`;
- a leg leaves a level only once its distance clears the line by 1 point (hysteresis).

Rescue triggers are per leg: a leg that reaches rescue is triggered once; while it stays in rescue it is triggered
again only when its rescue failed or lapsed (no end within 370 s), after a backoff of 30 s doubling up to 10 min. A
leg that leaves rescue starts afresh.

**Rescue routes (engine, `engine/src/rescue/serve-rescue.ts` `MAINNET_ROUTES`).** serve prints them at start. Live on
mainnet with `GIMBAL_RESCUE=1`:
- reserve → Hyperliquid: `fund_venue` into HyperCore USDC; the landing is an incoming entry in the desk's Hyperliquid
  ledger (`userNonFundingLedgerUpdates`), 1Click's delivery hash first, never the equity.
- reserve → Phoenix: `fund_venue` into Solana USDC for the desk Solana authority; once 1Click's delivery is on Solana
  and the desk's USDC account holds `minAmountOut` more than it held before the payment (the balance is read just
  before the hold opens and saved with it, so USDC already there is never taken for the delivery), a plain `sol_sign` deposit (Ember wrap + `deposit_funds`, 400,000
  units at 100,000 micro-lamports, under the 200,000 cap of a message that is not a rescue); the landing is that
  deposit, confirmed. Before anything is paid the engine checks a deposit could follow (a registered trader, a
  running desk, SOL for the fee), else the rescue is refused. A delivery that reaches the desk's USDC account with no
  deposit after it (serve stopped first, the deposit failed, or the rescue was parked and 1Click's SUCCESS is read
  after a restart) is settled: the wallet is read (bounded to 10 s), then the hold is released and saved, then the
  journal says, as an `owner:` line, how much was delivered. It gives the `pair-mainnet fund-phoenix` command only
  when no deposit was ever about to be signed (the hold saves a "credit started" marker first; a deposit that throws
  `NothingExecuted` counts as never signed), the release was saved, and the wallet still holds the saved baseline
  plus the delivery. Otherwise it says why and to check first: the deposit may have run (check Phoenix margin and
  the desk's Solana transactions), the wallet could not be read or did not answer in time, no baseline was saved,
  the delivery is not on the wallet yet, or the state save failed (a restart reads the hold again). The engine never
  deposits it late. Known limitation: a delivery that reaches the wallet after its rescue gave up is counted by the
  next Phoenix rescue's credit as part of that one's delivery (the money is misattributed, never deposited twice).
- Phoenix → Hyperliquid: one `sol_sign_rescue` transaction to the 1Click deposit address (Solana USDC for HyperCore
  USDC), the landing in the Hyperliquid ledger. The message is one of three, built and simulated unsigned before the
  hold is saved: spare USDC already on the desk's USDC account (the deposit owner's account and the
  `TransferChecked`, 100,000 units at 100,000 micro-lamports); a Phoenix `withdraw_funds` + Ember unwrap of what the
  account lacks, the transfer of `amountIn` and the `Revoke` (400,000 at 100,000); a paused desk's lean rescue (no
  price, no create of a desk account). It is refused before signing when the authority lacks the SOL (fee, token
  account rents, the 890,880-lamport reserve), Phoenix lets less be withdrawn, or the simulation fails. It is signed
  once and never rebuilt: the deposit ring takes the quote once.
- Both Phoenix routes need a Solana RPC (`SOLANA_RPC_URL`, default the public mainnet RPC) that serves
  `getSignatureStatuses` with `searchTransactionHistory`, which the Solana hold rule reads (a held `sol_sign_rescue`
  is released once the finalized height is past its `lastValidBlockHeight` and the signature is unknown, or once the
  signature is finalized with an error; a send that proves nothing ran, `NothingExecuted`, releases it at once). serve
  probes it at start with a finalized signature at least 10,000 slots old (the oldest of the last 1,000 naming
  Phoenix's withdraw queue); without history both Phoenix routes are refused, the start line says why, and Solana
  holds stay held.

Replay only (wired, run in the recorded worlds): Hyperliquid → Phoenix (`hl_withdraw`, `evm_usdc_to_intents`, then
the `sol_sign` deposit; not yet dry-run on mainnet), and reserve or Phoenix → Orderly (an Orderly landing needs its
private API, which serve does not open). Not built: Hyperliquid → Orderly (Arbitrum USDC into Arbitrum USDC, which
1Click does not quote). Into HyperCore 1Click delivers at least 1.31 USDC (`minAmountOut` under it is refused before
signing; about 1.65 USDC sent). `npm run rescue-dry -w engine -- --mainnet --contract <id> --desk <id>` prints both
Phoenix routes for a desk, keyless: the plan, 1Click's dry quote, the message simulated unsigned and every refusal.

**Rescuer state** (`engine/src/rescue/state.ts`). On mainnet the rescuer keeps its holds, an OutcomeUnknown, the USDC
its own `hl_withdraw`s left on Arbitrum, a withdraw on its way, the rescue cap's sliding hour and the ledger entries
and logs already matched in one file per desk: `rescue-mainnet-<contract>-<desk>-<desk evm>.json` in
`GIMBAL_STATE_DIR` (default the per-user state directory, `%LOCALAPPDATA%/gimbal/state`, else
`$XDG_STATE_HOME/gimbal` or `~/.local/state/gimbal`). It is written atomically before every signature and withdraw
(no save, no signature) and after every change; it holds nothing secret. serve prints the path at start (`holds and
the cap meter kept in ...`) and, when it loads the file, `rescuer state loaded from ...: N held transfer(s), an unknown
outcome, ...`. Off mainnet the recorded worlds keep their holds in memory.
- **A persisted OutcomeUnknown** (`"unknown"` in the file: a sentence naming the rescue and what to reconcile) is
  saved when a rescue's `hl_withdraw`, or the Phoenix deposit after a reserve → Phoenix delivery, ends with no proven
  outcome. It survives restarts and holds every transfer (reduces still run) until the owner clears it: reconcile
  first (for a withdraw, the Hyperliquid ledger and the desk's Arbitrum address; for a deposit, the desk's Solana USDC
  account and its Phoenix collateral, then `pair-mainnet fund-phoenix` if the USDC still waits), stop serve, set
  `"unknown"` to `null` in that file and start serve again. A hold is cleared the same way, by deleting its entry
  from `"holds"`. Do not delete the file to clear either: a missing file holds every transfer (below).
- **A missing or unusable file** (unreadable, another contract, desk or EVM address, a field a save would not write,
  a version 1 file) is never taken as "no holds": every transfer is held, reduces still run, nothing is written
  there, and the start line says `rescuer state missing` or `rescuer state unusable: ...`. After reconciling, the owner
  repairs the file, or moves it aside and starts once with `GIMBAL_RESCUE_FRESH=<contract>/<desk>`, which writes an
  empty one (any other value is ignored, and so is the right one over a usable file). serve refuses it while the
  contract counted a rescue or a `fund_venue` of the desk in the last 65 min, or while the state directory holds a
  trace of the desk's rescuers (a state file of any EVM address, a temporary file, a copy, or the `.fresh` marker the
  first refused FRESH writes) under 65 min old: a NEAR call an earlier rescuer sent may land until its quote's
  signed time + 65 min. A first run counts the rescue cap as used in full, freeing over its first hour.

**The pair in serve (mainnet).** `serve` adopts the carry pair `pair-mainnet open` made from the venues at start
(`engine/src/cli/serve-pair.ts`: the Hyperliquid and Phoenix legs and the relayer of `pair-mainnet-lib.ts`) and
holds it in a `PairTrader` behind `ProtectedPair` (`engine/src/trade/protected-pair.ts`). Every order it sends is
reduce-only and IOC, after the stored price is refreshed to last the order and its retry (the 300 s price-life rule),
each target clamped between 0 and the leg's position when the close runs: panic_close (the contract flips the desk
to `closing`) cancels the desk's resting Hyperliquid orders on the policy's coins and closes both legs (the Phoenix
leg sends IOCs only, so nothing rests there), a rescue's `reduce` route makes both smaller, a confirmed ADL unwinds
both. Serve never opens or grows a pair. It trades only with `GIMBAL_TRADE=1`, from the main checkout, never with
`--once`, holding the per-desk lock, which `pair-mainnet --send` takes too for its whole run (neither starts while
the other holds it; a lock file with no pid in it counts as held). The lock is
`locks/trader-<mode>-<contract>-<desk>.lock` in the per-user state directory (`%LOCALAPPDATA%/gimbal/state/locks/` or
`$XDG_STATE_HOME/gimbal/locks/`, not `GIMBAL_STATE_DIR`). It names its process by pid, start time, a random id and
the host's boot id, and its holder touches it every 30 s (the file's mtime is the heartbeat). A lock of a pid that
runs here is held. Any other lock is stale only once its heartbeat is over 90 s old: one of another boot id, of a pid
not running here, or of this very pid (node is pid 1 in every container, so a killed container leaves "pid 1"
behind), since a container may have a boot id and a pid namespace of its own and an overlapping one must wait. A stale
lock is taken over under a second exclusive file, `<lock>.takeover` (it holds its maker's token, and only its maker
removes it), so that of two starters that read the same stale lock only one takes it; the takeover is journaled. A lock held by a live other process does not stop serve: the pair starts alert only with its legs unknown
and the lock is tried again with the start's backoff (the same as a start read that failed). When the acquire error says the lock
"holds no pid" (empty or partly written: a crash while it was being made), first check that no serve and no
`pair-mainnet` runs for this desk (Task Manager or `ps`), then delete that one file and start again. Otherwise every
protection only alerts, says so, and holds no lock. A resting order on the pair's coin at start also makes it alert
only (it could fill under the trader). On SIGINT or SIGTERM serve starts no new trigger, waits up to 180 s in all
(the risk engine's ADL attempt, a close in flight, and a running rescue: it signs nothing new, one already signing or
sending goes on until its payment is sent and saved as held, then it stops waiting for 1Click), then turns trading off before it releases the lock: from then
on every close, order and cancel is refused, nothing signed. At start
serve prints which legs are live, which protections trade, which only alert (ADL too, while it is held or the
baselines do not offset), and which rescue routes run on mainnet.

**ADL** (`engine/src/risk/adl.ts`). A leg that shrank toward zero against the trader's baseline (the positions after
the last close, adopt or restored state; never what a watch read or reconciled) with no order of ours in flight,
confirmed by a second read 3 s later, is ADL: the pair is paused and both legs are unwound reduce-only. The pause
stops opens only; a rescue (its transfers and its reduce) and panic_close still run. There is no
partial re-hedge. While the saved state held orders in flight at start (our own order may have moved a leg), a
shrink starts no event: it is journaled once for the owner and nothing is traded, until a close result or an adopt
sets the baselines again, or the orders are settled from the venues. An order cannot run more than 10 min after it
was signed (a Hyperliquid IOC answers at once, a Phoenix blockhash lasts about 2 min), so once the youngest is that
old (at start, or on a timer serve sets for it) both legs are read twice alike: when each reads its saved baseline
moved by none, some or all of its orders in flight (each in full) and the two reads offset each other as the pair's
net, they are adopted and the hold ends. Explained leg by leg but not offsetting (one leg moved alone: an ADL while
serve was down looks the same as an order of ours that never went out), they are not adopted: the hold ends and the
saved baselines stay, so the ADL watch takes the shrink (two reads, then both legs unwound reduce-only; a reduce that
never went out is over-unwound, which is safe). While a leg has an order with no answer, nothing is adopted (the hold
stays; tried again each minute). Every outcome but an adopt is also journaled for the owner (`error`, `owner: ...`).
Otherwise the hold stays, and the start line `ADL -> alert only: ...` says what the owner runs (**reconcile**): check both legs
(`npm run monitor -w engine -- --mainnet`); to close them, stop serve, `pair-mainnet close <SYM> --send`, start serve
again (a close result clears the hold); if the legs are right as they are, stop serve, move the trader state file
aside and start serve once with `GIMBAL_TRADER_FRESH=<contract>/<desk>`. A close clamped to the legs as read (a
rescue's reduce queued behind another close) can leave the legs not offsetting: the pair then counts as not hedged
before (a shrink is alerted, not unwound) until a close offsets them, and the `open:` lines say so. Each pair has one budget of 3 unwind attempts across all events and restarts, counted on disk
before the attempt's first order; a failed attempt raises the `unhedged` alert and is retried after 60 s doubling up
to 10 min; when the budget is spent the owner is alerted (journal `error`, `owner: ...`) and nothing more is sent.
Every stage is journaled (`adl` with `numbers.stage`: unwound, flat, failed, gave-up, alert, not-adl), and the
alert is cleared when the event ends. A leg that grew or flipped, or a pair that was not hedged before, is not ADL:
it is journaled once for the owner and nothing is traded.

**Trader state.** The trader's open pair, orders that may still run, Hyperliquid post-only orders not settled, the
orders in flight and the ADL budget and pause are saved in `GIMBAL_STATE_DIR` (default: the per-user state directory,
`%LOCALAPPDATA%/gimbal/state` or `$XDG_STATE_HOME/gimbal`) as
`trader-<mode>-<contract>-<desk>-<desk evm>.json`, written atomically (temporary file, fsync, rename, then the
directory fsynced on POSIX) and refused for another contract, desk or address. Every order is saved in flight, one
entry each, before it is signed, and leaves that list only in the save that holds the trader's result for it (a
close's result, a watch check's report, an adopt). A reader removes only its own temporary files and those of a
process that is gone. A missing or unreadable file is not a fresh start: serve then only alerts until it is started
once with `GIMBAL_TRADER_FRESH=<contract>/<desk>` after both legs were checked on the venues. That holds for a first
start with both legs flat too: with no file, serve keeps no pair and the strategy loop gets no hands until that start
writes one. Any other value
(`1` included) is ignored, and so is the right one over a usable file: a usable file is always restored (a start line
says to remove `GIMBAL_TRADER_FRESH` from the env), so a shrink that happened while serve was down is compared with the
saved baselines and goes the normal ADL way (two agreeing reads, then the unwind). To start over a usable file, stop
serve and move the file aside first. Over a usable file, legs that read flat, or a new pair opened after a flat save, start over without
it.

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
- The rescuer saves an OutcomeUnknown of its own (an `hl_withdraw`, a Phoenix deposit) in its state file, so it
  survives restarts and holds every transfer until the owner sets `"unknown"` to `null` there ("Rescuer state").

**Record / replay.** `engine/fixtures/replay/<name>.jsonl.gz`, one line per call:
`{"t": <ms>, "venue": "hyperliquid", "method": "funding", "args": [], "ms": <how long the venue took>, "result": …}`,
with `"error": "<message>"` in place of `result` when the call threw (replay throws it again). `t` is when the
answer arrived; replay serves it from that moment on. A `ReplayVenue` answers
from the file on a virtual clock; `npm run demo` (`tools/demo.mjs`) plays the newest recording, about an hour of
mainnet answers, at ×10 (`--speed`) with the dashboard, and the Rescue screen's stress test pushes a leg past the
rescue line. `serve` in replay has no contract client and signs nothing; the tests use `ReplayContractClient`,
which applies the same policy checks and refusal codes as the contract (signatures marked as replay).
