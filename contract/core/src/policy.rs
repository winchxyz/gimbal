//! The owner's policy for one desk (docs/interfaces.md §1.2). The contract checks every order and
//! transfer against it before it asks the MPC network for a signature.
//!
//! The JSON shape is `ContractPolicy` in `shared/src/types.ts`: the same snake_case fields, passed as
//! is to `set_policy`. Unknown fields are refused, so a misspelt limit can never be silently dropped.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub hl_assets: Vec<HlAsset>,
    pub phoenix_markets: Vec<PhoenixMarket>,
    /// Orderly symbols, e.g. `PERP_SOL_USDC`.
    pub orderly_symbols: Vec<String>,
    /// Per leg, whole USD.
    pub max_notional_usd: u64,
    /// Order price against the oracle price.
    pub price_band_bps: u32,
    pub oracle_max_age_s: u32,
    pub rescue_cap_usd_per_hour: u64,
    /// 1Click: `minAmountOut ≥ amountIn − max(bps share, flat)`.
    pub max_transfer_cost_bps: u32,
    /// USDC × 1e6.
    pub max_transfer_cost_flat_e6: u64,
    /// Symbols without an oracle price that the owner explicitly allowed (no price band).
    pub unpriced: Vec<String>,
    /// Their own, smaller cap per leg.
    pub unpriced_max_notional_usd: u64,
}

/// A Hyperliquid perp the desk may trade.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HlAsset {
    /// Hyperliquid's asset index (differs between mainnet and testnet).
    pub index: u32,
    pub symbol: String,
    pub sz_decimals: u8,
}

/// A Phoenix market the desk may trade.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhoenixMarket {
    pub symbol: String,
    /// The market's orderbook account, base58.
    pub orderbook: String,
    /// Base units per lot × 1e8.
    pub base_lot_e8: u64,
    /// USD per tick × 1e8.
    pub tick_e8: u64,
}

/// Checks of orders and transfers against a [`Policy`]. Each returns the refusal of interfaces §1.5
/// (`E_ASSET`, `E_SIZE`, `E_PRICE_BAND`, `E_ORACLE_STALE`, `E_RESCUE_CAP`, …). They arrive with the
/// methods that need them, starting with Hyperliquid orders; this module only fixes where they live.
pub mod check {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JSON a `ContractPolicy` from `shared/` serialises to.
    const SHARED_JSON: &str = r#"{
        "hl_assets": [{ "index": 4, "symbol": "ETH", "sz_decimals": 4 }],
        "phoenix_markets": [{
            "symbol": "SOL",
            "orderbook": "11111111111111111111111111111111",
            "base_lot_e8": 1000000,
            "tick_e8": 1000
        }],
        "orderly_symbols": ["PERP_SOL_USDC"],
        "max_notional_usd": 20,
        "price_band_bps": 100,
        "oracle_max_age_s": 60,
        "rescue_cap_usd_per_hour": 50,
        "max_transfer_cost_bps": 100,
        "max_transfer_cost_flat_e6": 500000,
        "unpriced": ["HYPE"],
        "unpriced_max_notional_usd": 100
    }"#;

    fn sample() -> Policy {
        Policy {
            hl_assets: vec![HlAsset {
                index: 4,
                symbol: "ETH".into(),
                sz_decimals: 4,
            }],
            phoenix_markets: vec![PhoenixMarket {
                symbol: "SOL".into(),
                orderbook: "11111111111111111111111111111111".into(),
                base_lot_e8: 1_000_000,
                tick_e8: 1_000,
            }],
            orderly_symbols: vec!["PERP_SOL_USDC".into()],
            max_notional_usd: 20,
            price_band_bps: 100,
            oracle_max_age_s: 60,
            rescue_cap_usd_per_hour: 50,
            max_transfer_cost_bps: 100,
            max_transfer_cost_flat_e6: 500_000,
            unpriced: vec!["HYPE".into()],
            unpriced_max_notional_usd: 100,
        }
    }

    #[test]
    fn reads_the_shared_json_shape() {
        let p: Policy = serde_json::from_str(SHARED_JSON).unwrap();
        assert_eq!(p, sample());
    }

    #[test]
    fn json_round_trips() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert_eq!(serde_json::from_str::<Policy>(&json).unwrap(), sample());
    }

    #[test]
    fn borsh_round_trips() {
        let bytes = borsh::to_vec(&sample()).unwrap();
        assert_eq!(borsh::from_slice::<Policy>(&bytes).unwrap(), sample());
    }

    #[test]
    fn unknown_field_is_refused() {
        let json = SHARED_JSON.replace("\"price_band_bps\"", "\"price_band_bp\"");
        assert!(serde_json::from_str::<Policy>(&json).is_err());
        let json = SHARED_JSON.replace("\"sz_decimals\": 4", "\"sz_decimals\": 4, \"lev\": 3");
        assert!(serde_json::from_str::<Policy>(&json).is_err());
    }

    #[test]
    fn missing_field_is_refused() {
        let json = SHARED_JSON.replace("\"unpriced\": [\"HYPE\"],", "");
        assert!(serde_json::from_str::<Policy>(&json).is_err());
    }
}
