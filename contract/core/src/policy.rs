//! The owner's policy for one desk (docs/interfaces.md §1.2). The contract checks every order and
//! transfer against it before it asks the MPC network for a signature.
//!
//! The JSON shape is `ContractPolicy` in `shared/src/types.ts`: the same snake_case fields, passed as
//! is to `set_policy`. Unknown fields are refused, so a misspelt limit can never be silently dropped.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::decimal::parse_e8;
use crate::errors::{shown, Refusal, E_ARGS};
use crate::ids::decode_base58_32;
use crate::network::Network;

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
/// The least `oracle_max_age_s` a mainnet desk takes: the oracle stamps its prices
/// `recency_duration_sec` (600 s on mainnet) before its read, so a smaller bound leaves a fresh
/// answer usable for under five minutes, or not at all. Testnet keeps 1 to [`MAX_ORACLE_AGE_S`]
/// for its Mock prices.
pub const MAINNET_MIN_ORACLE_AGE_S: u32 = 900;
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
    /// Symbols without an oracle price that the owner explicitly allowed (no price band), each
    /// with its size cap in base units.
    pub unpriced: Vec<UnpricedAsset>,
    /// Their own cap per leg; an unpriced order must fit [`Policy::unpriced_cap_usd`] at its own
    /// price.
    pub unpriced_max_notional_usd: u64,
}

