//! What a Solana message may do for a desk (docs/interfaces.md §1.3 and §1.5): the `sol_sign`
//! policy (Phoenix immediate-or-cancel orders, cancels, collateral in and out, Ember conversions
//! and token moves between the desk's own accounts) and the two Phoenix onboarding messages
//! `sol_sign_register` takes.
//!
//! Every account of the desk the rules name is derived from the desk authority
//! ([`SolDesk::derive`]) by the caller; nothing is taken from what an owner registered. Phoenix's
//! and Ember's own accounts (not their program ids) come from [`SolDesk::infra`]: the pinned
//! [`PhoenixAccounts::PINNED`] unless the desk's owner replaced them ([`PhoenixAccounts::check`]),
//! so a Phoenix that moves one of them does not lock the desk's collateral in for good.

use crate::ed25519::is_on_curve;
use crate::errors::{
    Refusal, E_ARGS, E_ASSET, E_PRICE_BAND, E_QUOTE_FIELDS, E_SOL_ACCOUNT, E_SOL_MESSAGE,
    E_SOL_PROGRAM,
};
use crate::ids::decode_base58_32;
use crate::limits::{check_value, Valued};
use crate::policy::{PhoenixMarket, Policy};
use crate::solana::{
    associated_token_address, b58, check_transaction_size, parse_message, phoenix_spline_address,
    Format, Instruction, Message, Pubkey, Sha256, SolDesk, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM,
    EMBER_AUTHORITY, EMBER_PROGRAM, EMBER_VAULT, PHOENIX_ONBOARDER, PHOENIX_PROGRAM, PHUSD_MINT,
    SYSTEM_PROGRAM, TOKEN_PROGRAM, USDC_MINT,
};

/// The highest compute-unit limit a message may set.
pub const MAX_COMPUTE_UNIT_LIMIT: u32 = 600_000;
/// The highest priority fee a message may set, in micro-lamports per compute unit: twice what the
/// engine sets (100,000 with 400k to 600k units), so a stolen operator key repeating a
/// `cancel_all` with the most it may pay burns 0.000125 SOL a transaction (with the 5,000
/// lamport base fee), not 0.000605.
pub const MAX_COMPUTE_UNIT_PRICE: u64 = 200_000;
/// The most a message may pay in priority fees, in lamports: both caps together, 0.00012 SOL. A
/// price is taken only with a unit limit, which bounds the units it pays for.
pub const MAX_PRIORITY_FEE_LAMPORTS: u64 =
    MAX_COMPUTE_UNIT_LIMIT as u64 * MAX_COMPUTE_UNIT_PRICE / 1_000_000;
/// The highest compute-unit limit of a paused desk's rescue that pays a priority fee: a rescue
/// needs a priority fee to land under congestion, and with this limit it pays at most 0.00008 SOL
/// of it. Rescues are metered by the hourly rescue cap and the deposit ring (at most 32 in any
/// 65 min), so a paused desk burns at most 32 × 0.000085 SOL in fees in that time.
pub const RESCUE_MAX_COMPUTE_UNIT_LIMIT: u64 = 400_000;

// Anchor discriminators, sha256("global:<name>")[0..8].
/// Phoenix `place_market_order`.
pub const PLACE_MARKET_ORDER: [u8; 8] = [0x5a, 0x76, 0xc0, 0xfc, 0xc0, 0x63, 0x27, 0x91];
/// Phoenix `cancel_all`.
pub const CANCEL_ALL: [u8; 8] = [0x62, 0xbf, 0x4b, 0xdc, 0x73, 0x28, 0x47, 0xed];
/// Phoenix `deposit_funds`.
pub const DEPOSIT_FUNDS: [u8; 8] = [0xca, 0x27, 0x34, 0xd3, 0x35, 0x14, 0xfa, 0x58];
/// Phoenix `withdraw_funds`.
pub const WITHDRAW_FUNDS: [u8; 8] = [0xf1, 0x24, 0x1d, 0x6f, 0xd0, 0x1f, 0x68, 0xd9];
/// Phoenix `register_trader`.
pub const REGISTER_TRADER: [u8; 8] = [0x4b, 0xf3, 0xe0, 0xa7, 0x01, 0x05, 0x33, 0x20];
/// Phoenix `set_trader_capabilities_delegated`.
pub const SET_TRADER_CAPABILITIES_DELEGATED: [u8; 8] =
    [0xcf, 0xaa, 0x11, 0x15, 0x35, 0x23, 0x58, 0x97];
/// Ember `deposit` (USDC to PhUSD).
pub const EMBER_DEPOSIT: [u8; 8] = [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6];
/// Ember `withdraw` (PhUSD to USDC).
pub const EMBER_WITHDRAW: [u8; 8] = [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];

/// `GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS`, Phoenix's log authority: PDA `["log"]`.
pub const PHOENIX_LOG_AUTHORITY: Pubkey = [
    0xe8, 0x57, 0x26, 0xc0, 0xb2, 0xb5, 0xbc, 0xfa, 0xf6, 0x66, 0x8b, 0x7c, 0x1b, 0x83, 0x69, 0xfb,
    0x01, 0xc9, 0x98, 0x5f, 0xcc, 0x16, 0x7f, 0x0b, 0x42, 0x99, 0xbf, 0x1d, 0x7d, 0x1e, 0xc2, 0xa5,
];
/// `2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ`, Phoenix's global configuration: PDA
/// `["global"]`.
pub const PHOENIX_GLOBAL_CONFIGURATION: Pubkey = [
    0x1d, 0xaf, 0x2f, 0x5c, 0x33, 0xd2, 0x6c, 0x9b, 0x55, 0xff, 0x98, 0xf9, 0x37, 0x7a, 0xdc, 0x2f,
    0xc6, 0x12, 0x02, 0x9f, 0xc9, 0x23, 0x0d, 0x59, 0x25, 0xa8, 0xe1, 0xa4, 0x5a, 0x4e, 0x47, 0xca,
];
/// `8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR`, Phoenix's risk authority, a seed of the
/// onboarding permission.
pub const PHOENIX_RISK_AUTHORITY: Pubkey = [
    0x75, 0xf5, 0x42, 0x3b, 0x35, 0x0c, 0xf5, 0x1d, 0xf7, 0x0f, 0xf0, 0x03, 0x8b, 0x01, 0xb8, 0x95,
    0x03, 0x98, 0x26, 0x80, 0x12, 0x45, 0x3d, 0x45, 0xce, 0x8d, 0xd3, 0x46, 0xcc, 0x78, 0x96, 0x74,
];
/// `6UCimUpRW2CGh3ESJm3S59c4WcCaVLYcpPPbbrfX2nzr`, the onboarder's permission: PDA
/// `["permission", risk authority, onboarder]`.
pub const PHOENIX_ONBOARDING_PERMISSION: Pubkey = [
    0x51, 0x42, 0x5e, 0x53, 0x38, 0x9a, 0xf2, 0x98, 0x56, 0x00, 0x83, 0x2e, 0xb5, 0xd9, 0xdb, 0x05,
    0x9b, 0x63, 0x56, 0x45, 0x81, 0xe8, 0x66, 0x8e, 0xa6, 0xd6, 0x7f, 0x36, 0x7a, 0xf5, 0x29, 0x77,
];
/// `HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK`, the global trader index arena (the exchange
/// snapshot's one account on 2026-10-31; if Phoenix adds arenas, this list must follow).
pub const PHOENIX_GLOBAL_TRADER_INDEX: Pubkey = [
    0xf0, 0xc4, 0x39, 0x28, 0xe8, 0x21, 0xad, 0xfc, 0x8e, 0x9e, 0x46, 0x14, 0x9a, 0x1e, 0x73, 0x5b,
    0xe8, 0x3e, 0x31, 0xf6, 0x1f, 0xc8, 0x69, 0x0f, 0x85, 0xd6, 0xee, 0x4e, 0x22, 0xbe, 0xb4, 0x5a,
];
/// `2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok`, the active trader buffer arena (as above).
pub const PHOENIX_ACTIVE_TRADER_BUFFER: Pubkey = [
    0x15, 0xc8, 0xaa, 0x92, 0x3d, 0xe3, 0x61, 0x0f, 0x99, 0x61, 0x2f, 0x3b, 0xf7, 0xb8, 0x64, 0x4c,
    0x37, 0x0c, 0x90, 0xf1, 0xbb, 0xed, 0x89, 0x08, 0x66, 0x17, 0xfe, 0xa5, 0x2e, 0x50, 0x8e, 0x13,
];
/// `csZXgw2G58hbiWc9ndxaxrQVYVvqdXgQzYLuznEzHJu`, Phoenix's global vault for PhUSD, the
/// canonical mint: PDA `["vault", PhUSD mint]` (accounts[6] of a deposit and a withdrawal).
pub const PHOENIX_GLOBAL_VAULT: Pubkey = [
    0x09, 0x30, 0x7f, 0x65, 0xf1, 0xeb, 0xe9, 0xfa, 0x1a, 0x51, 0x23, 0xbc, 0xca, 0xb4, 0xf8, 0x89,
    0x15, 0xce, 0x74, 0xbe, 0x6f, 0x1e, 0x7f, 0x7d, 0x1b, 0x73, 0x3f, 0x94, 0x11, 0xd3, 0xeb, 0x66,
];
/// `2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC`, the perp asset map Phoenix's global
/// configuration names (the SDK reads it from there; accounts[5] of an order, a cancel and a
/// withdrawal).
pub const PHOENIX_PERP_ASSET_MAP: Pubkey = [
    0x1a, 0x75, 0x35, 0xd1, 0xdc, 0x09, 0xee, 0xe8, 0xf9, 0x4e, 0x8d, 0x3e, 0x78, 0xaa, 0xe7, 0x24,
    0x52, 0xac, 0xed, 0xd0, 0xd0, 0xec, 0x9b, 0xda, 0xe5, 0xd0, 0x3f, 0xd0, 0x33, 0x25, 0x48, 0xd1,
];
/// `3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K`, the withdraw queue the global configuration
/// names (as above; the last account of a withdrawal).
pub const PHOENIX_WITHDRAW_QUEUE: Pubkey = [
    0x26, 0xb1, 0x61, 0xcc, 0x85, 0xc0, 0xe0, 0x4b, 0x39, 0xf7, 0x7e, 0xaf, 0xe4, 0x98, 0x0c, 0xad,
    0x32, 0x2f, 0x85, 0xc6, 0xd0, 0x36, 0xe7, 0x65, 0x4f, 0x63, 0x67, 0xaa, 0x8a, 0x64, 0x8c, 0xd2,
];

