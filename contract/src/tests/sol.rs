//! The Solana action methods on the mocked chain: every message of `core/tests/vectors/solana.json`
//! and `solana-review.json` through `sol_sign` and of `solana-onboarding.json` through
//! `sol_sign_register`, the request they hand the MPC, and every guard on the way.

use super::*;
use crate::action::UnsignedAction;
use crate::sol::{sha256, MESSAGE_B64_MAX_LEN};
use gimbal_core::errors::{E_NO_DESK, E_ORACLE_STALE, E_SOL_MESSAGE};
use gimbal_core::phoenix::{check_message, check_registration};
use gimbal_core::solana::SolDesk;
use gimbal_core::Refusal;
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::base64::Engine as _;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/solana.json")).unwrap()
}

fn review() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/solana-review.json")).unwrap()
}

fn onboarding() -> Value {
    serde_json::from_str(include_str!(
        "../../core/tests/vectors/solana-onboarding.json"
    ))
    .unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap()
}

/// The vectors' desk: authority `Gma…EGB` and the accounts it derives.
pub(super) fn vector_solana() -> SolanaAccounts {
    serde_json::from_value(vectors()["desk"].clone()).unwrap()
}

/// The vectors' policy: ETH, SOL and BTC on Phoenix, 100 USD a leg, a 2% band.
fn sol_policy() -> Policy {
    let ctx = &vectors()["ctx"]["sol_sign"];
    Policy {
        phoenix_markets: ctx["markets"]
            .as_object()
            .unwrap()
            .values()
            .map(|m| PhoenixMarket {
                symbol: m["symbol"].as_str().unwrap().into(),
                orderbook: m["orderbook"].as_str().unwrap().into(),
                base_lot_e8: num(&m["base_lot_e8"]),
                tick_e8: num(&m["tick_usd_e8"]),
            })
            .collect(),
        max_notional_usd: num(&ctx["max_notional_usd"]),
        price_band_bps: 200,
        oracle_max_age_s: 300,
        ..policy()
    }
}

/// A testnet contract with desk `alpha` of `owner()` on the vectors' Solana authority, operator
/// `operator()`, written straight into the map (no MPC answer gives that authority).
fn sol_desk_with(policy: Policy) -> Gimbal {
    let mut g = testnet();
    let mut desk = Desk::new(owner(), policy, EVM.into(), vector_solana(), "woofi_dex");
    desk.operator = Some(operator());
    g.desks.insert("alpha".into(), desk);
    g
}

fn sol_desk() -> Gimbal {
    sol_desk_with(sol_policy())
}

fn cases(doc: &Value) -> Vec<Value> {
    doc["cases"].as_array().unwrap().clone()
}

fn case(doc: &Value, prefix: &str) -> Value {
    cases(doc)
        .into_iter()
        .find(|c| c["name"].as_str().unwrap().starts_with(prefix))
        .unwrap_or_else(|| panic!("no case {prefix:?}"))
}

fn bytes_of(c: &Value) -> Vec<u8> {
    hex::decode(c["message_hex"].as_str().unwrap()).unwrap()
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// The desk's accounts as the core derives them, with the host's sha256.
fn derived() -> SolDesk {
    called_by(operator());
    SolDesk::derive(sha256, vector_solana().check().unwrap().authority).unwrap()
}

/// What `f` returns, or the text it panicked with: the mock wraps `env::panic_str` as
/// `… GuestPanic { panic_msg: "<text, Debug-escaped>" }…`, unwrapped here.
pub(super) fn outcome<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    let mut got = None;
    match catch_unwind(AssertUnwindSafe(|| got = Some(f()))) {
        Ok(()) => Ok(got.unwrap()),
        Err(payload) => {
            let text = payload
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_default();
            let start = text.find("panic_msg: \"").map(|i| i + 12).unwrap_or(0);
            let end = text
                .rfind("\" }")
                .filter(|&e| e >= start)
                .unwrap_or(text.len());
            Err(text[start..end].replace("\\\"", "\"").replace("\\\\", "\\"))
        }
    }
}

