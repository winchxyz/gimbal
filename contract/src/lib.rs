//! The Gimbal NEAR contract: it owns each desk's venue accounts through Chain Signatures, builds every
//! payload itself, checks it against the owner's policy and only then asks the MPC network to sign.
//!
//! Rules that need no chain state live in `gimbal-core`; this crate holds state, roles, MPC calls and
//! events, and turns a core [`Refusal`] into the panic `"E_CODE: msg"` with [`fail`].

pub mod action;
pub mod config;
pub mod deposit;
pub mod desk;
pub mod events;
pub mod hl;
pub mod mpc;
pub mod prices;

pub use gimbal_core::Refusal;

use gimbal_core::errors::{shown, E_ARGS, E_DESK_EXISTS, E_NO_DESK};
use gimbal_core::ids::{check_desk_id, check_evm_address, decode_base58_32};
use gimbal_core::policy::Policy;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

use crate::config::{Config, FeeConfig, Network, OrderlyConfig, PriceSource, Treasury};
use crate::deposit::{check_one_yocto, check_pause_deposit, check_some_deposit, refund_after};
use crate::desk::{policy_sha256, Desk, Gate, Role, SolanaAccounts};
use crate::events::{DeskCreated, Event, OperatorSet, Paused, PolicySet};

/// Gas `on_desk_keys` gets besides its share of what `create_desk` leaves unused: it reads two keys,
/// hashes one, and writes the desk, or schedules the refund and [`Gimbal::refuse`].
pub const ON_DESK_KEYS_GAS: Gas = Gas::from_tgas(20);

/// Gas for [`Gimbal::refuse`], which only panics.
pub const REFUSE_GAS: Gas = Gas::from_tgas(5);

/// What `create_desk` uses itself besides the gas it attaches, measured on testnet on 2026-10-30
/// with a one-asset policy: it burnt 3.33 and 3.38 TGas, and prepays the execution fees of the
/// three receipts it creates (1.8 TGas: with 60 TGas attached the callback got 24.8). Rounded up.
pub const CREATE_DESK_GAS: Gas = Gas::from_tgas(6);

/// The least prepaid gas `create_desk` accepts (`E_ARGS` below it): its own cost, the two MPC calls
/// and the callback, 56 TGas. Clients attach 100 TGas; a shorter call would otherwise fail on the
/// host's gas error with no code to match on.
pub const CREATE_DESK_MIN_GAS: Gas = Gas::from_gas(
    CREATE_DESK_GAS.as_gas() + 2 * mpc::DERIVE_GAS.as_gas() + ON_DESK_KEYS_GAS.as_gas(),
);

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
    DeskCounts,
    DeskIds,
    HlNonces,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Gimbal {
    config: Config,
    desks: LookupMap<String, Desk>,
    /// How many desks each owner has.
    desk_counts: LookupMap<AccountId, u32>,
    /// `(owner, n)` → the id of the owner's `n`-th desk, from 0, for `desks_of`. One entry per desk,
    /// so adding a desk writes the same few bytes however many the owner has.
    desk_ids: LookupMap<(AccountId, u32), String>,
    /// Desk id → the last nonce its master address was given to sign on Hyperliquid (ms, 0 before
    /// the first); the next one is `max(block_ms, last + 1)`. Kept out of [`Desk`], so an action
    /// writes these few bytes and never rewrites the desk record with its policy. `create_desk`
    /// stores the 0, so the owner pays the entry's storage and an action never adds any.
    hl_nonces: LookupMap<String, u64>,
}