/// Phoenix's and Ember's own accounts the desk's instructions name, which are not program ids
/// and not the desk's (those are derived): what [`PhoenixAccounts::PINNED`] holds unless the
/// desk's owner replaced them. If Phoenix moves its global configuration or one of these
/// accounts, every withdrawal would fail with the pinned ones, so the owner can follow it.
///
/// The exact account count of each instruction stays fixed (10, 10, 12, 8): an instruction that
/// gains an account still needs a new contract, an accepted residual.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhoenixAccounts {
    pub log_authority: Pubkey,
    pub global_configuration: Pubkey,
    pub perp_asset_map: Pubkey,
    pub withdraw_queue: Pubkey,
    pub global_vault: Pubkey,
    pub global_trader_index: Pubkey,
    pub active_trader_buffer: Pubkey,
    /// Ember's state: accounts[1] of a wrap and an unwrap, and the only delegate an `Approve` of
    /// the desk's PhUSD account may name.
    pub ember_state: Pubkey,
    pub ember_vault: Pubkey,
}

/// The accounts no [`PhoenixAccounts`] entry may be: programs, mints, Phoenix's onboarding keys.
const NOT_INFRA: [(Pubkey, &str); 11] = [
    (SYSTEM_PROGRAM, "the system program"),
    (COMPUTE_BUDGET_PROGRAM, "the compute budget program"),
    (TOKEN_PROGRAM, "the token program"),
    (ATA_PROGRAM, "the associated token account program"),
    (PHOENIX_PROGRAM, "the Phoenix program"),
    (EMBER_PROGRAM, "the Ember program"),
    (USDC_MINT, "the USDC mint"),
    (PHUSD_MINT, "the PhUSD mint"),
    (PHOENIX_ONBOARDER, "Phoenix's onboarder"),
    (
        PHOENIX_ONBOARDING_PERMISSION,
        "Phoenix's onboarding permission",
    ),
    (PHOENIX_RISK_AUTHORITY, "Phoenix's risk authority"),
];

impl PhoenixAccounts {
    /// The accounts as recorded on 2026-10-31 (the constants above).
    pub const PINNED: PhoenixAccounts = PhoenixAccounts {
        log_authority: PHOENIX_LOG_AUTHORITY,
        global_configuration: PHOENIX_GLOBAL_CONFIGURATION,
        perp_asset_map: PHOENIX_PERP_ASSET_MAP,
        withdraw_queue: PHOENIX_WITHDRAW_QUEUE,
        global_vault: PHOENIX_GLOBAL_VAULT,
        global_trader_index: PHOENIX_GLOBAL_TRADER_INDEX,
        active_trader_buffer: PHOENIX_ACTIVE_TRADER_BUFFER,
        ember_state: EMBER_AUTHORITY,
        ember_vault: EMBER_VAULT,
    };

    /// The names and values, in the order above (also the JSON field order).
    pub fn entries(&self) -> [(&'static str, Pubkey); 9] {
        [
            ("log_authority", self.log_authority),
            ("global_configuration", self.global_configuration),
            ("perp_asset_map", self.perp_asset_map),
            ("withdraw_queue", self.withdraw_queue),
            ("global_vault", self.global_vault),
            ("global_trader_index", self.global_trader_index),
            ("active_trader_buffer", self.active_trader_buffer),
            ("ember_state", self.ember_state),
            ("ember_vault", self.ember_vault),
        ]
    }

    /// What an owner may set for the desk `desk` (`E_ARGS`): no program id, mint or Phoenix
    /// onboarding key; none of the desk's own derived accounts; no two entries alike; and the
    /// program-derived ones (log authority, global configuration, the two vaults, Ember's state)
    /// off the ed25519 curve, so no private key can sign for them. Ember's state is the only
    /// delegate an `Approve` may name, and that allowance never outlives the message (the walk
    /// requires the `Revoke`), so only Ember's own program can use it.
    ///
    /// Why the desk's money cannot be sent elsewhere through these: every account the desk's
    /// money lands in (its USDC and PhUSD accounts, its trader account, a rescue's deposit
    /// account) stays derived and pinned; these accounts are only ever passed to Phoenix's and
    /// Ember's pinned programs, which must check them themselves, since anyone can call those
    /// programs with any accounts. A wrong entry makes the desk's Phoenix instructions fail.
    pub fn check(&self, desk: &SolDesk) -> Result<(), Refusal> {
        let refuse = |name: &str, msg: String| {
            Err(Refusal::new(
                E_ARGS,
                format!("phoenix accounts: {name} {msg}"),
            ))
        };
        let entries = self.entries();
        let own = [
            (desk.authority, "the desk authority"),
            (desk.usdc_ata, "the desk's USDC account"),
            (desk.phusd_ata, "the desk's PhUSD account"),
            (desk.trader, "the desk's trader account"),
        ];
        let off_curve = [
            "log_authority",
            "global_configuration",
            "global_vault",
            "ember_state",
            "ember_vault",
        ];
        for (i, (name, key)) in entries.iter().enumerate() {
            if let Some((_, what)) = NOT_INFRA.iter().chain(own.iter()).find(|(k, _)| k == key) {
                return refuse(name, format!("{} is {what}", b58(key)));
            }
            if let Some((other, _)) = entries[..i].iter().find(|(_, k)| k == key) {
                return refuse(name, format!("{} is also {other}", b58(key)));
            }
            if off_curve.contains(name) && is_on_curve(key) {
                return refuse(
                    name,
                    format!(
                        "{} is on the ed25519 curve; this account is a program-derived address",
                        b58(key)
                    ),
                );
            }
        }
        Ok(())
    }
}

/// `register_trader` exactly as Phoenix builds it for the desk: max positions 128, preference
/// bits 0, trader PDA index 0, subaccount 0.
pub const REGISTER_TRADER_DATA: [u8; 18] = [
    0x4b, 0xf3, 0xe0, 0xa7, 0x01, 0x05, 0x33, 0x20, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
];
/// `set_trader_capabilities_delegated` exactly as Phoenix builds it: six toggles, all enabled
/// (limit orders, market orders, risk reducing, risk increasing, deposit, withdraw).
pub const CAPABILITIES_DATA: [u8; 24] = [
    0xcf, 0xaa, 0x11, 0x15, 0x35, 0x23, 0x58, 0x97, 0x06, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01,
    0x03, 0x01, 0x02, 0x01, 0x04, 0x01, 0x05, 0x01,
];

/// The order packet variant of an immediate-or-cancel order.
const IOC_VARIANT: u8 = 2;
/// The `orderFlags` bit of a reduce-only order.
const REDUCE_ONLY: u8 = 0x80;

// SPL Token instructions.
const TOKEN_TRANSFER: u8 = 3;
const TOKEN_APPROVE: u8 = 4;
const TOKEN_REVOKE: u8 = 5;
const TOKEN_TRANSFER_CHECKED: u8 = 12;
// Compute budget instructions.
const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
const SET_COMPUTE_UNIT_PRICE: u8 = 3;
/// Associated token account `CreateIdempotent`.
const ATA_CREATE_IDEMPOTENT: u8 = 1;

/// A rescue's verified 1Click deposit (C6): the one transfer out of the desk a `sol_sign_rescue`
/// message may carry, `amount_in` USDC (1e-6) into the USDC account of `deposit_owner`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rescue {
    pub deposit_owner: Pubkey,
    /// The associated USDC account of `deposit_owner`, derived.
    pub deposit_account: Pubkey,
    pub amount_in: u64,
}

