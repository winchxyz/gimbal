//! Every case in `vectors/hl.json` (built with `@nktkas/hyperliquid`, viem, ethers and msgpack, and
//! cross-checked with `hyperliquid-python-sdk`) must give the same bytes, hashes and refusals here:
//! `l1` (orders, cancels, setReferrer), `user_signed`, `strings` and the non-oracle rows of
//! `order_policy` (the oracle rows join with the price band on day 6). The signatures in the file
//! are of fixed test keys; the MPC's differ but must recover to the desk address (C5).

use gimbal_core::eip712;
use gimbal_core::hl::{
    agent_struct_hash, cancel_action, check_order, check_px, check_sz, connection_id,
    exchange_domain_separator, max_fee_rate, order_action, prepare_l1, referral_code,
    set_referrer_action, sign_transaction_domain_separator, usdc_token, Address, Cloid, HlOrder,
    OrderWire, UserAction, AGENT_TYPE,
};
use gimbal_core::msgpack::Value as Mp;
use gimbal_core::network::Network;
use gimbal_core::policy::{HlAsset, Policy};
use gimbal_core::Refusal;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const VECTORS: &str = include_str!("vectors/hl.json");

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn doc() -> Value {
    serde_json::from_str(VECTORS).expect("hl.json parses")
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a u64: {v}"))
}

fn network(name: &str) -> Network {
    match name {
        "mainnet" => Network::Mainnet,
        "testnet" => Network::Testnet,
        other => panic!("unknown network {other}"),
    }
}

fn json_of(v: &Mp) -> Value {
    serde_json::to_value(v).unwrap()
}

/// The `/exchange` body: the payload with the signature added.
fn exchange_body(payload: &Mp, signature: &Value) -> Value {
    let mut body = json_of(payload);
    body["signature"] = signature.clone();
    body
}

/// Collects mismatches so one run shows every failing case.
#[derive(Default)]
struct Failures(Vec<String>);

impl Failures {
    fn eq<T: PartialEq + std::fmt::Debug>(&mut self, case: &str, what: &str, got: T, want: T) {
        if got != want {
            self.0
                .push(format!("{case}: {what}: got {got:?}, want {want:?}"));
        }
    }

    fn done(self, total: usize) {
        assert!(total > 0);
        assert!(
            self.0.is_empty(),
            "{} mismatches in {total} cases:\n{}",
            self.0.len(),
            self.0.join("\n")
        );
    }
}

#[test]
fn the_l1_domain_and_agent_type_match() {
    let l1 = &doc()["l1"];
    assert_eq!(
        l1["domain"],
        json!({"name": "Exchange", "version": "1", "chainId": 1337,
               "verifyingContract": "0x0000000000000000000000000000000000000000"})
    );
    assert_eq!(
        hex0x(&exchange_domain_separator(keccak)),
        s(&l1["domain_separator"])
    );
    assert_eq!(s(&l1["agent_type"]), AGENT_TYPE);
    assert_eq!(
        hex0x(&keccak(AGENT_TYPE.as_bytes())),
        s(&l1["agent_typehash"])
    );
    for (net, network) in [("mainnet", Network::Mainnet), ("testnet", Network::Testnet)] {
        assert_eq!(s(&l1["source"][net]), network.hl_source());
    }
}

