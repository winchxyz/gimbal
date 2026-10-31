//! The oracle prices the contract stores (docs/interfaces.md §1.2, "Order size cap"): which policy
//! symbols have one, the OutLayer oracle asset each comes from, and how an oracle price becomes a
//! price in units of 1e-8 USD.
//!
//! The OutLayer oracle (`price-oracle.near`) lists 18 assets; five of them are the bases Gimbal
//! trades, keyed here by the policy's symbol (`ETH`, also the base of `PERP_ETH_USDC`). Any other
//! symbol has no stored price and enters a policy only through `policy.unpriced`.

use crate::errors::{shown, Refusal, E_ARGS, E_ASSET};

/// Policy symbol → oracle asset id, sorted by symbol (the order `prices()` returns).
pub const ORACLE_ASSETS: [(&str, &str); 5] = [
    ("BTC", "nbtc.bridge.near"),
    ("DOGE", "doge.omft.near"),
    ("ETH", "eth.bridge.near"),
    ("LTC", "ltc.omft.near"),
    ("SOL", "22.contract.portalbridge.near"),
];

/// The decimals of every price the OutLayer oracle fetches on demand: `multiplier` is USD per whole
/// token × 1e8. Reports pushed in the older Burrow form carry the token's own decimals on top
/// (`decimals` = token decimals + 4), which would read as a different number; such a price is not
/// stored, so the symbol stays without a price (`E_ORACLE_STALE`) rather than mispriced.
pub const ORACLE_PRICE_DECIMALS: u8 = 8;

/// The oracle asset id of a policy symbol.
pub fn asset_of(symbol: &str) -> Option<&'static str> {
    ORACLE_ASSETS
        .iter()
        .find(|(s, _)| *s == symbol)
        .map(|(_, a)| *a)
}

/// The row of a policy symbol in [`ORACLE_ASSETS`].
pub fn index_of(symbol: &str) -> Option<usize> {
    ORACLE_ASSETS.iter().position(|(s, _)| *s == symbol)
}

/// The policy symbol of an oracle asset id.
pub fn symbol_of(asset_id: &str) -> Option<&'static str> {
    ORACLE_ASSETS
        .iter()
        .find(|(_, a)| *a == asset_id)
        .map(|(s, _)| *s)
}

/// The symbols a `refresh_prices` or `set_mock_price` may name: one to five of the table's, each
/// once (`E_ARGS`), none outside it (`E_ASSET`). Returns their oracle asset ids, in the given order.
pub fn check_symbols(symbols: &[String]) -> Result<Vec<&'static str>, Refusal> {
    if symbols.is_empty() || symbols.len() > ORACLE_ASSETS.len() {
        return Err(Refusal::new(
            E_ARGS,
            format!(
                "{} symbols; name 1 to {} of {}",
                symbols.len(),
                ORACLE_ASSETS.len(),
                table()
            ),
        ));
    }
    let mut ids = Vec::with_capacity(symbols.len());
    for (i, symbol) in symbols.iter().enumerate() {
        let id = asset_of(symbol).ok_or_else(|| {
            Refusal::new(
                E_ASSET,
                format!(
                    "{} has no oracle price; the stored prices are {} (other symbols trade only \
                     through policy.unpriced)",
                    shown(symbol),
                    table()
                ),
            )
        })?;
        if symbols[..i].contains(symbol) {
            return Err(Refusal::new(
                E_ARGS,
                format!("{} is named twice", shown(symbol)),
            ));
        }
        ids.push(id);
    }
    Ok(ids)
}

fn table() -> String {
    ORACLE_ASSETS
        .iter()
        .map(|(s, _)| *s)
        .collect::<Vec<_>>()
        .join(", ")
}

/// An oracle price `{multiplier, decimals}` in units of 1e-8 USD, if it is one the contract
/// stores: decimals exactly [`ORACLE_PRICE_DECIMALS`], above zero, at most `u64::MAX`.
pub fn price_e8(multiplier: u128, decimals: u8) -> Option<u64> {
    if decimals != ORACLE_PRICE_DECIMALS || multiplier == 0 {
        return None;
    }
    u64::try_from(multiplier).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_sorted_and_two_way() {
        let symbols: Vec<&str> = ORACLE_ASSETS.iter().map(|(s, _)| *s).collect();
        let mut sorted = symbols.clone();
        sorted.sort_unstable();
        assert_eq!(symbols, sorted);
        for (i, (symbol, id)) in ORACLE_ASSETS.into_iter().enumerate() {
            assert_eq!(asset_of(symbol), Some(id));
            assert_eq!(symbol_of(id), Some(symbol));
            assert_eq!(index_of(symbol), Some(i));
        }
        assert_eq!(asset_of("HYPE"), None);
        assert_eq!(symbol_of("wrap.near"), None);
        assert_eq!(index_of("HYPE"), None);
    }

    #[test]
    fn symbols_to_refresh() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            check_symbols(&s(&["ETH", "SOL"])).unwrap(),
            ["eth.bridge.near", "22.contract.portalbridge.near"]
        );
        assert_eq!(check_symbols(&s(&[])).unwrap_err().code, E_ARGS);
        assert_eq!(check_symbols(&s(&["ETH", "ETH"])).unwrap_err().code, E_ARGS);
        let r = check_symbols(&s(&["ETH", "HYPE"])).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_ASSET: \"HYPE\" has no oracle price; the stored prices are BTC, DOGE, ETH, LTC, SOL \
             (other symbols trade only through policy.unpriced)"
        );
        assert_eq!(
            check_symbols(&s(&["BTC", "DOGE", "ETH", "LTC", "SOL", "BTC"]))
                .unwrap_err()
                .code,
            E_ARGS
        );
    }

    /// The mainnet answers of 2026-10-22 (decimals 8), and what is not stored.
    #[test]
    fn oracle_prices_in_e8() {
        assert_eq!(price_e8(237_978_000_000, 8), Some(237_978_000_000));
        assert_eq!(price_e8(7_837_166, 8), Some(7_837_166));
        // A Burrow-form report (eth.bridge.near: 18 + 4 decimals) is not read as USD.
        assert_eq!(price_e8(23_797_800, 22), None);
        assert_eq!(price_e8(0, 8), None);
        assert_eq!(price_e8(u128::from(u64::MAX) + 1, 8), None);
    }
}
