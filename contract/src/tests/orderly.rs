//! The Orderly action methods on the mocked chain: the bytes they hand the MPC are the cases of
//! `core/tests/vectors/orderly.json` (testnet rows, as these tests run a testnet contract), the
//! vector signatures pass `on_signed`, and every guard and refusal on the way.

use super::hl::{at, VECTOR_DESK_EVM};
use super::sol::{outcome, vector_solana};
use super::*;
use crate::action::{Pending, UnsignedAction};
use crate::orderly::orderly_account_id;
use gimbal_core::decimal::format_e8;
use gimbal_core::errors::{E_ASSET, E_DECIMAL, E_NO_DESK, E_SIZE};
use gimbal_core::orderly::OrderlyRequest;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/orderly.json")).unwrap()
}

fn eip712_case(name: &str) -> Value {
    vectors()["eip712"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no EIP-712 case {name:?}"))
        .clone()
}

fn request_case(name: &str) -> Value {
    vectors()["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no request case {name:?}"))
        .clone()
}

fn u(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap()
}

/// The vector symbols, unpriced (these tests store no prices), up to 10 units and 1000 USD.
fn orderly_policy() -> Policy {
    let unpriced = |s: &str| UnpricedAsset {
        symbol: s.into(),
        max_sz: "10".into(),
    };
    Policy {
        orderly_symbols: vec![
            "PERP_ETH_USDC".into(),
            "PERP_SOL_USDC".into(),
            "PERP_BTC_USDC".into(),
        ],
        max_notional_usd: 1000,
        unpriced: vec![unpriced("ETH"), unpriced("SOL"), unpriced("BTC")],
        unpriced_max_notional_usd: 1000,
        ..policy()
    }
}

/// A testnet contract (broker `woofi_dex`, Orderly referral code `code`) with desk `alpha` of
/// `owner()` on the vectors' keys, operator `operator()`, written straight into the map.
fn orderly_desk_with(code: Option<&str>) -> Gimbal {
    called_by(contract_id());
    let mut t = treasury();
    t.referral_codes.orderly = code.map(Into::into);
    let mut g = Gimbal::new(
        Network::Testnet,
        mpc_id(),
        PriceSource::Mock,
        t,
        fees(),
        OrderlyConfig {
            broker_id: "woofi_dex".into(),
            chain_id: ARBITRUM_SEPOLIA,
        },
    );
    let mut desk = Desk::new(
        owner(),
        orderly_policy(),
        VECTOR_DESK_EVM.into(),
        vector_solana(),
        "woofi_dex",
    );
    desk.operator = Some(operator());
    g.desks.insert("alpha".into(), desk);
    g
}

fn orderly_desk() -> Gimbal {
    orderly_desk_with(None)
}

/// `got` asks the desk's EVM key to sign `digest` and carries `{message, userAddress}` of the
/// case's POST body.
fn assert_signs_eip712(got: &UnsignedAction, case: &Value) {
    assert_eq!(got.desk_id, "alpha");
    assert_eq!(
        (got.venue.as_str(), got.kind.as_str()),
        ("orderly", case["primary_type"].as_str().unwrap())
    );
    let post = &case["post_body"];
    assert_eq!(
        serde_json::to_value(&got.payload).unwrap(),
        json!({ "message": post["message"], "userAddress": post["userAddress"] })
    );
    assert_eq!(
        serde_json::to_value(&got.sign_request).unwrap(),
        json!({
            "path": "gimbal/alpha/evm",
            "payload_v2": { "Ecdsa": case["digest"].as_str().unwrap().strip_prefix("0x").unwrap() },
            "domain_id": 0,
        })
    );
    assert_eq!(got.reason_sha256, None);
}