/// `sol_sign` by the operator.
fn sol_sign(g: &mut Gimbal, bytes: &[u8]) -> Result<UnsignedAction, String> {
    called_by(operator());
    outcome(|| g.prepare_sol_sign("alpha".into(), b64(bytes), "vector".into()))
}

/// `sol_sign_register` by the operator.
fn sol_sign_register(g: &mut Gimbal, bytes: &[u8]) -> Result<UnsignedAction, String> {
    called_by(operator());
    outcome(|| g.prepare_sol_sign_register("alpha".into(), b64(bytes)))
}

/// `got` signs `bytes` with the desk's Solana key and carries them as `message_b64`.
fn assert_signs(got: &UnsignedAction, kind: &str, bytes: &[u8], reason: Option<&str>) {
    assert_eq!(
        (got.desk_id.as_str(), got.venue.as_str(), got.kind.as_str()),
        ("alpha", "phoenix", kind)
    );
    assert_eq!(
        serde_json::to_value(&got.payload).unwrap(),
        json!({ "message_b64": b64(bytes) })
    );
    assert_eq!(
        serde_json::to_value(&got.sign_request).unwrap(),
        json!({
            "path": "gimbal/alpha/sol",
            "payload_v2": { "Eddsa": hex::encode(bytes) },
            "domain_id": 1,
        })
    );
    assert_eq!(
        got.reason_sha256,
        reason.map(|r| hex::encode(env::sha256_array(r)))
    );
}

fn core_refusal(r: &Refusal) -> String {
    r.to_string()
}

// --- sol_sign ---

/// The contract gives every vector message the core's answer without prices (the contract stores
/// none until C6): each pass signs, and each refusal is the core's refusal, code and text.
#[test]
fn sol_sign_answers_every_vector_message_as_the_core_does_without_prices() {
    let mut g = sol_desk();
    let policy = sol_policy();
    let accounts = derived();
    let (mut signed, mut stale, mut refused) = (0, 0, 0);
    for c in cases(&vectors()) {
        let bytes = bytes_of(&c);
        let want = check_message(sha256, &policy, &accounts, &bytes, &|_| None, None);
        let got = sol_sign(&mut g, &bytes);
        let name = c["name"].as_str().unwrap();
        match (&want, &got) {
            (Ok(w), Ok(got)) => {
                assert_signs(got, w.kind, &bytes, Some("vector"));
                signed += 1;
            }
            (Err(w), Err(got)) => {
                assert_eq!(got, &core_refusal(w), "{name}");
                if w.code == E_ORACLE_STALE {
                    stale += 1;
                }
                refused += 1;
            }
            _ => panic!("{name}: the core says {want:?}, the contract {got:?}"),
        }
        if c["method"] == "sol_sign_rescue" {
            assert!(
                got.is_err(),
                "{name}: a rescue signs only through sol_sign_rescue"
            );
        }
    }
    // 13 messages pass the vectors' policy with prices: 6 of them place priced orders and now
    // stop at the missing price, like the 3 the band or the cap refuses, 2 are rescues, and the
    // review refuses the lone Approve (an allowance with no unwrap to spend it) and the
    // withdrawal (an unwrap of an Approve with no Revoke after it).
    assert_eq!((signed, stale, refused), (3, 9, 50));
}

/// Every review case gets the core's answer too; each one the vectors refuse is refused with the
/// code they name.
#[test]
fn sol_sign_answers_every_review_message_as_the_core_does() {
    let mut g = sol_desk();
    let policy = sol_policy();
    let accounts = derived();
    let mut refused = 0;
    for c in cases(&review()) {
        let bytes = bytes_of(&c);
        let want = check_message(sha256, &policy, &accounts, &bytes, &|_| None, None);
        let got = sol_sign(&mut g, &bytes);
        let name = c["name"].as_str().unwrap();
        match (&want, &got) {
            (Ok(w), Ok(got)) => assert_signs(got, w.kind, &bytes, Some("vector")),
            (Err(w), Err(got)) => {
                assert_eq!(got, &core_refusal(w), "{name}");
                if c["expect"]["ok"] == false {
                    assert_eq!(c["expect"]["code"], w.code, "{name}");
                    refused += 1;
                }
            }
            _ => panic!("{name}: the core says {want:?}, the contract {got:?}"),
        }
    }
    assert!(refused >= 21, "{refused}");
}

