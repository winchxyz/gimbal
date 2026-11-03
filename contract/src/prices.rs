//! Oracle prices (docs/interfaces.md §1.2, "Order size cap"; §1.3 `refresh_prices`,
//! `set_mock_price`, `oracle_on_call`).
//!
//! Every priced order is valued at its symbol's stored oracle price and must sit inside the price
//! band around it; a price older than the policy's `oracle_max_age_s` is no price
//! (`E_ORACLE_STALE`). The store holds one price and its time per symbol of
//! [`ORACLE_ASSETS`]; symbols outside it trade only through `policy.unpriced`.
//!
//! With `PriceSource::OutLayer`, `refresh_prices` asks the oracle (`price-oracle.near`) on the
//! contract's own deposit: `request_price_data` with a private callback, `on_prices`. The oracle
//! burns about 3 TGas and splits the rest between OutLayer's `request_execution` (about 20 TGas
//! plus half of what is over 70) and its own callback (about 50 plus the other half); measured:
//! 76 TGas in gave OutLayer 21 (mainnet, 2026-11-01), 281 in gave it 124 (testnet). OutLayer
//! reserves 50 TGas for its yield callback out of what it gets (`MIN_RESPONSE_GAS`) and burns
//! about 4 itself, so the 21 failed with "Exceeded the prepaid gas". `request_price_data` now gets
//! nearly all of the transaction's gas ([`REQUEST_PRICE_DATA_GAS`] and every unused TGas) and
//! `on_prices` a small fixed amount. There is no `oracle_call` fallback in the same transaction: it
//! would need as much gas again, which 300 TGas cannot hold beside a well-funded first call. An answer's `timestamp` is the block time of
//! the oracle's read, and each price in it the median of reports at most the answer's
//! `recency_duration_sec` older (600 s on mainnet), so a stored price's time is the oldest a
//! report in it can be: `timestamp` − `recency_duration_sec`, and never later than the block
//! that stores it. `oracle_max_age_s` then bounds the age of every report behind a price. With
//! `PriceSource::Mock` the contract account sets prices itself (`set_mock_price`), testnet and
//! demo only.

use gimbal_core::errors::{shown, Refusal, E_ARGS, E_NOT_ALLOWED};
use gimbal_core::limits::fresh_price;
use gimbal_core::oracle::{check_symbols, price_e8, symbol_of, ORACLE_ASSETS};
use gimbal_core::policy::MAX_SAFE_INTEGER;
use near_sdk::serde::{Deserialize, Deserializer, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, serde_json, AccountId, Gas, GasWeight, NearToken, Promise, PromiseOrValue,
};

use crate::config::PriceSource;
use crate::deposit::check_one_yocto;
use crate::events::{emit, PRICES};
use crate::{fail, Gimbal, GimbalExt, OrFail};

/// What `refresh_prices` attaches to the oracle from the contract's balance. The oracle refunds it
/// when its cache is fresh and passes it to OutLayer (0.01 NEAR at least) when it must fetch.
pub const ORACLE_DEPOSIT: NearToken = NearToken::from_millinear(20);

/// Static gas of `request_price_data`, which also gets all the gas `refresh_prices` leaves unused
/// (281 TGas of 300 on testnet). At this floor alone the oracle forwards about 83 TGas to
/// OutLayer, which needs 54 (its 50 TGas reserve and its own 4).
pub const REQUEST_PRICE_DATA_GAS: Gas = Gas::from_tgas(200);

/// Gas of `on_prices`: one result read and up to seven prices stored. It used 2.1 TGas on mainnet
/// with five symbols; it schedules nothing.
pub const ON_PRICES_GAS: Gas = Gas::from_tgas(15);

/// What `refresh_prices` burns itself, with the fees of the two receipts it creates (19.3 TGas on
/// the mocked chain for all seven symbols; 2.8 TGas burnt on mainnet for five).
pub const REFRESH_PRICES_GAS: Gas = Gas::from_tgas(25);

/// The least prepaid gas `refresh_prices` accepts (`E_ARGS` below it), 240 TGas: the engine
/// attaches 300.
pub const REFRESH_PRICES_MIN_GAS: Gas = Gas::from_gas(
    REFRESH_PRICES_GAS.as_gas() + REQUEST_PRICE_DATA_GAS.as_gas() + ON_PRICES_GAS.as_gas(),
);

/// The longest oracle answer `on_prices` reads.
pub const PRICE_DATA_MAX_LEN: usize = 8 * 1024;