/// `got` asks the desk's Ed25519 key to sign the case's message and carries the REST payload.
fn assert_signs_rest(got: &UnsignedAction, r: &Value) {
    assert_eq!(got.desk_id, "alpha");
    assert_eq!(
        (got.venue.as_str(), got.kind.as_str()),
        ("orderly", r["kind"].as_str().unwrap())
    );
    assert_eq!(
        serde_json::to_value(&got.payload).unwrap(),
        json!({
            "method": r["method"], "path": r["path"], "body": r["body"],
            "timestamp": r["timestamp"], "message": r["message"],
        })
    );
    assert_eq!(
        serde_json::to_value(&got.sign_request).unwrap(),
        json!({
            "path": "gimbal/alpha/sol",
            "payload_v2": { "Eddsa": hex::encode(r["message"].as_str().unwrap()) },
            "domain_id": 1,
        })
    );
}

/// The `OrderlyRequest` of a request vector: its `request`, or for the money path the fields of
/// its EIP-712 case.
fn request_of(r: &Value) -> OrderlyRequest {
    let mut req = r
        .get("request")
        .cloned()
        .unwrap_or_else(|| json!({ "kind": r["kind"] }));
    req["timestamp_ms"] = r["timestamp"].clone();
    if let Some(name) = r.get("eip712_case") {
        let case = eip712_case(name.as_str().unwrap());
        let m = &case["message_typed"];
        req["signed_at_ms"] = json!(u(&m["timestamp"]));
        req["eip712_signature"] = case["signature"]["hex"].clone();
        if r["kind"] == "settle_pnl" {
            req["nonce"] = json!(u(&m["settleNonce"]));
        } else {
            req["nonce"] = json!(u(&m["withdrawNonce"]));
            req["amount"] = json!(format_e8(u128::from(u(&m["amount"])) * 100));
        }
    }
    serde_json::from_value(req).unwrap()
}

/// One method call on a test contract, for tables of calls.
type Call = Box<dyn FnOnce(&mut Gimbal) -> UnsignedAction>;
/// One method call on a desk of a test contract.
type DeskCall = Box<dyn Fn(&mut Gimbal, &str) -> UnsignedAction>;

/// `orderly_request` by `who` at the request's own timestamp.
fn request(g: &mut Gimbal, who: AccountId, req: OrderlyRequest) -> Result<UnsignedAction, String> {
    at(who, req.timestamp_ms, yocto(0));
    outcome(|| g.prepare_orderly_request("alpha".into(), req, "vector".into()))
}

// --- the account id ---

#[test]
fn the_desk_stores_its_orderly_account_id() {
    let v = vectors();
    let want = &v["account_ids"][0];
    assert_eq!(want["broker_id"], "woofi_dex");
    let g = orderly_desk();
    assert_eq!(
        g.get_desk("alpha".into()).unwrap().orderly_account_id,
        want["account_id"].as_str().unwrap()
    );
    // create_desk stores the id of the desk's address under the configured broker.
    let g = with_desk();
    let desk = g.get_desk("alpha".into()).unwrap();
    assert_eq!(
        desk.orderly_account_id,
        orderly_account_id(EVM, "woofi_dex")
    );
    assert_eq!(desk.orderly_account_id.len(), 66);
    assert_ne!(
        orderly_account_id(EVM, "woofi_dex"),
        orderly_account_id(EVM, "example_broker")
    );
}

// --- the EIP-712 methods ---

#[test]
fn orderly_register_signs_the_vector() {
    let mut g = orderly_desk();
    let c = eip712_case("Registration (testnet)");
    let m = &c["message_typed"];
    at(operator(), u(&m["timestamp"]), yocto(0));
    let got = g.prepare_orderly_register(
        "alpha".into(),
        m["registrationNonce"].as_str().unwrap().into(),
    );
    assert_signs_eip712(&got, &c);
    assert!(got.orders.is_empty() && got.amount.is_none());
}