/// A symbol without a trusted price that the owner allowed. Its orders skip the price band, so the
/// size is capped in base units: a notional cap at the caller's own limit price alone would let a
/// tiny price carry any size.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnpricedAsset {
    pub symbol: String,
    /// The largest order size in base units, a canonical decimal. The UI asks the owner for a cap
    /// in USD and converts it at the current price.
    pub max_sz: String,
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

    /// The `max_sz` of `symbol` in units of 1e-8, if the owner listed it in `unpriced`. A stored
    /// policy was validated, so its `max_sz` parses; one that does not counts as 0, which refuses
    /// every order.
    pub fn unpriced_max_sz_e8(&self, symbol: &str) -> Option<u128> {
        self.unpriced
            .iter()
            .find(|u| u.symbol == symbol)
            .map(|u| parse_e8(&u.max_sz).unwrap_or(0))
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
        for (i, asset) in self.unpriced.iter().enumerate() {
            symbol(&format!("unpriced[{i}].symbol"), &asset.symbol)?;
            if self.unpriced[..i].iter().any(|u| u.symbol == asset.symbol) {
                return refuse(format!(
                    "unpriced[{i}].symbol {} is listed twice",
                    shown(&asset.symbol)
                ));
            }
            let max_sz = parse_e8(&asset.max_sz).map_err(|r| {
                Refusal::new(E_ARGS, format!("policy.unpriced[{i}].max_sz {}", r.msg))
            })?;
            // Zero is allowed, like the other caps: it refuses every order of that symbol.
            if max_sz > u128::from(MAX_SAFE_INTEGER) * crate::decimal::UNIT {
                return refuse(format!(
                    "unpriced[{i}].max_sz {} is over 2^53 - 1 base units",
                    shown(&asset.max_sz)
                ));
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

    /// [`Policy::validate`] for a contract on `network`: on mainnet also `oracle_max_age_s` at
    /// least [`MAINNET_MIN_ORACLE_AGE_S`] (`E_ARGS`).
    pub fn validate_for(&self, network: Network) -> Result<(), Refusal> {
        self.validate()?;
        if network == Network::Mainnet && self.oracle_max_age_s < MAINNET_MIN_ORACLE_AGE_S {
            return refuse(format!(
                "oracle_max_age_s {} is under {MAINNET_MIN_ORACLE_AGE_S} on mainnet: the oracle's \
                 prices are already up to 600 s old when stored",
                self.oracle_max_age_s
            ));
        }
        Ok(())
    }

    /// The largest policy [`Policy::validate`] accepts: every list full and every string as long
    /// as it may be. It bounds the storage a desk takes and the gas `create_desk` needs, which
    /// tests on both sides measure with it.
    pub fn largest_valid() -> Policy {
        let n = MAX_LIST_LEN as u32;
        let sym = |i: u32| format!("{i:0>width$}", width = MAX_SYMBOL_LEN);
        Policy {
            hl_assets: (0..n)
                .map(|i| HlAsset {
                    index: u32::MAX - i,
                    symbol: sym(i),
                    sz_decimals: HL_MAX_SZ_DECIMALS,
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
            max_notional_usd: MAX_SAFE_INTEGER,
            price_band_bps: MAX_PRICE_BAND_BPS,
            oracle_max_age_s: MAX_ORACLE_AGE_S,
            rescue_cap_usd_per_hour: MAX_SAFE_INTEGER,
            max_transfer_cost_bps: MAX_TRANSFER_COST_BPS,
            max_transfer_cost_flat_e6: MAX_SAFE_INTEGER,
            unpriced: (0..n)
                .map(|i| UnpricedAsset {
                    symbol: sym(i),
                    // 2^53 - 1 less 1e-8: the longest max_sz under the cap.
                    max_sz: "9007199254740990.99999999".into(),
                })
                .collect(),
            unpriced_max_notional_usd: MAX_SAFE_INTEGER,
        }
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
pub fn is_orderly_perp(s: &str) -> bool {
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
        "unpriced": [{ "symbol": "HYPE", "max_sz": "2.5" }],
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
            unpriced: vec![unpriced("HYPE", "2.5")],
            unpriced_max_notional_usd: 100,
        }
    }

    fn unpriced(symbol: &str, max_sz: &str) -> UnpricedAsset {
        UnpricedAsset {
            symbol: symbol.into(),
            max_sz: max_sz.into(),
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
        let json = SHARED_JSON.replace(
            "\"unpriced\": [{ \"symbol\": \"HYPE\", \"max_sz\": \"2.5\" }],",
            "",
        );
        assert_ne!(json, SHARED_JSON);
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
        refused(|p| p.unpriced = (0..n).map(|i| unpriced(&format!("U{i}"), "1")).collect());
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
            let msg = refused(|p| p.unpriced[0].symbol = bad.into());
            assert!(msg.starts_with("policy.unpriced[0].symbol "), "{msg}");
        }
    }

    /// The largest policy `validate` accepts stays under 8 KiB in storage, so the deposit a
    /// `set_policy` can need is bounded (0.08 NEAR at 1e19 yocto per byte).
    #[test]
    fn the_largest_valid_policy_is_under_8_kib() {
        let p = Policy::largest_valid();
        p.validate().unwrap();
        let bytes = borsh::to_vec(&p).unwrap().len();
        assert!(bytes < 8 * 1024, "{bytes} bytes");
        // Every list is full and every string as long as it may be.
        assert_eq!(p.unpriced.len(), MAX_LIST_LEN);
        let longer = format!("{}9", p.unpriced[0].max_sz);
        let mut q = Policy::largest_valid();
        q.unpriced[0].max_sz = longer;
        assert_eq!(q.validate().unwrap_err().code, E_ARGS);
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
        let msg = refused(|p| p.unpriced.push(unpriced("HYPE", "1")));
        assert_eq!(msg, "policy.unpriced[1].symbol \"HYPE\" is listed twice");
        accepted(|p| p.unpriced.push(unpriced("kPEPE", "1000000")));
    }

    #[test]
    fn unpriced_max_sz_is_a_canonical_decimal_up_to_2_pow_53() {
        accepted(|p| p.unpriced[0].max_sz = "0".into());
        accepted(|p| p.unpriced[0].max_sz = "0.00000001".into());
        accepted(|p| p.unpriced[0].max_sz = "9007199254740991".into());
        for bad in ["", "2.50", "-1", "1e3", "02.5", "0.000000001"] {
            let msg = refused(|p| p.unpriced[0].max_sz = bad.into());
            assert!(msg.starts_with("policy.unpriced[0].max_sz "), "{msg}");
        }
        let msg = refused(|p| p.unpriced[0].max_sz = "9007199254740991.00000001".into());
        assert_eq!(
            msg,
            "policy.unpriced[0].max_sz \"9007199254740991.00000001\" is over 2^53 - 1 base units"
        );
    }

    #[test]
    fn the_unpriced_size_cap_is_found_by_symbol() {
        let p = sample();
        assert_eq!(p.unpriced_max_sz_e8("HYPE"), Some(250_000_000));
        assert_eq!(p.unpriced_max_sz_e8("ETH"), None);
        let mut q = sample();
        q.unpriced[0].max_sz = "not a number".into();
        assert_eq!(q.unpriced_max_sz_e8("HYPE"), Some(0));
    }

    #[test]
    fn an_unpriced_entry_needs_both_fields() {
        let json = SHARED_JSON.replace(", \"max_sz\": \"2.5\"", "");
        assert_ne!(json, SHARED_JSON);
        assert!(serde_json::from_str::<Policy>(&json).is_err());
        let json = SHARED_JSON.replace("\"max_sz\": \"2.5\"", "\"max_sz\": 2.5");
        assert!(serde_json::from_str::<Policy>(&json).is_err());
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

    /// A mainnet desk takes `oracle_max_age_s` from 900 (the oracle's prices are 600 s old when
    /// stored); testnet keeps 1 to 3600; every other rule holds on both.
    #[test]
    fn a_mainnet_policy_takes_an_oracle_age_of_900_s_at_least() {
        let with_age = |s: u32| Policy {
            oracle_max_age_s: s,
            ..sample()
        };
        for s in [MAINNET_MIN_ORACLE_AGE_S, MAX_ORACLE_AGE_S] {
            with_age(s).validate_for(Network::Mainnet).unwrap();
        }
        for s in [1, 60, MAINNET_MIN_ORACLE_AGE_S - 1] {
            let r = with_age(s).validate_for(Network::Mainnet).unwrap_err();
            assert_eq!(r.code, E_ARGS);
            assert_eq!(
                r.msg,
                format!(
                    "policy.oracle_max_age_s {s} is under 900 on mainnet: the oracle's prices are \
                     already up to 600 s old when stored"
                )
            );
            with_age(s).validate_for(Network::Testnet).unwrap();
        }
        for network in [Network::Mainnet, Network::Testnet] {
            for s in [0, MAX_ORACLE_AGE_S + 1] {
                let r = with_age(s).validate_for(network).unwrap_err();
                assert!(r.msg.contains("is not 1 to 3600"), "{}", r.msg);
            }
            let r = Policy {
                price_band_bps: 0,
                ..with_age(MAINNET_MIN_ORACLE_AGE_S)
            }
            .validate_for(network)
            .unwrap_err();
            assert!(r.msg.contains("price_band_bps"), "{}", r.msg);
        }
    }
}