impl Rescue {
    pub fn new(sha256: Sha256, deposit_owner: Pubkey, amount_in: u64) -> Result<Rescue, Refusal> {
        let deposit_account = associated_token_address(sha256, &deposit_owner, &USDC_MINT)
            .ok_or_else(|| {
                Refusal::new(
                    E_ARGS,
                    format!("no USDC token account address for {}", b58(&deposit_owner)),
                )
            })?;
        Ok(Rescue {
            deposit_owner,
            deposit_account,
            amount_in,
        })
    }
}

/// A Phoenix order the message places, as it was valued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhoenixOrder {
    pub symbol: String,
    pub bid: bool,
    /// Limit price, USD × 1e8 per base unit: `priceInTicks × tick_e8`.
    pub price_e8: u128,
    /// Base units × 1e8: `numBaseLots × base_lot_e8`.
    pub size_e8: u128,
    pub reduce_only: bool,
    pub valued: Valued,
}

/// What a message that passed [`check_message`] does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedMessage {
    /// `order` if it places an order, else `withdraw`, `deposit`, `cancel_all` for the first
    /// Phoenix action it takes, else `transaction`; `rescue` in rescue mode.
    pub kind: &'static str,
    pub orders: Vec<PhoenixOrder>,
    /// True when a paused desk may sign it: besides the compute budget, every instruction is a
    /// `cancel_all`, a reduce-only order, a `Revoke` of a desk token account or a token transfer
    /// into a desk token account, and a priority fee (a unit price above 0) comes only with a
    /// `cancel_all` or a reduce-only order, so a paused desk cannot be made to burn SOL on fees.
    /// Anything else (a deposit or withdrawal, Ember, a token account created, an `Approve`, a
    /// rescue transfer, which moves money out) needs a running desk.
    ///
    /// In rescue mode the rescue's own rule instead: a paused desk may sign a rescue that only
    /// frees and pays out the quote's `amountIn`: Phoenix withdrawals of at most `amountIn` in
    /// all, Ember unwraps of an amount, at most `amountIn` in all (with the `Approve` each spends
    /// and the `Revoke` after it, which the walk requires), `Revoke`s, the create of the deposit
    /// owner's account and the one transfer to it. No order, `cancel_all` (`sol_sign` signs
    /// those on a paused desk), deposit, wrap, other token transfer, create of a desk account or
    /// priority fee.
    pub reduces_risk: bool,
}

fn at(n: usize, code: &'static str, msg: impl AsRef<str>) -> Refusal {
    Refusal::new(code, format!("instruction {n}: {}", msg.as_ref()))
}

/// The instruction's accounts if it has at least `count` (`E_SOL_ACCOUNT` otherwise).
fn accounts<'m>(ix: &'m Instruction<'_>, n: usize, count: usize) -> Result<&'m [Pubkey], Refusal> {
    if ix.accounts.len() < count {
        return Err(at(
            n,
            E_SOL_ACCOUNT,
            format!("{} accounts, at least {count} expected", ix.accounts.len()),
        ));
    }
    Ok(&ix.accounts)
}

/// The instruction's accounts if there are exactly `count` (`E_SOL_ACCOUNT` otherwise): a
/// program reads its accounts by position, so one more or one less moves every account after it.
fn exactly<'m>(ix: &'m Instruction<'_>, n: usize, count: usize) -> Result<&'m [Pubkey], Refusal> {
    if ix.accounts.len() != count {
        return Err(at(
            n,
            E_SOL_ACCOUNT,
            format!("{} accounts, exactly {count} expected", ix.accounts.len()),
        ));
    }
    Ok(&ix.accounts)
}

/// Every `(index, key, what)` of `layout` holds its key (`E_SOL_ACCOUNT` otherwise).
fn pinned(a: &[Pubkey], n: usize, layout: &[(usize, Pubkey, &str)]) -> Result<(), Refusal> {
    for &(i, key, what) in layout {
        if a[i] != key {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                format!("account {i} is {}, not {what} {}", b58(&a[i]), b58(&key)),
            ));
        }
    }
    Ok(())
}

/// The amount (8 little-endian bytes) of a token transfer, a Phoenix withdraw or an Ember unwrap
/// (`what`) is not 0 (`E_SOL_PROGRAM`): an empty one moves nothing and would only pass a paused
/// desk's gate.
fn moves_something(amount: &[u8], what: &str, n: usize) -> Result<(), Refusal> {
    if le_u64(amount) == 0 {
        return Err(at(n, E_SOL_PROGRAM, format!("{what} of 0")));
    }
    Ok(())
}

/// A token transfer's source is not its destination (`E_SOL_ACCOUNT`): such a transfer moves
/// nothing and would only pass a paused desk's gate.
fn not_into_itself(source: &Pubkey, destination: &Pubkey, n: usize) -> Result<(), Refusal> {
    if source == destination {
        return Err(at(
            n,
            E_SOL_ACCOUNT,
            format!("a transfer from {} into itself", b58(source)),
        ));
    }
    Ok(())
}

fn le_u64(bytes: &[u8]) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(word)
}

/// A compute budget instruction within the caps: its opcode and value. Anything but a unit limit
/// or a unit price is `E_SOL_PROGRAM`.
fn check_compute_budget(data: &[u8], n: usize) -> Result<(u8, u64), Refusal> {
    match (data.first(), data.len()) {
        (Some(&SET_COMPUTE_UNIT_LIMIT), 5) => {
            let limit = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
            if limit > MAX_COMPUTE_UNIT_LIMIT {
                return Err(at(
                    n,
                    E_SOL_PROGRAM,
                    format!("compute unit limit {limit} is over {MAX_COMPUTE_UNIT_LIMIT}"),
                ));
            }
            Ok((SET_COMPUTE_UNIT_LIMIT, u64::from(limit)))
        }
        (Some(&SET_COMPUTE_UNIT_PRICE), 9) => {
            let price = le_u64(&data[1..]);
            if price > MAX_COMPUTE_UNIT_PRICE {
                return Err(at(
                    n,
                    E_SOL_PROGRAM,
                    format!(
                        "priority fee {price} micro-lamports per unit is over {MAX_COMPUTE_UNIT_PRICE}"
                    ),
                ));
            }
            Ok((SET_COMPUTE_UNIT_PRICE, price))
        }
        _ => Err(at(
            n,
            E_SOL_PROGRAM,
            "only SetComputeUnitLimit and SetComputeUnitPrice are allowed from the compute budget",
        )),
    }
}

