//! The rescue methods (docs/interfaces.md §1.3, §1.4): money out of a venue to a verified 1Click
//! deposit address, also on a paused desk, within the desk's hourly `rescue_cap_usd_per_hour`.
//!
//! - `hl_send_to_intents`: Hyperliquid `sendAsset` of the desk's perp USDC to the deposit address
//!   (HyperCore USDC origin);
//! - `sol_sign_rescue`: a Solana message whose one transfer out pays the deposit owner's USDC
//!   account (Solana USDC origin);
//! - `evm_usdc_to_intents`: an EIP-3009 `TransferWithAuthorization` of the desk's Arbitrum USDC to
//!   the deposit address, which the relayer submits (Arbitrum USDC origin).
//!
//! The operator's `hl_withdraw` and `orderly_withdraw` (to the desk's own Arbitrum address, no
//! quote) count their amount against the same hourly cap and the venue's 1 USDC fee against the
//! hourly cost budget ([`Gimbal::counted_withdraw`]), but no deposit address. Each also needs at
//! least [`operator_min_withdraw_e8`], so a stolen operator key cannot burn the desk's USDC in
//! many small fees.
//!
//! Each verifies the 1Click quote in `gimbal-core` (signature, then the field rules, then the cap,
//! then the transfer cost the policy allows), builds the transfer from the verified quote alone
//! and counts it in the desk's [`DeskCounters`] in the same call: its amount against the hourly
//! cap, its cost against the hourly cost budget, its deposit address against reuse. Each public
//! method is its `prepare_*` followed by `Gimbal::sign`; the `build_*` step takes the verified
//! quote, so the unit tests can hand it one.
//!
//! A rescue stays counted whatever the MPC answers. A `sign` that returns no signature to
//! `on_signed` (failed, timed out) may still be answered later by the MPC network's `respond`,
//! which publishes the signature on chain where the relayer can read it: freeing the cap, the
//! cost or the deposit address then would let the same transfer be signed again.

use gimbal_core::decimal::format_e8;
use gimbal_core::eip3009::{nonce as eip3009_nonce, Authorization, VALIDITY_S};
use gimbal_core::errors::{Refusal, E_QUOTE_FIELDS, E_RESCUE_CAP, E_SIZE};
use gimbal_core::hl::{usdc_token, Address, UserAction};
use gimbal_core::ids::{check_base58_32, check_reason};
use gimbal_core::limits::{check_hourly_notional, notional_e8};
use gimbal_core::oneclick::{
    check_cost, quote_cost_e8, rescue_cost_budget_e8, rescue_quote_budget_e8, transfer_cost_e8,
    verify_quote, Context, DeskAddresses, Method, VerifiedQuote, QUOTE_PAYABLE_MS, VENUE_FEE_E8,
};
use gimbal_core::phoenix::{check_message, Rescue};
use gimbal_core::policy::Policy;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::desk::{Desk, Gate};
use crate::hl::keccak;
use crate::prices::reference_price;
use crate::sol::{decode_message, sha256};
use crate::{action_desk, desk_ref, fail, take_hl_nonce, Gimbal, GimbalExt, OrFail};

/// How long a rescue weighs on the desk's meters: its weight falls linearly from its full amount
/// (or cost) to 0 over this hour, so the cap bounds any stretch of time, not a fixed window.
pub const RESCUE_WINDOW_MS: u64 = 3_600_000;

/// How many deposit addresses a desk remembers: a quote pays once, so a rescue to an address one
/// of the desk's last 32 rescues paid is refused. A slot is reused only once its address was paid
/// more than [`QUOTE_PAYABLE_MS`] ago, when no quote can pay it any more ([`DeskCounters::held`]):
/// a desk makes at most 32 rescues in any 65 min.
pub const DEPOSIT_RING: usize = 32;

/// How many times the policy's `max_transfer_cost_flat_e6` an operator withdrawal must move at
/// least ([`operator_min_withdraw_e8`]).
pub const OPERATOR_MIN_WITHDRAW_FLATS: u128 = 10;

/// The least an operator withdrawal moves whatever the policy, USDC × 1e8: 10 USDC, ten venue
/// fees, so a policy with `max_transfer_cost_flat_e6` 0 cannot turn the minimum off.
pub const OPERATOR_MIN_WITHDRAW_FLOOR_E8: u128 = 10 * VENUE_FEE_E8;

