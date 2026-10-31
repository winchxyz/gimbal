//! What a Solana message may do for a desk (docs/interfaces.md §1.3 and §1.5): the `sol_sign`
//! policy (Phoenix immediate-or-cancel orders, cancels, collateral in and out, Ember conversions
//! and token moves between the desk's own accounts) and the two Phoenix onboarding messages
//! `sol_sign_register` takes.
//!
//! Every account the rules name is derived from the desk authority ([`SolDesk::derive`]) by the
//! caller; nothing is taken from what an owner registered.

use crate::errors::{
    Refusal, E_ARGS, E_ASSET, E_PRICE_BAND, E_QUOTE_FIELDS, E_SOL_ACCOUNT, E_SOL_MESSAGE,
    E_SOL_PROGRAM,
};
use crate::ids::decode_base58_32;
use crate::limits::{check_value, Valued};
use crate::policy::{PhoenixMarket, Policy};
use crate::solana::{
    associated_token_address, b58, check_transaction_size, parse_message, Format, Instruction,
    Message, Pubkey, Sha256, SolDesk, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, EMBER_AUTHORITY,
    EMBER_PROGRAM, PHOENIX_ONBOARDER, PHOENIX_PROGRAM, PHUSD_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM,
    USDC_MINT,
};

/// The highest compute-unit limit a message may set.
pub const MAX_COMPUTE_UNIT_LIMIT: u32 = 600_000;
/// The highest priority fee a message may set, in micro-lamports per compute unit.
pub const MAX_COMPUTE_UNIT_PRICE: u64 = 1_000_000;

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
    /// True when it only reduces risk, so a paused desk may sign it: every order is reduce-only
    /// and nothing is withdrawn from Phoenix.
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

fn le_u64(bytes: &[u8]) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(word)
}

/// A compute budget instruction within the caps; returns its opcode. Anything but a unit limit
/// or a unit price is `E_SOL_PROGRAM`.
fn check_compute_budget(data: &[u8], n: usize) -> Result<u8, Refusal> {
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
            Ok(SET_COMPUTE_UNIT_LIMIT)
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
            Ok(SET_COMPUTE_UNIT_PRICE)
        }
        _ => Err(at(
            n,
            E_SOL_PROGRAM,
            "only SetComputeUnitLimit and SetComputeUnitPrice are allowed from the compute budget",
        )),
    }
}

/// Compute budget instructions may each come once (Solana refuses a repeat anyway).
#[derive(Default)]
struct Budget {
    seen: Vec<u8>,
}

impl Budget {
    fn check(&mut self, data: &[u8], n: usize) -> Result<(), Refusal> {
        let op = check_compute_budget(data, n)?;
        if self.seen.contains(&op) {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "a repeated compute budget instruction",
            ));
        }
        self.seen.push(op);
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
    policy: &'a Policy,
    desk: &'a SolDesk,
    reference: &'a dyn Fn(&str) -> Option<u128>,
    rescue: Option<&'a Rescue>,
    budget: Budget,
    deposit_account_created: bool,
    rescue_transfers: u32,
    orders: Vec<PhoenixOrder>,
    phoenix: Option<&'static str>,
    withdraws: bool,
}

