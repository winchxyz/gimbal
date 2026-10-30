//! The Gimbal NEAR contract: it owns each desk's venue accounts through Chain Signatures, builds every
//! payload itself, checks it against the owner's policy and only then asks the MPC network to sign.
//!
//! Rules that need no chain state live in `gimbal-core`; this crate holds state, roles, MPC calls and
//! events, and turns a core [`Refusal`] into the panic `"E_CODE: msg"` with [`fail`].

pub mod config;
pub mod desk;
pub mod events;

pub use gimbal_core::Refusal;

use gimbal_core::errors::{shown, E_DEPOSIT, E_DESK_EXISTS, E_NO_DESK};
use gimbal_core::ids::{check_desk_id, check_evm_address};
use gimbal_core::policy::Policy;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, Promise};

use crate::config::{Config, FeeConfig, Network, OrderlyConfig, PriceSource, Treasury};
use crate::desk::{policy_sha256, Desk, Role, SolanaAccounts};
use crate::events::{DeskCreated, Event, OperatorSet, Paused, PolicySet};

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
    config: Config,
    desks: LookupMap<String, Desk>,
    /// Desk ids per owner, in creation order, for `desks_of`.
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
            config: Config {
                network,
                mpc,
                price_source,
                treasury,
                fees,
                orderly,
            },
            desks: LookupMap::new(StorageKey::Desks),
            desks_by_owner: LookupMap::new(StorageKey::DesksByOwner),
        }
    }

    /// Creates a desk owned by the caller. The attached deposit pays for the storage the desk takes
    /// (`E_DEPOSIT` below that); the rest goes back to the caller. `evm_address` and `solana` are the
    /// desk's MPC-derived venue accounts and can never change afterwards.
    #[payable]
    pub fn create_desk(
        &mut self,
        desk_id: String,
        policy: Policy,
        evm_address: String,
        solana: SolanaAccounts,
    ) {
        check_desk_id(&desk_id).or_fail();
        if self.desks.contains_key(&desk_id) {
            fail(Refusal::new(
                E_DESK_EXISTS,
                format!("desk {desk_id} exists already"),
            ));
        }
        check_evm_address("evm_address", &evm_address).or_fail();
        solana.check().or_fail();
        policy.validate().or_fail();

        let owner = env::predecessor_account_id();
        let sol_authority = solana.authority.clone();
        let before = env::storage_usage();
        let desk = Desk::new(owner.clone(), policy, evm_address.clone(), solana);
        self.desks.insert(desk_id.clone(), desk);
        self.desks_by_owner
            .entry(owner.clone())
            .or_default()
            .push(desk_id.clone());
        // The maps write on flush; flushing now makes the bytes measurable within this call.
        self.desks.flush();
        self.desks_by_owner.flush();
        let bytes = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(bytes));

        let attached = env::attached_deposit();
        if attached < cost {
            fail(Refusal::new(
                E_DEPOSIT,
                format!(
                    "desk {desk_id} takes {bytes} bytes of storage: attach at least {} yoctoNEAR, not {}",
                    cost.as_yoctonear(),
                    attached.as_yoctonear()
                ),
            ));
        }
        let excess = attached.saturating_sub(cost);
        if !excess.is_zero() {
            Promise::new(owner.clone()).transfer(excess).detach();
        }
        DeskCreated {
            desk_id: &desk_id,
            owner: &owner,
            evm_address: &evm_address,
            sol_authority: &sol_authority,
        }
        .emit();
    }

    /// Replaces the desk's policy. Owner only; allowed while the desk is paused.
    pub fn set_policy(&mut self, desk_id: String, policy: Policy) {
        let desk = owner_desk(&mut self.desks, &desk_id, "set_policy");
        policy.validate().or_fail();
        let sha = policy_sha256(&policy);
        desk.policy = policy;
        PolicySet {
            desk_id: &desk_id,
            policy_sha256: &sha,
        }
        .emit();
    }

    /// Sets the separate operator account, or clears it with `null`. Owner only.
    pub fn set_operator(&mut self, desk_id: String, operator: Option<AccountId>) {
        let desk = owner_desk(&mut self.desks, &desk_id, "set_operator");
        desk.operator = operator;
        OperatorSet {
            desk_id: &desk_id,
            operator: desk.operator.as_ref(),
        }
        .emit();
    }

    /// Pauses or unpauses the desk. The owner may do both, the operator only pause. Setting the
    /// state the desk is already in changes nothing and logs nothing.
    pub fn set_paused(&mut self, desk_id: String, paused: bool) {
        let by = env::predecessor_account_id();
        let desk = desk_mut(&mut self.desks, &desk_id);
        desk.check_set_paused(&desk_id, &by, paused).or_fail();
        if desk.paused == paused {
            return;
        }
        desk.paused = paused;
        Paused {
            desk_id: &desk_id,
            paused,
            by: &by,
        }
        .emit();
    }

    /// The desk, or `null` when there is none with that id.
    pub fn get_desk(&self, desk_id: String) -> Option<Desk> {
        self.desks.get(&desk_id).cloned()
    }

    /// The ids of the owner's desks, in creation order.
    pub fn desks_of(&self, owner: AccountId) -> Vec<String> {
        self.desks_by_owner.get(&owner).cloned().unwrap_or_default()
    }

    /// Everything `new` fixed: network, MPC signer, price source, treasury, fees, Orderly broker.
    pub fn config(&self) -> Config {
        self.config.clone()
    }

    /// The contract crate's version.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

