//! The Solana policy against `vectors/solana.json` (the `sol_sign` messages, with the rescue rows
//! of C6) and `vectors/solana-onboarding.json` (the `sol_sign_register` messages), plus the
//! address derivations and the curve check against independent implementations.

use curve25519_dalek::edwards::CompressedEdwardsY;
use gimbal_core::ed25519::is_on_curve;
use gimbal_core::errors::{E_ORACLE_STALE, E_PRICE_BAND, E_SIZE, E_SOL_PROGRAM};
use gimbal_core::phoenix::{
    check_message, check_onboarding, Onboarding, Rescue, CANCEL_ALL, DEPOSIT_FUNDS, EMBER_DEPOSIT,
    EMBER_WITHDRAW, PHOENIX_ACTIVE_TRADER_BUFFER, PHOENIX_GLOBAL_CONFIGURATION,
    PHOENIX_GLOBAL_TRADER_INDEX, PHOENIX_LOG_AUTHORITY, PHOENIX_ONBOARDING_PERMISSION,
    PHOENIX_RISK_AUTHORITY, PLACE_MARKET_ORDER, REGISTER_TRADER, SET_TRADER_CAPABILITIES_DELEGATED,
    WITHDRAW_FUNDS,
};
use gimbal_core::policy::{PhoenixMarket, Policy, UnpricedAsset};
use gimbal_core::solana::{
    find_program_address, parse_message, phoenix_trader_address, Format, Pubkey, SolDesk,
    ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, EMBER_AUTHORITY, EMBER_PROGRAM, PHOENIX_ONBOARDER,
    PHOENIX_PROGRAM, PHUSD_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM, USDC_MINT,
};
use gimbal_core::Refusal;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn sol_doc() -> Value {
    serde_json::from_str(include_str!("vectors/solana.json")).unwrap()
}

fn onboarding_doc() -> Value {
    serde_json::from_str(include_str!("vectors/solana-onboarding.json")).unwrap()
}

fn key(v: &Value) -> Pubkey {
    let bytes = bs58::decode(v.as_str().unwrap()).into_vec().unwrap();
    bytes.try_into().unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap()
}

fn message(case: &Value) -> Vec<u8> {
    hex::decode(case["message_hex"].as_str().unwrap()).unwrap()
}

fn name(case: &Value) -> &str {
    case["name"].as_str().unwrap()
}

/// The context's policy: its three markets, cap and band.
fn vector_policy(ctx: &Value) -> Policy {
    let markets = ctx["markets"].as_object().unwrap();
    let policy = Policy {
        hl_assets: vec![],
        phoenix_markets: markets
            .values()
            .map(|m| PhoenixMarket {
                symbol: m["symbol"].as_str().unwrap().into(),
                orderbook: m["orderbook"].as_str().unwrap().into(),
                base_lot_e8: num(&m["base_lot_e8"]),
                tick_e8: num(&m["tick_usd_e8"]),
            })
            .collect(),
        orderly_symbols: vec![],
        max_notional_usd: num(&ctx["max_notional_usd"]),
        price_band_bps: u32::try_from(num(&ctx["price_band_bps"])).unwrap(),
        oracle_max_age_s: 300,
        rescue_cap_usd_per_hour: 0,
        max_transfer_cost_bps: 0,
        max_transfer_cost_flat_e6: 0,
        unpriced: vec![],
        unpriced_max_notional_usd: 0,
    };
    policy.validate().unwrap();
    assert_eq!(ctx["max_cu_limit"], 600_000);
    assert_eq!(ctx["max_cu_price"], 1_000_000);
    policy
}

fn vector_desk(doc: &Value) -> SolDesk {
    SolDesk::derive(sha256, key(&doc["desk"]["authority"])).unwrap()
}

fn reference_of(ctx: &Value) -> impl Fn(&str) -> Option<u128> + '_ {
    move |symbol| ctx["reference_prices_e8"][symbol].as_str()?.parse().ok()
}

