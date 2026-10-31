//! A desk: one owner's trading accounts on the venues, the policy they trade under and the money
//! the contract holds for them (docs/interfaces.md §1.2), and who may call what on it (§1.3).

use gimbal_core::errors::{Refusal, E_ARGS, E_NOT_ALLOWED, E_PAUSED};
use gimbal_core::ids::check_base58_32;
use gimbal_core::policy::Policy;
use gimbal_core::solana::{b58, SolDesk};
use near_sdk::{env, near, serde_json, AccountId};

use crate::sol::sha256;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Desk {
    /// Controls the desk; only the owner's wallet signs owner methods.
    pub owner: AccountId,
    /// Optional separate account that may call operator methods.
    pub operator: Option<AccountId>,
    pub paused: bool,
    pub policy: Policy,
    /// Hyperliquid master, Orderly account owner and EIP-3009 `from`: the MPC secp256k1 key at
    /// `gimbal/<desk_id>/evm`, lowercase `0x` address. Never changes.
    pub evm_address: String,
    /// Registered by the owner and checked against the authority's derived accounts; the Solana
    /// methods derive them again and never read the stored ones.
    pub solana: SolanaAccounts,
    /// The desk's Orderly account id under `OrderlyConfig.broker_id`, lowercase `0x` hex:
    /// keccak256(abi.encode(evm_address, keccak256(broker_id))), known before registration, the
    /// `orderly-account-id` header of every request. Never changes.
    pub orderly_account_id: String,
    /// The Orderly account's exclusive receiver address on Arbitrum, pinned once by the owner.
    pub orderly_receiver: Option<String>,
    pub ledger: Ledger,
}

/// The desk's Solana accounts, base58. `authority` is the MPC Ed25519 key at `gimbal/<desk_id>/sol`,
/// which is also the desk's Orderly key.
#[near(serializers = [borsh, json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaAccounts {
    pub authority: String,
    pub usdc_ata: String,
    pub phusd_ata: String,
    pub phoenix_trader: String,
}

/// USDC in 1e-6. Money in and out passes through the contract on NEAR.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Ledger {
    /// Principal: only the owner's own deposits (the base of the high-water mark).
    pub deposited: u128,
    pub withdrawn: u128,
    pub fees_paid: u128,
    pub hwm: u128,
    /// USDC on NEAR held for the desk: owner deposits not yet sent out, plus 1Click returns and
    /// refunds. `fund_venue` and `withdraw_to_owner` spend from it.
    pub idle_usdc: u128,
}

/// What the caller is to a desk (docs/interfaces.md §1.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The desk's owner account. The engine's function-call key on that account signs as the owner
    /// too: the contract sees only the account, so what that key may call is bounded by the key's
    /// method list alone, and among operator methods it is the owner (it can unpause).
    Owner,
    /// The separate account set with `set_operator`.
    Operator,
}

/// Whether an action method runs on a paused desk (docs/interfaces.md §1.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Opens or grows risk: refused on a paused desk (`E_PAUSED`).
    Running,
    /// Only reduces risk, which `panic_close` and a rescue rely on: reduce-only orders, cancels and
    /// rescue transfers. Allowed on a paused desk.
    ReducesRisk,
}

impl Gate {
    /// The gate of an order: a reduce-only one passes a paused desk, any other is refused there.
    pub const fn order(reduce_only: bool) -> Self {
        if reduce_only {
            Gate::ReducesRisk
        } else {
            Gate::Running
        }
    }
}

impl Desk {
    /// A new, running desk with no operator, no Orderly receiver and an empty ledger, its Orderly
    /// account id that of `evm_address` (checked by the caller) under `broker_id`.
    pub fn new(
        owner: AccountId,
        policy: Policy,
        evm_address: String,
        solana: SolanaAccounts,
        broker_id: &str,
    ) -> Self {
        Self {
            owner,
            operator: None,
            paused: false,
            policy,
            orderly_account_id: crate::orderly::orderly_account_id(&evm_address, broker_id),
            evm_address,
            solana,
            orderly_receiver: None,
            ledger: Ledger::default(),
        }
    }

