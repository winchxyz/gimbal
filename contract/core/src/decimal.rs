//! Canonical decimal strings (docs/interfaces.md §1.3) to integer units of 1e-8.
//!
//! Canonical means `"0"` or `[1-9][0-9]*`, optionally followed by `.` and 1 to 8 ASCII digits that do
//! not end in `0`. Every value then has exactly one spelling, so the string the contract signs is the
//! string the venue parses, and nothing is rounded on the way. The contract refuses anything else
//! with `E_DECIMAL` instead of normalising it.

use crate::errors::{shown, Refusal, E_DECIMAL};

/// Digits allowed after the dot.
pub const DECIMALS: usize = 8;

/// Units in 1: values are integers of 1e-8.
pub const UNIT: u128 = 100_000_000;

/// Parses a canonical decimal string into units of 1e-8.
///
/// Refuses (`E_DECIMAL`): an empty string, a sign, any character other than ASCII digits and one
/// dot, an empty integer or fraction part, a leading zero, more than 8 decimals, a trailing zero
/// after the dot, and a value above `u128::MAX` units. Zero itself is accepted; whether zero is
/// allowed is the caller's rule (a zero size is `E_SIZE`).
pub fn parse_e8(s: &str) -> Result<u128, Refusal> {
    let refuse = |why: &str| Refusal::new(E_DECIMAL, format!("{} {why}", shown(s)));

    if s.is_empty() {
        return Err(refuse("is empty"));
    }
    if s.starts_with(['+', '-']) {
        return Err(refuse("has a sign"));
    }
    let (int, frac) = match s.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (s, None),
    };
    // Checked on bytes, so a non-ASCII digit (Arabic-Indic, fullwidth) is refused like any letter.
    let all_digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(int) || !frac.is_none_or(all_digits) {
        return Err(refuse(
            "has a character other than ASCII digits and one dot",
        ));
    }
    if int.is_empty() || frac == Some("") {
        return Err(refuse("has an empty integer or fraction part"));
    }
    if int.len() > 1 && int.starts_with('0') {
        return Err(refuse("has a leading zero"));
    }
    let frac = frac.unwrap_or("");
    if frac.len() > DECIMALS {
        return Err(refuse("has more than 8 decimals"));
    }
    if frac.ends_with('0') {
        return Err(refuse("has a trailing zero after the dot"));
    }

    let overflow = || refuse("is too large");
    let mut whole: u128 = 0;
    for b in int.bytes() {
        whole = whole
            .checked_mul(10)
            .and_then(|w| w.checked_add(u128::from(b - b'0')))
            .ok_or_else(overflow)?;
    }
    // At most 8 digits, so this cannot overflow.
    let mut part: u128 = 0;
    for b in frac.bytes() {
        part = part * 10 + u128::from(b - b'0');
    }
    part *= 10u128.pow((DECIMALS - frac.len()) as u32);

    whole
        .checked_mul(UNIT)
        .and_then(|w| w.checked_add(part))
        .ok_or_else(overflow)
}

