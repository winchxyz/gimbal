//! The MPC signature every action method ends with: the `sign` call it schedules with 1 yoctoNEAR
//! and the gas it needs, and `on_signed`, which checks the answer is the desk's signature of what
//! was asked (`E_MPC` otherwise), emits `signed` and returns the SignedAction.

use super::hl::{at, hl_desk_with, hl_policy, hype, unpriced, VECTOR_DESK_EVM};
use super::sol::{outcome, vector_solana};
use super::*;
use crate::action::{Pending, SignedAction, UnsignedAction};
use crate::mpc::{check_sign_gas, ON_SIGNED_GAS, SIGNATURE_MAX_LEN, SIGN_GAS, SIGN_MIN_GAS};
use gimbal_core::errors::E_MPC;
use gimbal_core::hl::HlOrder;

/// A block time in the vectors' range (ms).
const T: u64 = 1_793_491_200_000;

/// The function calls the last call scheduled: (receiver, method, JSON args, deposit, static gas,
/// weight).
fn scheduled() -> Vec<(AccountId, String, Value, NearToken, Gas, u64)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    gas_weight,
                    ..
                } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap(),
                    attached_deposit,
                    prepaid_gas,
                    gas_weight.0,
                )),
                _ => None,
            })
        })
        .collect()
}

/// The `on_signed` argument the last action call scheduled.
fn pending() -> Pending {
    let calls = scheduled();
    let on_signed = calls
        .iter()
        .find(|c| c.1 == "on_signed")
        .expect("an action schedules on_signed");
    serde_json::from_value(on_signed.2["pending"].clone()).unwrap()
}

/// A call from the operator at `ms` with `gas` prepaid. Receipt fees are left out, as in
/// `call_with_gas`, to see what the contract itself allows.
fn at_with_gas(ms: u64, gas: Gas) {
    let context = VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(operator())
        .signer_account_id(operator())
        .block_timestamp(ms * 1_000_000)
        .prepaid_gas(gas)
        .build();
    testing_env!(
        context,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::free(),
        Default::default(),
        vec![]
    );
}

/// The MPC contract's secp256k1 answer for an Ethereum signature `0x` r ‖ s with v 27/28.
fn secp_answer(r: &str, s: &str, v: u64) -> Value {
    let recovery_id = v - 27;
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("{:02x}{}", 2 + recovery_id, r.trim_start_matches("0x")) },
        "s": { "scalar": s.trim_start_matches("0x") },
        "recovery_id": recovery_id,
    })
}

/// The MPC contract's Ed25519 answer for the 64 bytes of `hex`.
fn ed_answer(hex_sig: &str) -> Value {
    json!({ "scheme": "Ed25519", "signature": hex::decode(hex_sig).unwrap() })
}

/// `on_signed(pending)` with `answer` as the `sign` call's result.
fn run_on_signed(
    g: &Gimbal,
    pending: &Pending,
    answer: PromiseResult,
) -> Result<SignedAction, String> {
    callback(vec![answer]);
    outcome(|| g.on_signed(pending.clone()))
}

fn ok(answer: &Value) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(answer).unwrap())
}

/// The policy of `hl_order_signs_the_vector_bytes`: the vectors' assets unpriced, so they sign
/// before prices are stored.
fn vector_policy() -> Policy {
    let mut p = hl_policy();
    p.unpriced = ["BTC", "ETH", "SOL", "DOGE"]
        .iter()
        .map(|s| unpriced(s, "1000"))
        .collect();
    p.unpriced_max_notional_usd = 1000;
    p
}

/// The first 1 bp order of the Hyperliquid vectors, as `hl_order` takes it, with its nonce and
/// the testnet signature of key 0x01…01.
fn vector_order() -> (HlOrder, u64, Value, Value) {
    let c = super::hl::vectors()["l1"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "order" && c["params"]["builder_fee_tenth_bps"] == 10)
        .unwrap()
        .clone();
    let p = &c["params"];
    let order = serde_json::from_value(json!({
        "asset": p["asset"], "is_buy": p["is_buy"], "px": p["px"], "sz": p["sz"],
        "reduce_only": p["reduce_only"], "tif": p["tif"], "cloid": p["cloid"],
    }))
    .unwrap();
    let signature = c["testnet"]["exchange_body"]["signature"].clone();
    (order, c["nonce"].as_u64().unwrap(), signature, p.clone())
}

