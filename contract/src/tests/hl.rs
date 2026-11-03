//! The Hyperliquid action methods on the mocked chain: the bytes they hand the MPC are the
//! venue SDKs' vectors (`core/tests/vectors/hl.json`, testnet rows, as these tests run a testnet
//! contract), and every guard and refusal on the way.

use super::*;
use crate::action::UnsignedAction;
use gimbal_core::errors::E_NO_DESK;
use gimbal_core::hl::HlOrder;

/// The vectors sign for the address of test key 0x01…01; no MPC answer in these tests gives it, so
/// the desk on it is written straight into the map.
pub(super) const VECTOR_DESK_EVM: &str = "0x1a642f0e3c3af545e7acbd38b07251b3990914f1";
/// A block time in the vectors' range (ms).
const T: u64 = 1_793_491_200_000;

pub(super) fn vectors() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/hl.json")).unwrap()
}

/// The vector case called `name` in `section`.
fn case(section: &str, name: &str) -> Value {
    vectors()[section]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no {section} case {name:?}"))
        .clone()
}

pub(super) fn unpriced(symbol: &str, max_sz: &str) -> UnpricedAsset {
    UnpricedAsset {
        symbol: symbol.into(),
        max_sz: max_sz.into(),
    }
}

/// The `order_policy` vectors' assets: BTC 0, ETH 1, SOL 5, DOGE 12, and HYPE 159 unpriced (up to
/// 3 HYPE per order).
pub(super) fn hl_policy() -> Policy {
    let asset = |index, symbol: &str, sz_decimals| HlAsset {
        index,
        symbol: symbol.into(),
        sz_decimals,
    };
    Policy {
        hl_assets: vec![
            asset(0, "BTC", 5),
            asset(1, "ETH", 4),
            asset(5, "SOL", 2),
            asset(12, "DOGE", 0),
            asset(159, "HYPE", 2),
        ],
        max_notional_usd: 1000,
        oracle_max_age_s: 300,
        unpriced: vec![unpriced("HYPE", "3")],
        unpriced_max_notional_usd: 100,
        ..policy()
    }
}

/// A testnet contract with desk `alpha` of `owner()` on the vectors' desk address, operator
/// `operator()`.
fn hl_desk() -> Gimbal {
    hl_desk_with(hl_policy())
}

pub(super) fn hl_desk_with(policy: Policy) -> Gimbal {
    let mut g = testnet();
    let mut desk = Desk::new(
        owner(),
        policy,
        VECTOR_DESK_EVM.into(),
        solana(),
        "woofi_dex",
    );
    desk.operator = Some(operator());
    g.desks.insert("alpha".into(), desk);
    g
}

/// A call from `who` at block time `ms` with `deposit` attached.
pub(super) fn at(who: AccountId, ms: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(ms * 1_000_000)
        .build());
}

pub(super) fn order(asset: u32, px: &str, sz: &str) -> HlOrder {
    HlOrder {
        asset,
        is_buy: true,
        px: px.into(),
        sz: sz.into(),
        reduce_only: false,
        tif: "Ioc".into(),
        cloid: None,
    }
}

/// A priced order: refused (`E_ORACLE_STALE`) while no ETH price is stored.
fn eth() -> HlOrder {
    order(1, "2500", "0.1")
}

/// An unpriced order that fits the policy: 99.75 USD of HYPE, which signs without an oracle price.
pub(super) fn hype() -> HlOrder {
    order(159, "39.9", "2.5")
}

fn sha256_hex(s: &str) -> String {
    hex::encode(env::sha256_array(s))
}

/// `got` is what the vector signs: the `/exchange` body without its signature, and its digest as
/// the MPC request for the desk's EVM key.
fn assert_signs(got: &UnsignedAction, kind: &str, digest: &Value, exchange_body: &Value) {
    let mut body = exchange_body.clone();
    body.as_object_mut().unwrap().remove("signature");
    assert_eq!(got.desk_id, "alpha");
    assert_eq!(
        (got.venue.as_str(), got.kind.as_str()),
        ("hyperliquid", kind)
    );
    assert_eq!(serde_json::to_value(&got.payload).unwrap(), body);
    assert_eq!(
        serde_json::to_value(&got.sign_request).unwrap(),
        json!({
            "path": "gimbal/alpha/evm",
            "payload_v2": { "Ecdsa": digest.as_str().unwrap().strip_prefix("0x").unwrap() },
            "domain_id": 0,
        })
    );
}

