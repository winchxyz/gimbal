//! `vectors/oneclick.json` (dry quotes, 2026-10-27) and `vectors/oneclick-live.json` (live quotes
//! with deposit addresses, 2026-10-31) against [`verify_quote`]: every recorded quote's signature,
//! every tampered copy, and every field case with its context, ending as the file says.

use ed25519_dalek::{Signature, VerifyingKey};
use gimbal_core::errors::{E_QUOTE_FIELDS, E_QUOTE_SIGNATURE, E_RESCUE_CAP};
use gimbal_core::oneclick::{
    check_cost, check_quote_age, check_signature, decimals, parse_time_ms, verify_quote, Context,
    DeskAddresses, Method, ARB_USDC, HL_USDC, NEAR_USDC, ONECLICK_PUBLIC_KEY_B58, QUOTE_MAX_AGE_MS,
    QUOTE_MAX_AHEAD_MS, SOL_USDC,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const DRY: &str = include_str!("vectors/oneclick.json");
const LIVE: &str = include_str!("vectors/oneclick-live.json");

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn ed25519_verify(signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
    VerifyingKey::from_bytes(public_key)
        .and_then(|k| k.verify_strict(message, &Signature::from_bytes(signature)))
        .is_ok()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn files() -> [(&'static str, Value); 2] {
    [
        ("oneclick.json", serde_json::from_str(DRY).unwrap()),
        ("oneclick-live.json", serde_json::from_str(LIVE).unwrap()),
    ]
}

fn quote<'a>(doc: &'a Value, name: &str) -> &'a Value {
    doc["quotes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["name"] == name)
        .unwrap_or_else(|| panic!("no quote {name}"))
}

/// The context of a field case.
fn context(ctx: &Value) -> Context<'_> {
    let desk = &ctx["desk"];
    Context {
        desk: DeskAddresses {
            desk_id: s(&desk["desk_id"]),
            evm: s(&desk["evm"]),
            sol: s(&desk["sol"]),
            orderly_receiver: desk["orderly_receiver"].as_str(),
        },
        contract: s(&ctx["contract"]),
        now_ms: ctx["now_ms"].as_u64().unwrap(),
        remaining_cap_e8: u128::from(ctx["remaining_cap_usd"].as_u64().unwrap()) * 100_000_000,
        dry_ok: ctx["dry_ok"].as_bool().unwrap(),
    }
}

#[test]
fn the_files_agree_with_the_module() {
    for (file, doc) in files() {
        assert_eq!(
            s(&doc["public_key"]),
            format!("ed25519:{ONECLICK_PUBLIC_KEY_B58}"),
            "{file}"
        );
        let a = &doc["assets"];
        assert_eq!(s(&a["solUsdc"]), SOL_USDC);
        assert_eq!(s(&a["hlUsdc"]), HL_USDC);
        assert_eq!(s(&a["arbUsdc"]), ARB_USDC);
        assert_eq!(s(&a["nearUsdc"]), NEAR_USDC);
        for (asset, d) in doc["decimals"].as_object().unwrap() {
            assert_eq!(decimals(asset), Some(d.as_u64().unwrap() as u32), "{asset}");
        }
    }
}

/// Every recorded quote verifies as 1Click signed it, and the signed message is the one the file
/// shows.
#[test]
fn every_recorded_quote_verifies() {
    for (file, doc) in files() {
        for q in doc["quotes"].as_array().unwrap() {
            let name = s(&q["name"]);
            let canonical = s(&q["canonical_json"]);
            assert_eq!(
                bs58::encode(sha256(canonical.as_bytes())).into_string(),
                s(&q["signed_message"]),
                "{file}: {name}"
            );
            assert!(q["signature_valid"].as_bool().unwrap(), "{file}: {name}");
            check_signature(sha256, ed25519_verify, canonical, s(&q["signature"]))
                .unwrap_or_else(|r| panic!("{file}: {name}: {r}"));
        }
    }
}

/// Every tampered copy (amounts, recipient, refund, deadline, assets, deposit address, memo,
/// spacing, a flipped bit, another quote's signature) fails the signature.
#[test]
fn every_tampered_quote_fails_the_signature() {
    for (file, doc) in files() {
        let tampered = doc["tampered"].as_array().unwrap();
        assert!(tampered.len() >= 15, "{file}");
        for t in tampered {
            let name = s(&t["name"]);
            assert_eq!(s(&t["expect"]), E_QUOTE_SIGNATURE, "{file}: {name}");
            assert!(!t["signature_valid"].as_bool().unwrap(), "{file}: {name}");
            let r = check_signature(
                sha256,
                ed25519_verify,
                s(&t["canonical_json"]),
                s(&t["signature"]),
            )
            .unwrap_err();
            assert_eq!(r.code, E_QUOTE_SIGNATURE, "{file}: {name}");
        }
    }
}

/// Every field case ends as the file says: ok, or the code it names.
#[test]
fn every_field_case() {
    let mut codes = std::collections::BTreeMap::new();
    for (file, doc) in files() {
        for c in doc["field_cases"].as_array().unwrap() {
            let name = s(&c["name"]);
            let q = quote(&doc, s(&c["quote"]));
            let canonical = c["canonical_json"]
                .as_str()
                .unwrap_or(s(&q["canonical_json"]));
            let signature = c["signature"].as_str().unwrap_or(s(&q["signature"]));
            let method = Method::parse(s(&c["method"])).unwrap();
            let got = verify_quote(
                sha256,
                ed25519_verify,
                canonical,
                signature,
                method,
                &context(&c["ctx"]),
            );
            let expect = &c["expect"];
            if expect["ok"].as_bool().unwrap() {
                let v = got.unwrap_or_else(|r| panic!("{file}: {name}: {r}"));
                assert_eq!(v.method, method);
                assert_eq!(
                    v.amount_in.to_string(),
                    s(&q["response"]["quote"]["amountIn"])
                );
                *codes.entry("ok").or_insert(0) += 1;
            } else {
                let r = got.err().unwrap_or_else(|| panic!("{file}: {name} passed"));
                assert_eq!(r.code, s(&expect["code"]), "{file}: {name}: {r}");
                *codes.entry(r.code).or_insert(0) += 1;
            }
        }
    }
    for code in ["ok", E_QUOTE_SIGNATURE, E_QUOTE_FIELDS, E_RESCUE_CAP] {
        assert!(codes.contains_key(code), "no case ends {code}: {codes:?}");
    }
}

/// What a live quote passes on: its deposit address in the form the method pays, its amounts in
/// e8 and its deadline; and the signed cost of every recorded quote matches the file.
#[test]
fn a_live_quote_yields_its_deposit_address() {
    let [_, (_, live)] = files();
    for c in live["field_cases"].as_array().unwrap() {
        if !c["name"].as_str().unwrap().starts_with("as quoted: ") || c["expect"]["ok"] != true {
            continue;
        }
        let q = quote(&live, s(&c["quote"]));
        let method = Method::parse(s(&c["method"])).unwrap();
        let v = verify_quote(
            sha256,
            ed25519_verify,
            s(&q["canonical_json"]),
            s(&q["signature"]),
            method,
            &context(&c["ctx"]),
        )
        .unwrap();
        let fields: Value = serde_json::from_str(s(&q["canonical_json"])).unwrap();
        let deposit = s(&fields["depositAddress"]);
        let want = match method {
            Method::HlSendToIntents | Method::EvmUsdcToIntents => deposit.to_ascii_lowercase(),
            _ => deposit.to_owned(),
        };
        assert_eq!(
            v.deposit_address.as_deref(),
            Some(want.as_str()),
            "{}",
            q["name"]
        );
        assert_eq!(
            v.deadline_ms,
            parse_time_ms(s(&fields["deadline"])).unwrap()
        );
        assert_eq!(
            v.signed_at_ms,
            parse_time_ms(s(&fields["timestamp"])).unwrap()
        );
        assert_eq!(v.recipient, s(&fields["recipient"]));
        assert_eq!(v.destination_asset, s(&fields["destinationAsset"]));
        let cost = v.amount_in_e8 - v.min_amount_out_e8;
        assert_eq!(cost.to_string(), s(&q["signed_cost_e8"]), "{}", q["name"]);
    }
}

/// The cost bound at the policy defaults (100 bp, 0.5 USDC) over the live quotes: every rescue
/// and Orderly route recorded fits it; the 20 USDC NEAR-origin quote (0.52) does not.
#[test]
fn the_recorded_costs_against_the_default_bound() {
    let [_, (_, live)] = files();
    for c in live["field_cases"].as_array().unwrap() {
        if !c["name"].as_str().unwrap().starts_with("as quoted: ") || c["expect"]["ok"] != true {
            continue;
        }
        let q = quote(&live, s(&c["quote"]));
        let v = verify_quote(
            sha256,
            ed25519_verify,
            s(&q["canonical_json"]),
            s(&q["signature"]),
            Method::parse(s(&c["method"])).unwrap(),
            &context(&c["ctx"]),
        )
        .unwrap();
        let fits = check_cost(&v, 100, 500_000);
        if s(&q["name"]) == "fund_venue: USDC on NEAR (contract) to Hyperliquid" {
            assert_eq!(fits.unwrap_err().code, E_QUOTE_FIELDS);
        } else {
            fits.unwrap_or_else(|r| panic!("{}: {r}", q["name"]));
        }
    }
}

/// Any signature: for a quote 1Click would not sign, to reach the field rules.
fn any_signature(_: &[u8; 64], _: &[u8], _: &[u8; 32]) -> bool {
    true
}

/// Every live quote's deadline is about three days after its signed `timestamp` (1Click adds 72 h
/// to the requested deadline), longer than a contract remembers the deposit addresses it paid:
/// [`verify_quote`] pays a quote within the hour after the timestamp, and within five minutes
/// before it, edges included ([`check_quote_age`]), whatever the deadline. A quote without a
/// readable timestamp is refused.
#[test]
fn a_quote_pays_within_the_hour_after_it_was_signed() {
    let [_, (_, live)] = files();
    let mut checked = 0;
    for c in live["field_cases"].as_array().unwrap() {
        if !c["name"].as_str().unwrap().starts_with("as quoted: ") || c["expect"]["ok"] != true {
            continue;
        }
        let q = quote(&live, s(&c["quote"]));
        let fields: Value = serde_json::from_str(s(&q["canonical_json"])).unwrap();
        let method = Method::parse(s(&c["method"])).unwrap();
        let at = |now_ms: u64| {
            let ctx = Context {
                now_ms,
                ..context(&c["ctx"])
            };
            verify_quote(
                sha256,
                ed25519_verify,
                s(&q["canonical_json"]),
                s(&q["signature"]),
                method,
                &ctx,
            )
        };
        let name = s(&q["name"]);
        let signed = parse_time_ms(s(&fields["timestamp"])).unwrap();
        let deadline = parse_time_ms(s(&fields["deadline"])).unwrap();
        assert!(deadline - signed > 70 * QUOTE_MAX_AGE_MS, "{name}");
        for ok in [
            signed - QUOTE_MAX_AHEAD_MS,
            signed,
            signed + QUOTE_MAX_AGE_MS,
        ] {
            let v = at(ok).unwrap_or_else(|r| panic!("{name} at {ok}: {r}"));
            assert_eq!(v.signed_at_ms, signed);
            check_quote_age(signed, ok).unwrap();
        }
        for (late, says) in [
            (signed - QUOTE_MAX_AHEAD_MS - 1, "more than 5 min after"),
            (signed + QUOTE_MAX_AGE_MS + 1, "more than 1 h before"),
            (deadline - 1, "more than 1 h before"),
        ] {
            let r = at(late).unwrap_err();
            assert_eq!(r.code, E_QUOTE_FIELDS, "{name} at {late}");
            assert!(r.msg.contains(says), "{name} at {late}: {r}");
            assert_eq!(check_quote_age(signed, late).unwrap_err(), r);
        }
        checked += 1;
    }
    assert!(checked >= 5, "{checked}");
    // A quote whose timestamp is no UTC time, or missing, never verifies.
    let q = quote(
        &live,
        "Orderly money out: Arbitrum USDC (desk EVM) to Hyperliquid",
    );
    let canonical = s(&q["canonical_json"]);
    let c = live["field_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["quote"] == q["name"] && c["expect"]["ok"] == true)
        .unwrap();
    let ctx = context(&c["ctx"]);
    let fields: Value = serde_json::from_str(canonical).unwrap();
    let stamp = format!(r#""timestamp":"{}""#, s(&fields["timestamp"]));
    assert_eq!(canonical.matches(&stamp).count(), 1);
    for (bad, says) in [
        (r#""timestamp":"yesterday""#, "timestamp"),
        (r#""timestamp":"""#, "timestamp"),
        (r#""timestamp":1793460552462"#, "not a 1Click quote"),
        (r#""ignored":"x""#, "not a 1Click quote"),
    ] {
        let r = verify_quote(
            sha256,
            any_signature,
            &canonical.replace(&stamp, bad),
            s(&q["signature"]),
            Method::EvmUsdcToIntents,
            &ctx,
        )
        .unwrap_err();
        assert_eq!(r.code, E_QUOTE_FIELDS, "{bad}: {r}");
        assert!(r.msg.contains(says), "{bad}: {r}");
    }
}

/// A quote into its own origin asset only pays fees: refused even when it pays a desk address,
/// before the refund and recipient rules (review round 2, item 1).
#[test]
fn a_quote_into_its_own_origin_asset_is_refused() {
    let [_, (_, live)] = files();
    let name = "rescue Phoenix -> Hyperliquid: Solana USDC to the desk EVM address";
    let q = quote(&live, name);
    let c = live["field_cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == format!("as quoted: {name}"))
        .unwrap();
    let ctx = context(&c["ctx"]);
    let canonical = s(&q["canonical_json"]);
    let signature = s(&q["signature"]);
    // As quoted it passes, with the stand-in verifier as with the real one.
    for verify in [
        ed25519_verify as fn(&[u8; 64], &[u8], &[u8; 32]) -> bool,
        any_signature,
    ] {
        verify_quote(
            sha256,
            verify,
            canonical,
            signature,
            Method::SolSignRescue,
            &ctx,
        )
        .unwrap();
    }
    // Solana USDC back to the desk's Solana authority, the desk's own pair for Solana USDC.
    let looped = canonical
        .replace(HL_USDC, SOL_USDC)
        .replace(ctx.desk.evm, ctx.desk.sol);
    assert_ne!(looped, canonical);
    let r = verify_quote(
        sha256,
        any_signature,
        &looped,
        signature,
        Method::SolSignRescue,
        &ctx,
    )
    .unwrap_err();
    assert_eq!(
        r.to_string(),
        format!(
            "E_QUOTE_FIELDS: destinationAsset is the originAsset {SOL_USDC}: a transfer into the \
             same asset only pays fees"
        )
    );
    // 1Click's real signature does not cover it.
    let r = verify_quote(
        sha256,
        ed25519_verify,
        &looped,
        signature,
        Method::SolSignRescue,
        &ctx,
    )
    .unwrap_err();
    assert_eq!(r.code, E_QUOTE_SIGNATURE);
}
