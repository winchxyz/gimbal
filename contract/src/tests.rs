//! Unit tests of the contract's methods on the mocked chain. The mock keeps one chain per thread:
//! storage carries over between `testing_env!` calls, logs and receipts start empty, and a refused
//! call does not roll back what it wrote before its panic (the chain would).

use super::*;
use crate::config::{ReferralCodes, ARBITRUM_MAINNET, ARBITRUM_SEPOLIA};
use crate::deposit::ONE_YOCTO;
use crate::mpc::tests::{MPC_EVM, MPC_SOL};
use gimbal_core::errors::{E_ARGS, E_NOT_ALLOWED, E_PAUSED};
use gimbal_core::policy::{HlAsset, PhoenixMarket, UnpricedAsset};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// The Hyperliquid methods, on these fixtures.
mod hl;
/// The Orderly methods, on these fixtures.
mod orderly;
/// The MPC `sign` call and `on_signed`.
mod signing;
/// The Solana methods, on these fixtures.
mod sol;

/// The EVM address and Solana authority the MPC answers in [`MPC_EVM`] and [`MPC_SOL`] give.
const EVM: &str = "0x77cf7951f48ed15194825e2fe0908a6aa486d45a";
const SOL_AUTHORITY: &str = "31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd";
/// A well-formed address that is not the desk's.
const OTHER_EVM: &str = "0x8ba1f109551bd432803012645ac136ddd64dba72";

fn contract_id() -> AccountId {
    "gimbal.testnet".parse().unwrap()
}

fn mpc_id() -> AccountId {
    "v1.signer-prod.testnet".parse().unwrap()
}

fn oracle_id() -> AccountId {
    "price-oracle.testnet".parse().unwrap()
}

fn owner() -> AccountId {
    accounts(0)
}

fn operator() -> AccountId {
    accounts(1)
}

fn stranger() -> AccountId {
    accounts(2)
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// Enough for the storage of any one test call; the rest comes back.
fn storage_deposit() -> NearToken {
    NearToken::from_millinear(10)
}

/// A new call from `predecessor` with `deposit` attached.
fn call(predecessor: AccountId, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .build());
}

/// A call with no deposit: what the owner's FunctionCall key (the engine) looks like.
fn called_by(predecessor: AccountId) {
    call(predecessor, yocto(0));
}

/// The callback of a `create_desk` call, with the MPC contract's answers as promise results.
fn callback(results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .signer_account_id(owner())
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn answer(s: &str) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(s).unwrap())
}

fn mpc_answers() -> Vec<PromiseResult> {
    vec![answer(MPC_EVM), answer(MPC_SOL)]
}

fn treasury() -> Treasury {
    Treasury {
        near: accounts(5),
        hl_builder: "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c".into(),
        referral_codes: ReferralCodes {
            hyperliquid: Some("TESTCODE".into()),
            orderly: None,
            phoenix: None,
        },
    }
}

fn fees() -> FeeConfig {
    FeeConfig {
        performance_bps: 1000,
        hl_builder_tenth_bps: 10,
    }
}

fn testnet_with(price_source: PriceSource) -> Gimbal {
    called_by(contract_id());
    Gimbal::new(
        Network::Testnet,
        mpc_id(),
        price_source,
        treasury(),
        fees(),
        OrderlyConfig {
            broker_id: "woofi_dex".into(),
            chain_id: ARBITRUM_SEPOLIA,
        },
    )
}

fn testnet() -> Gimbal {
    testnet_with(PriceSource::Mock)
}

fn policy() -> Policy {
    Policy {
        hl_assets: vec![HlAsset {
            index: 4,
            symbol: "ETH".into(),
            sz_decimals: 4,
        }],
        phoenix_markets: vec![PhoenixMarket {
            symbol: "SOL".into(),
            orderbook: "11111111111111111111111111111111".into(),
            base_lot_e8: 1_000_000,
            tick_e8: 1_000,
        }],
        orderly_symbols: vec!["PERP_SOL_USDC".into()],
        max_notional_usd: 20,
        price_band_bps: 100,
        oracle_max_age_s: 60,
        rescue_cap_usd_per_hour: 50,
        max_transfer_cost_bps: 100,
        max_transfer_cost_flat_e6: 500_000,
        unpriced: vec![],
        unpriced_max_notional_usd: 100,
    }
}

fn b58(n: u8) -> String {
    bs58::encode([n; 32]).into_string()
}

/// The accounts [`SOL_AUTHORITY`] derives (bumps 254, 255 and 252), which `create_desk` requires.
fn solana() -> SolanaAccounts {
    SolanaAccounts {
        authority: SOL_AUTHORITY.into(),
        usdc_ata: "5EbDUDCy2ycULpJ4xDCmrDJ3zqVpshLLm46BQpYXLDAU".into(),
        phusd_ata: "4mVZb1tNA7QGWXnqFhT4yfuBAi8Ff5mHWs2otZwuH5Et".into(),
        phoenix_trader: "FgXaTCYWdnqYPd7cCPruqbggfHbNCs4EGqmrxBePz9A8".into(),
    }
}

/// The accounts of authority `[1; 32]` (`b58(1)`), a key the MPC does not give the test desk.
fn stranger_solana() -> SolanaAccounts {
    SolanaAccounts {
        authority: b58(1),
        usdc_ata: "Gs6NxmndAL3PULGZeYUHCknpMdDVbL46eFCBh856p5z6".into(),
        phusd_ata: "F1VgsU8zdX5KM64eRdTiGHjbhqetYfXY9FcopvsmFbKm".into(),
        phoenix_trader: "5odgPeixtpPBCiA1fDhnFuncxYT6YEBBiqW8NAvii1QN".into(),
    }
}

/// The function calls the last call scheduled: (receiver, method, JSON args, static gas, weight).
fn function_calls() -> Vec<(AccountId, String, Value, Gas, u64)> {
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
                    ..
                } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap(),
                    prepaid_gas,
                    gas_weight.0,
                )),
                _ => None,
            })
        })
        .collect()
}

/// The arguments `create_desk` scheduled `on_desk_keys` with.
fn scheduled_callback() -> (String, Desk, NearToken) {
    let (_, _, args, _, _) = function_calls()
        .into_iter()
        .find(|c| c.1 == "on_desk_keys")
        .expect("create_desk schedules on_desk_keys");
    (
        serde_json::from_value(args["desk_id"].clone()).unwrap(),
        serde_json::from_value(args["desk"].clone()).unwrap(),
        serde_json::from_value(args["attached"].clone()).unwrap(),
    )
}

