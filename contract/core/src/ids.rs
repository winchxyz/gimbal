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

/// Longest `reason` of an action method, in characters.
pub const REASON_MAX_CHARS: usize = 280;

/// An action's `reason`: at most [`REASON_MAX_CHARS`] characters (`E_ARGS`). Events carry its
/// sha256, not the text.
pub fn check_reason(reason: &str) -> Result<(), Refusal> {
    let chars = reason.chars().count();
    if chars > REASON_MAX_CHARS {
        return Err(Refusal::new(
            E_ARGS,
            format!("reason has {chars} characters, over {REASON_MAX_CHARS}"),
        ));
    }
    Ok(())
}

/// MPC domain 0: the desk's EVM key.
pub const MPC_DOMAIN_SECP256K1: u32 = 0;
/// MPC domain 1: the desk's Solana and Orderly key.
pub const MPC_DOMAIN_ED25519: u32 = 1;

/// The MPC derivation path of a desk's EVM key (domain 0).
pub fn evm_path(desk_id: &str) -> String {
    format!("gimbal/{desk_id}/evm")
}

/// The MPC derivation path of a desk's Solana key (domain 1).
pub fn sol_path(desk_id: &str) -> String {
    format!("gimbal/{desk_id}/sol")
}

/// Longest base58 spelling of the 64-byte key the MPC returns for secp256k1.
const BASE58_64_MAX_CHARS: usize = 88;

/// The 64 bytes of an MPC `derived_public_key` answer for domain 0, `"secp256k1:<base58>"`: the
/// uncompressed key without its `0x04` prefix.
pub fn decode_mpc_secp256k1(s: &str) -> Option<[u8; 64]> {
    let b58 = s.strip_prefix("secp256k1:")?;
    if b58.is_empty() || b58.len() > BASE58_64_MAX_CHARS {
        return None;
    }
    let mut out = [0u8; 64];
    match bs58::decode(b58).onto(&mut out[..]) {
        Ok(64) => Some(out),
        _ => None,
    }
}

/// The 32 bytes of an MPC `derived_public_key` answer for domain 1, `"ed25519:<base58>"`.
pub fn decode_mpc_ed25519(s: &str) -> Option<[u8; 32]> {
    decode_base58_32(s.strip_prefix("ed25519:")?)
}

/// The EVM address of a key, given the keccak256 of its 64 uncompressed bytes: the last 20 bytes,
/// as lowercase `0x` hex. The hash comes from the caller, so the contract can use the host's keccak.
pub fn evm_address_from_keccak(hash: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(42);
    s.push_str("0x");
    for b in &hash[12..] {
        s.push(char::from(HEX[usize::from(b >> 4)]));
        s.push(char::from(HEX[usize::from(b & 0x0f)]));
    }
    s
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

    /// What `v1.signer-prod.testnet` answered on 2026-10-30 for desk `c2-measure` of the
    /// testnet contract account (shared with the contract's tests).
    const MPC_EVM: &str = "secp256k1:5SycFGui1Kswp8ivPpv3TNEeYbB7X3tCRUtxL2MtbdNhkggr2JsKrdPjzzzCsoHCCmsFf7pyg6xu1AKyB5SWEAbr";
    const MPC_SOL: &str = "ed25519:31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd";

    #[test]
    fn mpc_answers_decode_to_their_key_bytes() {
        let evm = decode_mpc_secp256k1(MPC_EVM).unwrap();
        assert_eq!(
            format!("secp256k1:{}", bs58::encode(evm).into_string()),
            MPC_EVM
        );
        let sol = decode_mpc_ed25519(MPC_SOL).unwrap();
        assert_eq!(
            bs58::encode(sol).into_string(),
            "31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd"
        );
    }

    #[test]
    fn other_mpc_answers_decode_to_nothing() {
        let evm_b58 = MPC_EVM.strip_prefix("secp256k1:").unwrap();
        let sol_b58 = MPC_SOL.strip_prefix("ed25519:").unwrap();
        for bad in [
            "",
            evm_b58,
            MPC_SOL,
            &format!("ed25519:{evm_b58}"),
            &format!("secp256k1:{sol_b58}"),
            &format!("secp256k1:{}", bs58::encode([1u8; 65]).into_string()),
            &format!("secp256k1:{}", bs58::encode([1u8; 33]).into_string()),
            "secp256k1:",
            "secp256k1:0OIl",
        ] {
            assert_eq!(decode_mpc_secp256k1(bad), None, "{bad:?}");
        }
        for bad in [
            "",
            sol_b58,
            MPC_EVM,
            "ed25519:",
            &format!("ed25519:{evm_b58}"),
        ] {
            assert_eq!(decode_mpc_ed25519(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn evm_address_is_the_last_20_bytes_of_the_hash_in_lowercase_hex() {
        let hash: [u8; 32] = std::array::from_fn(|i| (i as u8) * 8 + 7);
        let address = evm_address_from_keccak(&hash);
        assert_eq!(address, "0x676f777f878f979fa7afb7bfc7cfd7dfe7eff7ff");
        assert!(is_lower_evm_address(&address));
    }

    #[test]
    fn reasons_are_at_most_280_characters() {
        check_reason("").unwrap();
        check_reason(&"\u{e9}".repeat(REASON_MAX_CHARS)).unwrap();
        let r = check_reason(&"a".repeat(REASON_MAX_CHARS + 1)).unwrap_err();
        assert_eq!(r.code, E_ARGS);
        assert_eq!(r.msg, "reason has 281 characters, over 280");
    }

    #[test]
    fn derivation_paths() {
        assert_eq!(evm_path("alpha"), "gimbal/alpha/evm");
        assert_eq!(sol_path("alpha"), "gimbal/alpha/sol");
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
