//! Every case in `vectors/decimal.json` (generated from a regex + BigInt parser and cross-checked by a
//! second, char-by-char parser) must give the same answer here.

use gimbal_core::decimal::{format_e8, parse_e8};
use serde_json::Value;

const VECTORS: &str = include_str!("vectors/decimal.json");

#[test]
fn every_decimal_vector_matches() {
    let doc: Value = serde_json::from_str(VECTORS).expect("decimal.json parses");
    let cases = doc["cases"].as_array().expect("decimal.json has cases");
    assert!(!cases.is_empty());

    let mut failures = Vec::new();
    for case in cases {
        let input = case["input"].as_str().expect("input is a string");
        let got = parse_e8(input);
        if case["ok"].as_bool().expect("ok is a bool") {
            let want: u128 = case["units_e8"]
                .as_str()
                .expect("units_e8 is a string")
                .parse()
                .expect("units_e8 fits u128");
            let fits_u64 = case["fits_u64"].as_bool().expect("fits_u64 is a bool");
            if got != Ok(want) {
                failures.push(format!("{input:?}: want {want}, got {got:?}"));
            } else if u64::try_from(want).is_ok() != fits_u64 {
                failures.push(format!("{input:?}: fits_u64 should be {fits_u64}"));
            } else if format_e8(want) != input {
                // Canonical means one spelling per value: formatting gives the input back.
                failures.push(format!("{input:?}: formats as {:?}", format_e8(want)));
            }
        } else {
            let code = case["code"].as_str().expect("code is a string");
            match got {
                Err(r) if r.code == code => {}
                other => failures.push(format!("{input:?}: want {code}, got {other:?}")),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
