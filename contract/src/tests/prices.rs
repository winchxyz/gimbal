//! Oracle prices on the mocked chain: `set_mock_price`, `refresh_prices` and both oracle paths
//! (`request_price_data` → `on_prices`, and the `oracle_call` fallback → `oracle_on_call`),
//! `prices()`, and the `order_policy` rows of `core/tests/vectors/hl.json` against stored prices.

use super::hl::{at, hl_desk_with, hl_policy, unpriced};
use super::*;
use crate::prices::{
    OraclePriceData, PriceRow, ON_PRICES_GAS, ORACLE_CALL_GAS, ORACLE_DEPOSIT,
    REFRESH_PRICES_MIN_GAS, REQUEST_PRICE_DATA_GAS,
};
use gimbal_core::errors::E_ORACLE_STALE;
use gimbal_core::hl::HlOrder;

fn outlayer() -> Gimbal {
    testnet_with(PriceSource::OutLayer {
        contract: oracle_id(),
    })
}

/// An OutLayer contract with desk `alpha` of `owner()`.
fn outlayer_desk() -> Gimbal {
    let mut g = outlayer();
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    g
}

/// A call from `who` with `gas` prepaid and no deposit.
fn call_with_gas_by(who: AccountId, gas: Gas) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who)
        .prepaid_gas(gas)
        .build());
}

/// The function calls of the last call with their deposits: (receiver, method, args, gas,
/// weight, deposit).
fn calls_with_deposits() -> Vec<(AccountId, String, Value, Gas, u64, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    prepaid_gas,
                    gas_weight,
                    attached_deposit,
                    ..
                } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap(),
                    prepaid_gas,
                    gas_weight.0,
                    attached_deposit,
                )),
                _ => None,
            })
        })
        .collect()
}

/// A `PriceData` answer at `timestamp_ns`: WASI prices (8 decimals) of ETH 2500 and BTC 81250,
/// plus what the contract skips: an asset it does not track, a null price and a Burrow-form price.
fn answer_at(timestamp_ns: u64) -> Value {
    json!({
        "timestamp": timestamp_ns.to_string(),
        "recency_duration_sec": 90,
        "prices": [
            { "asset_id": "eth.bridge.near", "price": { "multiplier": "250000000000", "decimals": 8 } },
            { "asset_id": "nbtc.bridge.near", "price": { "multiplier": 8125000000000u64, "decimals": 8 } },
            { "asset_id": "wrap.near", "price": { "multiplier": "300000000", "decimals": 8 } },
            { "asset_id": "doge.omft.near", "price": null },
            { "asset_id": "ltc.omft.near", "price": { "multiplier": "79000000", "decimals": 12 } },
        ],
    })
}

/// 2026-11-01T00:00:00Z less 10 s, in ns: the `order_policy` rows' ETH and BTC time.
const ANSWER_NS: u64 = 1_793_491_190_000_000_000;

fn row(asset: &str, price_e8: u64, at_ms: u64) -> PriceRow {
    PriceRow {
        asset: asset.into(),
        price_e8,
        at_ms,
    }
}

fn mock_price(g: &mut Gimbal, asset: &str, price_e8: u64, at_ms: u64) {
    at(contract_id(), at_ms, yocto(1));
    g.set_mock_price(asset.into(), price_e8);
}

// --- set_mock_price, prices() ---

#[test]
fn set_mock_price_stores_at_the_block_time_and_prices_lists_rows_by_asset() {
    let mut g = testnet();
    assert_eq!(g.prices(), vec![]);
    mock_price(&mut g, "SOL", 10_380_000_000, 1_793_490_899_000);
    assert_eq!(
        get_logs(),
        vec![event(
            "prices",
            r#"{"asset":"SOL","price_e8":10380000000,"at_ms":1793490899000}"#
        )]
    );
    mock_price(&mut g, "ETH", 250_000_000_000, 1_793_491_190_000);
    mock_price(&mut g, "BTC", 8_125_000_000_000, 1_793_491_190_000);
    let rows = vec![
        row("BTC", 8_125_000_000_000, 1_793_491_190_000),
        row("ETH", 250_000_000_000, 1_793_491_190_000),
        row("SOL", 10_380_000_000, 1_793_490_899_000),
    ];
    assert_eq!(g.prices(), rows);
    assert_eq!(
        serde_json::to_value(g.prices()).unwrap()[0],
        json!({ "asset": "BTC", "price_e8": 8_125_000_000_000u64, "at_ms": 1_793_491_190_000u64 })
    );
    // A later mock price replaces the stored one, older or not.
    mock_price(&mut g, "ETH", 240_000_000_000, 1_793_491_100_000);
    assert_eq!(
        g.prices()[1],
        row("ETH", 240_000_000_000, 1_793_491_100_000)
    );
}

