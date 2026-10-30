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
    phoenix: Option<String>,           // PHOENIX_INVITE_CODE: Phoenix's invite gate before trader registration
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

Fees are fixed at `new` and visible in `config()`. Nothing is charged on deposits, rescues or losses.

MPC: `v1.signer` (mainnet), `v1.signer-prod.testnet` (testnet). OutLayer oracle: `price-oracle.near`.

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
floor (2 × the MPC derive gas + the callback gas + its own cost, ~54 TGas) with `E_ARGS`. The transaction's result
is the callback's. Desk ids are global, so another owner can take an id between the call and its callback: after
`create_desk` a client reads `get_desk(desk_id)` and checks that `owner` is its own account before it funds the
desk's addresses.
Without that check an owner could register their own wallet as the desk's address and take profit out through
`hl_withdraw` or `orderly_withdraw` without the performance fee. The Solana token accounts and the Phoenix trader
account are derived from the authority and checked from day 4 (Solana parser). They can never change afterwards.
Owner and operator can never be the contract itself, the MPC contract or the oracle (`E_ARGS`). The Solana key is also the desk's
Orderly key; the contract builds every payload either key signs, so the two uses cannot be confused.

```rust
struct Policy {
    hl_assets: Vec<HlAsset>,                 // { index: u32, symbol: String, sz_decimals: u8 }
    phoenix_markets: Vec<PhoenixMarket>,     // { symbol, orderbook: String /*base58*/, base_lot_e8: u64, tick_e8: u64 /*USD per tick ×1e8*/ }
    orderly_symbols: Vec<String>,            // e.g. "PERP_SOL_USDC"
    max_notional_usd: u64,                   // per leg, whole USD
    price_band_bps: u32,                     // order price vs oracle price
    oracle_max_age_s: u32,
    rescue_cap_usd_per_hour: u64,
    max_transfer_cost_bps: u32,              // 1Click: minAmountOut ≥ amountIn − max(bps share, flat); default 100
    max_transfer_cost_flat_e6: u64,          // USDC ×1e6; default 500000 (0.5 USDC; measured 0.21–0.32 on 4–7 USDC)
    unpriced: Vec<String>,                   // symbols WITHOUT an oracle price the owner explicitly allowed
    unpriced_max_notional_usd: u64,          // their own cap per leg (default 100); an unpriced order must fit
                                             // min(max_notional_usd, unpriced_max_notional_usd)
}
// Every u64 in Policy is at most 2^53 − 1 (E_ARGS above), so JavaScript reads it exactly.
// policy_sha256 (event policy_set) = hex sha256 of the policy JSON exactly as get_desk returns it.
struct SolanaAccounts {                      // registered by the owner; Solana programs enforce them
    authority: String, usdc_ata: String, phusd_ata: String, phoenix_trader: String,
}
struct Ledger {                              // USDC in 1e-6; money in and out passes through the contract on NEAR
    deposited: u128,                         // principal: only the owner's own deposits (base of the high-water mark)
    withdrawn: u128, fees_paid: u128, hwm: u128,
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

Performance fee on a payout `x` to the owner: `profit = withdrawn + x − deposited`;
`fee = performance_bps × max(0, profit − hwm) / 10000`; then `hwm = max(hwm, profit)`.

**Unpriced assets.** An order for a symbol in `unpriced` skips the oracle band (there is no trusted price)
and must fit `unpriced_max_notional_usd`; the `signed` event carries `oracle_px: null, unpriced: true`.
Only the owner can add a symbol to `unpriced` (it is part of `set_policy`); the UI shows such symbols as
"no price protection". Any other symbol without a fresh oracle price is refused (`E_ORACLE_STALE` / `E_ASSET`).

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
`set_policy` and `set_operator` take a storage deposit instead: at least 1 yocto (no deposit at all is the
FunctionCall-key path, `E_NOT_ALLOWED`) and at least the storage the call adds (`E_DEPOSIT`, measured as the
change in storage usage); the excess is refunded to the caller, and storage freed later is not refunded. The
contract never pays for storage a caller adds. Pausing takes no deposit, or the 1 yocto a wallet may attach to
every owner call; more would stay in the contract and is refused (`E_DEPOSIT`).

**Paused desks.** While a desk is paused every operator action method refuses `E_PAUSED`, except actions that
only reduce risk, which `panic_close` and a rescue rely on: reduce-only orders (`hl_order` / an `orderly_request`
order with `reduce_only: true`, Phoenix closes through `sol_sign` as the Solana parser decides, day 4), cancels,
and rescue transfers (`fund_venue`, `hl_send_to_intents`, `sol_sign_rescue`, within `rescue_cap_usd_per_hour`).
`set_policy` and `set_operator` work on a paused desk.

Mutating methods use `#[deny_unknown_arguments]`, so a misspelt argument is refused instead of read as `None`.