#[test]
fn sol_sign_returns_the_message_for_the_desk_key() {
    let mut g = sol_desk();
    let deposit = bytes_of(&case(&vectors(), "deposit 15 USDC"));
    called_by(operator());
    let got = g.prepare_sol_sign("alpha".into(), b64(&deposit), "fund Phoenix".into());
    assert_signs(&got, "deposit", &deposit, Some("fund Phoenix"));
    let json = serde_json::to_string(&got).unwrap();
    assert_eq!(
        json,
        format!(
            r#"{{"desk_id":"alpha","venue":"phoenix","kind":"deposit","payload":{{"message_b64":"{}"}},"sign_request":{{"path":"gimbal/alpha/sol","payload_v2":{{"Eddsa":"{}"}},"domain_id":1}},"reason_sha256":"{}","orders":[],"amount":null}}"#,
            b64(&deposit),
            hex::encode(&deposit),
            hex::encode(env::sha256_array("fund Phoenix"))
        )
    );
    assert_eq!(serde_json::from_str::<UnsignedAction>(&json).unwrap(), got);
}

/// An order on a market the owner listed as unpriced signs without an oracle price, under its
/// own caps.
#[test]
fn sol_sign_signs_an_unpriced_order() {
    let mut p = sol_policy();
    p.unpriced = vec![UnpricedAsset {
        symbol: "ETH".into(),
        max_sz: "0.005".into(),
    }];
    p.unpriced_max_notional_usd = 50;
    let mut g = sol_desk_with(p);
    let buy = bytes_of(&case(&vectors(), "IOC buy 0.005 ETH, limit 2474.5"));
    let got = sol_sign(&mut g, &buy).unwrap();
    assert_signs(&got, "order", &buy, Some("vector"));
    let over = bytes_of(&case(&vectors(), "IOC sell 0.04 ETH at the cap"));
    assert!(sol_sign(&mut g, &over)
        .unwrap_err()
        .starts_with("E_SIZE: instruction 2: ETH size 0.04 is over its max_sz 0.005"));
}