#[test]
fn orderly_add_key_signs_the_desks_own_key() {
    let mut g = orderly_desk();
    for name in [
        "AddOrderlyKey 30 days (testnet)",
        "AddOrderlyKey 365 days, the maximum (testnet)",
    ] {
        let c = eip712_case(name);
        let m = &c["message_typed"];
        assert_eq!(m["orderlyKey"], vectors()["keys"]["orderly_key"]);
        at(owner(), u(&m["timestamp"]), yocto(0));
        let got = g.prepare_orderly_add_key("alpha".into(), u(&m["expiration"]));
        assert_signs_eip712(&got, &c);
    }
}

#[test]
fn orderly_settle_pnl_signs_the_vector() {
    let mut g = orderly_desk();
    let c = eip712_case("SettlePnl nonce 1 (testnet)");
    let m = &c["message_typed"];
    at(operator(), u(&m["timestamp"]), yocto(0));
    let got = g.prepare_orderly_settle_pnl("alpha".into(), u(&m["settleNonce"]));
    assert_signs_eip712(&got, &c);
}

#[test]
fn orderly_withdraw_signs_the_vectors_to_the_desk_address() {
    let mut g = orderly_desk();
    for (name, amount) in [
        ("Withdraw 5 USDC to the desk address (testnet)", "5"),
        ("Withdraw 1234.56789 USDC, nonce 42 (testnet)", "1234.56789"),
    ] {
        let c = eip712_case(name);
        let m = &c["message_typed"];
        assert_eq!(m["receiver"], vectors()["keys"]["deskEvm"]["address"]);
        at(operator(), u(&m["timestamp"]), yocto(0));
        let got = g.prepare_orderly_withdraw("alpha".into(), amount.into(), u(&m["withdrawNonce"]));
        assert_signs_eip712(&got, &c);
        assert_eq!(got.amount.as_deref(), Some(amount));
    }
}

#[test]
fn the_eip712_methods_refuse_bad_arguments() {
    let mut g = orderly_desk();
    let t = 1_793_491_200_000;
    let year = 365 * 86_400_000;
    let cases: Vec<(&str, Call, &str)> = vec![
        (
            "a nonce with a leading zero",
            Box::new(|g| g.prepare_orderly_register("alpha".into(), "0123".into())),
            "E_ARGS: registration_nonce \"0123\"",
        ),
        (
            "a nonce over 64 bits",
            Box::new(|g| g.prepare_orderly_register("alpha".into(), "18446744073709551616".into())),
            "E_ARGS: registration_nonce",
        ),
        (
            "a key expiring now",
            Box::new(move |g| g.prepare_orderly_add_key("alpha".into(), t)),
            "E_ARGS: expiration_ms",
        ),
        (
            "a key for a year and 1 ms",
            Box::new(move |g| g.prepare_orderly_add_key("alpha".into(), t + year + 1)),
            "E_ARGS: expiration_ms",
        ),
        (
            "a withdrawal of 0",
            Box::new(|g| g.prepare_orderly_withdraw("alpha".into(), "0".into(), 1)),
            E_SIZE,
        ),
        (
            "7 decimals",
            Box::new(|g| g.prepare_orderly_withdraw("alpha".into(), "1.0000001".into(), 1)),
            E_DECIMAL,
        ),
        (
            "raw units",
            Box::new(|g| g.prepare_orderly_withdraw("alpha".into(), "5000000.0".into(), 1)),
            E_DECIMAL,
        ),
    ];
    for (name, f, expected) in cases {
        at(operator(), t, yocto(0));
        let msg = outcome(|| f(&mut g)).expect_err(name);
        assert!(msg.starts_with(expected), "{name}: {msg}");
    }
    // A year exactly is allowed.
    at(operator(), t, yocto(0));
    g.prepare_orderly_add_key("alpha".into(), t + year);
}

// --- orderly_request and orderly_ws_auth ---

