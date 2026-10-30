//! NEP-297 events (docs/interfaces.md §1.6):
//! `EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"<name>","data":[{…}]}`.

use near_sdk::env;
use near_sdk::serde::Serialize;
use near_sdk::serde_json;

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

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;
    use near_sdk::test_utils::get_logs;

    #[derive(Serialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Paused {
        desk_id: &'static str,
        paused: bool,
        by: &'static str,
    }

    #[test]
    fn envelope_matches_the_interface() {
        let line = event_json(
            PAUSED,
            &[Paused {
                desk_id: "alpha",
                paused: true,
                by: "owner.testnet",
            }],
        );
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"paused","data":[{"desk_id":"alpha","paused":true,"by":"owner.testnet"}]}"#
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
}
