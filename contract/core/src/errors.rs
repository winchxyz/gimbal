//! Refusal codes (docs/interfaces.md §1.5) and the error every core check returns.
//!
//! The engine, its replay client and the tests match on these codes, so a code never changes meaning.

use std::fmt;

/// Caller is neither owner nor operator, or the operator called an owner method.
pub const E_NOT_ALLOWED: &str = "E_NOT_ALLOWED";
/// Desk paused.
pub const E_PAUSED: &str = "E_PAUSED";
/// No desk with that id.
pub const E_NO_DESK: &str = "E_NO_DESK";
/// A desk with that id exists already.
pub const E_DESK_EXISTS: &str = "E_DESK_EXISTS";
/// Malformed argument: desk id, address, base58/hex, `reason` length, a once-only setting set twice.
pub const E_ARGS: &str = "E_ARGS";
/// Attached deposit below the storage cost.
pub const E_DEPOSIT: &str = "E_DEPOSIT";
/// Asset, symbol or market not in the policy.
pub const E_ASSET: &str = "E_ASSET";
/// Notional over `max_notional_usd`, or zero.
pub const E_SIZE: &str = "E_SIZE";
/// Non-canonical decimal string.
pub const E_DECIMAL: &str = "E_DECIMAL";
/// Price outside `price_band_bps` of the oracle price.
pub const E_PRICE_BAND: &str = "E_PRICE_BAND";
/// No oracle price younger than `oracle_max_age_s`.
pub const E_ORACLE_STALE: &str = "E_ORACLE_STALE";
/// 1Click quote signature does not verify.
pub const E_QUOTE_SIGNATURE: &str = "E_QUOTE_SIGNATURE";
/// Quote recipient, refundTo, assets or deadline not acceptable.
pub const E_QUOTE_FIELDS: &str = "E_QUOTE_FIELDS";
/// Over `rescue_cap_usd_per_hour`.
pub const E_RESCUE_CAP: &str = "E_RESCUE_CAP";
/// Not a legacy message, trailing bytes, wrong signer count or fee payer.
pub const E_SOL_MESSAGE: &str = "E_SOL_MESSAGE";
/// Instruction for a program outside the allowlist.
pub const E_SOL_PROGRAM: &str = "E_SOL_PROGRAM";
/// Instruction touches an account the desk does not own.
pub const E_SOL_ACCOUNT: &str = "E_SOL_ACCOUNT";
/// The MPC network did not return a signature.
pub const E_MPC: &str = "E_MPC";

/// Every code, in the order of interfaces §1.5.
pub const ALL: [&str; 18] = [
    E_NOT_ALLOWED,
    E_PAUSED,
    E_NO_DESK,
    E_DESK_EXISTS,
    E_ARGS,
    E_DEPOSIT,
    E_ASSET,
    E_SIZE,
    E_DECIMAL,
    E_PRICE_BAND,
    E_ORACLE_STALE,
    E_QUOTE_SIGNATURE,
    E_QUOTE_FIELDS,
    E_RESCUE_CAP,
    E_SOL_MESSAGE,
    E_SOL_PROGRAM,
    E_SOL_ACCOUNT,
    E_MPC,
];

/// Why the contract will not do what it was asked. Displays as `"E_CODE: msg"`, which is exactly
/// the panic message the `gimbal` crate ends the call with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// One of the `E_*` constants above.
    pub code: &'static str,
    /// Plain-language detail for the person reading the failed transaction.
    pub msg: String,
}

impl Refusal {
    pub fn new(code: &'static str, msg: impl Into<String>) -> Self {
        // A typo in a code would silently break every client that matches on it.
        debug_assert!(ALL.contains(&code), "unknown refusal code {code}");
        Self {
            code,
            msg: msg.into(),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.msg)
    }
}

impl std::error::Error for Refusal {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_its_own_name() {
        for code in ALL {
            assert!(code.starts_with("E_"), "{code}");
            assert!(
                code[2..]
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b == b'_'),
                "{code}"
            );
        }
    }

    #[test]
    fn codes_are_unique() {
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn display_puts_the_code_first() {
        let r = Refusal::new(E_PRICE_BAND, "px 2500 is 4.3% from oracle 2397.1");
        assert_eq!(
            r.to_string(),
            "E_PRICE_BAND: px 2500 is 4.3% from oracle 2397.1"
        );
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "unknown refusal code")]
    fn unknown_code_is_caught_in_tests() {
        let _ = Refusal::new("E_TYPO", "x");
    }
}