/// The desk `desk_id`, or `E_NO_DESK`. Takes the map rather than the contract so a method can hold
/// the desk and still read `self.config`.
pub fn desk_mut<'a>(desks: &'a mut LookupMap<String, Desk>, desk_id: &str) -> &'a mut Desk {
    match desks.get_mut(desk_id) {
        Some(desk) => desk,
        None => fail(Refusal::new(
            E_NO_DESK,
            format!("no desk {}", shown(desk_id)),
        )),
    }
}

/// The desk of an owner method, after `E_NO_DESK` and `E_NOT_ALLOWED` (anyone but the owner).
pub fn owner_desk<'a>(
    desks: &'a mut LookupMap<String, Desk>,
    desk_id: &str,
    method: &str,
) -> &'a mut Desk {
    let desk = desk_mut(desks, desk_id);
    desk.check_owner(desk_id, &env::predecessor_account_id(), method)
        .or_fail();
    desk
}

/// The guard every action method calls first: the desk exists (`E_NO_DESK`), the caller is its
/// owner or operator (`E_NOT_ALLOWED`), and it is not paused (`E_PAUSED`). Returns the desk and the
/// caller's role.
pub fn action_desk<'a>(
    desks: &'a mut LookupMap<String, Desk>,
    desk_id: &str,
) -> (&'a mut Desk, Role) {
    let desk = desk_mut(desks, desk_id);
    let role = desk
        .check_action(desk_id, &env::predecessor_account_id())
        .or_fail();
    (desk, role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ReferralCodes, ARBITRUM_MAINNET, ARBITRUM_SEPOLIA};
    use gimbal_core::errors::E_ARGS;
    use gimbal_core::policy::{HlAsset, PhoenixMarket};
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json;
    use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const EVM: &str = "0x8ba1f109551bd432803012645ac136ddd64dba72";

    fn contract_id() -> AccountId {
        "gimbal.testnet".parse().unwrap()
    }

    fn owner() -> AccountId {
        accounts(0)
    }

    fn operator() -> AccountId {
        accounts(1)
    }

    fn stranger() -> AccountId {
        accounts(2)
    }

    /// A new call from `predecessor` with `deposit` attached. Storage carries over; logs and
    /// receipts start empty.
    fn call(predecessor: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(deposit)
            .build());
    }

    fn called_by(predecessor: AccountId) {
        call(predecessor, NearToken::from_yoctonear(0));
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

    fn policy() -> Policy {
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
            unpriced: vec![],
            unpriced_max_notional_usd: 100,
        }
    }

    fn b58(n: u8) -> String {
        bs58::encode([n; 32]).into_string()
    }

    fn solana() -> SolanaAccounts {
        SolanaAccounts {
            authority: b58(1),
            usdc_ata: b58(2),
            phusd_ata: b58(3),
            phoenix_trader: b58(4),
        }
    }

    /// A fresh contract with desk `alpha` of `owner()`, whose operator is `operator()`.
    fn with_desk() -> Gimbal {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        g.create_desk("alpha".into(), policy(), EVM.into(), solana());
        called_by(owner());
        g.set_operator("alpha".into(), Some(operator()));
        g
    }

    /// The panic message of a refused call. The mock reports it through `Debug`, so quotes in it
    /// come back escaped: match on text before any quoted input.
    fn refusal(f: impl FnOnce()) -> String {
        let payload = catch_unwind(AssertUnwindSafe(f)).expect_err("the call should be refused");
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    fn assert_refused(expected: &str, f: impl FnOnce()) {
        let msg = refusal(f);
        assert!(msg.contains(expected), "expected {expected:?} in {msg}");
    }

    /// The NEAR transfers the last call created, as (receiver, amount).
    fn transfers() -> Vec<(AccountId, NearToken)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit)),
                    _ => None,
                })
            })
            .collect()
    }

    /// What creating `alpha` for `owner()` costs, measured on a fresh chain: the mock keeps one
    /// chain per thread, so a refused attempt here would leave its desk behind.
    fn storage_cost_of_alpha() -> NearToken {
        std::thread::spawn(|| {
            called_by(contract_id());
            let mut g = testnet();
            let attached = NearToken::from_near(1);
            call(owner(), attached);
            g.create_desk("alpha".into(), policy(), EVM.into(), solana());
            let refunds = transfers();
            assert_eq!(refunds.len(), 1);
            attached.saturating_sub(refunds[0].1)
        })
        .join()
        .unwrap()
    }

    // --- new, config, version ---

    #[test]
    fn new_stores_the_config() {
        called_by(contract_id());
        let g = testnet();
        assert_eq!(g.config.network, Network::Testnet);
        assert_eq!(g.config.mpc.as_str(), "v1.signer-prod.testnet");
        assert_eq!(g.config.price_source, PriceSource::Mock);
        assert_eq!(g.config.treasury, treasury());
        assert_eq!(g.config.fees, fees());
        assert_eq!(g.config.orderly.chain_id, ARBITRUM_SEPOLIA);
        assert!(g.desks.get("alpha").is_none());
        assert!(g.desks_by_owner.get(&owner()).is_none());
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
    fn config_json() {
        called_by(contract_id());
        let g = testnet();
        assert_eq!(
            serde_json::to_string(&g.config()).unwrap(),
            r#"{"network":"Testnet","mpc":"v1.signer-prod.testnet","price_source":"Mock","treasury":{"near":"fargo","hl_builder":"0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c","referral_codes":{"hyperliquid":"TESTCODE","orderly":null,"phoenix":null}},"fees":{"performance_bps":1000,"hl_builder_tenth_bps":10},"orderly":{"broker_id":"woofi_dex","chain_id":421614}}"#
        );
    }

    #[test]
    fn version_is_the_crate_version() {
        called_by(contract_id());
        assert_eq!(testnet().version(), env!("CARGO_PKG_VERSION"));
    }

    // --- create_desk ---

    #[test]
    fn create_desk_stores_the_desk_logs_it_and_refunds_the_rest() {
        called_by(contract_id());
        let mut g = testnet();
        let attached = NearToken::from_near(1);
        call(owner(), attached);
        g.create_desk("alpha".into(), policy(), EVM.into(), solana());

        assert_eq!(
            g.get_desk("alpha".into()),
            Some(Desk::new(owner(), policy(), EVM.into(), solana()))
        );
        assert_eq!(g.desks_of(owner()), vec!["alpha".to_string()]);
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"gimbal","version":"1.0.0","event":"desk_created","data":[{{"desk_id":"alpha","owner":"alice","evm_address":"{EVM}","sol_authority":"{}"}}]}}"#,
                b58(1)
            )]
        );
        let refunds = transfers();
        assert_eq!(refunds.len(), 1);
        assert_eq!(refunds[0].0, owner());
        let cost = attached.saturating_sub(refunds[0].1);
        let byte = env::storage_byte_cost().as_yoctonear();
        assert!(cost.as_yoctonear() > 0 && cost.as_yoctonear().is_multiple_of(byte));
    }

    #[test]
    fn create_desk_accepts_exactly_its_storage_cost() {
        let cost = storage_cost_of_alpha();
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), cost);
        g.create_desk("alpha".into(), policy(), EVM.into(), solana());
        assert!(g.get_desk("alpha".into()).is_some());
        assert!(transfers().is_empty(), "nothing to refund");
    }

    #[test]
    fn create_desk_refuses_one_yocto_less_than_its_storage_cost() {
        let cost = storage_cost_of_alpha();
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), cost.saturating_sub(NearToken::from_yoctonear(1)));
        assert_refused("E_DEPOSIT: desk alpha takes ", || {
            g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        });
    }

    #[test]
    fn create_desk_refuses_no_deposit() {
        called_by(contract_id());
        let mut g = testnet();
        called_by(owner());
        assert_refused("E_DEPOSIT: ", || {
            g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        });
    }

    #[test]
    fn create_desk_refuses_a_malformed_desk_id() {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        for bad in ["", "Alpha", "a_b", "a.b", "a b", &"a".repeat(33)] {
            assert_refused("E_ARGS: desk id ", || {
                g.create_desk(bad.into(), policy(), EVM.into(), solana())
            });
        }
        assert!(g.desks_of(owner()).is_empty());
    }

    #[test]
    fn create_desk_refuses_a_malformed_evm_address() {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        for bad in [
            "0x8BA1f109551bD432803012645Ac136ddd64DBA72",
            "8ba1f109551bd432803012645ac136ddd64dba72",
            "0x8ba1f109551bd432803012645ac136ddd64dba7",
            "0x8ba1f109551bd432803012645ac136ddd64dba7z",
        ] {
            assert_refused("E_ARGS: evm_address ", || {
                g.create_desk("alpha".into(), policy(), bad.into(), solana())
            });
        }
    }

    #[test]
    fn create_desk_refuses_malformed_or_repeated_solana_accounts() {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        let mut s = solana();
        s.usdc_ata = "not-base58".into();
        assert_refused("E_ARGS: solana.usdc_ata ", || {
            g.create_desk("alpha".into(), policy(), EVM.into(), s)
        });
        let mut s = solana();
        s.authority = bs58::encode([1u8; 33]).into_string();
        assert_refused("E_ARGS: solana.authority ", || {
            g.create_desk("alpha".into(), policy(), EVM.into(), s)
        });
        let mut s = solana();
        s.phoenix_trader = s.authority.clone();
        assert_refused(
            "E_ARGS: solana.authority and solana.phoenix_trader are the same account",
            || g.create_desk("alpha".into(), policy(), EVM.into(), s),
        );
    }

    #[test]
    fn create_desk_refuses_an_invalid_policy() {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        let mut p = policy();
        p.price_band_bps = 0;
        assert_refused("E_ARGS: policy.price_band_bps 0", || {
            g.create_desk("alpha".into(), p, EVM.into(), solana())
        });
    }

    #[test]
    fn create_desk_refuses_an_existing_id() {
        let mut g = with_desk();
        for who in [owner(), stranger()] {
            call(who, NearToken::from_near(1));
            assert_refused("E_DESK_EXISTS: desk alpha exists already", || {
                g.create_desk("alpha".into(), policy(), EVM.into(), solana())
            });
        }
        assert_eq!(g.get_desk("alpha".into()).unwrap().owner, owner());
    }

    #[test]
    fn desks_of_lists_each_owners_desks_in_creation_order() {
        let mut g = with_desk();
        call(owner(), NearToken::from_near(1));
        g.create_desk("bravo".into(), policy(), EVM.into(), solana());
        call(stranger(), NearToken::from_near(1));
        g.create_desk("charlie-1".into(), policy(), EVM.into(), solana());
        assert_eq!(g.desks_of(owner()), vec!["alpha", "bravo"]);
        assert_eq!(g.desks_of(stranger()), vec!["charlie-1"]);
        assert!(g.desks_of(operator()).is_empty());
        assert_eq!(g.get_desk("charlie-1".into()).unwrap().owner, stranger());
    }

    #[test]
    fn get_desk_of_an_unknown_id_is_none() {
        let g = with_desk();
        assert_eq!(g.get_desk("bravo".into()), None);
    }

    // --- set_policy ---

    /// `policy()` with a larger cap and one unpriced symbol, and its JSON as the contract writes it.
    fn policy_2() -> Policy {
        let mut p = policy();
        p.max_notional_usd = 50;
        p.unpriced = vec!["HYPE".into()];
        p
    }

    const POLICY_2_JSON: &str = r#"{"hl_assets":[{"index":4,"symbol":"ETH","sz_decimals":4}],"phoenix_markets":[{"symbol":"SOL","orderbook":"11111111111111111111111111111111","base_lot_e8":1000000,"tick_e8":1000}],"orderly_symbols":["PERP_SOL_USDC"],"max_notional_usd":50,"price_band_bps":100,"oracle_max_age_s":60,"rescue_cap_usd_per_hour":50,"max_transfer_cost_bps":100,"max_transfer_cost_flat_e6":500000,"unpriced":["HYPE"],"unpriced_max_notional_usd":100}"#;

    /// sha256 of [`POLICY_2_JSON`], computed outside Rust as
    /// `sha256(JSON.stringify(JSON.parse(POLICY_2_JSON)))`, which gives back the same bytes.
    const POLICY_2_SHA256: &str =
        "159187a1835ef294181f0ecee01a9b0c59d5c6758f927ea2987d4bdf0290b5e7";

    #[test]
    fn policy_sha256_hashes_the_json_get_desk_returns() {
        called_by(contract_id());
        assert_eq!(serde_json::to_string(&policy_2()).unwrap(), POLICY_2_JSON);
        assert_eq!(policy_sha256(&policy_2()), POLICY_2_SHA256);
    }

    #[test]
    fn owner_sets_the_policy_and_its_sha256_is_logged() {
        let mut g = with_desk();
        called_by(owner());
        g.set_policy("alpha".into(), policy_2());
        assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy_2());
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"gimbal","version":"1.0.0","event":"policy_set","data":[{{"desk_id":"alpha","policy_sha256":"{POLICY_2_SHA256}"}}]}}"#
            )]
        );
    }

    #[test]
    fn set_policy_is_for_the_owner_only() {
        let mut g = with_desk();
        called_by(operator());
        assert_refused(
            "E_NOT_ALLOWED: set_policy on desk alpha is for its owner; bob is its operator",
            || g.set_policy("alpha".into(), policy_2()),
        );
        called_by(stranger());
        assert_refused(
            "E_NOT_ALLOWED: set_policy on desk alpha is for its owner; charlie is not",
            || g.set_policy("alpha".into(), policy_2()),
        );
        called_by(owner());
        assert_refused("E_NO_DESK: no desk ", || {
            g.set_policy("bravo".into(), policy_2())
        });
        let mut bad = policy_2();
        bad.oracle_max_age_s = 0;
        assert_refused("E_ARGS: policy.oracle_max_age_s 0", || {
            g.set_policy("alpha".into(), bad)
        });
        assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy());
    }

    #[test]
    fn owner_sets_the_policy_of_a_paused_desk() {
        let mut g = with_desk();
        called_by(owner());
        g.set_paused("alpha".into(), true);
        g.set_policy("alpha".into(), policy_2());
        assert_eq!(g.get_desk("alpha".into()).unwrap().policy, policy_2());
    }

    // --- set_operator ---

    #[test]
    fn owner_sets_and_clears_the_operator() {
        called_by(contract_id());
        let mut g = testnet();
        call(owner(), NearToken::from_near(1));
        g.create_desk("alpha".into(), policy(), EVM.into(), solana());
        called_by(owner());
        g.set_operator("alpha".into(), Some(operator()));
        assert_eq!(
            g.get_desk("alpha".into()).unwrap().operator,
            Some(operator())
        );
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"operator_set","data":[{"desk_id":"alpha","operator":"bob"}]}"#
            ]
        );
        called_by(owner());
        g.set_operator("alpha".into(), None);
        assert_eq!(g.get_desk("alpha".into()).unwrap().operator, None);
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"gimbal","version":"1.0.0","event":"operator_set","data":[{"desk_id":"alpha","operator":null}]}"#
            ]
        );
    }

    #[test]
    fn set_operator_is_for_the_owner_only() {
        let mut g = with_desk();
        called_by(operator());
        assert_refused(
            "E_NOT_ALLOWED: set_operator on desk alpha is for its owner; bob is its operator",
            || g.set_operator("alpha".into(), Some(operator())),
        );
        called_by(stranger());
        assert_refused(
            "E_NOT_ALLOWED: set_operator on desk alpha is for its owner; charlie is not",
            || g.set_operator("alpha".into(), Some(stranger())),
        );
        called_by(owner());
        assert_refused("E_NO_DESK: no desk ", || {
            g.set_operator("bravo".into(), None)
        });
        assert_eq!(
            g.get_desk("alpha".into()).unwrap().operator,
            Some(operator())
        );
    }

    #[test]
    fn a_cleared_operator_has_no_role() {
        let mut g = with_desk();
        called_by(owner());
        g.set_operator("alpha".into(), None);
        called_by(operator());
        assert_refused(
            "E_NOT_ALLOWED: bob is neither the owner nor the operator of desk alpha",
            || g.set_paused("alpha".into(), true),
        );
        assert_refused("E_NOT_ALLOWED: ", || {
            action_desk(&mut g.desks, "alpha");
        });
    }

    // --- set_paused ---

    fn paused_log(paused: bool, by: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"gimbal","version":"1.0.0","event":"paused","data":[{{"desk_id":"alpha","paused":{paused},"by":"{by}"}}]}}"#
        )
    }

    #[test]
    fn owner_pauses_and_unpauses() {
        let mut g = with_desk();
        called_by(owner());
        g.set_paused("alpha".into(), true);
        assert!(g.get_desk("alpha".into()).unwrap().paused);
        assert_eq!(get_logs(), vec![paused_log(true, "alice")]);
        called_by(owner());
        g.set_paused("alpha".into(), false);
        assert!(!g.get_desk("alpha".into()).unwrap().paused);
        assert_eq!(get_logs(), vec![paused_log(false, "alice")]);
    }

    #[test]
    fn setting_the_current_state_logs_nothing() {
        let mut g = with_desk();
        called_by(owner());
        g.set_paused("alpha".into(), false);
        assert!(get_logs().is_empty());
        g.set_paused("alpha".into(), true);
        called_by(operator());
        g.set_paused("alpha".into(), true);
        assert!(
            get_logs().is_empty(),
            "the owner's pause stays the one logged"
        );
    }

    #[test]
    fn operator_may_pause_but_never_unpause() {
        let mut g = with_desk();
        called_by(operator());
        g.set_paused("alpha".into(), true);
        assert!(g.get_desk("alpha".into()).unwrap().paused);
        assert_eq!(get_logs(), vec![paused_log(true, "bob")]);
        called_by(operator());
        assert_refused(
            "E_NOT_ALLOWED: the operator may pause desk alpha but never unpause it; only its owner can",
            || g.set_paused("alpha".into(), false),
        );
        assert!(g.get_desk("alpha".into()).unwrap().paused);
        called_by(owner());
        g.set_paused("alpha".into(), false);
        assert!(!g.get_desk("alpha".into()).unwrap().paused);
    }

    #[test]
    fn operator_may_not_unpause_even_a_running_desk() {
        let mut g = with_desk();
        called_by(operator());
        assert_refused("E_NOT_ALLOWED: the operator may pause desk alpha", || {
            g.set_paused("alpha".into(), false)
        });
    }

    #[test]
    fn a_stranger_may_not_pause_and_an_unknown_desk_is_refused() {
        let mut g = with_desk();
        called_by(stranger());
        for paused in [true, false] {
            assert_refused(
                "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
                || g.set_paused("alpha".into(), paused),
            );
        }
        assert!(!g.get_desk("alpha".into()).unwrap().paused);
        called_by(owner());
        assert_refused("E_NO_DESK: no desk ", || g.set_paused("bravo".into(), true));
    }

    // --- the action guard ---

    #[test]
    fn owner_and_operator_pass_the_action_guard_on_a_running_desk() {
        let mut g = with_desk();
        called_by(owner());
        assert_eq!(action_desk(&mut g.desks, "alpha").1, Role::Owner);
        called_by(operator());
        let (desk, role) = action_desk(&mut g.desks, "alpha");
        assert_eq!(role, Role::Operator);
        assert_eq!(desk.evm_address, EVM);
    }

    #[test]
    fn the_action_guard_refuses_a_stranger() {
        let mut g = with_desk();
        called_by(stranger());
        assert_refused(
            "E_NOT_ALLOWED: charlie is neither the owner nor the operator of desk alpha",
            || {
                action_desk(&mut g.desks, "alpha");
            },
        );
    }

    #[test]
    fn the_action_guard_refuses_everyone_on_a_paused_desk() {
        let mut g = with_desk();
        called_by(operator());
        g.set_paused("alpha".into(), true);
        for who in [owner(), operator()] {
            called_by(who);
            assert_refused(
                "E_PAUSED: desk alpha is paused; only its owner can unpause it",
                || {
                    action_desk(&mut g.desks, "alpha");
                },
            );
        }
        // The role comes first: a stranger learns nothing about the pause.
        called_by(stranger());
        assert_refused("E_NOT_ALLOWED: ", || {
            action_desk(&mut g.desks, "alpha");
        });
        called_by(owner());
        g.set_paused("alpha".into(), false);
        assert_eq!(action_desk(&mut g.desks, "alpha").1, Role::Owner);
    }

    #[test]
    fn the_action_guard_refuses_an_unknown_desk() {
        let mut g = with_desk();
        called_by(owner());
        assert_refused("E_NO_DESK: no desk ", || {
            action_desk(&mut g.desks, "bravo");
        });
    }

    // --- fail / or_fail (C1) ---

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