/// A paused desk signs a message only if, besides the compute budget, it cancels, places
/// reduce-only orders, revokes a delegate of a desk token account or moves tokens into one, and
/// pays a priority fee only to cancel or reduce; every other message that passes the policy waits
/// for a running desk.
#[test]
fn a_paused_desk_signs_only_what_reduces_risk() {
    let mut p = sol_policy();
    p.unpriced = vec![UnpricedAsset {
        symbol: "ETH".into(),
        max_sz: "0.005".into(),
    }];
    p.unpriced_max_notional_usd = 50;
    let accounts = derived();
    let mut g = sol_desk_with(p.clone());
    g.desks.get_mut("alpha").unwrap().paused = true;
    let paused = "E_PAUSED: desk alpha is paused";
    let mut answers = vec![];
    for c in cases(&vectors()).into_iter().chain(cases(&review())) {
        let bytes = bytes_of(&c);
        let Ok(want) = check_message(sha256, &p, &accounts, &bytes, &|_| None, None) else {
            continue;
        };
        let got = sol_sign(&mut g, &bytes);
        let name = c["name"].as_str().unwrap().to_owned();
        if want.reduces_risk {
            assert_eq!(got.unwrap().kind, want.kind, "{name}");
        } else {
            assert!(got.unwrap_err().starts_with(paused), "{name}");
        }
        answers.push((name, want.reduces_risk));
    }
    let signs = |prefix: &str| {
        answers
            .iter()
            .find(|(n, _)| n.starts_with(prefix))
            .unwrap_or_else(|| panic!("{prefix}"))
            .1
    };
    for prefix in [
        "cancel all ETH",
        "compute budget at the caps",
        "review 3: a reduce-only IOC sell",
        "review 5: lone Revoke of the desk PhUSD account without a priority fee",
        "review 5: lone Revoke of the desk PhUSD account at a unit price of 0",
        "review 5: a Transfer into the desk PhUSD account without a priority fee",
        "review 5: a TransferChecked into the desk PhUSD account without a priority fee",
    ] {
        assert!(signs(prefix), "{prefix}");
    }
    for prefix in [
        "deposit 15 USDC",
        "review 6: withdraw 10 USDC with a Revoke of the desk PhUSD account after the unwrap",
        "review 2: lone Revoke of the desk PhUSD account",
        "review 3: a Transfer into the desk PhUSD account",
        "review 5: lone Revoke of the desk PhUSD account at the budget caps",
        "IOC sell 0.005 ETH, limit 2425.5",
        "review 3: cancel_all, then an IOC sell that is not reduce-only",
        "review 3: the desk PhUSD account created, nothing else",
        "review 3: an Ember wrap alone",
        "review 3: an Approve and its unwrap without the Phoenix withdrawal",
    ] {
        assert!(!signs(prefix), "{prefix}");
    }
    // The message is checked first: a bad one is its own refusal, paused or not.
    let attack = bytes_of(&case(&vectors(), "attack: memo program"));
    assert!(sol_sign(&mut g, &attack)
        .unwrap_err()
        .starts_with("E_SOL_PROGRAM: "));
}

#[test]
fn sol_sign_is_for_the_owner_and_the_operator() {
    let mut g = sol_desk();
    let deposit = bytes_of(&case(&vectors(), "deposit 15 USDC"));
    called_by(owner());
    g.prepare_sol_sign("alpha".into(), b64(&deposit), String::new());
    called_by(stranger());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.prepare_sol_sign("alpha".into(), b64(&deposit), String::new());
    });
    called_by(operator());
    assert_refused(&format!("{E_NO_DESK}: "), || {
        g.prepare_sol_sign("bravo".into(), b64(&deposit), String::new());
    });
    assert_refused("E_ARGS: reason has 281 characters", || {
        g.prepare_sol_sign("alpha".into(), b64(&deposit), "x".repeat(281));
    });
}

#[test]
fn message_b64_is_standard_padded_base64_of_a_transaction_size() {
    let mut g = sol_desk();
    let deposit = bytes_of(&case(&vectors(), "deposit 15 USDC"));
    let good = b64(&deposit);
    called_by(operator());
    for bad in [
        good.trim_end_matches('=').to_owned(),
        good.replace('+', "-").replace('/', "_") + "!",
        format!(" {good}"),
    ] {
        if bad == good {
            continue;
        }
        assert_refused(
            "E_ARGS: message_b64 is not standard base64 with padding",
            || {
                g.prepare_sol_sign("alpha".into(), bad.clone(), String::new());
            },
        );
    }
    let long = "A".repeat(MESSAGE_B64_MAX_LEN + 4);
    assert_refused(
        &format!("{E_SOL_MESSAGE}: message_b64 has {} characters", long.len()),
        || {
            g.prepare_sol_sign("alpha".into(), long.clone(), String::new());
        },
    );
    // The longest one decoded is still checked against the transaction size by the core.
    let max = "A".repeat(MESSAGE_B64_MAX_LEN);
    assert_refused(&format!("{E_SOL_MESSAGE}: "), || {
        g.prepare_sol_sign("alpha".into(), max.clone(), String::new());
    });
}

