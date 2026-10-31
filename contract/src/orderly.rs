//! The Orderly action methods (docs/interfaces.md §1.3, §1.4). The desk's EVM key signs the
//! EIP-712 messages (`orderly_register`, `orderly_add_key`, `orderly_settle_pnl`,
//! `orderly_withdraw`), its Ed25519 key, the orderly key, the private REST calls
//! (`orderly_request`) and the WebSocket login (`orderly_ws_auth`). Every message and body is built
//! in `gimbal-core` from typed fields, the policy and `OrderlyConfig`; broker id and chain id
//! never come from the caller, timestamps of EIP-712 messages are the block time. Each public
//! method is its `prepare_*` followed by `Gimbal::sign`.

use gimbal_core::errors::{Refusal, E_ARGS};
use gimbal_core::hl::Address;
use gimbal_core::ids::{check_base58_32, check_reason};
use gimbal_core::orderly::{
    account_id, build_request, ws_auth, Broker, Context, Message, OrderlyRequest, Signable,
};
use near_sdk::{env, near, Promise};

use crate::action::{OrderDetail, UnsignedAction};
use crate::desk::{Desk, Gate};
use crate::hl::keccak;
use crate::mpc::recover_evm;
use crate::prices::reference_price;
use crate::{action_desk, Gimbal, GimbalExt, OrFail};

/// The Orderly account id of `evm_address` (a checked `0x` address) under `broker_id`, lowercase
/// `0x` hex: keccak256(abi.encode(address, keccak256(broker_id))).
pub fn orderly_account_id(evm_address: &str, broker_id: &str) -> String {
    let owner = Address::parse("evm_address", evm_address).or_fail();
    format!("0x{}", hex::encode(account_id(keccak, &owner.0, broker_id)))
}

/// The desk's EVM address as bytes; `create_desk` checked it.
fn desk_evm(desk: &Desk) -> [u8; 20] {
    Address::parse("evm_address", &desk.evm_address).or_fail().0
}

/// `eip712_signature` is the desk's own signature of `digest` (`E_ARGS`): the contract signs no
/// request whose body carries a signature Orderly would refuse.
fn check_desk_signature(
    digest: &[u8; 32],
    signature: &[u8; 65],
    evm_address: &str,
) -> Result<(), Refusal> {
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&signature[..64]);
    match recover_evm(digest, &rs, signature[64] - 27) {
        Some(address) if address == evm_address => Ok(()),
        Some(address) => Err(Refusal::new(
            E_ARGS,
            format!(
                "eip712_signature is {address}'s signature of the message, not the desk's \
                 ({evm_address})"
            ),
        )),
        None => Err(Refusal::new(E_ARGS, "eip712_signature recovers to no key")),
    }
}

/// The REST call (or WebSocket login) as an action for the desk's Ed25519 key.
fn rest_action(desk_id: String, signable: &Signable, reason: Option<&str>) -> UnsignedAction {
    let orders = signable
        .order
        .iter()
        .map(|o| OrderDetail::new(&o.symbol, o.buy, o.sz_e8, o.px_e8, o.valued))
        .collect();
    UnsignedAction::orderly_rest(
        desk_id,
        signable.kind,
        signable.payload(),
        &signable.message(),
        reason,
    )
    .with_orders(orders)
    .with_amount(signable.amount.clone())
}

#[near]
impl Gimbal {
    /// EIP-712 `Registration` of the desk's EVM address with `OrderlyConfig`'s broker, at the
    /// block time, with the nonce from Orderly's public `GET /v1/registration_nonce` (its decimal
    /// digits, `E_ARGS` otherwise). The relayer posts `{message, signature, userAddress}` to
    /// `/v1/register_account`. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn orderly_register(&mut self, desk_id: String, registration_nonce: String) -> Promise {
        let action = self.prepare_orderly_register(desk_id, registration_nonce);
        self.sign(action)
    }

    /// EIP-712 `AddOrderlyKey`: the desk's Ed25519 MPC key (its Solana authority) as its orderly
    /// key, scope `read,trading`, at the block time, expiring at `expiration_ms`: after the block
    /// time and at most 365 days later (`E_ARGS`). No other key can be added. Owner or operator,
    /// running desk.
    #[deny_unknown_arguments]
    pub fn orderly_add_key(&mut self, desk_id: String, expiration_ms: u64) -> Promise {
        let action = self.prepare_orderly_add_key(desk_id, expiration_ms);
        self.sign(action)
    }

    /// A private REST call signed with the orderly key after the checks of
    /// [`gimbal_core::orderly::build_request`]: `req.timestamp_ms` within Orderly's 300 s window
    /// of the block time, only the fields the kind takes, an order's symbol in the policy and its
    /// price and size checked as `hl_order` checks them, the money-path bodies rebuilt from their
    /// typed fields with an `eip712_signature` that must be the desk's (`E_ARGS`), `referral_bind`
    /// with the configured code only. Owner or operator; on a paused desk only reduce-only orders,
    /// cancels and reads (`E_PAUSED` otherwise).
    #[deny_unknown_arguments]
    pub fn orderly_request(
        &mut self,
        desk_id: String,
        req: OrderlyRequest,
        reason: String,
    ) -> Promise {
        let action = self.prepare_orderly_request(desk_id, req, reason);
        self.sign(action)
    }

    /// The private WebSocket login: the orderly key signs `timestamp` alone, in decimal, which
    /// must be within Orderly's 300 s window of the block time (`E_ARGS`). Owner or operator, also
    /// on a paused desk (it only reads positions and balances). `kind` is `ws_auth`.
    #[deny_unknown_arguments]
    pub fn orderly_ws_auth(&mut self, desk_id: String, timestamp: u64) -> Promise {
        let action = self.prepare_orderly_ws_auth(desk_id, timestamp);
        self.sign(action)
    }

    /// EIP-712 `SettlePnl` with Orderly's `settle_nonce`, at the block time; every withdrawal needs
    /// it first. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn orderly_settle_pnl(&mut self, desk_id: String, settle_nonce: u64) -> Promise {
        let action = self.prepare_orderly_settle_pnl(desk_id, settle_nonce);
        self.sign(action)
    }

    /// EIP-712 `Withdraw` of `amount` USDC (canonical, at most 6 decimals: `E_DECIMAL`; not zero:
    /// `E_SIZE`) to the desk's own EVM address on Arbitrum, token USDC, with Orderly's
    /// `withdraw_nonce`, at the block time. The message carries the amount in raw units (1e-6), a
    /// string in the JSON. Owner or operator, running desk.
    #[deny_unknown_arguments]
    pub fn orderly_withdraw(
        &mut self,
        desk_id: String,
        amount: String,
        withdraw_nonce: u64,
    ) -> Promise {
        let action = self.prepare_orderly_withdraw(desk_id, amount, withdraw_nonce);
        self.sign(action)
    }
}

