//! Desk ids and venue addresses (docs/interfaces.md §1.2, §1.5). A desk's addresses are fixed when it
//! is created, so a malformed one is refused there (`E_ARGS`) instead of failing at its first payload.

use crate::errors::{shown, Refusal, E_ARGS};

/// Longest desk id: `[a-z0-9-]{1,32}`.
pub const DESK_ID_MAX_LEN: usize = 32;

/// Longest base58 spelling of 32 bytes (all `0xff`); shorter inputs are decoded, longer ones refused
/// before decoding, whose cost grows with the square of the length.
const BASE58_32_MAX_CHARS: usize = 44;

/// `[a-z0-9-]{1,32}`: the id goes into the MPC derivation paths `gimbal/<desk_id>/evm` and
/// `gimbal/<desk_id>/sol`, so one spelling per desk keeps one set of keys per desk.
pub fn check_desk_id(desk_id: &str) -> Result<(), Refusal> {
    let ok = !desk_id.is_empty()
        && desk_id.len() <= DESK_ID_MAX_LEN
        && desk_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(Refusal::new(
            E_ARGS,
            format!(
                "desk id {} is not 1 to {DESK_ID_MAX_LEN} characters of a-z, 0-9 and -",
                shown(desk_id)
            ),
        ))
    }
}

/// `0x` and 40 lowercase hex digits: Hyperliquid lowercases addresses before it verifies a
/// signature, so a mixed-case address in a signed action would not match.
pub fn is_lower_evm_address(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// [`is_lower_evm_address`], as a refusal naming the argument.
pub fn check_evm_address(field: &str, s: &str) -> Result<(), Refusal> {
    if is_lower_evm_address(s) {
        Ok(())
    } else {
        Err(Refusal::new(
            E_ARGS,
            format!("{field} {} is not a lowercase 0x address", shown(s)),
        ))
    }
}

/// The 32 bytes a Solana account address spells in base58, or `None`. Base58 has one spelling per
/// byte string, so a decoded address cannot have a second form.
pub fn decode_base58_32(s: &str) -> Option<[u8; 32]> {
    if s.is_empty() || s.len() > BASE58_32_MAX_CHARS {
        return None;
    }
    let mut out = [0u8; 32];
    match bs58::decode(s).onto(&mut out[..]) {
        Ok(32) => Some(out),
        _ => None,
    }
}

/// [`decode_base58_32`], as a refusal naming the argument.
pub fn check_base58_32(field: &str, s: &str) -> Result<[u8; 32], Refusal> {
    decode_base58_32(s).ok_or_else(|| {
        Refusal::new(
            E_ARGS,
            format!("{field} {} is not a base58 address of 32 bytes", shown(s)),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desk_ids() {
        let max = "a".repeat(DESK_ID_MAX_LEN);
        for ok in ["alpha", "a", "0", "-", "desk-1", "9lives", max.as_str()] {
            check_desk_id(ok).unwrap_or_else(|r| panic!("{ok:?}: {r}"));
        }
        let long = "a".repeat(DESK_ID_MAX_LEN + 1);
        for bad in [
            "",
            long.as_str(),
            "Alpha",
            "a_b",
            "a.b",
            "a b",
            "a/b",
            "\u{e9}t\u{e9}",
            "alpha\n",
        ] {
            let r = check_desk_id(bad).expect_err(bad);
            assert_eq!(r.code, E_ARGS, "{bad:?}");
        }
    }

    #[test]
    fn a_huge_desk_id_is_cut_in_the_message() {
        let r = check_desk_id(&"A".repeat(10_000)).unwrap_err();
        assert!(r.msg.len() < 200, "{}", r.msg);
    }

    #[test]
    fn evm_addresses() {
        check_evm_address("evm_address", "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c").unwrap();
        for bad in [
            "0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c",
            "5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9cc",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9g",
            "0X5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
            " 0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9",
            "",
        ] {
            let r = check_evm_address("evm_address", bad).expect_err(bad);
            assert_eq!(r.code, E_ARGS);
            assert!(r.msg.starts_with("evm_address "), "{}", r.msg);
        }
    }

    #[test]
    fn base58_addresses_of_32_bytes() {
        // The system program (all zero bytes) and a real Phoenix-style key.
        assert_eq!(
            decode_base58_32("11111111111111111111111111111111"),
            Some([0; 32])
        );
        let onboarder = "EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z";
        let bytes = check_base58_32("solana.authority", onboarder).unwrap();
        assert_eq!(bs58::encode(bytes).into_string(), onboarder);
        // 32 bytes of 0xff: the longest spelling.
        let max = bs58::encode([0xffu8; 32]).into_string();
        assert_eq!(max.len(), BASE58_32_MAX_CHARS);
        assert_eq!(decode_base58_32(&max), Some([0xff; 32]));
    }

    #[test]
    fn other_base58_is_refused() {
        let short = bs58::encode([7u8; 31]).into_string();
        let long = bs58::encode([7u8; 33]).into_string();
        for bad in [
            "",
            short.as_str(),
            long.as_str(),
            // 0, O, I and l are not in the base58 alphabet.
            "0zkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
            "OzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
            "IzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
            "lzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
            " EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
        ] {
            assert_eq!(decode_base58_32(bad), None, "{bad:?}");
            let r = check_base58_32("solana.usdc_ata", bad).unwrap_err();
            assert_eq!(r.code, E_ARGS);
            assert!(r.msg.starts_with("solana.usdc_ata "), "{}", r.msg);
        }
    }
}
