//! The network the contract runs on (docs/interfaces.md §1.1), fixed in `new`. Only ids differ between
//! testnet and mainnet; every builder takes the network and picks them here.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// Arbitrum chain ids Orderly runs on.
pub const ARBITRUM_MAINNET: u64 = 42161;
pub const ARBITRUM_SEPOLIA: u64 = 421614;

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
    }
}
