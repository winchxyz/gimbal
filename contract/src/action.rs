//! What an action method builds and returns (docs/interfaces.md §1.4).
//!
//! Each action method builds an [`UnsignedAction`]: the payload the relayer posts once the
//! signature is added, the request for the MPC contract's `sign`, and what the `signed` event says
//! about it. `Gimbal::sign` sends the request with 1 yoctoNEAR, and `on_signed` returns the
//! [`SignedAction`]: the same `desk_id`, `venue`, `kind` and `payload`, plus `request_id` and the
//! MPC's `signature`.

use gimbal_core::decimal::format_e8;
use gimbal_core::hl::Prepared;
use gimbal_core::limits::Valued;
use gimbal_core::msgpack::Value;
use near_sdk::{env, near};

use crate::mpc::{MpcSignature, SignRequest};

pub const VENUE_HYPERLIQUID: &str = "hyperliquid";
/// Every Solana message the desk signs: Phoenix, and the Ember and token steps around it.
pub const VENUE_PHOENIX: &str = "phoenix";
pub const VENUE_ORDERLY: &str = "orderly";
/// The desk's own address on Arbitrum: EIP-3009 authorizations the relayer submits.
pub const VENUE_ARBITRUM: &str = "arbitrum";

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsignedAction {
    pub desk_id: String,
    /// `hyperliquid`, `phoenix`, `orderly` or `arbitrum`.
    pub venue: String,
    /// The action's type: `order`, `cancel`, `setReferrer`, `approveBuilderFee`,
    /// `usdClassTransfer`, `withdraw3`, `sendAsset` for Hyperliquid; `order`, `cancel_all`,
    /// `deposit`, `withdraw`, `transaction`, `rescue`, `register`, `referral_activate` for Solana;
    /// the request kind, `ws_auth` or the EIP-712 primary type for Orderly;
    /// `transfer_with_authorization` on Arbitrum.
    pub kind: String,
    /// For Hyperliquid, the `/exchange` body without `signature`: `{action, nonce, vaultAddress:
    /// null}` for an L1 action (plus `expiresAfter` for an order or cancel), `{action, nonce}` for
    /// a user-signed one. Keys in the order signed. For Solana, `{message_b64}`: the message
    /// exactly as signed. For an Orderly REST call `{method, path, body, timestamp, message}`, for
    /// an Orderly EIP-712 message `{message, userAddress}`. On Arbitrum `{from, to, value,
    /// validAfter, validBefore, nonce, token, chainId}`: the EIP-3009 message, then the USDC
    /// contract and its chain.
    pub payload: Value,
    /// What the desk's key must sign.
    pub sign_request: SignRequest,
    /// Lowercase hex sha256 of the call's `reason`, for the `signed` event; `null` for methods
    /// that take no reason.
    pub reason_sha256: Option<String>,
    /// The orders it places, as checked, for the `signed` event; empty for any other action.
    pub orders: Vec<OrderDetail>,
    /// The USDC it moves out of or between venue balances, canonical decimal, for the `signed`
    /// event: transfers and withdrawals.
    pub amount: Option<String>,
    /// The verified 1Click deposit address a rescue transfer pays, for the `signed` event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deposit_address: Option<String>,
}

/// One order of an action, as the `signed` event shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderDetail {
    /// The policy's symbol: `ETH` (Hyperliquid), the Phoenix market symbol, `PERP_ETH_USDC`.
    pub asset: String,
    /// `buy` or `sell`.
    pub side: String,
    /// Base units, canonical decimal.
    pub size: String,
    /// The limit price, canonical decimal.
    pub px: String,
    /// The oracle price it was checked against; `null` for a symbol in `policy.unpriced`.
    pub oracle_px: Option<String>,
    pub unpriced: bool,
}

impl OrderDetail {
    pub fn new(asset: &str, buy: bool, size_e8: u128, px_e8: u128, valued: Valued) -> Self {
        Self {
            asset: asset.to_owned(),
            side: if buy { "buy" } else { "sell" }.to_owned(),
            size: format_e8(size_e8),
            px: format_e8(px_e8),
            oracle_px: valued.oracle_e8.map(format_e8),
            unpriced: valued.unpriced(),
        }
    }
}

