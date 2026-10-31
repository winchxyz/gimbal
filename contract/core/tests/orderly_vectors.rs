//! `vectors/orderly.json` against the Orderly builders: domain separators, type hashes, struct hashes
//! and digests of every EIP-712 message, the JSON Orderly is sent, account ids, and every REST
//! message and body the desk's Ed25519 key signs; then the refusals of each builder.

use gimbal_core::decimal::parse_e8;
use gimbal_core::errors::{E_ARGS, E_ASSET, E_DECIMAL, E_ORACLE_STALE, E_PRICE_BAND, E_SIZE};
use gimbal_core::network::Network;
use gimbal_core::orderly::{
    account_id, build_request, checksum_address, client_order_id, order_body, orderly_key,
    parse_signature, signed_message_body, ws_auth, Broker, Context, Message, OrderlyRequest,
    KEY_SCOPE, LEDGER_MAINNET, LEDGER_TESTNET, MAX_AHEAD_MS, MAX_KEY_LIFETIME_MS,
    OFF_CHAIN_VERIFYING_CONTRACT, REQUEST_TTL_MS,
};
use gimbal_core::policy::{Policy, UnpricedAsset};
use gimbal_core::Refusal;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const VECTORS: &str = include_str!("vectors/orderly.json");

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn h(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn address(s: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    hex::decode_to_slice(&s[2..], &mut out).unwrap();
    out
}

fn u(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        Value::Number(n) => n.as_u64().unwrap(),
        _ => panic!("not an integer: {v}"),
    }
}

fn network(v: &Value) -> Network {
    match v.as_str().unwrap() {
        "testnet" => Network::Testnet,
        "mainnet" => Network::Mainnet,
        other => panic!("network {other}"),
    }
}

/// The broker of a vector network, as `OrderlyConfig` would hold it.
fn broker(v: &Value, net: &Value) -> Broker<'static> {
    let n = &v["networks"][net.as_str().unwrap()];
    Broker {
        network: network(net),
        broker_id: Box::leak(n["brokerId"].as_str().unwrap().to_owned().into_boxed_str()),
        chain_id: n["chainId"].as_u64().unwrap(),
    }
}

fn desk_evm(v: &Value) -> [u8; 20] {
    address(v["keys"]["deskEvm"]["address"].as_str().unwrap())
}

fn desk_sol(v: &Value) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(
        v["keys"]["deskSol"]["public_key_hex"].as_str().unwrap(),
        &mut out,
    )
    .unwrap();
    out
}

/// base64url without padding, as the `orderly-signature` header carries it.
fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// The message of an EIP-712 case, rebuilt through the constructors the contract calls.
fn message_of(v: &Value, case: &Value) -> Message {
    let m = &case["message_typed"];
    let ts = u(&m["timestamp"]);
    match case["primary_type"].as_str().unwrap() {
        "Registration" => {
            Message::registration(m["registrationNonce"].as_str().unwrap(), ts).unwrap()
        }
        "AddOrderlyKey" => {
            assert_eq!(m["orderlyKey"], v["keys"]["orderly_key"]);
            assert_eq!(m["scope"], KEY_SCOPE);
            Message::add_orderly_key(&desk_sol(v), u(&m["expiration"]), ts).unwrap()
        }
        "Withdraw" => {
            assert_eq!(m["token"], "USDC");
            let receiver = address(m["receiver"].as_str().unwrap());
            assert_eq!(receiver, desk_evm(v));
            let e6 = u(&m["amount"]);
            let amount = gimbal_core::decimal::format_e8(u128::from(e6) * 100);
            Message::withdraw(receiver, &amount, u(&m["withdrawNonce"]), ts).unwrap()
        }
        "SettlePnl" => Message::SettlePnl {
            settle_nonce: u(&m["settleNonce"]),
            timestamp: ts,
        },
        other => panic!("primary type {other}"),
    }
}

fn eip712_case<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["eip712"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no EIP-712 case {name}"))
}