/// The L1 vector `name` on testnet.
fn assert_signs_l1(got: &UnsignedAction, kind: &str, name: &str) {
    let c = case("l1", name);
    assert_signs(
        got,
        kind,
        &c["testnet"]["digest"],
        &c["testnet"]["exchange_body"],
    );
}

/// The L1 vector `name` on testnet as an order or cancel the contract builds at `block_ms`: the
/// vector's body plus `expiresAfter` = block time + 60 s after `vaultAddress`, and the digest of
/// that action with that expiry (the core pins the encoding against the venue SDK's layout,
/// `expires_after_enters_the_l1_hash_as_the_sdk_writes_it`), never the vector's own digest.
fn assert_signs_l1_expiring(got: &UnsignedAction, kind: &str, name: &str, block_ms: u64) {
    let c = case("l1", name);
    let expires = block_ms + gimbal_core::hl::EXPIRES_AFTER_MS;
    let mut body = c["testnet"]["exchange_body"].clone();
    body.as_object_mut().unwrap().remove("signature");
    body["expiresAfter"] = json!(expires);
    assert_eq!(
        (got.desk_id.as_str(), got.venue.as_str(), got.kind.as_str()),
        ("alpha", "hyperliquid", kind)
    );
    assert_eq!(serde_json::to_value(&got.payload).unwrap(), body);
    let gimbal_core::msgpack::Value::Map(entries) = &got.payload else {
        panic!("the payload is a map")
    };
    assert_eq!(
        entries.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        ["action", "nonce", "vaultAddress", "expiresAfter"]
    );
    let want = gimbal_core::hl::prepare_l1(
        crate::hl::keccak,
        Network::Testnet,
        "x",
        got.payload.get("action").unwrap().clone(),
        c["nonce"].as_u64().unwrap(),
        Some(expires),
    );
    assert_eq!(
        got.sign_request,
        crate::mpc::SignRequest::evm("alpha", &want.digest)
    );
    let vector_digest = c["testnet"]["digest"].as_str().unwrap();
    assert_ne!(format!("0x{}", hex::encode(want.digest)), vector_digest);
}

/// The user-signed vector `name`.
fn assert_signs_user(got: &UnsignedAction, kind: &str, name: &str) {
    let c = case("user_signed", name);
    assert_eq!(c["network"], "testnet");
    assert_signs(got, kind, &c["digest"], &c["exchange_body"]);
}

fn nonce_of(desk_id: &str, g: &Gimbal) -> u64 {
    g.hl_nonces.get(desk_id).copied().unwrap_or(0)
}

// --- hl_order ---

#[test]
fn hl_order_signs_the_vector_bytes() {
    // The l1 vectors price their orders with no one oracle price in mind, so their assets are
    // listed as unpriced here, with caps none of their orders reach; `tests::prices` runs the
    // priced `order_policy` rows against stored prices.
    let mut p = hl_policy();
    p.unpriced = ["BTC", "ETH", "SOL", "DOGE"]
        .iter()
        .map(|s| unpriced(s, "1000"))
        .collect();
    p.unpriced_max_notional_usd = 1000;
    let mut g = hl_desk_with(p);
    let mut signed = 0;
    for c in vectors()["l1"]["cases"].as_array().unwrap() {
        let p = &c["params"];
        // The contract's builder and fee are the config's: 1 bp to 0x5050…3c9c.
        if c["kind"] != "order" || p["builder_fee_tenth_bps"] != 10 {
            continue;
        }
        let order: HlOrder = serde_json::from_value(json!({
            "asset": p["asset"], "is_buy": p["is_buy"], "px": p["px"], "sz": p["sz"],
            "reduce_only": p["reduce_only"], "tif": p["tif"], "cloid": p["cloid"],
        }))
        .unwrap();
        at(operator(), c["nonce"].as_u64().unwrap(), yocto(0));
        let reason = format!("vector {}", c["name"]);
        let got = g.prepare_hl_order("alpha".into(), order, reason.clone());
        let nonce = c["nonce"].as_u64().unwrap();
        assert_signs_l1_expiring(&got, "order", c["name"].as_str().unwrap(), nonce);
        assert_eq!(got.reason_sha256, Some(sha256_hex(&reason)));
        signed += 1;
    }
    assert_eq!(signed, 9, "every 1 bp order in the vectors");
}