impl Walk<'_> {
    fn instruction(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        match ix.program {
            COMPUTE_BUDGET_PROGRAM => self.budget.check(ix.data, n),
            ATA_PROGRAM => self.create_token_account(ix, n),
            TOKEN_PROGRAM => self.token(ix, n),
            EMBER_PROGRAM => self.ember(ix, n),
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
        let a = accounts(ix, n, 6)?;
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
                let a = accounts(ix, n, 3)?;
                if !d.is_token_account(&a[0]) || a[1] != EMBER_AUTHORITY {
                    return Err(at(
                        n,
                        E_SOL_ACCOUNT,
                        "only the Ember authority may be approved, on a desk token account",
                    ));
                }
                Ok(())
            }
            Some(&TOKEN_TRANSFER) => {
                if ix.data.len() != 9 {
                    return Err(malformed());
                }
                // source, destination, owner
                let a = accounts(ix, n, 3)?;
                if !d.is_token_account(&a[1]) {
                    return Err(self.foreign_destination(&a[1], n));
                }
                Ok(())
            }
            Some(&TOKEN_TRANSFER_CHECKED) => {
                if ix.data.len() != 10 {
                    return Err(malformed());
                }
                // source, mint, destination, owner
                let a = accounts(ix, n, 4)?;
                if d.is_token_account(&a[2]) {
                    return Ok(());
                }
                let Some(r) = self.rescue.filter(|r| r.deposit_account == a[2]) else {
                    return Err(self.foreign_destination(&a[2], n));
                };
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

    fn ember(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        let disc = ix.data.get(..8);
        if disc != Some(&EMBER_DEPOSIT[..]) && disc != Some(&EMBER_WITHDRAW[..]) {
            return Err(at(
                n,
                E_SOL_PROGRAM,
                "only Ember deposit and withdraw are allowed",
            ));
        }
        let a = accounts(ix, n, 6)?;
        if a[4] != self.desk.usdc_ata || a[5] != self.desk.phusd_ata {
            return Err(at(
                n,
                E_SOL_ACCOUNT,
                "Ember must convert between the desk's own USDC and PhUSD accounts",
            ));
        }
        Ok(())
    }

    fn phoenix(&mut self, ix: &Instruction<'_>, n: usize) -> Result<(), Refusal> {
        let d = *self.desk;
        let disc: [u8; 8] = ix
            .data
            .get(..8)
            .and_then(|s| s.try_into().ok())
            .unwrap_or_default();
        let trader_at = |a: &[Pubkey], i: usize| {
            if a[i] == d.trader {
                Ok(())
            } else {
                Err(at(
                    n,
                    E_SOL_ACCOUNT,
                    format!(
                        "trader account {} is not the desk's, {}",
                        b58(&a[i]),
                        b58(&d.trader)
                    ),
                ))
            }
        };
        match disc {
            PLACE_MARKET_ORDER => {
                if ix.data.get(8) != Some(&IOC_VARIANT) {
                    return Err(at(
                        n,
                        E_SOL_PROGRAM,
                        "only immediate-or-cancel orders (packet variant 2) are allowed",
                    ));
                }
                let a = accounts(ix, n, 6)?;
                trader_at(a, 4)?;
                let order = self.order(ix, a[a.len() - 2], n)?;
                self.orders.push(order);
            }
            CANCEL_ALL => {
                trader_at(accounts(ix, n, 5)?, 4)?;
                self.phoenix.get_or_insert("cancel_all");
            }
            DEPOSIT_FUNDS => {
                let a = accounts(ix, n, 6)?;
                if a[4] != d.phusd_ata {
                    return Err(at(
                        n,
                        E_SOL_ACCOUNT,
                        "a Phoenix deposit must come from the desk's PhUSD account",
                    ));
                }
                trader_at(a, 5)?;
                self.phoenix.get_or_insert("deposit");
            }
            WITHDRAW_FUNDS => {
                let a = accounts(ix, n, 8)?;
                trader_at(a, 4)?;
                if a[7] != d.phusd_ata {
                    return Err(at(
                        n,
                        E_SOL_ACCOUNT,
                        "a Phoenix withdrawal must land in the desk's PhUSD account",
                    ));
                }
                self.withdraws = true;
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

    /// An IOC order on `orderbook`: a market of the policy (`E_ASSET`), a well-formed packet, a
    /// price limit (`E_PRICE_BAND` without one), then the checks every order makes
    /// ([`check_value`]).
    fn order(
        &self,
        ix: &Instruction<'_>,
        orderbook: Pubkey,
        n: usize,
    ) -> Result<PhoenixOrder, Refusal> {
        let market: &PhoenixMarket = self
            .policy
            .phoenix_markets
            .iter()
            .find(|m| decode_base58_32(&m.orderbook) == Some(orderbook))
            .ok_or_else(|| {
                at(
                    n,
                    E_ASSET,
                    format!(
                        "orderbook {} is not a market of the policy",
                        b58(&orderbook)
                    ),
                )
            })?;
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
///   [`MAX_COMPUTE_UNIT_PRICE`], once each;
/// - token account program: `CreateIdempotent` paid by the desk for its own USDC or PhUSD account
///   (or, in a rescue, the deposit owner's USDC account);
/// - SPL Token: `Approve` of a desk token account to the Ember authority, `Transfer` and
///   `TransferChecked` into a desk token account (in a rescue also exactly one `TransferChecked` of
///   `amount_in` USDC into the deposit owner's account created before it, else `E_QUOTE_FIELDS`);
/// - Ember deposit and withdraw between the desk's USDC and PhUSD accounts;
/// - Phoenix: `place_market_order` (immediate-or-cancel only, the desk's trader account, a market of
///   the policy, a price limit, then [`check_value`] at the `reference` price), `cancel_all`,
///   `deposit_funds` and `withdraw_funds` on the desk's own accounts.
///
/// A program outside this list, another instruction of these programs or a value over a cap is
/// `E_SOL_PROGRAM`, an account the desk does not own `E_SOL_ACCOUNT`, a market outside the policy
/// `E_ASSET`.
pub fn check_message(
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
        policy,
        desk,
        reference,
        rescue,
        budget: Budget::default(),
        deposit_account_created: false,
        rescue_transfers: 0,
        orders: Vec::new(),
        phoenix: None,
        withdraws: false,
    };
    for (n, ix) in m.instructions.iter().enumerate() {
        walk.instruction(ix, n)?;
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
    let reduces_risk = walk.orders.iter().all(|o| o.reduce_only) && !walk.withdraws;
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
    accounts: fn(&Pubkey, &Pubkey) -> Vec<Pubkey>,
}

fn register_accounts(authority: &Pubkey, trader: &Pubkey) -> Vec<Pubkey> {
    vec![
        PHOENIX_PROGRAM,
        PHOENIX_LOG_AUTHORITY,
        PHOENIX_GLOBAL_CONFIGURATION,
        *authority, // payer of the rent, the only signer of the two
        *authority, // the trader authority, read-only
        *trader,
        SYSTEM_PROGRAM,
    ]
}

fn capability_accounts(_authority: &Pubkey, trader: &Pubkey) -> Vec<Pubkey> {
    vec![
        PHOENIX_PROGRAM,
        PHOENIX_LOG_AUTHORITY,
        PHOENIX_GLOBAL_CONFIGURATION,
        PHOENIX_ONBOARDER,
        PHOENIX_ONBOARDING_PERMISSION,
        *trader,
        PHOENIX_GLOBAL_TRADER_INDEX,
        PHOENIX_ACTIVE_TRADER_BUFFER,
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
    /// The message type a format stands for: legacy messages are registrations, version 0 ones
    /// referral activations.
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
    check_transaction_size(message.len(), 2)?;
    check_signers(&m, 2, authority)?;
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
        if ix.accounts != (step.accounts)(authority, trader) {
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
    Ok(())
}