#[test]
fn every_l1_vector_matches() {
    let doc = doc();
    let cases = doc["l1"]["cases"].as_array().unwrap();
    let mut f = Failures::default();
    let mut kinds = Vec::new();
    for case in cases {
        let name = s(&case["name"]);
        let p = &case["params"];
        let kind = s(&case["kind"]);
        kinds.push(kind.to_owned());
        let action = match kind {
            "order" => {
                let order: HlOrder = serde_json::from_value(json!({
                    "asset": p["asset"], "is_buy": p["is_buy"], "px": p["px"], "sz": p["sz"],
                    "reduce_only": p["reduce_only"], "tif": p["tif"], "cloid": p["cloid"],
                }))
                .unwrap();
                let wire = OrderWire::from_order(&order).unwrap();
                let builder = Address::parse("builder", s(&p["builder"])).unwrap();
                let fee = u16::try_from(u(&p["builder_fee_tenth_bps"])).unwrap();
                order_action(&wire, &builder, fee)
            }
            "cancel" => cancel_action(u32::try_from(u(&p["asset"])).unwrap(), u(&p["oid"])),
            "setReferrer" => set_referrer_action(referral_code(Some(s(&p["code"]))).unwrap()),
            other => panic!("{name}: unknown kind {other}"),
        };
        let nonce = u(&case["nonce"]);
        f.eq(
            name,
            "action JSON",
            json_of(&action),
            case["action"].clone(),
        );
        f.eq(
            name,
            "msgpack",
            hex::encode(action.to_msgpack()),
            s(&case["msgpack_hex"]).to_owned(),
        );
        let connection = connection_id(keccak, &action, nonce);
        f.eq(
            name,
            "connection id",
            hex0x(&connection),
            s(&case["connection_id"]).to_owned(),
        );
        for net in ["mainnet", "testnet"] {
            let want = &case[net];
            let network = network(net);
            let what = |w: &str| format!("{net} {w}");
            f.eq(
                name,
                &what("source"),
                network.hl_source(),
                s(&want["source"]),
            );
            f.eq(
                name,
                &what("struct hash"),
                hex0x(&agent_struct_hash(keccak, network, &connection)),
                s(&want["struct_hash"]).to_owned(),
            );
            let prepared = prepare_l1(keccak, network, "x", action.clone(), nonce);
            f.eq(
                name,
                &what("digest"),
                hex0x(&prepared.digest),
                s(&want["digest"]).to_owned(),
            );
            f.eq(
                name,
                &what("exchange body"),
                exchange_body(&prepared.payload, &want["exchange_body"]["signature"]),
                want["exchange_body"].clone(),
            );
        }
    }
    // 12 orders, 3 cancels, 3 setReferrer, as the brief lists them.
    let count = |k: &str| kinds.iter().filter(|x| *x == k).count();
    assert_eq!(
        (count("order"), count("cancel"), count("setReferrer")),
        (12, 3, 3)
    );
    f.done(cases.len());
}

/// The action a user-signed case describes, built the way the contract builds it.
fn user_action(case: &Value) -> UserAction {
    let a = &case["action"];
    let addr = |field: &str| Address::parse(field, s(&a[field])).unwrap();
    match s(&case["kind"]) {
        "usdClassTransfer" => UserAction::UsdClassTransfer {
            amount: s(&a["amount"]).into(),
            to_perp: a["toPerp"].as_bool().unwrap(),
            nonce: u(&a["nonce"]),
        },
        "sendAsset" => {
            assert_eq!(
                s(&a["fromSubAccount"]),
                "",
                "the desk never sends from a sub-account"
            );
            UserAction::SendAsset {
                destination: addr("destination"),
                source_dex: s(&a["sourceDex"]).into(),
                destination_dex: s(&a["destinationDex"]).into(),
                token: s(&a["token"]).into(),
                amount: s(&a["amount"]).into(),
                nonce: u(&a["nonce"]),
            }
        }
        "withdraw3" => UserAction::Withdraw {
            destination: addr("destination"),
            amount: s(&a["amount"]).into(),
            time: u(&a["time"]),
        },
        "approveBuilderFee" => UserAction::ApproveBuilderFee {
            max_fee_rate: s(&a["maxFeeRate"]).into(),
            builder: addr("builder"),
            nonce: u(&a["nonce"]),
        },
        other => panic!("unknown kind {other}"),
    }
}