/// Writes units of 1e-8 as the canonical decimal string: the inverse of [`parse_e8`].
pub fn format_e8(units: u128) -> String {
    let whole = units / UNIT;
    let part = units % UNIT;
    if part == 0 {
        return whole.to_string();
    }
    let digits = format!("{part:0width$}", width = DECIMALS);
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> u128 {
        parse_e8(s).unwrap_or_else(|r| panic!("{s:?} refused: {r}"))
    }

    fn refused(s: &str) -> Refusal {
        match parse_e8(s) {
            Ok(v) => panic!("{s:?} accepted as {v}"),
            Err(r) => {
                assert_eq!(r.code, E_DECIMAL, "{s:?}");
                r
            }
        }
    }

    #[test]
    fn zero_is_canonical() {
        assert_eq!(ok("0"), 0);
    }

    #[test]
    fn integers_scale_by_1e8() {
        assert_eq!(ok("1"), 100_000_000);
        assert_eq!(ok("7"), 700_000_000);
        assert_eq!(ok("10"), 1_000_000_000);
        assert_eq!(ok("2400"), 240_000_000_000);
    }

    #[test]
    fn fractions_scale_by_1e8() {
        assert_eq!(ok("0.1"), 10_000_000);
        assert_eq!(ok("0.25"), 25_000_000);
        assert_eq!(ok("1.5"), 150_000_000);
        assert_eq!(ok("2397.1"), 239_710_000_000);
        assert_eq!(ok("0.0042"), 420_000);
    }

    #[test]
    fn eight_decimals_is_the_limit() {
        assert_eq!(ok("0.00000001"), 1);
        assert_eq!(ok("0.12345678"), 12_345_678);
        assert_eq!(ok("3.00000007"), 300_000_007);
        refused("0.000000001");
        refused("1.123456789");
        refused("1.000000001");
    }

    #[test]
    fn largest_value_is_u128_max_units() {
        assert_eq!(ok("3402823669209384634633746074317.68211455"), u128::MAX);
        let r = refused("3402823669209384634633746074317.68211456");
        assert!(r.msg.ends_with("is too large"), "{}", r.msg);
        // Overflow in the integer part alone, before the scale is applied.
        refused("340282366920938463463374607431768211456");
        refused("3402823669209384634633746074318");
    }

    #[test]
    fn empty_is_refused() {
        let r = refused("");
        assert_eq!(r.msg, "\"\" is empty");
    }

    #[test]
    fn sign_is_refused() {
        for s in ["-1", "+1", "-0", "+0.5", "-"] {
            refused(s);
        }
    }

    #[test]
    fn leading_zero_is_refused() {
        for s in ["00", "01", "007.5", "00.1", "0123"] {
            let r = refused(s);
            assert!(r.msg.ends_with("has a leading zero"), "{s:?}: {}", r.msg);
        }
    }

    #[test]
    fn trailing_zero_after_the_dot_is_refused() {
        for s in ["1.0", "1.50", "0.0", "0.00000000", "2400.10", "10.0"] {
            let r = refused(s);
            assert!(r.msg.ends_with("trailing zero after the dot"), "{s:?}");
        }
    }

    #[test]
    fn empty_parts_are_refused() {
        for s in [".", "1.", ".5", "0."] {
            let r = refused(s);
            assert!(r.msg.ends_with("empty integer or fraction part"), "{s:?}");
        }
    }

    #[test]
    fn non_ascii_digits_are_refused() {
        // ARABIC-INDIC DIGIT ONE, FULLWIDTH DIGIT ONE, DEVANAGARI DIGIT FIVE, SUPERSCRIPT TWO.
        for s in [
            "\u{0661}",
            "\u{FF11}",
            "1.\u{096B}",
            "\u{00B2}",
            "1\u{0660}",
        ] {
            refused(s);
        }
    }

    #[test]
    fn other_characters_are_refused() {
        for s in [
            " 1", "1 ", "1e8", "1E-8", "1,5", "1.2.3", "0x10", "1_000", "NaN", "Infinity", "1..2",
            "1.5\n", "\t1",
        ] {
            refused(s);
        }
    }

    #[test]
    fn long_input_is_cut_in_the_message() {
        let s = "9".repeat(100) + "x";
        let r = refused(&s);
        assert!(
            r.msg.starts_with(&format!("\"{}\"…", "9".repeat(40))),
            "{}",
            r.msg
        );
        assert!(r.msg.len() < 120, "{}", r.msg);
    }

    #[test]
    fn refusal_displays_as_the_panic_message() {
        let r = refused("1.50");
        assert_eq!(
            r.to_string(),
            "E_DECIMAL: \"1.50\" has a trailing zero after the dot"
        );
    }

    #[test]
    fn format_writes_canonical_strings() {
        assert_eq!(format_e8(0), "0");
        assert_eq!(format_e8(1), "0.00000001");
        assert_eq!(format_e8(100_000_000), "1");
        assert_eq!(format_e8(150_000_000), "1.5");
        assert_eq!(format_e8(240_050_000_000), "2400.5");
        assert_eq!(
            format_e8(u128::MAX),
            "3402823669209384634633746074317.68211455"
        );
    }

    #[test]
    fn format_and_parse_round_trip() {
        let mut v: u128 = 1;
        while v < u128::MAX / 7 {
            for units in [v, v - 1, v + 3, v * 5] {
                assert_eq!(ok(&format_e8(units)), units, "{units}");
            }
            v *= 7;
        }
    }
}
