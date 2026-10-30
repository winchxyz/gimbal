//! A desk: one owner's trading accounts on the venues, the policy they trade under and the money
//! the contract holds for them (docs/interfaces.md §1.2).

use gimbal_core::policy::Policy;
use near_sdk::{near, AccountId};

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