/// Runs `on_desk_keys` and says how the transaction ends: `Ok(())` once the desk is stored, or the
/// refusal it handed to `refuse`, the call it returns instead of a value.
fn run_callback(
    g: &mut Gimbal,
    desk_id: String,
    desk: Desk,
    attached: NearToken,
) -> Result<(), String> {
    match g.on_desk_keys(desk_id, desk, attached) {
        PromiseOrValue::Value(created) => {
            assert!(created, "a stored desk returns true");
            assert!(function_calls().is_empty());
            Ok(())
        }
        PromiseOrValue::Promise(promise) => {
            promise.detach();
            let calls = function_calls();
            assert_eq!(calls.len(), 1, "{calls:?}");
            let (to, method, args, gas, _) = &calls[0];
            assert_eq!((to, method.as_str()), (&contract_id(), "refuse"));
            assert_eq!(*gas, REFUSE_GAS);
            Err(args["refusal"].as_str().unwrap().to_owned())
        }
    }
}

/// `create_desk` of `desk_id` as `who` with `attached`, then its callback with the MPC's answers.
/// Returns whether the desk was stored.
fn create(g: &mut Gimbal, who: AccountId, desk_id: &str, attached: NearToken) -> bool {
    call(who, attached);
    g.create_desk(desk_id.into(), policy(), EVM.into(), solana())
        .detach();
    let (id, desk, deposit) = scheduled_callback();
    callback(mpc_answers());
    run_callback(g, id, desk, deposit).is_ok()
}

/// A fresh contract with desk `alpha` of `owner()`, whose operator is `operator()`.
fn with_desk() -> Gimbal {
    let mut g = testnet();
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    call(owner(), storage_deposit());
    g.set_operator("alpha".into(), Some(operator()));
    g
}

/// The panic message of a refused call. The mock reports it through `Debug`, so quotes in it come
/// back escaped: match on text before any quoted input.
fn refusal(f: impl FnOnce()) -> String {
    let payload = catch_unwind(AssertUnwindSafe(f)).expect_err("the call should be refused");
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn assert_refused(expected: &str, f: impl FnOnce()) {
    let msg = refusal(f);
    assert!(msg.contains(expected), "expected {expected:?} in {msg}");
}

/// The NEAR transfers the last call created, as (receiver, amount).
fn transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit)),
                _ => None,
            })
        })
        .collect()
}

/// What the caller paid for the last call: `attached` less the refund it created.
fn kept(attached: NearToken) -> NearToken {
    let refunds = transfers();
    assert!(refunds.len() <= 1, "{refunds:?}");
    attached.saturating_sub(refunds.first().map_or(yocto(0), |r| r.1))
}

/// The storage cost of `bytes`, at the chain's price per byte.
fn cost_of(bytes: u64) -> NearToken {
    env::storage_byte_cost().saturating_mul(u128::from(bytes))
}

/// What creating `alpha` for `owner()` costs: the storage its callback adds, measured on a fresh
/// chain.
fn storage_cost_of_alpha() -> NearToken {
    std::thread::spawn(|| {
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        g.create_desk("alpha".into(), policy(), EVM.into(), solana())
            .detach();
        let (id, desk, attached) = scheduled_callback();
        callback(mpc_answers());
        let before = env::storage_usage();
        run_callback(&mut g, id, desk, attached).unwrap();
        cost_of(env::storage_usage() - before)
    })
    .join()
    .unwrap()
}

/// An event line exactly as the contract writes it; `data` is the JSON object, fields in struct
/// order.
fn event(name: &str, data: &str) -> String {
    format!(
        r#"EVENT_JSON:{{"standard":"gimbal","version":"1.0.0","event":"{name}","data":[{data}]}}"#
    )
}

// --- new, config, version ---

#[test]
fn new_stores_the_config() {
    let g = testnet();
    assert_eq!(g.config.network, Network::Testnet);
    assert_eq!(g.config.mpc, mpc_id());
    assert_eq!(g.config.price_source, PriceSource::Mock);
    assert_eq!(g.config.treasury, treasury());
    assert_eq!(g.config.fees, fees());
    assert_eq!(g.config.orderly.chain_id, ARBITRUM_SEPOLIA);
    assert!(g.desks.get("alpha").is_none());
    assert!(g.desks_of(owner()).is_empty());
}

// `#[private]`, the already-initialised guard and `#[deny_unknown_arguments]` live in the wasm entry
// points near-sdk generates (for wasm32 only), which a unit test calling a method directly does not
// go through.

#[test]
#[should_panic(expected = "E_ARGS: the Mock price source is for testnet and demo only")]
fn new_refuses_mock_prices_on_mainnet() {
    called_by(contract_id());
    Gimbal::new(
        Network::Mainnet,
        "v1.signer".parse().unwrap(),
        PriceSource::Mock,
        treasury(),
        fees(),
        OrderlyConfig {
            broker_id: "gimbal".into(),
            chain_id: ARBITRUM_MAINNET,
        },
    );
}

#[test]
#[should_panic(expected = "E_ARGS: hl_builder_tenth_bps is 0")]
fn new_refuses_a_zero_builder_fee() {
    called_by(contract_id());
    Gimbal::new(
        Network::Testnet,
        mpc_id(),
        PriceSource::Mock,
        treasury(),
        FeeConfig {
            hl_builder_tenth_bps: 0,
            ..fees()
        },
        OrderlyConfig {
            broker_id: "woofi_dex".into(),
            chain_id: ARBITRUM_SEPOLIA,
        },
    );
}

#[test]
fn config_json() {
    let g = testnet();
    assert_eq!(
        serde_json::to_string(&g.config()).unwrap(),
        r#"{"network":"Testnet","mpc":"v1.signer-prod.testnet","price_source":"Mock","treasury":{"near":"fargo","hl_builder":"0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c","referral_codes":{"hyperliquid":"TESTCODE","orderly":null,"phoenix":null}},"fees":{"performance_bps":1000,"hl_builder_tenth_bps":10},"orderly":{"broker_id":"woofi_dex","chain_id":421614}}"#
    );
}

#[test]
fn version_is_the_crate_version() {
    assert_eq!(testnet().version(), env!("CARGO_PKG_VERSION"));
}

/// The attribute and doc lines right above `pub fn {method}(` in `source`.
fn attributes_of<'a>(source: &'a str, method: &str) -> Vec<&'a str> {
    let at = source
        .find(&format!("    pub fn {method}("))
        .unwrap_or_else(|| panic!("no method {method}"));
    source[..at]
        .lines()
        .rev()
        .map(str::trim)
        .take_while(|l| l.starts_with("#[") || l.starts_with("///"))
        .collect()
}

