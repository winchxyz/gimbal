//! The owner's policy for one desk (docs/interfaces.md §1.2). The contract checks every order and
//! transfer against it before it asks the MPC network for a signature.
//!
//! The JSON shape is `ContractPolicy` in `shared/src/types.ts`: the same snake_case fields, passed as
//! is to `set_policy`. Unknown fields are refused, so a misspelt limit can never be silently dropped.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::errors::{shown, Refusal, E_ARGS};
use crate::ids::decode_base58_32;

/// Most entries in one list of a policy. A desk trades a handful of markets; the cap bounds the
/// storage a policy takes (and the deposit a larger one needs).
pub const MAX_LIST_LEN: usize = 32;
/// Largest integer JavaScript reads exactly (2^53 − 1): every u64 in a policy stays at or below it,
/// so the engine and the web see the number the contract enforces.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// Longest symbol, in bytes.
pub const MAX_SYMBOL_LEN: usize = 32;
/// Hyperliquid allows `6 − szDecimals` price decimals on perps, so `szDecimals` is at most 6.
pub const HL_MAX_SZ_DECIMALS: u8 = 6;
/// The band is a share of the oracle price: 10 000 bps is 100 %.
pub const MAX_PRICE_BAND_BPS: u32 = 10_000;
/// An oracle price older than an hour cannot bound an order price; a larger value is most likely
/// milliseconds typed as seconds.
pub const MAX_ORACLE_AGE_S: u32 = 3_600;
/// A transfer cannot be allowed to cost more than all of it.
pub const MAX_TRANSFER_COST_BPS: u32 = 10_000;

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
    /// Their own cap per leg; an unpriced order must fit [`Policy::unpriced_cap_usd`].
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

impl Policy {
    /// The notional cap per leg of an order for an `unpriced` symbol: both caps apply.
    pub fn unpriced_cap_usd(&self) -> u64 {
        self.max_notional_usd.min(self.unpriced_max_notional_usd)
    }

