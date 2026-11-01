//! The network the contract runs on (docs/interfaces.md §1.1), fixed in `new`. Only ids differ between
//! testnet and mainnet; every builder takes the network and picks them here.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// Arbitrum chain ids Orderly runs on.
pub const ARBITRUM_MAINNET: u64 = 42161;
pub const ARBITRUM_SEPOLIA: u64 = 421614;

/// USDC on NEAR (Circle, 6 decimals): the token `ft_on_transfer` accepts and `fund_venue` and
/// `withdraw_to_owner` send. 1Click names the mainnet one `nep141:<this id>`.
pub const NEAR_USDC_MAINNET: &str =
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/// Circle's USDC on NEAR testnet (checked 2026-11-01: `ft_metadata` symbol USDC, storage 0.00125
/// NEAR). 1Click has no testnet, so testnet only takes deposits and pays out.
pub const NEAR_USDC_TESTNET: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/// JSON `"Mainnet"` / `"Testnet"`, borsh byte 0 / 1.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// The Arbitrum chain Orderly uses on this network: EIP-712 chainId, withdrawals, receiver address.
    pub const fn arbitrum_chain_id(self) -> u64 {
        match self {
            Network::Mainnet => ARBITRUM_MAINNET,
            Network::Testnet => ARBITRUM_SEPOLIA,
        }
    }

    /// The USDC token contract on NEAR.
    pub const fn near_usdc(self) -> &'static str {
        match self {
            Network::Mainnet => NEAR_USDC_MAINNET,
            Network::Testnet => NEAR_USDC_TESTNET,
        }
    }

    /// The `source` of a Hyperliquid L1 action's `Agent` message.
    pub const fn hl_source(self) -> &'static str {
        match self {
            Network::Mainnet => "a",
            Network::Testnet => "b",
        }
    }

    /// The `hyperliquidChain` of a Hyperliquid user-signed action.
    pub const fn hl_chain(self) -> &'static str {
        match self {
            Network::Mainnet => "Mainnet",
            Network::Testnet => "Testnet",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_and_borsh_shapes() {
        assert_eq!(
            serde_json::to_string(&Network::Mainnet).unwrap(),
            "\"Mainnet\""
        );
        assert_eq!(
            serde_json::from_str::<Network>("\"Testnet\"").unwrap(),
            Network::Testnet
        );
        assert!(serde_json::from_str::<Network>("\"testnet\"").is_err());
        assert_eq!(borsh::to_vec(&Network::Mainnet).unwrap(), [0]);
        assert_eq!(borsh::to_vec(&Network::Testnet).unwrap(), [1]);
    }

    #[test]
    fn ids_per_network() {
        assert_eq!(Network::Mainnet.arbitrum_chain_id(), 42161);
        assert_eq!(Network::Testnet.arbitrum_chain_id(), 421614);
        assert_eq!(
            (Network::Mainnet.hl_source(), Network::Testnet.hl_source()),
            ("a", "b")
        );
        assert_eq!(
            (Network::Mainnet.hl_chain(), Network::Testnet.hl_chain()),
            ("Mainnet", "Testnet")
        );
        // 1Click's USDC on NEAR is the mainnet token.
        assert_eq!(
            crate::oneclick::NEAR_USDC,
            format!("nep141:{}", Network::Mainnet.near_usdc())
        );
        assert_ne!(Network::Testnet.near_usdc(), Network::Mainnet.near_usdc());
    }
}
