//! The Hyperliquid action methods (docs/interfaces.md §1.3). Each runs its guard, builds the action
//! in `gimbal-core` from the policy, `Treasury` and `FeeConfig` (the caller chooses only what the
//! method takes), gives it the desk's next nonce and has the desk's master address sign it through
//! the MPC contract; the transaction returns the `SignedAction`. The desk's EVM key signs
//! everything: Gimbal uses no agent wallets.
//!
//! Each public method is its `prepare_*` (the checks and the [`UnsignedAction`], which the unit
//! tests read) followed by `Gimbal::sign`.

use gimbal_core::hl::{
    cancel_action, check_order, check_usdc_amount, max_fee_rate, order_action, prepare_l1,
    referral_code, set_referrer_action, Address, HlOrder, UserAction,
};
use gimbal_core::ids::check_reason;
use gimbal_core::limits::Valued;
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::config::Config;
use crate::deposit::check_one_yocto;
use crate::desk::Gate;
use crate::prices::reference_price;
use crate::{action_desk, owner_desk, take_hl_nonce, Gimbal, GimbalExt, OrFail};

/// The host's keccak256, which the core builders take as a function.
pub fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

#[near]
impl Gimbal {
    /// A limit order on Hyperliquid, with the treasury's builder fee. Owner or operator; a
    /// reduce-only order also on a paused desk. Refuses an asset outside the policy (`E_ASSET`),
    /// a bad tif or cloid (`E_ARGS`), px or sz strings that are not canonical or break
    /// Hyperliquid's rules (`E_DECIMAL`), a zero size (`E_SIZE`), and then, for a symbol in
    /// `policy.unpriced`, a size over its `max_sz` or a notional px × sz over the unpriced cap
    /// (`E_SIZE`); for any other symbol no fresh oracle price (`E_ORACLE_STALE`, every priced
    /// order until prices are stored, C6), a price outside the band (`E_PRICE_BAND`) or a notional
    /// sz × max(px, oracle) over `max_notional_usd` (`E_SIZE`).
    #[deny_unknown_arguments]
    pub fn hl_order(&mut self, desk_id: String, order: HlOrder, reason: String) -> Promise {
        let action = self.prepare_hl_order(desk_id, order, reason);
        self.sign(action)
    }

    /// Cancels the desk's resting order `oid` on Hyperliquid asset `asset`:
    /// `{type:"cancel", cancels:[{a, o}]}`. Owner or operator, also on a paused desk, so a pause
    /// can stop resting orders. The asset need not be in the policy any more: an owner who drops
    /// an asset must still be able to cancel what rests on it.
    #[deny_unknown_arguments]
    pub fn hl_cancel(&mut self, desk_id: String, asset: u32, oid: u64, reason: String) -> Promise {
        let action = self.prepare_hl_cancel(desk_id, asset, oid, reason);
        self.sign(action)
    }

    /// `{type:"setReferrer", code}` with the treasury's Hyperliquid referral code, the only one a
    /// desk can sign. Venue setup sends it once, before the desk's first order; with no code
    /// configured it is `E_ARGS` and setup skips it. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn hl_set_referrer(&mut self, desk_id: String) -> Promise {
        let action = self.prepare_hl_set_referrer(desk_id);
        self.sign(action)
    }

    /// `ApproveBuilderFee` for the treasury's builder at the fee `FeeConfig` fixes (10 tenths of a
    /// bp = `"0.01%"`), which every order then carries. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn hl_approve_builder_fee(&mut self, desk_id: String) -> Promise {
        let action = self.prepare_hl_approve_builder_fee(desk_id);
        self.sign(action)
    }

    /// Moves `amount` USDC between the desk's spot and perp balances on Hyperliquid. Owner or
    /// operator, running desk. `amount`: canonical, at most 6 decimals (`E_DECIMAL`), not zero
    /// (`E_SIZE`).
    #[deny_unknown_arguments]
    pub fn hl_usd_class_transfer(
        &mut self,
        desk_id: String,
        amount: String,
        to_perp: bool,
        reason: String,
    ) -> Promise {
        let action = self.prepare_hl_usd_class_transfer(desk_id, amount, to_perp, reason);
        self.sign(action)
    }

    /// Emergency only: withdraws `amount` USDC from Hyperliquid to the desk's own EVM address on
    /// Arbitrum. Owner only, exactly 1 yoctoNEAR attached (`E_NOT_ALLOWED`), also on a paused
    /// desk. `amount` as for [`Self::hl_usd_class_transfer`]; Hyperliquid takes its withdrawal fee
    /// out of it.
    #[payable]
    #[deny_unknown_arguments]
    pub fn hl_withdraw(&mut self, desk_id: String, amount: String) -> Promise {
        let action = self.prepare_hl_withdraw(desk_id, amount);
        self.sign(action)
    }
}