/// The compute budget a message sets: a unit limit and a unit price, each at most once (Solana
/// refuses a repeat anyway), with the instruction that set it.
#[derive(Default)]
struct Budget {
    limit: Option<(usize, u64)>,
    price: Option<(usize, u64)>,
}

impl Budget {
    fn check(&mut self, data: &[u8], n: usize) -> Result<(), Refusal> {
        let (op, value) = check_compute_budget(data, n)?;
        let slot = if op == SET_COMPUTE_UNIT_LIMIT {
            &mut self.limit
        } else {
            &mut self.price
        };
        if slot.replace((n, value)).is_some() {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "a repeated compute budget instruction",
            ));
        }
        Ok(())
    }

    /// A price needs a limit: without one every instruction may burn 200,000 units, up to
    /// 1,400,000, each paying the price. With both, the priority fee is at most
    /// [`MAX_PRIORITY_FEE_LAMPORTS`].
    fn finish(&self) -> Result<(), Refusal> {
        let Some((n, price)) = self.price else {
            return Ok(());
        };
        let Some((_, limit)) = self.limit else {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "a priority fee needs a SetComputeUnitLimit in the same message",
            ));
        };
        let fee = (u128::from(limit) * u128::from(price)).div_ceil(1_000_000);
        if fee > u128::from(MAX_PRIORITY_FEE_LAMPORTS) {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                format!("a priority fee of {fee} lamports is over {MAX_PRIORITY_FEE_LAMPORTS}"),
            ));
        }
        Ok(())
    }
}

/// The fields of an immediate-or-cancel order packet the policy reads.
struct Ioc {
    bid: bool,
    price_in_ticks: Option<u64>,
    num_base_lots: u64,
    reduce_only: bool,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let out = self.bytes.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(out)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(le_u64)
    }

    fn option_u64(&mut self) -> Option<Option<u64>> {
        match self.u8()? {
            0 => Some(None),
            1 => self.u64().map(Some),
            _ => None,
        }
    }
}

/// Decodes the packet after the discriminator and the variant: side u8, priceInTicks
/// Option<u64>, numBaseLots u64, numQuoteLots Option<u64>, minBaseLotsToFill u64,
/// minQuoteLotsToFill u64, selfTradeBehavior u8, matchLimit Option<u64>, clientOrderId u128,
/// lastValidSlot Option<u64>, orderFlags u8, cancelExisting bool, and nothing after.
fn decode_ioc(packet: &[u8], n: usize) -> Result<Ioc, Refusal> {
    let malformed = || at(n, E_SOL_PROGRAM, "the order packet is malformed");
    let mut c = Cursor {
        bytes: packet,
        at: 0,
    };
    let bid = match c.u8().ok_or_else(malformed)? {
        0 => true,
        1 => false,
        _ => return Err(malformed()),
    };
    let price_in_ticks = c.option_u64().ok_or_else(malformed)?;
    let num_base_lots = c.u64().ok_or_else(malformed)?;
    let num_quote_lots = c.option_u64().ok_or_else(malformed)?;
    c.u64().ok_or_else(malformed)?; // minBaseLotsToFill
    c.u64().ok_or_else(malformed)?; // minQuoteLotsToFill
    if c.u8().ok_or_else(malformed)? > 2 {
        return Err(malformed()); // selfTradeBehavior: abort, cancel provide, decrement take
    }
    c.option_u64().ok_or_else(malformed)?; // matchLimit
    c.take(16).ok_or_else(malformed)?; // clientOrderId
    c.option_u64().ok_or_else(malformed)?; // lastValidSlot
    let flags = c.u8().ok_or_else(malformed)?;
    if c.u8().ok_or_else(malformed)? > 1 {
        return Err(malformed()); // cancelExisting
    }
    if c.at != packet.len() {
        return Err(malformed());
    }
    if num_quote_lots.is_some() {
        return Err(at(
            n,
            E_SOL_PROGRAM,
            "an order sized in quote lots (numQuoteLots set); orders are sized in base lots",
        ));
    }
    if flags & !REDUCE_ONLY != 0 {
        return Err(at(
            n,
            E_SOL_PROGRAM,
            format!("order flags {flags:#04x}: only reduce-only (0x80) may be set"),
        ));
    }
    Ok(Ioc {
        bid,
        price_in_ticks,
        num_base_lots,
        reduce_only: flags & REDUCE_ONLY != 0,
    })
}

struct Walk<'a> {
    sha256: Sha256,
    policy: &'a Policy,
    desk: &'a SolDesk,
    reference: &'a dyn Fn(&str) -> Option<u128>,
    rescue: Option<&'a Rescue>,
    budget: Budget,
    deposit_account_created: bool,
    rescue_transfers: u32,
    orders: Vec<PhoenixOrder>,
    phoenix: Option<&'static str>,
    /// Instructions besides the compute budget.
    actions: usize,
    /// False once an instruction a paused desk may not sign comes ([`CheckedMessage`]); orders
    /// are counted at the end.
    reduces_risk: bool,
    /// An `Approve` waiting for the Ember unwrap it is for: its instruction and amount.
    approval: Option<(usize, u64)>,
    /// The Ember unwrap that spent an `Approve`, until a `Revoke` of the desk's PhUSD account
    /// after it clears whatever allowance the unwrap left.
    revoke_due: Option<usize>,
    /// A `cancel_all` came.
    cancel_all: bool,
    /// False once an instruction a paused desk's rescue may not carry comes
    /// ([`CheckedMessage::reduces_risk`] in rescue mode).
    rescue_pause_ok: bool,
    /// What the Phoenix withdrawals and the Ember unwraps of the message free, each summed.
    withdrawn: u64,
    unwrapped: u64,
}

impl<'a> Walk<'a> {
    fn instruction(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        if ix.program != COMPUTE_BUDGET_PROGRAM {
            self.actions += 1;
        }
        match ix.program {
            COMPUTE_BUDGET_PROGRAM => self.budget.check(ix.data, n),
            ATA_PROGRAM => {
                self.reduces_risk = false;
                self.create_token_account(ix, n)
            }
            TOKEN_PROGRAM => self.token(ix, n),
            EMBER_PROGRAM => {
                self.reduces_risk = false;
                self.ember(ix, n)
            }
            PHOENIX_PROGRAM => self.phoenix(ix, n),
            program => Err(at(
                n,
                E_SOL_PROGRAM,
                format!("program {} is not allowed", b58(&program)),
            )),
        }
    }