fn rescue_of(case: &Value) -> Option<Rescue> {
    (case["method"] == "sol_sign_rescue").then(|| {
        let r = &case["rescue"];
        Rescue::new(sha256, key(&r["deposit_owner"]), num(&r["amount_in"])).unwrap()
    })
}

fn outcome(r: &Result<impl Sized, Refusal>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code.into(),
    }
}

fn expected(case: &Value) -> String {
    if case["expect"]["ok"] == true {
        "ok".into()
    } else {
        case["expect"]["code"].as_str().unwrap().into()
    }
}

#[test]
fn the_desk_accounts_are_derived_from_the_authority() {
    let doc = sol_doc();
    let desk = vector_desk(&doc);
    let d = &doc["desk"];
    assert_eq!(
        desk.usdc_ata,
        key(&d["usdc_ata"]),
        "web3.js findProgramAddressSync"
    );
    assert_eq!(desk.phusd_ata, key(&d["phusd_ata"]));
    assert_eq!(
        desk.trader,
        key(&d["phoenix_trader"]),
        "the Phoenix SDK's trader PDA"
    );
    // The deposit owner's USDC account of the rescue rows is account key 5 of the one-transaction
    // rescue, the destination of its TransferChecked.
    let case = &doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| name(c).starts_with("rescue in one transaction"))
        .unwrap();
    let rescue = rescue_of(case).unwrap();
    assert_eq!(
        rescue.deposit_account,
        key(&case["parsed"]["account_keys"][5])
    );
}

#[test]
fn every_sol_sign_case_gets_its_expected_answer() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let policy = vector_policy(ctx);
    let desk = vector_desk(&doc);
    let reference = reference_of(ctx);
    let mut wrong = vec![];
    let cases = doc["cases"].as_array().unwrap();
    for case in cases {
        let got = check_message(
            &policy,
            &desk,
            &message(case),
            &reference,
            rescue_of(case).as_ref(),
        );
        if outcome(&got) != expected(case) {
            wrong.push(format!(
                "{}: got {got:?}, want {}",
                name(case),
                expected(case)
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert_eq!(cases.len(), 53);
    assert_eq!(
        cases.iter().filter(|c| c["expect"]["ok"] == true).count(),
        13
    );
}

#[test]
fn a_rescue_message_never_passes_plain_sol_sign() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&doc), reference_of(ctx));
    let mut rows = 0;
    for case in doc["cases"].as_array().unwrap() {
        if case["method"] == "sol_sign_rescue" {
            rows += 1;
            let got = check_message(&policy, &desk, &message(case), &reference, None);
            assert!(got.is_err(), "{}", name(case));
        }
    }
    assert_eq!(rows, 7);
}

#[test]
fn without_a_fresh_price_every_priced_order_is_stale() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let (policy, desk) = (vector_policy(ctx), vector_desk(&doc));
    let mut stale = 0;
    for case in doc["cases"].as_array().unwrap() {
        let bytes = message(case);
        let got = check_message(&policy, &desk, &bytes, &|_| None, rescue_of(case).as_ref());
        let want = expected(case);
        let has_price = case["why"]
            .as_str()
            .is_none_or(|w| !w.contains("no priceInTicks"));
        let priced_order = parse_message(&bytes).is_ok_and(|m| {
            m.instructions
                .iter()
                .any(|ix| ix.program == PHOENIX_PROGRAM && ix.data.starts_with(&PLACE_MARKET_ORDER))
        });
        // Every row whose order reached the valuation (a pass, a band or a size refusal) now stops
        // at the missing price; every other row keeps its answer.
        let reached =
            priced_order && has_price && (want == "ok" || want == E_PRICE_BAND || want == E_SIZE);
        if reached {
            assert_eq!(outcome(&got), E_ORACLE_STALE, "{}", name(case));
            stale += 1;
        } else {
            assert_eq!(outcome(&got), want, "{}", name(case));
        }
    }
    assert_eq!(stale, 9, "6 passes, 1 oversize and 2 band refusals");
}