#[test]
fn set_mock_price_is_the_contract_accounts_with_one_yocto_and_mock_only() {
    let mut g = testnet();
    for who in [owner(), operator(), oracle_id()] {
        at(who, 1, yocto(1));
        assert_refused(
            "E_NOT_ALLOWED: set_mock_price is the contract account's",
            || g.set_mock_price("ETH".into(), 1),
        );
    }
    for deposit in [yocto(0), yocto(2)] {
        at(contract_id(), 1, deposit);
        assert_refused(
            "E_NOT_ALLOWED: set_mock_price needs exactly 1 yoctoNEAR",
            || g.set_mock_price("ETH".into(), 1),
        );
    }
    for (asset, price, expected) in [
        ("HYPE", 1, "E_ASSET: "),
        ("eth", 1, "E_ASSET: "),
        ("ETH", 0, "E_ARGS: price_e8 0 is not 1 to 2^53 - 1"),
        (
            "ETH",
            1 << 53,
            "E_ARGS: price_e8 9007199254740992 is not 1 to 2^53 - 1",
        ),
    ] {
        at(contract_id(), 1, yocto(1));
        assert_refused(expected, || g.set_mock_price(asset.into(), price));
    }
    mock_price(&mut g, "DOGE", (1 << 53) - 1, 5);
    mock_price(&mut g, "LTC", 1, 5);
    assert_eq!(g.prices().len(), 2);

    let mut g = outlayer();
    at(contract_id(), 1, yocto(1));
    assert_refused("E_ARGS: prices come from the oracle", || {
        g.set_mock_price("ETH".into(), 1)
    });
    assert_eq!(g.prices(), vec![]);
}

// --- refresh_prices ---

#[test]
fn refresh_prices_asks_the_oracle_on_the_contracts_deposit_then_on_prices() {
    let mut g = outlayer_desk();
    call_with_gas_by(owner(), Gas::from_tgas(300));
    g.refresh_prices(vec!["ETH".into(), "BTC".into()]).detach();
    let calls = calls_with_deposits();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(
        calls[0],
        (
            oracle_id(),
            "request_price_data".into(),
            json!({ "asset_ids": ["eth.bridge.near", "nbtc.bridge.near"] }),
            REQUEST_PRICE_DATA_GAS,
            1,
            ORACLE_DEPOSIT,
        )
    );
    assert_eq!(ORACLE_DEPOSIT, NearToken::from_millinear(20));
    assert_eq!(
        calls[1],
        (
            contract_id(),
            "on_prices".into(),
            json!({ "assets": ["ETH", "BTC"] }),
            ON_PRICES_GAS,
            0,
            yocto(0),
        )
    );
    // All five symbols, each mapped to its OutLayer asset id.
    call_with_gas_by(contract_id(), REFRESH_PRICES_MIN_GAS);
    g.refresh_prices(
        ["SOL", "LTC", "DOGE", "ETH", "BTC"]
            .map(String::from)
            .to_vec(),
    )
    .detach();
    assert_eq!(
        calls_with_deposits()[0].2,
        json!({ "asset_ids": [
            "22.contract.portalbridge.near",
            "ltc.omft.near",
            "doge.omft.near",
            "eth.bridge.near",
            "nbtc.bridge.near",
        ] })
    );
}