/// The least USDC × 1e8 the operator may withdraw from Hyperliquid or Orderly in one call:
/// max(10 × the policy's `max_transfer_cost_flat_e6`, [`OPERATOR_MIN_WITHDRAW_FLOOR_E8`]), 10 USDC
/// at the default 0.5. The venue's 1 USDC fee of each also counts against the hourly rescue cost
/// budget, which bounds how many fees a stolen operator key can burn in an hour. The owner has no
/// minimum.
pub fn operator_min_withdraw_e8(policy: &Policy) -> u128 {
    (u128::from(policy.max_transfer_cost_flat_e6) * 100 * OPERATOR_MIN_WITHDRAW_FLATS)
        .max(OPERATOR_MIN_WITHDRAW_FLOOR_E8)
}

/// What the contract counts per desk besides its Hyperliquid nonce. Fixed size (1.3 KB), stored
/// by `create_desk`, so an action rewrites it without adding storage.
///
/// The two meters hold the weight of the desk's rescues at `rescue_at_ms`; at a later time each
/// weighs `weight × (1 − elapsed / 1 h)`, 0 after an hour ([`decayed`]). What a desk may still
/// rescue is the cap minus the amount meter's weight now: 2 × the cap can never move within a
/// moment, as with a fixed window, and the full cap is back an hour after the last rescue.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeskCounters {
    /// Block time (ms) the meters were last brought to.
    pub rescue_at_ms: u64,
    /// USDC × 1e8: the weight of the rescues' amounts, against `rescue_cap_usd_per_hour`.
    pub rescue_spent_e8: u128,
    /// USD × 1e8: the weight of what they may cost ([`transfer_cost_e8`]), against
    /// [`rescue_cost_budget_e8`].
    pub rescue_cost_e8: u128,
    /// USD × 1e8: the part of `rescue_cost_e8` that is the quotes' own costs ([`quote_cost_e8`],
    /// no venue fee), against [`rescue_quote_budget_e8`]. Always 0 in the `fund_venue` counters.
    pub rescue_quote_e8: u128,
    /// The counter of the desk's next EIP-3009 nonce, from 0.
    pub eip3009_next: u64,
    /// sha256 of the deposit addresses of the desk's last [`DEPOSIT_RING`] rescues, as the
    /// verified quote gives them (lowercase EVM, base58 Solana); all zero for an unused slot.
    pub deposits: [[u8; 32]; DEPOSIT_RING],
    /// The slot the next deposit address takes, the oldest one's.
    pub deposit_next: u8,
    /// Block time (ms) each slot's address was paid; 0 for an unused slot.
    pub deposit_paid_ms: [u64; DEPOSIT_RING],
    /// Block time (ms) the notional meter was last brought to.
    pub notional_at_ms: u64,
    /// USD × 1e8: the weight of the notional of the orders the desk signed that are not
    /// reduce-only, on all three venues, against `max_hourly_notional_usd`; decays like the
    /// rescue meters ([`decayed`]).
    pub notional_e8: u128,
}

/// `weight`, a meter's value at `since_ms`, at `now_ms`: falling linearly to 0 over
/// [`RESCUE_WINDOW_MS`], rounded up so a meter never frees more than the time allows.
pub fn decayed(weight: u128, since_ms: u64, now_ms: u64) -> u128 {
    let window = u128::from(RESCUE_WINDOW_MS);
    let elapsed = u128::from(now_ms.saturating_sub(since_ms).min(RESCUE_WINDOW_MS));
    let left = window - elapsed;
    // weight × left / window, without the product overflowing.
    (weight / window) * left + ((weight % window) * left).div_ceil(window)
}

impl DeskCounters {
    /// The amount meter's weight at `now_ms`, USDC × 1e8.
    pub fn spent_e8(&self, now_ms: u64) -> u128 {
        decayed(self.rescue_spent_e8, self.rescue_at_ms, now_ms)
    }

    /// The cost meter's weight at `now_ms`, USD × 1e8.
    pub fn cost_e8(&self, now_ms: u64) -> u128 {
        decayed(self.rescue_cost_e8, self.rescue_at_ms, now_ms)
    }

    /// The quote part of the cost meter at `now_ms`, USD × 1e8.
    pub fn quote_cost_used_e8(&self, now_ms: u64) -> u128 {
        decayed(self.rescue_quote_e8, self.rescue_at_ms, now_ms)
    }

    /// USDC × 1e8 the desk can still rescue at `now_ms` under a cap of `cap_usd` an hour.
    pub fn remaining_cap_e8(&self, cap_usd: u64, now_ms: u64) -> u128 {
        (u128::from(cap_usd) * 100_000_000).saturating_sub(self.spent_e8(now_ms))
    }

