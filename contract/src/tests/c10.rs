//! The C10 fixes on the mocked chain: the hourly notional meter, the Phoenix accounts and second
//! 1Click key settings, and `new`'s network ids.

use super::hl::{at, hl_desk_with, hl_policy, hype};
use super::*;
use crate::rescue::RESCUE_WINDOW_MS;
use crate::settings::{PhoenixAccountsJson, ONECLICK_KEY_DELAY_MS};
use crate::sol::sha256;
use gimbal_core::phoenix::PhoenixAccounts;
use gimbal_core::solana::{b58 as base58, find_program_address, PHOENIX_PROGRAM};

const T: u64 = 1_793_491_200_000;

fn notional_desk(cap: Option<u64>) -> Gimbal {
    let mut g = hl_desk_with(Policy {
        max_hourly_notional_usd: cap,
        ..hl_policy()
    });
    // The mock keeps this thread's storage: start the desk's meters from zero.
    g.desk_counters.insert("alpha".into(), Default::default());
    g
}

/// Orders that are not reduce-only count their notional (the value the size cap read: here the
/// unpriced HYPE order at its own 99.75 USD) against `max_hourly_notional_usd`, which decays like
/// the rescue meters; reduce-only orders count nothing and pass a full meter.
#[test]
fn the_hourly_notional_meter_counts_orders_that_are_not_reduce_only() {
    let mut g = notional_desk(Some(250));
    at(operator(), T, yocto(0));
    g.prepare_hl_order("alpha".into(), hype(), "open".into());
    g.prepare_hl_order("alpha".into(), hype(), "open".into());
    let c = g.counters_of("alpha");
    assert_eq!((c.notional_at_ms, c.notional_e8), (T, 2 * 9_975_000_000));
    let nonce = g.hl_nonces.get("alpha").copied();
    assert_refused(
        "E_SIZE: the order: 99.75 USD of notional is over what is left of \
         max_hourly_notional_usd 250 in the sliding hour, 50.5 USD",
        || {
            g.prepare_hl_order("alpha".into(), hype(), "open".into());
        },
    );
    assert_eq!(g.hl_nonces.get("alpha").copied(), nonce, "no nonce taken");
    let mut close = hype();
    close.reduce_only = true;
    close.is_buy = false;
    g.prepare_hl_order("alpha".into(), close, "close".into());
    assert_eq!(g.counters_of("alpha").notional_e8, 2 * 9_975_000_000);
    // A fifth of an hour later 159.6 still weigh: no room; two fifths later 119.7: room.
    at(operator(), T + RESCUE_WINDOW_MS / 5, yocto(0));
    assert_refused("E_SIZE: the order: 99.75 USD", || {
        g.prepare_hl_order("alpha".into(), hype(), "open".into());
    });
    at(operator(), T + RESCUE_WINDOW_MS * 2 / 5, yocto(0));
    g.prepare_hl_order("alpha".into(), hype(), "open".into());
    assert_eq!(
        g.counters_of("alpha").notional_e8,
        11_970_000_000 + 9_975_000_000
    );
    // A cap of 0 refuses every order that is not reduce-only.
    let mut g = notional_desk(Some(0));
    at(operator(), T, yocto(0));
    assert_refused("max_hourly_notional_usd 0", || {
        g.prepare_hl_order("alpha".into(), hype(), "open".into());
    });
}

/// Left out, the cap is 15 × `max_notional_usd` and follows it; `get_desk_counters` shows the cap
/// in force and the meter.
#[test]
fn the_default_hourly_notional_cap_is_15_orders() {
    let mut g = notional_desk(None);
    assert_eq!(hl_policy().max_notional_usd, 1000);
    at(operator(), T, yocto(0));
    g.prepare_hl_order("alpha".into(), hype(), "open".into());
    let v = g.get_desk_counters("alpha".into()).unwrap();
    assert_eq!(v.notional_cap_usd, 15_000);
    assert_eq!(v.notional_now_e8.0, 9_975_000_000);
    assert_eq!(v.notional_left_e8.0, 1_500_000_000_000 - 9_975_000_000);
    assert_eq!(g.get_desk_counters("bravo".into()), None);
}

fn moved() -> [u8; 32] {
    find_program_address(sha256, &[b"moved"], &PHOENIX_PROGRAM)
        .unwrap()
        .0
}

