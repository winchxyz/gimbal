//! What every order must fit once its venue's own encoding is checked (docs/interfaces.md §1.2,
//! "Order size cap" and "Unpriced assets"): the oracle price as reference, the price band around it
//! and the notional cap at the reference price. Hyperliquid and Phoenix orders both end here.
//!
//! The caller passes the reference price: the oracle price of the symbol if it is young enough
//! ([`fresh_price`]), or `None`, and then every priced order is refused with `E_ORACLE_STALE`.

use crate::decimal::format_e8;
use crate::errors::{Refusal, E_ORACLE_STALE, E_PRICE_BAND, E_SIZE};
use crate::policy::Policy;

/// Units in 1 USD of notional: price (1e-8) × size (1e-8).
const NOTIONAL_UNIT: u128 = 10u128.pow(16);

/// The stored oracle price `price_e8` taken at `at_ms`, if it is at most `max_age_s` old at
/// `now_ms`. The edge is allowed; a time stamp after `now_ms` counts as age 0.
pub fn fresh_price(price_e8: u128, at_ms: u64, now_ms: u64, max_age_s: u32) -> Option<u128> {
    let age_ms = now_ms.saturating_sub(at_ms);
    (age_ms <= u64::from(max_age_s) * 1000).then_some(price_e8)
}

/// How an order that fits the policy was valued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Valued {
    /// The oracle price it was checked against; `None` for a symbol in `policy.unpriced`.
    pub oracle_e8: Option<u128>,
}

impl Valued {
    /// Opened under `policy.unpriced`: no price band (the `signed` event's `unpriced: true`).
    pub const fn unpriced(&self) -> bool {
        self.oracle_e8.is_none()
    }
}

/// The checks of an order of `sz_e8` base units at limit price `px_e8` (both in 1e-8) for
/// `symbol`, in this order:
///
/// - a zero size is `E_SIZE`;
/// - a symbol in `policy.unpriced`: `sz ≤ max_sz`, then `sz × px` within
///   min(`max_notional_usd`, `unpriced_max_notional_usd`) (`E_SIZE`); no price band;
/// - any other symbol needs a reference price (`E_ORACLE_STALE`), the limit price within
///   `price_band_bps` of it, edges allowed (`E_PRICE_BAND`), and `sz × max(px, reference)` within
///   `max_notional_usd` (`E_SIZE`), buys and sells alike: a sell at a tiny limit price is valued at
///   the oracle price, so it cannot carry any size.
pub fn check_value(
    policy: &Policy,
    symbol: &str,
    px_e8: u128,
    sz_e8: u128,
    reference_e8: Option<u128>,
) -> Result<Valued, Refusal> {
    if sz_e8 == 0 {
        return Err(Refusal::new(E_SIZE, format!("{symbol} size is zero")));
    }
    if let Some(max_sz_e8) = policy.unpriced_max_sz_e8(symbol) {
        if sz_e8 > max_sz_e8 {
            return Err(Refusal::new(
                E_SIZE,
                format!(
                    "{symbol} size {} is over its max_sz {} (an unpriced symbol, capped in base units)",
                    format_e8(sz_e8),
                    format_e8(max_sz_e8)
                ),
            ));
        }
        check_notional(
            symbol,
            px_e8,
            None,
            sz_e8,
            policy.unpriced_cap_usd(),
            "the unpriced cap, min(max_notional_usd, unpriced_max_notional_usd)",
        )?;
        return Ok(Valued { oracle_e8: None });
    }
    let oracle_e8 = reference_e8.ok_or_else(|| {
        Refusal::new(
            E_ORACLE_STALE,
            format!(
                "no oracle price for {symbol} younger than {} s, and {symbol} is not in policy.unpriced",
                policy.oracle_max_age_s
            ),
        )
    })?;
    check_band(px_e8, oracle_e8, policy.price_band_bps)?;
    check_notional(
        symbol,
        px_e8,
        Some(oracle_e8),
        sz_e8,
        policy.max_notional_usd,
        "max_notional_usd",
    )?;
    Ok(Valued {
        oracle_e8: Some(oracle_e8),
    })
}