    /// USD × 1e8 the desk's rescues may still cost at `now_ms` under a budget of `budget_e8`.
    pub fn remaining_cost_e8(&self, budget_e8: u128, now_ms: u64) -> u128 {
        budget_e8.saturating_sub(self.cost_e8(now_ms))
    }

    /// Whether one of the last [`DEPOSIT_RING`] rescues paid the deposit address hashing to
    /// `deposit_sha256`.
    pub fn paid(&self, deposit_sha256: &[u8; 32]) -> bool {
        self.deposits.contains(deposit_sha256)
    }

    /// When the address in the slot the next rescue takes was paid, while that is
    /// [`QUOTE_PAYABLE_MS`] or less before `now_ms`: a quote may still pay that address then
    /// (paid at its earliest, 5 min before its `timestamp`, it stays payable until 60 min after),
    /// so forgetting it would let the quote pay it twice. `None` for an unused slot or one paid
    /// longer ago, which the next rescue may take.
    pub fn held(&self, now_ms: u64) -> Option<u64> {
        let slot = usize::from(self.deposit_next) % DEPOSIT_RING;
        let paid_ms = self.deposit_paid_ms[slot];
        let used = self.deposits[slot] != [0; 32];
        (used && now_ms.saturating_sub(paid_ms) <= QUOTE_PAYABLE_MS).then_some(paid_ms)
    }

    /// Counts a rescue of `amount_e8` that may cost `cost_e8`, to the deposit address hashing to
    /// `deposit_sha256`, at `now_ms`. The caller checked [`Self::held`] first.
    pub fn spend(&mut self, amount_e8: u128, cost_e8: u128, deposit_sha256: [u8; 32], now_ms: u64) {
        self.spend_amount(amount_e8, cost_e8, now_ms);
        let slot = usize::from(self.deposit_next) % DEPOSIT_RING;
        self.deposits[slot] = deposit_sha256;
        self.deposit_paid_ms[slot] = now_ms;
        self.deposit_next = u8::try_from((slot + 1) % DEPOSIT_RING).unwrap_or(0);
    }

    /// [`Self::spend`] of a rescue whose cost `cost_e8` holds `quote_e8` of the quote's own,
    /// which the quote meter counts too.
    pub fn spend_rescue(
        &mut self,
        amount_e8: u128,
        cost_e8: u128,
        quote_e8: u128,
        deposit_sha256: [u8; 32],
        now_ms: u64,
    ) {
        self.spend(amount_e8, cost_e8, deposit_sha256, now_ms);
        // spend brought the quote meter to now_ms with the others.
        self.rescue_quote_e8 = self.rescue_quote_e8.saturating_add(quote_e8);
    }

    /// Counts `amount_e8` against the amount meter and `cost_e8` against the cost meter at
    /// `now_ms`: the operator's withdrawals, which pay no quote, so no deposit address. Every
    /// rescue meter is brought to `now_ms`, since they share `rescue_at_ms`.
    pub fn spend_amount(&mut self, amount_e8: u128, cost_e8: u128, now_ms: u64) {
        self.rescue_spent_e8 = self.spent_e8(now_ms).saturating_add(amount_e8);
        self.rescue_cost_e8 = self.cost_e8(now_ms).saturating_add(cost_e8);
        self.rescue_quote_e8 = self.quote_cost_used_e8(now_ms);
        self.rescue_at_ms = now_ms;
    }

    /// The notional meter's weight at `now_ms`, USD × 1e8.
    pub fn notional_used_e8(&self, now_ms: u64) -> u128 {
        decayed(self.notional_e8, self.notional_at_ms, now_ms)
    }

    /// Counts the orders' `notional_e8` at `now_ms`, or `E_SIZE` when it is over what is left of
    /// `cap_usd` in the sliding hour ([`check_hourly_notional`]). The caller counts only orders
    /// that are not reduce-only, and stores the counters only once every check passed.
    pub fn spend_notional(
        &mut self,
        notional_e8: u128,
        cap_usd: u64,
        now_ms: u64,
        what: &str,
    ) -> Result<(), Refusal> {
        let used = self.notional_used_e8(now_ms);
        let left = (u128::from(cap_usd) * 100_000_000).saturating_sub(used);
        check_hourly_notional(notional_e8, left, cap_usd, what)?;
        self.notional_e8 = used.saturating_add(notional_e8);
        self.notional_at_ms = now_ms;
        Ok(())
    }
}