/// The generated entry points refuse unknown arguments only where the method carries the
/// attribute, so a misspelt `operater` is refused instead of read as `operator: null`. The wasm
/// build is proved on testnet (PR #8); this keeps the attribute from being dropped.
#[test]
fn mutating_methods_refuse_unknown_arguments() {
    let sources: [(&str, &[&str]); 4] = [
        (
            include_str!("lib.rs"),
            &[
                "new",
                "create_desk",
                "set_policy",
                "set_operator",
                "set_paused",
            ],
        ),
        (
            include_str!("hl.rs"),
            &[
                "hl_order",
                "hl_cancel",
                "hl_set_referrer",
                "hl_approve_builder_fee",
                "hl_usd_class_transfer",
                "hl_withdraw",
            ],
        ),
        (include_str!("sol.rs"), &["sol_sign", "sol_sign_register"]),
        (
            include_str!("orderly.rs"),
            &[
                "orderly_register",
                "orderly_add_key",
                "orderly_request",
                "orderly_ws_auth",
                "orderly_settle_pnl",
                "orderly_withdraw",
            ],
        ),
    ];
    for (source, methods) in sources {
        for method in methods {
            let attributes = attributes_of(source, method);
            assert!(
                attributes.contains(&"#[deny_unknown_arguments]"),
                "{method}: {attributes:?}"
            );
        }
    }
}

/// `#[private]` lives in the wasm entry point too. Without it on `on_desk_keys` any contract could
/// call it with made-up MPC answers and a desk of its choosing and drain refunds; without it on
/// `on_signed` anyone could make the contract log a `signed` event for an action it never built;
/// `refuse` and `new` are the contract's own as well.
#[test]
fn callbacks_and_init_are_private() {
    let source = include_str!("lib.rs");
    for method in ["new", "on_desk_keys", "on_signed", "refuse"] {
        let attributes = attributes_of(source, method);
        assert!(
            attributes.contains(&"#[private]"),
            "{method}: {attributes:?}"
        );
    }
}

// --- create_desk ---

#[test]
fn the_test_desk_addresses_are_the_mpc_answers() {
    called_by(contract_id());
    assert_eq!(mpc::evm_address(MPC_EVM).unwrap(), EVM);
    assert_eq!(
        bs58::encode(mpc::sol_authority(MPC_SOL).unwrap()).into_string(),
        SOL_AUTHORITY
    );
}

#[test]
fn create_desk_asks_the_mpc_for_both_keys_and_stores_nothing_itself() {
    let mut g = testnet();
    let attached = NearToken::from_near(1);
    call(owner(), attached);
    let before = env::storage_usage();
    g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        .detach();
    assert_eq!(
        env::storage_usage(),
        before,
        "the measuring write is undone"
    );
    assert_eq!(g.get_desk("alpha".into()), None);
    assert!(g.desks_of(owner()).is_empty());
    assert!(get_logs().is_empty());
    assert!(transfers().is_empty());

    let calls = function_calls();
    assert_eq!(calls.len(), 3, "{calls:?}");
    let contract = contract_id().to_string();
    for (call, (path, domain)) in calls[..2]
        .iter()
        .zip([("gimbal/alpha/evm", 0), ("gimbal/alpha/sol", 1)])
    {
        assert_eq!(call.0, mpc_id());
        assert_eq!(call.1, "derived_public_key");
        assert_eq!(
            call.2,
            json!({ "path": path, "predecessor": contract, "domain_id": domain })
        );
        assert_eq!(call.3, mpc::DERIVE_GAS);
    }
    let (to, method, args, gas, weight) = &calls[2];
    assert_eq!((to, method.as_str()), (&contract_id(), "on_desk_keys"));
    assert_eq!((*gas, *weight), (ON_DESK_KEYS_GAS, 1));
    assert_eq!(
        args,
        &json!({
            "desk_id": "alpha",
            "desk": Desk::new(owner(), policy(), EVM.into(), solana(), "woofi_dex"),
            "attached": attached,
        })
    );
}

#[test]
fn the_callback_stores_the_desk_refunds_the_rest_and_logs_both_events() {
    let mut g = testnet();
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    assert_eq!(
        g.get_desk("alpha".into()),
        Some(Desk::new(
            owner(),
            policy(),
            EVM.into(),
            solana(),
            "woofi_dex"
        ))
    );
    assert_eq!(g.desks_of(owner()), vec!["alpha".to_string()]);
    assert_eq!(
        get_logs(),
        vec![
            event(
                "desk_created",
                &format!(
                    r#"{{"desk_id":"alpha","owner":"alice","evm_address":"{EVM}","sol_authority":"{SOL_AUTHORITY}"}}"#
                )
            ),
            event(
                "policy_set",
                &format!(
                    r#"{{"desk_id":"alpha","policy_sha256":"{}"}}"#,
                    policy_sha256(&policy())
                )
            ),
        ]
    );
    let refunds = transfers();
    assert_eq!(refunds.len(), 1);
    assert_eq!(refunds[0].0, owner());
}

#[test]
fn the_callback_keeps_exactly_the_storage_the_desk_adds() {
    let mut g = testnet();
    let attached = NearToken::from_near(1);
    call(owner(), attached);
    g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        .detach();
    let (id, desk, deposit) = scheduled_callback();
    callback(mpc_answers());
    let before = env::storage_usage();
    run_callback(&mut g, id, desk, deposit).unwrap();
    let added = env::storage_usage() - before;
    assert!(added > 0);
    assert_eq!(kept(attached), cost_of(added));
}

#[test]
fn each_desk_adds_the_same_storage_however_many_the_owner_has() {
    let mut g = testnet();
    let mut added = Vec::new();
    for id in ["desk-1", "desk-2", "desk-3", "desk-4"] {
        call(owner(), NearToken::from_near(1));
        g.create_desk(id.into(), policy(), EVM.into(), solana())
            .detach();
        let (id, desk, attached) = scheduled_callback();
        callback(mpc_answers());
        let before = env::storage_usage();
        run_callback(&mut g, id, desk, attached).unwrap();
        added.push(env::storage_usage() - before);
    }
    // The first desk also creates the owner's count; after that each id is one entry of its own.
    assert!(added[0] > added[1], "{added:?}");
    assert_eq!(added[1..], [added[1]; 3], "{added:?}");
    assert_eq!(
        g.desks_of(owner()),
        ["desk-1", "desk-2", "desk-3", "desk-4"]
    );
    // What is stored, read back through fresh maps on the same prefixes rather than the contract's
    // caches: one `(owner, n)` entry per desk, from 0, and the owner's count.
    let ids: LookupMap<(AccountId, u32), String> = LookupMap::new(StorageKey::DeskIds);
    let counts: LookupMap<AccountId, u32> = LookupMap::new(StorageKey::DeskCounts);
    for (n, id) in ["desk-1", "desk-2", "desk-3", "desk-4"]
        .into_iter()
        .enumerate()
    {
        let n = u32::try_from(n).unwrap();
        assert_eq!(ids.get(&(owner(), n)).map(String::as_str), Some(id));
    }
    assert_eq!(ids.get(&(owner(), 4)), None);
    assert_eq!(counts.get(&owner()), Some(&4));
    assert_eq!(counts.get(&operator()), None, "nobody else has a count");
}