#[near]
impl Gimbal {
    /// Sets the configuration once, at deploy. Private: only the contract account itself can
    /// initialise it, so nobody can front-run the deploy with their own treasury or fees.
    #[init]
    #[private]
    #[deny_unknown_arguments]
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
            desk_counts: LookupMap::new(StorageKey::DeskCounts),
            desk_ids: LookupMap::new(StorageKey::DeskIds),
            hl_nonces: LookupMap::new(StorageKey::HlNonces),
        }
    }

    /// Creates a desk owned by the caller once the MPC contract confirms its addresses.
    /// `evm_address` and `solana` are the desk's MPC-derived venue accounts and can never change.
    ///
    /// Attach the storage the desk takes (`E_DEPOSIT` below it; no deposit at all is
    /// `E_NOT_ALLOWED`) and about 100 TGas (`E_ARGS` below [`CREATE_DESK_MIN_GAS`]). The call asks
    /// the MPC contract's `derived_public_key` for `gimbal/<desk_id>/evm` and `gimbal/<desk_id>/sol`
    /// and stores nothing itself; [`Self::on_desk_keys`] stores the desk, refunds the excess and
    /// emits `desk_created` and `policy_set`, or refunds everything and fails. The transaction's
    /// result is that callback's: `true`, or the refusal.
    #[payable]
    #[deny_unknown_arguments]
    pub fn create_desk(
        &mut self,
        desk_id: String,
        policy: Policy,
        evm_address: String,
        solana: SolanaAccounts,
    ) -> Promise {
        let attached = env::attached_deposit();
        check_some_deposit("create_desk", attached).or_fail();
        check_create_desk_gas(env::prepaid_gas()).or_fail();
        let owner = env::predecessor_account_id();
        let contract = env::current_account_id();
        self.config
            .check_not_reserved(&contract, "owner", &owner)
            .or_fail();
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

        let desk = Desk::new(owner, policy, evm_address, solana);
        // A short deposit is refused here, before the MPC calls: write the desk, measure, undo.
        let added = self.write_desk(&desk_id, &desk);
        self.unwrite_desk(&desk_id, &desk.owner);
        refund_after(
            &format!("desk {desk_id}"),
            added,
            env::storage_byte_cost(),
            attached,
        )
        .or_fail();

        mpc::desk_keys(&self.config.mpc, &desk_id, &contract).then(
            Self::ext(contract)
                .with_static_gas(ON_DESK_KEYS_GAS)
                .with_unused_gas_weight(1)
                .on_desk_keys(desk_id, desk, attached),
        )
    }

    /// The callback of `create_desk`. When the MPC keys give the desk's `evm_address` and Solana
    /// authority and the id is still free, it stores the desk, keeps its storage out of `attached`,
    /// refunds the rest, emits `desk_created` and `policy_set` and returns `true`. Otherwise
    /// (`E_MPC`, `E_ARGS`, `E_DESK_EXISTS` or `E_DEPOSIT`) it stores nothing, refunds all of
    /// `attached` and returns [`Self::refuse`] with the refusal, so the transaction ends as that
    /// failure. It never panics itself: a failed callback would keep the deposit.
    #[private]
    pub fn on_desk_keys(
        &mut self,
        desk_id: String,
        desk: Desk,
        attached: NearToken,
    ) -> PromiseOrValue<bool> {
        match self.store_checked_desk(&desk_id, &desk, attached) {
            Ok(refund) => {
                refund_to(&desk.owner, refund);
                DeskCreated {
                    desk_id: &desk_id,
                    owner: &desk.owner,
                    evm_address: &desk.evm_address,
                    sol_authority: &desk.solana.authority,
                }
                .emit();
                PolicySet {
                    desk_id: &desk_id,
                    policy_sha256: &policy_sha256(&desk.policy),
                }
                .emit();
                PromiseOrValue::Value(true)
            }
            Err(refusal) => {
                refund_to(&desk.owner, attached);
                PromiseOrValue::Promise(
                    Self::ext(env::current_account_id())
                        .with_static_gas(REFUSE_GAS)
                        .refuse(refusal.to_string()),
                )
            }
        }
    }

    /// Ends the transaction as `refusal` (`"E_CODE: msg"`). A callback that must not panic, since
    /// that would undo the refund it scheduled, returns a call to this instead, so a wallet shows
    /// the refused call as failed and not as a success.
    #[private]
    pub fn refuse(&self, refusal: String) {
        env::panic_str(&refusal)
    }

    /// Replaces the desk's policy. Owner only, allowed while the desk is paused. Attach the storage
    /// a larger policy adds (at least 1 yoctoNEAR); the rest is refunded.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_policy(&mut self, desk_id: String, policy: Policy) {
        let attached = env::attached_deposit();
        let desk = owner_desk_mut(&mut self.desks, &desk_id, "set_policy");
        check_some_deposit("set_policy", attached).or_fail();
        policy.validate().or_fail();
        let sha = policy_sha256(&policy);
        let before = env::storage_usage();
        desk.policy = policy;
        self.desks.flush();
        charge_storage(before, &format!("set_policy on desk {desk_id}"), attached);
        PolicySet {
            desk_id: &desk_id,
            policy_sha256: &sha,
        }
        .emit();
    }

    /// Sets the separate operator account, or clears it with `null`. Owner only. Attach the storage
    /// a longer account id adds (at least 1 yoctoNEAR); the rest is refunded.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_operator(&mut self, desk_id: String, operator: Option<AccountId>) {
        let attached = env::attached_deposit();
        let desk = owner_desk_mut(&mut self.desks, &desk_id, "set_operator");
        check_some_deposit("set_operator", attached).or_fail();
        if let Some(account) = &operator {
            self.config
                .check_not_reserved(&env::current_account_id(), "operator", account)
                .or_fail();
        }
        let before = env::storage_usage();
        desk.operator = operator.clone();
        self.desks.flush();
        charge_storage(before, &format!("set_operator on desk {desk_id}"), attached);
        OperatorSet {
            desk_id: &desk_id,
            operator: operator.as_ref(),
        }
        .emit();
    }

    /// Pauses or unpauses the desk. The owner may do both, the operator only pause. Pausing takes no
    /// deposit (or 1 yoctoNEAR), so the engine's key can pause; unpausing needs exactly 1 yoctoNEAR,
    /// so only the owner's wallet can. Setting the state the desk is already in changes nothing and
    /// logs nothing.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_paused(&mut self, desk_id: String, paused: bool) {
        let by = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let desk = desk_mut(&mut self.desks, &desk_id);
        desk.check_set_paused(&desk_id, &by, paused).or_fail();
        if paused {
            check_pause_deposit(attached)
        } else {
            check_one_yocto("set_paused(false)", attached)
        }
        .or_fail();
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
        let count = self.desk_counts.get(&owner).copied().unwrap_or(0);
        (0..count)
            .filter_map(|n| self.desk_ids.get(&(owner.clone(), n)).cloned())
            .collect()
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

