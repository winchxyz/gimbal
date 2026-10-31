//! EIP-712 typed-data hashes (<https://eips.ethereum.org/EIPS/eip-712>) for what the desk's EVM key
//! signs: Hyperliquid's `Agent` and user-signed actions now, Orderly's messages and EIP-3009 later.
//!
//! keccak256 comes from the caller as a [`Keccak`], so the contract uses the host's (cheap in gas)
//! and the tests a Rust one; nothing here depends on near-sdk.

/// keccak256.
pub type Keccak = fn(&[u8]) -> [u8; 32];

pub const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/// One member of a struct, as EIP-712 encodes it into a 32-byte word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field<'a> {
    /// `string`: keccak256 of the UTF-8 bytes.
    Str(&'a str),
    /// `bytes32`: as is.
    Bytes32([u8; 32]),
    /// `uint64` / `uint256` up to 2^64 − 1: big-endian, left-padded.
    Uint(u64),
    /// `bool`: 0 or 1.
    Bool(bool),
    /// `address`: the 20 bytes, left-padded.
    Address([u8; 20]),
}

/// `encodeData` of one member.
pub fn word(keccak: Keccak, field: &Field) -> [u8; 32] {
    let mut w = [0u8; 32];
    match field {
        Field::Str(s) => return keccak(s.as_bytes()),
        Field::Bytes32(b) => return *b,
        Field::Uint(n) => w[24..].copy_from_slice(&n.to_be_bytes()),
        Field::Bool(b) => w[31] = u8::from(*b),
        Field::Address(a) => w[12..].copy_from_slice(a),
    }
    w
}

/// `hashStruct`: keccak256(keccak256(type) ‖ encodeData of each member, in the type's order).
pub fn hash_struct(keccak: Keccak, type_string: &str, fields: &[Field]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * (1 + fields.len()));
    buf.extend_from_slice(&keccak(type_string.as_bytes()));
    for field in fields {
        buf.extend_from_slice(&word(keccak, field));
    }
    keccak(&buf)
}

/// The domain separator of `{name, version, chainId, verifyingContract}`.
pub fn domain_separator(
    keccak: Keccak,
    name: &str,
    version: &str,
    chain_id: u64,
    verifying_contract: [u8; 20],
) -> [u8; 32] {
    hash_struct(
        keccak,
        DOMAIN_TYPE,
        &[
            Field::Str(name),
            Field::Str(version),
            Field::Uint(chain_id),
            Field::Address(verifying_contract),
        ],
    )
}

/// The 32 bytes a key signs: keccak256(0x19 0x01 ‖ domain separator ‖ struct hash).
pub fn digest(keccak: Keccak, domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 66];
    buf[..2].copy_from_slice(&[0x19, 0x01]);
    buf[2..34].copy_from_slice(domain_separator);
    buf[34..].copy_from_slice(struct_hash);
    keccak(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in hash that shows what was hashed, to check the layout without a keccak.
    fn first32(data: &[u8]) -> [u8; 32] {
        let mut out = [0xee; 32];
        let n = data.len().min(32);
        out[..n].copy_from_slice(&data[..n]);
        out
    }

    #[test]
    fn words_are_left_padded() {
        let w = word(first32, &Field::Uint(0x0102));
        assert_eq!(w[..30], [0; 30]);
        assert_eq!(w[30..], [1, 2]);
        assert_eq!(word(first32, &Field::Bool(true))[31], 1);
        assert_eq!(word(first32, &Field::Bool(false)), [0; 32]);
        let w = word(first32, &Field::Address([7; 20]));
        assert_eq!(
            (w[..12].to_vec(), w[12..].to_vec()),
            (vec![0; 12], vec![7; 20])
        );
        assert_eq!(word(first32, &Field::Bytes32([9; 32])), [9; 32]);
        assert_eq!(word(first32, &Field::Str("ab"))[..3], [b'a', b'b', 0xee]);
    }

    #[test]
    fn the_digest_is_prefixed_with_0x1901() {
        let d = digest(first32, &[1; 32], &[2; 32]);
        assert_eq!(d[..2], [0x19, 0x01]);
        assert_eq!(d[2..], [1; 30]);
    }
}