#[test]
fn an_action_call_asks_the_mpc_to_sign_then_calls_on_signed() {
    let mut g = hl_desk_with(hl_policy());
    at(operator(), T, yocto(0));
    g.hl_order("alpha".into(), hype(), "first".into()).detach();
    let calls = scheduled();
    assert_eq!(calls.len(), 2, "{calls:?}");
    let (to, method, args, deposit, gas, weight) = &calls[0];
    assert_eq!((to, method.as_str()), (&mpc_id(), "sign"));
    assert_eq!(
        *deposit,
        yocto(1),
        "1 yoctoNEAR from the contract's balance"
    );
    assert_eq!(
        (*gas, *weight),
        (SIGN_GAS, 1),
        "sign gets every unused gas unit"
    );
    let first = pending();
    assert_eq!(
        args,
        &json!({ "request": serde_json::to_value(&first.action.sign_request).unwrap() })
    );
    let (to, method, _, deposit, gas, weight) = &calls[1];
    assert_eq!((to, method.as_str()), (&contract_id(), "on_signed"));
    assert_eq!((*deposit, *gas, *weight), (yocto(0), ON_SIGNED_GAS, 0));
    assert_eq!(first.request_id, 0);
    assert_eq!(first.signer, VECTOR_DESK_EVM);
    assert_eq!(
        (first.action.venue.as_str(), first.action.kind.as_str()),
        ("hyperliquid", "order")
    );
    assert_eq!(first.action.sign_request.path, "gimbal/alpha/evm");

    // The next call gets the next id; a Solana-key action names the desk's authority.
    at(operator(), T + 1, yocto(0));
    g.hl_cancel("alpha".into(), 159, 7, "second".into())
        .detach();
    assert_eq!(pending().request_id, 1);
    at(operator(), T + 2, yocto(0));
    g.orderly_ws_auth("alpha".into(), T + 2).detach();
    let third = pending();
    assert_eq!(third.request_id, 2);
    assert_eq!(third.signer, SOL_AUTHORITY);
    assert_eq!(third.action.sign_request.path, "gimbal/alpha/sol");
    assert_eq!(g.next_request_id, 3);
}

#[test]
fn an_owner_payout_signs_with_the_yocto_it_attached() {
    let mut g = hl_desk_with(hl_policy());
    at(owner(), T, yocto(1));
    g.hl_withdraw("alpha".into(), "10".into()).detach();
    let calls = scheduled();
    assert_eq!((calls[0].1.as_str(), calls[0].3), ("sign", yocto(1)));
    assert_eq!(pending().action.amount.as_deref(), Some("10"));
}

#[test]
fn an_action_call_refuses_less_gas_than_the_signature_needs() {
    assert_eq!(SIGN_MIN_GAS, Gas::from_tgas(85));
    assert!(check_sign_gas(Gas::from_tgas(300)).is_ok());
    let mut g = hl_desk_with(hl_policy());
    for gas in [
        SIGN_MIN_GAS.saturating_sub(Gas::from_gas(1)),
        Gas::from_tgas(30),
    ] {
        at_with_gas(T, gas);
        let r = outcome(|| g.hl_order("alpha".into(), hype(), "short".into()).detach());
        let msg = r.unwrap_err();
        assert!(
            msg.starts_with("E_ARGS: an action call needs at least 85 TGas attached for the MPC signature (300 TGas recommended), not "),
            "{msg}"
        );
        assert!(scheduled().is_empty());
        at_with_gas(T, gas);
        let r = outcome(|| g.orderly_ws_auth("alpha".into(), T).detach());
        assert!(r.unwrap_err().starts_with("E_ARGS: an action call needs"));
    }
    at_with_gas(T, SIGN_MIN_GAS);
    g.hl_order("alpha".into(), hype(), "enough".into()).detach();
    assert_eq!(scheduled().len(), 2);
}