#[test]
fn every_domain_separator() {
    let v = vectors();
    for net in ["testnet", "mainnet"] {
        let b = broker(&v, &json!(net));
        let off = Message::SettlePnl {
            settle_nonce: 0,
            timestamp: 0,
        };
        let registration = Message::Registration {
            timestamp: 0,
            registration_nonce: 0,
        };
        let d = &v["domains"][net];
        assert_eq!(d["off_chain"]["name"], "Orderly");
        assert_eq!(d["off_chain"]["version"], "1");
        assert_eq!(d["off_chain"]["chainId"], b.chain_id);
        assert_eq!(
            d["off_chain"]["verifyingContract"],
            OFF_CHAIN_VERIFYING_CONTRACT
        );
        assert_eq!(
            d["off_chain"]["separator"],
            h(&registration.domain_separator(keccak, &b)),
            "{net} off-chain"
        );
        assert_eq!(
            d["on_chain"]["verifyingContract"],
            off.verifying_contract(b.network)
        );
        assert_eq!(
            d["on_chain"]["separator"],
            h(&off.domain_separator(keccak, &b)),
            "{net} on-chain"
        );
    }
    assert_eq!(v["networks"]["testnet"]["ledger"], LEDGER_TESTNET);
    assert_eq!(v["networks"]["mainnet"]["ledger"], LEDGER_MAINNET);
    assert_eq!(
        v["networks"]["testnet"]["chainId"],
        Network::Testnet.arbitrum_chain_id()
    );
    assert_eq!(
        v["networks"]["mainnet"]["chainId"],
        Network::Mainnet.arbitrum_chain_id()
    );
}

#[test]
fn every_eip712_case() {
    let v = vectors();
    let cases = v["eip712"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let b = broker(&v, &case["network"]);
        assert_eq!(case["message_typed"]["brokerId"], b.broker_id, "{name}");
        assert_eq!(u(&case["message_typed"]["chainId"]), b.chain_id, "{name}");
        let m = message_of(&v, case);
        assert_eq!(m.kind(), case["primary_type"], "{name}");
        assert_eq!(m.type_string(), case["type_string"], "{name}");
        assert_eq!(
            h(&keccak(m.type_string().as_bytes())),
            case["typehash"],
            "{name}"
        );
        assert_eq!(
            case["domain"]["verifyingContract"],
            m.verifying_contract(b.network),
            "{name}"
        );
        assert_eq!(
            h(&m.domain_separator(keccak, &b)),
            case["domain_separator"],
            "{name}"
        );
        assert_eq!(h(&m.struct_hash(keccak, &b)), case["struct_hash"], "{name}");
        assert_eq!(h(&m.digest(keccak, &b)), case["digest"], "{name}");
        assert_eq!(m.timestamp(), u(&case["message_typed"]["timestamp"]));

        // What the relayer posts: the payload's message and userAddress, plus the signature.
        let payload: Value =
            serde_json::from_str(&m.payload(keccak, &b, &desk_evm(&v)).to_json()).unwrap();
        let post = &case["post_body"];
        assert_eq!(payload["message"], post["message"], "{name}");
        assert_eq!(payload["userAddress"], post["userAddress"], "{name}");
        assert_eq!(payload.as_object().unwrap().len(), 2, "{name}");

        let sig = parse_signature(case["signature"]["hex"].as_str().unwrap()).unwrap();
        assert_eq!(h(&sig[..32]), case["signature"]["r"], "{name}");
        assert_eq!(h(&sig[32..64]), case["signature"]["s"], "{name}");
        assert_eq!(u64::from(sig[64]), u(&case["signature"]["v"]), "{name}");
        assert_eq!(post["signature"], case["signature"]["hex"], "{name}");
    }
}

#[test]
fn account_ids_and_addresses() {
    let v = vectors();
    for a in v["account_ids"].as_array().unwrap() {
        let owner = address(a["user_address"].as_str().unwrap());
        let broker = a["broker_id"].as_str().unwrap();
        assert_eq!(h(&keccak(broker.as_bytes())), a["broker_hash"]);
        assert_eq!(h(&account_id(keccak, &owner, broker)), a["account_id"]);
    }
    let evm = &v["keys"]["deskEvm"];
    let lower = address(evm["address_lower"].as_str().unwrap());
    assert_eq!(checksum_address(keccak, &lower), evm["address"]);
    for constant in [OFF_CHAIN_VERIFYING_CONTRACT, LEDGER_TESTNET, LEDGER_MAINNET] {
        assert_eq!(checksum_address(keccak, &address(constant)), constant);
    }
    assert_eq!(orderly_key(&desk_sol(&v)), v["keys"]["orderly_key"]);
    assert_eq!(
        bs58::encode(desk_sol(&v)).into_string(),
        v["keys"]["deskSol"]["public_key_b58"]
    );
}

/// A policy with the vector symbols, priced at the vector prices.
fn vector_policy() -> Policy {
    Policy {
        hl_assets: vec![],
        phoenix_markets: vec![],
        orderly_symbols: vec![
            "PERP_ETH_USDC".into(),
            "PERP_SOL_USDC".into(),
            "PERP_BTC_USDC".into(),
        ],
        max_notional_usd: 100_000,
        price_band_bps: 500,
        oracle_max_age_s: 60,
        rescue_cap_usd_per_hour: 0,
        max_transfer_cost_bps: 0,
        max_transfer_cost_flat_e6: 0,
        unpriced: vec![],
        unpriced_max_notional_usd: 0,
    }
}