#[test]
fn hl_order_refuses_what_the_policy_does_not_allow() {
    let mut g = hl_desk();
    let mut bad_tif = eth();
    bad_tif.tif = "FrontendMarket".into();
    let mut bad_cloid = eth();
    bad_cloid.cloid = Some("0x0123456789abcdef0123456789abcd".into());
    for (o, expected) in [
        (
            order(7, "10", "1"),
            "E_ASSET: Hyperliquid asset 7 is not in the desk's policy",
        ),
        (bad_tif, "E_ARGS: tif "),
        (bad_cloid, "E_ARGS: cloid "),
        (order(1, "2500.50", "0.1"), "E_DECIMAL: px "),
        (order(1, "2500.125", "0.1"), "E_DECIMAL: px "),
        (order(0, "81250.5", "0.001"), "E_DECIMAL: px "),
        (order(1, "2500", "0.12345"), "E_DECIMAL: sz "),
        (order(1, "2500", "0"), "E_SIZE: sz is zero"),
        (
            order(159, "50", "3"),
            "E_SIZE: HYPE 50 x 3 = 150 USD is over the unpriced cap",
        ),
        (
            order(159, "1", "3.01"),
            "E_SIZE: HYPE size 3.01 is over its max_sz 3",
        ),
    ] {
        at(operator(), T, yocto(0));
        assert_refused(expected, || {
            g.prepare_hl_order("alpha".into(), o, "enter".into());
        });
    }
    at(operator(), T, yocto(0));
    assert_refused("E_ARGS: reason has 281 characters, over 280", || {
        g.prepare_hl_order("alpha".into(), hype(), "x".repeat(281));
    });
    assert_eq!(nonce_of("alpha", &g), 0, "a refused order takes no nonce");
    // The unpriced cap itself passes.
    g.prepare_hl_order("alpha".into(), order(159, "40", "2.5"), "x".repeat(280));
    g.prepare_hl_order("alpha".into(), order(159, "33.33", "3"), String::new());
}

/// With no price stored every priced order is refused, whatever its size and side: the oversize
/// order and the tiny-price sell of the C3 review included.
#[test]
fn a_priced_order_is_refused_without_a_stored_price() {
    let mut g = hl_desk();
    let mut tiny_sell = order(1, "1", "1000");
    tiny_sell.is_buy = false;
    let mut close = eth();
    close.reduce_only = true;
    for o in [eth(), order(1, "2500", "0.4001"), tiny_sell, close] {
        at(operator(), T, yocto(0));
        assert_refused(
            "E_ORACLE_STALE: no oracle price for ETH younger than 300 s, and ETH is not in policy.unpriced",
            || {
                g.prepare_hl_order("alpha".into(), o, "enter".into());
            },
        );
    }
    assert_eq!(nonce_of("alpha", &g), 0);
}

#[test]
fn a_reduce_only_order_passes_a_paused_desk_and_nothing_else_does() {
    let mut g = hl_desk();
    at(operator(), T, yocto(0));
    g.set_paused("alpha".into(), true);
    let paused = "E_PAUSED: desk alpha is paused";
    for who in [owner(), operator()] {
        at(who, T, yocto(0));
        assert_refused(paused, || {
            g.prepare_hl_order("alpha".into(), eth(), "open".into());
        });
        assert_refused(paused, || {
            g.prepare_hl_order("alpha".into(), hype(), "open".into());
        });
        let mut close = hype();
        close.reduce_only = true;
        close.is_buy = false;
        let got = g.prepare_hl_order("alpha".into(), close, "panic close".into());
        let payload = serde_json::to_value(&got.payload).unwrap();
        assert_eq!(payload["action"]["orders"][0]["r"], true);
        assert_refused(paused, || {
            g.prepare_hl_set_referrer("alpha".into());
        });
        assert_refused(paused, || {
            g.prepare_hl_approve_builder_fee("alpha".into());
        });
        assert_refused(paused, || {
            g.prepare_hl_usd_class_transfer("alpha".into(), "5".into(), true, "margin".into());
        });
    }
    // The owner's emergency withdrawal works on a paused desk.
    at(owner(), T, ONE_YOCTO);
    g.prepare_hl_withdraw("alpha".into(), "10".into());
}