fn with_log_authority(key: [u8; 32]) -> PhoenixAccountsJson {
    let mut a = PhoenixAccounts::PINNED;
    a.log_authority = key;
    PhoenixAccountsJson::of(&a)
}

/// `set_phoenix_accounts`: the owner with exactly 1 yoctoNEAR, also on a paused desk; nothing that
/// is a program, a mint or one of the desk's own accounts; logged; the record was prepaid.
#[test]
fn the_owner_sets_the_phoenix_accounts() {
    let mut g = hl_desk_with(hl_policy());
    let pinned = g.get_desk_settings("alpha".into()).unwrap();
    assert_eq!(
        pinned.phoenix_accounts,
        PhoenixAccountsJson::of(&PhoenixAccounts::PINNED)
    );
    assert_eq!(pinned.oneclick_key, None);
    let accounts = with_log_authority(moved());
    at(operator(), T, ONE_YOCTO);
    assert_refused(
        "E_NOT_ALLOWED: set_phoenix_accounts on desk alpha is for its owner; bob is its operator",
        || g.set_phoenix_accounts("alpha".into(), accounts.clone()),
    );
    for deposit in [yocto(0), yocto(2)] {
        at(owner(), T, deposit);
        assert_refused(
            "E_NOT_ALLOWED: set_phoenix_accounts needs exactly 1 yoctoNEAR",
            || g.set_phoenix_accounts("alpha".into(), accounts.clone()),
        );
    }
    at(owner(), T, ONE_YOCTO);
    for (key, what) in [
        (PHOENIX_PROGRAM, "the Phoenix program"),
        ([0; 32], "the system program"),
    ] {
        let expected = format!(
            "E_ARGS: phoenix accounts: log_authority {} is {what}",
            base58(&key)
        );
        assert_refused(&expected, || {
            g.set_phoenix_accounts("alpha".into(), with_log_authority(key))
        });
    }
    let mut bad = accounts.clone();
    bad.ember_vault = "not base58!".into();
    assert_refused("E_ARGS: ember_vault", || {
        g.set_phoenix_accounts("alpha".into(), bad)
    });
    g.desks.get_mut("alpha").unwrap().paused = true;
    // What `create_desk` stores (the fixture writes the desk alone).
    g.desk_settings.insert("alpha".into(), Default::default());
    g.desk_settings.flush();
    at(owner(), T, ONE_YOCTO);
    let before = env::storage_usage();
    g.set_phoenix_accounts("alpha".into(), accounts.clone());
    g.desk_settings.flush();
    assert!(env::storage_usage() <= before, "the record was prepaid");
    assert_eq!(
        g.get_desk_settings("alpha".into())
            .unwrap()
            .phoenix_accounts,
        accounts
    );
    assert_eq!(g.sol_desk("alpha").infra.log_authority, moved());
    assert_eq!(
        get_logs(),
        vec![event(
            "phoenix_accounts_set",
            &format!(
                r#"{{"desk_id":"alpha","accounts":{}}}"#,
                serde_json::to_string(&accounts).unwrap()
            )
        )]
    );
}

fn key_b58(n: u8) -> String {
    base58(&[n; 32])
}