    /// `CreateIdempotent` paid by the desk, for the desk's USDC or PhUSD account, or in a rescue
    /// for the deposit owner's USDC account.
    fn create_token_account(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        if ix.data != [ATA_CREATE_IDEMPOTENT] {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "only the idempotent create (data 01) of the token account program is allowed",
            ));
        }
        // payer, account, owner, mint, system program, token program
        let a = exactly(ix, n, 6)?;
        pinned(
            a,
            n,
            &[
                (4, SYSTEM_PROGRAM, "the system program"),
                (5, TOKEN_PROGRAM, "the token program"),
            ],
        )?;
        let d = self.desk;
        if a[0] != d.authority {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                "the desk must pay for a token account it creates",
            ));
        }
        let (owner, mint) = (a[2], a[3]);
        if mint != USDC_MINT && mint != PHUSD_MINT {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                format!("mint {} is not USDC or PhUSD", b58(&mint)),
            ));
        }
        let expected = if owner == d.authority {
            self.rescue_pause_ok = false;
            if mint == USDC_MINT {
                d.usdc_ata
            } else {
                d.phusd_ata
            }
        } else if let Some(r) = self.rescue.filter(|r| r.deposit_owner == owner) {
            if mint != USDC_MINT {
                return Err(at(
                    n,
                    E_SOL_ACCOUNT,
                    "the deposit owner's token account must be for USDC",
                ));
            }
            self.deposit_account_created = true;
            r.deposit_account
        } else {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                format!("a token account for {}, which is not the desk", b58(&owner)),
            ));
        };
        if a[1] != expected {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                format!(
                    "{} is not the associated token account of {} for that mint",
                    b58(&a[1]),
                    b58(&owner)
                ),
            ));
        }
        Ok(())
    }

    fn token(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        let d = self.desk;
        let malformed = || at(n, E_SOL_PROGRAM, "a malformed token instruction");
        match ix.data.first() {
            Some(&TOKEN_APPROVE) => {
                if ix.data.len() != 9 {
                    return Err(malformed());
                }
                // source, delegate, owner
                let a = exactly(ix, n, 3)?;
                pinned(
                    a,
                    n,
                    &[
                        (0, d.phusd_ata, "the desk's PhUSD account"),
                        (1, d.infra.ember_state, "Ember's state"),
                        (2, d.authority, "the desk authority"),
                    ],
                )?;
                if let Some((first, _)) = self.approval {
                    return Err(at(
                        n,
                        E_SOL_PROGRAM,
                        format!("a second Approve before the unwrap of instruction {first}'s"),
                    ));
                }
                self.approval = Some((n, le_u64(&ix.data[1..])));
                self.reduces_risk = false;
                Ok(())
            }
            Some(&TOKEN_REVOKE) => {
                if ix.data.len() != 1 {
                    return Err(malformed());
                }
                // source, owner
                let a = exactly(ix, n, 2)?;
                if !d.is_token_account(&a[0]) {
                    return Err(at(
                        n,
                        E_SOL_ACCOUNT,
                        format!("{} is not a desk token account", b58(&a[0])),
                    ));
                }
                pinned(a, n, &[(1, d.authority, "the desk authority")])?;
                if a[0] == d.phusd_ata {
                    self.revoke_due = None;
                }
                Ok(())
            }
            Some(&TOKEN_TRANSFER) => {
                if ix.data.len() != 9 {
                    return Err(malformed());
                }
                // source, destination, owner
                let a = accounts(ix, n, 3)?;
                moves_something(&ix.data[1..9], "a token transfer", n)?;
                if !d.is_token_account(&a[1]) {
                    return Err(self.foreign_destination(&a[1], n));
                }
                self.rescue_pause_ok = false;
                not_into_itself(&a[0], &a[1], n)
            }
            Some(&TOKEN_TRANSFER_CHECKED) => {
                if ix.data.len() != 10 {
                    return Err(malformed());
                }
                // source, mint, destination, owner
                let a = accounts(ix, n, 4)?;
                moves_something(&ix.data[1..9], "a token transfer", n)?;
                if d.is_token_account(&a[2]) {
                    self.rescue_pause_ok = false;
                    return not_into_itself(&a[0], &a[2], n);
                }
                let Some(r) = self.rescue.filter(|r| r.deposit_account == a[2]) else {
                    return Err(self.foreign_destination(&a[2], n));
                };
                // The one transfer out: from the desk's USDC account, signed by the desk.
                pinned(
                    exactly(ix, n, 4)?,
                    n,
                    &[
                        (0, d.usdc_ata, "the desk's USDC account"),
                        (3, d.authority, "the desk authority"),
                    ],
                )?;
                if a[1] != USDC_MINT || !self.deposit_account_created {
                    return Err(at(
                        n,
                        E_SOL_ACCOUNT,
                        "a rescue pays USDC into the deposit owner's account created earlier in \
                         the same message",
                    ));
                }
                let amount = le_u64(&ix.data[1..9]);
                if amount != r.amount_in {
                    return Err(at(
                        n,
                        E_QUOTE_FIELDS,
                        format!(
                            "the rescue transfer is {amount}, not the quote's amountIn {}",
                            r.amount_in
                        ),
                    ));
                }
                self.rescue_transfers += 1;
                self.reduces_risk = false;
                if self.rescue_transfers > 1 {
                    return Err(at(n, E_QUOTE_FIELDS, "a second rescue transfer"));
                }
                Ok(())
            }
            Some(op) => Err(at(
                n,
                E_SOL_PROGRAM,
                format!("token instruction {op} is not allowed"),
            )),
            None => Err(malformed()),
        }
    }

    /// The rescue's `amountIn`, 0 outside rescue mode.
    fn rescue_amount(&self) -> u64 {
        self.rescue.map_or(0, |r| r.amount_in)
    }

    fn foreign_destination(&self, account: &Pubkey, n: usize) -> Refusal {
        at(
            n,
            E_SOL_ACCOUNT,
            format!(
                "a transfer into {}, which is not a desk token account",
                b58(account)
            ),
        )
    }

    /// Ember deposit (a wrap of USDC into PhUSD) and withdraw (the unwrap back), both with the
    /// 8 accounts the SDK gives them: desk authority, Ember's state, the USDC and PhUSD mints,
    /// the desk's USDC and PhUSD accounts, Ember's vault, the token program.
    fn ember(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        let disc = ix.data.get(..8);
        if disc != Some(&EMBER_DEPOSIT[..]) && disc != Some(&EMBER_WITHDRAW[..]) {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "only Ember deposit and withdraw are allowed",
            ));
        }
        if disc == Some(&EMBER_DEPOSIT[..]) && ix.data.len() != 16 {
            return Err(at(n, E_SOL_PROGRAM, "a malformed Ember deposit"));
        }
        let d = self.desk;
        pinned(
            exactly(ix, n, 8)?,
            n,
            &[
                (0, d.authority, "the desk authority"),
                (1, d.infra.ember_state, "Ember's state"),
                (2, USDC_MINT, "the USDC mint"),
                (3, PHUSD_MINT, "the PhUSD mint"),
                (4, d.usdc_ata, "the desk's USDC account"),
                (5, d.phusd_ata, "the desk's PhUSD account"),
                (6, d.infra.ember_vault, "Ember's vault"),
                (7, TOKEN_PROGRAM, "the token program"),
            ],
        )?;
        if disc == Some(&EMBER_DEPOSIT[..]) {
            // A wrap puts USDC back into PhUSD, no step of a rescue.
            self.rescue_pause_ok = false;
        }
        if disc == Some(&EMBER_WITHDRAW[..]) {
            // An Option<u64>: 1 and the amount, or 0 for the whole balance.
            let amount = match (ix.data.get(8), ix.data.len()) {
                (Some(1), 17) => {
                    moves_something(&ix.data[9..], "an Ember unwrap", n)?;
                    Some(le_u64(&ix.data[9..]))
                }
                (Some(0), 9) => None,
                _ => return Err(at(n, E_SOL_PROGRAM, "a malformed Ember withdraw")),
            };
            match amount {
                Some(a) => self.unwrapped = self.unwrapped.saturating_add(a),
                None => self.rescue_pause_ok = false,
            }
            if self.unwrapped > self.rescue_amount() {
                self.rescue_pause_ok = false;
            }
            if let Some((approved_at, approved)) = self.approval.take() {
                if amount != Some(approved) {
                    return Err(at(
                        n,
                        E_SOL_PROGRAM,
                        format!(
                            "the unwrap of {} is not the {approved} instruction {approved_at} \
                             approves",
                            amount.map_or_else(|| "the whole balance".into(), |a| a.to_string())
                        ),
                    ));
                }
                self.revoke_due = Some(n);
            }
        }
        Ok(())
    }

    /// The four Phoenix instructions, each with its exact account list as the Phoenix SDK builds
    /// it (one global trader index and one active trader buffer arena):
    ///
    /// - `place_market_order` and `cancel_all`, 10 accounts: program, log authority, global
    ///   configuration, desk authority, trader, perp asset map, global trader index, active
    ///   trader buffer, orderbook (a market of the policy, `E_ASSET`), its spline collection;
    /// - `deposit_funds`, 10: program, log authority, global configuration, desk authority, desk
    ///   PhUSD account, trader, global vault, token program, global trader index, active trader
    ///   buffer;
    /// - `withdraw_funds`, 12: program, log authority, global configuration, desk authority,
    ///   trader, perp asset map, global vault, desk PhUSD account, token program, global trader
    ///   index, active trader buffer, withdraw queue.
    fn phoenix(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        let d = *self.desk;
        let disc: [u8; 8] = ix
            .data
            .get(..8)
            .and_then(|s| s.try_into().ok())
            .unwrap_or_default();
        let head = [
            (0, PHOENIX_PROGRAM, "the Phoenix program"),
            (1, d.infra.log_authority, "Phoenix's log authority"),
            (
                2,
                d.infra.global_configuration,
                "Phoenix's global configuration",
            ),
            (3, d.authority, "the desk authority"),
        ];
        let trader = "the desk's trader account";
        let phusd = "the desk's PhUSD account";
        let index = "Phoenix's global trader index";
        let buffer = "Phoenix's active trader buffer";
        let vault = "Phoenix's PhUSD vault";
        let malformed = |what: &str| at(n, E_SOL_PROGRAM, format!("a malformed {what}"));
        match disc {
            PLACE_MARKET_ORDER | CANCEL_ALL => {
                let is_order = disc == PLACE_MARKET_ORDER;
                if is_order && ix.data.get(8) != Some(&IOC_VARIANT) {
                    return Err(at(
                        n,
                        E_SOL_PROGRAM,
                        "only immediate-or-cancel orders (packet variant 2) are allowed",
                    ));
                }
                if !is_order && ix.data.len() != 8 {
                    return Err(malformed("cancel_all"));
                }
                let a = exactly(ix, n, 10)?;
                pinned(a, n, &head)?;
                pinned(
                    a,
                    n,
                    &[
                        (4, d.trader, trader),
                        (5, d.infra.perp_asset_map, "Phoenix's perp asset map"),
                        (6, d.infra.global_trader_index, index),
                        (7, d.infra.active_trader_buffer, buffer),
                    ],
                )?;
                let market = self.market(&a[8], n)?;
                let spline = phoenix_spline_address(self.sha256, &a[8]).ok_or_else(|| {
                    at(
                        n,
                        E_SOL_ACCOUNT,
                        format!("no spline collection address for orderbook {}", b58(&a[8])),
                    )
                })?;
                pinned(
                    a,
                    n,
                    &[(9, spline, "the spline collection of that orderbook")],
                )?;
                self.rescue_pause_ok = false;
                if is_order {
                    let order = self.order(ix, market, n)?;
                    self.orders.push(order);
                } else {
                    self.cancel_all = true;
                    self.phoenix.get_or_insert("cancel_all");
                }
            }
            DEPOSIT_FUNDS => {
                if ix.data.len() != 16 {
                    return Err(malformed("deposit_funds"));
                }
                let a = exactly(ix, n, 10)?;
                pinned(a, n, &head)?;
                pinned(
                    a,
                    n,
                    &[
                        (4, d.phusd_ata, phusd),
                        (5, d.trader, trader),
                        (6, d.infra.global_vault, vault),
                        (7, TOKEN_PROGRAM, "the token program"),
                        (8, d.infra.global_trader_index, index),
                        (9, d.infra.active_trader_buffer, buffer),
                    ],
                )?;
                self.reduces_risk = false;
                self.rescue_pause_ok = false;
                self.phoenix.get_or_insert("deposit");
            }
            WITHDRAW_FUNDS => {
                if ix.data.len() != 16 {
                    return Err(malformed("withdraw_funds"));
                }
                let a = exactly(ix, n, 12)?;
                moves_something(&ix.data[8..16], "a Phoenix withdraw", n)?;
                pinned(a, n, &head)?;
                pinned(
                    a,
                    n,
                    &[
                        (4, d.trader, trader),
                        (5, d.infra.perp_asset_map, "Phoenix's perp asset map"),
                        (6, d.infra.global_vault, vault),
                        (7, d.phusd_ata, phusd),
                        (8, TOKEN_PROGRAM, "the token program"),
                        (9, d.infra.global_trader_index, index),
                        (10, d.infra.active_trader_buffer, buffer),
                        (11, d.infra.withdraw_queue, "Phoenix's withdraw queue"),
                    ],
                )?;
                self.reduces_risk = false;
                self.withdrawn = self.withdrawn.saturating_add(le_u64(&ix.data[8..16]));
                if self.withdrawn > self.rescue_amount() {
                    self.rescue_pause_ok = false;
                }
                self.phoenix.get_or_insert("withdraw");
            }
            _ => {
                return Err(at(
                    n,
                    E_SOL_PROGRAM,
                    format!("Phoenix instruction {} is not allowed", hex::encode(disc)),
                ))
            }
        }
        Ok(())
    }

    /// The policy's market on `orderbook` (`E_ASSET` if there is none).
    fn market(&self, orderbook: &Pubkey, n: usize) -> Result<&'a PhoenixMarket, Refusal> {
        self.policy
            .phoenix_markets
            .iter()
            .find(|m| decode_base58_32(&m.orderbook).as_ref() == Some(orderbook))
            .ok_or_else(|| {
                at(
                    n,
                    E_ASSET,
                    format!("orderbook {} is not a market of the policy", b58(orderbook)),
                )
            })
    }

    /// An IOC order on `market`: a well-formed packet, a price limit (`E_PRICE_BAND` without
    /// one), then the checks every order makes ([`check_value`]).
    fn order(
        &self,
        ix: &Instruction<'_>,
        market: &PhoenixMarket,
        n: usize,
    ) -> Result<PhoenixOrder, Refusal> {
        let ioc = decode_ioc(&ix.data[9..], n)?;
        let ticks = ioc.price_in_ticks.ok_or_else(|| {
            at(
                n,
                E_PRICE_BAND,
                format!(
                    "{} order without priceInTicks: no price limit to check against the band",
                    market.symbol
                ),
            )
        })?;
        let price_e8 = u128::from(ticks) * u128::from(market.tick_e8);
        let size_e8 = u128::from(ioc.num_base_lots) * u128::from(market.base_lot_e8);
        let valued = check_value(
            self.policy,
            &market.symbol,
            price_e8,
            size_e8,
            (self.reference)(&market.symbol),
        )
        .map_err(|r| at(n, r.code, r.msg))?;
        Ok(PhoenixOrder {
            symbol: market.symbol.clone(),
            bid: ioc.bid,
            price_e8,
            size_e8,
            reduce_only: ioc.reduce_only,
            valued,
        })
    }
}