#[test]
fn hl_actions_are_for_the_owner_and_the_operator() {
    let mut g = hl_desk();
    at(stranger(), T, yocto(0));
    let stranger_refused =
        "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha";
    assert_refused(stranger_refused, || {
        g.prepare_hl_order("alpha".into(), eth(), "x".into());
    });
    assert_refused(stranger_refused, || {
        g.prepare_hl_set_referrer("alpha".into());
    });
    assert_refused(stranger_refused, || {
        g.prepare_hl_approve_builder_fee("alpha".into());
    });
    assert_refused(stranger_refused, || {
        g.prepare_hl_usd_class_transfer("alpha".into(), "5".into(), true, "x".into());
    });
    at(owner(), T, yocto(0));
    assert_refused(&format!("{E_NO_DESK}: no desk "), || {
        g.prepare_hl_order("bravo".into(), eth(), "x".into());
    });
    // The owner's FunctionCall key (no deposit) reaches every operator method.
    g.prepare_hl_order("alpha".into(), hype(), "x".into());
    g.prepare_hl_set_referrer("alpha".into());
    g.prepare_hl_approve_builder_fee("alpha".into());
    g.prepare_hl_usd_class_transfer("alpha".into(), "5".into(), true, "x".into());
    assert_eq!(nonce_of("alpha", &g), T + 3);
}

#[test]
fn every_action_takes_the_next_nonce_of_its_desk() {
    let mut g = hl_desk();
    let bravo = g.get_desk("alpha".into()).unwrap();
    g.desks.insert("bravo".into(), bravo);
    let nonce = |u: &UnsignedAction| u.payload.get("nonce").cloned();
    let n = |ms: u64| Some(gimbal_core::msgpack::Value::UInt(ms));
    at(operator(), T, yocto(0));
    assert_eq!(
        nonce(&g.prepare_hl_order("alpha".into(), hype(), "a".into())),
        n(T)
    );
    // Two in one block, then a user-signed one: never the same nonce twice.
    assert_eq!(nonce(&g.prepare_hl_set_referrer("alpha".into())), n(T + 1));
    assert_eq!(
        nonce(&g.prepare_hl_approve_builder_fee("alpha".into())),
        n(T + 2)
    );
    // Another desk has its own nonces.
    assert_eq!(nonce(&g.prepare_hl_set_referrer("bravo".into())), n(T));
    // A later block moves on to the block time; an earlier one cannot go back.
    at(operator(), T + 5_000, yocto(0));
    assert_eq!(
        nonce(&g.prepare_hl_order("alpha".into(), hype(), "b".into())),
        n(T + 5_000)
    );
    at(owner(), T - 10, ONE_YOCTO);
    let w = g.prepare_hl_withdraw("alpha".into(), "10".into());
    assert_eq!(nonce(&w), n(T + 5_001));
    assert_eq!(
        w.payload.get("action").unwrap().get("time"),
        n(T + 5_001).as_ref()
    );
    assert_eq!(nonce_of("alpha", &g), T + 5_001);
    assert_eq!(nonce_of("bravo", &g), T);
}

/// The gas `f` burns, less the cost of reading the gas counter itself.
fn gas_of(f: impl FnOnce()) -> u64 {
    let start = env::used_gas().as_gas();
    let idle = env::used_gas().as_gas() - start;
    let start = env::used_gas().as_gas();
    f();
    env::used_gas().as_gas() - start - idle
}

#[test]
fn an_action_writes_its_nonce_and_never_rewrites_the_desk() {
    let mut g = hl_desk();
    at(owner(), T, yocto(0));
    g.desks.flush();
    assert_eq!(gas_of(|| g.desks.flush()), 0, "nothing left to write");
    // An order reads the desk and writes only its nonce entry.
    g.prepare_hl_order("alpha".into(), hype(), "a".into());
    assert_eq!(
        gas_of(|| g.desks.flush()),
        0,
        "the desk is not written back"
    );
    assert!(
        gas_of(|| g.hl_nonces.flush()) > 0,
        "the nonce entry is written"
    );
    // The control: a method that changes the desk does write it back.
    g.set_paused("alpha".into(), true);
    assert!(
        gas_of(|| g.desks.flush()) > 0,
        "set_paused rewrites the desk"
    );
}

#[test]
fn a_new_desk_pays_for_its_nonce_entry_and_an_action_adds_no_storage() {
    let mut g = hl_desk();
    at(owner(), T, yocto(0));
    g.desks.remove("alpha");
    g.desks.flush();
    let desk = Desk::new(
        owner(),
        hl_policy(),
        VECTOR_DESK_EVM.into(),
        solana(),
        "woofi_dex",
    );
    // `write_desk` measures what `create_desk` charges for, the stored nonce entry included.
    let before = env::storage_usage();
    let added = g.write_desk("alpha", &desk);
    // It also charges for the desk's future share of the contract-wide fund_venue map.
    assert_eq!(
        env::storage_usage() + crate::money::FUND_PAID_RESERVE_BYTES,
        before + added
    );
    assert_eq!(g.hl_nonces.get("alpha"), Some(&0));
    let before = env::storage_usage();
    g.prepare_hl_order("alpha".into(), hype(), "a".into());
    g.hl_nonces.flush();
    assert_eq!(nonce_of("alpha", &g), T);
    assert_eq!(env::storage_usage(), before, "an action adds no storage");
}