impl Gimbal {
    /// The broker every Orderly message names.
    fn broker(&self) -> Broker<'_> {
        Broker {
            network: self.config.network,
            broker_id: &self.config.orderly.broker_id,
            chain_id: self.config.orderly.chain_id,
        }
    }

    /// An EIP-712 message as an action for the desk's EVM key.
    fn eip712_action(
        &self,
        desk_id: String,
        desk_evm: &[u8; 20],
        message: &Message,
    ) -> UnsignedAction {
        let broker = self.broker();
        UnsignedAction::orderly_eip712(
            desk_id,
            message.kind(),
            message.payload(keccak, &broker, desk_evm),
            &message.digest(keccak, &broker),
        )
    }

    /// [`Self::orderly_register`] up to the signature.
    pub fn prepare_orderly_register(
        &mut self,
        desk_id: String,
        registration_nonce: String,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::Running);
        let evm = desk_evm(desk);
        let message =
            Message::registration(&registration_nonce, env::block_timestamp_ms()).or_fail();
        self.eip712_action(desk_id, &evm, &message)
    }

    /// [`Self::orderly_add_key`] up to the signature.
    pub fn prepare_orderly_add_key(
        &mut self,
        desk_id: String,
        expiration_ms: u64,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::Running);
        let evm = desk_evm(desk);
        let authority = check_base58_32("solana.authority", &desk.solana.authority).or_fail();
        let message =
            Message::add_orderly_key(&authority, expiration_ms, env::block_timestamp_ms())
                .or_fail();
        self.eip712_action(desk_id, &evm, &message)
    }

    /// [`Self::orderly_request`] up to the signature.
    pub fn prepare_orderly_request(
        &mut self,
        desk_id: String,
        req: OrderlyRequest,
        reason: String,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let max_age_s = desk.policy.oracle_max_age_s;
        let reference = |symbol: &str| reference_price(symbol, max_age_s);
        let ctx = Context {
            keccak,
            broker: self.broker(),
            policy: &desk.policy,
            desk_evm: desk_evm(desk),
            referral_code: self.config.treasury.referral_codes.orderly.as_deref(),
            block_ms: env::block_timestamp_ms(),
            reference: &reference,
        };
        let signable = build_request(&ctx, &req).or_fail();
        if !signable.reduces_risk {
            desk.check_action(&desk_id, &env::predecessor_account_id(), Gate::Running)
                .or_fail();
        }
        if let Some((digest, signature)) = &signable.eip712 {
            check_desk_signature(digest, signature, &desk.evm_address).or_fail();
        }
        rest_action(desk_id, &signable, Some(&reason))
    }

    /// [`Self::orderly_ws_auth`] up to the signature.
    pub fn prepare_orderly_ws_auth(&mut self, desk_id: String, timestamp: u64) -> UnsignedAction {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        let signable = ws_auth(timestamp, env::block_timestamp_ms()).or_fail();
        rest_action(desk_id, &signable, None)
    }

    /// [`Self::orderly_settle_pnl`] up to the signature.
    pub fn prepare_orderly_settle_pnl(
        &mut self,
        desk_id: String,
        settle_nonce: u64,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::Running);
        let evm = desk_evm(desk);
        let message = Message::SettlePnl {
            settle_nonce,
            timestamp: env::block_timestamp_ms(),
        };
        self.eip712_action(desk_id, &evm, &message)
    }

    /// [`Self::orderly_withdraw`] up to the signature.
    pub fn prepare_orderly_withdraw(
        &mut self,
        desk_id: String,
        amount: String,
        withdraw_nonce: u64,
    ) -> UnsignedAction {
        let (desk, _) = action_desk(&self.desks, &desk_id, Gate::Running);
        let evm = desk_evm(desk);
        let message =
            Message::withdraw(evm, &amount, withdraw_nonce, env::block_timestamp_ms()).or_fail();
        self.eip712_action(desk_id, &evm, &message)
            .with_amount(Some(amount))
    }
}