#[test]
fn orderly_request_signs_every_testnet_vector() {
    let mut g = orderly_desk_with(Some("TESTCODE"));
    let mut signed = 0;
    for r in vectors()["requests"].as_array().unwrap() {
        if r["network"] != "testnet" {
            continue;
        }
        let name = r["name"].as_str().unwrap();
        let req = request_of(r);
        // An order's vector body carries the client_order_id of its request_id.
        g.next_request_id = r["request_id"].as_u64().unwrap_or(0);
        let got = request(&mut g, operator(), req.clone());
        if req.order_type.as_deref() == Some("MARKET") {
            assert!(
                got.unwrap_err().starts_with("E_PRICE_BAND: a MARKET order"),
                "{name}"
            );
            continue;
        }
        let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_signs_rest(&got, r);
        assert_eq!(
            got.reason_sha256,
            Some(hex::encode(env::sha256_array("vector"))),
            "{name}"
        );
        if req.kind == "order" {
            let o = &got.orders[..];
            assert_eq!(o.len(), 1, "{name}");
            assert_eq!(o[0].asset, req.symbol.clone().unwrap());
            assert_eq!(o[0].side, req.side.clone().unwrap().to_lowercase());
            assert_eq!(o[0].px, req.price.clone().unwrap());
            assert_eq!(o[0].size, req.quantity.clone().unwrap());
            assert_eq!((o[0].oracle_px.as_deref(), o[0].unpriced), (None, true));
        } else {
            assert!(got.orders.is_empty(), "{name}");
        }
        let amount = (req.kind == "withdraw_request").then(|| req.amount.clone().unwrap());
        assert_eq!(got.amount, amount, "{name}");
        signed += 1;
    }
    assert_eq!(signed, 15, "every testnet request but the MARKET order");
}

#[test]
fn referral_bind_signs_only_the_configured_code() {
    let r = request_case("referral_bind (testnet)");
    let mut g = orderly_desk();
    let msg = request(&mut g, operator(), request_of(&r)).unwrap_err();
    assert!(
        msg.starts_with("E_ARGS: no Orderly referral code is configured"),
        "{msg}"
    );
    let mut g = orderly_desk_with(Some("A\"B"));
    let got = request(&mut g, operator(), request_of(&r)).unwrap();
    assert_eq!(
        got.payload.get("body"),
        Some(&gimbal_core::msgpack::Value::str(
            r#"{"referral_code":"A\"B"}"#
        ))
    );
}

#[test]
fn a_money_path_body_carries_only_the_desks_signature() {
    let mut g = orderly_desk();
    let r = request_case("settle_pnl POST (testnet)");
    // The mainnet case's signature is of another digest: it recovers to some other address.
    let mainnet = eip712_case("SettlePnl nonce 1 (mainnet)");
    let mut req = request_of(&r);
    req.eip712_signature = Some(mainnet["signature"]["hex"].as_str().unwrap().into());
    let msg = request(&mut g, operator(), req).unwrap_err();
    assert!(msg.starts_with("E_ARGS: eip712_signature is 0x"), "{msg}");
    assert!(msg.ends_with("'s signature of the message, not the desk's (0x1a642f0e3c3af545e7acbd38b07251b3990914f1)"), "{msg}");
    // The other v: the same r and s, another key.
    let mut req = request_of(&r);
    let sig = req.eip712_signature.clone().unwrap();
    let flipped = if sig.ends_with("1c") { "1b" } else { "1c" };
    req.eip712_signature = Some(format!("{}{flipped}", &sig[..130]));
    let msg = request(&mut g, operator(), req).unwrap_err();
    assert!(msg.starts_with("E_ARGS: eip712_signature "), "{msg}");
    // Another withdrawal amount than the one signed changes the digest.
    let w = request_case("withdraw_request POST (testnet)");
    let mut req = request_of(&w);
    req.amount = Some("6".into());
    let msg = request(&mut g, operator(), req).unwrap_err();
    assert!(msg.starts_with("E_ARGS: eip712_signature is 0x"), "{msg}");
}