// --- hl_cancel ---

#[test]
fn hl_cancel_signs_the_vector_bytes() {
    let mut g = hl_desk();
    let mut signed = 0;
    for c in vectors()["l1"]["cases"].as_array().unwrap() {
        if c["kind"] != "cancel" {
            continue;
        }
        let p = &c["params"];
        at(operator(), c["nonce"].as_u64().unwrap(), yocto(0));
        let got = g.prepare_hl_cancel(
            "alpha".into(),
            u32::try_from(p["asset"].as_u64().unwrap()).unwrap(),
            p["oid"].as_u64().unwrap(),
            "stale order".into(),
        );
        let nonce = c["nonce"].as_u64().unwrap();
        assert_signs_l1_expiring(&got, "cancel", c["name"].as_str().unwrap(), nonce);
        assert_eq!(got.reason_sha256, Some(sha256_hex("stale order")));
        signed += 1;
    }
    assert_eq!(signed, 3, "every cancel in the vectors");
}

#[test]
fn hl_cancel_passes_a_paused_desk_and_takes_the_next_nonce() {
    let mut g = hl_desk();
    at(operator(), T, yocto(0));
    g.set_paused("alpha".into(), true);
    for (who, n) in [(owner(), T), (operator(), T + 1)] {
        at(who, T, yocto(0));
        let got = g.prepare_hl_cancel("alpha".into(), 1, 77, "pause".into());
        assert_eq!(
            serde_json::to_value(&got.payload).unwrap(),
            json!({
                "action": { "type": "cancel", "cancels": [{ "a": 1, "o": 77 }] },
                "nonce": n,
                "vaultAddress": null,
                "expiresAfter": T + 60_000,
            })
        );
    }
    // An asset the policy no longer lists can still be cancelled.
    let got = g.prepare_hl_cancel("alpha".into(), 4242, u64::MAX, String::new());
    assert_eq!(got.kind, "cancel");
    assert_eq!(nonce_of("alpha", &g), T + 2);
}

#[test]
fn hl_cancel_is_for_the_owner_and_the_operator() {
    let mut g = hl_desk();
    at(stranger(), T, yocto(0));
    assert_refused(
        "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
        || {
            g.prepare_hl_cancel("alpha".into(), 1, 77, "x".into());
        },
    );
    at(operator(), T, yocto(0));
    assert_refused(&format!("{E_NO_DESK}: no desk "), || {
        g.prepare_hl_cancel("bravo".into(), 1, 77, "x".into());
    });
    assert_refused("E_ARGS: reason has 281 characters, over 280", || {
        g.prepare_hl_cancel("alpha".into(), 1, 77, "x".repeat(281));
    });
    assert_eq!(nonce_of("alpha", &g), 0);
}

// --- venue setup ---

#[test]
fn hl_set_referrer_signs_the_treasury_code_only() {
    let mut g = hl_desk();
    at(operator(), 1_793_491_215_000, yocto(0));
    let got = g.prepare_hl_set_referrer("alpha".into());
    assert_signs_l1(&got, "setReferrer", "setReferrer TESTCODE");
    assert_eq!(got.reason_sha256, None);
}

#[test]
fn hl_set_referrer_without_a_code_is_e_args() {
    called_by(contract_id());
    let mut t = treasury();
    t.referral_codes.hyperliquid = None;
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
    g.desks.insert(
        "alpha".into(),
        Desk::new(
            owner(),
            hl_policy(),
            VECTOR_DESK_EVM.into(),
            solana(),
            "woofi_dex",
        ),
    );
    at(owner(), T, yocto(0));
    assert_refused(
        "E_ARGS: no Hyperliquid referral code is configured (treasury.referral_codes.hyperliquid is null)",
        || {
            g.prepare_hl_set_referrer("alpha".into());
        },
    );
    assert_eq!(nonce_of("alpha", &g), 0);
}