#[test]
fn on_signed_returns_the_signed_hyperliquid_order_and_logs_it() {
    let mut g = hl_desk_with(vector_policy());
    let (order, nonce, sig, p) = vector_order();
    at(operator(), nonce, yocto(0));
    let action = g.prepare_hl_order("alpha".into(), order, "vector order".into());
    let pending = Pending {
        request_id: 41,
        signer: VECTOR_DESK_EVM.into(),
        action: action.clone(),
    };
    let answer = secp_answer(
        sig["r"].as_str().unwrap(),
        sig["s"].as_str().unwrap(),
        sig["v"].as_u64().unwrap(),
    );
    let signed = run_on_signed(&g, &pending, ok(&answer)).unwrap();
    assert_eq!(
        serde_json::to_value(&signed).unwrap(),
        json!({
            "desk_id": "alpha", "request_id": 41, "venue": "hyperliquid", "kind": "order",
            "payload": serde_json::to_value(&action.payload).unwrap(),
            "signature": answer,
        })
    );
    let symbol = ["BTC", "ETH", "SOL", "DOGE"]
        .into_iter()
        .zip([0, 1, 5, 12])
        .find(|(_, i)| p["asset"] == *i)
        .unwrap()
        .0;
    let side = if p["is_buy"] == true { "buy" } else { "sell" };
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            &format!(
                r#"{{"desk_id":"alpha","request_id":41,"venue":"hyperliquid","kind":"order","asset":"{symbol}","side":"{side}","size":"{}","px":"{}","oracle_px":null,"unpriced":true,"reason_sha256":"{}"}}"#,
                p["sz"].as_str().unwrap(),
                p["px"].as_str().unwrap(),
                hex::encode(env::sha256_array("vector order")),
            )
        )]
    );
}

/// The orderly.json WebSocket login, signed by the vectors' Solana key.
fn ws_auth_pending(g: &mut Gimbal) -> (Pending, Value) {
    let v: Value =
        serde_json::from_str(include_str!("../../core/tests/vectors/orderly.json")).unwrap();
    let w = &v["ws_auth"];
    let ts = w["timestamp"].as_u64().unwrap();
    at(operator(), ts, yocto(0));
    let action = g.prepare_orderly_ws_auth("alpha".into(), ts);
    let pending = Pending {
        request_id: 3,
        signer: vector_solana().authority,
        action,
    };
    (pending, ed_answer(w["signature_hex"].as_str().unwrap()))
}

fn sol_vector_desk() -> Gimbal {
    let mut g = testnet();
    let mut desk = Desk::new(
        owner(),
        policy(),
        VECTOR_DESK_EVM.into(),
        vector_solana(),
        "woofi_dex",
    );
    desk.operator = Some(operator());
    g.desks.insert("alpha".into(), desk);
    g
}

#[test]
fn on_signed_checks_an_ed25519_answer_against_the_desk_authority() {
    let mut g = sol_vector_desk();
    let (pending, answer) = ws_auth_pending(&mut g);
    let signed = run_on_signed(&g, &pending, ok(&answer)).unwrap();
    assert_eq!(signed.kind, "ws_auth");
    assert_eq!(signed.venue, "orderly");
    assert_eq!(serde_json::to_value(&signed.signature).unwrap(), answer);
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            r#"{"desk_id":"alpha","request_id":3,"venue":"orderly","kind":"ws_auth","reason_sha256":null}"#
        )]
    );
}

