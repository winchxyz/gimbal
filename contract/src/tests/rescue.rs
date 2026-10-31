//! The rescue methods on the mocked chain, with 1Click's own signed quotes
//! (`core/tests/vectors/oneclick-live.json`, `oneclick.json`): `evm_usdc_to_intents` against the
//! contract cases of `eip3009.json`, `sol_sign_rescue` against the rescue rows of `solana.json`,
//! `hl_send_to_intents` against the `sendAsset` vectors of `hl.json`, the sliding hourly cap and
//! cost budget across calls and methods, a deposit address paid once, the pause rules, and
//! tampered or foreign quotes.

use super::hl::{at, vectors as hl_vectors, VECTOR_DESK_EVM};
use super::sol::{outcome, vector_solana};
use super::*;
use crate::action::{Pending, UnsignedAction};
use crate::mpc::SignRequest;
use crate::rescue::{decayed, ed25519_verify, DeskCounters, DEPOSIT_RING, RESCUE_WINDOW_MS};
use crate::sol::sha256;
use gimbal_core::errors::{E_NO_DESK, E_QUOTE_FIELDS, E_QUOTE_SIGNATURE, E_RESCUE_CAP};
use gimbal_core::oneclick::{
    check_cost, verify_quote, Context, DeskAddresses, Method, VerifiedQuote, SOL_USDC,
};
use gimbal_core::phoenix::{check_message, Rescue};
use gimbal_core::solana::{parse_message, SolDesk};
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::base64::Engine as _;

/// 2026-11-01T00:00:00Z: before every live quote's deadline (2026-11-03).
const NOW_MS: u64 = 1_793_491_200_000;
const ORDERLY_RECEIVER: &str = "0xc48b812bb43401392c037381aca934f4069c0517";

const ARB_QUOTE: &str = "Orderly money out: Arbitrum USDC (desk EVM) to Hyperliquid";
const SOL_ORDERLY_QUOTE: &str = "Solana USDC to the pinned Orderly receiver, 10 USDC";
const SOL_HL_QUOTE: &str = "rescue Phoenix -> Hyperliquid: Solana USDC to the desk EVM address";

fn live() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/oneclick-live.json")).unwrap()
}

fn recorded() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/oneclick.json")).unwrap()
}

fn eip3009() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/eip3009.json")).unwrap()
}

fn solana_vectors() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/solana.json")).unwrap()
}

fn named<'a>(list: &'a Value, name: &str) -> &'a Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no case {name:?}"))
}

/// A quote and its signature, as the relayer passes them.
fn quote(doc: &Value, name: &str) -> (String, String) {
    let q = named(&doc["quotes"], name);
    (
        q["canonical_json"].as_str().unwrap().to_owned(),
        q["signature"].as_str().unwrap().to_owned(),
    )
}

fn deposit_of(doc: &Value, name: &str) -> String {
    named(&doc["quotes"], name)["response"]["quote"]["depositAddress"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The quotes' desk: `alpha` on the vectors' EVM address and Solana authority, with the pinned
/// Orderly receiver, operator `operator()`, cap 50 USD an hour.
fn rescue_desk_with(policy: Policy) -> Gimbal {
    let mut g = testnet();
    let mut desk = Desk::new(
        owner(),
        policy,
        VECTOR_DESK_EVM.into(),
        vector_solana(),
        "woofi_dex",
    );
    desk.operator = Some(operator());
    desk.orderly_receiver = Some(ORDERLY_RECEIVER.into());
    g.desks.insert("alpha".into(), desk);
    g.desk_counters
        .insert("alpha".into(), DeskCounters::default());
    g
}

/// The Solana vectors' Phoenix markets, 100 USD a leg, a 2% band, the default rescue policy.
fn rescue_policy() -> Policy {
    let ctx = &solana_vectors()["ctx"]["sol_sign_rescue"];
    let num = |v: &Value| -> u64 { v.as_str().unwrap().parse().unwrap() };
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
        max_notional_usd: 100,
        price_band_bps: 200,
        oracle_max_age_s: 300,
        ..policy()
    }
}

fn rescue_desk() -> Gimbal {
    rescue_desk_with(rescue_policy())
}

fn counters(g: &Gimbal) -> DeskCounters {
    *g.desk_counters.get("alpha").unwrap()
}

/// Clears the desk's deposit ring, so the one live Arbitrum quote can sign again: the tests that
/// count many rescues have no second live quote.
fn forget_deposits(g: &mut Gimbal) {
    let mut c = counters(g);
    c.deposits = Default::default();
    g.desk_counters.insert("alpha".into(), c);
}

/// The live Arbitrum quote as the desk verifies it at `NOW_MS`, for the build steps to be handed
/// copies with other amounts and deposit addresses.
fn arb_verified(g: &Gimbal) -> VerifiedQuote {
    at(operator(), NOW_MS, yocto(0));
    let (q, sig) = quote(&live(), ARB_QUOTE);
    g.verified_quote("alpha", &q, &sig, Method::EvmUsdcToIntents)
}

/// `v` paying deposit address `0x…<n>` instead, `amount_e8` in (6 decimals), `min_out_e8` out.
fn paying(v: &VerifiedQuote, n: u32, amount_e8: u128, min_out_e8: u128) -> VerifiedQuote {
    VerifiedQuote {
        deposit_address: Some(format!("0x{n:040x}")),
        amount_in: amount_e8 / 100,
        amount_in_e8: amount_e8,
        min_amount_out_e8: min_out_e8,
        ..v.clone()
    }
}

fn evm_to_intents(g: &mut Gimbal, q: &(String, String)) -> Result<UnsignedAction, String> {
    outcome(|| {
        g.prepare_evm_usdc_to_intents("alpha".into(), q.0.clone(), q.1.clone(), "out".into())
    })
}

fn digest_of(hex_str: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_str.trim_start_matches("0x"), &mut out).unwrap();
    out
}