/// `get_desk_counters`: a desk's [`DeskCounters`] as JSON, amounts USD × 1e8 as decimal strings,
/// with each meter's weight and what is left of its bound at `now_ms`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct DeskCountersView {
    /// The next EIP-3009 counter `evm_usdc_to_intents` takes: an authorization with counter `n`
    /// was signed (or its `sign` call sent) once this is above `n`.
    pub eip3009_next: u64,
    pub rescue_at_ms: u64,
    pub rescue_spent_e8: U128,
    pub rescue_cost_e8: U128,
    /// The amount meter's weight now, and what is left of `rescue_cap_usd_per_hour`.
    pub rescue_spent_now_e8: U128,
    pub rescue_cap_left_e8: U128,
    /// The cost meter's weight now, and what is left of the hourly rescue cost budget.
    pub rescue_cost_now_e8: U128,
    pub rescue_cost_left_e8: U128,
    pub rescue_cost_budget_e8: U128,
    /// The quote part of the cost meter: its weight at `rescue_at_ms`, what is left of the
    /// quotes' share of the budget now, and that share (the budget without the venue-fee room).
    pub rescue_quote_cost_e8: U128,
    pub rescue_quote_cost_left_e8: U128,
    pub rescue_quote_budget_e8: U128,
    /// The deposit ring: sha256 hex of each slot's address (`null` for an unused slot), when it
    /// was paid, and the slot the next rescue takes.
    pub deposits: Vec<Option<String>>,
    pub deposit_paid_ms: Vec<u64>,
    pub deposit_next: u8,
    pub notional_at_ms: u64,
    pub notional_e8: U128,
    /// The hourly notional cap in force, whole USD: `max_hourly_notional_usd`, or 15 ×
    /// `max_notional_usd` while it is `null`.
    pub notional_cap_usd: u64,
    /// The notional meter's weight now, and what is left of the cap.
    pub notional_now_e8: U128,
    pub notional_left_e8: U128,
}

