//! The contract's configuration, fixed once in `new` (docs/interfaces.md §1.1). Only URLs, ids and the
//! price source differ between testnet and mainnet; the code is the same.

use gimbal_core::errors::{Refusal, E_ARGS};
use near_sdk::{near, AccountId};

/// Hyperliquid caps a builder fee on perps at 100 tenths of a bp (0.1 %).
pub const HL_BUILDER_FEE_MAX_TENTH_BPS: u16 = 100;
/// A performance fee is a share of profit: at most all of it.
pub const PERFORMANCE_FEE_MAX_BPS: u16 = 10_000;
/// Hyperliquid referral codes are 1 to 20 characters.
pub const HL_REFERRAL_CODE_MAX_CHARS: usize = 20;
/// Arbitrum chain ids Orderly runs on.
pub const ARBITRUM_MAINNET: u64 = 42161;
pub const ARBITRUM_SEPOLIA: u64 = 421614;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
}

/// Where the price band gets its oracle price.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PriceSource {
    /// The OutLayer price oracle (`price-oracle.near`), on-demand path.
    OutLayer { contract: AccountId },
    /// Owner-set prices: testnet and demo only, refused on mainnet.
    Mock,
}

#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Treasury {
    /// Receives performance fees on NEAR.
    pub near: AccountId,
    /// Hyperliquid builder: lowercase `0x` address with ≥ 100 USDC in perps.
    pub hl_builder: String,
    /// The only referral codes a desk can ever use.
    pub referral_codes: ReferralCodes,
}

/// `None` means that venue's referral step is skipped.
#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ReferralCodes {
    /// Signed once per desk with `hl_set_referrer`, before its first order.
    pub hyperliquid: Option<String>,
    /// Bound once per desk (`referral_bind`, permanent); must belong to `OrderlyConfig::broker_id`.
    pub orderly: Option<String>,
    /// Phoenix's invite gate before trader registration.
    pub phoenix: Option<String>,
}

#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderlyConfig {
    /// Testnet `woofi_dex`; mainnet: Gimbal's broker id.
    pub broker_id: String,
    /// Arbitrum: 421614 testnet, 42161 mainnet.
    pub chain_id: u64,
}

#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeConfig {
    /// Share of profit above the desk's high-water mark; 1000 = 10 %.
    pub performance_bps: u16,
    /// Per Hyperliquid fill, in tenths of a bp; 10 = 1 bp.
    pub hl_builder_tenth_bps: u16,
}

/// Checks the arguments of `new`. They are fixed for the contract's life and every desk depends on
/// them, so a wrong value is refused up front rather than at the first order.
pub fn check(
    network: Network,
    price_source: &PriceSource,
    treasury: &Treasury,
    fees: &FeeConfig,
    orderly: &OrderlyConfig,
) -> Result<(), Refusal> {
    let refuse = |msg: String| Err(Refusal::new(E_ARGS, msg));

    if network == Network::Mainnet && *price_source == PriceSource::Mock {
        return refuse("the Mock price source is for testnet and demo only".into());
    }
    if !is_lower_evm_address(&treasury.hl_builder) {
        return refuse(format!(
            "hl_builder {:?} is not a lowercase 0x address",
            treasury.hl_builder
        ));
    }
    if let Some(code) = &treasury.referral_codes.hyperliquid {
        let chars = code.chars().count();
        if chars == 0 || chars > HL_REFERRAL_CODE_MAX_CHARS {
            return refuse(format!(
                "Hyperliquid referral code has {chars} characters, not 1 to {HL_REFERRAL_CODE_MAX_CHARS}"
            ));
        }
    }
    for (venue, code) in [
        ("Orderly", &treasury.referral_codes.orderly),
        ("Phoenix", &treasury.referral_codes.phoenix),
    ] {
        if code.as_deref() == Some("") {
            return refuse(format!(
                "{venue} referral code is empty; use null to skip it"
            ));
        }
    }
    if fees.performance_bps > PERFORMANCE_FEE_MAX_BPS {
        return refuse(format!(
            "performance_bps {} is over {PERFORMANCE_FEE_MAX_BPS}",
            fees.performance_bps
        ));
    }
    if fees.hl_builder_tenth_bps > HL_BUILDER_FEE_MAX_TENTH_BPS {
        return refuse(format!(
            "hl_builder_tenth_bps {} is over Hyperliquid's cap of {HL_BUILDER_FEE_MAX_TENTH_BPS}",
            fees.hl_builder_tenth_bps
        ));
    }
    if orderly.broker_id.is_empty() {
        return refuse("Orderly broker_id is empty".into());
    }
    if orderly.chain_id != network.arbitrum_chain_id() {
        return refuse(format!(
            "Orderly chain_id {} does not match {network:?} (Arbitrum {})",
            orderly.chain_id,
            network.arbitrum_chain_id()
        ));
    }
    Ok(())
}

