//! The Solana policy against `vectors/solana.json` (the `sol_sign` messages, with the rescue rows
//! of C6) and `vectors/solana-onboarding.json` (the `sol_sign_register` messages), plus the
//! address derivations and the curve check against independent implementations.

use curve25519_dalek::edwards::CompressedEdwardsY;
use gimbal_core::ed25519::is_on_curve;
use gimbal_core::errors::{
    E_ASSET, E_ORACLE_STALE, E_PRICE_BAND, E_SIZE, E_SOL_ACCOUNT, E_SOL_MESSAGE, E_SOL_PROGRAM,
};
use gimbal_core::phoenix::{
    check_message, check_onboarding, check_registration, Onboarding, Rescue, CANCEL_ALL,
    DEPOSIT_FUNDS, EMBER_DEPOSIT, EMBER_WITHDRAW, MAX_COMPUTE_UNIT_LIMIT, MAX_COMPUTE_UNIT_PRICE,
    MAX_PRIORITY_FEE_LAMPORTS, PHOENIX_ACTIVE_TRADER_BUFFER, PHOENIX_GLOBAL_CONFIGURATION,
    PHOENIX_GLOBAL_TRADER_INDEX, PHOENIX_GLOBAL_VAULT, PHOENIX_LOG_AUTHORITY,
    PHOENIX_ONBOARDING_PERMISSION, PHOENIX_PERP_ASSET_MAP, PHOENIX_RISK_AUTHORITY,
    PHOENIX_WITHDRAW_QUEUE, PLACE_MARKET_ORDER, REGISTER_TRADER, SET_TRADER_CAPABILITIES_DELEGATED,
    WITHDRAW_FUNDS,
};
use gimbal_core::policy::{PhoenixMarket, Policy, UnpricedAsset};
use gimbal_core::solana::{
    find_program_address, parse_message, phoenix_spline_address, phoenix_trader_address, Format,
    Pubkey, SolDesk, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, EMBER_AUTHORITY, EMBER_PROGRAM,
    EMBER_VAULT, PHOENIX_ONBOARDER, PHOENIX_PROGRAM, PHUSD_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM,
    USDC_MINT,
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

/// The `solana.json` cases whose answer the review changed: a lone Approve would leave Ember an
/// allowance on the desk's PhUSD, so an Approve now needs an unwrap of its amount after it
/// (review item 2), and that unwrap a Revoke of the desk's PhUSD account after it (review item
/// 6), which the SDK's withdrawal and the one-transaction rescue do not carry.
const REVIEWED: [(&str, &str); 3] = [
    (
        "Token Approve of the desk PhUSD account to the Ember authority",
        E_SOL_PROGRAM,
    ),
    (
        "withdraw 10 USDC (ATA, approve, ATA, Phoenix withdraw, Ember unwrap)",
        E_SOL_PROGRAM,
    ),
    (
        "rescue in one transaction: Phoenix withdraw + Ember unwrap + ATA for the deposit owner + \
         TransferChecked of amountIn",
        E_SOL_PROGRAM,
    ),
];

/// The answer a case must get: the vector's, or the reviewed one.
fn expected(case: &Value) -> String {
    if let Some((_, code)) = REVIEWED.iter().find(|(n, _)| *n == name(case)) {
        return (*code).into();
    }
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
            sha256,
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
    assert_eq!(cases.iter().filter(|c| expected(c) == "ok").count(), 10);
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
            let got = check_message(sha256, &policy, &desk, &message(case), &reference, None);
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
        let got = check_message(
            sha256,
            &policy,
            &desk,
            &bytes,
            &|_| None,
            rescue_of(case).as_ref(),
        );
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
        check_message(sha256, &policy, &desk, &message(case), &|_| None, None)
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
    // The vector message `prefix`, with a Revoke of the desk's PhUSD account appended when
    // `revoke` (the withdrawal and the rescue spend an Approve, review item 6).
    let check = |prefix: &str, revoke: bool| {
        let case = doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| name(c).starts_with(prefix))
            .unwrap();
        let mut d = Draft::of(&message(case));
        if revoke {
            d.push_revoke(desk.phusd_ata, desk.authority);
        }
        check_message(
            sha256,
            &policy,
            &desk,
            &d.bytes(),
            &reference,
            rescue_of(case).as_ref(),
        )
        .unwrap()
    };
    for (prefix, revoke, kind, reduces_risk) in [
        ("cancel all ETH", false, "cancel_all", true),
        ("compute budget at the caps", false, "cancel_all", true),
        ("deposit 15 USDC", false, "deposit", false),
        ("withdraw 10 USDC", true, "withdraw", false),
        ("IOC sell 0.005 ETH", false, "order", false),
        ("rescue in one transaction", true, "rescue", false),
    ] {
        let c = check(prefix, revoke);
        assert_eq!((c.kind, c.reduces_risk), (kind, reduces_risk), "{prefix}");
    }
    let check = |prefix: &str| check(prefix, false);
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
    let c = check_message(sha256, &policy, &desk, &close, &reference, None).unwrap();
    assert!(c.orders[0].reduce_only && c.reduces_risk);
    for flags in [0x10, 0x20, 0x40, 0xc0, 0x01] {
        let bad = with_flags(&doc, "IOC sell 0.005 ETH", flags);
        let r = check_message(sha256, &policy, &desk, &bad, &reference, None).unwrap_err();
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
    // The golden messages, whose type is read from their instructions.
    for (which, kind) in [
        (Onboarding::Register, "register"),
        (Onboarding::ReferralActivate, "referral_activate"),
    ] {
        let golden = &doc["messages"][kind];
        let bytes = base64_decode(golden["message_b64"].as_str().unwrap());
        check_onboarding(&authority, &trader, &bytes, which).unwrap();
        assert_eq!(check_registration(&authority, &trader, &bytes), Ok(which));
        assert_eq!(which.kind(), kind);
    }
}

/// `sol_sign_register` takes no type: a registration is a legacy message and a referral
/// activation a version 0 one, so the format names the type. Every case whose format is its
/// type's gets the vector's answer. Of the four others, the two that offer one type's valid
/// message as the other pass as what they are, and the two compiled in the other type's format
/// are refused as that type (`E_SOL_PROGRAM` where the typed check says `E_SOL_MESSAGE`).
#[test]
fn sol_sign_register_takes_the_type_its_format_stands_for() {
    let doc = onboarding_doc();
    let ctx = &doc["ctx"];
    let authority = key(&ctx["desk"]["authority"]);
    let trader = phoenix_trader_address(sha256, &authority).unwrap();
    let mut wrong = vec![];
    let (mut passed_as_other, mut refused_as_other) = (0, 0);
    for case in doc["cases"].as_array().unwrap() {
        let bytes = message(case);
        let got = check_registration(&authority, &trader, &bytes);
        let format_type = match parse_message(&bytes) {
            Ok(m) => Onboarding::of(m.format).kind(),
            Err(_) => case["type"].as_str().unwrap(),
        };
        if format_type == case["type"] {
            if outcome(&got) != expected(case) {
                wrong.push(format!(
                    "{}: got {got:?}, want {}",
                    name(case),
                    expected(case)
                ));
            }
            if let Ok(which) = got {
                assert_eq!(which.kind(), format_type);
            }
        } else if name(case).contains(" offered as ") {
            assert_eq!(got.map(Onboarding::kind), Ok(format_type), "{}", name(case));
            passed_as_other += 1;
        } else {
            assert_eq!(expected(case), E_SOL_MESSAGE, "{}", name(case));
            assert_eq!(outcome(&got), E_SOL_PROGRAM, "{}", name(case));
            refused_as_other += 1;
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert_eq!((passed_as_other, refused_as_other), (2, 2));
}

#[test]
fn onboarding_messages_are_not_sol_sign_messages() {
    let sol = sol_doc();
    let ctx = &sol["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&sol), reference_of(ctx));
    for case in onboarding_doc()["cases"].as_array().unwrap() {
        let got = check_message(sha256, &policy, &desk, &message(case), &reference, None);
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
    assert_eq!(pda(&[b"vault", &PHUSD_MINT]), PHOENIX_GLOBAL_VAULT);
    let ember = |seed: &[u8]| {
        find_program_address(sha256, &[&PHOENIX_PROGRAM, seed], &EMBER_PROGRAM)
            .unwrap()
            .0
    };
    assert_eq!(ember(b"state"), EMBER_AUTHORITY);
    assert_eq!(ember(b"vault"), EMBER_VAULT);
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

/// The accounts every passing vector puts in the pinned places of a Phoenix instruction are the
/// pinned constants, and each order's and cancel's spline is the one derived from its orderbook.
#[test]
fn the_vectors_put_the_pinned_and_derived_accounts_in_their_places() {
    let doc = sol_doc();
    let mut seen = [0; 4];
    for case in doc["cases"].as_array().unwrap() {
        if case["expect"]["ok"] != true {
            continue;
        }
        let bytes = message(case);
        for ix in parse_message(&bytes).unwrap().instructions {
            let a = &ix.accounts;
            if ix.program == EMBER_PROGRAM {
                assert_eq!(
                    (a[1], a[6]),
                    (EMBER_AUTHORITY, EMBER_VAULT),
                    "{}",
                    name(case)
                );
                seen[3] += 1;
            }
            if ix.program != PHOENIX_PROGRAM {
                continue;
            }
            if ix.data.starts_with(&PLACE_MARKET_ORDER) || ix.data.starts_with(&CANCEL_ALL) {
                assert_eq!(a[5], PHOENIX_PERP_ASSET_MAP, "{}", name(case));
                assert_eq!(a[9], spline(&a[8]), "{}", name(case));
                seen[0] += 1;
            } else if ix.data.starts_with(&WITHDRAW_FUNDS) {
                assert_eq!(a[5], PHOENIX_PERP_ASSET_MAP, "{}", name(case));
                assert_eq!(a[11], PHOENIX_WITHDRAW_QUEUE, "{}", name(case));
                assert_eq!(a[6], PHOENIX_GLOBAL_VAULT, "{}", name(case));
                seen[1] += 1;
            } else if ix.data.starts_with(&DEPOSIT_FUNDS) {
                assert_eq!(a[6], PHOENIX_GLOBAL_VAULT, "{}", name(case));
                seen[2] += 1;
            }
        }
    }
    assert_eq!(seen, [8, 2, 1, 3]);
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

// --- review cases (vectors/solana-review.json) ---

/// A legacy message taken apart for editing: the header, the keys, the blockhash and each
/// instruction as its program index, account indexes and data.
#[derive(Clone)]
struct Draft {
    header: [u8; 3],
    keys: Vec<Pubkey>,
    blockhash: Pubkey,
    ixs: Vec<(u8, Vec<u8>, Vec<u8>)>,
}

fn compact_u16(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let low = u8::try_from(n & 0x7f).unwrap();
        n >>= 7;
        if n == 0 {
            out.push(low);
            return;
        }
        out.push(low | 0x80);
    }
}

impl Draft {
    fn of(bytes: &[u8]) -> Draft {
        let m = parse_message(bytes).unwrap();
        assert_eq!(m.format, Format::Legacy);
        Draft {
            header: [
                m.num_required_signatures,
                m.num_readonly_signed,
                m.num_readonly_unsigned,
            ],
            keys: m.keys.clone(),
            blockhash: m.recent_blockhash,
            ixs: m
                .instructions
                .iter()
                .map(|ix| {
                    (
                        ix.program_index,
                        ix.account_indexes.clone(),
                        ix.data.to_vec(),
                    )
                })
                .collect(),
        }
    }

    fn bytes(&self) -> Vec<u8> {
        let mut out = self.header.to_vec();
        compact_u16(&mut out, self.keys.len());
        for k in &self.keys {
            out.extend_from_slice(k);
        }
        out.extend_from_slice(&self.blockhash);
        compact_u16(&mut out, self.ixs.len());
        for (program, accounts, data) in &self.ixs {
            out.push(*program);
            compact_u16(&mut out, accounts.len());
            out.extend_from_slice(accounts);
            compact_u16(&mut out, data.len());
            out.extend_from_slice(data);
        }
        out
    }

    /// The index of `key`, added as the last read-only account if the message lacks it.
    fn index(&mut self, key: Pubkey) -> u8 {
        let i = self.keys.iter().position(|k| *k == key).unwrap_or_else(|| {
            self.keys.push(key);
            self.header[2] += 1;
            self.keys.len() - 1
        });
        u8::try_from(i).unwrap()
    }

    /// The one instruction of `program` whose data starts with `prefix`.
    fn find(&self, program: Pubkey, prefix: &[u8]) -> usize {
        let found: Vec<usize> = (0..self.ixs.len())
            .filter(|&i| {
                let (p, _, data) = &self.ixs[i];
                self.keys[usize::from(*p)] == program && data.starts_with(prefix)
            })
            .collect();
        assert_eq!(found.len(), 1, "{prefix:02x?}");
        found[0]
    }

    fn account(&self, ix: usize, i: usize) -> Pubkey {
        self.keys[usize::from(self.ixs[ix].1[i])]
    }

    fn set_account(&mut self, ix: usize, i: usize, key: Pubkey) -> &mut Self {
        let k = self.index(key);
        self.ixs[ix].1[i] = k;
        self
    }

    fn push_account(&mut self, ix: usize, key: Pubkey) -> &mut Self {
        let k = self.index(key);
        self.ixs[ix].1.push(k);
        self
    }

    fn remove_account(&mut self, ix: usize, i: usize) -> &mut Self {
        self.ixs[ix].1.remove(i);
        self
    }

    fn swap_accounts(&mut self, ix: usize, i: usize, j: usize) -> &mut Self {
        self.ixs[ix].1.swap(i, j);
        self
    }

    /// Appends a token `Revoke` of `source` by `owner`.
    fn push_revoke(&mut self, source: Pubkey, owner: Pubkey) -> &mut Self {
        let source = self.writable(source);
        let owner = self.index(owner);
        let program = self.index(TOKEN_PROGRAM);
        self.ixs.push((program, vec![source, owner], vec![5]));
        self
    }

    /// The index of `key`, added as the last writable non-signer account if the message lacks
    /// it (every index after it moves up one).
    fn writable(&mut self, key: Pubkey) -> u8 {
        if let Some(i) = self.keys.iter().position(|k| *k == key) {
            return u8::try_from(i).unwrap();
        }
        let at = self.keys.len() - usize::from(self.header[2]);
        self.keys.insert(at, key);
        let at = u8::try_from(at).unwrap();
        for (program, accounts, _) in &mut self.ixs {
            for i in std::iter::once(program).chain(accounts.iter_mut()) {
                if *i >= at {
                    *i += 1;
                }
            }
        }
        at
    }
}

#[test]
fn a_draft_writes_back_the_message_it_read() {
    for case in sol_doc()["cases"].as_array().unwrap() {
        let bytes = message(case);
        if parse_message(&bytes).is_ok_and(|m| m.format == Format::Legacy) {
            assert_eq!(Draft::of(&bytes).bytes(), bytes, "{}", name(case));
        }
    }
}

/// The review cases, built from the messages of `solana.json`.
struct Review<'d> {
    doc: &'d Value,
    cases: Vec<Value>,
}

impl<'d> Review<'d> {
    fn base(&self, prefix: &str) -> &'d Value {
        self.doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| name(c).starts_with(prefix))
            .unwrap_or_else(|| panic!("no case {prefix:?}"))
    }

    fn draft(&self, base: &str) -> Draft {
        Draft::of(&message(self.base(base)))
    }

    /// The draft of case `base` and the index of its one instruction of `program` whose data
    /// starts with `prefix`.
    fn at(&self, base: &str, program: Pubkey, prefix: &[u8]) -> (Draft, usize) {
        let d = self.draft(base);
        let i = d.find(program, prefix);
        (d, i)
    }

    /// Adds `draft`, an edit of case `base` for review item `item`, which must get `answer`: a
    /// refusal code, or `<kind> reduces_risk` / `<kind> running` for a message that passes.
    fn add(&mut self, item: u32, case_name: &str, base: &str, draft: &Draft, answer: &str) {
        let expect = match answer.split_once(' ') {
            Some((kind, gate)) => serde_json::json!({
                "ok": true,
                "kind": kind,
                "reduces_risk": gate == "reduces_risk",
            }),
            None => serde_json::json!({ "ok": false, "code": answer }),
        };
        assert!(
            self.cases.iter().all(|c| c["name"] != case_name),
            "{case_name} twice"
        );
        self.cases.push(serde_json::json!({
            "name": case_name,
            "review_item": item,
            "base": name(self.base(base)),
            "method": "sol_sign",
            "message_hex": hex::encode(draft.bytes()),
            "expect": expect,
        }));
    }
}

/// A named edit of an instruction (the draft, the instruction's index, the keys
/// [`layout_cases`] hands it) and the code its message must get.
type Edit = (
    &'static str,
    fn(&mut Draft, usize, &[Pubkey; 5]),
    &'static str,
);

fn spline(orderbook: &Pubkey) -> Pubkey {
    phoenix_spline_address(sha256, orderbook).unwrap()
}

/// Review item 1: every Phoenix instruction has its exact account list, with Phoenix's own
/// accounts in their places and, for an order or a cancel, the spline derived from its
/// orderbook.
fn layout_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let book = |symbol: &str| key(&doc["markets"][symbol]["orderbook"]);
    let (eth, sol) = (book("ETH"), book("SOL"));
    let stranger = key(&doc["keys"]["strangerSol"]["public_key_b58"]);
    let unlisted = {
        let (d, i) = r.at(
            "attack: order on an unknown market",
            PHOENIX_PROGRAM,
            &PLACE_MARKET_ORDER,
        );
        d.account(i, 8)
    };
    let desk = vector_desk(doc);

    let buy = "IOC buy 0.005 ETH, limit 2474.5";
    let order = |r: &Review<'_>| r.at(buy, PHOENIX_PROGRAM, &PLACE_MARKET_ORDER);
    let (mut d, i) = order(r);
    d.set_account(i, 8, unlisted)
        .set_account(i, 9, spline(&unlisted))
        .push_account(i, eth)
        .push_account(i, spline(&eth));
    r.add(
        1,
        "review 1: IOC buy on an unlisted orderbook and its spline, the ETH orderbook appended \
         (12 accounts)",
        buy,
        &d,
        E_SOL_ACCOUNT,
    );
    let edits: [Edit; 8] = [
        (
            "IOC buy with a trailing account (11)",
            |d, i, k| {
                d.push_account(i, k[0]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy without its spline (9 accounts)",
            |d, i, _| {
                d.remove_account(i, 9);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy without the perp asset map (9 accounts)",
            |d, i, _| {
                d.remove_account(i, 5);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy on the ETH orderbook with the SOL spline",
            |d, i, k| {
                d.set_account(i, 9, spline(&k[1]));
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy on an unlisted orderbook with its own spline",
            |d, i, k| {
                d.set_account(i, 8, k[2]).set_account(i, 9, spline(&k[2]));
            },
            E_ASSET,
        ),
        (
            "IOC buy with the trader index and the trader buffer swapped",
            |d, i, _| {
                d.swap_accounts(i, 6, 7);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy with another perp asset map",
            |d, i, k| {
                d.set_account(i, 5, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "IOC buy naming another authority at accounts[3]",
            |d, i, k| {
                d.set_account(i, 3, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
    ];
    let k = [desk.usdc_ata, sol, unlisted, stranger, eth];
    for (what, edit, code) in edits {
        let (mut d, i) = order(r);
        edit(&mut d, i, &k);
        r.add(1, &format!("review 1: {what}"), buy, &d, code);
    }
    let sol_buy = "IOC buy 0.1 SOL, limit 104.84";
    let (mut d, i) = r.at(sol_buy, PHOENIX_PROGRAM, &PLACE_MARKET_ORDER);
    d.set_account(i, 8, eth);
    r.add(
        1,
        "review 1: IOC buy sized for SOL on the ETH orderbook with the SOL spline",
        sol_buy,
        &d,
        E_SOL_ACCOUNT,
    );

    let cancel = "cancel all ETH";
    let edits: [Edit; 5] = [
        (
            "cancel_all with a trailing account (11)",
            |d, i, k| {
                d.push_account(i, k[0]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "cancel_all without its spline (9 accounts)",
            |d, i, _| {
                d.remove_account(i, 9);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "cancel_all on the ETH orderbook with the SOL spline",
            |d, i, k| {
                d.set_account(i, 9, spline(&k[1]));
            },
            E_SOL_ACCOUNT,
        ),
        (
            "cancel_all on an unlisted orderbook with its own spline",
            |d, i, k| {
                d.set_account(i, 8, k[2]).set_account(i, 9, spline(&k[2]));
            },
            E_ASSET,
        ),
        (
            "cancel_all with a trailing data byte",
            |d, i, _| d.ixs[i].2.push(0),
            E_SOL_PROGRAM,
        ),
    ];
    for (what, edit, code) in edits {
        let (mut d, i) = r.at(cancel, PHOENIX_PROGRAM, &CANCEL_ALL);
        edit(&mut d, i, &k);
        r.add(1, &format!("review 1: {what}"), cancel, &d, code);
    }

    let deposit = "deposit 15 USDC";
    let edits: [Edit; 3] = [
        (
            "deposit_funds with a trailing account (11)",
            |d, i, k| {
                d.push_account(i, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "deposit_funds without the trader buffer (9 accounts)",
            |d, i, _| {
                d.remove_account(i, 9);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "deposit_funds with the PhUSD account and the trader swapped",
            |d, i, _| {
                d.swap_accounts(i, 4, 5);
            },
            E_SOL_ACCOUNT,
        ),
    ];
    for (what, edit, code) in edits {
        let (mut d, i) = r.at(deposit, PHOENIX_PROGRAM, &DEPOSIT_FUNDS);
        edit(&mut d, i, &k);
        r.add(1, &format!("review 1: {what}"), deposit, &d, code);
    }

    let withdraw = "withdraw 10 USDC";
    let edits: [Edit; 3] = [
        (
            "withdraw_funds with a trailing account (13)",
            |d, i, k| {
                d.push_account(i, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "withdraw_funds without the withdraw queue (11 accounts)",
            |d, i, _| {
                d.remove_account(i, 11);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "withdraw_funds with another withdraw queue",
            |d, i, k| {
                d.set_account(i, 11, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
    ];
    for (what, edit, code) in edits {
        let (mut d, i) = r.at(withdraw, PHOENIX_PROGRAM, &WITHDRAW_FUNDS);
        edit(&mut d, i, &k);
        r.add(1, &format!("review 1: {what}"), withdraw, &d, code);
    }
}

/// Review item 2: an Approve is of the desk's PhUSD account to the Ember authority, for exactly
/// the amount of an Ember unwrap after it; a Revoke of a desk token account passes alone. Each
/// edit is of the withdrawal with the Revoke item 6 asks for appended, so it is the one thing
/// wrong with its message.
fn approval_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let desk = vector_desk(doc);
    let stranger = key(&doc["keys"]["strangerSol"]["public_key_b58"]);
    let withdraw = "withdraw 10 USDC";
    let approve_at = |r: &Review<'_>| {
        let (mut d, i) = r.at(withdraw, TOKEN_PROGRAM, &[4]);
        d.push_revoke(desk.phusd_ata, desk.authority);
        (d, i)
    };
    let set_amount = |d: &mut Draft, i: usize, amount: u64| {
        d.ixs[i].2[1..9].copy_from_slice(&amount.to_le_bytes());
    };
    for (what, amount) in [
        ("1 above", 10_000_001),
        ("1 below", 9_999_999),
        ("of u64::MAX before", u64::MAX),
    ] {
        let (mut d, i) = approve_at(r);
        set_amount(&mut d, i, amount);
        let case_name = format!("review 2: Approve {what} the unwrap");
        r.add(2, &case_name, withdraw, &d, E_SOL_PROGRAM);
    }
    let (mut d, _) = approve_at(r);
    let unwrap = d.find(EMBER_PROGRAM, &EMBER_WITHDRAW);
    d.ixs.remove(unwrap);
    r.add(
        2,
        "review 2: Approve with no unwrap after it",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let (mut d, i) = approve_at(r);
    let approve = d.ixs.remove(i);
    d.ixs.push(approve);
    r.add(
        2,
        "review 2: Approve after the unwrap",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let (mut d, i) = approve_at(r);
    let approve = d.ixs[i].clone();
    d.ixs.insert(i, approve);
    r.add(
        2,
        "review 2: two Approves before the unwrap",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let (mut d, _) = approve_at(r);
    let unwrap = d.find(EMBER_PROGRAM, &EMBER_WITHDRAW);
    d.ixs[unwrap].2.truncate(8);
    d.ixs[unwrap].2.push(0);
    r.add(
        2,
        "review 2: Approve before an unwrap of the whole balance (no amount)",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let (mut d, i) = approve_at(r);
    d.set_account(i, 0, desk.usdc_ata);
    r.add(
        2,
        "review 2: Approve of the desk USDC account to the Ember authority",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );
    let (mut d, i) = approve_at(r);
    d.set_account(i, 2, stranger);
    r.add(
        2,
        "review 2: Approve with another owner",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );
    let (mut d, i) = approve_at(r);
    d.push_account(i, stranger);
    r.add(
        2,
        "review 2: Approve with a trailing account (4)",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );

    let lone = "Token Approve of the desk PhUSD account to the Ember authority";
    let (mut d, i) = r.at(lone, TOKEN_PROGRAM, &[4]);
    set_amount(&mut d, i, u64::MAX);
    r.add(
        2,
        "review 2: lone Approve of u64::MAX",
        lone,
        &d,
        E_SOL_PROGRAM,
    );
    // The lone Approve turned into a Revoke of its source; `source` takes the PhUSD account's key
    // slot, which is writable.
    let revoke = |r: &Review<'_>, source: Pubkey| {
        let (mut d, i) = r.at(lone, TOKEN_PROGRAM, &[4]);
        let slot = d.ixs[i].1[0];
        d.ixs[i].1 = vec![slot, d.index(desk.authority)];
        d.ixs[i].2 = vec![5];
        d.keys[usize::from(slot)] = source;
        (d, i)
    };
    // The base carries a priority fee, so a paused desk no longer signs these (review item 5).
    let (d, _) = revoke(r, desk.phusd_ata);
    r.add(
        2,
        "review 2: lone Revoke of the desk PhUSD account",
        lone,
        &d,
        "transaction running",
    );
    let (d, _) = revoke(r, desk.usdc_ata);
    r.add(
        2,
        "review 2: lone Revoke of the desk USDC account",
        lone,
        &d,
        "transaction running",
    );
    let (d, _) = revoke(r, stranger);
    r.add(
        2,
        "review 2: Revoke of an account the desk does not own",
        lone,
        &d,
        E_SOL_ACCOUNT,
    );
    let (mut d, i) = revoke(r, desk.phusd_ata);
    d.ixs[i].2.push(0);
    r.add(
        2,
        "review 2: Revoke with a trailing data byte",
        lone,
        &d,
        E_SOL_PROGRAM,
    );
}

/// Review item 3: a priority fee only with a unit limit, something to do besides the compute
/// budget, and what a paused desk may sign.
fn budget_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let desk = vector_desk(doc);
    let stranger = key(&doc["keys"]["strangerSol"]["public_key_b58"]);
    let cancel = "cancel all ETH";
    // The vectors' budget: [limit 400000, price 100000, …].
    let (limit, price) = (0, 1);
    let mut d = r.draft(cancel);
    d.ixs[price].2[1..9].copy_from_slice(&MAX_COMPUTE_UNIT_PRICE.to_le_bytes());
    d.ixs = vec![d.ixs[price].clone()];
    r.add(
        3,
        "review 3: only SetComputeUnitPrice 1000000",
        cancel,
        &d,
        E_SOL_PROGRAM,
    );
    let mut d = r.draft(cancel);
    d.ixs.remove(limit);
    r.add(
        3,
        "review 3: a cancel_all with a priority fee and no unit limit",
        cancel,
        &d,
        E_SOL_PROGRAM,
    );
    let mut d = r.draft(cancel);
    d.ixs.swap(limit, price);
    r.add(
        3,
        "review 3: a cancel_all with the unit limit after the price",
        cancel,
        &d,
        "cancel_all reduces_risk",
    );
    let mut d = r.draft(cancel);
    d.ixs.remove(price);
    r.add(
        3,
        "review 3: a cancel_all with a unit limit and no price",
        cancel,
        &d,
        "cancel_all reduces_risk",
    );
    let mut d = r.draft(cancel);
    let again = d.ixs[limit].clone();
    d.ixs.insert(limit, again);
    r.add(
        3,
        "review 3: a cancel_all with two unit limits",
        cancel,
        &d,
        E_SOL_PROGRAM,
    );
    let caps = "compute budget at the caps";
    let mut d = r.draft(caps);
    d.ixs.truncate(2);
    r.add(
        3,
        "review 3: only the compute budget, at its caps",
        caps,
        &d,
        E_SOL_MESSAGE,
    );
    let mut d = r.draft(cancel);
    d.ixs.truncate(1);
    r.add(3, "review 3: only a unit limit", cancel, &d, E_SOL_MESSAGE);
    let mut d = r.draft(cancel);
    d.ixs.clear();
    r.add(
        3,
        "review 3: no instruction at all",
        cancel,
        &d,
        E_SOL_MESSAGE,
    );

    // The pause gate.
    let sell = "IOC sell 0.005 ETH, limit 2425.5";
    let reduce_only = |r: &Review<'_>| {
        let (mut d, i) = r.at(sell, PHOENIX_PROGRAM, &PLACE_MARKET_ORDER);
        let flags = d.ixs[i].2.len() - 2;
        d.ixs[i].2[flags] = 0x80;
        (d, i)
    };
    let (d, _) = reduce_only(r);
    r.add(
        3,
        "review 3: a reduce-only IOC sell",
        sell,
        &d,
        "order reduces_risk",
    );
    let (mut d, i) = reduce_only(r);
    let mut cancel_ix = d.ixs[i].clone();
    cancel_ix.2 = CANCEL_ALL.to_vec();
    d.ixs.push(cancel_ix);
    r.add(
        3,
        "review 3: a reduce-only IOC sell, then cancel_all",
        sell,
        &d,
        "order reduces_risk",
    );
    let (mut d, i) = r.at(sell, PHOENIX_PROGRAM, &PLACE_MARKET_ORDER);
    let mut cancel_ix = d.ixs[i].clone();
    cancel_ix.2 = CANCEL_ALL.to_vec();
    d.ixs.insert(i, cancel_ix);
    r.add(
        3,
        "review 3: cancel_all, then an IOC sell that is not reduce-only",
        sell,
        &d,
        "order running",
    );
    // The lone Approve turned into a transfer from an account the desk may move (a stranger's,
    // with the desk as its delegate) into the desk's PhUSD account.
    let lone = "Token Approve of the desk PhUSD account to the Ember authority";
    let transfer = |r: &Review<'_>, data: Vec<u8>| {
        let (mut d, i) = r.at(lone, TOKEN_PROGRAM, &[4]);
        let source = d.writable(stranger);
        let into = d.ixs[i].1[0];
        let owner = d.index(desk.authority);
        d.ixs[i].1 = if data[0] == 12 {
            vec![source, d.index(PHUSD_MINT), into, owner]
        } else {
            vec![source, into, owner]
        };
        d.ixs[i].2 = data;
        d
    };
    // The base carries a priority fee, so a paused desk no longer signs these (review item 5).
    let amount = 1_000_000u64.to_le_bytes();
    let d = transfer(r, [&[3][..], &amount].concat());
    r.add(
        3,
        "review 3: a Transfer into the desk PhUSD account",
        lone,
        &d,
        "transaction running",
    );
    let d = transfer(r, [&[12][..], &amount, &[6]].concat());
    r.add(
        3,
        "review 3: a TransferChecked into the desk PhUSD account",
        lone,
        &d,
        "transaction running",
    );
    let deposit = "deposit 15 USDC";
    let mut d = r.draft(deposit);
    d.ixs.truncate(3);
    r.add(
        3,
        "review 3: the desk PhUSD account created, nothing else",
        deposit,
        &d,
        "transaction running",
    );
    let mut d = r.draft(deposit);
    let wrap = d.find(EMBER_PROGRAM, &EMBER_DEPOSIT);
    d.ixs = vec![d.ixs[0].clone(), d.ixs[1].clone(), d.ixs[wrap].clone()];
    r.add(
        3,
        "review 3: an Ember wrap alone",
        deposit,
        &d,
        "transaction running",
    );
    let withdraw = "withdraw 10 USDC";
    let (mut d, i) = r.at(withdraw, PHOENIX_PROGRAM, &WITHDRAW_FUNDS);
    d.ixs.remove(i);
    d.push_revoke(desk.phusd_ata, desk.authority);
    r.add(
        3,
        "review 3: an Approve and its unwrap without the Phoenix withdrawal",
        withdraw,
        &d,
        "transaction running",
    );
}

/// Review item 5: a paused desk pays a priority fee only for a message that cancels or reduces a
/// position, and a token transfer moves something into another account.
fn fee_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let desk = vector_desk(doc);
    let stranger = key(&doc["keys"]["strangerSol"]["public_key_b58"]);
    let lone = "Token Approve of the desk PhUSD account to the Ember authority";
    // The vectors' budget: [limit 400000, price 100000, …].
    let (limit, price) = (0, 1);
    let set_price = |d: &mut Draft, value: u64| {
        d.ixs[price].2[1..9].copy_from_slice(&value.to_le_bytes());
    };
    // The lone Approve turned into a Revoke of the desk's PhUSD account.
    let revoke = |r: &Review<'_>| {
        let (mut d, i) = r.at(lone, TOKEN_PROGRAM, &[4]);
        d.ixs[i].1 = vec![d.ixs[i].1[0], d.index(desk.authority)];
        d.ixs[i].2 = vec![5];
        d
    };
    let mut d = revoke(r);
    d.ixs.remove(price);
    r.add(
        5,
        "review 5: lone Revoke of the desk PhUSD account without a priority fee",
        lone,
        &d,
        "transaction reduces_risk",
    );
    let mut d = revoke(r);
    set_price(&mut d, 0);
    r.add(
        5,
        "review 5: lone Revoke of the desk PhUSD account at a unit price of 0",
        lone,
        &d,
        "transaction reduces_risk",
    );
    let mut d = revoke(r);
    d.ixs[limit].2[1..5].copy_from_slice(&MAX_COMPUTE_UNIT_LIMIT.to_le_bytes());
    set_price(&mut d, MAX_COMPUTE_UNIT_PRICE);
    r.add(
        5,
        "review 5: lone Revoke of the desk PhUSD account at the budget caps",
        lone,
        &d,
        "transaction running",
    );
    // The lone Approve turned into a transfer from `source` into the desk's PhUSD account, as in
    // review item 3.
    let transfer = |r: &Review<'_>, source: Pubkey, data: Vec<u8>| {
        let (mut d, i) = r.at(lone, TOKEN_PROGRAM, &[4]);
        let source = d.writable(source);
        let into = d.ixs[i].1[0];
        let owner = d.index(desk.authority);
        d.ixs[i].1 = if data[0] == 12 {
            vec![source, d.index(PHUSD_MINT), into, owner]
        } else {
            vec![source, into, owner]
        };
        d.ixs[i].2 = data;
        d
    };
    for (op, what) in [(3u8, "Transfer"), (12, "TransferChecked")] {
        let data = |amount: u64| {
            let mut data = vec![op];
            data.extend_from_slice(&amount.to_le_bytes());
            if op == 12 {
                data.push(6);
            }
            data
        };
        let mut d = transfer(r, stranger, data(1_000_000));
        d.ixs.remove(price);
        r.add(
            5,
            &format!("review 5: a {what} into the desk PhUSD account without a priority fee"),
            lone,
            &d,
            "transaction reduces_risk",
        );
        let mut d = transfer(r, stranger, data(0));
        d.ixs.remove(price);
        r.add(
            5,
            &format!("review 5: a {what} of 0 into the desk PhUSD account"),
            lone,
            &d,
            E_SOL_PROGRAM,
        );
        let mut d = transfer(r, desk.phusd_ata, data(1_000_000));
        d.ixs.remove(price);
        r.add(
            5,
            &format!("review 5: a {what} from the desk PhUSD account into itself"),
            lone,
            &d,
            E_SOL_ACCOUNT,
        );
    }
}

/// Review item 6: an Ember unwrap that spends an Approve is followed by a Revoke of the desk's
/// PhUSD account in the same message, so no allowance outlives it, whatever the amounts.
fn revoke_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let desk = vector_desk(doc);
    let withdraw = "withdraw 10 USDC";
    let mut d = r.draft(withdraw);
    d.push_revoke(desk.phusd_ata, desk.authority);
    r.add(
        6,
        "review 6: withdraw 10 USDC with a Revoke of the desk PhUSD account after the unwrap",
        withdraw,
        &d,
        "withdraw running",
    );
    let max = |r: &Review<'_>| {
        let (mut d, approve) = r.at(withdraw, TOKEN_PROGRAM, &[4]);
        let unwrap = d.find(EMBER_PROGRAM, &EMBER_WITHDRAW);
        d.ixs[approve].2[1..9].copy_from_slice(&u64::MAX.to_le_bytes());
        d.ixs[unwrap].2[9..17].copy_from_slice(&u64::MAX.to_le_bytes());
        d
    };
    r.add(
        6,
        "review 6: Approve and unwrap of u64::MAX with no Revoke",
        withdraw,
        &max(r),
        E_SOL_PROGRAM,
    );
    let mut d = max(r);
    d.push_revoke(desk.phusd_ata, desk.authority);
    r.add(
        6,
        "review 6: Approve and unwrap of u64::MAX, then a Revoke",
        withdraw,
        &d,
        "withdraw running",
    );
    let mut d = r.draft(withdraw);
    d.push_revoke(desk.usdc_ata, desk.authority);
    r.add(
        6,
        "review 6: withdraw 10 USDC with a Revoke of the desk USDC account instead",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let mut d = r.draft(withdraw);
    let unwrap = d.find(EMBER_PROGRAM, &EMBER_WITHDRAW);
    d.push_revoke(desk.phusd_ata, desk.authority);
    let revoke_ix = d.ixs.pop().unwrap();
    d.ixs.insert(unwrap, revoke_ix);
    r.add(
        6,
        "review 6: withdraw 10 USDC with the Revoke before the unwrap",
        withdraw,
        &d,
        E_SOL_PROGRAM,
    );
    let (mut d, approve) = r.at(withdraw, TOKEN_PROGRAM, &[4]);
    d.ixs.remove(approve);
    r.add(
        6,
        "review 6: an unwrap with no Approve needs no Revoke",
        withdraw,
        &d,
        "withdraw running",
    );
}

/// With the limit the price now needs, the priority fee is at most 0.0006 SOL; without one, the
/// 1,400,000 units a message may burn at the top price would pay 0.0014 SOL.
#[test]
fn the_priority_fee_is_capped_by_the_limit_and_the_price_together() {
    assert_eq!(
        MAX_PRIORITY_FEE_LAMPORTS,
        u64::from(MAX_COMPUTE_UNIT_LIMIT) * MAX_COMPUTE_UNIT_PRICE / 1_000_000
    );
    assert_eq!(MAX_PRIORITY_FEE_LAMPORTS, 600_000);
    assert_eq!(1_400_000 * MAX_COMPUTE_UNIT_PRICE / 1_000_000, 1_400_000);
}

/// Review item 4: Phoenix's vault in a deposit and a withdrawal, and every account of an Ember
/// wrap and unwrap, Ember's state and vault among them, in their places.
fn vault_cases(r: &mut Review<'_>) {
    let doc = r.doc;
    let stranger = key(&doc["keys"]["strangerSol"]["public_key_b58"]);
    let usdc_vault = find_program_address(sha256, &[b"vault", &USDC_MINT], &PHOENIX_PROGRAM)
        .unwrap()
        .0;
    let (deposit, withdraw) = ("deposit 15 USDC", "withdraw 10 USDC");
    let (mut d, i) = r.at(deposit, PHOENIX_PROGRAM, &DEPOSIT_FUNDS);
    d.set_account(i, 6, usdc_vault);
    r.add(
        4,
        "review 4: deposit_funds into the USDC vault",
        deposit,
        &d,
        E_SOL_ACCOUNT,
    );
    let (mut d, i) = r.at(withdraw, PHOENIX_PROGRAM, &WITHDRAW_FUNDS);
    d.set_account(i, 6, stranger);
    r.add(
        4,
        "review 4: withdraw_funds from another vault",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );
    let edits: [Edit; 7] = [
        (
            "Ember wrap with another state",
            |d, i, k| {
                d.set_account(i, 1, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap into another vault",
            |d, i, k| {
                d.set_account(i, 6, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap with the mints swapped",
            |d, i, _| {
                d.swap_accounts(i, 2, 3);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap with another token program",
            |d, i, k| {
                d.set_account(i, 7, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap with a trailing account (9)",
            |d, i, k| {
                d.push_account(i, k[3]);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap without the token program (7 accounts)",
            |d, i, _| {
                d.remove_account(i, 7);
            },
            E_SOL_ACCOUNT,
        ),
        (
            "Ember wrap with a trailing data byte",
            |d, i, _| d.ixs[i].2.push(0),
            E_SOL_PROGRAM,
        ),
    ];
    let k = [stranger; 5];
    for (what, edit, code) in edits {
        let (mut d, i) = r.at(deposit, EMBER_PROGRAM, &EMBER_DEPOSIT);
        edit(&mut d, i, &k);
        r.add(4, &format!("review 4: {what}"), deposit, &d, code);
    }
    let (mut d, i) = r.at(withdraw, EMBER_PROGRAM, &EMBER_WITHDRAW);
    d.set_account(i, 6, stranger);
    r.add(
        4,
        "review 4: Ember unwrap from another vault",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );
    let (mut d, i) = r.at(withdraw, EMBER_PROGRAM, &EMBER_WITHDRAW);
    d.set_account(i, 1, stranger);
    r.add(
        4,
        "review 4: Ember unwrap with another state",
        withdraw,
        &d,
        E_SOL_ACCOUNT,
    );
}

fn review_doc() -> Value {
    let doc = sol_doc();
    let mut r = Review {
        doc: &doc,
        cases: vec![],
    };
    layout_cases(&mut r);
    approval_cases(&mut r);
    budget_cases(&mut r);
    vault_cases(&mut r);
    fee_cases(&mut r);
    revoke_cases(&mut r);
    serde_json::json!({
        "file": "solana-review.json",
        "note": "Review cases for the sol_sign policy. Each edits one message of solana.json, \
                 named in base; the desk, markets and sol_sign context are solana.json's. Built \
                 by core/tests/solana_vectors.rs (GIMBAL_BLESS=1 cargo test rewrites this file).",
        "cases": r.cases,
    })
}

/// `vectors/solana-review.json` is what [`review_doc`] builds; `GIMBAL_BLESS=1` rewrites it.
#[test]
fn the_review_vectors_are_the_edits_this_file_makes() {
    let want = review_doc();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/solana-review.json"
    );
    if std::env::var_os("GIMBAL_BLESS").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&want).unwrap() + "\n").unwrap();
    }
    let got: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(
        got == want,
        "solana-review.json is stale: GIMBAL_BLESS=1 cargo test rewrites it"
    );
}

#[test]
fn every_review_case_gets_its_expected_answer() {
    let doc = sol_doc();
    let ctx = &doc["ctx"]["sol_sign"];
    let (policy, desk, reference) = (vector_policy(ctx), vector_desk(&doc), reference_of(ctx));
    let review: Value = serde_json::from_str(include_str!("vectors/solana-review.json")).unwrap();
    let mut wrong = vec![];
    for case in review["cases"].as_array().unwrap() {
        let got = check_message(sha256, &policy, &desk, &message(case), &reference, None);
        let e = &case["expect"];
        let fine = match &got {
            Ok(c) => e["ok"] == true && e["kind"] == c.kind && e["reduces_risk"] == c.reduces_risk,
            Err(r) => e["code"] == r.code,
        };
        if !fine {
            wrong.push(format!("{}: got {got:?}, want {e}", name(case)));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
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
