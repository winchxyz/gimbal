//! The Hyperliquid action methods (docs/interfaces.md §1.3). Each runs its guard, builds the action
//! in `gimbal-core` from the policy, `Treasury` and `FeeConfig` (the caller chooses only what the
//! method takes), gives it the desk's next nonce and returns the [`UnsignedAction`] for the desk's
//! master address. The desk's EVM key signs everything: Gimbal uses no agent wallets.

use gimbal_core::hl::{
    check_order, check_usdc_amount, max_fee_rate, order_action, prepare_l1, referral_code,
    set_referrer_action, Address, HlOrder, UserAction,
};
use gimbal_core::ids::check_reason;
use near_sdk::{env, near};

use crate::action::UnsignedAction;
use crate::config::Config;
use crate::deposit::check_one_yocto;
use crate::desk::Gate;
use crate::prices::reference_price;
use crate::{action_desk, owner_desk, Gimbal, GimbalExt, OrFail};

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
    pub fn hl_order(&mut self, desk_id: String, order: HlOrder, reason: String) -> UnsignedAction {
        let (desk, _) = action_desk(&mut self.desks, &desk_id, Gate::order(order.reduce_only));
        check_reason(&reason).or_fail();
        let reference = desk
            .policy
            .hl_assets
            .iter()
            .find(|a| a.index == order.asset)
            .and_then(|a| reference_price(&a.symbol, desk.policy.oracle_max_age_s));
        let checked = check_order(&desk.policy, &order, reference).or_fail();
        let builder = treasury_builder(&self.config);
        let action = order_action(
            &checked.wire,
            &builder,
            self.config.fees.hl_builder_tenth_bps,
        );
        let nonce = desk.take_hl_nonce(env::block_timestamp_ms());
        let prepared = prepare_l1(keccak, self.config.network, "order", action, nonce);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(&reason))
    }

    /// `{type:"setReferrer", code}` with the treasury's Hyperliquid referral code, the only one a
    /// desk can sign. Venue setup sends it once, before the desk's first order; with no code
    /// configured it is `E_ARGS` and setup skips it. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn hl_set_referrer(&mut self, desk_id: String) -> UnsignedAction {
        let (desk, _) = action_desk(&mut self.desks, &desk_id, Gate::Running);
        let code =
            referral_code(self.config.treasury.referral_codes.hyperliquid.as_deref()).or_fail();
        let action = set_referrer_action(code);
        let nonce = desk.take_hl_nonce(env::block_timestamp_ms());
        let prepared = prepare_l1(keccak, self.config.network, "setReferrer", action, nonce);
        UnsignedAction::hyperliquid(desk_id, prepared, None)
    }

    /// `ApproveBuilderFee` for the treasury's builder at the fee `FeeConfig` fixes (10 tenths of a
    /// bp = `"0.01%"`), which every order then carries. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn hl_approve_builder_fee(&mut self, desk_id: String) -> UnsignedAction {
        let (desk, _) = action_desk(&mut self.desks, &desk_id, Gate::Running);
        let builder = treasury_builder(&self.config);
        let max_fee_rate = max_fee_rate(self.config.fees.hl_builder_tenth_bps);
        let nonce = desk.take_hl_nonce(env::block_timestamp_ms());
        let action = UserAction::ApproveBuilderFee {
            max_fee_rate,
            builder,
            nonce,
        };
        UnsignedAction::hyperliquid(desk_id, action.prepare(keccak, self.config.network), None)
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
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&mut self.desks, &desk_id, Gate::Running);
        check_reason(&reason).or_fail();
        check_usdc_amount(&amount).or_fail();
        let nonce = desk.take_hl_nonce(env::block_timestamp_ms());
        let action = UserAction::UsdClassTransfer {
            amount,
            to_perp,
            nonce,
        };
        let prepared = action.prepare(keccak, self.config.network);
        UnsignedAction::hyperliquid(desk_id, prepared, Some(&reason))
    }

    /// Emergency only: withdraws `amount` USDC from Hyperliquid to the desk's own EVM address on
    /// Arbitrum. Owner only, exactly 1 yoctoNEAR attached (`E_NOT_ALLOWED`), also on a paused
    /// desk. `amount` as for [`Self::hl_usd_class_transfer`]; Hyperliquid takes its withdrawal fee
    /// out of it.
    #[payable]
    #[deny_unknown_arguments]
    pub fn hl_withdraw(&mut self, desk_id: String, amount: String) -> UnsignedAction {
        let desk = owner_desk(&mut self.desks, &desk_id, "hl_withdraw");
        check_one_yocto("hl_withdraw", env::attached_deposit()).or_fail();
        check_usdc_amount(&amount).or_fail();
        let destination = Address::parse("evm_address", &desk.evm_address).or_fail();
        let time = desk.take_hl_nonce(env::block_timestamp_ms());
        let action = UserAction::Withdraw {
            destination,
            amount,
            time,
        };
        UnsignedAction::hyperliquid(desk_id, action.prepare(keccak, self.config.network), None)
    }
}

/// `treasury.hl_builder`, which `new` checked is a lowercase address.
fn treasury_builder(config: &Config) -> Address {
    Address::parse("treasury.hl_builder", &config.treasury.hl_builder).or_fail()
}
