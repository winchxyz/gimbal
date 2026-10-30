//! The Gimbal NEAR contract: it owns each desk's venue accounts through Chain Signatures, builds every
//! payload itself, checks it against the owner's policy and only then asks the MPC network to sign.
//!
//! Rules that need no chain state live in `gimbal-core`; this crate holds state, roles, MPC calls and
//! events, and turns a core [`Refusal`] into the panic `"E_CODE: msg"` with [`fail`].

pub mod config;
pub mod desk;
pub mod events;

pub use gimbal_core::Refusal;

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

use crate::config::{FeeConfig, Network, OrderlyConfig, PriceSource, Treasury};
use crate::desk::Desk;

/// Ends the call with the refusal's stable code first: `"E_PRICE_BAND: px 2500 is 4.3% from oracle
/// 2397.1"`. Clients match on the code, people read the rest.
pub fn fail(refusal: Refusal) -> ! {
    env::panic_str(&refusal.to_string())
}

/// `result.or_fail()` returns the value or ends the call with the refusal, see [`fail`].
pub trait OrFail<T> {
    fn or_fail(self) -> T;
}

impl<T> OrFail<T> for Result<T, Refusal> {
    fn or_fail(self) -> T {
        match self {
            Ok(value) => value,
            Err(refusal) => fail(refusal),
        }
    }
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Desks,
    DesksByOwner,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gimbal {
    network: Network,
    /// The MPC signer contract (`v1.signer` mainnet, `v1.signer-prod.testnet` testnet).
    mpc: AccountId,
    price_source: PriceSource,
    treasury: Treasury,
    fees: FeeConfig,
    orderly: OrderlyConfig,
    desks: LookupMap<String, Desk>,
    /// Desk ids per owner, for `desks_of`.
    desks_by_owner: LookupMap<AccountId, Vec<String>>,
}

#[near]
impl Gimbal {
    /// Sets the configuration once, at deploy. Private: only the contract account itself can
    /// initialise it, so nobody can front-run the deploy with their own treasury or fees.
    #[init]
    #[private]
    pub fn new(
        network: Network,
        mpc: AccountId,
        price_source: PriceSource,
        treasury: Treasury,
        fees: FeeConfig,
        orderly: OrderlyConfig,
    ) -> Self {
        config::check(network, &price_source, &treasury, &fees, &orderly).or_fail();
        Self {
            network,
            mpc,
            price_source,
            treasury,
            fees,
            orderly,
            desks: LookupMap::new(StorageKey::Desks),
            desks_by_owner: LookupMap::new(StorageKey::DesksByOwner),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ReferralCodes, ARBITRUM_MAINNET, ARBITRUM_SEPOLIA};
    use gimbal_core::errors::E_ARGS;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn contract_id() -> AccountId {
        "gimbal.testnet".parse().unwrap()
    }

    fn called_by(predecessor: AccountId) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(predecessor)
            .build());
    }

    fn treasury() -> Treasury {
        Treasury {
            near: accounts(5),
            hl_builder: "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c".into(),
            referral_codes: ReferralCodes {
                hyperliquid: Some("TESTCODE".into()),
                orderly: None,
                phoenix: None,
            },
        }
    }

    fn fees() -> FeeConfig {
        FeeConfig {
            performance_bps: 1000,
            hl_builder_tenth_bps: 10,
        }
    }

    fn testnet() -> Gimbal {
        Gimbal::new(
            Network::Testnet,
            "v1.signer-prod.testnet".parse().unwrap(),
            PriceSource::Mock,
            treasury(),
            fees(),
            OrderlyConfig {
                broker_id: "woofi_dex".into(),
                chain_id: ARBITRUM_SEPOLIA,
            },
        )
    }

    #[test]
    fn new_stores_the_config() {
        called_by(contract_id());
        let g = testnet();
        assert_eq!(g.network, Network::Testnet);
        assert_eq!(g.mpc.as_str(), "v1.signer-prod.testnet");
        assert_eq!(g.price_source, PriceSource::Mock);
        assert_eq!(g.treasury, treasury());
        assert_eq!(g.fees, fees());
        assert_eq!(g.orderly.chain_id, ARBITRUM_SEPOLIA);
        assert!(g.desks.get("alpha").is_none());
        assert!(g.desks_by_owner.get(&accounts(0)).is_none());
    }

    // `#[private]` and the already-initialised guard live in the wasm entry point that near-sdk
    // generates, which a unit test calling `Gimbal::new` directly does not go through.

    #[test]
    #[should_panic(expected = "E_ARGS: the Mock price source is for testnet and demo only")]
    fn new_refuses_mock_prices_on_mainnet() {
        called_by(contract_id());
        Gimbal::new(
            Network::Mainnet,
            "v1.signer".parse().unwrap(),
            PriceSource::Mock,
            treasury(),
            fees(),
            OrderlyConfig {
                broker_id: "gimbal".into(),
                chain_id: ARBITRUM_MAINNET,
            },
        );
    }

    #[test]
    #[should_panic(expected = "E_ARGS: desk id is too long")]
    fn fail_panics_with_code_first() {
        fail(Refusal::new(E_ARGS, "desk id is too long"));
    }

    #[test]
    // The mock escapes quotes in the panic it reports, so match the part before the quoted input.
    #[should_panic(expected = "E_DECIMAL: ")]
    fn or_fail_panics_on_a_refusal() {
        gimbal_core::decimal::parse_e8("1.50").or_fail();
    }

    #[test]
    fn or_fail_passes_values_through() {
        assert_eq!(gimbal_core::decimal::parse_e8("1.5").or_fail(), 150_000_000);
    }
}