impl DeskCountersView {
    pub fn of(c: &DeskCounters, policy: &Policy, now_ms: u64) -> Self {
        let budget = rescue_cost_budget_e8(
            policy.rescue_cap_usd_per_hour,
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let quote_budget = rescue_quote_budget_e8(
            policy.rescue_cap_usd_per_hour,
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let notional_now = c.notional_used_e8(now_ms);
        Self {
            eip3009_next: c.eip3009_next,
            rescue_at_ms: c.rescue_at_ms,
            rescue_spent_e8: U128(c.rescue_spent_e8),
            rescue_cost_e8: U128(c.rescue_cost_e8),
            rescue_spent_now_e8: U128(c.spent_e8(now_ms)),
            rescue_cap_left_e8: U128(c.remaining_cap_e8(policy.rescue_cap_usd_per_hour, now_ms)),
            rescue_cost_now_e8: U128(c.cost_e8(now_ms)),
            rescue_cost_left_e8: U128(c.remaining_cost_e8(budget, now_ms)),
            rescue_cost_budget_e8: U128(budget),
            rescue_quote_cost_e8: U128(c.rescue_quote_e8),
            rescue_quote_cost_left_e8: U128(
                quote_budget.saturating_sub(c.quote_cost_used_e8(now_ms)),
            ),
            rescue_quote_budget_e8: U128(quote_budget),
            deposits: c
                .deposits
                .iter()
                .map(|d| (*d != [0; 32]).then(|| hex::encode(d)))
                .collect(),
            deposit_paid_ms: c.deposit_paid_ms.to_vec(),
            deposit_next: c.deposit_next,
            notional_at_ms: c.notional_at_ms,
            notional_e8: U128(c.notional_e8),
            notional_cap_usd: policy.hourly_notional_cap_usd(),
            notional_now_e8: U128(notional_now),
            notional_left_e8: U128(
                (u128::from(policy.hourly_notional_cap_usd()) * 100_000_000)
                    .saturating_sub(notional_now),
            ),
        }
    }
}

/// The host's Ed25519 check, as the core takes it.
pub fn ed25519_verify(signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
    env::ed25519_verify(signature, message, public_key)
}

pub(crate) fn quote_fields(msg: impl AsRef<str>) -> Refusal {
    Refusal::new(E_QUOTE_FIELDS, msg.as_ref())
}

/// The verified deposit address, which a live quote always has.
pub(crate) fn deposit_of(q: &VerifiedQuote) -> String {
    q.deposit_address
        .clone()
        .ok_or_else(|| quote_fields("the quote has no depositAddress"))
        .or_fail()
}

#[near]
impl Gimbal {
    /// Rescue out of Hyperliquid: `sendAsset` of the quote's `amountIn` of the desk's perp USDC
    /// (`sourceDex` `""`) to the quote's deposit address on the spot side (`destinationDex`
    /// `"spot"`), the network's USDC token, the desk's next nonce. The quote: a live 1Click quote
    /// of HyperCore USDC, signed by 1Click (`E_QUOTE_SIGNATURE`), into another asset, paying a
    /// desk address, the pinned Orderly receiver or the contract for the desk, refunds to the
    /// desk's EVM address, signed at most 1 h before the block time (5 min after it), before its
    /// deadline, a deposit address none of the desk's last 32 rescues paid, within the
    /// policy's transfer cost, with an `amountIn` Hyperliquid's perp balance can send (at most 6
    /// decimals) (`E_QUOTE_FIELDS`), within what is left of the hourly cap, of the quotes' share
    /// of the hourly cost budget (the quote's own cost) and of the whole budget, which counts the
    /// quote's cost and Hyperliquid's 1 USDC send fee ([`transfer_cost_e8`]), and not a 33rd
    /// rescue within 65 min ([`DEPOSIT_RING`]) (`E_RESCUE_CAP`). Owner or operator, also on a
    /// paused desk. `kind`
    /// `sendAsset`; a user-signed action, so no
    /// `expiresAfter`: the nonce window bounds a late signature.
    #[deny_unknown_arguments]
    pub fn hl_send_to_intents(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> Promise {
        let action = self.prepare_hl_send_to_intents(desk_id, quote, quote_signature, reason);
        self.sign(action)
    }

    /// Rescue out of Solana: signs a message as `sol_sign` checks one, in rescue mode: besides
    /// what `sol_sign` allows, an idempotent create of the deposit owner's USDC account and, after
    /// it, exactly one `TransferChecked` of exactly the quote's `amountIn` USDC into that account
    /// (`E_QUOTE_FIELDS`). The quote as for [`Self::hl_send_to_intents`], of Solana USDC, refunds
    /// to the desk's Solana authority. Owner or operator; on a paused desk too, under its own
    /// rule (`E_PAUSED` otherwise): only what frees and pays out the quote's `amountIn` passes a
    /// pause, Phoenix withdrawals and Ember unwraps of at most `amountIn` in all (with the
    /// unwrap's `Approve` and `Revoke`), the deposit owner's account create and the transfer; no
    /// priority fee, order, cancel, deposit, wrap or create of a desk account. `kind` `rescue`.
    #[deny_unknown_arguments]
    pub fn sol_sign_rescue(
        &mut self,
        desk_id: String,
        message_b64: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> Promise {
        let action =
            self.prepare_sol_sign_rescue(desk_id, message_b64, quote, quote_signature, reason);
        self.sign(action)
    }

    /// The desk's Arbitrum USDC to 1Click: an EIP-712 `TransferWithAuthorization` (EIP-3009) of
    /// the quote's `amountIn` from the desk's EVM address to the quote's deposit address, on
    /// Circle's USDC of the network's Arbitrum chain, `validAfter` 0, `validBefore` the block time
    /// + 300 s, nonce keccak256(desk_id ‖ the desk's counter as u64 big-endian), the counter
    /// advanced by this call. The quote as for [`Self::hl_send_to_intents`], of Arbitrum USDC,
    /// refunds to the desk's EVM address. Owner or operator, also on a paused desk (the last step
    /// of Orderly money out, and a rescue). `venue` `arbitrum`, `kind`
    /// `transfer_with_authorization`.
    #[deny_unknown_arguments]
    pub fn evm_usdc_to_intents(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> Promise {
        let action = self.prepare_evm_usdc_to_intents(desk_id, quote, quote_signature, reason);
        self.sign(action)
    }
}

impl Gimbal {
    /// The quote checked for `method` on the desk at the block time: [`verify_quote`] (with what
    /// is left of the desk's cap; it also bounds the quote's age, so a quote is payable for
    /// [`QUOTE_PAYABLE_MS`] at most), then [`check_cost`] at the policy's bounds. The build step
    /// counts it ([`Self::counted_rescue`]), whose deposit ring keeps every address it paid for at
    /// least that long.
    pub fn verified_quote(
        &self,
        desk_id: &str,
        quote: &str,
        quote_signature: &str,
        method: Method,
    ) -> VerifiedQuote {
        let desk = desk_ref(&self.desks, desk_id);
        let now_ms = env::block_timestamp_ms();
        let counters = self.desk_counters.get(desk_id).copied().unwrap_or_default();
        let contract = env::current_account_id();
        let second_key = self.accepted_oneclick_key(desk_id, now_ms);
        let pinned_key = self.pinned_oneclick_key_trusted(desk_id);
        let ctx = Context {
            desk: DeskAddresses {
                desk_id,
                evm: &desk.evm_address,
                sol: &desk.solana.authority,
                orderly_receiver: desk.orderly_receiver.as_deref(),
                owner: desk.owner.as_str(),
            },
            contract: contract.as_str(),
            now_ms,
            remaining_cap_e8: counters
                .remaining_cap_e8(desk.policy.rescue_cap_usd_per_hour, now_ms),
            dry_ok: false,
            second_key,
            pinned_key,
        };
        let q =
            verify_quote(sha256, ed25519_verify, quote, quote_signature, method, &ctx).or_fail();
        check_cost(
            &q,
            desk.policy.max_transfer_cost_bps,
            desk.policy.max_transfer_cost_flat_e6,
        )
        .or_fail();
        q
    }

    /// The desk's counters with the verified rescue `q` counted at the block time, or the
    /// refusal: `E_QUOTE_FIELDS` for a deposit address one of the desk's last [`DEPOSIT_RING`]
    /// rescues paid (a quote pays once), `E_RESCUE_CAP` for a 33rd rescue within 65 min (it would
    /// forget an address a quote can still pay, [`DeskCounters::held`]), an amount over what is
    /// left of the hourly cap, the quote's own cost ([`quote_cost_e8`]) over what is left of the
    /// quotes' share of the hourly cost budget ([`rescue_quote_budget_e8`]: the venue-fee room is
    /// not theirs, so `appFees` within the 1Click fee bound cannot spend it), or the whole cost
    /// ([`transfer_cost_e8`]) over what is left of the hourly cost budget
    /// ([`rescue_cost_budget_e8`] of the policy's cap and transfer cost bounds), each a limit on
    /// how much the desk rescues in a stretch of time. Writes nothing:
    /// each build step stores the result once all its checks passed. Nothing is ever given back
    /// (module doc).
    pub fn counted_rescue(&self, desk_id: &str, q: &VerifiedQuote) -> DeskCounters {
        let policy = &desk_ref(&self.desks, desk_id).policy;
        let now_ms = env::block_timestamp_ms();
        let mut counters = self.desk_counters.get(desk_id).copied().unwrap_or_default();
        let deposit = deposit_of(q);
        let deposit_sha256 = env::sha256_array(deposit.as_bytes());
        if counters.paid(&deposit_sha256) {
            fail_fields(format!(
                "deposit address {deposit} was paid by one of this desk's last {DEPOSIT_RING} \
                 rescues; a quote pays once"
            ));
        }
        if let Some(paid_ms) = counters.held(now_ms) {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "this desk's last {DEPOSIT_RING} rescues were paid within 65 min, the oldest \
                     at {paid_ms} ms: a quote can pay its deposit address again until {} ms, so \
                     the next rescue waits until after then",
                    paid_ms.saturating_add(QUOTE_PAYABLE_MS)
                ),
            ));
        }
        let cap_left = counters.remaining_cap_e8(policy.rescue_cap_usd_per_hour, now_ms);
        if q.amount_in_e8 > cap_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "amountIn {} USDC is over what is left of the hourly rescue cap, {} USD",
                    format_e8(q.amount_in_e8),
                    format_e8(cap_left)
                ),
            ));
        }
        let quote_cost = quote_cost_e8(q);
        let quote_budget = rescue_quote_budget_e8(
            policy.rescue_cap_usd_per_hour,
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let quote_left = quote_budget.saturating_sub(counters.quote_cost_used_e8(now_ms));
        if quote_cost > quote_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "the quote may cost {} USD (amountIn − minAmountOut), over what is left of the \
                     quotes' share of the hourly rescue cost budget, {} of {} USD (the rest is \
                     for venue fees)",
                    format_e8(quote_cost),
                    format_e8(quote_left),
                    format_e8(quote_budget)
                ),
            ));
        }
        let cost = transfer_cost_e8(q);
        let budget = rescue_cost_budget_e8(
            policy.rescue_cap_usd_per_hour,
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let cost_left = counters.remaining_cost_e8(budget, now_ms);
        if cost > cost_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "the rescue may cost {} USD, over what is left of the hourly rescue cost \
                     budget, {} of {} USD",
                    format_e8(cost),
                    format_e8(cost_left),
                    format_e8(budget)
                ),
            ));
        }
        counters.spend_rescue(q.amount_in_e8, cost, quote_cost, deposit_sha256, now_ms);
        counters
    }

    /// The desk's counters with the operator's `method` (`hl_withdraw` or `orderly_withdraw`) of
    /// `amount_e8` counted at the block time, or the refusal: `E_SIZE` below
    /// [`operator_min_withdraw_e8`], `E_RESCUE_CAP` for an amount over what is left of the hourly
    /// cap or the venue's 1 USDC fee ([`VENUE_FEE_E8`]) over what is left of the hourly cost
    /// budget. There is no quote, so no deposit address, and the destination is the desk's own EVM
    /// address. Writes nothing, like [`Self::counted_rescue`].
    pub fn counted_withdraw(&self, desk_id: &str, method: &str, amount_e8: u128) -> DeskCounters {
        let policy = &desk_ref(&self.desks, desk_id).policy;
        let now_ms = env::block_timestamp_ms();
        let mut counters = self.desk_counters.get(desk_id).copied().unwrap_or_default();
        let min = operator_min_withdraw_e8(policy);
        if amount_e8 < min {
            fail(Refusal::new(
                E_SIZE,
                format!(
                    "the operator's {method} of {} USDC is under its minimum of {} USDC (10 × \
                     max_transfer_cost_flat_e6, at least 10 USDC); the owner has none",
                    format_e8(amount_e8),
                    format_e8(min)
                ),
            ));
        }
        let cap_left = counters.remaining_cap_e8(policy.rescue_cap_usd_per_hour, now_ms);
        if amount_e8 > cap_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "{method} of {} USDC is over what is left of the hourly rescue cap, {} USD",
                    format_e8(amount_e8),
                    format_e8(cap_left)
                ),
            ));
        }
        let budget = rescue_cost_budget_e8(
            policy.rescue_cap_usd_per_hour,
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let cost_left = counters.remaining_cost_e8(budget, now_ms);
        if VENUE_FEE_E8 > cost_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "{method} pays the venue's 1 USDC fee, over what is left of the hourly rescue \
                     cost budget, {} of {} USD",
                    format_e8(cost_left),
                    format_e8(budget)
                ),
            ));
        }
        counters.spend_amount(amount_e8, VENUE_FEE_E8, now_ms);
        counters
    }

    /// `counters` with the orders' notional counted against the desk's `max_hourly_notional_usd`
    /// at the block time (`E_SIZE` over what is left), for the orders of one signed action that
    /// are not reduce-only, each valued as the size cap values it ([`notional_e8`]).
    pub fn count_notional(
        &self,
        desk_id: &str,
        mut counters: DeskCounters,
        orders: impl IntoIterator<Item = u128>,
    ) -> DeskCounters {
        let notional: u128 = orders.into_iter().fold(0, u128::saturating_add);
        if notional == 0 {
            return counters;
        }
        let policy = &desk_ref(&self.desks, desk_id).policy;
        counters
            .spend_notional(
                notional,
                policy.hourly_notional_cap_usd(),
                env::block_timestamp_ms(),
                "the order",
            )
            .or_fail();
        counters
    }

    /// The desk's stored counters, or the default before `create_desk` stored them.
    pub fn counters_of(&self, desk_id: &str) -> DeskCounters {
        self.desk_counters.get(desk_id).copied().unwrap_or_default()
    }

    /// [`Self::hl_send_to_intents`] up to the signature.
    pub fn prepare_hl_send_to_intents(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let q = self.verified_quote(&desk_id, &quote, &quote_signature, Method::HlSendToIntents);
        self.build_hl_send_to_intents(desk_id, &q, &reason)
    }

    /// The `sendAsset` of a verified HyperCore quote.
    pub fn build_hl_send_to_intents(
        &mut self,
        desk_id: String,
        q: &VerifiedQuote,
        reason: &str,
    ) -> UnsignedAction {
        let deposit = deposit_of(q);
        let destination = Address::parse("depositAddress", &deposit).or_fail();
        if !q.amount_in_e8.is_multiple_of(100) {
            fail_fields(format!(
                "amountIn {} USDC has more than the 6 decimals Hyperliquid's perp balance sends",
                format_e8(q.amount_in_e8)
            ));
        }
        let counters = self.counted_rescue(&desk_id, q);
        let amount = format_e8(q.amount_in_e8);
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let action = UserAction::SendAsset {
            destination,
            source_dex: String::new(),
            destination_dex: "spot".to_owned(),
            token: usdc_token(self.config.network).to_owned(),
            amount: amount.clone(),
            nonce,
        };
        let prepared = action.prepare(keccak, self.config.network);
        self.desk_counters.insert(desk_id.clone(), counters);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(reason))
            .with_amount(Some(amount))
            .with_deposit_address(deposit)
    }

    /// [`Self::sol_sign_rescue`] up to the signature.
    pub fn prepare_sol_sign_rescue(
        &mut self,
        desk_id: String,
        message_b64: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let q = self.verified_quote(&desk_id, &quote, &quote_signature, Method::SolSignRescue);
        self.build_sol_sign_rescue(desk_id, message_b64, &q, &reason)
    }

    /// The rescue message of a verified Solana quote.
    pub fn build_sol_sign_rescue(
        &mut self,
        desk_id: String,
        message_b64: String,
        q: &VerifiedQuote,
        reason: &str,
    ) -> UnsignedAction {
        let deposit = deposit_of(q);
        let owner = check_base58_32("depositAddress", &deposit).or_fail();
        let amount_in = u64::try_from(q.amount_in)
            .map_err(|_| quote_fields("amountIn is over 2^64 - 1"))
            .or_fail();
        let rescue = Rescue::new(sha256, owner, amount_in).or_fail();
        let counters = self.counted_rescue(&desk_id, q);
        let message = decode_message(&message_b64).or_fail();
        let accounts = self.sol_desk(&desk_id);
        let desk: &Desk = desk_ref(&self.desks, &desk_id);
        let max_age_s = desk.policy.oracle_max_age_s;
        let block_ms = env::block_timestamp_ms();
        let prices = &self.prices;
        let reference = |symbol: &str| reference_price(prices, symbol, max_age_s, block_ms);
        let checked = check_message(
            sha256,
            &desk.policy,
            &accounts,
            &message,
            &reference,
            Some(&rescue),
        )
        .or_fail();
        // The rescue's own pause rule, which the core reads in rescue mode.
        if !checked.reduces_risk {
            desk.check_action(&desk_id, &env::predecessor_account_id(), Gate::Running)
                .or_fail();
        }
        let orders = checked
            .orders
            .iter()
            .map(|o| OrderDetail::new(&o.symbol, o.bid, o.size_e8, o.price_e8, o.valued))
            .collect();
        let counters = self.count_notional(
            &desk_id,
            counters,
            checked
                .orders
                .iter()
                .filter(|o| !o.reduce_only)
                .map(|o| notional_e8(o.price_e8, o.size_e8, &o.valued)),
        );
        self.desk_counters.insert(desk_id.clone(), counters);
        UnsignedAction::solana(desk_id, checked.kind, message_b64, &message, Some(reason))
            .with_orders(orders)
            .with_amount(Some(format_e8(q.amount_in_e8)))
            .with_deposit_address(deposit)
    }

    /// [`Self::evm_usdc_to_intents`] up to the signature.
    pub fn prepare_evm_usdc_to_intents(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let q = self.verified_quote(&desk_id, &quote, &quote_signature, Method::EvmUsdcToIntents);
        self.build_evm_usdc_to_intents(desk_id, &q, &reason)
    }

    /// The EIP-3009 authorization of a verified Arbitrum quote; takes the desk's counter.
    pub fn build_evm_usdc_to_intents(
        &mut self,
        desk_id: String,
        q: &VerifiedQuote,
        reason: &str,
    ) -> UnsignedAction {
        let deposit = deposit_of(q);
        let to = Address::parse("depositAddress", &deposit).or_fail();
        let from =
            Address::parse("evm_address", &desk_ref(&self.desks, &desk_id).evm_address).or_fail();
        let value = u64::try_from(q.amount_in)
            .map_err(|_| quote_fields("amountIn is over 2^64 - 1"))
            .or_fail();
        let mut counters = self.counted_rescue(&desk_id, q);
        let counter = counters.eip3009_next;
        counters.eip3009_next = counter
            .checked_add(1)
            .ok_or_else(|| quote_fields("the desk's EIP-3009 counter is exhausted"))
            .or_fail();
        let block_s = env::block_timestamp_ms() / 1000;
        let auth = Authorization {
            from: from.0,
            to: to.0,
            value,
            valid_after: 0,
            valid_before: block_s + VALIDITY_S,
            nonce: eip3009_nonce(keccak, &desk_id, counter),
        };
        let network = self.config.network;
        let digest = auth.digest(keccak, network);
        self.desk_counters.insert(desk_id.clone(), counters);
        UnsignedAction::arbitrum(
            desk_id,
            "transfer_with_authorization",
            auth.payload(network),
            &digest,
            reason,
        )
        .with_amount(Some(format_e8(q.amount_in_e8)))
        .with_deposit_address(deposit)
    }
}

fn fail_fields(msg: String) -> ! {
    fail(quote_fields(msg))
}