#[test]
fn refresh_prices_refuses_bad_symbols_strangers_little_gas_and_the_mock_source() {
    let mut g = outlayer_desk();
    for (assets, expected) in [
        (vec![], "E_ARGS: "),
        (vec!["ETH", "ETH"], "E_ARGS: "),
        (vec!["ETH", "BTC", "SOL", "LTC", "DOGE", "ETH"], "E_ARGS: "),
        (vec!["HYPE"], "E_ASSET: "),
        (vec!["eth.bridge.near"], "E_ASSET: "),
    ] {
        call_with_gas_by(owner(), Gas::from_tgas(300));
        let assets = assets.into_iter().map(String::from).collect();
        assert_refused(expected, || {
            g.refresh_prices(assets).detach();
        });
    }
    for who in [operator(), stranger(), oracle_id()] {
        call_with_gas_by(who, Gas::from_tgas(300));
        assert_refused("E_NOT_ALLOWED: ", || {
            g.refresh_prices(vec!["ETH".into()]).detach();
        });
    }
    call_with_gas_by(
        owner(),
        REFRESH_PRICES_MIN_GAS.saturating_sub(Gas::from_gas(1)),
    );
    assert_refused("E_ARGS: refresh_prices needs at least 285 TGas", || {
        g.refresh_prices(vec!["ETH".into()]).detach();
    });

    let mut g = testnet();
    call_with_gas_by(contract_id(), Gas::from_tgas(300));
    assert_refused("E_ARGS: the price source is Mock", || {
        g.refresh_prices(vec!["ETH".into()]).detach();
    });
}

// --- the oracle's answers ---

/// `on_prices` with the oracle's answer `result`, prepaid what `refresh_prices` gives it.
fn on_prices_with(g: &mut Gimbal, result: PromiseResult, assets: &[&str]) -> PromiseOrValue<bool> {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .signer_account_id(owner())
            .prepaid_gas(ON_PRICES_GAS)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    g.on_prices(assets.iter().map(|s| s.to_string()).collect())
}

fn value(r: PromiseOrValue<bool>) -> bool {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("a value, not a promise"),
    }
}

fn successful(v: &Value) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(v).unwrap())
}