#[test]
fn hl_approve_builder_fee_approves_the_fee_config() {
    let mut g = hl_desk();
    let c = case("user_signed", "approveBuilderFee 0.01% (testnet)");
    at(operator(), c["action"]["nonce"].as_u64().unwrap(), yocto(0));
    let got = g.prepare_hl_approve_builder_fee("alpha".into());
    assert_signs_user(
        &got,
        "approveBuilderFee",
        "approveBuilderFee 0.01% (testnet)",
    );
}

// --- money ---

#[test]
fn hl_usd_class_transfer_signs_the_vectors() {
    let mut g = hl_desk();
    for (name, amount, to_perp) in [
        ("usdClassTransfer 12.5 to perp (testnet)", "12.5", true),
        ("usdClassTransfer 3 to spot (testnet)", "3", false),
    ] {
        let c = case("user_signed", name);
        at(operator(), c["action"]["nonce"].as_u64().unwrap(), yocto(0));
        let got = g.prepare_hl_usd_class_transfer(
            "alpha".into(),
            amount.into(),
            to_perp,
            "margin".into(),
        );
        assert_signs_user(&got, "usdClassTransfer", name);
        assert_eq!(got.reason_sha256, Some(sha256_hex("margin")));
    }
}

#[test]
fn hl_usd_class_transfer_refuses_bad_amounts() {
    let mut g = hl_desk();
    at(operator(), T, yocto(0));
    for (amount, expected) in [
        ("12.50", "E_DECIMAL: amount "),
        ("0.0000001", "E_DECIMAL: amount "),
        ("1e3", "E_DECIMAL: amount "),
        ("0", "E_SIZE: amount is zero"),
    ] {
        assert_refused(expected, || {
            g.prepare_hl_usd_class_transfer("alpha".into(), amount.into(), true, "m".into());
        });
    }
    assert_refused("E_ARGS: reason has 281 characters", || {
        g.prepare_hl_usd_class_transfer("alpha".into(), "1".into(), true, "x".repeat(281));
    });
    assert_eq!(nonce_of("alpha", &g), 0);
}

#[test]
fn hl_withdraw_pays_the_desks_own_address() {
    let mut g = hl_desk();
    let c = case(
        "user_signed",
        "withdraw3 10 USDC to the desk's own address (testnet)",
    );
    assert_eq!(c["action"]["destination"], VECTOR_DESK_EVM);
    at(owner(), c["action"]["time"].as_u64().unwrap(), ONE_YOCTO);
    let got = g.prepare_hl_withdraw("alpha".into(), "10".into());
    assert_signs_user(
        &got,
        "withdraw3",
        "withdraw3 10 USDC to the desk's own address (testnet)",
    );
    assert_eq!(got.reason_sha256, None);
}

/// The desk's rescue counters, all zero before its first rescue.
fn counters_of(g: &Gimbal) -> crate::rescue::DeskCounters {
    g.desk_counters.get("alpha").copied().unwrap_or_default()
}

/// The operator path (no deposit) signs the same `withdraw3` as the owner's wallet: the vector's
/// bytes, to the desk's own address, which no argument can change.
#[test]
fn the_operators_hl_withdraw_signs_the_same_withdraw3_to_the_desks_own_address() {
    let c = case(
        "user_signed",
        "withdraw3 10 USDC to the desk's own address (testnet)",
    );
    let time = c["action"]["time"].as_u64().unwrap();
    for who in [operator(), owner()] {
        // A thread each: the mock's storage, and so the desk's nonce, lives as long as its thread.
        std::thread::spawn(move || {
            let mut g = hl_desk();
            at(who, time, yocto(0));
            let got = g.prepare_hl_withdraw("alpha".into(), "10".into());
            assert_signs_user(
                &got,
                "withdraw3",
                "withdraw3 10 USDC to the desk's own address (testnet)",
            );
            let payload = serde_json::to_value(&got.payload).unwrap();
            assert_eq!(payload["action"]["destination"], VECTOR_DESK_EVM);
            assert_eq!(got.amount.as_deref(), Some("10"));
        })
        .join()
        .unwrap();
    }
}

