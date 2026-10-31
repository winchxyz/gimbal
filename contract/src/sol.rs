//! The Solana action methods (docs/interfaces.md §1.3): `sol_sign` for Phoenix, Ember and the
//! desk's own token transfers, and `sol_sign_register` for Phoenix onboarding. Each decodes the
//! compiled message, derives the desk's token accounts and Phoenix trader account from its
//! authority (the stored `solana` fields are not read: `create_desk` checked them against the
//! same derivation, and no check depends on that), checks every instruction in `gimbal-core` and
//! has the desk's Solana key sign the message through the MPC contract; the transaction returns
//! the `SignedAction`. Each public method is its `prepare_*` followed by `Gimbal::sign`.

use gimbal_core::errors::{Refusal, E_ARGS, E_SOL_MESSAGE};
use gimbal_core::ids::{check_base58_32, check_reason};
use gimbal_core::phoenix::{check_message, check_registration};
use gimbal_core::solana::{SolDesk, MAX_TRANSACTION_BYTES};
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::base64::Engine as _;
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::desk::{Desk, Gate};
use crate::prices::reference_price;
use crate::{action_desk, Gimbal, GimbalExt, OrFail};

/// The host's SHA-256, which the core derivations take as a function.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    env::sha256_array(data)
}

/// The longest `message_b64` decoded: the base64 of the largest message a one-signature
/// transaction can carry (1232 − 1 − 64 bytes). The core checks each method's exact limit.
pub const MESSAGE_B64_MAX_LEN: usize = (MAX_TRANSACTION_BYTES - 65).div_ceil(3) * 4;

/// The message bytes of `message_b64`: standard base64 with padding, one spelling per message
/// (`E_ARGS`), and no longer than a transaction can carry (`E_SOL_MESSAGE`).
pub fn decode_message(message_b64: &str) -> Result<Vec<u8>, Refusal> {
    if message_b64.len() > MESSAGE_B64_MAX_LEN {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            format!(
                "message_b64 has {} characters; a Solana transaction is at most {MAX_TRANSACTION_BYTES} bytes, so its message at most {MESSAGE_B64_MAX_LEN}",
                message_b64.len()
            ),
        ));
    }
    STANDARD.decode(message_b64).map_err(|e| {
        Refusal::new(
            E_ARGS,
            format!("message_b64 is not standard base64 with padding: {e}"),
        )
    })
}

/// The desk's Solana accounts, derived from its authority.
pub fn desk_accounts(desk: &Desk) -> Result<SolDesk, Refusal> {
    let authority = check_base58_32("solana.authority", &desk.solana.authority)?;
    SolDesk::derive(sha256, authority)
}

#[near]
impl Gimbal {
    /// Signs a Solana transaction message for the desk's authority: compute budget (within the
    /// caps, a price only with a unit limit), creation of the desk's USDC and PhUSD token
    /// accounts, an Approve to Ember for exactly the unwrap that follows it with a Revoke of the
    /// desk's PhUSD account after that unwrap, Revokes, transfers of more than 0 into the desk's
    /// own token accounts from another account, Ember deposits and withdrawals between them, and
    /// Phoenix IOC orders on policy markets, `cancel_all`, deposits and withdrawals on the desk's
    /// trader account, each with its exact account list. A legacy message with the desk as its
    /// only signer and fee payer and something to do besides the compute budget
    /// (`E_SOL_MESSAGE`); any other program or instruction is `E_SOL_PROGRAM`, a foreign or
    /// misplaced account `E_SOL_ACCOUNT`, a market outside the policy `E_ASSET`, and each order
    /// is checked as `hl_order` checks one: `E_ORACLE_STALE` for every priced order until prices
    /// are stored (C6), `E_PRICE_BAND`, `E_SIZE`. Owner or operator; on a paused desk only a
    /// message that reduces risk (besides the compute budget only `cancel_all`, reduce-only
    /// orders, Revokes and transfers into the desk's token accounts, and a priority fee only with
    /// a `cancel_all` or a reduce-only order), else `E_PAUSED`. `kind` is `order`, else the first
    /// Phoenix action (`cancel_all`, `deposit`, `withdraw`), else `transaction`.
    #[deny_unknown_arguments]
    pub fn sol_sign(&mut self, desk_id: String, message_b64: String, reason: String) -> Promise {
        let action = self.prepare_sol_sign(desk_id, message_b64, reason);
        self.sign(action)
    }

    /// Signs one of Phoenix's two onboarding messages for the desk, which Phoenix's onboarder
    /// co-signs and Phoenix's API sends: the registration `build-register-ixs` returns
    /// (`register_trader` + `set_trader_capabilities_delegated`, a legacy message) or a referral
    /// activation (`set_trader_capabilities_delegated` alone, a version 0 message without
    /// lookups). The format names the type; then two signers, keys[0] the desk paying fees and
    /// keys[1] Phoenix's onboarder (`E_SOL_MESSAGE`, `E_SOL_ACCOUNT`), an optional compute budget
    /// prefix within the caps, Phoenix's instruction data byte for byte (`E_ARGS`) and its
    /// accounts position by position (`E_SOL_ACCOUNT`), the desk's own trader account derived from
    /// its authority. The referral code travels only in the HTTP call, so nothing here binds one.
    /// Owner or operator, running desk; `kind` is `register` or `referral_activate`.
    #[deny_unknown_arguments]
    pub fn sol_sign_register(&mut self, desk_id: String, message_b64: String) -> Promise {
        let action = self.prepare_sol_sign_register(desk_id, message_b64);
        self.sign(action)
    }
}

impl Gimbal {
    /// [`Self::sol_sign`] up to the signature.
    pub fn prepare_sol_sign(
        &mut self,
        desk_id: String,
        message_b64: String,
        reason: String,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let message = decode_message(&message_b64).or_fail();
        let accounts = desk_accounts(desk).or_fail();
        let max_age_s = desk.policy.oracle_max_age_s;
        let reference = |symbol: &str| reference_price(symbol, max_age_s);
        let checked =
            check_message(sha256, &desk.policy, &accounts, &message, &reference, None).or_fail();
        if !checked.reduces_risk {
            desk.check_action(&desk_id, &env::predecessor_account_id(), Gate::Running)
                .or_fail();
        }
        let orders = checked
            .orders
            .iter()
            .map(|o| OrderDetail::new(&o.symbol, o.bid, o.size_e8, o.price_e8, o.valued))
            .collect();
        UnsignedAction::solana(desk_id, checked.kind, message_b64, &message, Some(&reason))
            .with_orders(orders)
    }

    /// [`Self::sol_sign_register`] up to the signature.
    pub fn prepare_sol_sign_register(
        &mut self,
        desk_id: String,
        message_b64: String,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::Running);
        let message = decode_message(&message_b64).or_fail();
        let accounts = desk_accounts(desk).or_fail();
        let which = check_registration(&accounts.authority, &accounts.trader, &message).or_fail();
        UnsignedAction::solana(desk_id, which.kind(), message_b64, &message, None)
    }
}