#[test]
fn on_signed_refuses_anything_but_the_desks_signature_of_the_request() {
    let mut g = hl_desk_with(vector_policy());
    let (order, nonce, sig, _) = vector_order();
    at(operator(), nonce, yocto(0));
    let action: UnsignedAction = g.prepare_hl_order("alpha".into(), order, "vector".into());
    let evm = Pending {
        request_id: 1,
        signer: VECTOR_DESK_EVM.into(),
        action,
    };
    let (r, s, v) = (
        sig["r"].as_str().unwrap(),
        sig["s"].as_str().unwrap(),
        sig["v"].as_u64().unwrap(),
    );
    let good = secp_answer(r, s, v);
    let mut sol_desk = sol_vector_desk();
    let (ed, ed_good) = ws_auth_pending(&mut sol_desk);
    let mut flipped = hex::decode(
        ed_good["signature"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| format!("{:02x}", b.as_u64().unwrap()))
            .collect::<String>(),
    )
    .unwrap();
    flipped[10] ^= 1;

    let mut other = evm.clone();
    other.signer = OTHER_EVM.into();
    let mut wrong_v = good.clone();
    wrong_v["recovery_id"] = json!(1 - (v - 27));
    let mut bad_id = good.clone();
    bad_id["recovery_id"] = json!(2);
    let mut bad_point = good.clone();
    bad_point["big_r"]["affine_point"] = json!(format!("04{}", r.trim_start_matches("0x")));
    let mut long_s = good.clone();
    long_s["s"]["scalar"] = json!(format!("00{}", s.trim_start_matches("0x")));
    let mut other_sol = ed.clone();
    other_sol.signer = SOL_AUTHORITY.into();
    let cases: Vec<(&str, &Gimbal, &Pending, PromiseResult, &str)> = vec![
        ("the MPC call failed", &g, &evm, PromiseResult::Failed, "E_MPC: the MPC contract did not return a signature"),
        ("not a signature", &g, &evm, ok(&json!("oops")), "E_MPC: the MPC contract returned no signature, but 6 bytes"),
        ("too long to read", &g, &evm, PromiseResult::Successful(vec![b' '; SIGNATURE_MAX_LEN + 1]), "E_MPC: the MPC contract did not return a signature"),
        ("another address's key", &g, &other, ok(&good), "E_MPC: the MPC signature recovers to 0x1a642f0e3c3af545e7acbd38b07251b3990914f1, not the desk's address 0x8ba1"),
        ("the other recovery id", &g, &evm, ok(&wrong_v), "E_MPC: the MPC signature recovers to 0x"),
        ("recovery id 2", &g, &evm, ok(&bad_id), "E_MPC: the MPC signature has recovery id 2"),
        ("an uncompressed big_r", &g, &evm, ok(&bad_point), "E_MPC: the MPC signature has no compressed point"),
        ("an s of 33 bytes", &g, &evm, ok(&long_s), "E_MPC: the MPC signature has no 32-byte scalar"),
        ("an Ed25519 answer to a secp256k1 request", &g, &evm, ok(&ed_good), "E_MPC: the MPC signature is Ed25519 for a secp256k1 request"),
        ("a secp256k1 answer to an Ed25519 request", &sol_desk, &ed, ok(&good), "E_MPC: the MPC signature is secp256k1 for an Ed25519 request"),
        ("a changed Ed25519 signature", &sol_desk, &ed, ok(&ed_answer(&hex::encode(&flipped))), "E_MPC: the MPC signature does not verify under the desk's key"),
        ("another authority", &sol_desk, &other_sol, ok(&ed_good), "E_MPC: the MPC signature does not verify under the desk's key 31wj7"),
        ("63 bytes", &sol_desk, &ed, ok(&ed_answer(&hex::encode(&flipped[..63]))), "E_MPC: the MPC signature has 63 bytes, not 64"),
    ];
    for (name, g, pending, answer, expected) in cases {
        let r = run_on_signed(g, pending, answer);
        let msg = r.expect_err(name);
        assert!(msg.starts_with(expected), "{name}: {msg}");
        assert!(get_logs().is_empty(), "{name}: nothing is logged");
    }
    // The good answers pass.
    run_on_signed(&g, &evm, ok(&good)).unwrap();
    run_on_signed(&sol_desk, &ed, ok(&ed_good)).unwrap();
    assert_eq!(E_MPC, "E_MPC");
}