/// A call from `owner()` with 1 NEAR and `gas` attached. The mock charges receipt fees from an older
/// fee table (2.3 TGas per function call), so they are left out here to see what the contract
/// itself allows; [`CREATE_DESK_GAS`] holds today's fees, measured on testnet.
fn call_with_gas(gas: Gas) {
    let context = VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(owner())
        .signer_account_id(owner())
        .attached_deposit(NearToken::from_near(1))
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

#[test]
fn create_desk_refuses_less_gas_than_its_floor() {
    assert_eq!(CREATE_DESK_MIN_GAS, Gas::from_tgas(64));
    let mut g = testnet();
    let short = CREATE_DESK_MIN_GAS.saturating_sub(Gas::from_gas(1));
    for gas in [short, Gas::from_tgas(10)] {
        call_with_gas(gas);
        assert_refused(
            "E_ARGS: create_desk needs at least 64 TGas attached (100 TGas recommended), not ",
            || {
                g.create_desk("alpha".into(), policy(), EVM.into(), solana())
                    .detach();
            },
        );
        assert!(function_calls().is_empty());
    }
    // At the floor it goes on to the two MPC calls and the callback.
    call_with_gas(CREATE_DESK_MIN_GAS);
    g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        .detach();
    assert_eq!(function_calls().len(), 3);
}

/// The host gas (storage, hashing, logs, promise arguments) `create_desk` and then `on_desk_keys`
/// burn for a new desk with `policy`, leaving out the gas `create_desk` attaches to its calls, and
/// the desk's size as JSON and as borsh. The mock meters host functions, not wasm instructions.
fn desk_gas(g: &mut Gimbal, desk_id: &str, policy: Policy) -> (u64, u64, u64, u64) {
    call_with_gas(Gas::from_tgas(100));
    let start = env::used_gas().as_gas();
    g.create_desk(desk_id.into(), policy, EVM.into(), solana())
        .detach();
    let attached = 2 * mpc::DERIVE_GAS.as_gas() + ON_DESK_KEYS_GAS.as_gas();
    let create = env::used_gas().as_gas() - start - attached;
    let (id, desk, deposit) = scheduled_callback();
    let json = serde_json::to_vec(&desk).unwrap().len() as u64;
    let borsh = near_sdk::borsh::to_vec(&desk).unwrap().len() as u64;
    callback(mpc_answers());
    let start = env::used_gas().as_gas();
    run_callback(g, id, desk, deposit).unwrap();
    (create, env::used_gas().as_gas() - start, json, borsh)
}

#[test]
fn the_gas_create_desk_keeps_covers_the_largest_policy() {
    const TGAS: u64 = Gas::from_tgas(1).as_gas();
    // `create_desk` with a one-asset policy on testnet: 3.38 TGas burnt, 1.8 TGas of receipt fees.
    let measured = 3_380 * TGAS / 1000 + 1_800 * TGAS / 1000;
    // Wasm work for every extra byte, which the mock does not meter: parsed from JSON and written
    // back as JSON (the callback's arguments) at 100 instructions a byte, written as borsh at 20,
    // at 822,756 gas an instruction.
    let wasm = |json: u64, borsh: u64| (2 * json * 100 + borsh * 20) * 822_756;
    let mut g = testnet();
    let (small_create, small_keys, small_json, small_borsh) = desk_gas(&mut g, "small", policy());
    let (create, keys, json, borsh) = desk_gas(&mut g, "large", Policy::largest_valid());
    assert!(json > 12_000 && borsh > 8_000, "{json} {borsh}");
    // The Solana accounts check (after that measurement) derives three program addresses: one
    // curve check per bump tried, about 125,000 wasm instructions each (counted in the wasm32
    // build: 254 squarings of 447 and 11 multiplications of 622). An authority takes 6 on average
    // (the test one 7); more than 24 happens for fewer than 2 in 100,000.
    let derivation = 24 * 125_000 * 822_756;
    let extra = create - small_create + wasm(json - small_json, borsh - small_borsh) + derivation;
    assert!(
        measured + extra + 4 * TGAS <= CREATE_DESK_GAS.as_gas(),
        "create_desk: {measured} + {extra} with a 4 TGas margin is over {CREATE_DESK_GAS:?}"
    );
    // `on_desk_keys` parses the same JSON and stores the borsh; its host gas stays far below what
    // it is attached, the rest being wasm work of the same size as above.
    assert!(keys > small_keys);
    assert!(
        keys + wasm(json, borsh) + 10 * TGAS <= ON_DESK_KEYS_GAS.as_gas(),
        "on_desk_keys: {keys} host gas"
    );
}

#[test]
fn create_desk_accepts_exactly_its_storage_cost() {
    let cost = storage_cost_of_alpha();
    let mut g = testnet();
    assert!(create(&mut g, owner(), "alpha", cost));
    assert!(g.get_desk("alpha".into()).is_some());
    assert!(transfers().is_empty(), "nothing to refund");
}

#[test]
fn create_desk_refuses_one_yocto_less_than_its_storage_cost_before_the_mpc_calls() {
    let cost = storage_cost_of_alpha();
    let mut g = testnet();
    call(owner(), cost.saturating_sub(ONE_YOCTO));
    let before = env::storage_usage();
    assert_refused("E_DEPOSIT: desk alpha takes ", || {
        g.create_desk("alpha".into(), policy(), EVM.into(), solana())
            .detach();
    });
    assert_eq!(env::storage_usage(), before);
    assert!(function_calls().is_empty());
}

#[test]
fn create_desk_without_a_deposit_is_not_allowed() {
    let mut g = testnet();
    called_by(owner());
    assert_refused(
        "E_NOT_ALLOWED: create_desk needs a deposit of at least 1 yoctoNEAR from the owner's wallet",
        || {
            g.create_desk("alpha".into(), policy(), EVM.into(), solana())
                .detach();
        },
    );
}

#[test]
fn the_contract_the_mpc_and_the_oracle_never_own_a_desk() {
    let mut g = testnet_with(PriceSource::OutLayer {
        contract: oracle_id(),
    });
    for (who, what) in [
        (contract_id(), "the contract itself"),
        (mpc_id(), "the MPC contract"),
        (oracle_id(), "the price oracle"),
    ] {
        call(who.clone(), NearToken::from_near(1));
        assert_refused(&format!("E_ARGS: owner {who} is {what}"), || {
            g.create_desk("alpha".into(), policy(), EVM.into(), solana())
                .detach();
        });
    }
}

#[test]
fn create_desk_refuses_a_malformed_desk_id() {
    let mut g = testnet();
    call(owner(), NearToken::from_near(1));
    for bad in ["", "Alpha", "a_b", "a.b", "a b", &"a".repeat(33)] {
        assert_refused("E_ARGS: desk id ", || {
            g.create_desk(bad.into(), policy(), EVM.into(), solana())
                .detach();
        });
    }
}

#[test]
fn create_desk_refuses_a_malformed_evm_address() {
    let mut g = testnet();
    call(owner(), NearToken::from_near(1));
    for bad in [
        "0x77CF7951f48ed15194825e2fe0908a6aa486d45a",
        "77cf7951f48ed15194825e2fe0908a6aa486d45a",
        "0x77cf7951f48ed15194825e2fe0908a6aa486d45",
        "0x77cf7951f48ed15194825e2fe0908a6aa486d45z",
    ] {
        assert_refused("E_ARGS: evm_address ", || {
            g.create_desk("alpha".into(), policy(), bad.into(), solana())
                .detach();
        });
    }
}

#[test]
fn create_desk_refuses_malformed_or_underived_solana_accounts() {
    let mut g = testnet();
    call(owner(), NearToken::from_near(1));
    let mut s = solana();
    s.usdc_ata = "not-base58".into();
    assert_refused("E_ARGS: solana.usdc_ata ", || {
        g.create_desk("alpha".into(), policy(), EVM.into(), s)
            .detach();
    });
    let mut s = solana();
    s.authority = bs58::encode([1u8; 33]).into_string();
    assert_refused("E_ARGS: solana.authority ", || {
        g.create_desk("alpha".into(), policy(), EVM.into(), s)
            .detach();
    });
    // An account of the owner's choosing, here the authority itself, is not the derived one.
    let mut s = solana();
    s.phoenix_trader = s.authority.clone();
    assert_refused(
        &format!(
            "E_ARGS: solana.phoenix_trader {SOL_AUTHORITY} is not the Phoenix trader account of \
             solana.authority {SOL_AUTHORITY}, FgXaTCYWdnqYPd7cCPruqbggfHbNCs4EGqmrxBePz9A8"
        ),
        || {
            g.create_desk("alpha".into(), policy(), EVM.into(), s)
                .detach();
        },
    );
    let mut s = solana();
    s.phusd_ata = stranger_solana().phusd_ata;
    assert_refused("E_ARGS: solana.phusd_ata F1Vgs", || {
        g.create_desk("alpha".into(), policy(), EVM.into(), s)
            .detach();
    });
    assert!(function_calls().is_empty(), "refused before the MPC calls");
}

#[test]
fn create_desk_refuses_an_invalid_policy() {
    let mut g = testnet();
    call(owner(), NearToken::from_near(1));
    let mut p = policy();
    p.price_band_bps = 0;
    assert_refused("E_ARGS: policy.price_band_bps 0", || {
        g.create_desk("alpha".into(), p, EVM.into(), solana())
            .detach();
    });
}

#[test]
fn create_desk_refuses_an_existing_id() {
    let mut g = with_desk();
    for who in [owner(), stranger()] {
        call(who, NearToken::from_near(1));
        assert_refused("E_DESK_EXISTS: desk alpha exists already", || {
            g.create_desk("alpha".into(), policy(), EVM.into(), solana())
                .detach();
        });
    }
    assert_eq!(g.get_desk("alpha".into()).unwrap().owner, owner());
}

#[test]
fn desks_of_lists_each_owners_desks_in_creation_order() {
    let mut g = with_desk();
    let one = NearToken::from_near(1);
    assert!(create(&mut g, owner(), "bravo", one));
    assert!(create(&mut g, stranger(), "charlie-1", one));
    assert_eq!(g.desks_of(owner()), vec!["alpha", "bravo"]);
    assert_eq!(g.desks_of(stranger()), vec!["charlie-1"]);
    assert!(g.desks_of(operator()).is_empty());
    assert_eq!(g.get_desk("charlie-1".into()).unwrap().owner, stranger());
}

#[test]
fn get_desk_of_an_unknown_id_is_none() {
    let g = with_desk();
    assert_eq!(g.get_desk("bravo".into()), None);
}

// --- the callback's refusals ---

/// `create_desk` of `alpha` by `owner()` with these arguments, up to the scheduled callback.
fn scheduled(
    g: &mut Gimbal,
    evm_address: &str,
    solana: SolanaAccounts,
) -> (String, Desk, NearToken) {
    call(owner(), NearToken::from_near(1));
    g.create_desk("alpha".into(), policy(), evm_address.into(), solana)
        .detach();
    scheduled_callback()
}

/// Runs the callback with `results` and checks that it stored nothing, sent the whole deposit back
/// to the caller, and ends the transaction with a refusal starting with `expected`.
fn assert_callback_refused(
    g: &mut Gimbal,
    (desk_id, desk, attached): (String, Desk, NearToken),
    results: Vec<PromiseResult>,
    expected: &str,
) {
    let owner = desk.owner.clone();
    let had = g.get_desk(desk_id.clone());
    let listed = g.desks_of(owner.clone());
    callback(results);
    let before = env::storage_usage();
    let refusal = run_callback(g, desk_id.clone(), desk, attached)
        .expect_err("the callback should end as a refusal");
    assert!(
        refusal.starts_with(expected),
        "expected {expected:?}, got {refusal:?}"
    );
    assert_eq!(env::storage_usage(), before, "nothing is stored");
    assert_eq!(g.get_desk(desk_id), had);
    assert_eq!(g.desks_of(owner.clone()), listed);
    assert!(get_logs().is_empty(), "{:?}", get_logs());
    assert_eq!(transfers(), vec![(owner, attached)]);
}

#[test]
fn refuse_ends_the_call_as_its_refusal() {
    let g = testnet();
    callback(vec![]);
    assert_refused(
        "E_MPC: the MPC contract did not return the desk's EVM key",
        || g.refuse("E_MPC: the MPC contract did not return the desk's EVM key".into()),
    );
}

#[test]
fn the_callback_refunds_an_evm_address_that_is_not_the_mpc_key() {
    let mut g = testnet();
    let args = scheduled(&mut g, OTHER_EVM, solana());
    assert_callback_refused(
        &mut g,
        args,
        mpc_answers(),
        &format!("E_ARGS: evm_address {OTHER_EVM} is not the MPC address of desk alpha, {EVM}"),
    );
}

#[test]
fn the_callback_refunds_a_solana_authority_that_is_not_the_mpc_key() {
    let mut g = testnet();
    let args = scheduled(&mut g, EVM, stranger_solana());
    assert_callback_refused(
        &mut g,
        args,
        mpc_answers(),
        &format!(
            "E_ARGS: solana.authority {} is not the MPC key of desk alpha, {SOL_AUTHORITY}",
            b58(1)
        ),
    );
}

#[test]
fn the_callback_refunds_when_the_mpc_call_fails() {
    for (results, expected) in [
        (
            vec![PromiseResult::Failed, answer(MPC_SOL)],
            "E_MPC: the MPC contract did not return the desk's EVM key: ",
        ),
        (
            vec![answer(MPC_EVM), PromiseResult::Failed],
            "E_MPC: the MPC contract did not return the desk's Solana key: ",
        ),
        (
            vec![answer(MPC_SOL), answer(MPC_EVM)],
            "E_MPC: the MPC contract's EVM key ",
        ),
    ] {
        let mut g = testnet();
        let args = scheduled(&mut g, EVM, solana());
        assert_callback_refused(&mut g, args, results, expected);
    }
}

#[test]
fn the_callback_refunds_an_id_taken_while_the_keys_were_checked() {
    let mut g = testnet();
    let args = scheduled(&mut g, EVM, solana());
    // A second create_desk of the same id lands first.
    assert!(create(&mut g, stranger(), "alpha", NearToken::from_near(1)));
    assert_callback_refused(
        &mut g,
        args,
        mpc_answers(),
        "E_DESK_EXISTS: desk alpha was created while its addresses were checked",
    );
    assert_eq!(g.get_desk("alpha".into()).unwrap().owner, stranger());
    assert!(g.desks_of(owner()).is_empty());
}

#[test]
fn the_callback_refunds_a_deposit_short_of_the_storage_and_undoes_its_write() {
    let mut g = testnet();
    let (desk_id, desk, _) = scheduled(&mut g, EVM, solana());
    assert_callback_refused(
        &mut g,
        (desk_id, desk, ONE_YOCTO),
        mpc_answers(),
        "E_DEPOSIT: desk alpha takes ",
    );
    // An owner with a desk already keeps that one listed.
    assert!(create(&mut g, owner(), "bravo", NearToken::from_near(1)));
    let (desk_id, desk, _) = scheduled(&mut g, EVM, solana());
    assert_callback_refused(
        &mut g,
        (desk_id, desk, ONE_YOCTO),
        mpc_answers(),
        "E_DEPOSIT: desk alpha takes ",
    );
    assert_eq!(g.desks_of(owner()), vec!["bravo"]);
}

// --- set_policy ---

/// `policy()` with a larger cap and one unpriced symbol, and its JSON as the contract writes it.
fn policy_2() -> Policy {
    let mut p = policy();
    p.max_notional_usd = 50;
    p.unpriced = vec![UnpricedAsset {
        symbol: "HYPE".into(),
        max_sz: "2.5".into(),
    }];
    p
}

const POLICY_2_JSON: &str = r#"{"hl_assets":[{"index":4,"symbol":"ETH","sz_decimals":4}],"phoenix_markets":[{"symbol":"SOL","orderbook":"11111111111111111111111111111111","base_lot_e8":1000000,"tick_e8":1000}],"orderly_symbols":["PERP_SOL_USDC"],"max_notional_usd":50,"price_band_bps":100,"oracle_max_age_s":60,"rescue_cap_usd_per_hour":50,"max_transfer_cost_bps":100,"max_transfer_cost_flat_e6":500000,"unpriced":[{"symbol":"HYPE","max_sz":"2.5"}],"unpriced_max_notional_usd":100}"#;

/// sha256 of [`POLICY_2_JSON`], computed outside Rust as
/// `sha256(JSON.stringify(JSON.parse(POLICY_2_JSON)))`, which gives back the same bytes.
const POLICY_2_SHA256: &str = "dd22d0c2ea4a07a460be1dc73aabfc2cb228416bb358d42e9f19457f0adcce3e";

#[test]
fn policy_sha256_hashes_the_json_get_desk_returns() {
    called_by(contract_id());
    assert_eq!(serde_json::to_string(&policy_2()).unwrap(), POLICY_2_JSON);
    assert_eq!(policy_sha256(&policy_2()), POLICY_2_SHA256);
}

#[test]
fn owner_sets_the_policy_and_its_sha256_is_logged() {
    let mut g = with_desk();
    call(owner(), storage_deposit());
    g.set_policy("alpha".into(), policy_2());
    assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy_2());
    assert_eq!(
        get_logs(),
        vec![event(
            "policy_set",
            &format!(r#"{{"desk_id":"alpha","policy_sha256":"{POLICY_2_SHA256}"}}"#)
        )]
    );
}

#[test]
fn set_policy_keeps_exactly_the_storage_a_larger_policy_adds() {
    let mut g = with_desk();
    let attached = storage_deposit();
    call(owner(), attached);
    let before = env::storage_usage();
    g.set_policy("alpha".into(), policy_2());
    let added = env::storage_usage() - before;
    assert!(added > 0);
    assert_eq!(kept(attached), cost_of(added));
    assert_eq!(transfers()[0].0, owner());
}

#[test]
fn a_smaller_policy_costs_one_yocto_and_frees_nothing_back() {
    let mut g = with_desk();
    call(owner(), storage_deposit());
    g.set_policy("alpha".into(), policy_2());
    let attached = storage_deposit();
    call(owner(), attached);
    let before = env::storage_usage();
    g.set_policy("alpha".into(), policy());
    assert!(env::storage_usage() < before);
    assert_eq!(kept(attached), ONE_YOCTO);
    // One yocto is enough for a policy of the same size or smaller.
    call(owner(), ONE_YOCTO);
    g.set_policy("alpha".into(), policy());
    assert!(transfers().is_empty());
}

#[test]
fn set_policy_refuses_a_deposit_short_of_its_storage() {
    let mut g = with_desk();
    call(owner(), ONE_YOCTO);
    assert_refused("E_DEPOSIT: set_policy on desk alpha takes ", || {
        g.set_policy("alpha".into(), policy_2())
    });
}

#[test]
fn set_policy_is_for_the_owner_only() {
    let mut g = with_desk();
    call(operator(), storage_deposit());
    assert_refused(
        "E_NOT_ALLOWED: set_policy on desk alpha is for its owner; bob is its operator",
        || g.set_policy("alpha".into(), policy_2()),
    );
    call(stranger(), storage_deposit());
    assert_refused(
        "E_NOT_ALLOWED: set_policy on desk alpha is for its owner; charlie is not",
        || g.set_policy("alpha".into(), policy_2()),
    );
    call(owner(), storage_deposit());
    assert_refused("E_NO_DESK: no desk ", || {
        g.set_policy("bravo".into(), policy_2())
    });
    let mut bad = policy_2();
    bad.oracle_max_age_s = 0;
    assert_refused("E_ARGS: policy.oracle_max_age_s 0", || {
        g.set_policy("alpha".into(), bad)
    });
    assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy());
}