/// `0x` and 40 lowercase hex digits: Hyperliquid lowercases addresses before it verifies a
/// signature, so a mixed-case address in a signed action would not match.
fn is_lower_evm_address(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn treasury() -> Treasury {
        Treasury {
            near: "treasury.testnet".parse().unwrap(),
            hl_builder: "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c".into(),
            referral_codes: ReferralCodes {
                hyperliquid: Some("TESTCODE".into()),
                orderly: None,
                phoenix: Some("INVITE".into()),
            },
        }
    }

    fn fees() -> FeeConfig {
        FeeConfig {
            performance_bps: 1000,
            hl_builder_tenth_bps: 10,
        }
    }

    fn orderly(chain_id: u64) -> OrderlyConfig {
        OrderlyConfig {
            broker_id: "woofi_dex".into(),
            chain_id,
        }
    }

    fn refused(r: Result<(), Refusal>) -> String {
        let r = r.expect_err("should be refused");
        assert_eq!(r.code, E_ARGS);
        r.msg
    }

    #[test]
    fn testnet_with_mock_prices_is_fine() {
        let o = orderly(ARBITRUM_SEPOLIA);
        check(
            Network::Testnet,
            &PriceSource::Mock,
            &treasury(),
            &fees(),
            &o,
        )
        .unwrap();
    }

    #[test]
    fn mainnet_with_outlayer_is_fine() {
        let ps = PriceSource::OutLayer {
            contract: "price-oracle.near".parse().unwrap(),
        };
        let o = orderly(ARBITRUM_MAINNET);
        check(Network::Mainnet, &ps, &treasury(), &fees(), &o).unwrap();
    }

    #[test]
    fn mock_prices_on_mainnet_are_refused() {
        let o = orderly(ARBITRUM_MAINNET);
        let msg = refused(check(
            Network::Mainnet,
            &PriceSource::Mock,
            &treasury(),
            &fees(),
            &o,
        ));
        assert!(msg.contains("Mock"), "{msg}");
    }

    #[test]
    fn builder_address_must_be_lowercase_hex() {
        let o = orderly(ARBITRUM_SEPOLIA);
        for bad in [
            "0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c",
            "5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9cc",
            "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9g",
            "0X5050a4f4b3f9338c3472dcc01a87c76a144b3c9c",
            "",
        ] {
            let mut t = treasury();
            t.hl_builder = bad.into();
            refused(check(Network::Testnet, &PriceSource::Mock, &t, &fees(), &o));
        }
    }

    #[test]
    fn hyperliquid_referral_code_is_1_to_20_chars() {
        let o = orderly(ARBITRUM_SEPOLIA);
        for (code, ok) in [
            (Some("A"), true),
            (Some("ABCDEFGHIJ0123456789"), true),
            (None, true),
            (Some(""), false),
            (Some("ABCDEFGHIJ0123456789K"), false),
        ] {
            let mut t = treasury();
            t.referral_codes.hyperliquid = code.map(String::from);
            let r = check(Network::Testnet, &PriceSource::Mock, &t, &fees(), &o);
            assert_eq!(r.is_ok(), ok, "{code:?}");
        }
    }

    #[test]
    fn empty_orderly_or_phoenix_code_is_refused() {
        let o = orderly(ARBITRUM_SEPOLIA);
        let mut t = treasury();
        t.referral_codes.orderly = Some(String::new());
        refused(check(Network::Testnet, &PriceSource::Mock, &t, &fees(), &o));
        let mut t = treasury();
        t.referral_codes.phoenix = Some(String::new());
        refused(check(Network::Testnet, &PriceSource::Mock, &t, &fees(), &o));
    }

    #[test]
    fn fees_are_capped() {
        let o = orderly(ARBITRUM_SEPOLIA);
        let t = treasury();
        let edge = FeeConfig {
            performance_bps: PERFORMANCE_FEE_MAX_BPS,
            hl_builder_tenth_bps: HL_BUILDER_FEE_MAX_TENTH_BPS,
        };
        check(Network::Testnet, &PriceSource::Mock, &t, &edge, &o).unwrap();
        let mut f = edge;
        f.performance_bps += 1;
        refused(check(Network::Testnet, &PriceSource::Mock, &t, &f, &o));
        let mut f = edge;
        f.hl_builder_tenth_bps += 1;
        refused(check(Network::Testnet, &PriceSource::Mock, &t, &f, &o));
    }

    #[test]
    fn orderly_chain_follows_the_network() {
        let t = treasury();
        let wrong = orderly(ARBITRUM_MAINNET);
        refused(check(
            Network::Testnet,
            &PriceSource::Mock,
            &t,
            &fees(),
            &wrong,
        ));
        let mut empty = orderly(ARBITRUM_SEPOLIA);
        empty.broker_id.clear();
        refused(check(
            Network::Testnet,
            &PriceSource::Mock,
            &t,
            &fees(),
            &empty,
        ));
    }

    #[test]
    fn json_shapes() {
        use near_sdk::serde_json::{from_str, json, to_value};
        assert_eq!(to_value(Network::Mainnet).unwrap(), json!("Mainnet"));
        assert_eq!(to_value(PriceSource::Mock).unwrap(), json!("Mock"));
        assert_eq!(
            from_str::<PriceSource>(r#"{"OutLayer":{"contract":"price-oracle.near"}}"#).unwrap(),
            PriceSource::OutLayer {
                contract: "price-oracle.near".parse().unwrap()
            }
        );
        // A misspelt optional field would otherwise read as None and silently skip a referral.
        assert!(from_str::<ReferralCodes>(r#"{"hyperliqiud":"X"}"#).is_err());
        assert_eq!(
            from_str::<ReferralCodes>("{}").unwrap(),
            ReferralCodes::default()
        );
    }
}