const E8: u128 = 100_000_000;

/// The reference prices of the vector orders' base symbols.
fn vector_price(symbol: &str) -> Option<u128> {
    match symbol {
        "ETH" => Some(1_200 * E8),
        "SOL" => Some(104 * E8),
        "BTC" => Some(80_000 * E8),
        _ => None,
    }
}

fn no_price(_: &str) -> Option<u128> {
    None
}

/// The context of a request vector, the oracle at the order's own price.
fn context<'a>(
    v: &Value,
    net: &Value,
    policy: &'a Policy,
    block_ms: u64,
    reference: &'a dyn Fn(&str) -> Option<u128>,
) -> Context<'a> {
    Context {
        keccak,
        broker: broker(v, net),
        policy,
        desk_evm: desk_evm(v),
        referral_code: Some("TESTCODE"),
        block_ms,
        request_id: 0,
        reference,
    }
}

/// The `OrderlyRequest` of a request vector: its `request`, or for the money path the fields of its
/// EIP-712 case.
fn request_of(v: &Value, r: &Value) -> OrderlyRequest {
    let mut req = r
        .get("request")
        .cloned()
        .unwrap_or_else(|| json!({ "kind": r["kind"] }));
    req["timestamp_ms"] = r["timestamp"].clone();
    if let Some(name) = r.get("eip712_case") {
        let case = eip712_case(v, name.as_str().unwrap());
        let m = &case["message_typed"];
        req["signed_at_ms"] = json!(u(&m["timestamp"]));
        req["eip712_signature"] = case["signature"]["hex"].clone();
        if r["kind"] == "settle_pnl" {
            req["nonce"] = json!(u(&m["settleNonce"]));
        } else {
            req["nonce"] = json!(u(&m["withdrawNonce"]));
            let e6 = u128::from(u(&m["amount"]));
            req["amount"] = json!(gimbal_core::decimal::format_e8(e6 * 100));
        }
    }
    serde_json::from_value(req).unwrap()
}