/// The `sol_sign` policy (and, with `rescue`, the C6 rescue mode): a legacy message for one
/// signature, keys[0] the desk authority (`E_SOL_MESSAGE`), then every instruction in order, the
/// first refusal being the answer:
///
/// - compute budget: a unit limit up to [`MAX_COMPUTE_UNIT_LIMIT`] and a price up to
///   [`MAX_COMPUTE_UNIT_PRICE`], once each, a price only with a limit;
/// - token account program: `CreateIdempotent` paid by the desk for its own USDC or PhUSD account
///   (or, in a rescue, the deposit owner's USDC account);
/// - SPL Token: `Approve` of the desk's PhUSD account to the Ember authority for exactly the
///   amount of the Ember unwrap that follows it, before any other `Approve`, with a `Revoke` of
///   the desk's PhUSD account after that unwrap (else `E_SOL_PROGRAM`); `Revoke` of a desk token
///   account; `Transfer` and `TransferChecked` of more than 0 (else `E_SOL_PROGRAM`) into a desk
///   token account other than the source (else `E_SOL_ACCOUNT`; in a rescue also exactly one
///   `TransferChecked` of `amount_in` USDC into the deposit owner's account created before it,
///   else `E_QUOTE_FIELDS`);
/// - Ember deposit and withdraw (an unwrap of an amount, or of the whole balance) between the
///   desk's USDC and PhUSD accounts, with Ember's state and vault in their places;
/// - Phoenix: `place_market_order` (immediate-or-cancel only, a market of the policy, a price
///   limit, then [`check_value`] at the `reference` price), `cancel_all`, `deposit_funds` and
///   `withdraw_funds`, each with its exact account list: the desk's own accounts, Phoenix's
///   pinned ones and, for an order or a cancel, the orderbook with the spline collection derived
///   from it (`sha256` derives it).
///
/// A program outside this list, another instruction of these programs or a value over a cap is
/// `E_SOL_PROGRAM`, an account the desk does not own or out of its place `E_SOL_ACCOUNT`, a
/// market outside the policy `E_ASSET`. After the walk: a price without a limit, then an
/// `Approve` its unwrap never spent, then an unwrap of an `Approve` with no `Revoke` after it, is
/// `E_SOL_PROGRAM`, and a message with nothing besides the compute budget `E_SOL_MESSAGE`.
/// [`CheckedMessage::reduces_risk`] says whether a paused desk may sign the message.
pub fn check_message(
    sha256: Sha256,
    policy: &Policy,
    desk: &SolDesk,
    message: &[u8],
    reference: &dyn Fn(&str) -> Option<u128>,
    rescue: Option<&Rescue>,
) -> Result<CheckedMessage, Refusal> {
    let m = parse_message(message)?;
    if m.format != Format::Legacy {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            "a version 0 message; sol_sign takes legacy messages only",
        ));
    }
    check_transaction_size(message.len(), 1)?;
    check_signers(&m, 1, &desk.authority)?;
    let mut walk = Walk {
        sha256,
        policy,
        desk,
        reference,
        rescue,
        budget: Budget::default(),
        deposit_account_created: false,
        rescue_transfers: 0,
        orders: Vec::new(),
        phoenix: None,
        actions: 0,
        reduces_risk: true,
        approval: None,
        revoke_due: None,
        cancel_all: false,
        rescue_pause_ok: true,
        withdrawn: 0,
        unwrapped: 0,
    };
    for (n, ix) in m.instructions.iter().enumerate() {
        walk.instruction(ix, n)?;
    }
    walk.budget.finish()?;
    if let Some((n, amount)) = walk.approval {
        return Err(at(
            n,
            E_SOL_PROGRAM,
            format!("an Approve of {amount} with no Ember unwrap of that amount after it"),
        ));
    }
    if let Some(n) = walk.revoke_due {
        return Err(at(
            n,
            E_SOL_PROGRAM,
            "an unwrap that spends an Approve needs a Revoke of the desk's PhUSD account after it, \
             so no allowance outlives the message",
        ));
    }
    if walk.actions == 0 {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            "the message has no instruction besides the compute budget",
        ));
    }
    if rescue.is_some() && walk.rescue_transfers != 1 {
        return Err(Refusal::new(
            E_QUOTE_FIELDS,
            "a rescue message carries exactly one transfer to the deposit owner; this one has none",
        ));
    }
    let kind = if rescue.is_some() {
        "rescue"
    } else if !walk.orders.is_empty() {
        "order"
    } else {
        walk.phoenix.unwrap_or("transaction")
    };
    // A priority fee is spent whatever the message does, so a paused desk pays one only to cancel
    // or to reduce a position.
    let priority_fee = walk.budget.price.is_some_and(|(_, price)| price > 0);
    let cancels_or_reduces = walk.cancel_all || walk.orders.iter().any(|o| o.reduce_only);
    // A paused desk's rescue may pay a priority fee (within the price cap) for at most
    // RESCUE_MAX_COMPUTE_UNIT_LIMIT units, so it can land under congestion.
    let rescue_fee_ok = !priority_fee
        || walk
            .budget
            .limit
            .is_some_and(|(_, limit)| limit <= RESCUE_MAX_COMPUTE_UNIT_LIMIT);
    let reduces_risk = if rescue.is_some() {
        walk.rescue_pause_ok && rescue_fee_ok
    } else {
        walk.reduces_risk
            && walk.orders.iter().all(|o| o.reduce_only)
            && (!priority_fee || cancels_or_reduces)
    };
    Ok(CheckedMessage {
        kind,
        orders: walk.orders,
        reduces_risk,
    })
}