#[test]
fn owner_sets_the_policy_of_a_paused_desk() {
    let mut g = with_desk();
    called_by(owner());
    g.set_paused("alpha".into(), true);
    call(owner(), storage_deposit());
    g.set_policy("alpha".into(), policy_2());
    assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy_2());
}

// --- set_operator ---

#[test]
fn owner_sets_and_clears_the_operator() {
    let mut g = testnet();
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    let attached = storage_deposit();
    call(owner(), attached);
    let before = env::storage_usage();
    g.set_operator("alpha".into(), Some(operator()));
    let added = env::storage_usage() - before;
    assert!(added > 0);
    assert_eq!(kept(attached), cost_of(added));
    assert_eq!(
        g.get_desk("alpha".into()).unwrap().operator,
        Some(operator())
    );
    assert_eq!(
        get_logs(),
        vec![event(
            "operator_set",
            r#"{"desk_id":"alpha","operator":"bob"}"#
        )]
    );

    call(owner(), ONE_YOCTO);
    g.set_operator("alpha".into(), None);
    assert_eq!(g.get_desk("alpha".into()).unwrap().operator, None);
    assert!(transfers().is_empty(), "freed storage is not paid back");
    assert_eq!(
        get_logs(),
        vec![event(
            "operator_set",
            r#"{"desk_id":"alpha","operator":null}"#
        )]
    );
}