#[test]
fn orderly_requests_refuse_what_the_policy_does_not_allow() {
    let mut g = orderly_desk();
    let base = request_of(&request_case("order LIMIT BUY"));
    let with = |f: &dyn Fn(&mut OrderlyRequest)| {
        let mut r = base.clone();
        f(&mut r);
        r
    };
    let cases = [
        (
            "a symbol outside the policy",
            with(&|r| r.symbol = Some("PERP_DOGE_USDC".into())),
            E_ASSET,
        ),
        (
            "over the unpriced max_sz",
            with(&|r| r.quantity = Some("10.00000001".into())),
            E_SIZE,
        ),
        (
            "over the unpriced notional cap",
            with(&|r| r.quantity = Some("1".into())),
            E_SIZE,
        ),
        (
            "a timestamp 301 s old",
            with(&|r| r.timestamp_ms -= 301_000),
            "E_ARGS",
        ),
        (
            "a field of another kind",
            with(&|r| r.order_id = Some(1)),
            "E_ARGS",
        ),
    ];
    for (name, req, code) in cases {
        let block = base.timestamp_ms;
        at(operator(), block, yocto(0));
        let msg =
            outcome(|| g.prepare_orderly_request("alpha".into(), req, "r".into())).expect_err(name);
        assert!(msg.starts_with(code), "{name}: {msg}");
    }
    // The reason is checked as everywhere.
    at(operator(), base.timestamp_ms, yocto(0));
    let msg = outcome(|| g.prepare_orderly_request("alpha".into(), base.clone(), "x".repeat(281)))
        .unwrap_err();
    assert!(msg.starts_with("E_ARGS: reason"), "{msg}");
    // ws_auth outside the window.
    at(operator(), base.timestamp_ms, yocto(0));
    let msg = outcome(|| g.prepare_orderly_ws_auth("alpha".into(), base.timestamp_ms - 300_001))
        .unwrap_err();
    assert!(msg.starts_with("E_ARGS: timestamp "), "{msg}");
}

// --- guards ---