/// `signers` signatures and keys[0], the fee payer, the desk authority.
fn check_signers(m: &Message<'_>, signers: u8, authority: &Pubkey) -> Result<(), Refusal> {
    if m.num_required_signatures != signers {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            format!(
                "the message needs {} signatures; it must need {signers}",
                m.num_required_signatures
            ),
        ));
    }
    if m.keys[0] != *authority {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            format!(
                "the fee payer (keys[0]) is {}, not the desk authority {}",
                b58(&m.keys[0]),
                b58(authority)
            ),
        ));
    }
    Ok(())
}

/// The Phoenix onboarding messages `sol_sign_register` signs. Phoenix's onboarder co-signs both
/// and Phoenix's API sends them; the referral code of an activation travels only in that HTTP
/// call, never in the signed bytes, so there is nothing to check for it here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Onboarding {
    /// `register_trader` then `set_trader_capabilities_delegated`, as `build-register-ixs`
    /// returns them, compiled as a legacy message with the desk paying fees and rent.
    Register,
    /// `set_trader_capabilities_delegated` alone, the referral activation transaction the SDK
    /// builds: a version 0 message without lookups.
    ReferralActivate,
}

/// One instruction of an onboarding message: what it must be, byte for byte.
struct Step {
    disc: [u8; 8],
    data: &'static [u8],
    accounts: fn(&PhoenixAccounts, &Pubkey, &Pubkey) -> Vec<Pubkey>,
}

fn register_accounts(infra: &PhoenixAccounts, authority: &Pubkey, trader: &Pubkey) -> Vec<Pubkey> {
    vec![
        PHOENIX_PROGRAM,
        infra.log_authority,
        infra.global_configuration,
        *authority, // payer of the rent, the only signer of the two
        *authority, // the trader authority, read-only
        *trader,
        SYSTEM_PROGRAM,
    ]
}

fn capability_accounts(
    infra: &PhoenixAccounts,
    _authority: &Pubkey,
    trader: &Pubkey,
) -> Vec<Pubkey> {
    vec![
        PHOENIX_PROGRAM,
        infra.log_authority,
        infra.global_configuration,
        PHOENIX_ONBOARDER,
        PHOENIX_ONBOARDING_PERMISSION,
        *trader,
        infra.global_trader_index,
        infra.active_trader_buffer,
    ]
}

const REGISTER_STEP: Step = Step {
    disc: REGISTER_TRADER,
    data: &REGISTER_TRADER_DATA,
    accounts: register_accounts,
};

const CAPABILITIES_STEP: Step = Step {
    disc: SET_TRADER_CAPABILITIES_DELEGATED,
    data: &CAPABILITIES_DATA,
    accounts: capability_accounts,
};

impl Onboarding {
    /// The type a format stands for: a registration is always a legacy message and a referral
    /// activation always a version 0 one, so `sol_sign_register` needs no type argument. A
    /// message is then refused as the type of its format.
    pub fn of(format: Format) -> Onboarding {
        match format {
            Format::Legacy => Onboarding::Register,
            Format::V0 => Onboarding::ReferralActivate,
        }
    }

    pub fn kind(self) -> &'static str {
        match self {
            Onboarding::Register => "register",
            Onboarding::ReferralActivate => "referral_activate",
        }
    }

    fn format(self) -> Format {
        match self {
            Onboarding::Register => Format::Legacy,
            Onboarding::ReferralActivate => Format::V0,
        }
    }

    fn steps(self) -> &'static [Step] {
        match self {
            Onboarding::Register => &[REGISTER_STEP, CAPABILITIES_STEP],
            Onboarding::ReferralActivate => &[CAPABILITIES_STEP],
        }
    }
}

