//! Reference prices for the order checks (docs/interfaces.md §1.2, "Order size cap").
//!
//! Every priced order is valued at its symbol's oracle price and must sit inside the price band
//! around it. The contract stores no prices yet: `refresh_prices` and `set_mock_price` land in C6.
//! Until then there is no fresh price for any symbol, so every priced order is refused with
//! `E_ORACLE_STALE`; only symbols the owner listed in `policy.unpriced` can be signed.

/// The oracle price of `symbol` in units of 1e-8 USD, if one younger than `max_age_s` is stored.
pub fn reference_price(_symbol: &str, _max_age_s: u32) -> Option<u128> {
    None
}