    /// Checks the fields on their own, before the policy is stored (`create_desk`, `set_policy`):
    /// limits that make no sense, malformed symbols and addresses, duplicates, integers JavaScript
    /// cannot read exactly. Every refusal is `E_ARGS` and names the field, e.g.
    /// `policy.hl_assets[1].sz_decimals`. Whether a symbol has an oracle price is chain state,
    /// checked per order (`E_ORACLE_STALE`, `E_ASSET`).
    pub fn validate(&self) -> Result<(), Refusal> {
        list_len("hl_assets", self.hl_assets.len())?;
        for (i, asset) in self.hl_assets.iter().enumerate() {
            symbol(&format!("hl_assets[{i}].symbol"), &asset.symbol)?;
            if asset.sz_decimals > HL_MAX_SZ_DECIMALS {
                return refuse(format!(
                    "hl_assets[{i}].sz_decimals {} is over {HL_MAX_SZ_DECIMALS}",
                    asset.sz_decimals
                ));
            }
            let earlier = &self.hl_assets[..i];
            if earlier.iter().any(|a| a.index == asset.index) {
                return refuse(format!(
                    "hl_assets[{i}].index {} is listed twice",
                    asset.index
                ));
            }
            if earlier.iter().any(|a| a.symbol == asset.symbol) {
                return refuse(format!(
                    "hl_assets[{i}].symbol {} is listed twice",
                    shown(&asset.symbol)
                ));
            }
        }

        list_len("phoenix_markets", self.phoenix_markets.len())?;
        for (i, market) in self.phoenix_markets.iter().enumerate() {
            symbol(&format!("phoenix_markets[{i}].symbol"), &market.symbol)?;
            if decode_base58_32(&market.orderbook).is_none() {
                return refuse(format!(
                    "phoenix_markets[{i}].orderbook {} is not a base58 address of 32 bytes",
                    shown(&market.orderbook)
                ));
            }
            if market.base_lot_e8 == 0 || market.tick_e8 == 0 {
                return refuse(format!(
                    "phoenix_markets[{i}] has a zero base_lot_e8 or tick_e8"
                ));
            }
            safe_integer(
                &format!("phoenix_markets[{i}].base_lot_e8"),
                market.base_lot_e8,
            )?;
            safe_integer(&format!("phoenix_markets[{i}].tick_e8"), market.tick_e8)?;
            let earlier = &self.phoenix_markets[..i];
            if earlier.iter().any(|m| m.symbol == market.symbol) {
                return refuse(format!(
                    "phoenix_markets[{i}].symbol {} is listed twice",
                    shown(&market.symbol)
                ));
            }
            if earlier.iter().any(|m| m.orderbook == market.orderbook) {
                return refuse(format!(
                    "phoenix_markets[{i}].orderbook {} is listed twice",
                    shown(&market.orderbook)
                ));
            }
        }

        list_len("orderly_symbols", self.orderly_symbols.len())?;
        for (i, s) in self.orderly_symbols.iter().enumerate() {
            if !is_orderly_perp(s) {
                return refuse(format!(
                    "orderly_symbols[{i}] {} is not PERP_<BASE>_USDC with BASE of A-Z and 0-9",
                    shown(s)
                ));
            }
            if self.orderly_symbols[..i].contains(s) {
                return refuse(format!("orderly_symbols[{i}] {} is listed twice", shown(s)));
            }
        }

        list_len("unpriced", self.unpriced.len())?;
        for (i, s) in self.unpriced.iter().enumerate() {
            symbol(&format!("unpriced[{i}]"), s)?;
            if self.unpriced[..i].contains(s) {
                return refuse(format!("unpriced[{i}] {} is listed twice", shown(s)));
            }
        }

        if !(1..=MAX_PRICE_BAND_BPS).contains(&self.price_band_bps) {
            return refuse(format!(
                "price_band_bps {} is not 1 to {MAX_PRICE_BAND_BPS}",
                self.price_band_bps
            ));
        }
        if !(1..=MAX_ORACLE_AGE_S).contains(&self.oracle_max_age_s) {
            return refuse(format!(
                "oracle_max_age_s {} is not 1 to {MAX_ORACLE_AGE_S}",
                self.oracle_max_age_s
            ));
        }
        if self.max_transfer_cost_bps > MAX_TRANSFER_COST_BPS {
            return refuse(format!(
                "max_transfer_cost_bps {} is over {MAX_TRANSFER_COST_BPS}",
                self.max_transfer_cost_bps
            ));
        }
        for (field, value) in [
            ("max_notional_usd", self.max_notional_usd),
            ("rescue_cap_usd_per_hour", self.rescue_cap_usd_per_hour),
            ("max_transfer_cost_flat_e6", self.max_transfer_cost_flat_e6),
            ("unpriced_max_notional_usd", self.unpriced_max_notional_usd),
        ] {
            safe_integer(field, value)?;
        }
        // Notional caps and the rescue cap may be zero: that refuses every order or rescue, which is
        // the owner's call. The two notional caps are not compared: an unpriced order has to fit
        // both (`unpriced_cap_usd`), and the defaults (100 against the canary's 20) differ that way.
        Ok(())
    }
}

fn refuse(msg: String) -> Result<(), Refusal> {
    Err(Refusal::new(E_ARGS, format!("policy.{msg}")))
}

fn safe_integer(field: &str, value: u64) -> Result<(), Refusal> {
    if value > MAX_SAFE_INTEGER {
        return refuse(format!(
            "{field} {value} is over 2^53 - 1, the largest integer JavaScript reads exactly"
        ));
    }
    Ok(())
}

fn list_len(field: &str, len: usize) -> Result<(), Refusal> {
    if len > MAX_LIST_LEN {
        return refuse(format!("{field} has {len} entries, over {MAX_LIST_LEN}"));
    }
    Ok(())
}