#[test]
fn set_operator_refuses_a_deposit_short_of_its_storage() {
    let mut g = testnet();
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    call(owner(), ONE_YOCTO);
    assert_refused("E_DEPOSIT: set_operator on desk alpha takes ", || {
        g.set_operator("alpha".into(), Some(operator()))
    });
}

#[test]
fn set_operator_is_for_the_owner_only() {
    let mut g = with_desk();
    call(operator(), storage_deposit());
    assert_refused(
        "E_NOT_ALLOWED: set_operator on desk alpha is for its owner; bob is its operator",
        || g.set_operator("alpha".into(), Some(operator())),
    );
    call(stranger(), storage_deposit());
    assert_refused(
        "E_NOT_ALLOWED: set_operator on desk alpha is for its owner; charlie is not",
        || g.set_operator("alpha".into(), Some(stranger())),
    );
    call(owner(), storage_deposit());
    assert_refused("E_NO_DESK: no desk ", || {
        g.set_operator("bravo".into(), None)
    });
    assert_eq!(
        g.get_desk("alpha".into()).unwrap().operator,
        Some(operator())
    );
}

#[test]
fn the_operator_is_never_the_contract_the_mpc_or_the_oracle() {
    let mut g = testnet_with(PriceSource::OutLayer {
        contract: oracle_id(),
    });
    assert!(create(&mut g, owner(), "alpha", NearToken::from_near(1)));
    for (who, what) in [
        (contract_id(), "the contract itself"),
        (mpc_id(), "the MPC contract"),
        (oracle_id(), "the price oracle"),
    ] {
        call(owner(), storage_deposit());
        assert_refused(&format!("E_ARGS: operator {who} is {what}"), || {
            g.set_operator("alpha".into(), Some(who.clone()))
        });
    }
    assert_eq!(g.get_desk("alpha".into()).unwrap().operator, None);
}