The owner's wallet signs only what needs the owner: `create_desk`, `set_policy`, `set_operator`, adding the
operator key, `set_orderly_receiver`, deposits and payouts. Venue setup runs from the engine through operator
methods, and its content is fixed by the policy, `Treasury`, `FeeConfig` and `OrderlyConfig`, so the operator
chooses nothing:
- Hyperliquid: `hl_set_referrer` (if a code is set), `hl_approve_builder_fee`.
- Orderly: `orderly_register`, `orderly_add_key`, the `receiver_address` lookup (the owner then pins it), and
  `referral_bind` (if a code is set).
- Phoenix: wallet login (`phoenix_sign_login`), `POST /v1/invite/validate {code, wallet_address}` with
  `referral_codes.phoenix` (body: verify on day 6), then `sol_sign_register`. The invite call itself is not signed
  by the desk, so the contract cannot enforce that code; it only gates access.

| Method | Owner | Operator | Notes |
|---|---|---|---|
| `create_desk(desk_id, policy, evm_address, solana)` | ✓ | | payable: storage deposit; ~100 TGas; the desk is stored in the callback after the MPC address check, and the transaction's result is the callback's (§1.2) |
| `set_policy(desk_id, policy)` | ✓ | | payable: storage deposit for a larger policy (≥ 1 yocto) |
| `set_operator(desk_id, operator: Option<AccountId>)` | ✓ | | payable: storage deposit (≥ 1 yocto) |
| `set_paused(desk_id, paused)` | ✓ | pause only | pausing: 0 or 1 yocto (more → `E_DEPOSIT`); unpausing needs exactly 1 yocto attached, so the operator key cannot unpause |
| `ft_on_transfer(sender_id, amount, msg)` | any sender | | USDC on NEAR only (`ft_transfer_call`, msg `{"desk_id"}`): owner → `deposited` + `idle_usdc`; others → `idle_usdc`; unknown desk → full refund (§1.2) |
| `fund_venue(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | sends the desk's USDC on NEAR to a verified 1Click deposit address (recipient = a desk venue address or the pinned Orderly receiver) |
| `withdraw_to_owner(desk_id, amount)` | ✓ | | pays USDC on NEAR the contract holds for the desk, minus the performance fee to the treasury |
| `hl_approve_builder_fee(desk_id)` | ✓ | ✓ | `ApproveBuilderFee` for the treasury builder at `maxFeeRate` from `FeeConfig` |
| `hl_set_referrer(desk_id)` | ✓ | ✓ | L1 action `{type:"setReferrer", code}` with `code = treasury.referral_codes.hyperliquid`; once per desk, before its first order; no other code can be signed; with no code configured it refuses (`E_ARGS`) and setup skips it |
| `hl_withdraw(desk_id, amount)` | ✓ | | emergency only: to the desk's own EVM address |
| `set_mock_price(asset, price_e8)` | contract owner | | only with `PriceSource::Mock` |
| `refresh_prices(assets: Vec<String>)` | ✓ | ✓ | asks the OutLayer oracle → stores price + time |
| `hl_order(desk_id, order: HlOrder, reason)` | ✓ | ✓ | price band vs stored oracle price |
| `hl_usd_class_transfer(desk_id, amount, to_perp, reason)` | ✓ | ✓ | |
| `hl_send_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Hyperliquid |
| `sol_sign(desk_id, message_b64, reason)` | ✓ | ✓ | Phoenix / Ember / own transfers |
| `sol_sign_register(desk_id, message_b64)` | ✓ | ✓ | Phoenix trader registration only: `register_trader` + `set_trader_capabilities_delegated`, two signers (desk + Phoenix's pinned onboarder) |
| `phoenix_sign_login(desk_id, message)` | ✓ | ✓ | Ed25519 over Phoenix's `/v1/auth/*` wallet-login message only, before the invite check and registration; the contract accepts only Phoenix's login template (`E_ARGS` otherwise). Template and endpoints: verify on day 4 |
| `sol_sign_rescue(desk_id, message_b64, quote, quote_signature, reason)` | ✓ | ✓ | rescue out of Solana |
| `orderly_register(desk_id, registration_nonce)` | ✓ | ✓ | EIP-712 `Registration` (nonce from `GET /v1/registration_nonce`, block time as timestamp, broker and chain from `OrderlyConfig`) |
| `orderly_add_key(desk_id, expiration_ms)` | ✓ | ✓ | EIP-712 `AddOrderlyKey`: the desk's Ed25519 MPC key as orderly key, scope `read,trading`, ≤ 365 days |
| `set_orderly_receiver(desk_id, receiver)` | ✓ | | pins the Orderly account's exclusive receiver address on Arbitrum (below); once. Owner only: a wrong receiver would redirect every deposit into Orderly |
| `orderly_request(desk_id, req: OrderlyRequest, reason)` | ✓ | ✓ | private REST call signed with the orderly key after policy checks: orders, cancels, and the money-path requests below |
| `orderly_ws_auth(desk_id, timestamp)` | ✓ | ✓ | one signature per private WebSocket session (positions, balances) |
| `orderly_settle_pnl(desk_id, settle_nonce)` | ✓ | ✓ | EIP-712 `SettlePnl`; runs before every withdraw, or the withdrawable balance is short |
| `orderly_withdraw(desk_id, amount, withdraw_nonce)` | ✓ | ✓ | EIP-712 `Withdraw` to the desk's own EVM address only (Arbitrum) |
| `evm_usdc_to_intents(desk_id, quote, quote_signature, reason)` | ✓ | ✓ | EIP-712 USDC `TransferWithAuthorization` (EIP-3009) from the desk's EVM address to a verified 1Click deposit address on Arbitrum; the relayer submits it and pays the gas |
| `panic_close(desk_id)` | ✓ | | pauses, then the engine sends reduce-only closes |

**Orderly money path.** In: 1Click delivers Arbitrum USDC straight to the account's *exclusive receiver
address* (`GET /v1/client/asset/receiver_address?chain_id=<id>&token=USDC`, pinned with `set_orderly_receiver`;
minimum 5 USDC — less is lost, so the contract requires the quote's `minAmountOut` ≥ 6 USDC); Orderly sweeps it
into the vault and credits it in 1–2 min, the desk signs nothing. Out, run by the engine, each Orderly REST
call signed through `orderly_request`: `settle_nonce` → `orderly_settle_pnl` → `settle_pnl` → `withdraw_nonce`
→ `orderly_withdraw` → `withdraw_request` → USDC on the desk's Arbitrum address (40–52 s) →
`evm_usdc_to_intents` → 1Click. The relayer's Arbitrum gas wallet holds a few dollars of ETH and can never
move desk money (it only submits authorizations the contract signed).

Views: `config()`, `get_desk(desk_id)`, `desks_of(owner)`, `prices()`, `version()`.

```rust
struct HlOrder { asset: u32, is_buy: bool, px: String, sz: String, reduce_only: bool, tif: String /* Ioc|Gtc|Alo */, cloid: Option<String> }
struct OrderlyRequest {                      // the contract builds path and body; the engine never passes raw JSON
    kind: String,                            // "order" | "cancel" | "cancel_all"
                                             // | "receiver_address" (GET /v1/client/asset/receiver_address?chain_id=<OrderlyConfig.chain_id>&token=USDC)
                                             // | "settle_nonce" (GET /v1/settle_nonce; path: verify on day 5) | "withdraw_nonce" (GET /v1/withdraw_nonce)
                                             // | "settle_pnl" (POST /v1/settle_pnl; body: verify on day 5) | "withdraw_request" (POST /v1/withdraw_request)
                                             // | "referral_bind" (POST /v1/referral/bind {referral_code}, code = referral_codes.orderly
                                             //   only; once per desk, permanent; path and field: verify on day 5)
    symbol: Option<String>, side: Option<String> /* BUY|SELL */, order_type: Option<String> /* IOC|LIMIT|MARKET */,
    price: Option<String>, quantity: Option<String>, reduce_only: bool, client_order_id: Option<String>,
    order_id: Option<u64>, timestamp_ms: u64,
    // settle_pnl / withdraw_request only: the fields of the EIP-712 message signed earlier and its signature.
    // The contract rebuilds the message itself (receiver = desk EVM, token USDC, broker and chain from config).
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

- Hyperliquid: POST `/exchange` with `payload` + `signature: { r: "0x" + affine_point[2..], s: "0x" + scalar, v: 27 + recovery_id }`.
- Solana: `payload = { "message_b64": "…" }`, `signature = { "scheme": "Ed25519", "signature": [64 bytes] }`;
  the transaction is `[1][signature][message]`. `sol_sign_register` is the exception: two signers, and
  Phoenix's API adds its onboarder signature and sends it.
- Orderly: `payload = { "method", "path", "body", "timestamp", "message": "<timestamp + METHOD + path + body, exactly as signed>" }`,
  Ed25519 as above; the relayer sends headers `orderly-timestamp`, `orderly-account-id`, `orderly-key`
  (`ed25519:<base58 public key>`) and `orderly-signature` (base64url of the 64 bytes). EIP-712 actions
  (`Registration`, `AddOrderlyKey`, `Withdraw`) come back as secp256k1 signatures like Hyperliquid's; Orderly
  takes them as `0x` + r ‖ s ‖ v (65 bytes, v = 27 + recovery_id).
- Arbitrum (`evm_usdc_to_intents`): `payload` = the typed-data message `{ from, to, value, validAfter, validBefore, nonce }`
  plus `token` and `chainId`; the relayer's gas wallet calls the USDC contract's
  `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)`.

### 1.5 Refusals

A refusal is a panic with a stable code first: `"E_PRICE_BAND: px 2500 is 4.3% from oracle 2397.1"`.
One exception: arguments that do not deserialize (wrong type, unknown field, out-of-range integer) panic inside
near-sdk before the method runs ("Failed to deserialize input from JSON"); clients treat that as `E_ARGS`.

| Code | When |
|---|---|
| `E_NOT_ALLOWED` | caller is neither owner nor operator, operator called an owner method, an owner method came without exactly 1 yocto attached, or a storage method (`create_desk`, `set_policy`, `set_operator`) came with no deposit (§1.3) |
| `E_PAUSED` | desk paused |
| `E_NO_DESK` / `E_DESK_EXISTS` | |
| `E_ARGS` | malformed argument: desk_id outside `[a-z0-9-]{1,32}`, bad address or base58/hex, `reason` over 280 characters, a once-only setting set twice, `create_desk` with less prepaid gas than its floor (§1.2) |
| `E_DEPOSIT` | attached deposit below the storage cost (`create_desk`, `set_policy`, `set_operator`), or a pause carrying more than 1 yocto |
| `E_ASSET` | asset, symbol or market not in the policy |
| `E_SIZE` | notional over `max_notional_usd`, or zero |
| `E_DECIMAL` | non-canonical decimal string |
| `E_PRICE_BAND` | price outside `price_band_bps` of the oracle price |
| `E_ORACLE_STALE` | no oracle price younger than `oracle_max_age_s` |
| `E_QUOTE_SIGNATURE` | 1Click quote signature does not verify |
| `E_QUOTE_FIELDS` | quote recipient / refundTo / assets / deadline not acceptable |
| `E_RESCUE_CAP` | over `rescue_cap_usd_per_hour` |
| `E_SOL_MESSAGE` | not a legacy message, trailing bytes, wrong signer count or fee payer |
| `E_SOL_PROGRAM` | instruction for a program outside the allowlist |
| `E_SOL_ACCOUNT` | instruction touches an account the desk does not own |
| `E_MPC` | the MPC network did not return a signature |

### 1.6 Events (NEP-297)

`EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"<name>","data":[{…}]}`

| Event | Data |
|---|---|
| `desk_created` | desk_id, owner, evm_address, sol_authority |
| `policy_set` | desk_id, policy_sha256 (also emitted by `create_desk`, for the first policy) |
| `operator_set` | desk_id, operator |
| `orderly_receiver_set` | desk_id, receiver |
| `paused` | desk_id, paused, by |
| `prices` | [{ asset, price_e8, at_ms }] |
| `signed` | desk_id, request_id, venue, kind, asset?, side?, size?, px?, oracle_px?, amount?, deposit_address?, reason_sha256 |
| `deposit` | desk_id, sender, amount, principal (true when the sender is the owner), deposited_total, idle_usdc |
| `payout` | desk_id, to, amount, fee, profit, hwm |
| `fee_charged` | desk_id, kind (`performance`), amount, treasury |

`signed` is emitted in `on_signed`, only when the MPC returned a signature.

## 2. Engine ↔ web (`shared/src/types.ts`)

```ts
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
  tradable: boolean;              // both legs are VenueIds, so a desk could trade it; false = watch only
  veto?: { verdict: 'pass' | 'veto'; reasons: string[]; model: string; at: number };   // NEAR AI, can only refuse
  refused?: { code: string; reason: string };   // tradable, but the contract would refuse it under the current
                                                // policy (E_* code), e.g. no oracle price and not in policy.unpriced
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
  rescue_cap_usd_per_hour: number; unpriced: string[]; unpriced_max_notional_usd: number;
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
  paused: { by: string; at: number } | null;   // set_paused / panic_close: the NEAR account that paused, ms; null = running
  rescueFailure: RescueFailure | null;         // a rescue failed and the owner must act; cleared once margin is safe again
  updatedAt: number;
}