/// 1 to [`MAX_SYMBOL_LEN`] printable ASCII characters without spaces. Venues spell symbols
/// differently (`kPEPE`, `xyz:TSLA`), so only what can never be a symbol is refused.
fn symbol(field: &str, s: &str) -> Result<(), Refusal> {
    let ok = !s.is_empty() && s.len() <= MAX_SYMBOL_LEN && s.bytes().all(|b| b.is_ascii_graphic());
    if ok {
        Ok(())
    } else {
        refuse(format!(
            "{field} {} is not 1 to {MAX_SYMBOL_LEN} printable ASCII characters without spaces",
            shown(s)
        ))
    }
}

/// Orderly perps are all `PERP_<BASE>_USDC`, e.g. `PERP_SOL_USDC`, `PERP_1000PEPE_USDC`.
fn is_orderly_perp(s: &str) -> bool {
    s.len() <= MAX_SYMBOL_LEN
        && s.strip_prefix("PERP_")
            .and_then(|rest| rest.strip_suffix("_USDC"))
            .is_some_and(|base| {
                !base.is_empty()
                    && base
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            })
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

    /// The refusal of a policy changed by `edit`: always `E_ARGS`, message starting `policy.`.
    fn refused(edit: impl FnOnce(&mut Policy)) -> String {
        let mut p = sample();
        edit(&mut p);
        let r = p.validate().expect_err("should be refused");
        assert_eq!(r.code, E_ARGS, "{r}");
        assert!(r.msg.starts_with("policy."), "{r}");
        r.msg
    }

    fn accepted(edit: impl FnOnce(&mut Policy)) {
        let mut p = sample();
        edit(&mut p);
        p.validate().unwrap_or_else(|r| panic!("refused: {r}"));
    }

    fn hl(index: u32, symbol: &str) -> HlAsset {
        HlAsset {
            index,
            symbol: symbol.into(),
            sz_decimals: 2,
        }
    }

    fn phoenix(symbol: &str, orderbook: &str) -> PhoenixMarket {
        PhoenixMarket {
            symbol: symbol.into(),
            orderbook: orderbook.into(),
            base_lot_e8: 1_000_000,
            tick_e8: 1_000,
        }
    }

    #[test]
    fn the_sample_and_an_empty_policy_are_valid() {
        sample().validate().unwrap();
        accepted(|p| {
            p.hl_assets.clear();
            p.phoenix_markets.clear();
            p.orderly_symbols.clear();
            p.unpriced.clear();
        });
    }

    #[test]
    fn zero_caps_are_the_owners_call() {
        accepted(|p| {
            p.max_notional_usd = 0;
            p.rescue_cap_usd_per_hour = 0;
            p.unpriced_max_notional_usd = 0;
            p.max_transfer_cost_bps = 0;
            p.max_transfer_cost_flat_e6 = 0;
        });
        // The interface defaults: an unpriced cap of 100 next to the canary's 20.
        accepted(|p| {
            p.max_notional_usd = 20;
            p.unpriced_max_notional_usd = 100;
        });
    }

    #[test]
    fn an_unpriced_order_fits_both_caps() {
        let mut p = sample();
        p.max_notional_usd = 20;
        p.unpriced_max_notional_usd = 100;
        assert_eq!(p.unpriced_cap_usd(), 20);
        p.max_notional_usd = 500;
        assert_eq!(p.unpriced_cap_usd(), 100);
    }

    #[test]
    fn every_u64_is_one_javascript_reads_exactly() {
        accepted(|p| {
            p.max_notional_usd = MAX_SAFE_INTEGER;
            p.rescue_cap_usd_per_hour = MAX_SAFE_INTEGER;
            p.max_transfer_cost_flat_e6 = MAX_SAFE_INTEGER;
            p.unpriced_max_notional_usd = MAX_SAFE_INTEGER;
            p.phoenix_markets[0].base_lot_e8 = MAX_SAFE_INTEGER;
            p.phoenix_markets[0].tick_e8 = MAX_SAFE_INTEGER;
        });
        let over = MAX_SAFE_INTEGER + 1;
        let msg = refused(|p| p.max_notional_usd = over);
        assert_eq!(
            msg,
            "policy.max_notional_usd 9007199254740992 is over 2^53 - 1, the largest integer JavaScript reads exactly"
        );
        let msg = refused(|p| p.rescue_cap_usd_per_hour = over);
        assert!(msg.starts_with("policy.rescue_cap_usd_per_hour "), "{msg}");
        let msg = refused(|p| p.max_transfer_cost_flat_e6 = over);
        assert!(
            msg.starts_with("policy.max_transfer_cost_flat_e6 "),
            "{msg}"
        );
        let msg = refused(|p| p.unpriced_max_notional_usd = over);
        assert!(
            msg.starts_with("policy.unpriced_max_notional_usd "),
            "{msg}"
        );
        let msg = refused(|p| p.phoenix_markets[0].base_lot_e8 = over);
        assert!(
            msg.starts_with("policy.phoenix_markets[0].base_lot_e8 "),
            "{msg}"
        );
        let msg = refused(|p| p.phoenix_markets[0].tick_e8 = over);
        assert!(
            msg.starts_with("policy.phoenix_markets[0].tick_e8 "),
            "{msg}"
        );
    }

    #[test]
    fn lists_are_capped() {
        accepted(|p| {
            p.hl_assets = (0..MAX_LIST_LEN as u32)
                .map(|i| hl(i, &format!("A{i}")))
                .collect()
        });
        let n = MAX_LIST_LEN as u32 + 1;
        let msg = refused(|p| p.hl_assets = (0..n).map(|i| hl(i, &format!("A{i}"))).collect());
        assert!(msg.contains("hl_assets has 33 entries"), "{msg}");
        refused(|p| p.orderly_symbols = (0..n).map(|i| format!("PERP_A{i}_USDC")).collect());
        refused(|p| p.unpriced = (0..n).map(|i| format!("U{i}")).collect());
        refused(|p| {
            p.phoenix_markets = (0..n)
                .map(|i| {
                    let mut key = [1u8; 32];
                    key[0] = i as u8;
                    phoenix(&format!("M{i}"), &bs58::encode(key).into_string())
                })
                .collect()
        });
    }

    #[test]
    fn symbols_are_printable_ascii() {
        accepted(|p| p.hl_assets = vec![hl(1, "kPEPE"), hl(2, "xyz:TSLA")]);
        let long = "A".repeat(MAX_SYMBOL_LEN + 1);
        for bad in ["", "E TH", "ETH\n", "\u{c9}TH", long.as_str()] {
            let msg = refused(|p| p.hl_assets[0].symbol = bad.into());
            assert!(msg.starts_with("policy.hl_assets[0].symbol "), "{msg}");
            refused(|p| p.phoenix_markets[0].symbol = bad.into());
            refused(|p| p.unpriced[0] = bad.into());
        }
    }

    /// The largest policy `validate` accepts stays under 8 KiB in storage, so the deposit a
    /// `set_policy` can need is bounded (0.08 NEAR at 1e19 yocto per byte).
    #[test]
    fn the_largest_valid_policy_is_under_8_kib() {
        let n = MAX_LIST_LEN as u32;
        let sym = |i: u32| format!("{i:0>width$}", width = MAX_SYMBOL_LEN);
        let p = Policy {
            hl_assets: (0..n)
                .map(|i| HlAsset {
                    index: i,
                    symbol: sym(i),
                    sz_decimals: 0,
                })
                .collect(),
            phoenix_markets: (0..n)
                .map(|i| {
                    let mut key = [0xffu8; 32];
                    key[31] = i as u8;
                    PhoenixMarket {
                        symbol: sym(i),
                        orderbook: bs58::encode(key).into_string(),
                        base_lot_e8: MAX_SAFE_INTEGER,
                        tick_e8: MAX_SAFE_INTEGER,
                    }
                })
                .collect(),
            orderly_symbols: (0..n)
                .map(|i| format!("PERP_{i:0>width$}_USDC", width = MAX_SYMBOL_LEN - 10))
                .collect(),
            unpriced: (0..n).map(sym).collect(),
            ..sample()
        };
        p.validate().unwrap();
        let bytes = borsh::to_vec(&p).unwrap().len();
        assert!(bytes < 8 * 1024, "{bytes} bytes");
    }

    #[test]
    fn hl_assets_are_unique_with_valid_sz_decimals() {
        accepted(|p| p.hl_assets[0].sz_decimals = HL_MAX_SZ_DECIMALS);
        let msg = refused(|p| p.hl_assets[0].sz_decimals = HL_MAX_SZ_DECIMALS + 1);
        assert!(msg.contains("sz_decimals 7 is over 6"), "{msg}");
        let msg = refused(|p| p.hl_assets.push(hl(4, "BTC")));
        assert!(
            msg.contains("hl_assets[1].index 4 is listed twice"),
            "{msg}"
        );
        let msg = refused(|p| p.hl_assets.push(hl(0, "ETH")));
        assert!(msg.contains("hl_assets[1].symbol"), "{msg}");
    }

    #[test]
    fn phoenix_markets_need_a_32_byte_orderbook_and_non_zero_lots() {
        let msg = refused(|p| p.phoenix_markets[0].orderbook = "0x00".into());
        assert!(msg.contains("phoenix_markets[0].orderbook"), "{msg}");
        refused(|p| p.phoenix_markets[0].orderbook = bs58::encode([9u8; 31]).into_string());
        refused(|p| p.phoenix_markets[0].base_lot_e8 = 0);
        refused(|p| p.phoenix_markets[0].tick_e8 = 0);
        let other = bs58::encode([9u8; 32]).into_string();
        let msg = refused(|p| p.phoenix_markets.push(phoenix("SOL", &other)));
        assert!(msg.contains("phoenix_markets[1].symbol"), "{msg}");
        let msg = refused(|p| {
            p.phoenix_markets
                .push(phoenix("BTC", "11111111111111111111111111111111"))
        });
        assert!(msg.contains("phoenix_markets[1].orderbook"), "{msg}");
        accepted(|p| p.phoenix_markets.push(phoenix("BTC", &other)));
    }

    #[test]
    fn orderly_symbols_are_perp_usdc() {
        accepted(|p| {
            p.orderly_symbols = vec![
                "PERP_ETH_USDC".into(),
                "PERP_1000PEPE_USDC".into(),
                "PERP_SOL_USDC".into(),
            ]
        });
        for bad in [
            "",
            "ETH",
            "PERP__USDC",
            "PERP_eth_USDC",
            "PERP_ETH_USDT",
            "SPOT_ETH_USDC",
            "PERP_ETH-X_USDC",
            "PERP_ETH_USDC ",
            "PERP_ABCDEFGHIJKLMNOPQRSTUVWXYZ_USDC",
        ] {
            let msg = refused(|p| p.orderly_symbols[0] = bad.into());
            assert!(msg.starts_with("policy.orderly_symbols[0] "), "{msg}");
        }
        let msg = refused(|p| p.orderly_symbols.push("PERP_SOL_USDC".into()));
        assert!(msg.contains("listed twice"), "{msg}");
    }

    #[test]
    fn unpriced_symbols_are_unique() {
        let msg = refused(|p| p.unpriced.push("HYPE".into()));
        assert!(msg.contains("unpriced[1]"), "{msg}");
    }

    #[test]
    fn price_band_oracle_age_and_transfer_cost_are_bounded() {
        accepted(|p| p.price_band_bps = 1);
        accepted(|p| p.price_band_bps = MAX_PRICE_BAND_BPS);
        refused(|p| p.price_band_bps = 0);
        refused(|p| p.price_band_bps = MAX_PRICE_BAND_BPS + 1);
        accepted(|p| p.oracle_max_age_s = 1);
        accepted(|p| p.oracle_max_age_s = MAX_ORACLE_AGE_S);
        refused(|p| p.oracle_max_age_s = 0);
        let msg = refused(|p| p.oracle_max_age_s = 60_000);
        assert!(msg.contains("oracle_max_age_s 60000"), "{msg}");
        accepted(|p| p.max_transfer_cost_bps = MAX_TRANSFER_COST_BPS);
        refused(|p| p.max_transfer_cost_bps = MAX_TRANSFER_COST_BPS + 1);
    }
}
