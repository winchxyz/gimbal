//! Every case in `vectors/hl.json` (built with `@nktkas/hyperliquid`, viem, ethers and msgpack, and
//! cross-checked with `hyperliquid-python-sdk`) must give the same bytes, hashes and refusals here:
//! `l1` (orders, cancels, setReferrer), `user_signed`, `strings` and every row of `order_policy`,
//! with the file's oracle prices as reference prices and without any (the contract until it stores
//! prices, C6). The signatures in the file are of fixed test keys; the MPC's differ but must
//! recover to the desk address (C5).

use gimbal_core::eip712;
use gimbal_core::hl::{
    agent_struct_hash, cancel_action, check_order, check_px, check_sz, connection_id,
    exchange_domain_separator, max_fee_rate, order_action, prepare_l1, referral_code,
    set_referrer_action, sign_transaction_domain_separator, usdc_token, Address, Cloid, HlOrder,
    OrderWire, UserAction, AGENT_TYPE,
};
use gimbal_core::limits::fresh_price;
use gimbal_core::msgpack::Value as Mp;
use gimbal_core::network::Network;
use gimbal_core::policy::{HlAsset, Policy, UnpricedAsset};
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

/// The largest size of an unpriced symbol in these tests. The vectors list `unpriced` as plain
/// symbols, from before `max_sz`; their HYPE rows are sized 2.5 and 3, so with a `max_sz` of 3 the
/// notional cap decides them, as the vectors expect.
const VECTOR_UNPRICED_MAX_SZ: &str = "3";

/// The order-policy cases' policy, with the fields an order check does not read left empty.
fn vector_policy(p: &Value) -> Policy {
    let unpriced: Vec<String> = serde_json::from_value(p["unpriced"].clone()).unwrap();
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
        unpriced: unpriced
            .into_iter()
            .map(|symbol| UnpricedAsset {
                symbol,
                max_sz: VECTOR_UNPRICED_MAX_SZ.into(),
            })
            .collect(),
        unpriced_max_notional_usd: u(&p["unpriced_max_notional_usd"]),
    }
}

/// The reference price of `symbol` at the vectors' `now_ms`: its oracle price if young enough.
fn vector_reference(op: &Value, policy: &Policy, symbol: &str) -> Option<u128> {
    let oracle = op["oracle_by_symbol"].get(symbol)?;
    let price_e8: u128 = s(&oracle["price_e8"]).parse().unwrap();
    fresh_price(
        price_e8,
        u(&oracle["at_ms"]),
        u(&op["now_ms"]),
        policy.oracle_max_age_s,
    )
}

/// The symbol of the order's asset, if the policy lists it.
fn symbol_of(policy: &Policy, order: &HlOrder) -> Option<String> {
    policy
        .hl_assets
        .iter()
        .find(|a| a.index == order.asset)
        .map(|a| a.symbol.clone())
}

/// With the vectors' oracle prices as references every row ends as the file says: the band edges
/// pass, the stale and missing prices are `E_ORACLE_STALE`, the band is `E_PRICE_BAND`.
#[test]
fn every_order_policy_row_matches_with_the_vector_oracle() {
    let doc = doc();
    let op = &doc["order_policy"];
    let policy = vector_policy(&op["policy"]);
    policy.validate().unwrap();
    let cases = op["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 22);
    let mut f = Failures::default();
    let mut codes = Vec::new();
    for case in cases {
        let name = s(&case["name"]);
        let order: HlOrder = serde_json::from_value(case["order"].clone()).unwrap();
        let reference =
            symbol_of(&policy, &order).and_then(|sym| vector_reference(op, &policy, &sym));
        let got = check_order(&policy, &order, reference);
        let want = &case["expect"];
        if want["ok"].as_bool().unwrap() {
            let unpriced = want["unpriced"].as_bool().unwrap();
            f.eq(
                name,
                "unpriced",
                got.map(|c| c.unpriced).map_err(|r| r.code),
                Ok(unpriced),
            );
        } else {
            let code = s(&want["code"]);
            codes.push(code);
            f.eq(name, "code", got.map(|_| ()).map_err(|r| r.code), Err(code));
        }
    }
    let count = |c: &str| codes.iter().filter(|x| **x == c).count();
    assert_eq!((count("E_PRICE_BAND"), count("E_ORACLE_STALE")), (2, 2));
    f.done(cases.len());
}

/// Without a stored price (the contract until C6), a priced order that the vectors pass is
/// `E_ORACLE_STALE`; refusals decided before the oracle, and unpriced orders, stay as they are.
#[test]
fn without_an_oracle_every_priced_row_that_passes_is_stale() {
    let doc = doc();
    let op = &doc["order_policy"];
    let policy = vector_policy(&op["policy"]);
    let mut f = Failures::default();
    let mut flipped = 0;
    for case in op["cases"].as_array().unwrap() {
        let name = s(&case["name"]);
        let order: HlOrder = serde_json::from_value(case["order"].clone()).unwrap();
        let got = check_order(&policy, &order, None).map(|c| c.unpriced);
        let want = &case["expect"];
        let code = want["code"].as_str();
        let priced_pass = want["ok"].as_bool().unwrap() && !want["unpriced"].as_bool().unwrap();
        // A zero size and HYPE's notional are refused before any oracle is needed.
        let decided_by_oracle = matches!(code, Some("E_PRICE_BAND" | "E_ORACLE_STALE"))
            || (code == Some("E_SIZE")
                && order.sz != "0"
                && symbol_of(&policy, &order).as_deref() != Some("HYPE"));
        let expected = if priced_pass || decided_by_oracle {
            flipped += usize::from(priced_pass);
            Err("E_ORACLE_STALE")
        } else if let Some(code) = code {
            Err(code)
        } else {
            Ok(true)
        };
        f.eq(name, "outcome", got.map_err(|r| r.code), expected);
    }
    // ETH and BTC inside the cap and the band, the two band edges, the reduce-only close.
    assert_eq!(flipped, 6);
    f.done(22);
}