/// How recently the oracle must have been asked (for every price) for `refresh_prices` to skip
/// it, ms: within it a second call spends nothing from the contract's balance, also while the
/// oracle answers nothing, whoever calls and whatever symbols they name.
pub const REFRESH_SKIP_MS: u64 = 30_000;

/// One stored price: USD per whole token × 1e8, and its time, ms: the oldest a report in it can
/// be (module doc), or the block time of a mock price. `stored_ms` is the block time the contract
/// stored it, which [`REFRESH_SKIP_MS`] counts from.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredPrice {
    pub price_e8: u64,
    pub at_ms: u64,
    pub stored_ms: u64,
}

/// A row of `prices()` and of the `prices` event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceRow {
    /// The policy symbol (`ETH`).
    pub asset: String,
    pub price_e8: u64,
    pub at_ms: u64,
}

/// The oracle's `PriceData`, read leniently: integers as strings or numbers, unknown fields
/// ignored.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct OraclePriceData {
    /// When the oracle read its cache (or fetched), ns.
    #[serde(deserialize_with = "integer")]
    pub timestamp: u128,
    /// How much older than `timestamp` the reports behind each price may be, s. Required: an
    /// answer without it says nothing of its prices' age.
    #[serde(deserialize_with = "integer")]
    pub recency_duration_sec: u128,
    #[serde(default)]
    pub prices: Vec<OracleAssetPrice>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct OracleAssetPrice {
    pub asset_id: String,
    #[serde(default)]
    pub price: Option<OraclePrice>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct OraclePrice {
    #[serde(deserialize_with = "integer")]
    pub multiplier: u128,
    pub decimals: u8,
}

/// A JSON integer or a decimal string of one.
fn integer<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
    #[derive(Deserialize)]
    #[serde(crate = "near_sdk::serde", untagged)]
    enum Either {
        Number(u64),
        Text(String),
    }
    match Either::deserialize(d)? {
        Either::Number(n) => Ok(u128::from(n)),
        Either::Text(s) => s.parse().map_err(near_sdk::serde::de::Error::custom),
    }
}

/// The price of `symbol` in units of 1e-8 USD if one at most `max_age_s` old at `now_ms` is
/// stored: the reference of the order checks.
pub fn reference_price(
    prices: &LookupMap<String, StoredPrice>,
    symbol: &str,
    max_age_s: u32,
    now_ms: u64,
) -> Option<u128> {
    let p = prices.get(symbol)?;
    fresh_price(u128::from(p.price_e8), p.at_ms, now_ms, max_age_s)
}

/// The time of an oracle answer's prices, ms: `timestamp` − `recency_duration_sec`, the oldest a
/// report behind them can be, and at most `block_ms`, so an answer from the future is neither
/// fresh forever nor in the way of the answers after it.
pub fn answer_time_ms(data: &OraclePriceData, block_ms: u64) -> u64 {
    let read_ms = data.timestamp / 1_000_000;
    let oldest_ms = read_ms.saturating_sub(data.recency_duration_sec.saturating_mul(1000));
    u64::try_from(oldest_ms).unwrap_or(u64::MAX).min(block_ms)
}

/// `E_ARGS` when `refresh_prices` came with less than [`REFRESH_PRICES_MIN_GAS`].
pub fn check_refresh_gas(prepaid: Gas) -> Result<(), Refusal> {
    if prepaid >= REFRESH_PRICES_MIN_GAS {
        return Ok(());
    }
    Err(Refusal::new(
        E_ARGS,
        format!(
            "refresh_prices needs at least {} TGas attached (300 recommended), not {}",
            REFRESH_PRICES_MIN_GAS.as_tgas(),
            prepaid.as_tgas()
        ),
    ))
}