#[test]
fn a_paused_desk_signs_only_orderly_calls_that_reduce_risk() {
    let mut g = orderly_desk_with(Some("TESTCODE"));
    g.desks.get_mut("alpha").unwrap().paused = true;
    for name in [
        "order IOC SELL reduce-only",
        "cancel one order (query string is signed)",
        "cancel all orders of a symbol",
        "receiver_address lookup (testnet)",
        "settle_nonce (testnet)",
        "withdraw_nonce (testnet)",
        "funding_fee_history of one symbol, one day, page 1 of 60 rows (testnet)",
        "positions (testnet)",
        "holding (testnet)",
    ] {
        let req = request_of(&request_case(name));
        request(&mut g, owner(), req.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        request(&mut g, operator(), req).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
    let t = 1_793_491_260_000;
    at(operator(), t, yocto(0));
    g.prepare_orderly_ws_auth("alpha".into(), t);

    for name in [
        "order LIMIT BUY",
        "settle_pnl POST (testnet)",
        "withdraw_request POST (testnet)",
        "referral_bind (testnet)",
    ] {
        let req = request_of(&request_case(name));
        let msg = request(&mut g, operator(), req).unwrap_err();
        assert!(
            msg.starts_with("E_PAUSED: desk alpha is paused"),
            "{name}: {msg}"
        );
    }
    let refused: Vec<(&str, Call)> = vec![
        (
            "orderly_register",
            Box::new(|g| g.prepare_orderly_register("alpha".into(), "1".into())),
        ),
        (
            "orderly_add_key",
            Box::new(move |g| g.prepare_orderly_add_key("alpha".into(), t + 1)),
        ),
        (
            "orderly_settle_pnl",
            Box::new(|g| g.prepare_orderly_settle_pnl("alpha".into(), 1)),
        ),
        (
            "orderly_withdraw",
            Box::new(|g| g.prepare_orderly_withdraw("alpha".into(), "5".into(), 1)),
        ),
    ];
    for (name, f) in refused {
        at(owner(), t, yocto(0));
        let msg = outcome(|| f(&mut g)).unwrap_err();
        assert!(msg.starts_with("E_PAUSED"), "{name}: {msg}");
    }
}

#[test]
fn orderly_methods_are_for_the_owner_and_the_operator() {
    let mut g = orderly_desk();
    let t = 1_793_491_211_000;
    let req = request_of(&request_case("order LIMIT BUY"));
    for who in [owner(), operator()] {
        request(&mut g, who, req.clone()).unwrap();
    }
    let calls: Vec<(&str, DeskCall)> = vec![
        (
            "orderly_request",
            Box::new(move |g, d| g.prepare_orderly_request(d.into(), req.clone(), "r".into())),
        ),
        (
            "orderly_ws_auth",
            Box::new(move |g, d| g.prepare_orderly_ws_auth(d.into(), t)),
        ),
        (
            "orderly_register",
            Box::new(|g, d| g.prepare_orderly_register(d.into(), "1".into())),
        ),
        (
            "orderly_add_key",
            Box::new(move |g, d| g.prepare_orderly_add_key(d.into(), t + 1)),
        ),
        (
            "orderly_settle_pnl",
            Box::new(|g, d| g.prepare_orderly_settle_pnl(d.into(), 1)),
        ),
        (
            "orderly_withdraw",
            Box::new(|g, d| g.prepare_orderly_withdraw(d.into(), "5".into(), 1)),
        ),
    ];
    for (name, f) in &calls {
        at(stranger(), t, yocto(0));
        let msg = outcome(|| f(&mut g, "alpha")).unwrap_err();
        assert!(msg.starts_with("E_NOT_ALLOWED: "), "{name}: {msg}");
        at(owner(), t, yocto(0));
        let msg = outcome(|| f(&mut g, "beta")).unwrap_err();
        assert!(msg.starts_with(E_NO_DESK), "{name}: {msg}");
        at(owner(), t, yocto(0));
        outcome(|| f(&mut g, "alpha")).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

// --- signed ---

#[test]
fn the_vector_signatures_pass_on_signed() {
    let mut g = orderly_desk();
    // Registration: the desk's EVM key, v 28.
    let c = eip712_case("Registration (testnet)");
    let m = &c["message_typed"];
    at(operator(), u(&m["timestamp"]), yocto(0));
    let action = g.prepare_orderly_register(
        "alpha".into(),
        m["registrationNonce"].as_str().unwrap().into(),
    );
    let sig = &c["signature"];
    let v = u(&sig["v"]);
    let answer = json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("{:02x}{}", v - 25, &sig["r"].as_str().unwrap()[2..]) },
        "s": { "scalar": &sig["s"].as_str().unwrap()[2..] },
        "recovery_id": v - 27,
    });
    let pending = Pending {
        request_id: 9,
        signer: VECTOR_DESK_EVM.into(),
        action,
    };
    callback(vec![PromiseResult::Successful(
        serde_json::to_vec(&answer).unwrap(),
    )]);
    let signed = g.on_signed(pending);
    assert_eq!(
        serde_json::to_value(&signed).unwrap(),
        json!({
            "desk_id": "alpha", "request_id": 9, "venue": "orderly", "kind": "Registration",
            "payload": { "message": c["post_body"]["message"], "userAddress": c["post_body"]["userAddress"] },
            "signature": answer,
        })
    );
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            r#"{"desk_id":"alpha","request_id":9,"venue":"orderly","kind":"Registration","reason_sha256":null}"#
        )]
    );

    // An order: the orderly key's signature of the vector message, and the order in the event.
    let r = request_case("order LIMIT BUY");
    g.next_request_id = r["request_id"].as_u64().unwrap();
    let action = request(&mut g, operator(), request_of(&r)).unwrap();
    let answer = json!({
        "scheme": "Ed25519",
        "signature": hex::decode(r["signature_hex"].as_str().unwrap()).unwrap(),
    });
    let pending = Pending {
        request_id: 10,
        signer: vector_solana().authority,
        action,
    };
    callback(vec![PromiseResult::Successful(
        serde_json::to_vec(&answer).unwrap(),
    )]);
    let signed = g.on_signed(pending);
    assert_eq!(signed.kind, "order");
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            &format!(
                r#"{{"desk_id":"alpha","request_id":10,"venue":"orderly","kind":"order","asset":"PERP_ETH_USDC","side":"buy","size":"0.0087","px":"1212.89","oracle_px":null,"unpriced":true,"reason_sha256":"{}"}}"#,
                hex::encode(env::sha256_array("vector"))
            )
        )]
    );

    // A withdrawal names its amount.
    let c = eip712_case("Withdraw 5 USDC to the desk address (testnet)");
    let m = &c["message_typed"];
    at(operator(), u(&m["timestamp"]), yocto(0));
    let action = g.prepare_orderly_withdraw("alpha".into(), "5".into(), u(&m["withdrawNonce"]));
    let sig = &c["signature"];
    let v = u(&sig["v"]);
    let answer = json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("{:02x}{}", v - 25, &sig["r"].as_str().unwrap()[2..]) },
        "s": { "scalar": &sig["s"].as_str().unwrap()[2..] },
        "recovery_id": v - 27,
    });
    callback(vec![PromiseResult::Successful(
        serde_json::to_vec(&answer).unwrap(),
    )]);
    g.on_signed(Pending {
        request_id: 11,
        signer: VECTOR_DESK_EVM.into(),
        action,
    });
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            r#"{"desk_id":"alpha","request_id":11,"venue":"orderly","kind":"Withdraw","amount":"5","reason_sha256":null}"#
        )]
    );
}