// --- evm_usdc_to_intents ---

#[test]
fn evm_usdc_to_intents_signs_the_eip3009_contract_cases_and_moves_the_counter() {
    let mut g = rescue_desk();
    let q = quote(&live(), ARB_QUOTE);
    let v = eip3009();
    let cases: Vec<&Value> = v["contract_cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["network"] == "testnet")
        .collect();
    assert_eq!(cases.len(), 2);
    let mut times = vec![];
    for c in cases {
        let name = c["name"].as_str().unwrap();
        assert_eq!(c["quote"], ARB_QUOTE);
        assert_eq!(
            counters(&g).eip3009_next.to_string(),
            c["counter"].as_str().unwrap()
        );
        // Both cases sign the one live quote, which the desk's ring would refuse the second time.
        forget_deposits(&mut g);
        let ms = c["now_s"].as_u64().unwrap() * 1000;
        times.push(ms);
        at(operator(), ms, yocto(0));
        let got = evm_to_intents(&mut g, &q).unwrap();
        assert_eq!(
            (got.desk_id.as_str(), got.venue.as_str(), got.kind.as_str()),
            ("alpha", "arbitrum", "transfer_with_authorization"),
            "{name}"
        );
        assert_eq!(
            serde_json::to_value(&got.payload).unwrap(),
            c["payload"],
            "{name}"
        );
        assert_eq!(
            got.sign_request,
            SignRequest::evm("alpha", &digest_of(c["digest"].as_str().unwrap())),
            "{name}"
        );
        assert_eq!(got.amount.as_deref(), Some("10"));
        assert_eq!(
            got.deposit_address.as_deref(),
            Some("0x1d5ed45fc6fdcca040abebb0b016bdf4962931be")
        );
        assert_eq!(
            got.reason_sha256,
            Some(hex::encode(env::sha256_array("out")))
        );
    }
    let c = counters(&g);
    assert_eq!(c.eip3009_next, 2);
    let ten = 10 * 100_000_000;
    assert_eq!(c.rescue_at_ms, times[1]);
    assert_eq!(c.rescue_spent_e8, decayed(ten, times[0], times[1]) + ten);
}

/// The cap slides (review round 2, item 4): a rescue weighs its full amount when made and nothing
/// an hour later, falling linearly in between, so no stretch of time sees more than the cap plus
/// what the time gone frees, and a moment never sees more than the cap.
#[test]
fn every_rescue_method_counts_against_one_sliding_hourly_cap() {
    // A 10% cost bound, so the cost budget (5 USD) stays out of the cap's way.
    let mut g = rescue_desk_with(Policy {
        max_transfer_cost_bps: 1000,
        ..rescue_policy()
    });
    let q = quote(&live(), ARB_QUOTE);
    let again = |g: &mut Gimbal, ms: u64| {
        forget_deposits(g);
        at(operator(), ms, yocto(0));
        evm_to_intents(g, &q)
    };
    // 50 USD an hour: five 10 USDC authorizations, then a millisecond later nothing.
    for _ in 0..5 {
        again(&mut g, NOW_MS).unwrap();
    }
    let refused = again(&mut g, NOW_MS + 1).unwrap_err();
    assert_eq!(
        refused,
        "E_RESCUE_CAP: amountIn 10 USDC is over what is left of the hourly rescue cap, \
         0.00001388 USD"
    );
    assert_eq!(
        counters(&g).eip3009_next,
        5,
        "a refused call takes no nonce"
    );
    // A Solana rescue shares the cap.
    let (message, _) = rescue_message("rescue: USDC to the verified 1Click deposit owner");
    let sol = quote(&live(), SOL_ORDERLY_QUOTE);
    at(operator(), NOW_MS + 1, yocto(0));
    let refused = sol_rescue(&mut g, &message, &sol).unwrap_err();
    assert!(
        refused.starts_with(&format!("{E_RESCUE_CAP}: ")),
        "{refused}"
    );
    // A fifth of an hour later a fifth of the cap is back: one more, then nothing.
    let later = NOW_MS + RESCUE_WINDOW_MS / 5;
    assert_eq!(counters(&g).remaining_cap_e8(50, later), 10 * 100_000_000);
    again(&mut g, later).unwrap();
    assert!(again(&mut g, later).unwrap_err().starts_with(E_RESCUE_CAP));
    let c = counters(&g);
    assert_eq!(
        (c.rescue_at_ms, c.rescue_spent_e8),
        (later, 50 * 100_000_000)
    );
    // Half an hour after the last rescue half the cap is back, an hour after it all of it.
    assert_eq!(
        c.remaining_cap_e8(50, later + RESCUE_WINDOW_MS / 2),
        25 * 100_000_000
    );
    at(operator(), later + RESCUE_WINDOW_MS, yocto(0));
    sol_rescue(&mut g, &message, &sol).unwrap();
    assert_eq!(counters(&g).rescue_spent_e8, 10 * 100_000_000);
    // A lower cap applies at once.
    let mut g = rescue_desk_with(Policy {
        rescue_cap_usd_per_hour: 9,
        ..rescue_policy()
    });
    at(operator(), NOW_MS, yocto(0));
    assert!(evm_to_intents(&mut g, &q)
        .unwrap_err()
        .starts_with(E_RESCUE_CAP));
    assert_eq!(counters(&g), DeskCounters::default());
}

#[test]
fn a_meter_falls_linearly_over_the_hour_and_rounds_up() {
    let w = RESCUE_WINDOW_MS;
    assert_eq!(decayed(u128::from(w), 0, 0), u128::from(w));
    assert_eq!(decayed(u128::from(w), 0, 1), u128::from(w) - 1);
    assert_eq!(decayed(1, 0, w - 1), 1, "rounded up");
    assert_eq!(decayed(1, 0, w), 0);
    assert_eq!(decayed(1, 0, u64::MAX), 0);
    assert_eq!(decayed(u128::MAX, 0, w / 2), u128::MAX / 2 + 1);
    assert_eq!(
        decayed(7, 10, 5),
        7,
        "a time before the last rescue frees nothing"
    );
}

/// The skim the review found (round 2, item 1): rescues that each cost what `check_cost` allows,
/// the flat 0.5 USDC on any amount, could pay most of the cap away in fees an hour, on a paused
/// desk too. The hourly cost budget, max(cap × bps / 10⁴, 2 × flat) = 1 USD at the defaults,
/// stops it. It counts the signed quote's cost only, not Hyperliquid's 1 USDC send fee, a burn
/// that pays no third party (`transfer_cost_e8`).
#[test]
fn the_hourly_cost_budget_stops_skimming_the_cap_through_fees() {
    let mut g = rescue_desk();
    g.desks.get_mut("alpha").unwrap().paused = true;
    let base = arb_verified(&g);
    // 1 USDC in, 0.5 out: within the per-transfer bound.
    let skim = |n| paying(&base, n, 100_000_000, 50_000_000);
    assert!(check_cost(&skim(1), 100, 500_000).is_ok());
    let build = |g: &mut Gimbal, q: &VerifiedQuote| {
        outcome(|| g.build_evm_usdc_to_intents("alpha".into(), q, "out"))
    };
    at(operator(), NOW_MS, yocto(0));
    build(&mut g, &skim(1)).unwrap();
    build(&mut g, &skim(2)).unwrap();
    let before = counters(&g);
    assert_eq!(
        build(&mut g, &skim(3)).unwrap_err(),
        "E_RESCUE_CAP: the rescue may cost 0.5 USD, over what is left of the hourly rescue cost \
         budget, 0 of 1 USD"
    );
    assert_eq!(counters(&g), before, "a refused rescue counts nothing");
    assert_eq!(
        (before.rescue_spent_e8, before.rescue_cost_e8),
        (2 * 100_000_000, 100_000_000)
    );
    // The cap alone would have let 48 more through: 24 USDC of fees an hour.
    assert_eq!(before.remaining_cap_e8(50, NOW_MS), 48 * 100_000_000);
    // A quarter of an hour later a quarter of the budget is back, too little; at half, enough.
    at(operator(), NOW_MS + RESCUE_WINDOW_MS / 4, yocto(0));
    assert!(build(&mut g, &skim(3))
        .unwrap_err()
        .contains("0.25 of 1 USD"));
    at(operator(), NOW_MS + RESCUE_WINDOW_MS / 2, yocto(0));
    build(&mut g, &skim(3)).unwrap();

    // The live quote through the public method on the paused desk: 0.415247 USDC each, two fit.
    let mut g = rescue_desk();
    g.desks.get_mut("alpha").unwrap().paused = true;
    let q = quote(&live(), ARB_QUOTE);
    for _ in 0..2 {
        forget_deposits(&mut g);
        at(operator(), NOW_MS, yocto(0));
        evm_to_intents(&mut g, &q).unwrap();
    }
    forget_deposits(&mut g);
    assert_eq!(
        evm_to_intents(&mut g, &q).unwrap_err(),
        "E_RESCUE_CAP: the rescue may cost 0.415247 USD, over what is left of the hourly rescue \
         cost budget, 0.169506 of 1 USD"
    );

    // Hyperliquid on a 20 USD cap desk (c6-desk's): the 1 USD budget counts the quote's 0.355657,
    // not the 1 USDC send fee, so two sends with a normal quote cost fit, and a third does not.
    let mut g = rescue_desk_with(Policy {
        rescue_cap_usd_per_hour: 20,
        ..rescue_policy()
    });
    let hl = |n: u32, min_out_e8| VerifiedQuote {
        method: Method::HlSendToIntents,
        deposit_address: Some(format!("0x{n:040x}")),
        amount_in: 400_000_000,
        amount_in_e8: 400_000_000,
        min_amount_out_e8: min_out_e8,
        destination_asset: SOL_USDC.into(),
        recipient: vector_solana().authority,
        deadline_ms: u64::MAX,
    };
    let send =
        |g: &mut Gimbal, q| outcome(|| g.build_hl_send_to_intents("alpha".into(), &q, "out"));
    at(operator(), NOW_MS, yocto(0));
    send(&mut g, hl(1, 364_434_300)).unwrap();
    send(&mut g, hl(2, 364_434_300)).unwrap();
    assert_eq!(counters(&g).rescue_cost_e8, 2 * 35_565_700);
    let nonces = g.hl_nonces.get("alpha").copied();
    assert_eq!(
        send(&mut g, hl(3, 364_434_300)).unwrap_err(),
        "E_RESCUE_CAP: the rescue may cost 0.355657 USD, over what is left of the hourly rescue \
         cost budget, 0.288686 of 1 USD"
    );
    assert_eq!(g.hl_nonces.get("alpha").copied(), nonces, "no nonce taken");
    // A send costing nothing through its quote still fits.
    send(&mut g, hl(4, 400_000_000)).unwrap();
    assert_eq!(counters(&g).rescue_cost_e8, 2 * 35_565_700);
}

/// A quote pays once (review round 2, item 2): a rescue to a deposit address one of the desk's
/// last 32 rescues paid is refused, whatever quote names it.
#[test]
fn a_deposit_address_is_paid_once() {
    let mut g = rescue_desk();
    let q = quote(&live(), ARB_QUOTE);
    at(operator(), NOW_MS, yocto(0));
    evm_to_intents(&mut g, &q).unwrap();
    let before = counters(&g);
    assert_eq!(
        evm_to_intents(&mut g, &q).unwrap_err(),
        "E_QUOTE_FIELDS: deposit address 0x1d5ed45fc6fdcca040abebb0b016bdf4962931be was paid by \
         one of this desk's last 32 rescues; a quote pays once"
    );
    assert_eq!(counters(&g), before, "a refused rescue counts nothing");
    // The same address in another verified quote (the build step sees the address alone).
    let other = paying(&arb_verified(&g), 0, 100_000_000, 100_000_000);
    let other = VerifiedQuote {
        deposit_address: Some("0x1d5ed45fc6fdcca040abebb0b016bdf4962931be".into()),
        ..other
    };
    let got = outcome(|| g.build_evm_usdc_to_intents("alpha".into(), &other, "out"));
    assert!(got.unwrap_err().starts_with(E_QUOTE_FIELDS));
}

#[test]
fn the_deposit_ring_forgets_the_oldest_of_33() {
    let mut c = DeskCounters::default();
    let hash = |i: usize| [u8::try_from(i + 1).unwrap(); 32];
    for i in 0..DEPOSIT_RING {
        c.spend(0, 0, hash(i), NOW_MS);
    }
    assert!((0..DEPOSIT_RING).all(|i| c.paid(&hash(i))));
    assert_eq!(c.deposit_next, 0);
    c.spend(0, 0, hash(DEPOSIT_RING), NOW_MS);
    assert!(!c.paid(&hash(0)));
    assert!((1..=DEPOSIT_RING).all(|i| c.paid(&hash(i))));
    assert_eq!(c.deposit_next, 1);
}

/// A rescue whose MPC call returns no signature stays counted (review round 2, item 7): a late
/// `respond` can still publish the signature, so neither the cap, the cost nor the deposit
/// address is given back.
#[test]
fn a_rescue_the_mpc_did_not_sign_stays_counted() {
    let mut g = rescue_desk();
    let q = quote(&live(), ARB_QUOTE);
    at(operator(), NOW_MS, yocto(0));
    let action = evm_to_intents(&mut g, &q).unwrap();
    let counted = counters(&g);
    assert_eq!(counted.rescue_spent_e8, 10 * 100_000_000);
    callback(vec![PromiseResult::Failed]);
    let got = outcome(|| {
        g.on_signed(Pending {
            request_id: 0,
            signer: VECTOR_DESK_EVM.into(),
            action,
        })
    });
    assert!(got.unwrap_err().starts_with("E_MPC: "));
    assert_eq!(counters(&g), counted);
    at(operator(), NOW_MS + 1, yocto(0));
    assert!(evm_to_intents(&mut g, &q)
        .unwrap_err()
        .starts_with(E_QUOTE_FIELDS));
}

#[test]
fn a_rescue_refuses_tampered_foreign_and_expired_quotes() {
    let mut g = rescue_desk();
    let (arb, arb_sig) = quote(&live(), ARB_QUOTE);
    at(operator(), NOW_MS, yocto(0));
    let refused = |g: &mut Gimbal, q: &str, sig: &str| {
        evm_to_intents(g, &(q.to_owned(), sig.to_owned())).unwrap_err()
    };
    // The deposit address, the recipient and the amount, each changed in the signed string.
    let deposit = deposit_of(&live(), ARB_QUOTE);
    for (from, to) in [
        (
            deposit.as_str(),
            "0x8ba1f109551bd432803012645ac136ddd64dba72",
        ),
        (
            r#""recipient":"0x1a642f0e3c3af545e7acbd38b07251b3990914f1""#,
            r#""recipient":"0x8ba1f109551bd432803012645ac136ddd64dba72""#,
        ),
        (r#""amountIn":"10000000""#, r#""amountIn":"1000000""#),
    ] {
        assert_eq!(arb.matches(from).count(), 1, "{from}");
        let tampered = arb.replace(from, to);
        assert!(
            refused(&mut g, &tampered, &arb_sig).starts_with(E_QUOTE_SIGNATURE),
            "{from}"
        );
    }
    // Every tampered quote of the recordings (Solana quotes, refused before their origin counts).
    for t in live()["tampered"].as_array().unwrap() {
        let got = refused(
            &mut g,
            t["canonical_json"].as_str().unwrap(),
            t["signature"].as_str().unwrap(),
        );
        assert!(got.starts_with(E_QUOTE_SIGNATURE), "{}: {got}", t["name"]);
    }
    // A quote of another origin, a dry quote, a quote another desk would get.
    let (sol, sol_sig) = quote(&live(), SOL_HL_QUOTE);
    assert!(refused(&mut g, &sol, &sol_sig).starts_with(E_QUOTE_FIELDS));
    let (dry, dry_sig) = quote(&recorded(), ARB_QUOTE);
    assert!(refused(&mut g, &dry, &dry_sig).starts_with(E_QUOTE_FIELDS));
    g.desks.get_mut("alpha").unwrap().evm_address = OTHER_EVM.into();
    assert!(refused(&mut g, &arb, &arb_sig).starts_with(E_QUOTE_FIELDS));
    let mut g = rescue_desk();
    // At the deadline, 2026-11-03T15:59:12.894Z, the quote is dead.
    at(operator(), 1_793_721_552_894, yocto(0));
    assert!(refused(&mut g, &arb, &arb_sig).starts_with(E_QUOTE_FIELDS));
    at(operator(), 1_793_721_552_893, yocto(0));
    evm_to_intents(&mut g, &(arb.clone(), arb_sig.clone())).unwrap();
    // A cost over the policy's bound: 10 USDC in, 9.584753 out is 0.42 USDC, over 0.4.
    let mut g = rescue_desk_with(Policy {
        max_transfer_cost_flat_e6: 400_000,
        ..rescue_policy()
    });
    at(operator(), NOW_MS, yocto(0));
    let got = refused(&mut g, &arb, &arb_sig);
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert!(got.contains("cost"), "{got}");
    assert_eq!(counters(&g), DeskCounters::default());
}

#[test]
fn rescues_are_for_the_owner_and_the_operator_and_pass_a_paused_desk() {
    let mut g = rescue_desk();
    let q = quote(&live(), ARB_QUOTE);
    at(stranger(), NOW_MS, yocto(0));
    assert!(evm_to_intents(&mut g, &q)
        .unwrap_err()
        .starts_with(E_NOT_ALLOWED));
    at(operator(), NOW_MS, yocto(0));
    let unknown = outcome(|| {
        g.prepare_evm_usdc_to_intents("beta".into(), q.0.clone(), q.1.clone(), "out".into())
    });
    assert!(unknown.unwrap_err().starts_with(E_NO_DESK));
    let long = outcome(|| {
        g.prepare_evm_usdc_to_intents("alpha".into(), q.0.clone(), q.1.clone(), "x".repeat(281))
    });
    assert!(long.unwrap_err().starts_with(E_ARGS));
    g.desks.get_mut("alpha").unwrap().paused = true;
    for who in [owner(), operator()] {
        forget_deposits(&mut g);
        at(who, NOW_MS, yocto(0));
        evm_to_intents(&mut g, &q).unwrap();
    }
    let (message, _) = rescue_message("rescue: USDC to the verified 1Click deposit owner");
    sol_rescue(&mut g, &message, &quote(&live(), SOL_ORDERLY_QUOTE)).unwrap();
    // hl_send_to_intents passes the pause guard and stops at the quote.
    at(operator(), NOW_MS, yocto(0));
    let (sol, sol_sig) = quote(&live(), SOL_HL_QUOTE);
    let got = outcome(|| g.prepare_hl_send_to_intents("alpha".into(), sol, sol_sig, "out".into()));
    assert!(got.unwrap_err().starts_with(E_QUOTE_FIELDS));
}

/// The `signed` event of a rescue names the deposit address it pays, after `amount`.
#[test]
fn the_signed_event_of_a_rescue_names_its_deposit_address() {
    let mut g = rescue_desk();
    at(operator(), NOW_MS, yocto(0));
    let action = evm_to_intents(&mut g, &quote(&live(), ARB_QUOTE)).unwrap();
    crate::events::emit_signed(&Pending {
        request_id: 7,
        signer: VECTOR_DESK_EVM.into(),
        action,
    });
    assert_eq!(
        get_logs(),
        vec![event(
            "signed",
            &format!(
                r#"{{"desk_id":"alpha","request_id":7,"venue":"arbitrum","kind":"transfer_with_authorization","amount":"10","deposit_address":"0x1d5ed45fc6fdcca040abebb0b016bdf4962931be","reason_sha256":"{}"}}"#,
                hex::encode(env::sha256_array("out"))
            )
        )]
    );
}

// --- sol_sign_rescue ---

/// The solana.json case starting with `prefix`, paid to the live quote's deposit owner instead
/// of the recordings' `J2xcc…`: both that key and its USDC account replaced in the message bytes.
/// Returns the message and what the core says of it.
fn rescue_message(prefix: &str) -> (Vec<u8>, Value) {
    let v = solana_vectors();
    let c = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"].as_str().unwrap().starts_with(prefix))
        .unwrap_or_else(|| panic!("no case {prefix:?}"))
        .clone();
    (patched(&c), c)
}

fn patched(c: &Value) -> Vec<u8> {
    let key = |s: &str| check_base58(s);
    let old_owner = key(c["rescue"]["deposit_owner"].as_str().unwrap());
    let new_owner = key(&deposit_of(&live(), SOL_ORDERLY_QUOTE));
    let ata = |owner| Rescue::new(sha256, owner, 1).unwrap().deposit_account;
    let mut bytes = hex::decode(c["message_hex"].as_str().unwrap()).unwrap();
    assert_eq!(c["rescue"]["amount_in"], "10000000");
    for (from, to) in [(old_owner, new_owner), (ata(old_owner), ata(new_owner))] {
        replace_key(&mut bytes, &from, &to);
    }
    bytes
}

fn check_base58(s: &str) -> [u8; 32] {
    gimbal_core::ids::check_base58_32("key", s).unwrap()
}

fn replace_key(bytes: &mut [u8], from: &[u8; 32], to: &[u8; 32]) {
    let mut i = 0;
    while i + 32 <= bytes.len() {
        if &bytes[i..i + 32] == from {
            bytes[i..i + 32].copy_from_slice(to);
            i += 32;
        } else {
            i += 1;
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn sol_rescue(
    g: &mut Gimbal,
    message: &[u8],
    q: &(String, String),
) -> Result<UnsignedAction, String> {
    outcome(|| {
        g.prepare_sol_sign_rescue(
            "alpha".into(),
            b64(message),
            q.0.clone(),
            q.1.clone(),
            "rescue".into(),
        )
    })
}

fn vector_accounts() -> SolDesk {
    SolDesk::derive(sha256, check_base58(&vector_solana().authority)).unwrap()
}

/// Every rescue row of solana.json, paid to the live quote's deposit owner, gets the core's
/// answer in rescue mode: the simple rescue signs as `rescue` and spends the cap, the five attacks
/// are refused with the code the vectors name, and the one-transaction rescue as the review
/// decided (`E_SOL_PROGRAM` without a Revoke after its unwrap); with the Revoke appended it signs.
#[test]
fn sol_sign_rescue_answers_every_rescue_row_as_the_core_does() {
    let v = solana_vectors();
    let q = quote(&live(), SOL_ORDERLY_QUOTE);
    let owner_key = check_base58(&deposit_of(&live(), SOL_ORDERLY_QUOTE));
    let rescue = Rescue::new(sha256, owner_key, 10_000_000).unwrap();
    let (mut signed, mut refused) = (0, 0);
    let one_transaction = "rescue in one transaction: Phoenix withdraw + Ember unwrap + ATA for \
                           the deposit owner + TransferChecked of amountIn";
    let mut rows: Vec<(String, Vec<u8>, String)> = vec![];
    for c in v["cases"].as_array().unwrap() {
        if c["method"] != "sol_sign_rescue" {
            continue;
        }
        let name = c["name"].as_str().unwrap();
        let expect = if name == one_transaction {
            rows.push((
                format!("{name}, with the Revoke"),
                with_revoke(&patched(c)),
                "ok".into(),
            ));
            "E_SOL_PROGRAM".to_owned()
        } else if c["expect"]["ok"] == true {
            "ok".into()
        } else {
            c["expect"]["code"].as_str().unwrap().to_owned()
        };
        rows.push((name.to_owned(), patched(c), expect));
    }
    for (name, bytes, expect) in &rows {
        let mut g = rescue_desk();
        at(operator(), NOW_MS, yocto(0));
        let want = check_message(
            sha256,
            &rescue_policy(),
            &vector_accounts(),
            bytes,
            &|_| None,
            Some(&rescue),
        );
        let got = sol_rescue(&mut g, bytes, &q);
        match (&want, &got) {
            (Ok(w), Ok(got)) => {
                assert_eq!(expect, "ok", "{name}");
                assert_eq!(w.kind, "rescue");
                assert_eq!(
                    (got.venue.as_str(), got.kind.as_str()),
                    ("phoenix", "rescue")
                );
                assert_eq!(
                    serde_json::to_value(&got.payload).unwrap(),
                    json!({ "message_b64": b64(bytes) })
                );
                assert_eq!(got.sign_request, SignRequest::sol("alpha", bytes));
                assert_eq!(got.amount.as_deref(), Some("10"));
                assert_eq!(
                    got.deposit_address.as_deref(),
                    Some("3c4FLYTWuAbDVwi1Xpz4kFryXW2GudrmXUzLq4W17oxi")
                );
                assert_eq!(counters(&g).rescue_spent_e8, 10 * 100_000_000);
                signed += 1;
            }
            (Err(w), Err(got)) => {
                assert_eq!(got, &w.to_string(), "{name}");
                assert_eq!(expect, w.code, "{name}");
                assert_eq!(counters(&g), DeskCounters::default(), "{name}");
                refused += 1;
            }
            _ => panic!("{name}: the core says {want:?}, the contract {got:?}"),
        }
    }
    assert_eq!((signed, refused), (2, 6));
}

#[test]
fn sol_sign_rescue_refuses_a_quote_that_does_not_match_the_message() {
    let mut g = rescue_desk();
    at(operator(), NOW_MS, yocto(0));
    let (message, _) = rescue_message("rescue: USDC to the verified 1Click deposit owner");
    // The 4 USDC quote to the desk EVM pays another deposit owner, another amount.
    let other = quote(&live(), SOL_HL_QUOTE);
    let got = sol_rescue(&mut g, &message, &other).unwrap_err();
    assert!(got.starts_with("E_SOL_ACCOUNT: "), "{got}");
    // The recordings' message still pays J2xcc…, which no live quote names.
    let v = solana_vectors();
    let c = named(
        &v["cases"],
        "rescue: USDC to the verified 1Click deposit owner (ATA create + TransferChecked)",
    );
    let original = hex::decode(c["message_hex"].as_str().unwrap()).unwrap();
    let got = sol_rescue(&mut g, &original, &quote(&live(), SOL_ORDERLY_QUOTE)).unwrap_err();
    assert!(got.starts_with("E_SOL_ACCOUNT: "), "{got}");
    // An Arbitrum quote is not a Solana rescue.
    let got = sol_rescue(&mut g, &message, &quote(&live(), ARB_QUOTE)).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    // The 5 USDC quote to the Orderly receiver is under Orderly's 6 USDC minimum out.
    let five = quote(
        &live(),
        "Solana USDC to the pinned Orderly receiver, 5 USDC (minAmountOut below 6)",
    );
    let got = sol_rescue(&mut g, &message, &five).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    // Without the pinned receiver the Orderly quote pays no desk address.
    g.desks.get_mut("alpha").unwrap().orderly_receiver = None;
    let got = sol_rescue(&mut g, &message, &quote(&live(), SOL_ORDERLY_QUOTE)).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert_eq!(counters(&g), DeskCounters::default());
}

/// An instruction by its addresses: program, accounts, data.
type Ix = ([u8; 32], Vec<[u8; 32]>, Vec<u8>);

/// The legacy message `m` with `extra` appended to its instructions.
fn appended(m: &[u8], extra: Vec<Ix>) -> Vec<u8> {
    rewritten(m, |ixs| ixs.extend(extra))
}

/// The legacy message `m` with its instructions edited by `edit`, the keys the new ones lack
/// appended as read-only (the contract does not read writability); unused keys stay.
fn rewritten(m: &[u8], edit: impl FnOnce(&mut Vec<Ix>)) -> Vec<u8> {
    let a = parse_message(m).unwrap();
    let mut list: Vec<Ix> = a
        .instructions
        .iter()
        .map(|ix| (ix.program, ix.accounts.clone(), ix.data.to_vec()))
        .collect();
    edit(&mut list);
    let mut keys = a.keys.clone();
    for (program, accounts, _) in &list {
        for k in std::iter::once(program).chain(accounts) {
            if !keys.contains(k) {
                keys.push(*k);
            }
        }
    }
    let added = u8::try_from(keys.len() - a.keys.len()).unwrap();
    let index = |k: &[u8; 32]| u8::try_from(keys.iter().position(|x| x == k).unwrap()).unwrap();
    let ixs: Vec<(u8, Vec<u8>, Vec<u8>)> = list
        .iter()
        .map(|(program, accounts, data)| {
            (
                index(program),
                accounts.iter().map(index).collect(),
                data.clone(),
            )
        })
        .collect();
    let mut out = vec![
        a.num_required_signatures,
        a.num_readonly_signed,
        a.num_readonly_unsigned + added,
    ];
    compact(&mut out, keys.len());
    for k in &keys {
        out.extend_from_slice(k);
    }
    out.extend_from_slice(&a.recent_blockhash);
    compact(&mut out, ixs.len());
    for (program, accounts, data) in ixs {
        out.push(program);
        compact(&mut out, accounts.len());
        out.extend_from_slice(&accounts);
        compact(&mut out, data.len());
        out.extend_from_slice(&data);
    }
    out
}

/// `m` followed by the instructions of `other` besides its compute budget.
fn merged(m: &[u8], other: &[u8]) -> Vec<u8> {
    let compute_budget = check_base58("ComputeBudget111111111111111111111111111111");
    let b = parse_message(other).unwrap();
    let extra = b
        .instructions
        .iter()
        .filter(|ix| ix.program != compute_budget)
        .map(|ix| (ix.program, ix.accounts.clone(), ix.data.to_vec()))
        .collect();
    appended(m, extra)
}

/// `m` with a token `Revoke` of the desk's PhUSD account at the end, which an Ember unwrap that
/// spends an `Approve` needs after it (the review's item 6; the recorded one-transaction rescue
/// predates it).
fn with_revoke(m: &[u8]) -> Vec<u8> {
    let accounts = vector_accounts();
    let token = check_base58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    appended(
        m,
        vec![(token, vec![accounts.phusd_ata, accounts.authority], vec![5])],
    )
}

fn compact(out: &mut Vec<u8>, mut n: usize) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// The rescue's own pause rule (review round 2, item 6): on a paused desk a rescue message signs
/// only when it frees and pays out the quote's amountIn and nothing else. The simple rescue, and
/// the one-transaction rescue without its priority fee and its creates of desk accounts, sign;
/// the one-transaction rescue as the SDK builds it, or a rescue with an order or a cancel, need a
/// running desk.
#[test]
fn a_paused_desk_signs_only_a_rescue_that_frees_and_pays_amount_in() {
    let q = quote(&live(), SOL_ORDERLY_QUOTE);
    let (simple, _) = rescue_message("rescue: USDC to the verified 1Click deposit owner");
    let full = with_revoke(&rescue_message("rescue in one transaction:").0);
    let authority = vector_accounts().authority;
    let compute_budget = check_base58("ComputeBudget111111111111111111111111111111");
    let ata = check_base58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    let lean = rewritten(&full, |ixs| {
        ixs.retain(|(program, accounts, data)| {
            let unit_price = *program == compute_budget && data.first() == Some(&3);
            let desk_create = *program == ata && accounts[2] == authority;
            !unit_price && !desk_create
        });
    });
    let vector = |prefix: &str| {
        let v = solana_vectors();
        let c = v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"].as_str().unwrap().starts_with(prefix))
            .unwrap()
            .clone();
        hex::decode(c["message_hex"].as_str().unwrap()).unwrap()
    };
    let buy = merged(&simple, &vector("IOC buy 0.005 ETH, limit 2474.5"));
    let cancel = merged(&simple, &vector("cancel all ETH"));
    let paused_desk = || {
        let mut g = rescue_desk();
        g.desks.get_mut("alpha").unwrap().paused = true;
        at(contract_id(), NOW_MS, yocto(1));
        g.set_mock_price("ETH".into(), 245_000_000_000);
        at(operator(), NOW_MS, yocto(0));
        g
    };
    for (what, bytes) in [("simple", &simple), ("one transaction, lean", &lean)] {
        let mut g = paused_desk();
        let got = sol_rescue(&mut g, bytes, &q).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(got.kind, "rescue");
        // The same message through sol_sign: not a rescue, so the deposit owner is a stranger.
        let plain = outcome(|| g.prepare_sol_sign("alpha".into(), b64(bytes), "x".into()));
        assert!(plain.is_err(), "{what}");
    }
    for (what, bytes) in [
        ("one transaction, as the SDK builds it", &full),
        ("with an ETH buy", &buy),
        ("with a cancel", &cancel),
    ] {
        let mut g = paused_desk();
        let got = sol_rescue(&mut g, bytes, &q).unwrap_err();
        assert!(got.starts_with(&format!("{E_PAUSED}: ")), "{what}: {got}");
        assert_eq!(counters(&g), DeskCounters::default(), "{what}");
        // Running, the same message signs.
        g.desks.get_mut("alpha").unwrap().paused = false;
        let got = sol_rescue(&mut g, bytes, &q).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(got.kind, "rescue", "{what}");
    }
    // The core reads the merged order as an ETH buy that can grow the position, and the action
    // of the running desk carries it.
    let rescue = Rescue::new(
        sha256,
        check_base58(&deposit_of(&live(), SOL_ORDERLY_QUOTE)),
        10_000_000,
    )
    .unwrap();
    let reference = |s: &str| (s == "ETH").then_some(245_000_000_000u128);
    let checked = check_message(
        sha256,
        &rescue_policy(),
        &vector_accounts(),
        &buy,
        &reference,
        Some(&rescue),
    )
    .unwrap();
    assert_eq!(checked.orders.len(), 1);
    assert!(!checked.orders[0].reduce_only);
    let mut g = paused_desk();
    g.desks.get_mut("alpha").unwrap().paused = false;
    let got = sol_rescue(&mut g, &buy, &q).unwrap();
    assert_eq!(got.orders.len(), 1);
    assert_eq!(got.orders[0].side, "buy");
}

// --- hl_send_to_intents ---

/// No live quote has HyperCore USDC as its origin (1Click refused the pair on 2026-10-31), so the
/// signed dry quote of 2026-10-27 stands in: the contract refuses it as dry, and the core's
/// verified fields of it, with the `hl.json` vector's deposit address, build the vector's
/// `sendAsset` byte for byte.
#[test]
fn hl_send_to_intents_sends_the_verified_amount_to_the_deposit_address() {
    let doc = recorded();
    let name = "rescue Hyperliquid -> Phoenix: HyperCore USDC to the desk Solana authority";
    let (q, sig) = quote(&doc, name);
    // A 20 USD cap, as c6-desk: the 1 USD cost budget holds the quote's 0.36 (Hyperliquid's send
    // fee is not counted, `transfer_cost_e8`).
    let mut g = rescue_desk_with(Policy {
        rescue_cap_usd_per_hour: 20,
        ..rescue_policy()
    });
    let vector = named(
        &hl_vectors()["user_signed"]["cases"],
        "sendAsset 4 USDC perp -> 1Click deposit address (testnet)",
    )
    .clone();
    let nonce = vector["action"]["nonce"].as_u64().unwrap();
    at(operator(), nonce, yocto(0));
    let got = outcome(|| {
        g.prepare_hl_send_to_intents("alpha".into(), q.clone(), sig.clone(), "out".into())
    })
    .unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert!(got.contains("live"), "{got}");

    let fc = named(&doc["field_cases"], &format!("as quoted: {name}"));
    let ctx = Context {
        desk: DeskAddresses {
            desk_id: "alpha",
            evm: VECTOR_DESK_EVM,
            sol: &vector_solana().authority,
            orderly_receiver: Some(ORDERLY_RECEIVER),
        },
        contract: "gimbal.testnet",
        now_ms: fc["ctx"]["now_ms"].as_u64().unwrap(),
        remaining_cap_e8: 50 * 100_000_000,
        dry_ok: true,
    };
    let mut verified = verify_quote(
        sha256,
        ed25519_verify,
        &q,
        &sig,
        Method::HlSendToIntents,
        &ctx,
    )
    .unwrap();
    assert_eq!(
        (verified.amount_in, verified.amount_in_e8),
        (400_000_000, 400_000_000)
    );
    let destination = vector["action"]["destination"].as_str().unwrap();
    verified.deposit_address = Some(destination.to_owned());
    let action = g.build_hl_send_to_intents("alpha".into(), &verified, "out");
    let mut body = vector["exchange_body"].clone();
    body.as_object_mut().unwrap().remove("signature");
    assert_eq!(
        (action.venue.as_str(), action.kind.as_str()),
        ("hyperliquid", "sendAsset")
    );
    assert_eq!(serde_json::to_value(&action.payload).unwrap(), body);
    assert_eq!(
        action.sign_request,
        SignRequest::evm("alpha", &digest_of(vector["digest"].as_str().unwrap()))
    );
    assert_eq!(action.amount.as_deref(), Some("4"));
    assert_eq!(action.deposit_address.as_deref(), Some(destination));
    assert_eq!(counters(&g).rescue_spent_e8, 400_000_000);
    assert_eq!(g.hl_nonces.get("alpha").copied(), Some(nonce));

    // Hyperliquid's perp balance sends 6 decimals at most.
    verified.amount_in = 400_000_001;
    verified.amount_in_e8 = 400_000_001;
    at(operator(), nonce + 1, yocto(0));
    let got = outcome(|| g.build_hl_send_to_intents("alpha".into(), &verified, "out")).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert_eq!(counters(&g).rescue_spent_e8, 400_000_000);
}

#[test]
fn hl_send_to_intents_refuses_quotes_of_other_origins() {
    let mut g = rescue_desk();
    at(operator(), NOW_MS, yocto(0));
    for name in [SOL_HL_QUOTE, ARB_QUOTE, SOL_ORDERLY_QUOTE] {
        let (q, sig) = quote(&live(), name);
        let got = outcome(|| g.prepare_hl_send_to_intents("alpha".into(), q, sig, "out".into()))
            .unwrap_err();
        assert!(got.starts_with(E_QUOTE_FIELDS), "{name}: {got}");
    }
    assert_eq!(g.hl_nonces.get("alpha").copied(), None, "no nonce taken");
    assert_eq!(counters(&g), DeskCounters::default());
}
