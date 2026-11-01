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
use gimbal_core::errors::{Refusal, E_QUOTE_FIELDS, E_RESCUE_CAP};
use gimbal_core::hl::{usdc_token, Address, UserAction};
use gimbal_core::ids::{check_base58_32, check_reason};
use gimbal_core::oneclick::{
    check_cost, rescue_cost_budget_e8, transfer_cost_e8, verify_quote, Context, DeskAddresses,
    Method, VerifiedQuote, QUOTE_PAYABLE_MS,
};
use gimbal_core::phoenix::{check_message, Rescue};
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::desk::{Desk, Gate};
use crate::hl::keccak;
use crate::prices::reference_price;
use crate::sol::{decode_message, desk_accounts, sha256};
use crate::{action_desk, desk_ref, fail, take_hl_nonce, Gimbal, GimbalExt, OrFail};

/// How long a rescue weighs on the desk's meters: its weight falls linearly from its full amount
/// (or cost) to 0 over this hour, so the cap bounds any stretch of time, not a fixed window.
pub const RESCUE_WINDOW_MS: u64 = 3_600_000;

/// How many deposit addresses a desk remembers: a quote pays once, so a rescue to an address one
/// of the desk's last 32 rescues paid is refused. A slot is reused only once its address was paid
/// more than [`QUOTE_PAYABLE_MS`] ago, when no quote can pay it any more ([`DeskCounters::held`]):
/// a desk makes at most 32 rescues in any 65 min.
pub const DEPOSIT_RING: usize = 32;

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
    /// The counter of the desk's next EIP-3009 nonce, from 0.
    pub eip3009_next: u64,
    /// sha256 of the deposit addresses of the desk's last [`DEPOSIT_RING`] rescues, as the
    /// verified quote gives them (lowercase EVM, base58 Solana); all zero for an unused slot.
    pub deposits: [[u8; 32]; DEPOSIT_RING],
    /// The slot the next deposit address takes, the oldest one's.
    pub deposit_next: u8,
    /// Block time (ms) each slot's address was paid; 0 for an unused slot.
    pub deposit_paid_ms: [u64; DEPOSIT_RING],
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
        self.rescue_spent_e8 = self.spent_e8(now_ms).saturating_add(amount_e8);
        self.rescue_cost_e8 = self.cost_e8(now_ms).saturating_add(cost_e8);
        self.rescue_at_ms = now_ms;
        let slot = usize::from(self.deposit_next) % DEPOSIT_RING;
        self.deposits[slot] = deposit_sha256;
        self.deposit_paid_ms[slot] = now_ms;
        self.deposit_next = u8::try_from((slot + 1) % DEPOSIT_RING).unwrap_or(0);
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
    /// decimals) (`E_QUOTE_FIELDS`), within what is left of the hourly cap and of the hourly cost
    /// budget, which counts the quote's cost, not Hyperliquid's 1 USDC send fee
    /// ([`transfer_cost_e8`]), and not a 33rd rescue within 65 min ([`DEPOSIT_RING`])
    /// (`E_RESCUE_CAP`). Owner or operator, also on a paused desk. `kind`
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
    /// left of the hourly cap or a cost ([`transfer_cost_e8`]) over what is left of the hourly
    /// cost budget ([`rescue_cost_budget_e8`] of the policy's cap and transfer cost bounds), each
    /// a limit on how much the desk rescues in a stretch of time. Writes nothing:
    /// each build step stores the result once all its checks passed. Nothing is ever given back
    /// (module doc).
    pub fn counted_rescue(&self, desk_id: &str, q: &VerifiedQuote) -> DeskCounters {
        self.counted_transfer(desk_id, q, true)
    }

    /// [`Self::counted_rescue`] for `fund_venue` too: with `capped` false (USDC from the
    /// contract into the desk's own venues, a rescue out of the desk's reserve) the amount is
    /// neither checked against nor added to the hourly cap, while the deposit ring and the cost
    /// budget count it as for a rescue.
    pub fn counted_transfer(&self, desk_id: &str, q: &VerifiedQuote, capped: bool) -> DeskCounters {
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
        if capped && q.amount_in_e8 > cap_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "amountIn {} USDC is over what is left of the hourly rescue cap, {} USD",
                    format_e8(q.amount_in_e8),
                    format_e8(cap_left)
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
        let amount_e8 = if capped { q.amount_in_e8 } else { 0 };
        counters.spend(amount_e8, cost, deposit_sha256, now_ms);
        counters
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
        let desk: &Desk = desk_ref(&self.desks, &desk_id);
        let accounts = desk_accounts(desk).or_fail();
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