impl Gimbal {
    /// The checks of [`Self::on_desk_keys`], then the write. Returns the part of `attached` to
    /// refund; on a refusal nothing is left written.
    fn store_checked_desk(
        &mut self,
        desk_id: &str,
        desk: &Desk,
        attached: NearToken,
    ) -> Result<NearToken, Refusal> {
        let evm_address = mpc::evm_address(&mpc::answer(mpc::EVM_RESULT, "EVM")?)?;
        let sol_authority = mpc::sol_authority(&mpc::answer(mpc::SOL_RESULT, "Solana")?)?;
        if desk.evm_address != evm_address {
            return Err(Refusal::new(
                E_ARGS,
                format!(
                    "evm_address {} is not the MPC address of desk {desk_id}, {evm_address}",
                    desk.evm_address
                ),
            ));
        }
        // Base58 has one spelling per key, so comparing the bytes compares the strings.
        if decode_base58_32(&desk.solana.authority) != Some(sol_authority) {
            return Err(Refusal::new(
                E_ARGS,
                format!(
                    "solana.authority {} is not the MPC key of desk {desk_id}, {}",
                    desk.solana.authority,
                    bs58::encode(sol_authority).into_string()
                ),
            ));
        }
        if self.desks.contains_key(desk_id) {
            return Err(Refusal::new(
                E_DESK_EXISTS,
                format!("desk {desk_id} was created while its addresses were checked"),
            ));
        }
        let added = self.write_desk(desk_id, desk);
        let refund = refund_after(
            &format!("desk {desk_id}"),
            added,
            env::storage_byte_cost(),
            attached,
        );
        if refund.is_err() {
            self.unwrite_desk(desk_id, &desk.owner);
        }
        refund
    }

    /// Stores the desk and its nonce entry and appends its id to the owner's ids; returns the
    /// bytes that took.
    fn write_desk(&mut self, desk_id: &str, desk: &Desk) -> u64 {
        let before = env::storage_usage();
        self.desks.insert(desk_id.to_owned(), desk.clone());
        self.hl_nonces.insert(desk_id.to_owned(), 0);
        let n = self.desk_counts.get(&desk.owner).copied().unwrap_or(0);
        self.desk_ids
            .insert((desk.owner.clone(), n), desk_id.to_owned());
        self.desk_counts.insert(desk.owner.clone(), n + 1);
        self.flush_desks();
        env::storage_usage().saturating_sub(before)
    }

    /// Undoes [`Self::write_desk`] in the same call. Desks are never deleted, so the owner's last
    /// id is the one that write added, and a count that drops to 0 was created by it.
    fn unwrite_desk(&mut self, desk_id: &str, owner: &AccountId) {
        self.desks.remove(desk_id);
        self.hl_nonces.remove(desk_id);
        let count = self.desk_counts.get(owner).copied().unwrap_or(0);
        if let Some(last) = count.checked_sub(1) {
            self.desk_ids.remove(&(owner.clone(), last));
            if last == 0 {
                self.desk_counts.remove(owner);
            } else {
                self.desk_counts.insert(owner.clone(), last);
            }
        }
        self.flush_desks();
    }