#[near]
impl Gimbal {
    /// Asks the OutLayer oracle for the prices of every symbol of [`ORACLE_ASSETS`] and stores
    /// each that is newer than the stored one; event `prices` with the rows stored. `assets` (1
    /// to 7 symbols of the table, each once: `E_ARGS`, `E_ASSET`) only names what the caller
    /// waits for. Takes no deposit: the oracle's 0.02 NEAR comes from the contract's balance and
    /// is mostly refunded. Callers are the owners of desks, whose engine key calls it, the desks'
    /// separate operator accounts and the contract account (`E_NOT_ALLOWED` for anyone else, so
    /// strangers cannot spend the contract's deposit); `E_ARGS` with the Mock source or under
    /// [`REFRESH_PRICES_MIN_GAS`]. When anyone asked the oracle less than [`REFRESH_SKIP_MS`] ago
    /// (its answer may still be on the way) it asks nothing and returns `true` at once, so the
    /// contract makes at most one oracle call per 30 s however many desks and symbols there are.
    /// Otherwise the transaction's result is `true` when every symbol of `assets` got a price from
    /// the oracle's answer, `false` when one did not.
    #[deny_unknown_arguments]
    pub fn refresh_prices(&mut self, assets: Vec<String>) -> PromiseOrValue<bool> {
        let oracle = self.oracle_or_fail();
        check_symbols(&assets).or_fail();
        let caller = env::predecessor_account_id();
        let owns_a_desk = self.desk_counts.get(&caller).is_some_and(|n| *n > 0);
        let operates_a_desk = self.operator_counts.get(&caller).is_some_and(|n| *n > 0);
        if !owns_a_desk && !operates_a_desk && caller != env::current_account_id() {
            fail(Refusal::new(
                E_NOT_ALLOWED,
                format!(
                    "{caller} owns and operates no desk; only desk owners and operators refresh \
                     prices"
                ),
            ));
        }
        check_refresh_gas(env::prepaid_gas()).or_fail();
        let now_ms = env::block_timestamp_ms();
        let asked = self.prices_asked_ms;
        if asked != 0 && now_ms.saturating_sub(asked) < REFRESH_SKIP_MS {
            env::log_str(&format!(
                "the oracle was asked for every price at {asked} ms, under 30 s ago; no oracle call"
            ));
            return PromiseOrValue::Value(true);
        }
        self.prices_asked_ms = now_ms;
        let all: Vec<&str> = ORACLE_ASSETS.iter().map(|(_, id)| *id).collect();
        let args = serde_json::json!({ "asset_ids": all });
        let call = Promise::new(oracle)
            .function_call_weight(
                "request_price_data",
                args.to_string().into_bytes(),
                ORACLE_DEPOSIT,
                REQUEST_PRICE_DATA_GAS,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PRICES_GAS)
                    .with_unused_gas_weight(0)
                    .on_prices(assets),
            );
        PromiseOrValue::Promise(call)
    }

    /// The callback of `request_price_data`: stores every price of the answer and returns whether
    /// every symbol of `assets` (the caller's) got one; `false` when the call failed or answered
    /// nothing readable (the next `refresh_prices` asks again once [`REFRESH_SKIP_MS`] passed).
    #[private]
    pub fn on_prices(&mut self, assets: Vec<String>) -> bool {
        let answer = env::promise_result_checked(0, PRICE_DATA_MAX_LEN)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<OraclePriceData>(&bytes).ok());
        match answer {
            Some(data) => self.store_prices(&data, &assets),
            None => {
                env::log_str("request_price_data failed or answered nothing readable");
                false
            }
        }
    }

    /// The OutLayer oracle's callback after an `oracle_call` (its `ext_price_receiver`): stores the
    /// prices like `on_prices` and returns whether every symbol in `msg` (comma-separated) got
    /// one. `refresh_prices` no longer makes an `oracle_call` (module doc); the method stays for
    /// the interface and stores nothing an `oracle_call` of the contract did not ask for. Only the configured oracle may call it, and only for
    /// an `oracle_call` the contract made itself (`E_NOT_ALLOWED`). Not payable: the oracle's
    /// `oracle_call` calls it with no deposit on every path (its source, read 2026-10-31). The
    /// 0.02 NEAR the contract attached to `oracle_call` stays with the oracle's own handling: sent
    /// back to the contract when the oracle's cache was fresh, else passed to OutLayer.
    #[deny_unknown_arguments]
    pub fn oracle_on_call(
        &mut self,
        sender_id: AccountId,
        data: OraclePriceData,
        msg: String,
    ) -> bool {
        let caller = env::predecessor_account_id();
        if self.config.oracle() != Some(&caller) {
            fail(Refusal::new(
                E_NOT_ALLOWED,
                format!("oracle_on_call is the price oracle's; {caller} is not it"),
            ));
        }
        if sender_id != env::current_account_id() {
            fail(Refusal::new(
                E_NOT_ALLOWED,
                format!("oracle_on_call answers the contract's own oracle_call, not {sender_id}'s"),
            ));
        }
        let assets: Vec<String> = msg
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        self.store_prices(&data, &assets)
    }

    /// Sets the stored price of `asset` (a symbol of [`ORACLE_ASSETS`], `E_ASSET`) to `price_e8`
    /// (USD × 1e8, 1 to 2^53 − 1, `E_ARGS`) at the block time; event `prices`. Only the contract
    /// account itself, with exactly 1 yoctoNEAR (`E_NOT_ALLOWED`), and only with
    /// `PriceSource::Mock` (`E_ARGS`).
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_mock_price(&mut self, asset: String, price_e8: u64) {
        let caller = env::predecessor_account_id();
        if caller != env::current_account_id() {
            fail(Refusal::new(
                E_NOT_ALLOWED,
                format!("set_mock_price is the contract account's; {caller} is not it"),
            ));
        }
        check_one_yocto("set_mock_price", env::attached_deposit()).or_fail();
        if self.config.price_source != PriceSource::Mock {
            fail(Refusal::new(
                E_ARGS,
                "prices come from the oracle (refresh_prices); set_mock_price needs \
                 PriceSource::Mock",
            ));
        }
        check_symbols(std::slice::from_ref(&asset)).or_fail();
        if !(1..=MAX_SAFE_INTEGER).contains(&price_e8) {
            fail(Refusal::new(
                E_ARGS,
                format!("price_e8 {price_e8} is not 1 to 2^53 - 1"),
            ));
        }
        let at_ms = env::block_timestamp_ms();
        self.prices.insert(
            asset.clone(),
            StoredPrice {
                price_e8,
                at_ms,
                stored_ms: at_ms,
            },
        );
        emit(
            PRICES,
            &[PriceRow {
                asset,
                price_e8,
                at_ms,
            }],
        );
    }

    /// The stored prices, `[{asset, price_e8, at_ms}]` sorted by asset, the shape of the `prices`
    /// event; a symbol without a price is left out.
    pub fn prices(&self) -> Vec<PriceRow> {
        ORACLE_ASSETS
            .iter()
            .filter_map(|(symbol, _)| {
                self.prices.get(*symbol).map(|p| PriceRow {
                    asset: (*symbol).to_owned(),
                    price_e8: p.price_e8,
                    at_ms: p.at_ms,
                })
            })
            .collect()
    }
}