#[test]
fn every_request() {
    let v = vectors();
    let policy = vector_policy();
    let requests = v["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 22);
    let mut kinds = std::collections::BTreeSet::new();
    for r in requests {
        let name = r["name"].as_str().unwrap();
        let ts = r["timestamp"].as_u64().unwrap();
        let req = request_of(&v, r);
        let px = req.price.as_deref().map(|p| parse_e8(p).unwrap());
        let at_px = move |_: &str| px;
        // An order's client_order_id is the contract's, from the request_id it signs with.
        let request_id = r["request_id"].as_u64();
        assert_eq!(request_id.is_some(), req.kind == "order", "{name}");
        let ctx = Context {
            request_id: request_id.unwrap_or(0),
            ..context(&v, &r["network"], &policy, ts, &at_px)
        };
        kinds.insert(req.kind.clone());
        assert_eq!(
            r["message"].as_str().unwrap(),
            format!(
                "{ts}{}{}{}",
                r["method"].as_str().unwrap(),
                r["path"].as_str().unwrap(),
                r["body"].as_str().unwrap()
            ),
            "{name}"
        );
        if req.order_type.as_deref() == Some("MARKET") {
            // Gimbal never signs a MARKET order (no price limit); the body is still pinned.
            let refusal = build_request(&ctx, &req).unwrap_err();
            assert_eq!(refusal.code, E_PRICE_BAND, "{name}");
            let body = order_body(
                req.symbol.as_deref().unwrap(),
                Some(&client_order_id(ctx.request_id)),
                "MARKET",
                None,
                req.quantity.as_deref().unwrap(),
                req.side.as_deref().unwrap(),
                req.reduce_only,
            );
            assert_eq!(body, r["body"].as_str().unwrap(), "{name}");
            continue;
        }
        let s = build_request(&ctx, &req).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(s.kind, r["kind"].as_str().unwrap(), "{name}");
        assert_eq!(s.method, r["method"].as_str().unwrap(), "{name}");
        assert_eq!(s.path, r["path"].as_str().unwrap(), "{name}");
        assert_eq!(s.body, r["body"].as_str().unwrap(), "{name}");
        assert_eq!(s.timestamp, ts, "{name}");
        assert_eq!(s.message(), r["message"].as_str().unwrap(), "{name}");
        let payload: Value = serde_json::from_str(&s.payload().to_json()).unwrap();
        assert_eq!(
            payload,
            json!({
                "method": r["method"], "path": r["path"], "body": r["body"],
                "timestamp": ts, "message": r["message"],
            }),
            "{name}"
        );

        // The relayer's headers.
        let sig = hex::decode(r["signature_hex"].as_str().unwrap()).unwrap();
        assert_eq!(
            b64url(&sig),
            r["signature_b64url"].as_str().unwrap(),
            "{name}"
        );
        let headers = &r["headers"];
        assert_eq!(headers["orderly-timestamp"], ts.to_string(), "{name}");
        assert_eq!(headers["orderly-key"], v["keys"]["orderly_key"], "{name}");
        assert_eq!(
            headers["orderly-signature"], r["signature_b64url"],
            "{name}"
        );
        let b = broker(&v, &r["network"]);
        assert_eq!(
            headers["orderly-account-id"],
            h(&account_id(keccak, &desk_evm(&v), b.broker_id)),
            "{name}"
        );
        let api = v["networks"][r["network"].as_str().unwrap()]["api"]
            .as_str()
            .unwrap();
        assert_eq!(r["url"], format!("{api}{}", s.path), "{name}");

        // The EIP-712 message embedded in a money-path body is the one the case signed.
        if let Some(case) = r.get("eip712_case") {
            let case = eip712_case(&v, case.as_str().unwrap());
            let (digest, signature) = s.eip712.unwrap();
            assert_eq!(h(&digest), case["digest"], "{name}");
            assert_eq!(h(&signature), case["signature"]["hex"], "{name}");
            let m = message_of(&v, case);
            assert_eq!(
                signed_message_body(keccak, &b, &m, &signature, &desk_evm(&v)),
                s.body,
                "{name}"
            );
        } else {
            assert!(s.eip712.is_none(), "{name}");
        }
    }
    let all = [
        "cancel",
        "cancel_all",
        "funding_fee_history",
        "holding",
        "order",
        "positions",
        "receiver_address",
        "referral_bind",
        "settle_nonce",
        "settle_pnl",
        "withdraw_nonce",
        "withdraw_request",
    ];
    assert_eq!(kinds.into_iter().collect::<Vec<_>>(), all);
}

#[test]
fn ws_auth_signs_the_timestamp_alone() {
    let v = vectors();
    let w = &v["ws_auth"];
    let ts = w["timestamp"].as_u64().unwrap();
    let s = ws_auth(ts, ts).unwrap();
    assert_eq!(s.kind, "ws_auth");
    assert_eq!(s.message(), w["message"].as_str().unwrap());
    assert_eq!(s.message(), ts.to_string());
    assert!(s.reduces_risk);
    let payload: Value = serde_json::from_str(&s.payload().to_json()).unwrap();
    assert_eq!(
        payload,
        json!({"method": "", "path": "", "body": "", "timestamp": ts, "message": ts.to_string()})
    );
    let sig = hex::decode(w["signature_hex"].as_str().unwrap()).unwrap();
    assert_eq!(b64url(&sig), w["signature_b64url"].as_str().unwrap());
    assert_eq!(w["frame"]["params"]["sign"], w["signature_b64url"]);
    assert_eq!(
        w["frame"]["params"]["orderly_key"],
        v["keys"]["orderly_key"]
    );
    assert_eq!(w["frame"]["params"]["timestamp"], ts);
}

// --- Refusals ---

const BLOCK: u64 = 1_793_491_300_000;

fn testnet() -> Broker<'static> {
    Broker {
        network: Network::Testnet,
        broker_id: "woofi_dex",
        chain_id: 421_614,
    }
}

fn ctx_at<'a>(policy: &'a Policy, referral_code: Option<&'a str>) -> Context<'a> {
    Context {
        keccak,
        broker: testnet(),
        policy,
        desk_evm: address("0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1"),
        referral_code,
        block_ms: BLOCK,
        request_id: 0,
        reference: &vector_price,
    }
}

fn req(fields: Value) -> OrderlyRequest {
    let mut r = json!({ "timestamp_ms": BLOCK });
    for (k, val) in fields.as_object().unwrap() {
        r[k] = val.clone();
    }
    serde_json::from_value(r).unwrap()
}

fn eth_buy() -> Value {
    json!({
        "kind": "order", "symbol": "PERP_ETH_USDC", "side": "BUY", "order_type": "LIMIT",
        "price": "1212.89", "quantity": "0.0087",
    })
}