    /// The maps write on flush; flushing now makes the bytes measurable within this call.
    fn flush_desks(&mut self) {
        self.desks.flush();
        self.hl_nonces.flush();
        self.desk_counts.flush();
        self.desk_ids.flush();
    }
}

/// `E_ARGS` when `create_desk` came with less than [`CREATE_DESK_MIN_GAS`].
pub fn check_create_desk_gas(prepaid: Gas) -> Result<(), Refusal> {
    if prepaid >= CREATE_DESK_MIN_GAS {
        return Ok(());
    }
    Err(Refusal::new(
        E_ARGS,
        format!(
            "create_desk needs at least {} TGas attached (100 TGas recommended), not {}",
            CREATE_DESK_MIN_GAS.as_tgas(),
            prepaid.as_tgas()
        ),
    ))
}

/// Sends `amount` back, unless it is zero.
fn refund_to(account: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(account.clone()).transfer(amount).detach();
    }
}

/// The end of a storage method, after its writes are flushed: keeps the storage added since
/// `before` (at least 1 yoctoNEAR) out of `attached`, or `E_DEPOSIT`, and refunds the rest to the
/// caller. Storage freed is not paid back.
fn charge_storage(before: u64, what: &str, attached: NearToken) {
    let added = env::storage_usage().saturating_sub(before);
    let refund = refund_after(what, added, env::storage_byte_cost(), attached).or_fail();
    refund_to(&env::predecessor_account_id(), refund);
}

/// `E_NO_DESK` for `desk_id`.
fn no_desk(desk_id: &str) -> ! {
    fail(Refusal::new(
        E_NO_DESK,
        format!("no desk {}", shown(desk_id)),
    ))
}

/// The desk `desk_id`, or `E_NO_DESK`, to read. Takes the map rather than the contract so a
/// method can hold the desk and still use the other fields. Reading leaves the stored record as
/// it is; [`desk_mut`] marks it to be written back.
pub fn desk_ref<'a>(desks: &'a LookupMap<String, Desk>, desk_id: &str) -> &'a Desk {
    desks.get(desk_id).unwrap_or_else(|| no_desk(desk_id))
}

/// The desk `desk_id`, or `E_NO_DESK`, to change: the whole record is written back at the end of
/// the call.
pub fn desk_mut<'a>(desks: &'a mut LookupMap<String, Desk>, desk_id: &str) -> &'a mut Desk {
    desks.get_mut(desk_id).unwrap_or_else(|| no_desk(desk_id))
}

/// The desk of an owner method that changes it, after `E_NO_DESK` and `E_NOT_ALLOWED` (anyone but
/// the owner).
pub fn owner_desk_mut<'a>(
    desks: &'a mut LookupMap<String, Desk>,
    desk_id: &str,
    method: &str,
) -> &'a mut Desk {
    let desk = desk_mut(desks, desk_id);
    desk.check_owner(desk_id, &env::predecessor_account_id(), method)
        .or_fail();
    desk
}

/// [`owner_desk_mut`] for an owner method that only reads the desk.
pub fn owner_desk<'a>(desks: &'a LookupMap<String, Desk>, desk_id: &str, method: &str) -> &'a Desk {
    let desk = desk_ref(desks, desk_id);
    desk.check_owner(desk_id, &env::predecessor_account_id(), method)
        .or_fail();
    desk
}

/// The guard every action method calls first: the desk exists (`E_NO_DESK`), the caller is its
/// owner or operator (`E_NOT_ALLOWED`), and, for a [`Gate::Running`] action, it is not paused
/// (`E_PAUSED`). Returns the desk, read only (an action never rewrites the desk record), and the
/// caller's role.
pub fn action_desk<'a>(
    desks: &'a LookupMap<String, Desk>,
    desk_id: &str,
    gate: Gate,
) -> (&'a Desk, Role) {
    let desk = desk_ref(desks, desk_id);
    let role = desk
        .check_action(desk_id, &env::predecessor_account_id(), gate)
        .or_fail();
    (desk, role)
}

/// The desk's next Hyperliquid nonce, `max(block_ms, last + 1)`, which it records as used.
pub fn take_hl_nonce(nonces: &mut LookupMap<String, u64>, desk_id: &str, block_ms: u64) -> u64 {
    let last = nonces.get(desk_id).copied().unwrap_or(0);
    let next = gimbal_core::hl::next_nonce(block_ms, last);
    nonces.insert(desk_id.to_owned(), next);
    next
}

#[cfg(test)]
mod tests;