/// The deposit picks the path. 1 yocto is the owner's wallet: the owner alone. None is the
/// operator path: the operator, or the owner's engine key (a FunctionCall key on the owner's
/// account, which looks like the owner and cannot attach a deposit). Anything else is refused.
#[test]
fn hl_withdraw_has_an_owner_path_and_an_operator_path() {
    let mut g = hl_desk();
    at(operator(), T, ONE_YOCTO);
    assert_refused(
        "E_NOT_ALLOWED: hl_withdraw on desk alpha is for its owner; bob is its operator",
        || {
            g.prepare_hl_withdraw("alpha".into(), "10".into());
        },
    );
    for deposit in [yocto(0), ONE_YOCTO, yocto(2)] {
        at(stranger(), T, deposit);
        assert_refused(
            "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
            || {
                g.prepare_hl_withdraw("alpha".into(), "10".into());
            },
        );
    }
    for who in [owner(), operator()] {
        for wrong in [yocto(2), NearToken::from_near(1)] {
            at(who.clone(), T, wrong);
            assert_refused(
                "E_NOT_ALLOWED: hl_withdraw takes exactly 1 yoctoNEAR from the owner's wallet, \
                 or no deposit on the operator path; attached ",
                || {
                    g.prepare_hl_withdraw("alpha".into(), "10".into());
                },
            );
        }
        for deposit in [yocto(0), ONE_YOCTO] {
            if who == operator() && deposit == ONE_YOCTO {
                continue;
            }
            at(who.clone(), T, deposit);
            assert_refused("E_SIZE: amount is zero", || {
                g.prepare_hl_withdraw("alpha".into(), "0".into());
            });
            assert_refused("E_DECIMAL: amount ", || {
                g.prepare_hl_withdraw("alpha".into(), "10.0".into());
            });
            let msg = refusal(|| {
                g.prepare_hl_withdraw("alpha".into(), "0.0000001".into());
            });
            assert!(
                msg.contains("E_DECIMAL: amount ") && msg.contains("has 7 decimals; USDC has 6"),
                "{msg}"
            );
        }
    }
    at(operator(), T, yocto(0));
    assert_refused("E_NO_DESK: no desk ", || {
        g.prepare_hl_withdraw("bravo".into(), "10".into());
    });
    assert_eq!(nonce_of("alpha", &g), 0, "a refused call takes no nonce");
    assert_eq!(counters_of(&g), Default::default());
}

/// The operator path counts `amount` against the desk's sliding hourly rescue cap (50 USD here),
/// and nothing against the cost budget or the deposit ring; the owner's wallet is not limited.
#[test]
fn the_operators_hl_withdraw_counts_against_the_rescue_cap() {
    let mut g = hl_desk();
    let cap = g
        .get_desk("alpha".into())
        .unwrap()
        .policy
        .rescue_cap_usd_per_hour;
    assert_eq!(cap, 50);
    let e8 = |usd: u128| usd * 100_000_000;
    at(operator(), T, yocto(0));
    g.prepare_hl_withdraw("alpha".into(), "30".into());
    let c = counters_of(&g);
    assert_eq!((c.rescue_at_ms, c.rescue_spent_e8), (T, e8(30)));
    assert_eq!(c.rescue_cost_e8, 0, "no quote, no cost");
    assert_eq!(
        c.deposits,
        [[0; 32]; crate::rescue::DEPOSIT_RING],
        "no deposit address"
    );
    assert_eq!(c.deposit_next, 0);
    // The owner's engine key takes the same path and the same cap.
    at(owner(), T, yocto(0));
    g.prepare_hl_withdraw("alpha".into(), "20".into());
    assert_eq!(counters_of(&g).rescue_spent_e8, e8(50));
    for who in [operator(), owner()] {
        at(who, T + 1, yocto(0));
        assert_refused(
            "E_RESCUE_CAP: hl_withdraw of 0.00002 USDC is over what is left of the hourly \
             rescue cap, 0.00001388 USD",
            || {
                g.prepare_hl_withdraw("alpha".into(), "0.00002".into());
            },
        );
    }
    assert_eq!(
        nonce_of("alpha", &g),
        T + 1,
        "the refused calls took no nonce"
    );
    assert_eq!(counters_of(&g).rescue_spent_e8, e8(50));
    // The owner's wallet withdraws without a limit and counts nothing.
    at(owner(), T + 1, ONE_YOCTO);
    g.prepare_hl_withdraw("alpha".into(), "1000".into());
    assert_eq!(counters_of(&g).rescue_spent_e8, e8(50));
    assert_eq!(counters_of(&g).rescue_at_ms, T);
    // A fifth of an hour later a fifth of the cap is back: 10 USDC, then nothing.
    let later = T + crate::rescue::RESCUE_WINDOW_MS / 5;
    at(operator(), later, yocto(0));
    assert_refused(
        "E_RESCUE_CAP: hl_withdraw of 10.000001 USDC is over ",
        || {
            g.prepare_hl_withdraw("alpha".into(), "10.000001".into());
        },
    );
    g.prepare_hl_withdraw("alpha".into(), "10".into());
    let c = counters_of(&g);
    assert_eq!((c.rescue_at_ms, c.rescue_spent_e8), (later, e8(50)));
    // A lower cap applies at once.
    let mut g = hl_desk_with(Policy {
        rescue_cap_usd_per_hour: 9,
        ..hl_policy()
    });
    // The mock keeps this thread's storage: start the new desk's meters from zero.
    g.desk_counters.insert("alpha".into(), Default::default());
    at(operator(), T, yocto(0));
    assert_refused(
        "E_RESCUE_CAP: hl_withdraw of 10 USDC is over what is left of the hourly rescue cap, 9 USD",
        || {
            g.prepare_hl_withdraw("alpha".into(), "10".into());
        },
    );
}