// The status line reads, first match wins: rescueFailure → Needs you, paused → Paused, health rescue →
// Rescuing, health watch → Watch, no legs → Waiting, else Level.
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
  journal: JournalEntry[];        // the most recent entries, newest first, at most 100
  rescue: RescueProgress | null;  // the running rescue, else the last one
  setup: SetupProgress | null;
  health: HealthMap | null;
  at: number;                     // ms, when the engine built the response
}
```

HTTP (engine, port 8790): `GET /events` (SSE, one `StreamEvent` per message), `GET /state` (`EngineState`),
`GET /windows/history?id=<window id>` (`WindowHistory`, for the Windows chart; kept out of the stream because
it is 168 points per window), `POST /stress` (testnet and replay only: tighten the margin threshold to force a rescue; 1Click has
no testnet, so on testnet the rescue's 1Click steps are replayed from recorded mainnet responses),
`POST /policy/draft` `{ text }` → `PolicyDraft` (NEAR AI; nothing is applied until the owner signs `set_policy`
and confirms the engine rules), `GET` / `PUT /strategy` (`StrategyConfig`), `POST /setup` `{ deskId }` (starts
venue setup; progress arrives as `setup` events), `POST /rotate` `{ windowId }` (manual override: close the held
window and open this one, with the same checks as auto; refused with the reason when a check fails) and
`POST /close` (close both legs with reduce-only orders). Both answer `{ ok: true }` or `{ ok: false, reason }`
at once; progress arrives as `journal` and `desk` events. Pause and Resume are not engine calls: the owner's
wallet signs `set_paused` (§1.3).

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
}

export interface MarketFunding extends FundingRate {   // the prices the rate applies to, from the same read,
  markPx: number | null;                               // so the scanner prices basis and size without a book
  oraclePx: number | null;                             // per market; null where the venue does not say
  openInterest: number | null;           // base units
  volume24hUsd: number | null;
}

export interface ContractClient {                      // NearContractClient | ReplayContractClient
  refreshPrices(assets: string[]): Promise<void>;
  hlOrder(deskId: string, order: HlOrder, reason: string): Promise<SignedAction>;
  solSign(deskId: string, messageB64: string, reason: string): Promise<SignedAction>;
  // … one method per contract action method
}
```

**Record / replay.** `engine/fixtures/replay/<name>.jsonl.gz`, one line per call:
`{"t": <ms>, "venue": "hyperliquid", "method": "funding", "args": [], "ms": <how long the venue took>, "result": …}`,
with `"error": "<message>"` in place of `result` when the call threw (replay throws it again). `t` is when the
answer arrived; replay serves it from that moment on. A `ReplayVenue` answers
from the file on a virtual clock; `npm run demo` plays a recorded day at ×N speed, with a scripted
margin squeeze, and its `ReplayContractClient` applies the same policy checks and refusal codes as the
contract (signatures marked as replay).