#[test]
fn every_user_signed_vector_matches() {
    let doc = doc();
    let us = &doc["user_signed"];
    assert_eq!(
        hex0x(&sign_transaction_domain_separator(keccak)),
        s(&us["domain_separator"])
    );
    assert_eq!(us["domain"]["chainId"], json!(0x66eee));
    for (net, network) in [("mainnet", Network::Mainnet), ("testnet", Network::Testnet)] {
        assert_eq!(s(&us["usdc_token"][net]), usdc_token(network));
    }
    let cases = us["cases"].as_array().unwrap();
    let mut f = Failures::default();
    let mut seen = Vec::new();
    for case in cases {
        let name = s(&case["name"]);
        let network = network(s(&case["network"]));
        let action = user_action(case);
        seen.push((action.kind(), network));
        f.eq(name, "kind", action.kind(), s(&case["kind"]));
        f.eq(
            name,
            "type string",
            action.type_string(),
            s(&case["type_string"]),
        );
        f.eq(
            name,
            "primary type",
            action.type_string().split('(').next().unwrap(),
            s(&case["primary_type"]),
        );
        f.eq(
            name,
            "typehash",
            hex0x(&keccak(action.type_string().as_bytes())),
            s(&case["typehash"]).to_owned(),
        );
        f.eq(
            name,
            "domain separator",
            hex0x(&sign_transaction_domain_separator(keccak)),
            s(&case["domain_separator"]).to_owned(),
        );
        let struct_hash = action.struct_hash(keccak, network);
        f.eq(
            name,
            "struct hash",
            hex0x(&struct_hash),
            s(&case["struct_hash"]).to_owned(),
        );
        let prepared = action.prepare(keccak, network);
        f.eq(
            name,
            "digest",
            hex0x(&prepared.digest),
            s(&case["digest"]).to_owned(),
        );
        f.eq(
            name,
            "digest from parts",
            prepared.digest,
            eip712::digest(
                keccak,
                &sign_transaction_domain_separator(keccak),
                &struct_hash,
            ),
        );
        f.eq(
            name,
            "action JSON",
            json_of(&action.action(network)),
            case["action"].clone(),
        );
        f.eq(
            name,
            "exchange body",
            exchange_body(&prepared.payload, &case["exchange_body"]["signature"]),
            case["exchange_body"].clone(),
        );
        if action.kind() == "sendAsset" {
            f.eq(
                name,
                "USDC token",
                s(&case["action"]["token"]),
                usdc_token(network),
            );
        }
    }
    // Each of the four actions on both networks.
    for kind in [
        "usdClassTransfer",
        "sendAsset",
        "withdraw3",
        "approveBuilderFee",
    ] {
        for network in [Network::Mainnet, Network::Testnet] {
            assert!(seen.contains(&(kind, network)), "{kind} {network:?}");
        }
    }
    f.done(cases.len());
}

/// `Ok` or the refusal code, for comparing with a case's `valid` / `code`.
fn outcome<T>(r: Result<T, Refusal>) -> Result<(), &'static str> {
    r.map(|_| ()).map_err(|r| r.code)
}

fn expected(case: &Value, ok_field: &str, code_field: &str) -> Result<(), String> {
    if case[ok_field].as_bool().unwrap() {
        Ok(())
    } else {
        Err(s(&case[code_field]).to_owned())
    }
}