#[test]
fn a_cleared_operator_has_no_role() {
    let mut g = with_desk();
    call(owner(), ONE_YOCTO);
    g.set_operator("alpha".into(), None);
    called_by(operator());
    assert_refused(
        "E_NOT_ALLOWED: bob is neither the owner nor the operator of desk alpha",
        || g.set_paused("alpha".into(), true),
    );
    for gate in [Gate::Running, Gate::ReducesRisk] {
        assert_refused("E_NOT_ALLOWED: ", || {
            action_desk(&g.desks, "alpha", gate);
        });
    }
}

// --- the owner's FunctionCall key ---

/// The engine signs with a FunctionCall key on the owner's account: the contract sees the owner,
/// with no deposit attached. That key reaches no owner method and cannot unpause.
#[test]
fn the_owners_access_key_reaches_no_owner_method() {
    let mut g = with_desk();
    called_by(owner());
    assert_refused("E_NOT_ALLOWED: create_desk needs a deposit", || {
        g.create_desk("bravo".into(), policy(), EVM.into(), solana())
            .detach();
    });
    assert_refused("E_NOT_ALLOWED: set_policy needs a deposit", || {
        g.set_policy("alpha".into(), policy())
    });
    assert_refused("E_NOT_ALLOWED: set_operator needs a deposit", || {
        g.set_operator("alpha".into(), None)
    });
    let unpause = "E_NOT_ALLOWED: set_paused(false) needs exactly 1 yoctoNEAR attached";
    assert_refused(unpause, || g.set_paused("alpha".into(), false));
    g.set_paused("alpha".into(), true);
    assert!(g.get_desk("alpha".into()).unwrap().paused, "it can pause");
    assert_refused(unpause, || g.set_paused("alpha".into(), false));
    assert!(g.get_desk("alpha".into()).unwrap().paused);
    let desk = g.get_desk("alpha".into()).unwrap();
    assert_eq!(desk.policy, policy());
    assert_eq!(desk.operator, Some(operator()));
}

// --- set_paused ---