#[test]
fn on_prices_stores_the_usd_prices_of_the_answer_and_says_whether_all_came() {
    let mut g = outlayer();
    let answer = successful(&answer_at(ANSWER_NS));
    assert!(value(on_prices_with(&mut g, answer, &["ETH", "BTC"])));
    let at_ms = ANSWER_NS / 1_000_000;
    assert_eq!(
        g.prices(),
        vec![
            row("BTC", 8_125_000_000_000, at_ms),
            row("ETH", 250_000_000_000, at_ms)
        ]
    );
    let logs = get_logs();
    assert_eq!(
        logs.last().unwrap(),
        &event(
            "prices",
            r#"{"asset":"BTC","price_e8":8125000000000,"at_ms":1793491190000},{"asset":"ETH","price_e8":250000000000,"at_ms":1793491190000}"#
        )
    );
    assert!(logs.contains(&r#"no USD price for "doge.omft.near" in the oracle's answer"#.into()));
    assert!(logs.contains(&r#"no USD price for "ltc.omft.near" in the oracle's answer"#.into()));

    // DOGE has no price in the answer, so the result is false; ETH is kept as it was.
    let answer = successful(&answer_at(ANSWER_NS));
    assert!(!value(on_prices_with(&mut g, answer, &["ETH", "DOGE"])));
    // An older answer never replaces a newer price, and logs no row.
    let mut old = answer_at(ANSWER_NS - 1_000_000);
    old["prices"][0]["price"]["multiplier"] = json!("1");
    assert!(value(on_prices_with(&mut g, successful(&old), &["ETH"])));
    assert_eq!(g.prices()[1], row("ETH", 250_000_000_000, at_ms));
    assert!(!get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"prices\"")));
    // A newer one does.
    let mut new = answer_at(ANSWER_NS + 60_000_000_000);
    new["prices"][0]["price"]["multiplier"] = json!("251000000000");
    assert!(value(on_prices_with(&mut g, successful(&new), &["ETH"])));
    assert_eq!(g.prices()[1], row("ETH", 251_000_000_000, at_ms + 60_000));
    // An answer that is not PriceData stores nothing.
    let junk = successful(&json!({ "prices": [] }));
    let r = on_prices_with(&mut g, junk, &["ETH"]);
    assert!(matches!(r, PromiseOrValue::Promise(_)), "falls back");
}

#[test]
fn when_request_price_data_fails_on_prices_falls_back_to_oracle_call() {
    let mut g = outlayer();
    match on_prices_with(&mut g, PromiseResult::Failed, &["ETH", "SOL"]) {
        PromiseOrValue::Promise(p) => p.detach(),
        PromiseOrValue::Value(v) => panic!("a fallback, not {v}"),
    }
    let calls = calls_with_deposits();
    assert_eq!(
        calls,
        vec![(
            oracle_id(),
            "oracle_call".into(),
            json!({
                "receiver_id": contract_id(),
                "asset_ids": ["eth.bridge.near", "22.contract.portalbridge.near"],
                "msg": "ETH,SOL",
            }),
            ORACLE_CALL_GAS,
            0,
            ORACLE_DEPOSIT,
        )]
    );
    assert_eq!(ORACLE_CALL_GAS, Gas::from_tgas(200));
    assert_eq!(g.prices(), vec![]);

    // With too little gas left for the fallback the callback just ends false.
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .prepaid_gas(Gas::from_tgas(204))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!value(g.on_prices(vec!["ETH".into()])));
    assert!(calls_with_deposits().is_empty());
}

#[test]
fn oracle_on_call_is_the_oracles_answer_to_the_contracts_own_call() {
    let mut g = outlayer();
    let data: OraclePriceData = serde_json::from_value(answer_at(ANSWER_NS)).unwrap();
    for who in [owner(), contract_id(), stranger()] {
        called_by(who);
        assert_refused(
            "E_NOT_ALLOWED: oracle_on_call is the price oracle's",
            || {
                g.oracle_on_call(contract_id(), data.clone(), "ETH".into());
            },
        );
    }
    called_by(oracle_id());
    assert_refused(
        "E_NOT_ALLOWED: oracle_on_call answers the contract's own oracle_call",
        || {
            g.oracle_on_call(stranger(), data.clone(), "ETH".into());
        },
    );
    assert_eq!(g.prices(), vec![]);
    called_by(oracle_id());
    assert!(g.oracle_on_call(contract_id(), data.clone(), "ETH,BTC".into()));
    assert_eq!(g.prices().len(), 2);
    called_by(oracle_id());
    assert!(!g.oracle_on_call(contract_id(), data, "ETH,DOGE".into()));

    // With the Mock source no account is the oracle.
    let mut g = testnet();
    called_by(oracle_id());
    let data: OraclePriceData = serde_json::from_value(answer_at(ANSWER_NS)).unwrap();
    assert_refused("E_NOT_ALLOWED: ", || {
        g.oracle_on_call(contract_id(), data, "ETH".into());
    });
}

// --- orders against stored prices ---

/// The `order_policy` desk: [`hl_policy`] with the rows' 2 % band.
fn order_policy_desk() -> Gimbal {
    let mut g = hl_desk_with(Policy {
        price_band_bps: 200,
        ..hl_policy()
    });
    let v = super::hl::vectors();
    for (symbol, p) in v["order_policy"]["oracle_by_symbol"].as_object().unwrap() {
        let price_e8: u64 = p["price_e8"].as_str().unwrap().parse().unwrap();
        mock_price(&mut g, symbol, price_e8, p["at_ms"].as_u64().unwrap());
    }
    g
}

#[test]
fn every_order_policy_row_against_the_stored_prices() {
    let v = super::hl::vectors();
    let op = &v["order_policy"];
    assert_eq!(op["policy"]["price_band_bps"], 200);
    let now_ms = op["now_ms"].as_u64().unwrap();
    let mut g = order_policy_desk();
    let mut rows = 0;
    for c in op["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let order: HlOrder = serde_json::from_value(c["order"].clone()).unwrap();
        at(operator(), now_ms, yocto(0));
        let expect = &c["expect"];
        if expect["ok"] == true {
            let got = g.prepare_hl_order("alpha".into(), order, "row".into());
            let detail = &got.orders[0];
            assert_eq!(json!(detail.unpriced), expect["unpriced"], "{name}");
            assert_eq!(detail.oracle_px.is_none(), detail.unpriced, "{name}");
        } else {
            let code = expect["code"].as_str().unwrap();
            assert_refused(&format!("{code}: "), || {
                g.prepare_hl_order("alpha".into(), order, "row".into());
            });
        }
        rows += 1;
    }
    assert_eq!(rows, 22);
}

#[test]
fn an_order_is_valued_at_the_stored_price_and_refused_once_it_is_stale() {
    let mut g = order_policy_desk();
    let now = 1_793_491_200_000;
    at(operator(), now, yocto(0));
    let got = g.prepare_hl_order("alpha".into(), order(1, "2500.5", "0.1"), "x".into());
    assert_eq!(got.orders[0].oracle_px.as_deref(), Some("2500"));
    assert!(!got.orders[0].unpriced);
    // ETH was stored at now − 10 s; at the 300 s edge it still passes, 1 ms later it is stale.
    at(operator(), now + 290_000, yocto(0));
    g.prepare_hl_order("alpha".into(), order(1, "2500", "0.1"), "x".into());
    at(operator(), now + 290_001, yocto(0));
    assert_refused(&format!("{E_ORACLE_STALE}: "), || {
        g.prepare_hl_order("alpha".into(), order(1, "2500", "0.1"), "x".into());
    });
    // A fresh price makes it pass again, against the new band.
    mock_price(&mut g, "ETH", 260_000_000_000, now + 290_001);
    at(operator(), now + 290_001, yocto(0));
    assert_refused("E_PRICE_BAND: ", || {
        g.prepare_hl_order("alpha".into(), order(1, "2500", "0.1"), "x".into());
    });
    g.prepare_hl_order("alpha".into(), order(1, "2600", "0.1"), "x".into());
}

fn order(asset: u32, px: &str, sz: &str) -> HlOrder {
    super::hl::order(asset, px, sz)
}

/// `unpriced` is the owner's alone: the operator cannot list a symbol there to skip the band, and
/// the desk keeps refusing the unpriced order.
#[test]
fn the_operator_cannot_add_to_unpriced() {
    let mut g = with_desk();
    let mut p = policy();
    p.hl_assets.push(HlAsset {
        index: 12,
        symbol: "DOGE".into(),
        sz_decimals: 0,
    });
    p.unpriced = vec![unpriced("DOGE", "100")];
    call(operator(), storage_deposit());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.set_policy("alpha".into(), p.clone())
    });
    called_by(operator());
    assert_refused("E_NOT_ALLOWED: ", || {
        g.set_policy("alpha".into(), p.clone())
    });
    assert!(g
        .get_desk("alpha".into())
        .unwrap()
        .policy
        .unpriced
        .is_empty());
    // The owner can.
    call(owner(), storage_deposit());
    g.set_policy("alpha".into(), p);
    assert_eq!(
        g.get_desk("alpha".into()).unwrap().policy.unpriced,
        vec![unpriced("DOGE", "100")]
    );
}

#[test]
fn an_unknown_symbol_has_no_price_and_needs_unpriced() {
    let mut g = hl_desk_with(hl_policy());
    at(operator(), 1_793_491_200_000, yocto(0));
    assert_refused(
        "E_ORACLE_STALE: no oracle price for DOGE younger than 300 s, and DOGE is not in policy.unpriced",
        || {
            g.prepare_hl_order("alpha".into(), order(12, "0.2", "100"), "x".into());
        },
    );
    // HYPE has no oracle asset at all; listed in unpriced it signs, capped by the unpriced cap.
    let got = g.prepare_hl_order("alpha".into(), super::hl::hype(), "x".into());
    assert!(got.orders[0].unpriced);
    assert_eq!(got.orders[0].oracle_px, None);
}