#[test]
fn every_string_vector_matches() {
    let doc = doc();
    let st = &doc["strings"];
    let mut f = Failures::default();
    let mut total = 0;
    for case in st["px_cases"].as_array().unwrap() {
        total += 1;
        let px = s(&case["px"]);
        let sz_decimals = u8::try_from(u(&case["sz_decimals"])).unwrap();
        let got = outcome(check_px(px, sz_decimals)).map_err(str::to_owned);
        f.eq(
            &format!("px {px:?} sz {sz_decimals}"),
            "outcome",
            got,
            expected(case, "valid", "code"),
        );
    }
    for case in st["sz_cases"].as_array().unwrap() {
        total += 1;
        let sz = s(&case["sz"]);
        let sz_decimals = u8::try_from(u(&case["sz_decimals"])).unwrap();
        let got = outcome(check_sz(sz, sz_decimals)).map_err(str::to_owned);
        f.eq(
            &format!("sz {sz:?} sz {sz_decimals}"),
            "outcome",
            got,
            expected(case, "valid", "code"),
        );
    }
    // format_cases are the engine's rounding (the contract validates and never rounds).
    assert!(s(&st["format_cases_note"]).starts_with("engine side only"));
    for case in st["hex_cases"].as_array().unwrap() {
        total += 1;
        let input = s(&case["input"]);
        let wire = match s(&case["field"]) {
            "cloid" => Cloid::parse(input).map(|c| c.to_hex()),
            "address" => Address::parse("address", input).map(|a| a.to_hex()),
            other => panic!("unknown hex field {other}"),
        };
        let name = format!("hex {input:?}");
        if case["ok"].as_bool().unwrap() {
            f.eq(
                &name,
                "wire",
                wire.map_err(|r| r.code),
                Ok(s(&case["wire"]).to_owned()),
            );
        } else {
            f.eq(
                &name,
                "code",
                wire.map_err(|r| r.code.to_owned()),
                Err(s(&case["code"]).to_owned()),
            );
        }
    }
    for case in st["fee_rate_cases"].as_array().unwrap() {
        total += 1;
        let fee = u16::try_from(u(&case["builder_fee_tenth_bps"])).unwrap();
        f.eq(
            &format!("fee {fee}"),
            "maxFeeRate",
            max_fee_rate(fee),
            s(&case["max_fee_rate"]).to_owned(),
        );
    }
    for case in st["referral_code_cases"].as_array().unwrap() {
        total += 1;
        let code = case["code"].as_str();
        let got = outcome(referral_code(code)).map_err(str::to_owned);
        f.eq(
            &format!("referral {code:?}"),
            "outcome",
            got,
            expected(case, "ok", "code_refusal"),
        );
    }
    f.done(total);
}

/// The order-policy cases' policy, with the fields an order check does not read left empty.
fn vector_policy(p: &Value) -> Policy {
    Policy {
        hl_assets: serde_json::from_value::<Vec<HlAsset>>(p["hl_assets"].clone()).unwrap(),
        phoenix_markets: vec![],
        orderly_symbols: vec![],
        max_notional_usd: u(&p["max_notional_usd"]),
        price_band_bps: u32::try_from(u(&p["price_band_bps"])).unwrap(),
        oracle_max_age_s: u32::try_from(u(&p["oracle_max_age_s"])).unwrap(),
        rescue_cap_usd_per_hour: 0,
        max_transfer_cost_bps: 0,
        max_transfer_cost_flat_e6: 0,
        unpriced: serde_json::from_value(p["unpriced"].clone()).unwrap(),
        unpriced_max_notional_usd: u(&p["unpriced_max_notional_usd"]),
    }
}

/// Today's checks decide every row whose outcome needs no oracle price. A row the band or the
/// staleness check decides (day 6) must pass today's checks as a priced order, so those checks
/// hand it on to the oracle step.
#[test]
fn every_order_policy_row_without_an_oracle_matches() {
    let doc = doc();
    let op = &doc["order_policy"];
    let policy = vector_policy(&op["policy"]);
    policy.validate().unwrap();
    let cases = op["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 22);
    let mut f = Failures::default();
    let mut oracle_rows = 0;
    for case in cases {
        let name = s(&case["name"]);
        let order: HlOrder = serde_json::from_value(case["order"].clone()).unwrap();
        let got = check_order(&policy, &order);
        let want = &case["expect"];
        let code = want["code"].as_str();
        if matches!(code, Some("E_PRICE_BAND" | "E_ORACLE_STALE")) {
            oracle_rows += 1;
            f.eq(
                name,
                "handed to the oracle step",
                got.map(|c| c.unpriced).map_err(|r| r.code),
                Ok(false),
            );
        } else if want["ok"].as_bool().unwrap() {
            let unpriced = want["unpriced"].as_bool().unwrap();
            f.eq(
                name,
                "unpriced",
                got.map(|c| c.unpriced).map_err(|r| r.code),
                Ok(unpriced),
            );
        } else {
            f.eq(
                name,
                "code",
                got.map(|_| ()).map_err(|r| r.code),
                Err(code.unwrap()),
            );
        }
    }
    // Two band edges and two stale or missing prices wait for day 6.
    assert_eq!(oracle_rows, 4);
    f.done(cases.len());
}