#[test]
fn owner_pauses_and_unpauses() {
    let mut g = with_desk();
    called_by(owner());
    g.set_paused("alpha".into(), true);
    assert!(g.get_desk("alpha".into()).unwrap().paused);
    assert_eq!(get_logs(), vec![paused_log(true, "alice")]);
    call(owner(), ONE_YOCTO);
    g.set_paused("alpha".into(), false);
    assert!(!g.get_desk("alpha".into()).unwrap().paused);
    assert_eq!(get_logs(), vec![paused_log(false, "alice")]);
}

fn paused_log(paused: bool, by: &str) -> String {
    event(
        "paused",
        &format!(r#"{{"desk_id":"alpha","paused":{paused},"by":"{by}"}}"#),
    )
}

#[test]
fn unpausing_needs_exactly_one_yocto() {
    let mut g = with_desk();
    called_by(owner());
    g.set_paused("alpha".into(), true);
    for wrong in [yocto(0), yocto(2), NearToken::from_near(1)] {
        call(owner(), wrong);
        assert_refused(
            "E_NOT_ALLOWED: set_paused(false) needs exactly 1 yoctoNEAR attached",
            || g.set_paused("alpha".into(), false),
        );
    }
    assert!(g.get_desk("alpha".into()).unwrap().paused);
}

#[test]
fn pausing_takes_no_deposit_or_one_yocto() {
    let mut g = with_desk();
    for (who, deposit) in [(owner(), yocto(0)), (operator(), ONE_YOCTO)] {
        call(who, deposit);
        g.set_paused("alpha".into(), true);
        assert!(g.get_desk("alpha".into()).unwrap().paused);
        call(owner(), ONE_YOCTO);
        g.set_paused("alpha".into(), false);
    }
    call(operator(), yocto(2));
    assert_refused(
        "E_DEPOSIT: pausing takes no deposit (0 or 1 yoctoNEAR); attached 2",
        || g.set_paused("alpha".into(), true),
    );
}

#[test]
fn setting_the_current_state_logs_nothing() {
    let mut g = with_desk();
    call(owner(), ONE_YOCTO);
    g.set_paused("alpha".into(), false);
    assert!(get_logs().is_empty());
    called_by(owner());
    g.set_paused("alpha".into(), true);
    called_by(operator());
    g.set_paused("alpha".into(), true);
    assert!(
        get_logs().is_empty(),
        "the owner's pause stays the one logged"
    );
}

#[test]
fn operator_may_pause_but_never_unpause() {
    let mut g = with_desk();
    called_by(operator());
    g.set_paused("alpha".into(), true);
    assert!(g.get_desk("alpha".into()).unwrap().paused);
    assert_eq!(get_logs(), vec![paused_log(true, "bob")]);
    // Not even with the yocto an owner method needs.
    call(operator(), ONE_YOCTO);
    assert_refused(
        "E_NOT_ALLOWED: the operator may pause desk alpha but never unpause it; only its owner can",
        || g.set_paused("alpha".into(), false),
    );
    assert!(g.get_desk("alpha".into()).unwrap().paused);
    call(owner(), ONE_YOCTO);
    g.set_paused("alpha".into(), false);
    assert!(!g.get_desk("alpha".into()).unwrap().paused);
}

#[test]
fn operator_may_not_unpause_even_a_running_desk() {
    let mut g = with_desk();
    call(operator(), ONE_YOCTO);
    assert_refused("E_NOT_ALLOWED: the operator may pause desk alpha", || {
        g.set_paused("alpha".into(), false)
    });
}

#[test]
fn a_stranger_may_not_pause_and_an_unknown_desk_is_refused() {
    let mut g = with_desk();
    for paused in [true, false] {
        call(stranger(), ONE_YOCTO);
        assert_refused(
            "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
            || g.set_paused("alpha".into(), paused),
        );
    }
    assert!(!g.get_desk("alpha".into()).unwrap().paused);
    called_by(owner());
    assert_refused("E_NO_DESK: no desk ", || g.set_paused("bravo".into(), true));
}

// --- the action guard ---

#[test]
fn owner_and_operator_pass_both_gates_on_a_running_desk() {
    let g = with_desk();
    for gate in [Gate::Running, Gate::ReducesRisk] {
        called_by(owner());
        assert_eq!(action_desk(&g.desks, "alpha", gate).1, Role::Owner);
        called_by(operator());
        let (desk, role) = action_desk(&g.desks, "alpha", gate);
        assert_eq!(role, Role::Operator);
        assert_eq!(desk.evm_address, EVM);
    }
}

#[test]
fn the_action_guard_refuses_a_stranger() {
    let g = with_desk();
    called_by(stranger());
    for gate in [Gate::Running, Gate::ReducesRisk] {
        assert_refused(
            "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
            || {
                action_desk(&g.desks, "alpha", gate);
            },
        );
    }
}

#[test]
fn on_a_paused_desk_only_risk_reducing_actions_pass() {
    let mut g = with_desk();
    called_by(operator());
    g.set_paused("alpha".into(), true);
    for (who, role) in [(owner(), Role::Owner), (operator(), Role::Operator)] {
        called_by(who);
        assert_refused(
            &format!("{E_PAUSED}: desk alpha is paused; only its owner can unpause it"),
            || {
                action_desk(&g.desks, "alpha", Gate::Running);
            },
        );
        assert_eq!(action_desk(&g.desks, "alpha", Gate::ReducesRisk).1, role);
    }
    // The role comes first: a stranger learns nothing about the pause.
    called_by(stranger());
    assert_refused(&format!("{E_NOT_ALLOWED}: "), || {
        action_desk(&g.desks, "alpha", Gate::Running);
    });
    call(owner(), ONE_YOCTO);
    g.set_paused("alpha".into(), false);
    assert_eq!(action_desk(&g.desks, "alpha", Gate::Running).1, Role::Owner);
}

#[test]
fn the_action_guard_refuses_an_unknown_desk() {
    let g = with_desk();
    called_by(owner());
    assert_refused("E_NO_DESK: no desk ", || {
        action_desk(&g.desks, "bravo", Gate::ReducesRisk);
    });
}

// --- fail / or_fail (C1) ---

#[test]
#[should_panic(expected = "E_ARGS: desk id is too long")]
fn fail_panics_with_code_first() {
    fail(Refusal::new(E_ARGS, "desk id is too long"));
}

#[test]
// The mock escapes quotes in the panic it reports, so match the part before the quoted input.
#[should_panic(expected = "E_DECIMAL: ")]
fn or_fail_panics_on_a_refusal() {
    gimbal_core::decimal::parse_e8("1.50").or_fail();
}

#[test]
fn or_fail_passes_values_through() {
    assert_eq!(gimbal_core::decimal::parse_e8("1.5").or_fail(), 150_000_000);
}