#[test]
fn an_unpriced_phoenix_market_is_capped_at_its_own_price_and_max_sz() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let mut policy = vector_policy(ctx);
    policy.unpriced = vec![UnpricedAsset {
        symbol: "ETH".into(),
        max_sz: "0.005".into(),
    }];
    policy.unpriced_max_notional_usd = 50;
    let desk = vector_desk(&doc);
    let run = |prefix: &str| {
        let case = doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| name(c).starts_with(prefix))
            .unwrap();
        check_message(&policy, &desk, &message(case), &|_| None, None)
    };
    let ok = run("IOC buy 0.005 ETH, limit 2474.5").unwrap();
    assert!(ok.orders[0].valued.unpriced());
    // No band for an unpriced symbol: 2500 vs 2450 passes, but 0.04 is over max_sz.
    run("attack: IOC buy at +2.04%").unwrap();
    let r = run("IOC sell 0.04 ETH at the cap").unwrap_err();
    assert_eq!(
        r.to_string(),
        "E_SIZE: instruction 2: ETH size 0.04 is over its max_sz 0.005 (an unpriced symbol, \
         capped in base units)"
    );
}

#[test]
fn kinds_and_the_pause_gate() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&doc), reference_of(ctx));
    let check = |prefix: &str| {
        let case = doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| name(c).starts_with(prefix))
            .unwrap();
        check_message(
            &policy,
            &desk,
            &message(case),
            &reference,
            rescue_of(case).as_ref(),
        )
        .unwrap()
    };
    for (prefix, kind, reduces_risk) in [
        ("cancel all ETH", "cancel_all", true),
        ("deposit 15 USDC", "deposit", true),
        ("withdraw 10 USDC", "withdraw", false),
        ("IOC sell 0.005 ETH", "order", false),
        ("Token Approve", "transaction", true),
        ("rescue in one transaction", "rescue", false),
    ] {
        let c = check(prefix);
        assert_eq!((c.kind, c.reduces_risk), (kind, reduces_risk), "{prefix}");
    }
    let sell = check("IOC sell 0.005 ETH, limit 2425.5");
    let o = &sell.orders[0];
    assert_eq!(
        (o.symbol.as_str(), o.bid, o.reduce_only),
        ("ETH", false, false)
    );
    assert_eq!((o.price_e8, o.size_e8), (242_550_000_000, 500_000));
    assert_eq!(o.valued.oracle_e8, Some(245_000_000_000));
}

/// The vector order message `prefix` with its order flags byte set to `flags`. The order is the
/// last instruction and its packet ends with orderFlags u8, cancelExisting bool.
fn with_flags(doc: &Value, prefix: &str, flags: u8) -> Vec<u8> {
    let case = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| name(c).starts_with(prefix))
        .unwrap();
    let mut bytes = message(case);
    let at = bytes.len() - 2;
    assert_eq!(bytes[at], 0);
    bytes[at] = flags;
    bytes
}

#[test]
fn a_reduce_only_order_reduces_risk_and_no_other_flag_passes() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&doc), reference_of(ctx));
    let close = with_flags(&doc, "IOC sell 0.005 ETH", 0x80);
    let c = check_message(&policy, &desk, &close, &reference, None).unwrap();
    assert!(c.orders[0].reduce_only && c.reduces_risk);
    for flags in [0x10, 0x20, 0x40, 0xc0, 0x01] {
        let bad = with_flags(&doc, "IOC sell 0.005 ETH", flags);
        let r = check_message(&policy, &desk, &bad, &reference, None).unwrap_err();
        assert_eq!(r.code, E_SOL_PROGRAM, "{flags:#04x}");
        assert!(r.msg.contains("only reduce-only (0x80) may be set"), "{r}");
    }
}