// --- the Orderly receiver and the key's IP list ---

const RECEIVER: &str = "0xc48b812bb43401392c037381aca934f4069c0517";

#[test]
fn the_owner_pins_the_orderly_receiver_once() {
    let mut g = orderly_desk();
    for who in [operator(), stranger()] {
        call(who, storage_deposit());
        assert_refused("E_NOT_ALLOWED: ", || {
            g.set_orderly_receiver("alpha".into(), RECEIVER.into())
        });
    }
    called_by(owner());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.set_orderly_receiver("alpha".into(), RECEIVER.into())
    });
    for bad in [
        "0xC48b812bb43401392c037381aca934f4069c0517",
        "c48b812bb43401392c037381aca934f4069c0517",
        "0xc48b812bb43401392c037381aca934f4069c05",
    ] {
        call(owner(), storage_deposit());
        assert_refused("E_ARGS: ", || {
            g.set_orderly_receiver("alpha".into(), bad.into())
        });
    }
    call(owner(), storage_deposit());
    assert_refused(&format!("{E_NO_DESK}: "), || {
        g.set_orderly_receiver("beta".into(), RECEIVER.into())
    });
    assert_eq!(g.get_desk("alpha".into()).unwrap().orderly_receiver, None);

    call(owner(), storage_deposit());
    let before = env::storage_usage();
    g.set_orderly_receiver("alpha".into(), RECEIVER.into());
    assert_eq!(
        kept(storage_deposit()),
        cost_of(env::storage_usage() - before).max(yocto(1))
    );
    assert_eq!(
        get_logs(),
        vec![event(
            "orderly_receiver_set",
            &format!(r#"{{"desk_id":"alpha","receiver":"{RECEIVER}"}}"#)
        )]
    );
    assert_eq!(
        g.get_desk("alpha".into())
            .unwrap()
            .orderly_receiver
            .as_deref(),
        Some(RECEIVER)
    );
    // Pinned for good: not even the same address again, and a pause changes nothing.
    for receiver in [RECEIVER, OTHER_EVM] {
        call(owner(), storage_deposit());
        assert_refused(
            "E_ARGS: desk alpha has its Orderly receiver pinned already",
            || g.set_orderly_receiver("alpha".into(), receiver.into()),
        );
    }
    // Short of its storage, on a fresh chain (the mock keeps what this one wrote).
    std::thread::spawn(|| {
        let mut g = orderly_desk();
        call(owner(), yocto(1));
        assert_refused("E_DEPOSIT: ", || {
            g.set_orderly_receiver("alpha".into(), RECEIVER.into())
        });
    })
    .join()
    .unwrap();
}