fn with(base: Value, change: Value) -> Value {
    let mut out = base;
    for (k, val) in change.as_object().unwrap() {
        if val.is_null() {
            out.as_object_mut().unwrap().remove(k);
        } else {
            out[k] = val.clone();
        }
    }
    out
}

/// A settle_pnl request with the SettlePnl (testnet) vector's signature.
fn settle(change: Value) -> Value {
    with(
        json!({
            "kind": "settle_pnl", "nonce": 1, "signed_at_ms": 1_793_491_205_000u64,
            "eip712_signature": "0x0057ad808089b4ae4068ae3d2e2039b8ade32cb84365780170a75fed8e4701d26c1e1967d0d318ef791cbed9e2c06d22bec290313bf1f1640ed32c33621d9bbf1c",
        }),
        change,
    )
}

fn withdraw(change: Value) -> Value {
    with(
        settle(json!({"kind": "withdraw_request", "amount": "5"})),
        change,
    )
}

fn refused(r: Result<impl std::fmt::Debug, Refusal>) -> Refusal {
    match r {
        Ok(v) => panic!("accepted: {v:?}"),
        Err(e) => e,
    }
}

#[test]
fn request_refusals() {
    let policy = vector_policy();
    let mut unpriced = vector_policy();
    unpriced.unpriced = vec![UnpricedAsset {
        symbol: "ETH".into(),
        max_sz: "0.01".into(),
    }];
    unpriced.unpriced_max_notional_usd = 20;
    let ttl = REQUEST_TTL_MS;
    let cases: Vec<(&str, Value, &str)> = vec![
        // The window.
        (
            "300 s and 1 ms old",
            with(eth_buy(), json!({"timestamp_ms": BLOCK - ttl - 1})),
            E_ARGS,
        ),
        (
            "5 s and 1 ms ahead",
            with(eth_buy(), json!({"timestamp_ms": BLOCK + MAX_AHEAD_MS + 1})),
            E_ARGS,
        ),
        // Kinds and fields.
        ("unknown kind", json!({"kind": "transfer"}), E_ARGS),
        ("kind in another case", json!({"kind": "ORDER"}), E_ARGS),
        (
            "an order_id on an order",
            with(eth_buy(), json!({"order_id": 1})),
            E_ARGS,
        ),
        (
            "an amount on an order",
            with(eth_buy(), json!({"amount": "1"})),
            E_ARGS,
        ),
        (
            "reduce_only on a cancel",
            json!({"kind": "cancel", "symbol": "PERP_ETH_USDC", "order_id": 1, "reduce_only": true}),
            E_ARGS,
        ),
        (
            "a side on a cancel_all",
            json!({"kind": "cancel_all", "symbol": "PERP_ETH_USDC", "side": "BUY"}),
            E_ARGS,
        ),
        (
            "a symbol on a nonce read",
            json!({"kind": "settle_nonce", "symbol": "PERP_ETH_USDC"}),
            E_ARGS,
        ),
        (
            "a page on a receiver lookup",
            json!({"kind": "receiver_address", "page": 1}),
            E_ARGS,
        ),
        (
            "a code field on referral_bind",
            json!({"kind": "referral_bind", "symbol": "PERP_ETH_USDC"}),
            E_ARGS,
        ),
        (
            "a quantity on funding_fee_history",
            json!({"kind": "funding_fee_history", "quantity": "1"}),
            E_ARGS,
        ),
        // Orders.
        (
            "no symbol",
            with(eth_buy(), json!({"symbol": null})),
            E_ARGS,
        ),
        (
            "a symbol outside the policy",
            with(eth_buy(), json!({"symbol": "PERP_DOGE_USDC"})),
            E_ASSET,
        ),
        (
            "an HL symbol",
            with(eth_buy(), json!({"symbol": "ETH"})),
            E_ASSET,
        ),
        ("no side", with(eth_buy(), json!({"side": null})), E_ARGS),
        (
            "side in lower case",
            with(eth_buy(), json!({"side": "buy"})),
            E_ARGS,
        ),
        (
            "no order_type",
            with(eth_buy(), json!({"order_type": null})),
            E_ARGS,
        ),
        (
            "a POST_ONLY order",
            with(eth_buy(), json!({"order_type": "POST_ONLY"})),
            E_ARGS,
        ),
        (
            "a MARKET order",
            with(eth_buy(), json!({"order_type": "MARKET"})),
            E_PRICE_BAND,
        ),
        ("no price", with(eth_buy(), json!({"price": null})), E_ARGS),
        (
            "no quantity",
            with(eth_buy(), json!({"quantity": null})),
            E_ARGS,
        ),
        (
            "a price with a leading zero",
            with(eth_buy(), json!({"price": "01212.89"})),
            E_DECIMAL,
        ),
        (
            "a price in exponent form",
            with(eth_buy(), json!({"price": "1.2e3"})),
            E_DECIMAL,
        ),
        (
            "a price of 0",
            with(eth_buy(), json!({"price": "0"})),
            E_DECIMAL,
        ),
        (
            "a quantity of 0",
            with(eth_buy(), json!({"quantity": "0"})),
            E_SIZE,
        ),
        (
            "a quantity with a trailing zero",
            with(eth_buy(), json!({"quantity": "0.0080"})),
            E_DECIMAL,
        ),
        // The contract sets every client_order_id; a caller's is refused, even the one it would set.
        (
            "a caller's client_order_id",
            with(eth_buy(), json!({"client_order_id": "my-order-1"})),
            E_ARGS,
        ),
        (
            "the contract's own client_order_id",
            with(eth_buy(), json!({"client_order_id": "g0"})),
            E_ARGS,
        ),
        (
            "a client_order_id on a cancel",
            json!({"kind": "cancel", "symbol": "PERP_ETH_USDC", "order_id": 1, "client_order_id": "g0"}),
            E_ARGS,
        ),
        (
            "a symbol on a positions read",
            json!({"kind": "positions", "symbol": "PERP_ETH_USDC"}),
            E_ARGS,
        ),
        (
            "a page on a holding read",
            json!({"kind": "holding", "page": 1}),
            E_ARGS,
        ),
        (
            "a price 5.1% over the oracle",
            with(eth_buy(), json!({"price": "1261.2"})),
            E_PRICE_BAND,
        ),
        (
            "over max_notional_usd",
            with(eth_buy(), json!({"quantity": "84"})),
            E_SIZE,
        ),
        (
            "a SOL sell far under its oracle price",
            with(
                eth_buy(),
                json!({"symbol": "PERP_SOL_USDC", "side": "SELL", "price": "1", "quantity": "1"}),
            ),
            E_PRICE_BAND,
        ),
        // Cancels.
        (
            "a cancel without order_id",
            json!({"kind": "cancel", "symbol": "PERP_ETH_USDC"}),
            E_ARGS,
        ),
        (
            "a cancel without symbol",
            json!({"kind": "cancel", "order_id": 1}),
            E_ARGS,
        ),
        (
            "a cancel of an HL symbol",
            json!({"kind": "cancel", "symbol": "ETH", "order_id": 1}),
            E_ARGS,
        ),
        (
            "a cancel_all of every symbol",
            json!({"kind": "cancel_all"}),
            E_ARGS,
        ),
        (
            "a cancel_all with a query in the symbol",
            json!({"kind": "cancel_all", "symbol": "PERP_ETH_USDC&x=1"}),
            E_ARGS,
        ),
        (
            "funding_fee_history of a lower-case symbol",
            json!({"kind": "funding_fee_history", "symbol": "perp_eth_usdc"}),
            E_ARGS,
        ),
        // The money path.
        (
            "settle_pnl without nonce",
            settle(json!({"nonce": null})),
            E_ARGS,
        ),
        (
            "settle_pnl without signed_at_ms",
            settle(json!({"signed_at_ms": null})),
            E_ARGS,
        ),
        (
            "settle_pnl without signature",
            settle(json!({"eip712_signature": null})),
            E_ARGS,
        ),
        (
            "a signature without 0x",
            settle(
                json!({"eip712_signature": "0057ad808089b4ae4068ae3d2e2039b8ade32cb84365780170a75fed8e4701d26c1e1967d0d318ef791cbed9e2c06d22bec290313bf1f1640ed32c33621d9bbf1c"}),
            ),
            E_ARGS,
        ),
        (
            "a signature with v 1",
            settle(
                json!({"eip712_signature": "0x0057ad808089b4ae4068ae3d2e2039b8ade32cb84365780170a75fed8e4701d26c1e1967d0d318ef791cbed9e2c06d22bec290313bf1f1640ed32c33621d9bbf01"}),
            ),
            E_ARGS,
        ),
        (
            "a 64-byte signature",
            settle(
                json!({"eip712_signature": "0x0057ad808089b4ae4068ae3d2e2039b8ade32cb84365780170a75fed8e4701d26c1e1967d0d318ef791cbed9e2c06d22bec290313bf1f1640ed32c33621d9bbf"}),
            ),
            E_ARGS,
        ),
        (
            "a signature that is not hex",
            settle(
                json!({"eip712_signature": "0xzz57ad808089b4ae4068ae3d2e2039b8ade32cb84365780170a75fed8e4701d26c1e1967d0d318ef791cbed9e2c06d22bec290313bf1f1640ed32c33621d9bbf1c"}),
            ),
            E_ARGS,
        ),
        (
            "an amount on settle_pnl",
            settle(json!({"amount": "5"})),
            E_ARGS,
        ),
        (
            "withdraw_request without amount",
            withdraw(json!({"amount": null})),
            E_ARGS,
        ),
        (
            "a withdrawal of 0",
            withdraw(json!({"amount": "0"})),
            E_SIZE,
        ),
        (
            "a withdrawal with 7 decimals",
            withdraw(json!({"amount": "1.0000001"})),
            E_DECIMAL,
        ),
        (
            "a withdrawal in raw units with a leading zero",
            withdraw(json!({"amount": "05000000"})),
            E_DECIMAL,
        ),
    ];
    for (name, fields, code) in &cases {
        let r = build_request(&ctx_at(&policy, Some("TESTCODE")), &req(fields.clone()));
        assert_eq!(refused(r).code, *code, "{name}");
    }

    // No referral code configured.
    let r = build_request(
        &ctx_at(&policy, None),
        &req(json!({"kind": "referral_bind"})),
    );
    assert_eq!(refused(r).code, E_ARGS);

    // An unpriced symbol: no band, the base-unit cap and the unpriced notional cap.
    let ctx = Context {
        reference: &no_price,
        ..ctx_at(&unpriced, None)
    };
    let ok = build_request(
        &ctx,
        &req(with(
            eth_buy(),
            json!({"price": "2000", "quantity": "0.01"}),
        )),
    )
    .unwrap();
    assert!(ok.order.unwrap().valued.unpriced());
    for (name, change, code) in [
        (
            "over max_sz",
            json!({"price": "1", "quantity": "0.01000001"}),
            E_SIZE,
        ),
        (
            "over the unpriced notional cap",
            json!({"price": "2000.01", "quantity": "0.01"}),
            E_SIZE,
        ),
    ] {
        let r = build_request(&ctx, &req(with(eth_buy(), change)));
        assert_eq!(refused(r).code, code, "{name}");
    }
    let sol = build_request(
        &ctx,
        &req(with(eth_buy(), json!({"symbol": "PERP_SOL_USDC"}))),
    );
    assert_eq!(refused(sol).code, E_ORACLE_STALE);
}