#[test]
fn the_parser_reads_what_web3_reads() {
    let doc = sol_doc();
    let mut compared = 0;
    for case in doc["cases"].as_array().unwrap() {
        let p = &case["parsed"];
        if p.is_null() {
            continue;
        }
        let bytes = message(case);
        let m = parse_message(&bytes).unwrap();
        assert_eq!(m.format, Format::Legacy);
        let h = &p["header"];
        assert_eq!(
            [
                m.num_required_signatures,
                m.num_readonly_signed,
                m.num_readonly_unsigned
            ]
            .map(u64::from),
            [
                num(&h["num_required_signatures"]),
                num(&h["num_readonly_signed"]),
                num(&h["num_readonly_unsigned"])
            ],
            "{}",
            name(case)
        );
        let keys: Vec<Pubkey> = p["account_keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(key)
            .collect();
        assert_eq!(m.keys, keys);
        assert_eq!(m.recent_blockhash, key(&p["recent_blockhash"]));
        let ixs = p["instructions"].as_array().unwrap();
        assert_eq!(m.instructions.len(), ixs.len());
        for (ix, want) in m.instructions.iter().zip(ixs) {
            assert_eq!(u64::from(ix.program_index), num(&want["program_index"]));
            let idx: Vec<u8> = want["account_indexes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| u8::try_from(num(i)).unwrap())
                .collect();
            assert_eq!(ix.account_indexes, idx);
            assert_eq!(hex::encode(ix.data), want["data_hex"].as_str().unwrap());
        }
        compared += 1;
    }
    assert!(compared >= 45, "{compared}");
}

#[test]
fn every_onboarding_case_gets_its_expected_answer() {
    let doc = onboarding_doc();
    let ctx = &doc["ctx"];
    let authority = key(&ctx["desk"]["authority"]);
    let trader = phoenix_trader_address(sha256, &authority).unwrap();
    assert_eq!(trader, key(&ctx["desk"]["phoenix_trader"]));
    let mut wrong = vec![];
    let cases = doc["cases"].as_array().unwrap();
    for case in cases {
        let which = match case["type"].as_str().unwrap() {
            "register" => Onboarding::Register,
            "referral_activate" => Onboarding::ReferralActivate,
            other => panic!("unknown type {other}"),
        };
        let got = check_onboarding(&authority, &trader, &message(case), which);
        if outcome(&got) != expected(case) {
            wrong.push(format!(
                "{}: got {got:?}, want {}",
                name(case),
                expected(case)
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert_eq!(cases.len(), 47);
    assert_eq!(
        cases.iter().filter(|c| c["expect"]["ok"] == true).count(),
        5
    );
    // The golden messages, and the type a format stands for.
    for (which, kind) in [
        (Onboarding::Register, "register"),
        (Onboarding::ReferralActivate, "referral_activate"),
    ] {
        let golden = &doc["messages"][kind];
        let bytes = base64_decode(golden["message_b64"].as_str().unwrap());
        check_onboarding(&authority, &trader, &bytes, which).unwrap();
        let format = parse_message(&bytes).unwrap().format;
        assert_eq!(Onboarding::of(format), which);
        assert_eq!(which.kind(), kind);
    }
}

#[test]
fn onboarding_messages_are_not_sol_sign_messages() {
    let sol = sol_doc();
    let ctx = &sol["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&sol), reference_of(ctx));
    for case in onboarding_doc()["cases"].as_array().unwrap() {
        let got = check_message(&policy, &desk, &message(case), &reference, None);
        assert!(got.is_err(), "{}", name(case));
    }
}

#[test]
fn the_pinned_phoenix_accounts_are_their_program_addresses() {
    let pda = |seeds: &[&[u8]]| {
        find_program_address(sha256, seeds, &PHOENIX_PROGRAM)
            .unwrap()
            .0
    };
    assert_eq!(pda(&[b"log"]), PHOENIX_LOG_AUTHORITY);
    assert_eq!(pda(&[b"global"]), PHOENIX_GLOBAL_CONFIGURATION);
    assert_eq!(
        pda(&[b"permission", &PHOENIX_RISK_AUTHORITY, &PHOENIX_ONBOARDER]),
        PHOENIX_ONBOARDING_PERMISSION
    );
    let ctx = &onboarding_doc()["ctx"];
    for (got, field) in [
        (PHOENIX_LOG_AUTHORITY, "log_authority"),
        (PHOENIX_GLOBAL_CONFIGURATION, "global_configuration"),
        (PHOENIX_RISK_AUTHORITY, "risk_authority"),
        (PHOENIX_ONBOARDING_PERMISSION, "permission_account"),
        (PHOENIX_ONBOARDER, "onboarder"),
        (PHOENIX_PROGRAM, "phoenix_program"),
        (SYSTEM_PROGRAM, "system_program"),
        (COMPUTE_BUDGET_PROGRAM, "compute_budget_program"),
    ] {
        assert_eq!(got, key(&ctx[field]), "{field}");
    }
    assert_eq!(
        PHOENIX_GLOBAL_TRADER_INDEX,
        key(&ctx["global_trader_index"][0])
    );
    assert_eq!(ctx["global_trader_index"].as_array().unwrap().len(), 1);
    assert_eq!(
        PHOENIX_ACTIVE_TRADER_BUFFER,
        key(&ctx["active_trader_buffer"][0])
    );
    assert_eq!(ctx["active_trader_buffer"].as_array().unwrap().len(), 1);
}

#[test]
fn the_program_and_mint_constants_are_their_base58_names() {
    let doc = sol_doc();
    let p = &doc["programs"];
    for (got, want) in [
        (COMPUTE_BUDGET_PROGRAM, &p["computeBudget"]),
        (PHOENIX_PROGRAM, &p["phoenix"]),
        (EMBER_PROGRAM, &p["ember"]),
        (TOKEN_PROGRAM, &p["token"]),
        (ATA_PROGRAM, &p["ata"]),
        (USDC_MINT, &doc["mints"]["usdc"]),
        (PHUSD_MINT, &doc["mints"]["phusd"]),
        (EMBER_AUTHORITY, &doc["ember_authority"]),
    ] {
        assert_eq!(got, key(want), "{want}");
    }
}

#[test]
fn the_discriminators_are_anchors() {
    for (disc, name) in [
        (PLACE_MARKET_ORDER, "place_market_order"),
        (CANCEL_ALL, "cancel_all"),
        (DEPOSIT_FUNDS, "deposit_funds"),
        (WITHDRAW_FUNDS, "withdraw_funds"),
        (REGISTER_TRADER, "register_trader"),
        (
            SET_TRADER_CAPABILITIES_DELEGATED,
            "set_trader_capabilities_delegated",
        ),
        (EMBER_DEPOSIT, "deposit"),
        (EMBER_WITHDRAW, "withdraw"),
    ] {
        assert_eq!(
            disc,
            sha256(format!("global:{name}").as_bytes())[..8],
            "{name}"
        );
    }
}

#[test]
fn the_curve_check_agrees_with_curve25519_dalek() {
    let dalek = |b: &[u8; 32]| CompressedEdwardsY(*b).decompress().is_some();
    let mut on = 0;
    let mut inputs: Vec<[u8; 32]> = (0u32..3000).map(|i| sha256(&i.to_le_bytes())).collect();
    // Edges: small y, y near and above p (2^255 − 19), every top bit, all ones.
    for small in 0u8..=40 {
        let mut b = [0u8; 32];
        b[0] = small;
        inputs.push(b);
        b[31] = 0x80;
        inputs.push(b);
    }
    for below in 0u8..=40 {
        let mut b = [0xffu8; 32];
        b[31] = 0x7f;
        b[0] = 0xff - below; // 2^255 − 1 − below: y = p + 18 − below
        inputs.push(b);
        b[31] = 0xff;
        inputs.push(b);
    }
    for input in &inputs {
        assert_eq!(is_on_curve(input), dalek(input), "{}", hex::encode(input));
        on += usize::from(is_on_curve(input));
    }
    // About half of all 32-byte strings are points.
    assert!(
        on > inputs.len() / 3 && on < inputs.len() * 2 / 3,
        "{on} of {}",
        inputs.len()
    );
}

fn base64_decode(s: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![];
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        let v = ALPHABET.iter().position(|&a| a == c).unwrap() as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
