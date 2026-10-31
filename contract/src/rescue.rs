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
//! and spends the cap in the same call, before the MPC answers: a signature that fails or comes
//! late never frees its share. Each public method is its `prepare_*` followed by `Gimbal::sign`;
//! the `build_*` step takes the verified quote, so the unit tests can hand it one.

use gimbal_core::decimal::format_e8;
use gimbal_core::eip3009::{nonce as eip3009_nonce, Authorization, VALIDITY_S};
use gimbal_core::errors::{Refusal, E_QUOTE_FIELDS};
use gimbal_core::hl::{usdc_token, Address, UserAction};
use gimbal_core::ids::{check_base58_32, check_reason};
use gimbal_core::oneclick::{
    check_cost, verify_quote, Context, DeskAddresses, Method, VerifiedQuote,
};
use gimbal_core::phoenix::{check_message, Rescue};
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::desk::{Desk, Gate};
use crate::hl::keccak;
use crate::prices::reference_price;
use crate::sol::{decode_message, desk_accounts, sha256};
use crate::{action_desk, desk_ref, take_hl_nonce, Gimbal, GimbalExt, OrFail};

/// The rescue cap's window: an hour from the first rescue after the last window closed.
pub const RESCUE_WINDOW_MS: u64 = 3_600_000;

/// What the contract counts per desk besides its Hyperliquid nonce. Fixed size, stored by
/// `create_desk`, so an action rewrites it without adding storage.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeskCounters {
    /// Block time (ms) of the first rescue of the current window.
    pub rescue_window_start_ms: u64,
    /// USDC × 1e8 the rescues of that window moved.
    pub rescue_spent_e8: u128,
    /// The counter of the desk's next EIP-3009 nonce, from 0.
    pub eip3009_next: u64,
}

impl DeskCounters {
    /// Whether the window that started at `rescue_window_start_ms` still runs at `now_ms`.
    pub const fn in_window(&self, now_ms: u64) -> bool {
        self.rescue_spent_e8 > 0
            && now_ms < self.rescue_window_start_ms.saturating_add(RESCUE_WINDOW_MS)
    }

    /// USDC × 1e8 the desk can still rescue at `now_ms` under a cap of `cap_usd` per hour.
    pub fn remaining_cap_e8(&self, cap_usd: u64, now_ms: u64) -> u128 {
        let cap = u128::from(cap_usd) * 100_000_000;
        if self.in_window(now_ms) {
            cap.saturating_sub(self.rescue_spent_e8)
        } else {
            cap
        }
    }

    /// Counts a rescue of `amount_e8` at `now_ms`, opening a new window if none runs.
    pub fn spend(&mut self, amount_e8: u128, now_ms: u64) {
        if self.in_window(now_ms) {
            self.rescue_spent_e8 = self.rescue_spent_e8.saturating_add(amount_e8);
        } else {
            self.rescue_window_start_ms = now_ms;
            self.rescue_spent_e8 = amount_e8;
        }
    }
}

/// The host's Ed25519 check, as the core takes it.
pub fn ed25519_verify(signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
    env::ed25519_verify(signature, message, public_key)
}

fn quote_fields(msg: impl AsRef<str>) -> Refusal {
    Refusal::new(E_QUOTE_FIELDS, msg.as_ref())
}

/// The verified deposit address, which a live quote always has.
fn deposit_of(q: &VerifiedQuote) -> String {
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
    /// of HyperCore USDC, signed by 1Click (`E_QUOTE_SIGNATURE`), paying a desk address, the
    /// pinned Orderly receiver or the contract for the desk, refunds to the desk's EVM address,
    /// within what is left of the hourly cap (`E_RESCUE_CAP`) and the policy's transfer cost, with
    /// an `amountIn` Hyperliquid's perp balance can send (at most 6 decimals) (`E_QUOTE_FIELDS`).
    /// Owner or operator, also on a paused desk. `kind` `sendAsset`; a user-signed action, so no
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
    /// rule: the rescue transfer, the account create and the steps that free the USDC (Phoenix
    /// withdrawal, Ember unwrap) pass a pause, an order that is not reduce-only does not
    /// (`E_PAUSED`). `kind` `rescue`.
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
    /// is left of the desk's cap), then [`check_cost`] at the policy's bounds.
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

    /// Counts `amount_e8` against the desk's cap at the block time.
    fn spend_rescue(&mut self, desk_id: &str, amount_e8: u128) {
        let mut counters = self.desk_counters.get(desk_id).copied().unwrap_or_default();
        counters.spend(amount_e8, env::block_timestamp_ms());
        self.desk_counters.insert(desk_id.to_owned(), counters);
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
        self.spend_rescue(&desk_id, q.amount_in_e8);
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
        // The rescue's own pause rule: everything a rescue message may carry passes a paused
        // desk, except an order that can grow a position.
        if checked.orders.iter().any(|o| !o.reduce_only) {
            desk.check_action(&desk_id, &env::predecessor_account_id(), Gate::Running)
                .or_fail();
        }
        let orders = checked
            .orders
            .iter()
            .map(|o| OrderDetail::new(&o.symbol, o.bid, o.size_e8, o.price_e8, o.valued))
            .collect();
        self.spend_rescue(&desk_id, q.amount_in_e8);
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
        let mut counters = self
            .desk_counters
            .get(&desk_id)
            .copied()
            .unwrap_or_default();
        let counter = counters.eip3009_next;
        counters.eip3009_next = counter
            .checked_add(1)
            .ok_or_else(|| quote_fields("the desk's EIP-3009 counter is exhausted"))
            .or_fail();
        self.desk_counters.insert(desk_id.clone(), counters);
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
        self.spend_rescue(&desk_id, q.amount_in_e8);
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
    crate::fail(quote_fields(msg))
}