/// `|px − oracle| × 10 000 ≤ band_bps × oracle`, else `E_PRICE_BAND`.
pub fn check_band(px_e8: u128, oracle_e8: u128, band_bps: u32) -> Result<(), Refusal> {
    let diff = px_e8.abs_diff(oracle_e8);
    // Both sides fit u128: prices are below 2^128 / 1e4 in any market a policy can list, and an
    // overflow is far outside any band.
    let inside = match (
        diff.checked_mul(10_000),
        oracle_e8.checked_mul(u128::from(band_bps)),
    ) {
        (Some(lhs), Some(rhs)) => lhs <= rhs,
        (None, _) => false,
        (Some(_), None) => true,
    };
    if inside {
        return Ok(());
    }
    // The distance in % with 4 decimals, rounded up so it never reads as inside the band.
    let pct_e4 = if oracle_e8 == 0 {
        None
    } else {
        diff.checked_mul(1_000_000)
            .map(|d| d.div_ceil(oracle_e8))
            .and_then(|p| p.checked_mul(10_000))
    };
    let distance = pct_e4.map_or_else(|| "far".to_string(), |p| format!("{}%", format_e8(p)));
    Err(Refusal::new(
        E_PRICE_BAND,
        format!(
            "px {} is {distance} from oracle {}, outside price_band_bps {band_bps}",
            format_e8(px_e8),
            format_e8(oracle_e8)
        ),
    ))
}