impl Gimbal {
    /// [`Self::hl_order`] up to the signature.
    pub fn prepare_hl_order(
        &mut self,
        desk_id: String,
        order: HlOrder,
        reason: String,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::order(order.reduce_only));
        check_reason(&reason).or_fail();
        let reference = desk
            .policy
            .hl_assets
            .iter()
            .find(|a| a.index == order.asset)
            .and_then(|a| reference_price(&a.symbol, desk.policy.oracle_max_age_s));
        let checked = check_order(&desk.policy, &order, reference).or_fail();
        let detail = OrderDetail::new(
            &checked.symbol,
            order.is_buy,
            checked.sz_e8,
            checked.px_e8,
            Valued {
                oracle_e8: checked.oracle_e8,
            },
        );
        let builder = treasury_builder(&self.config);
        let action = order_action(
            &checked.wire,
            &builder,
            self.config.fees.hl_builder_tenth_bps,
        );
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let prepared = prepare_l1(keccak, self.config.network, "order", action, nonce);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(&reason)).with_orders(vec![detail])
    }

    /// [`Self::hl_cancel`] up to the signature.
    pub fn prepare_hl_cancel(
        &mut self,
        desk_id: String,
        asset: u32,
        oid: u64,
        reason: String,
    ) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let action = cancel_action(asset, oid);
        let prepared = prepare_l1(keccak, self.config.network, "cancel", action, nonce);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(&reason))
    }

    /// [`Self::hl_set_referrer`] up to the signature.
    pub fn prepare_hl_set_referrer(&mut self, desk_id: String) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::Running);
        let code =
            referral_code(self.config.treasury.referral_codes.hyperliquid.as_deref()).or_fail();
        let action = set_referrer_action(code);
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let prepared = prepare_l1(keccak, self.config.network, "setReferrer", action, nonce);
        UnsignedAction::hyperliquid(desk_id, prepared, None)
    }

    /// [`Self::hl_approve_builder_fee`] up to the signature.
    pub fn prepare_hl_approve_builder_fee(&mut self, desk_id: String) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::Running);
        let builder = treasury_builder(&self.config);
        let max_fee_rate = max_fee_rate(self.config.fees.hl_builder_tenth_bps);
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let action = UserAction::ApproveBuilderFee {
            max_fee_rate,
            builder,
            nonce,
        };
        UnsignedAction::hyperliquid(desk_id, action.prepare(keccak, self.config.network), None)
    }

    /// [`Self::hl_usd_class_transfer`] up to the signature.
    pub fn prepare_hl_usd_class_transfer(
        &mut self,
        desk_id: String,
        amount: String,
        to_perp: bool,
        reason: String,
    ) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::Running);
        check_reason(&reason).or_fail();
        check_usdc_amount(&amount).or_fail();
        let nonce = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let action = UserAction::UsdClassTransfer {
            amount: amount.clone(),
            to_perp,
            nonce,
        };
        let prepared = action.prepare(keccak, self.config.network);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(&reason)).with_amount(Some(amount))
    }

    /// [`Self::hl_withdraw`] up to the signature.
    pub fn prepare_hl_withdraw(&mut self, desk_id: String, amount: String) -> UnsignedAction {
        let desk = owner_desk(&self.desks, &desk_id, "hl_withdraw");
        check_one_yocto("hl_withdraw", env::attached_deposit()).or_fail();
        check_usdc_amount(&amount).or_fail();
        let destination = Address::parse("evm_address", &desk.evm_address).or_fail();
        let time = take_hl_nonce(&mut self.hl_nonces, &desk_id, env::block_timestamp_ms());
        let action = UserAction::Withdraw {
            destination,
            amount: amount.clone(),
            time,
        };
        UnsignedAction::hyperliquid(desk_id, action.prepare(keccak, self.config.network), None)
            .with_amount(Some(amount))
    }
}

/// `treasury.hl_builder`, which `new` checked is a lowercase address.
fn treasury_builder(config: &Config) -> Address {
    Address::parse("treasury.hl_builder", &config.treasury.hl_builder).or_fail()
}