/// After `panic_close` the desk closes: reduce-only orders, cancels and the operator's
/// withdrawal sign; anything that opens or grows a position is `E_PAUSED`.
#[test]
fn a_closing_desk_signs_reduce_only_orders_and_refuses_opening_ones() {
    let mut g = hl_desk();
    at(operator(), T, yocto(0));
    g.panic_close("alpha".into());
    let desk = g.get_desk("alpha".into()).unwrap();
    assert!(desk.paused && desk.closing);
    for who in [owner(), operator()] {
        at(who, T, yocto(0));
        for is_buy in [true, false] {
            let mut close = hype();
            close.is_buy = is_buy;
            close.reduce_only = true;
            let got = g.prepare_hl_order("alpha".into(), close, "panic close".into());
            let payload = serde_json::to_value(&got.payload).unwrap();
            assert_eq!(payload["action"]["orders"][0]["r"], true);
            let mut open = hype();
            open.is_buy = is_buy;
            assert_refused("E_PAUSED: desk alpha is paused", || {
                g.prepare_hl_order("alpha".into(), open, "open".into());
            });
        }
        g.prepare_hl_cancel("alpha".into(), 159, 7, "panic close".into());
        g.prepare_hl_withdraw("alpha".into(), "5".into());
        assert_refused("E_PAUSED: desk alpha is paused", || {
            g.prepare_hl_usd_class_transfer("alpha".into(), "5".into(), true, "margin".into());
        });
    }
    assert_eq!(counters_of(&g).rescue_spent_e8, 10 * 100_000_000);
}

// --- the returned shape ---

/// What C5 wraps: one JSON object, keys in this order, and it reads back as the same value, so it
/// can travel to a callback as an argument.
#[test]
fn an_unsigned_action_is_this_json() {
    let mut g = hl_desk();
    let nonce = 1_793_491_215_000;
    at(operator(), nonce, yocto(0));
    let got = g.prepare_hl_set_referrer("alpha".into());
    let c = case("l1", "setReferrer TESTCODE");
    let digest = c["testnet"]["digest"]
        .as_str()
        .unwrap()
        .strip_prefix("0x")
        .unwrap()
        .to_owned();
    let json = serde_json::to_string(&got).unwrap();
    assert_eq!(
        json,
        format!(
            r#"{{"desk_id":"alpha","venue":"hyperliquid","kind":"setReferrer","payload":{{"action":{{"type":"setReferrer","code":"TESTCODE"}},"nonce":{nonce},"vaultAddress":null}},"sign_request":{{"path":"gimbal/alpha/evm","payload_v2":{{"Ecdsa":"{digest}"}},"domain_id":0}},"reason_sha256":null,"orders":[],"amount":null}}"#
        )
    );
    assert_eq!(serde_json::from_str::<UnsignedAction>(&json).unwrap(), got);
}

#[test]
fn hl_methods_refuse_unknown_arguments_and_only_hl_withdraw_is_payable() {
    let source = include_str!("../hl.rs");
    for method in [
        "hl_order",
        "hl_cancel",
        "hl_set_referrer",
        "hl_approve_builder_fee",
        "hl_usd_class_transfer",
        "hl_withdraw",
    ] {
        let attributes = attributes_of(source, method);
        assert!(
            attributes.contains(&"#[deny_unknown_arguments]"),
            "{method}: {attributes:?}"
        );
        // Operator methods take no deposit: the operator key cannot attach one.
        assert_eq!(
            attributes.contains(&"#[payable]"),
            method == "hl_withdraw",
            "{method}: {attributes:?}"
        );
    }
}