/// The lowercase hex sha256 of a reason.
fn reason_sha256(reason: Option<&str>) -> Option<String> {
    reason.map(|r| hex::encode(env::sha256_array(r)))
}

impl UnsignedAction {
    /// A Hyperliquid action for the desk's EVM key to sign.
    pub fn hyperliquid(desk_id: String, prepared: Prepared, reason: Option<&str>) -> Self {
        Self {
            sign_request: SignRequest::evm(&desk_id, &prepared.digest),
            desk_id,
            venue: VENUE_HYPERLIQUID.into(),
            kind: prepared.kind.into(),
            payload: prepared.payload,
            reason_sha256: reason_sha256(reason),
            orders: Vec::new(),
            amount: None,
            deposit_address: None,
        }
    }

    /// A Solana message for the desk's Ed25519 key to sign; `message` is `message_b64` decoded.
    pub fn solana(
        desk_id: String,
        kind: &str,
        message_b64: String,
        message: &[u8],
        reason: Option<&str>,
    ) -> Self {
        Self {
            sign_request: SignRequest::sol(&desk_id, message),
            desk_id,
            venue: VENUE_PHOENIX.into(),
            kind: kind.into(),
            payload: Value::map([("message_b64", Value::str(message_b64))]),
            reason_sha256: reason_sha256(reason),
            orders: Vec::new(),
            amount: None,
            deposit_address: None,
        }
    }

    /// An Orderly REST call (or the WebSocket login) for the desk's Ed25519 key: it signs
    /// `message`, the UTF-8 text the payload repeats.
    pub fn orderly_rest(
        desk_id: String,
        kind: &str,
        payload: Value,
        message: &str,
        reason: Option<&str>,
    ) -> Self {
        Self {
            sign_request: SignRequest::sol(&desk_id, message.as_bytes()),
            desk_id,
            venue: VENUE_ORDERLY.into(),
            kind: kind.into(),
            payload,
            reason_sha256: reason_sha256(reason),
            orders: Vec::new(),
            amount: None,
            deposit_address: None,
        }
    }

    /// An Orderly EIP-712 message for the desk's EVM key: it signs `digest`.
    pub fn orderly_eip712(desk_id: String, kind: &str, payload: Value, digest: &[u8; 32]) -> Self {
        Self {
            sign_request: SignRequest::evm(&desk_id, digest),
            desk_id,
            venue: VENUE_ORDERLY.into(),
            kind: kind.into(),
            payload,
            reason_sha256: None,
            orders: Vec::new(),
            amount: None,
            deposit_address: None,
        }
    }

    /// An EIP-3009 authorization on Arbitrum for the desk's EVM key: it signs `digest`.
    pub fn arbitrum(
        desk_id: String,
        kind: &str,
        payload: Value,
        digest: &[u8; 32],
        reason: &str,
    ) -> Self {
        Self {
            sign_request: SignRequest::evm(&desk_id, digest),
            desk_id,
            venue: VENUE_ARBITRUM.into(),
            kind: kind.into(),
            payload,
            reason_sha256: reason_sha256(Some(reason)),
            orders: Vec::new(),
            amount: None,
            deposit_address: None,
        }
    }

    pub fn with_deposit_address(mut self, deposit_address: String) -> Self {
        self.deposit_address = Some(deposit_address);
        self
    }

    pub fn with_orders(mut self, orders: Vec<OrderDetail>) -> Self {
        self.orders = orders;
        self
    }

    pub fn with_amount(mut self, amount: Option<String>) -> Self {
        self.amount = amount;
        self
    }
}

/// What every action method returns once the MPC signed (docs/interfaces.md §1.4); the engine
/// submits it as is.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedAction {
    pub desk_id: String,
    /// The contract's count of signing requests, from 0: one per action call.
    pub request_id: u64,
    pub venue: String,
    pub kind: String,
    pub payload: Value,
    /// The MPC contract's answer as it gave it: `{scheme: "Secp256k1", big_r, s, recovery_id}` or
    /// `{scheme: "Ed25519", signature}`.
    pub signature: MpcSignature,
}

/// What `on_signed` gets: the action, its request id and who must have signed it (the desk's
/// lowercase EVM address or base58 Solana authority).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub request_id: u64,
    pub signer: String,
    pub action: UnsignedAction,
}
