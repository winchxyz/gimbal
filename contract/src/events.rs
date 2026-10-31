//! NEP-297 events (docs/interfaces.md §1.6):
//! `EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"<name>","data":[{…}]}`.

use near_sdk::serde::Serialize;
use near_sdk::serde_json;
use near_sdk::{env, AccountId};

use crate::action::{OrderDetail, Pending};

pub const STANDARD: &str = "gimbal";
pub const VERSION: &str = "1.0.0";

pub const DESK_CREATED: &str = "desk_created";
pub const POLICY_SET: &str = "policy_set";
pub const OPERATOR_SET: &str = "operator_set";
pub const ORDERLY_RECEIVER_SET: &str = "orderly_receiver_set";
pub const PAUSED: &str = "paused";
pub const PRICES: &str = "prices";
/// Emitted in `on_signed`, only when the MPC returned a signature.
pub const SIGNED: &str = "signed";
pub const DEPOSIT: &str = "deposit";
pub const PAYOUT: &str = "payout";
pub const FEE_CHARGED: &str = "fee_charged";

/// Field order is the order the interface shows, which a struct keeps and a JSON map would not.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a, T: Serialize> {
    standard: &'static str,
    version: &'static str,
    event: &'a str,
    data: &'a [T],
}

/// The log line for one event, `EVENT_JSON:` included.
pub fn event_json<T: Serialize>(event: &str, data: &[T]) -> String {
    let envelope = Envelope {
        standard: STANDARD,
        version: VERSION,
        event,
        data,
    };
    // Serialising plain structs of strings and numbers cannot fail.
    let json = serde_json::to_string(&envelope).unwrap_or_else(|_| env::abort());
    format!("EVENT_JSON:{json}")
}

/// Logs an event with every item of `data`; most events carry one item, `prices` carries many.
pub fn emit<T: Serialize>(event: &str, data: &[T]) {
    env::log_str(&event_json(event, data));
}

/// The data of one event; the type fixes the event name, so the two cannot be mixed up.
pub trait Event: Serialize + Sized {
    const NAME: &'static str;

    /// Logs this event with this one item.
    fn emit(&self) {
        emit(Self::NAME, std::slice::from_ref(self));
    }
}

/// A new desk and the venue addresses it can never change.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DeskCreated<'a> {
    pub desk_id: &'a str,
    pub owner: &'a AccountId,
    pub evm_address: &'a str,
    pub sol_authority: &'a str,
}

impl Event for DeskCreated<'_> {
    const NAME: &'static str = DESK_CREATED;
}

/// The owner set a policy; `policy_sha256` is [`crate::desk::policy_sha256`].
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PolicySet<'a> {
    pub desk_id: &'a str,
    pub policy_sha256: &'a str,
}

impl Event for PolicySet<'_> {
    const NAME: &'static str = POLICY_SET;
}

/// The owner set the operator account, or cleared it (`null`).
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct OperatorSet<'a> {
    pub desk_id: &'a str,
    pub operator: Option<&'a AccountId>,
}

impl Event for OperatorSet<'_> {
    const NAME: &'static str = OPERATOR_SET;
}

/// The desk was paused or unpaused, and by which account. Logged only when the state changes, so
/// after a pause `by` is the account that actually paused.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Paused<'a> {
    pub desk_id: &'a str,
    pub paused: bool,
    pub by: &'a AccountId,
}

impl Event for Paused<'_> {
    const NAME: &'static str = PAUSED;
}

/// One item of `signed`: the action the MPC signed, one item per order it places (asset, side,
/// size, px, oracle_px, unpriced), or one without them for any other action.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Signed<'a> {
    pub desk_id: &'a str,
    pub request_id: u64,
    pub venue: &'a str,
    pub kind: &'a str,
    #[serde(flatten)]
    pub order: Option<&'a OrderDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<&'a str>,
    pub reason_sha256: Option<&'a str>,
}

/// Logs `signed` for the action of `pending`, which the MPC signed.
pub fn emit_signed(pending: &Pending) {
    let a = &pending.action;
    let item = |order| Signed {
        desk_id: &a.desk_id,
        request_id: pending.request_id,
        venue: &a.venue,
        kind: &a.kind,
        order,
        amount: a.amount.as_deref(),
        reason_sha256: a.reason_sha256.as_deref(),
    };
    let items: Vec<Signed> = if a.orders.is_empty() {
        vec![item(None)]
    } else {
        a.orders.iter().map(|o| item(Some(o))).collect()
    };
    emit(SIGNED, &items);
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn account(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    /// The one line `event.emit()` logs, in a fresh environment.
    fn logged(event: impl Event) -> String {
        testing_env!(VMContextBuilder::new().build());
        event.emit();
        let mut logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        logs.remove(0)
    }

    #[test]
    fn envelope_matches_the_interface() {
        let line = event_json(PRICES, &[json!({"asset": "ETH"})]);
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"prices","data":[{"asset":"ETH"}]}"#
        );
    }

    #[test]
    fn several_items_stay_in_one_event() {
        let prices = [
            json!({"asset": "ETH", "price_e8": 239_710_000_000u64, "at_ms": 1}),
            json!({"asset": "BTC", "price_e8": 8_125_500_000_000u64, "at_ms": 1}),
        ];
        let line = event_json(PRICES, &prices);
        let parsed: serde_json::Value =
            serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(parsed["event"], "prices");
        assert_eq!(parsed["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn emit_writes_one_log_line() {
        emit(POLICY_SET, &[json!({"desk_id": "alpha"})]);
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"policy_set","data":[{"desk_id":"alpha"}]}"#
            ]
        );
    }

    #[test]
    fn desk_created_json() {
        let owner = account("owner.testnet");
        let line = logged(DeskCreated {
            desk_id: "alpha",
            owner: &owner,
            evm_address: "0x8ba1f109551bd432803012645ac136ddd64dba72",
            sol_authority: "EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"desk_created","data":[{"desk_id":"alpha","owner":"owner.testnet","evm_address":"0x8ba1f109551bd432803012645ac136ddd64dba72","sol_authority":"EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z"}]}"#
        );
    }

    #[test]
    fn policy_set_json() {
        let line = logged(PolicySet {
            desk_id: "alpha",
            policy_sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"policy_set","data":[{"desk_id":"alpha","policy_sha256":"0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"}]}"#
        );
    }

    #[test]
    fn operator_set_json() {
        let operator = account("engine.testnet");
        let line = logged(OperatorSet {
            desk_id: "alpha",
            operator: Some(&operator),
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"operator_set","data":[{"desk_id":"alpha","operator":"engine.testnet"}]}"#
        );
        let line = logged(OperatorSet {
            desk_id: "alpha",
            operator: None,
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"operator_set","data":[{"desk_id":"alpha","operator":null}]}"#
        );
    }

    #[test]
    fn paused_json() {
        let by = account("engine.testnet");
        let line = logged(Paused {
            desk_id: "alpha",
            paused: true,
            by: &by,
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"paused","data":[{"desk_id":"alpha","paused":true,"by":"engine.testnet"}]}"#
        );
        let by = account("owner.testnet");
        let line = logged(Paused {
            desk_id: "alpha",
            paused: false,
            by: &by,
        });
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"paused","data":[{"desk_id":"alpha","paused":false,"by":"owner.testnet"}]}"#
        );
    }
}
