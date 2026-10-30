//! A desk: one owner's trading accounts on the venues, the policy they trade under and the money
//! the contract holds for them (docs/interfaces.md §1.2), and who may call what on it (§1.3).

use gimbal_core::errors::{Refusal, E_ARGS, E_NOT_ALLOWED, E_PAUSED};
use gimbal_core::ids::check_base58_32;
use gimbal_core::policy::Policy;
use near_sdk::{env, near, serde_json, AccountId};

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
    /// Registered by the owner; the Solana programs enforce them.
    pub solana: SolanaAccounts,
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

impl Desk {
    /// A new, running desk with no operator, no Orderly receiver and an empty ledger.
    pub fn new(
        owner: AccountId,
        policy: Policy,
        evm_address: String,
        solana: SolanaAccounts,
    ) -> Self {
        Self {
            owner,
            operator: None,
            paused: false,
            policy,
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
    /// (`E_NOT_ALLOWED`), then a running desk (`E_PAUSED`). A pause stops the owner's actions too.
    pub fn check_action(&self, desk_id: &str, caller: &AccountId) -> Result<Role, Refusal> {
        let role = self
            .role_of(caller)
            .ok_or_else(|| self.stranger(desk_id, caller))?;
        if self.paused {
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
    /// Each field a base58 address of 32 bytes, and the four of them different accounts.
    pub fn check(&self) -> Result<(), Refusal> {
        let fields = [
            ("authority", &self.authority),
            ("usdc_ata", &self.usdc_ata),
            ("phusd_ata", &self.phusd_ata),
            ("phoenix_trader", &self.phoenix_trader),
        ];
        for (name, value) in fields {
            check_base58_32(&format!("solana.{name}"), value)?;
        }
        // Base58 has one spelling per address, so equal strings are the only way to be equal.
        for (i, (a, value)) in fields.iter().enumerate() {
            if let Some((b, _)) = fields[i + 1..].iter().find(|(_, v)| v == value) {
                return Err(Refusal::new(
                    E_ARGS,
                    format!("solana.{a} and solana.{b} are the same account"),
                ));
            }
        }
        Ok(())
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

    fn refused(s: SolanaAccounts) -> String {
        let r = s.check().expect_err("should be refused");
        assert_eq!(r.code, E_ARGS);
        r.msg
    }

    #[test]
    fn distinct_32_byte_solana_accounts_pass() {
        solana().check().unwrap();
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
        s.phoenix_trader = format!("{}O", b58(4));
        assert!(refused(s).starts_with("solana.phoenix_trader "));
    }

    #[test]
    fn solana_accounts_must_differ() {
        let mut s = solana();
        s.phoenix_trader = s.authority.clone();
        assert_eq!(
            refused(s),
            "solana.authority and solana.phoenix_trader are the same account"
        );
        let mut s = solana();
        s.phusd_ata = s.usdc_ata.clone();
        assert_eq!(
            refused(s),
            "solana.usdc_ata and solana.phusd_ata are the same account"
        );
    }
}