/// `sz × max(px, oracle)` within `cap` whole USD, else `E_SIZE` naming the cap.
fn check_notional(
    symbol: &str,
    px_e8: u128,
    oracle_e8: Option<u128>,
    sz_e8: u128,
    cap: u64,
    cap_name: &str,
) -> Result<(), Refusal> {
    let value_px = oracle_e8.map_or(px_e8, |o| o.max(px_e8));
    // In units of 1e-16 USD; an overflow is far over any cap.
    let notional = value_px.checked_mul(sz_e8);
    if notional.is_some_and(|n| n <= u128::from(cap) * NOTIONAL_UNIT) {
        return Ok(());
    }
    let shown_notional = notional.map_or_else(
        || "more than 2^128 / 1e16".to_string(),
        |n| format_e8(n / 100_000_000),
    );
    let at = if value_px == px_e8 {
        format_e8(px_e8)
    } else {
        format!(
            "{} (the oracle price, above the limit {})",
            format_e8(value_px),
            format_e8(px_e8)
        )
    };
    Err(Refusal::new(
        E_SIZE,
        format!(
            "{symbol} {at} x {} = {shown_notional} USD is over {cap_name} {cap}",
            format_e8(sz_e8)
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decimal::parse_e8;
    use crate::policy::UnpricedAsset;

    fn policy() -> Policy {
        Policy {
            hl_assets: vec![],
            phoenix_markets: vec![],
            orderly_symbols: vec![],
            max_notional_usd: 1000,
            price_band_bps: 200,
            oracle_max_age_s: 300,
            rescue_cap_usd_per_hour: 0,
            max_transfer_cost_bps: 0,
            max_transfer_cost_flat_e6: 0,
            unpriced: vec![UnpricedAsset {
                symbol: "HYPE".into(),
                max_sz: "2.5".into(),
            }],
            unpriced_max_notional_usd: 100,
        }
    }

    fn e8(s: &str) -> u128 {
        parse_e8(s).unwrap()
    }

    fn value(symbol: &str, px: &str, sz: &str, oracle: Option<&str>) -> Result<Valued, Refusal> {
        check_value(&policy(), symbol, e8(px), e8(sz), oracle.map(e8))
    }

    #[test]
    fn a_sell_at_a_tiny_price_is_valued_at_the_oracle() {
        // The review's case: px 1, sz 1000 on ETH fit a 1000 USD cap when valued at its own price.
        let r = value("ETH", "1", "1000", Some("2500")).unwrap_err();
        assert_eq!(r.code, E_PRICE_BAND);
        // With a band wide enough to let the price through, the size still counts at the oracle.
        let mut p = policy();
        p.price_band_bps = 10_000;
        let r = check_value(&p, "ETH", e8("1"), e8("1000"), Some(e8("2500"))).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_SIZE: ETH 2500 (the oracle price, above the limit 1) x 1000 = 2500000 USD is over max_notional_usd 1000"
        );
        // The cap at the oracle price is allowed, buys above it are valued at their own price.
        check_value(&p, "ETH", e8("1"), e8("0.4"), Some(e8("2500"))).unwrap();
        let r = value("ETH", "2550", "0.4", Some("2500")).unwrap_err();
        assert_eq!(
            r.msg,
            "ETH 2550 x 0.4 = 1020 USD is over max_notional_usd 1000"
        );
    }

    #[test]
    fn a_priced_symbol_without_a_fresh_price_is_refused() {
        let r = value("ETH", "2500", "0.1", None).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_ORACLE_STALE: no oracle price for ETH younger than 300 s, and ETH is not in policy.unpriced"
        );
    }

    #[test]
    fn the_band_edges_are_allowed() {
        value("ETH", "2550", "0.1", Some("2500")).unwrap();
        value("ETH", "2450", "0.1", Some("2500")).unwrap();
        let r = value("ETH", "2550.1", "0.1", Some("2500")).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_PRICE_BAND: px 2550.1 is 2.004% from oracle 2500, outside price_band_bps 200"
        );
        assert_eq!(
            value("ETH", "2449.9", "0.1", Some("2500"))
                .unwrap_err()
                .code,
            E_PRICE_BAND
        );
        // The band runs before the size: an oversize order far from the oracle is a band refusal.
        assert_eq!(
            value("ETH", "9000", "1", Some("2500")).unwrap_err().code,
            E_PRICE_BAND
        );
        assert_eq!(
            check_band(1, 0, 100).unwrap_err().msg,
            "px 0.00000001 is far from oracle 0, outside price_band_bps 100"
        );
        assert!(check_band(u128::MAX, 1, 100).is_err());
        check_band(u128::MAX / 2, u128::MAX / 2, 10_000).unwrap();
    }

    #[test]
    fn unpriced_symbols_are_capped_in_base_units_and_at_their_own_price() {
        let ok = value("HYPE", "39.9", "2.5", None).unwrap();
        assert!(ok.unpriced());
        // An oracle price, if one were passed, is not used for an unpriced symbol.
        assert!(value("HYPE", "39.9", "2.5", Some("1")).unwrap().unpriced());
        let r = value("HYPE", "1", "2.51", None).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_SIZE: HYPE size 2.51 is over its max_sz 2.5 (an unpriced symbol, capped in base units)"
        );
        let r = value("HYPE", "50", "2.5", None).unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_SIZE: HYPE 50 x 2.5 = 125 USD is over the unpriced cap, min(max_notional_usd, unpriced_max_notional_usd) 100"
        );
        let mut p = policy();
        p.max_notional_usd = 50;
        let r = check_value(&p, "HYPE", e8("39.9"), e8("2.5"), None).unwrap_err();
        assert!(r.msg.ends_with("unpriced_max_notional_usd) 50"), "{r}");
    }

    #[test]
    fn zero_sizes_and_huge_notionals_are_e_size() {
        assert_eq!(
            value("ETH", "2500", "0", Some("2500"))
                .unwrap_err()
                .to_string(),
            "E_SIZE: ETH size is zero"
        );
        let mut p = policy();
        p.price_band_bps = 10_000;
        p.max_notional_usd = crate::policy::MAX_SAFE_INTEGER;
        let huge = u128::MAX / 3;
        let r = check_value(&p, "ETH", huge, huge, Some(huge)).unwrap_err();
        assert_eq!(r.code, E_SIZE);
        assert!(r.msg.contains("more than 2^128 / 1e16"), "{r}");
        p.max_notional_usd = 0;
        assert_eq!(
            check_value(&p, "ETH", e8("1"), e8("0.0001"), Some(e8("1")))
                .unwrap_err()
                .code,
            E_SIZE
        );
    }

    #[test]
    fn prices_are_fresh_up_to_the_max_age() {
        let now = 1_793_491_200_000;
        assert_eq!(fresh_price(7, now - 300_000, now, 300), Some(7));
        assert_eq!(fresh_price(7, now - 300_001, now, 300), None);
        assert_eq!(fresh_price(7, now + 5_000, now, 1), Some(7));
        assert_eq!(fresh_price(7, 0, now, 3_600), None);
    }
}
