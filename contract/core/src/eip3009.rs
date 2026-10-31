//! EIP-3009 `TransferWithAuthorization` for Circle's USDC on Arbitrum (docs/interfaces.md §1.4,
//! "Arbitrum"): what `evm_usdc_to_intents` has the desk's EVM key sign, so the relayer can move
//! USDC from the desk's Arbitrum address to a verified 1Click deposit address and pay the gas.
//!
//! The nonce is the contract's, never the relayer's: keccak256(utf8(desk_id) ‖ counter as u64
//! big-endian), with a counter per desk that the signing call itself advances. `validAfter` is 0
//! and `validBefore` the block time + [`VALIDITY_S`], so a signature the MPC returns late dies on
//! its own.

use crate::eip712::{self, Field, Keccak};
use crate::msgpack::Value;
use crate::network::Network;

pub const TYPE: &str = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

/// How long an authorization is valid after the block that signs it, in seconds.
pub const VALIDITY_S: u64 = 300;

/// Circle's USDC domain: name and version are the same on both networks.
pub const DOMAIN_NAME: &str = "USD Coin";
pub const DOMAIN_VERSION: &str = "2";

/// The USDC contract on the network's Arbitrum chain, lowercase.
pub const fn usdc_token(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        Network::Testnet => "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    }
}

/// The authorization's nonce for the desk's `counter`-th signature.
pub fn nonce(keccak: Keccak, desk_id: &str, counter: u64) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(desk_id.len() + 8);
    preimage.extend_from_slice(desk_id.as_bytes());
    preimage.extend_from_slice(&counter.to_be_bytes());
    keccak(&preimage)
}

/// One transfer: `value` USDC (1e-6) from `from` to `to`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value: u64,
    pub valid_after: u64,
    pub valid_before: u64,
    pub nonce: [u8; 32],
}

pub fn domain_separator(keccak: Keccak, network: Network) -> [u8; 32] {
    eip712::domain_separator(
        keccak,
        DOMAIN_NAME,
        DOMAIN_VERSION,
        network.arbitrum_chain_id(),
        token_bytes(network),
    )
}

impl Authorization {
    pub fn struct_hash(&self, keccak: Keccak) -> [u8; 32] {
        eip712::hash_struct(
            keccak,
            TYPE,
            &[
                Field::Address(self.from),
                Field::Address(self.to),
                Field::Uint(self.value),
                Field::Uint(self.valid_after),
                Field::Uint(self.valid_before),
                Field::Bytes32(self.nonce),
            ],
        )
    }

    pub fn digest(&self, keccak: Keccak, network: Network) -> [u8; 32] {
        eip712::digest(
            keccak,
            &domain_separator(keccak, network),
            &self.struct_hash(keccak),
        )
    }

    /// What the relayer needs besides the signature: the fields of the typed message (lowercase
    /// hex, uint256 values as decimal strings), then the token and the chain id.
    pub fn payload(&self, network: Network) -> Value {
        let hex = |b: &[u8]| Value::Str(format!("0x{}", hex::encode(b)));
        Value::map([
            ("from", hex(&self.from)),
            ("to", hex(&self.to)),
            ("value", Value::Str(self.value.to_string())),
            ("validAfter", Value::Str(self.valid_after.to_string())),
            ("validBefore", Value::Str(self.valid_before.to_string())),
            ("nonce", hex(&self.nonce)),
            ("token", Value::str(usdc_token(network))),
            ("chainId", Value::UInt(network.arbitrum_chain_id())),
        ])
    }
}

/// The 20 bytes of [`usdc_token`] (a constant, so the decode cannot fail; the test checks it).
fn token_bytes(network: Network) -> [u8; 20] {
    let mut out = [0u8; 20];
    let _ = hex::decode_to_slice(&usdc_token(network)[2..], &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_addresses_decode() {
        for network in [Network::Mainnet, Network::Testnet] {
            let bytes = token_bytes(network);
            assert_eq!(format!("0x{}", hex::encode(bytes)), usdc_token(network));
        }
    }
}