/// A Phoenix onboarding message for the desk with authority `authority` and trader account
/// `trader` (derived): the format of its type (`E_SOL_MESSAGE`), two signatures with keys[0] the
/// desk (`E_SOL_MESSAGE`) and keys[1] Phoenix's onboarder (`E_SOL_ACCOUNT`); then an optional
/// compute budget prefix within the caps, each instruction once (`E_SOL_PROGRAM`), and exactly
/// the type's Phoenix instructions in order (`E_SOL_PROGRAM`), each with Phoenix's data byte for
/// byte (`E_ARGS`) and its accounts position by position (`E_SOL_ACCOUNT`). Accounts are matched
/// through each instruction's own account list, never by message key index, which depends on
/// the compiler.
pub fn check_onboarding(
    authority: &Pubkey,
    trader: &Pubkey,
    message: &[u8],
    which: Onboarding,
) -> Result<(), Refusal> {
    let m = parse_message(message)?;
    check_shape(
        &PhoenixAccounts::PINNED,
        authority,
        trader,
        message.len(),
        &m,
        which,
    )
}

/// `sol_sign_register`'s check: the message's type is the one its format stands for
/// ([`Onboarding::of`]), and it is checked as [`check_onboarding`] checks that type, with the
/// pinned Phoenix accounts.
pub fn check_registration(
    authority: &Pubkey,
    trader: &Pubkey,
    message: &[u8],
) -> Result<Onboarding, Refusal> {
    check_registration_in(&PhoenixAccounts::PINNED, authority, trader, message)
}

/// [`check_registration`] with the desk's Phoenix accounts `infra`.
pub fn check_registration_in(
    infra: &PhoenixAccounts,
    authority: &Pubkey,
    trader: &Pubkey,
    message: &[u8],
) -> Result<Onboarding, Refusal> {
    let m = parse_message(message)?;
    let which = Onboarding::of(m.format);
    check_shape(infra, authority, trader, message.len(), &m, which)?;
    Ok(which)
}

fn check_shape(
    infra: &PhoenixAccounts,
    authority: &Pubkey,
    trader: &Pubkey,
    len: usize,
    m: &Message,
    which: Onboarding,
) -> Result<(), Refusal> {
    if m.format != which.format() {
        return Err(Refusal::new(
            E_SOL_MESSAGE,
            format!(
                "a {:?} message; {} is a {:?} message",
                m.format,
                which.kind(),
                which.format()
            ),
        ));
    }
    check_transaction_size(len, 2)?;
    check_signers(m, 2, authority)?;
    if m.keys[1] != PHOENIX_ONBOARDER {
        return Err(Refusal::new(
            E_SOL_ACCOUNT,
            format!(
                "the second signer is {}, not Phoenix's onboarder {}",
                b58(&m.keys[1]),
                b58(&PHOENIX_ONBOARDER)
            ),
        ));
    }
    let steps = which.steps();
    let mut next = 0;
    let mut budget = Budget::default();
    for (n, ix) in m.instructions.iter().enumerate() {
        if ix.program == COMPUTE_BUDGET_PROGRAM {
            if next != 0 {
                return Err(at(
                    n,
                    E_SOL_PROGRAM,
                    "compute budget instructions come before the Phoenix ones",
                ));
            }
            budget.check(ix.data, n)?;
            continue;
        }
        let step = steps
            .get(next)
            .filter(|s| ix.program == PHOENIX_PROGRAM && ix.data.get(..8) == Some(&s.disc[..]));
        let Some(step) = step else {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                format!(
                    "not the next instruction of a Phoenix {} message",
                    which.kind()
                ),
            ));
        };
        next += 1;
        if ix.data != step.data {
            return Err(at(
                n,
                E_ARGS,
                "the instruction data is not what Phoenix builds for the desk",
            ));
        }
        if ix.accounts != (step.accounts)(infra, authority, trader) {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                "the accounts are not Phoenix's and the desk's, in Phoenix's order",
            ));
        }
    }
    if next != steps.len() {
        return Err(Refusal::new(
            E_SOL_PROGRAM,
            format!("a Phoenix {} message is missing instructions", which.kind()),
        ));
    }
    // A unit price needs a unit limit here too, within the same caps as sol_sign.
    budget.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fields of an IOC packet, encoded as Phoenix's SDK encodes them.
    struct Packet {
        side: u8,
        price: Option<u64>,
        lots: u64,
        quote_lots: Option<u64>,
        self_trade: u8,
        flags: u8,
        cancel_existing: u8,
    }

    fn option(out: &mut Vec<u8>, v: Option<u64>) {
        match v {
            None => out.push(0),
            Some(x) => {
                out.push(1);
                out.extend(x.to_le_bytes());
            }
        }
    }

    impl Packet {
        fn buy() -> Packet {
            Packet {
                side: 0,
                price: Some(24_745),
                lots: 50,
                quote_lots: None,
                self_trade: 1,
                flags: 0,
                cancel_existing: 0,
            }
        }

        fn bytes(&self) -> Vec<u8> {
            let mut out = vec![self.side];
            option(&mut out, self.price);
            out.extend(self.lots.to_le_bytes());
            option(&mut out, self.quote_lots);
            out.extend(0u64.to_le_bytes()); // minBaseLotsToFill
            out.extend(0u64.to_le_bytes()); // minQuoteLotsToFill
            out.push(self.self_trade);
            option(&mut out, None); // matchLimit
            out.extend(7u128.to_le_bytes()); // clientOrderId
            option(&mut out, Some(300_000_000)); // lastValidSlot
            out.push(self.flags);
            out.push(self.cancel_existing);
            out
        }
    }

    fn refused(bytes: &[u8]) -> String {
        match decode_ioc(bytes, 2) {
            Ok(_) => panic!("decoded"),
            Err(r) => {
                assert_eq!(r.code, E_SOL_PROGRAM);
                r.msg
            }
        }
    }

    #[test]
    fn an_ioc_packet_decodes_to_side_price_lots_and_reduce_only() {
        let ioc = decode_ioc(&Packet::buy().bytes(), 2).unwrap();
        assert!(ioc.bid && !ioc.reduce_only);
        assert_eq!((ioc.price_in_ticks, ioc.num_base_lots), (Some(24_745), 50));
        let close = Packet {
            side: 1,
            price: None,
            flags: REDUCE_ONLY,
            ..Packet::buy()
        };
        let ioc = decode_ioc(&close.bytes(), 2).unwrap();
        assert!(!ioc.bid && ioc.reduce_only);
        assert_eq!(
            ioc.price_in_ticks, None,
            "the policy refuses it, not the decoder"
        );
    }

    #[test]
    fn a_malformed_packet_is_refused() {
        let malformed = "instruction 2: the order packet is malformed";
        let good = Packet::buy().bytes();
        for cut in [0, 1, 9, good.len() - 1] {
            assert_eq!(refused(&good[..cut]), malformed, "cut at {cut}");
        }
        let mut long = good.clone();
        long.push(0);
        assert_eq!(refused(&long), malformed);
        let mut bad_tag = good.clone();
        bad_tag[1] = 2; // priceInTicks option tag
        assert_eq!(refused(&bad_tag), malformed);
        for p in [
            Packet {
                side: 2,
                ..Packet::buy()
            },
            Packet {
                self_trade: 3,
                ..Packet::buy()
            },
            Packet {
                cancel_existing: 2,
                ..Packet::buy()
            },
        ] {
            assert_eq!(refused(&p.bytes()), malformed);
        }
    }

    #[test]
    fn orders_are_sized_in_base_lots_with_no_flag_but_reduce_only() {
        let quote = Packet {
            quote_lots: Some(1),
            ..Packet::buy()
        };
        assert!(refused(&quote.bytes()).contains("sized in quote lots"));
        for flags in [0x01, 0x40, 0xc0, 0xff] {
            let p = Packet {
                flags,
                ..Packet::buy()
            };
            assert!(
                refused(&p.bytes()).contains("only reduce-only (0x80) may be set"),
                "{flags:#04x}"
            );
        }
    }
}