    /// The caller's role, if any. An operator set to the owner's own account stays the owner.
    pub fn role_of(&self, caller: &AccountId) -> Option<Role> {
        if *caller == self.owner {
            Some(Role::Owner)
        } else if self.operator.as_ref() == Some(caller) {
            Some(Role::Operator)
        } else {
            None
        }
    }

    /// Owner methods (`set_policy`, `set_operator`, …): the owner only, on a running or paused desk.
    pub fn check_owner(
        &self,
        desk_id: &str,
        caller: &AccountId,
        method: &str,
    ) -> Result<(), Refusal> {
        match self.role_of(caller) {
            Some(Role::Owner) => Ok(()),
            Some(Role::Operator) => Err(Refusal::new(
                E_NOT_ALLOWED,
                format!("{method} on desk {desk_id} is for its owner; {caller} is its operator"),
            )),
            None => Err(Refusal::new(
                E_NOT_ALLOWED,
                format!("{method} on desk {desk_id} is for its owner; {caller} is not"),
            )),
        }
    }

    /// `set_paused`: the owner either way; the operator may pause, never unpause.
    pub fn check_set_paused(
        &self,
        desk_id: &str,
        caller: &AccountId,
        paused: bool,
    ) -> Result<Role, Refusal> {
        match self.role_of(caller) {
            Some(Role::Owner) => Ok(Role::Owner),
            Some(Role::Operator) if paused => Ok(Role::Operator),
            Some(Role::Operator) => Err(Refusal::new(
                E_NOT_ALLOWED,
                format!("the operator may pause desk {desk_id} but never unpause it; only its owner can"),
            )),
            None => Err(self.stranger(desk_id, caller)),
        }
    }

    /// The check every action method makes before anything else: the owner or the operator
    /// (`E_NOT_ALLOWED`), then, for a [`Gate::Running`] action, a running desk (`E_PAUSED`). A pause
    /// stops the owner's actions too; actions that only reduce risk pass it.
    pub fn check_action(
        &self,
        desk_id: &str,
        caller: &AccountId,
        gate: Gate,
    ) -> Result<Role, Refusal> {
        let role = self
            .role_of(caller)
            .ok_or_else(|| self.stranger(desk_id, caller))?;
        if self.paused && gate == Gate::Running {
            return Err(Refusal::new(
                E_PAUSED,
                format!("desk {desk_id} is paused; only its owner can unpause it"),
            ));
        }
        Ok(role)
    }

    fn stranger(&self, desk_id: &str, caller: &AccountId) -> Refusal {
        Refusal::new(
            E_NOT_ALLOWED,
            format!("{caller} is neither the owner nor the operator of desk {desk_id}"),
        )
    }
}

impl SolanaAccounts {
    /// Each field a base58 address of 32 bytes, and the three accounts the ones the authority
    /// derives, as Solana's runtime derives them (`E_ARGS`): its associated token accounts for
    /// USDC and PhUSD and its Phoenix trader account (index 0). Returns the derived accounts.
    pub fn check(&self) -> Result<SolDesk, Refusal> {
        let authority = check_base58_32("solana.authority", &self.authority)?;
        let fields = [
            ("usdc_ata", &self.usdc_ata),
            ("phusd_ata", &self.phusd_ata),
            ("phoenix_trader", &self.phoenix_trader),
        ];
        let mut given = [[0u8; 32]; 3];
        for ((name, value), bytes) in fields.iter().zip(given.iter_mut()) {
            *bytes = check_base58_32(&format!("solana.{name}"), value)?;
        }
        let desk = SolDesk::derive(sha256, authority)?;
        let derived = [
            (desk.usdc_ata, "USDC token account"),
            (desk.phusd_ata, "PhUSD token account"),
            (desk.trader, "Phoenix trader account"),
        ];
        for (((name, value), bytes), (want, what)) in fields.iter().zip(given).zip(derived) {
            if bytes != want {
                return Err(Refusal::new(
                    E_ARGS,
                    format!(
                        "solana.{name} {value} is not the {what} of solana.authority {}, {}",
                        self.authority,
                        b58(&want)
                    ),
                ));
            }
        }
        Ok(desk)
    }
}