#[test]
fn ip_restriction_signs_the_owners_list_and_passes_a_paused_desk() {
    let mut g = orderly_desk();
    let t = 1_793_491_260_000;
    let req = |t: u64| -> OrderlyRequest {
        serde_json::from_value(json!({ "kind": "ip_restriction", "timestamp_ms": t })).unwrap()
    };
    // No list yet: nothing to apply.
    let msg = request(&mut g, operator(), req(t)).unwrap_err();
    assert!(msg.starts_with("E_ARGS: the owner set no IP list"), "{msg}");

    let ips: Vec<String> = vec!["203.0.113.7".into(), "2001:db8::1".into()];
    for who in [operator(), stranger()] {
        call(who, storage_deposit());
        assert_refused("E_NOT_ALLOWED: ", || {
            g.set_orderly_ips("alpha".into(), ips.clone())
        });
    }
    called_by(owner());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.set_orderly_ips("alpha".into(), ips.clone())
    });
    for bad in [
        vec![],
        vec!["203.0.113.7".to_string(), "203.0.113.7".into()],
        vec!["203.0.113.7/32".to_string()],
        (0..11).map(|i| format!("10.0.0.{i}")).collect(),
    ] {
        call(owner(), storage_deposit());
        assert_refused("E_ARGS: ", || g.set_orderly_ips("alpha".into(), bad));
    }
    call(owner(), storage_deposit());
    let before = env::storage_usage();
    g.set_orderly_ips("alpha".into(), ips.clone());
    assert_eq!(
        kept(storage_deposit()),
        cost_of(env::storage_usage() - before).max(yocto(1))
    );
    assert_eq!(
        get_logs(),
        vec![event(
            "orderly_ips_set",
            r#"{"desk_id":"alpha","ips":["203.0.113.7","2001:db8::1"]}"#
        )]
    );

    g.desks.get_mut("alpha").unwrap().paused = true;
    let got = request(&mut g, operator(), req(t)).unwrap();
    let body = r#"{"orderly_key":"ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB","ip_restriction_list":"203.0.113.7,2001:db8::1"}"#;
    let message = format!("{t}POST/v1/client/set_orderly_key_ip_restriction{body}");
    assert_eq!(
        (got.venue.as_str(), got.kind.as_str()),
        ("orderly", "ip_restriction")
    );
    assert_eq!(
        serde_json::to_value(&got.payload).unwrap(),
        json!({
            "method": "POST",
            "path": "/v1/client/set_orderly_key_ip_restriction",
            "body": body,
            "timestamp": t,
            "message": message,
        })
    );
    assert_eq!(
        got.sign_request,
        crate::mpc::SignRequest::sol("alpha", message.as_bytes())
    );

    // A new list replaces the old one; the next request signs it.
    call(owner(), storage_deposit());
    g.set_orderly_ips("alpha".into(), vec!["198.51.100.1".into()]);
    let got = request(&mut g, owner(), req(t + 1)).unwrap();
    assert_eq!(
        serde_json::to_value(&got.payload).unwrap()["body"],
        r#"{"orderly_key":"ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB","ip_restriction_list":"198.51.100.1"}"#
    );
}
