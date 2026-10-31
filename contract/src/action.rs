//! What an action method returns (docs/interfaces.md §1.4).
//!
//! Until the MPC call lands (C5), an action method stops at [`UnsignedAction`]: the payload the
//! relayer posts once the signature is added, and the request for the MPC contract's `sign`. C5
//! sends that request and returns the `SignedAction` from `on_signed`: the same `desk_id`, `venue`,
//! `kind` and `payload`, plus `request_id` and `signature`.

use gimbal_core::hl::Prepared;
use gimbal_core::msgpack::Value;
use near_sdk::{env, near};

use crate::mpc::SignRequest;

pub const VENUE_HYPERLIQUID: &str = "hyperliquid";
/// Every Solana message the desk signs: Phoenix, and the Ember and token steps around it.
pub const VENUE_PHOENIX: &str = "phoenix";

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsignedAction {
    pub desk_id: String,
    /// `hyperliquid` or `phoenix` (`orderly` later).
    pub venue: String,
    /// The action's type: `order`, `setReferrer`, `approveBuilderFee`, `usdClassTransfer`,
    /// `withdraw3`, …
    pub kind: String,
    /// For Hyperliquid, the `/exchange` body without `signature`: `{action, nonce, vaultAddress:
    /// null}` for an L1 action, `{action, nonce}` for a user-signed one. Keys in the order signed.
    /// For Solana, `{message_b64}`: the message exactly as signed.
    pub payload: Value,
    /// What the desk's key must sign.
    pub sign_request: SignRequest,
    /// Lowercase hex sha256 of the call's `reason`, for the `signed` event; `null` for methods
    /// that take no reason.
    pub reason_sha256: Option<String>,
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
            reason_sha256: reason.map(|r| hex::encode(env::sha256_array(r))),
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
            reason_sha256: reason.map(|r| hex::encode(env::sha256_array(r))),
        }
    }
}