/// The `policy_sha256` of the `policy_set` event: lowercase hex SHA-256 of the policy's JSON exactly
/// as the contract writes it (fields in `Policy` order, no spaces), which is what `get_desk` returns.
/// A client recomputes it as `sha256(JSON.stringify(desk.policy))` on that view.
pub fn policy_sha256(policy: &Policy) -> String {
    // Serialising plain structs of strings and integers cannot fail.
    let json = serde_json::to_vec(policy).unwrap_or_else(|_| env::abort());
    hex::encode(env::sha256_array(json))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The testnet desk's MPC key and the accounts it derives (checked independently with
    /// web3.js-equivalent derivation: bumps 254, 255 and 252).
    fn solana() -> SolanaAccounts {
        SolanaAccounts {
            authority: "31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd".into(),
            usdc_ata: "5EbDUDCy2ycULpJ4xDCmrDJ3zqVpshLLm46BQpYXLDAU".into(),
            phusd_ata: "4mVZb1tNA7QGWXnqFhT4yfuBAi8Ff5mHWs2otZwuH5Et".into(),
            phoenix_trader: "FgXaTCYWdnqYPd7cCPruqbggfHbNCs4EGqmrxBePz9A8".into(),
        }
    }

    fn refused(s: SolanaAccounts) -> String {
        let r = s.check().expect_err("should be refused");
        assert_eq!(r.code, E_ARGS);
        r.msg
    }

    #[test]
    fn only_reduce_only_orders_pass_a_pause() {
        assert_eq!(Gate::order(true), Gate::ReducesRisk);
        assert_eq!(Gate::order(false), Gate::Running);
    }

    #[test]
    fn the_derived_solana_accounts_pass() {
        let s = solana();
        let desk = s.check().unwrap();
        assert_eq!(b58(&desk.authority), s.authority);
        assert_eq!(b58(&desk.usdc_ata), s.usdc_ata);
        assert_eq!(b58(&desk.phusd_ata), s.phusd_ata);
        assert_eq!(b58(&desk.trader), s.phoenix_trader);
    }

    #[test]
    fn every_solana_field_is_checked() {
        let mut s = solana();
        s.authority = "0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c".into();
        assert!(refused(s).starts_with("solana.authority "));
        let mut s = solana();
        s.usdc_ata = bs58::encode([2u8; 31]).into_string();
        assert!(refused(s).starts_with("solana.usdc_ata "));
        let mut s = solana();
        s.phusd_ata = String::new();
        assert!(refused(s).starts_with("solana.phusd_ata "));
        let mut s = solana();
        s.phoenix_trader = format!("{}O", s.phoenix_trader);
        assert!(refused(s).starts_with("solana.phoenix_trader "));
    }

    #[test]
    fn each_account_must_be_the_one_the_authority_derives() {
        let mut s = solana();
        s.usdc_ata = s.phusd_ata.clone();
        assert_eq!(
            refused(s),
            "solana.usdc_ata 4mVZb1tNA7QGWXnqFhT4yfuBAi8Ff5mHWs2otZwuH5Et is not the USDC token \
             account of solana.authority 31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd, \
             5EbDUDCy2ycULpJ4xDCmrDJ3zqVpshLLm46BQpYXLDAU"
        );
        let mut s = solana();
        s.phusd_ata = s.authority.clone();
        assert!(refused(s).starts_with("solana.phusd_ata 31wj7"));
        let mut s = solana();
        s.phoenix_trader = bs58::encode([4u8; 32]).into_string();
        assert!(refused(s).contains(" is not the Phoenix trader account of solana.authority "));
        // Another authority's accounts are not this one's.
        let mut s = solana();
        s.authority = bs58::encode([1u8; 32]).into_string();
        assert!(refused(s).starts_with("solana.usdc_ata 5EbDUD"));
    }
}