/// The second 1Click key: the treasury proposes, the owner accepts that exact key, it signs quotes
/// for the desk 24 h after the acceptance and only while it is still the proposal.
#[test]
fn a_second_oneclick_key_takes_the_treasury_the_owner_and_a_day() {
    let mut g = hl_desk_with(hl_policy());
    let treasury = treasury().near;
    for who in [owner(), operator(), stranger(), contract_id()] {
        at(who, T, ONE_YOCTO);
        assert_refused(
            "E_NOT_ALLOWED: only the treasury account fargo proposes a 1Click key",
            || g.propose_oneclick_key(Some(key_b58(7))),
        );
    }
    at(treasury.clone(), T, yocto(0));
    assert_refused(
        "E_NOT_ALLOWED: propose_oneclick_key needs exactly 1 yoctoNEAR",
        || g.propose_oneclick_key(Some(key_b58(7))),
    );
    at(treasury.clone(), T, ONE_YOCTO);
    assert_refused("E_ARGS: key is all zero", || {
        g.propose_oneclick_key(Some(key_b58(0)))
    });
    assert_refused("E_ARGS: key is 1Click's pinned key", || {
        g.propose_oneclick_key(Some(gimbal_core::oneclick::ONECLICK_PUBLIC_KEY_B58.into()))
    });
    g.propose_oneclick_key(Some(key_b58(7)));
    assert_eq!(g.oneclick_key_proposal(), Some(key_b58(7)));
    assert_eq!(
        get_logs(),
        vec![event(
            "oneclick_key_proposed",
            &format!(r#"{{"key":"{}"}}"#, key_b58(7))
        )]
    );
    assert_eq!(
        g.accepted_oneclick_key("alpha", T),
        None,
        "no owner accepted it"
    );

    at(operator(), T, ONE_YOCTO);
    assert_refused(
        "E_NOT_ALLOWED: accept_oneclick_key on desk alpha is for its owner",
        || g.accept_oneclick_key("alpha".into(), Some(key_b58(7))),
    );
    at(owner(), T, ONE_YOCTO);
    assert_refused(
        "E_ARGS: key is not the treasury's proposed 1Click key",
        || g.accept_oneclick_key("alpha".into(), Some(key_b58(8))),
    );
    g.accept_oneclick_key("alpha".into(), Some(key_b58(7)));
    let from = T + ONECLICK_KEY_DELAY_MS;
    assert_eq!(
        get_logs(),
        vec![event(
            "oneclick_key_accepted",
            &format!(
                r#"{{"desk_id":"alpha","key":"{}","from_ms":{from}}}"#,
                key_b58(7)
            )
        )]
    );
    assert_eq!(g.accepted_oneclick_key("alpha", from - 1), None, "the day");
    assert_eq!(g.accepted_oneclick_key("alpha", from), Some([7; 32]));
    at(owner(), from, yocto(0));
    let view = g.get_desk_settings("alpha".into()).unwrap();
    assert_eq!(
        (
            view.oneclick_key,
            view.oneclick_key_from_ms,
            view.oneclick_key_active
        ),
        (Some(key_b58(7)), from, true)
    );
    // A new proposal ends the acceptance; the owner accepts again for another day.
    at(treasury.clone(), from, ONE_YOCTO);
    g.propose_oneclick_key(Some(key_b58(9)));
    assert_eq!(g.accepted_oneclick_key("alpha", from), None);
    g.propose_oneclick_key(None);
    assert_eq!(g.oneclick_key_proposal(), None);
    assert_eq!(g.accepted_oneclick_key("alpha", from), None);
    // The owner clears it.
    at(owner(), from, ONE_YOCTO);
    g.accept_oneclick_key("alpha".into(), None);
    let view = g.get_desk_settings("alpha".into()).unwrap();
    assert_eq!((view.oneclick_key, view.oneclick_key_from_ms), (None, 0));
}

/// `new` takes only its network's MPC signer and oracle.
#[test]
fn new_takes_the_networks_own_mpc_and_oracle() {
    let orderly = |chain_id| OrderlyConfig {
        broker_id: "gimbal".into(),
        chain_id,
    };
    let oracle = |id: &str| PriceSource::OutLayer {
        contract: id.parse().unwrap(),
    };
    for (network, mpc, price, chain, expected) in [
        (
            Network::Mainnet,
            "v1.signer-prod.testnet",
            oracle("price-oracle.near"),
            ARBITRUM_MAINNET,
            "E_ARGS: mpc v1.signer-prod.testnet is not the Mainnet MPC signer v1.signer",
        ),
        (
            Network::Mainnet,
            "v1.signer",
            oracle("price-oracle.testnet"),
            ARBITRUM_MAINNET,
            "E_ARGS: price oracle price-oracle.testnet is not the Mainnet OutLayer oracle",
        ),
        (
            Network::Testnet,
            "v1.signer",
            PriceSource::Mock,
            ARBITRUM_SEPOLIA,
            "E_ARGS: mpc v1.signer is not the Testnet MPC signer v1.signer-prod.testnet",
        ),
        (
            Network::Testnet,
            "v1.signer-prod.testnet",
            oracle("price-oracle.near"),
            ARBITRUM_SEPOLIA,
            "E_ARGS: price oracle price-oracle.near is not the Testnet OutLayer oracle",
        ),
    ] {
        called_by(contract_id());
        assert_refused(expected, || {
            Gimbal::new(
                network,
                mpc.parse().unwrap(),
                price,
                treasury(),
                fees(),
                orderly(chain),
            );
        });
    }
}