/// The stored `solana` fields are what `create_desk` checked; the method derives the accounts
/// again from the authority and never reads them.
#[test]
fn sol_sign_derives_the_accounts_instead_of_reading_them() {
    let mut g = sol_desk();
    let desk = g.desks.get_mut("alpha").unwrap();
    desk.solana.usdc_ata = stranger_solana().usdc_ata;
    desk.solana.phoenix_trader = stranger_solana().phoenix_trader;
    let deposit = bytes_of(&case(&vectors(), "deposit 15 USDC"));
    assert_eq!(sol_sign(&mut g, &deposit).unwrap().kind, "deposit");
}

// --- sol_sign_register ---

/// Every onboarding case gets the core's answer for the type its format stands for: both golden
/// messages and their variants sign, every attack is refused with the core's refusal.
#[test]
fn sol_sign_register_answers_every_onboarding_message_as_the_core_does() {
    let mut g = sol_desk();
    let accounts = derived();
    let doc = onboarding();
    assert_eq!(doc["ctx"]["desk"]["authority"], vector_solana().authority);
    let mut kinds = vec![];
    for c in cases(&doc) {
        let bytes = bytes_of(&c);
        let want = check_registration(&accounts.authority, &accounts.trader, &bytes);
        let got = sol_sign_register(&mut g, &bytes);
        let name = c["name"].as_str().unwrap();
        match (&want, &got) {
            (Ok(w), Ok(got)) => {
                assert_signs(got, w.kind(), &bytes, None);
                kinds.push(got.kind.clone());
            }
            (Err(w), Err(got)) => assert_eq!(got, &core_refusal(w), "{name}"),
            _ => panic!("{name}: the core says {want:?}, the contract {got:?}"),
        }
        if c["expect"]["ok"] == true {
            assert!(got.is_ok(), "{name}");
        }
    }
    // The 5 messages that pass, and the 2 that offer one valid type's message as the other.
    kinds.sort();
    assert_eq!(
        kinds,
        ["referral_activate"; 4]
            .into_iter()
            .chain(["register"; 3])
            .collect::<Vec<_>>()
    );
}

#[test]
fn sol_sign_register_signs_the_golden_messages() {
    let mut g = sol_desk();
    let doc = onboarding();
    for kind in ["register", "referral_activate"] {
        let b64 = doc["messages"][kind]["message_b64"].as_str().unwrap();
        called_by(operator());
        let got = g.prepare_sol_sign_register("alpha".into(), b64.into());
        assert_signs(&got, kind, &STANDARD.decode(b64).unwrap(), None);
    }
}

#[test]
fn sol_sign_register_needs_a_running_desk() {
    let mut g = sol_desk();
    let register = onboarding()["messages"]["register"]["message_b64"]
        .as_str()
        .unwrap()
        .to_owned();
    g.desks.get_mut("alpha").unwrap().paused = true;
    called_by(operator());
    assert_refused("E_PAUSED: desk alpha is paused", || {
        g.prepare_sol_sign_register("alpha".into(), register.clone());
    });
    called_by(stranger());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.prepare_sol_sign_register("alpha".into(), register.clone());
    });
}

/// A registration message signs only for its own desk: the testnet desk derives another trader
/// account, and its authority is not the fee payer.
#[test]
fn an_onboarding_message_signs_for_its_own_desk_only() {
    let mut g = with_desk();
    let register = onboarding()["messages"]["register"]["message_b64"]
        .as_str()
        .unwrap()
        .to_owned();
    called_by(operator());
    assert_refused(
        &format!("{E_SOL_MESSAGE}: the fee payer (keys[0]) is "),
        || {
            g.prepare_sol_sign_register("alpha".into(), register.clone());
        },
    );
}

#[test]
fn sol_methods_refuse_unknown_arguments_and_take_no_deposit() {
    let source = include_str!("../sol.rs");
    for method in ["sol_sign", "sol_sign_register"] {
        let attributes = attributes_of(source, method);
        assert!(
            attributes.contains(&"#[deny_unknown_arguments]"),
            "{method}: {attributes:?}"
        );
        assert!(
            !attributes.contains(&"#[payable]"),
            "{method}: {attributes:?}"
        );
    }
}