#[test]
fn what_each_request_allows() {
    let policy = vector_policy();
    let ctx = ctx_at(&policy, Some("TESTCODE"));
    let ttl = REQUEST_TTL_MS;
    // The window's edges.
    for ts in [BLOCK - ttl, BLOCK + MAX_AHEAD_MS] {
        build_request(&ctx, &req(with(eth_buy(), json!({"timestamp_ms": ts})))).unwrap();
        ws_auth(ts, BLOCK).unwrap();
    }
    assert_eq!(refused(ws_auth(BLOCK - ttl - 1, BLOCK)).code, E_ARGS);
    assert_eq!(
        refused(ws_auth(BLOCK + MAX_AHEAD_MS + 1, BLOCK)).code,
        E_ARGS
    );
    // A price at the band's edge.
    build_request(&ctx, &req(with(eth_buy(), json!({"price": "1260"})))).unwrap();
    // The client order id is the contract's, from the request id; a null one is no caller's id.
    let ctx41 = Context {
        request_id: 41,
        ..ctx_at(&policy, Some("TESTCODE"))
    };
    let s = build_request(&ctx41, &req(eth_buy())).unwrap();
    assert_eq!(
        s.body,
        r#"{"symbol":"PERP_ETH_USDC","client_order_id":"g41","order_type":"LIMIT","order_price":1212.89,"order_quantity":0.0087,"side":"BUY"}"#
    );
    // A null client_order_id (as the engine may send it) is no caller's id.
    let mut null_id = eth_buy();
    null_id["client_order_id"] = Value::Null;
    assert_eq!(build_request(&ctx41, &req(null_id)).unwrap().body, s.body);
    // The two snapshot reads: no fields, nothing in the query.
    let s = build_request(&ctx41, &req(json!({"kind": "positions"}))).unwrap();
    assert_eq!(
        (s.method, s.path.as_str(), s.body.as_str()),
        ("GET", "/v1/positions", "")
    );
    let s = build_request(&ctx41, &req(json!({"kind": "holding"}))).unwrap();
    assert_eq!(s.path, "/v1/client/holding");
    let s = build_request(&ctx41, &req(eth_buy())).unwrap();
    let order = s.order.unwrap();
    assert!(order.buy && !order.reduce_only);
    assert_eq!(order.valued.oracle_e8, Some(1_200 * E8));
    assert_eq!((order.px_e8, order.sz_e8), (121_289_000_000, 870_000));

    // Which requests a paused desk may send.
    let reduces = |fields: Value| build_request(&ctx, &req(fields)).unwrap().reduces_risk;
    assert!(!reduces(eth_buy()));
    assert!(reduces(with(
        eth_buy(),
        json!({"side": "SELL", "reduce_only": true})
    )));
    assert!(reduces(
        json!({"kind": "cancel", "symbol": "PERP_DOGE_USDC", "order_id": 1})
    ));
    assert!(reduces(
        json!({"kind": "cancel_all", "symbol": "PERP_DOGE_USDC"})
    ));
    for kind in [
        "receiver_address",
        "settle_nonce",
        "withdraw_nonce",
        "funding_fee_history",
        "positions",
        "holding",
    ] {
        assert!(reduces(json!({ "kind": kind })), "{kind}");
    }
    assert!(!reduces(settle(json!({}))));
    assert!(!reduces(withdraw(json!({}))));
    assert!(!reduces(json!({"kind": "referral_bind"})));

    // funding_fee_history writes only the parameters set, in Orderly's order.
    let s = build_request(&ctx, &req(json!({"kind": "funding_fee_history"}))).unwrap();
    assert_eq!(s.path, "/v1/funding_fee/history");
    let s = build_request(
        &ctx,
        &req(json!({"kind": "funding_fee_history", "size": 5, "symbol": "PERP_DOGE_USDC"})),
    )
    .unwrap();
    assert_eq!(
        s.path,
        "/v1/funding_fee/history?symbol=PERP_DOGE_USDC&size=5"
    );

    // The withdrawal amount is a decimal in, raw units in the message.
    let s = build_request(&ctx, &req(withdraw(json!({"amount": "1234.56789"})))).unwrap();
    assert_eq!(s.amount.as_deref(), Some("1234.56789"));
    assert!(s.body.contains(r#""amount":"1234567890""#), "{}", s.body);

    // Unknown fields do not deserialize.
    let r: Result<OrderlyRequest, _> =
        serde_json::from_value(json!({"kind": "order", "timestamp_ms": 1, "body": "{}"}));
    assert!(r.is_err());
    let r: Result<OrderlyRequest, _> = serde_json::from_value(json!({"kind": "order"}));
    assert!(r.is_err(), "timestamp_ms is required");
}

#[test]
fn eip712_refusals() {
    let authority = [7u8; 32];
    // Registration nonces: the digits Orderly sends, nothing else.
    for nonce in [
        "",
        "0123",
        "12a",
        "-1",
        "+1",
        " 1",
        "1.0",
        "18446744073709551616",
    ] {
        let r = Message::registration(nonce, BLOCK);
        assert_eq!(refused(r).code, E_ARGS, "{nonce:?}");
    }
    for (nonce, want) in [("0", 0), ("18446744073709551615", u64::MAX)] {
        assert_eq!(
            Message::registration(nonce, BLOCK).unwrap(),
            Message::Registration {
                timestamp: BLOCK,
                registration_nonce: want,
            }
        );
    }
    // Key expiry: after the block, at most 365 days on.
    for expiration in [
        0,
        BLOCK - 1,
        BLOCK,
        BLOCK + MAX_KEY_LIFETIME_MS + 1,
        u64::MAX,
    ] {
        let r = Message::add_orderly_key(&authority, expiration, BLOCK);
        assert_eq!(refused(r).code, E_ARGS, "{expiration}");
    }
    for expiration in [BLOCK + 1, BLOCK + MAX_KEY_LIFETIME_MS] {
        let m = Message::add_orderly_key(&authority, expiration, BLOCK).unwrap();
        assert_eq!(m.timestamp(), BLOCK);
    }
    // Withdraw amounts.
    let to = [0x11u8; 20];
    for (amount, code) in [
        ("0", E_SIZE),
        ("0.0000001", E_DECIMAL),
        ("1.10", E_DECIMAL),
        ("", E_DECIMAL),
        ("1e3", E_DECIMAL),
    ] {
        assert_eq!(
            refused(Message::withdraw(to, amount, 1, BLOCK)).code,
            code,
            "{amount}"
        );
    }
    let m = Message::withdraw(to, "0.000001", 1, BLOCK).unwrap();
    assert!(matches!(m, Message::Withdraw { amount_e6: 1, .. }));
}