impl Gimbal {
    /// The configured oracle, or `E_ARGS` with the Mock source.
    fn oracle_or_fail(&self) -> AccountId {
        self.config.oracle().cloned().unwrap_or_else(|| {
            fail(Refusal::new(
                E_ARGS,
                "the price source is Mock: the contract account sets prices with set_mock_price",
            ))
        })
    }

    /// Stores every price of `data` that is for a symbol of the table, in the oracle's USD form
    /// ([`price_e8`]), at most 2^53 − 1, and newer than the stored one, at the time
    /// [`answer_time_ms`] gives; emits `prices` with the rows stored, sorted by asset. Returns
    /// whether each of `asked` now has a price at least as new as this answer.
    fn store_prices(&mut self, data: &OraclePriceData, asked: &[String]) -> bool {
        let block_ms = env::block_timestamp_ms();
        let at_ms = answer_time_ms(data, block_ms);
        let mut rows: Vec<PriceRow> = Vec::new();
        for p in &data.prices {
            let Some(symbol) = symbol_of(&p.asset_id) else {
                continue;
            };
            let Some(e8) = p
                .price
                .as_ref()
                .and_then(|price| price_e8(price.multiplier, price.decimals))
                .filter(|e8| *e8 <= MAX_SAFE_INTEGER)
            else {
                env::log_str(&format!(
                    "no USD price for {} in the oracle's answer",
                    shown(&p.asset_id)
                ));
                continue;
            };
            if self
                .prices
                .get(symbol)
                .is_some_and(|old| old.at_ms >= at_ms)
            {
                continue;
            }
            self.prices.insert(
                symbol.to_owned(),
                StoredPrice {
                    price_e8: e8,
                    at_ms,
                    stored_ms: block_ms,
                },
            );
            rows.push(PriceRow {
                asset: symbol.to_owned(),
                price_e8: e8,
                at_ms,
            });
        }
        rows.sort_by(|a, b| a.asset.cmp(&b.asset));
        if !rows.is_empty() {
            emit(PRICES, &rows);
        }
        asked
            .iter()
            .all(|s| self.prices.get(s).is_some_and(|p| p.at_ms >= at_ms))
    }
}
