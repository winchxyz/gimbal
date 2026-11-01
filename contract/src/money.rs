//! Money in and out on NEAR (docs/interfaces.md §1.2, §1.3). USDC on NEAR arrives through
//! `ft_on_transfer`, goes to the desk's venues through `fund_venue` and to the owner through
//! `withdraw_to_owner`, which charges the performance fee ([`gimbal_core::fees`]). The desk's
//! `idle_usdc` is what the contract holds for it: every method spends it before its transfer goes
//! out and a callback gives back exactly what a failed transfer did not send.
//!
//! - `fund_venue` pays a verified 1Click quote of USDC on NEAR into one of the desk's own venue
//!   addresses or its pinned Orderly receiver. Its `refundTo` is the desk owner's NEAR account: a
//!   1Click refund on NEAR is a plain `ft_transfer`, which calls nothing in the receiver, so a
//!   refund to the contract would land with no desk to credit. The owner gets it back directly.
//!   A quote pays once: the deposit address goes into the contract-wide `fund_paid` map and the
//!   desk's own `fund_venue` ring of the last 32 transfers ([`crate::rescue::DEPOSIT_RING`], 65
//!   min), and its cost into the desk's own hourly `fund_venue` cost budget
//!   ([`fund_cost_budget_e8`]); the rescues' ring and budget are never touched, so funding cannot
//!   block a rescue. The amount is not capped beyond `idle_usdc`: it only moves the desk's money
//!   into the desk's own accounts.
//!
//!   What is left between the owner and the treasury: a refund goes to the owner and leaves the
//!   books as spent, so idle USDC that held profit (1Click returns) reaches the owner without the
//!   fee, and the owner re-depositing it counts as principal again (`deposited` up by the refund).
//!   Either way the treasury is under-charged by at most `performance_bps` (10 %) of the refunded
//!   amount, and nobody but the owner can gain. A deliberate refund is made hard: the quote must
//!   leave 0.5 % between `amountOut` and `minAmountOut` (`FUND_VENUE_MIN_ROOM_BPS`), so it is not
//!   built to fail; within that, refunds stay rare and cost the owner the round trip.
//! - `withdraw_to_owner` sends the owner's share first and the fee to the treasury only once the
//!   owner's transfer landed. One payout per desk is in flight at a time, so a failed transfer can
//!   be taken back exactly: the whole payout when the owner's transfer failed, the fee alone
//!   (back into `idle_usdc`, due again at the next payout) when only the fee transfer failed. The
//!   callbacks get several times the gas they use; should one still fail, the owner can clear the
//!   lock an hour later with `clear_payout_lock`, which changes nothing else.
//!
//! The contract pays the transfers' 1 yoctoNEAR and the USDC storage registration of the deposit
//! address (0.00125 NEAR; the owner's registration, when it exists already, comes back).

use gimbal_core::decimal::format_e8;
use gimbal_core::errors::{shown, Refusal, E_ARGS, E_NO_DESK, E_SIZE};
use gimbal_core::errors::{E_QUOTE_FIELDS, E_RESCUE_CAP};
use gimbal_core::fees::{Books, Payout};
use gimbal_core::ids::check_reason;
use gimbal_core::oneclick::{
    fund_cost_budget_e8, transfer_cost_e8, Method, VerifiedQuote, QUOTE_PAYABLE_MS,
};
use near_sdk::json_types::{I128, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue};

use crate::deposit::{check_one_yocto, ONE_YOCTO};
use crate::desk::{Gate, Ledger};
use crate::events::{Deposit, Event, FeeCharged, PayoutEvent, PayoutLockCleared};
use crate::rescue::{deposit_of, quote_fields, DeskCounters, DEPOSIT_RING};
use crate::{action_desk, desk_ref, fail, owner_desk, Gimbal, GimbalExt, OrFail};

/// Gas for the USDC contract's `ft_transfer`: near-contract-standards burns about 3 TGas; Circle's
/// token adds its pause and blocklist checks.
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas for the USDC contract's `storage_deposit`.
pub const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
/// USDC on NEAR's storage registration (`storage_balance_bounds`, min = max, read on mainnet and
/// testnet 2026-11-01).
pub const USDC_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

/// The fees a contract prepays for each function call it schedules (sending it and running it):
/// 4.9 TGas under the protocol fees near-sdk's mock charges.
pub const CALL_FEE: Gas = Gas::from_tgas(5);
/// The fees for each promise a scheduled call waits for (a data receipt, sent and received):
/// 9.4 TGas under the same fees.
pub const WAIT_FEE: Gas = Gas::from_tgas(10);
/// Wasm work a method does besides the host calls the mock meters: parsing and checking the quote
/// or the payout, JSON for the receipts' arguments.
pub const OWN_WORK_GAS: Gas = Gas::from_tgas(10);

const fn sum(parts: &[Gas]) -> Gas {
    let mut total = 0;
    let mut i = 0;
    while i < parts.len() {
        total += parts[i].as_gas();
        i += 1;
    }
    Gas::from_gas(total)
}

/// What `fund_venue` uses itself before its calls: its own work, and the fees of the four calls it
/// schedules (two registrations, the transfer, the callback) and of the three results they wait
/// for, 60 TGas.
pub const FUND_VENUE_GAS: Gas = sum(&[
    OWN_WORK_GAS,
    CALL_FEE,
    CALL_FEE,
    CALL_FEE,
    CALL_FEE,
    WAIT_FEE,
    WAIT_FEE,
    WAIT_FEE,
]);
/// Gas for `on_fund_venue`: one result, one small write; it schedules nothing. Far over what it
/// uses (under 1 TGas with its wasm work): a callback that ran out would not re-credit a failed
/// transfer.
pub const ON_FUND_VENUE_GAS: Gas = Gas::from_tgas(20);
/// The least prepaid gas `fund_venue` accepts (`E_ARGS` below it), 115 TGas: its own cost, two
/// storage registrations, the transfer and the callback. The engine attaches 300.
pub const FUND_VENUE_MIN_GAS: Gas = sum(&[
    FUND_VENUE_GAS,
    STORAGE_DEPOSIT_GAS,
    STORAGE_DEPOSIT_GAS,
    FT_TRANSFER_GAS,
    ON_FUND_VENUE_GAS,
]);

/// What `withdraw_to_owner` uses itself: its own work, and the fees of a transfer and its
/// callback, 30 TGas.
pub const WITHDRAW_GAS: Gas = sum(&[OWN_WORK_GAS, CALL_FEE, CALL_FEE, WAIT_FEE]);
/// Gas for `on_payout_fee`: one result, one small write, two events; it schedules nothing. Far
/// over what it uses (under 1 TGas with its wasm work).
pub const ON_PAYOUT_FEE_GAS: Gas = Gas::from_tgas(20);
/// Gas a callback that schedules calls gets beyond its estimate, so it has several times what it
/// uses: the payout lock is released in the callbacks.
pub const CALLBACK_MARGIN_GAS: Gas = Gas::from_tgas(40);
/// Gas for `on_payout_owner`: its own work, the fee transfer and its callback and their fees, and
/// [`CALLBACK_MARGIN_GAS`], 105 TGas.
pub const ON_PAYOUT_OWNER_GAS: Gas = sum(&[
    OWN_WORK_GAS,
    CALL_FEE,
    CALL_FEE,
    WAIT_FEE,
    FT_TRANSFER_GAS,
    ON_PAYOUT_FEE_GAS,
    CALLBACK_MARGIN_GAS,
]);
/// How long a payout lock is held before the owner may clear it (`clear_payout_lock`): a callback
/// runs within a few blocks of its transfer or never.
pub const PAYOUT_LOCK_CLEAR_MS: u64 = 3_600_000;
/// The least prepaid gas `withdraw_to_owner` accepts (`E_ARGS` below it), 150 TGas. The fee-only
/// path (the owner's share is 0) schedules the fee transfer and `on_payout_fee` instead, less.
pub const WITHDRAW_MIN_GAS: Gas = sum(&[WITHDRAW_GAS, FT_TRANSFER_GAS, ON_PAYOUT_OWNER_GAS]);

/// The storage one entry of the contract-wide `fund_paid` map takes: the 1-byte map prefix and
/// the 32-byte hash, the 8-byte time, and the 40 bytes the protocol counts per record.
pub const FUND_PAID_ENTRY_BYTES: u64 = 1 + 32 + 8 + 40;
/// What `create_desk` charges besides what it writes: the desk's share of the contract-wide map,
/// at most one entry per slot of its fund ring, so `fund_venue` never adds storage the owner did
/// not pay for.
pub const FUND_PAID_RESERVE_BYTES: u64 = DEPOSIT_RING as u64 * FUND_PAID_ENTRY_BYTES;

/// The desk's money on NEAR, apart from the desk record: a deposit or a payout reads and writes
/// these bytes (89 plus the owner id and its length, 157 for an implicit account) whatever the
/// size of the policy. Written by `create_desk`, never deleted.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeskMoney {
    /// The desk's owner, as in the desk record (it never changes): deposits from it are principal.
    pub owner: AccountId,
    pub ledger: Ledger,
    /// A `withdraw_to_owner` of this desk has transfers in flight; its callbacks clear it.
    pub payout_pending: bool,
    /// Block time (ms) the pending payout was booked; 0 with none.
    pub payout_since_ms: u64,
    /// The number of the desk's latest payout, from 1; its callbacks carry it, so a late callback
    /// of a payout whose lock the owner cleared does not settle the next one.
    pub payout_seq: u64,
}

impl DeskMoney {
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            ledger: Ledger::default(),
            payout_pending: false,
            payout_since_ms: 0,
            payout_seq: 0,
        }
    }

    fn books(&self) -> Books {
        self.ledger.into()
    }

    fn set_books(&mut self, books: Books) {
        self.ledger = books.into();
    }

    fn unlock(&mut self) {
        self.payout_pending = false;
        self.payout_since_ms = 0;
    }

    /// Whether the payout numbered `seq` is the one in flight.
    fn settles(&self, seq: u64) -> bool {
        self.payout_pending && self.payout_seq == seq
    }
}

/// The `msg` of a USDC `ft_transfer_call` to the contract, `{"desk_id":"<id>"}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct DeskMsg {
    desk_id: String,
}

/// A payout in flight, as its callbacks receive it: [`Payout`] in JSON and its number
/// ([`DeskMoney::payout_seq`]).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingPayout {
    pub seq: u64,
    pub amount: U128,
    pub fee: U128,
    pub profit: I128,
    pub hwm_before: U128,
    pub hwm_after: U128,
}

impl PendingPayout {
    pub fn new(p: Payout, seq: u64) -> Self {
        Self {
            seq,
            amount: U128(p.amount),
            fee: U128(p.fee),
            profit: I128(p.profit),
            hwm_before: U128(p.hwm_before),
            hwm_after: U128(p.hwm_after),
        }
    }
}

impl From<PendingPayout> for Payout {
    fn from(p: PendingPayout) -> Self {
        Self {
            amount: p.amount.0,
            // A fee over the amount cannot come from `Books::payout`; clamp so `to_owner` holds.
            fee: p.fee.0.min(p.amount.0),
            profit: p.profit.0,
            hwm_before: p.hwm_before.0,
            hwm_after: p.hwm_after.0,
        }
    }
}

/// A checked `fund_venue`, its USDC taken from the desk: what to send where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundVenue {
    pub desk_id: String,
    /// The quote's 1Click deposit address on NEAR.
    pub deposit: AccountId,
    /// The desk owner: the quote's `refundTo`, registered on USDC so the refund can land.
    pub owner: AccountId,
    /// USDC × 1e6, the quote's `amountIn`.
    pub amount: u128,
}

/// A `fund_venue` counted on the desk's own meters: the new counters, the deposit address's hash
/// for the contract-wide map, and the hash (with its paid time) the ring slot forgot, which leaves
/// that map.
pub struct CountedFund {
    pub counters: DeskCounters,
    pub deposit_sha256: [u8; 32],
    pub forgotten: Option<([u8; 32], u64)>,
}

/// Whether the one promise the callback waits for succeeded. `ft_transfer` returns nothing, so
/// any value is a success; only a failed receipt is a failure. Reading no bytes of the value keeps
/// a long answer from turning a sent transfer into a re-credit.
pub fn transfer_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// `E_ARGS` below `min` prepaid gas for `method`.
pub fn check_gas(method: &str, prepaid: Gas, min: Gas) -> Result<(), Refusal> {
    if prepaid >= min {
        return Ok(());
    }
    Err(Refusal::new(
        E_ARGS,
        format!(
            "{method} needs at least {} TGas attached (300 TGas recommended), not {}",
            min.as_tgas(),
            prepaid.as_tgas()
        ),
    ))
}

fn ft_transfer(token: &AccountId, receiver: &AccountId, amount: u128, memo: String) -> Promise {
    let args = json!({ "receiver_id": receiver, "amount": U128(amount), "memo": memo });
    Promise::new(token.clone()).function_call(
        "ft_transfer".to_owned(),
        args.to_string().into_bytes(),
        ONE_YOCTO,
        FT_TRANSFER_GAS,
    )
}

fn storage_deposit(token: &AccountId, account: &AccountId) -> Promise {
    let args = json!({ "account_id": account, "registration_only": true });
    Promise::new(token.clone()).function_call(
        "storage_deposit".to_owned(),
        args.to_string().into_bytes(),
        USDC_STORAGE_DEPOSIT,
        STORAGE_DEPOSIT_GAS,
    )
}

#[near]
impl Gimbal {
    /// NEP-141 receiver for USDC on NEAR sent with `ft_transfer_call` and `msg`
    /// `{"desk_id":"<id>"}`, from any sender. From the desk owner it is principal (`deposited`
    /// and `idle_usdc`), from anyone else (1Click returns and refunds) `idle_usdc` only. Another
    /// token, another `msg` or an unknown desk: the whole amount is returned as unused, so the
    /// token refunds it. Never charges a fee. Event `deposit`.
    #[deny_unknown_arguments]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        match self.credit(&sender_id, amount.0, &msg) {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(why) => {
                env::log_str(&format!("refunded {} to {sender_id}: {why}", amount.0));
                PromiseOrValue::Value(amount)
            }
        }
    }

    /// Sends the quote's `amountIn` of the desk's idle USDC on NEAR to the quote's 1Click deposit
    /// address. The quote: a live 1Click quote of USDC on NEAR (`E_QUOTE_SIGNATURE`), into another
    /// asset, paying the desk's EVM address on HyperCore, its Solana authority or its pinned
    /// Orderly receiver on Arbitrum (`minAmountOut` ≥ 6 USDC there), refunds to the desk owner's
    /// NEAR account, signed at most 1 h before the block time (5 min after it), within the
    /// policy's transfer cost, a deposit address none of the desk's last 32 transfers paid
    /// (`E_QUOTE_FIELDS`), within what is left of the hourly cost budget, and not a 33rd transfer
    /// within 65 min (`E_RESCUE_CAP`). At most the desk's `idle_usdc` (`E_SIZE`). Owner or
    /// operator, also on a paused desk (it adds margin); at least [`FUND_VENUE_MIN_GAS`]
    /// (`E_ARGS`). Registers the deposit address and the owner on USDC, then `ft_transfer`;
    /// returns `true`, or `false` when the transfer failed and the USDC is back in `idle_usdc`.
    #[deny_unknown_arguments]
    pub fn fund_venue(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> Promise {
        check_gas("fund_venue", env::prepaid_gas(), FUND_VENUE_MIN_GAS).or_fail();
        let transfer = self.prepare_fund_venue(desk_id, quote, quote_signature, reason);
        self.send_fund_venue(transfer)
    }

    /// The callback of `fund_venue`'s transfer: `true` once it landed; otherwise the amount goes
    /// back into the desk's `idle_usdc` and it returns `false`. The deposit address stays in the
    /// ring and the cost stays counted, as for every rescue. Never panics.
    #[private]
    pub fn on_fund_venue(&mut self, desk_id: String, amount: U128) -> bool {
        if transfer_succeeded() {
            return true;
        }
        if let Some(money) = self.money.get_mut(&desk_id) {
            money.ledger.idle_usdc = money.ledger.idle_usdc.saturating_add(amount.0);
        }
        env::log_str(&format!(
            "fund_venue of {} for desk {desk_id} failed; back in its idle USDC",
            amount.0
        ));
        false
    }

    /// Pays `amount` of the desk's idle USDC on NEAR out to its owner, less the performance fee
    /// (`gimbal_core::fees`), which goes to the treasury. Owner only, exactly 1 yoctoNEAR
    /// (`E_NOT_ALLOWED`), also on a paused desk; `amount` from 1 to `idle_usdc` (`E_SIZE`); one
    /// payout of a desk at a time and at least [`WITHDRAW_MIN_GAS`] (`E_ARGS`). The owner's share
    /// goes first, the fee after it lands. Returns `true` once the owner was paid, `false` when
    /// nothing left the contract (the ledger is then as before). Events `payout` and
    /// `fee_charged`, once the transfers settled.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw_to_owner(&mut self, desk_id: String, amount: U128) -> Promise {
        let owner = owner_desk(&self.desks, &desk_id, "withdraw_to_owner")
            .owner
            .clone();
        check_one_yocto("withdraw_to_owner", env::attached_deposit()).or_fail();
        check_gas("withdraw_to_owner", env::prepaid_gas(), WITHDRAW_MIN_GAS).or_fail();
        let payout = self.book_payout(&desk_id, amount.0);
        self.send_payout(desk_id, owner, payout)
    }

    /// The callback of the owner's transfer. Failed: the payout is taken back whole and it returns
    /// `false`. Landed with no fee: `payout`, `true`. Landed with a fee: the fee transfer to the
    /// treasury and [`Self::on_payout_fee`]. Never panics. A callback of a payout that is no longer
    /// the one in flight (the owner cleared its lock, then withdrew again) gives back only the
    /// amounts a failed transfer did not send and leaves the high-water mark and the lock to the
    /// payout in flight.
    #[private]
    pub fn on_payout_owner(
        &mut self,
        desk_id: String,
        owner: AccountId,
        payout: PendingPayout,
    ) -> PromiseOrValue<bool> {
        let p = Payout::from(payout);
        if !transfer_succeeded() {
            if let Some(money) = self.money.get_mut(&desk_id) {
                let mut books = money.books();
                if money.settles(payout.seq) {
                    books.undo_payout(&p);
                    money.set_books(books);
                    money.unlock();
                } else {
                    books.return_payout(&p);
                    money.set_books(books);
                }
            }
            env::log_str(&format!(
                "the payout of {} to {owner} failed; desk {desk_id}'s ledger is as before",
                p.amount
            ));
            return PromiseOrValue::Value(false);
        }
        if p.fee == 0 {
            self.end_payout(&desk_id, payout.seq);
            emit_payout(&desk_id, &owner, &p);
            return PromiseOrValue::Value(true);
        }
        PromiseOrValue::Promise(self.send_fee(desk_id, owner, payout))
    }

    /// The callback of the fee transfer. Landed: `payout` and `fee_charged`. Failed: the fee goes
    /// back into the desk's idle USDC and the high-water mark back to before the payout, so the
    /// next payout charges it; `payout` then says what the owner received, with no fee. Returns
    /// whether anything reached the owner. Never panics.
    #[private]
    pub fn on_payout_fee(
        &mut self,
        desk_id: String,
        owner: AccountId,
        payout: PendingPayout,
    ) -> bool {
        let p = Payout::from(payout);
        let landed = transfer_succeeded();
        if landed {
            self.end_payout(&desk_id, payout.seq);
            emit_payout(&desk_id, &owner, &p);
            FeeCharged {
                desk_id: &desk_id,
                kind: "performance",
                amount: U128(p.fee),
                treasury: &self.config.treasury.near,
            }
            .emit();
            return true;
        }
        if let Some(money) = self.money.get_mut(&desk_id) {
            let mut books = money.books();
            if money.settles(payout.seq) {
                books.undo_fee(&p);
                money.set_books(books);
                money.unlock();
            } else {
                books.return_fee(&p);
                money.set_books(books);
            }
        }
        env::log_str(&format!(
            "the fee of {} for desk {desk_id} did not reach the treasury; it is back in the desk's \
             idle USDC and due at the next payout",
            p.fee
        ));
        if p.to_owner() == 0 {
            return false;
        }
        let paid = Payout {
            amount: p.to_owner(),
            fee: 0,
            profit: p
                .profit
                .saturating_sub(i128::try_from(p.fee).unwrap_or(i128::MAX)),
            hwm_before: p.hwm_before,
            hwm_after: p.hwm_before,
        };
        emit_payout(&desk_id, &owner, &paid);
        true
    }

    /// The owner's way out of a payout lock that its callbacks never released (a callback that
    /// failed, out of gas say): once the lock has been held for [`PAYOUT_LOCK_CLEAR_MS`] (1 h),
    /// clears it (`E_ARGS` before then or with no lock). Owner only, exactly 1 yoctoNEAR
    /// (`E_NOT_ALLOWED`). It re-credits nothing and rolls nothing back: the ledger stays as
    /// `withdraw_to_owner` booked it (the whole amount out, the fee charged), because the contract
    /// cannot know whether the transfers landed, and crediting a payout that did land would pay it
    /// twice. Event `payout_lock_cleared`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn clear_payout_lock(&mut self, desk_id: String) {
        owner_desk(&self.desks, &desk_id, "clear_payout_lock");
        check_one_yocto("clear_payout_lock", env::attached_deposit()).or_fail();
        let now_ms = env::block_timestamp_ms();
        let money = self.money_mut(&desk_id);
        if !money.payout_pending {
            fail(Refusal::new(
                E_ARGS,
                format!("desk {desk_id} has no payout in flight"),
            ));
        }
        let since_ms = money.payout_since_ms;
        let free_at_ms = since_ms.saturating_add(PAYOUT_LOCK_CLEAR_MS);
        if now_ms < free_at_ms {
            fail(Refusal::new(
                E_ARGS,
                format!(
                    "the payout of desk {desk_id} was booked at {since_ms} ms; its lock can be \
                     cleared from {free_at_ms} ms"
                ),
            ));
        }
        money.unlock();
        PayoutLockCleared {
            desk_id: &desk_id,
            locked_since_ms: since_ms,
            ledger: "unchanged",
        }
        .emit();
    }
}

impl Gimbal {
    /// The USDC token contract on NEAR of the contract's network.
    pub fn usdc(&self) -> AccountId {
        // A constant of the core, a valid account id.
        self.config
            .network
            .near_usdc()
            .parse()
            .unwrap_or_else(|_| env::abort())
    }

    /// The desk's money record, or `E_NO_DESK`.
    pub fn money_ref(&self, desk_id: &str) -> &DeskMoney {
        self.money.get(desk_id).unwrap_or_else(|| {
            fail(Refusal::new(
                E_NO_DESK,
                format!("no desk {}", shown(desk_id)),
            ))
        })
    }

    fn money_mut(&mut self, desk_id: &str) -> &mut DeskMoney {
        self.money.get_mut(desk_id).unwrap_or_else(|| {
            fail(Refusal::new(
                E_NO_DESK,
                format!("no desk {}", shown(desk_id)),
            ))
        })
    }

    /// [`Self::ft_on_transfer`]'s credit, or why the amount goes back.
    fn credit(&mut self, sender: &AccountId, amount: u128, msg: &str) -> Result<(), String> {
        let token = env::predecessor_account_id();
        let usdc = self.config.network.near_usdc();
        if token.as_str() != usdc {
            return Err(format!("{token} is not USDC on NEAR ({usdc})"));
        }
        let DeskMsg { desk_id } = serde_json::from_str(msg)
            .map_err(|_| format!("msg {} is not {{\"desk_id\":\"<id>\"}}", shown(msg)))?;
        let money = self
            .money
            .get_mut(&desk_id)
            .ok_or_else(|| format!("no desk {}", shown(&desk_id)))?;
        let principal = *sender == money.owner;
        let mut books = money.books();
        if principal {
            books.deposit_principal(amount);
        } else {
            books.deposit_return(amount);
        }
        money.set_books(books);
        Deposit {
            desk_id: &desk_id,
            sender,
            amount: U128(amount),
            principal,
            deposited_total: U128(books.deposited),
            idle_usdc: U128(books.idle_usdc),
        }
        .emit();
        Ok(())
    }

    /// [`Self::fund_venue`] up to its transfer.
    pub fn prepare_fund_venue(
        &mut self,
        desk_id: String,
        quote: String,
        quote_signature: String,
        reason: String,
    ) -> FundVenue {
        action_desk(&self.desks, &desk_id, Gate::ReducesRisk);
        check_reason(&reason).or_fail();
        let q = self.verified_quote(&desk_id, &quote, &quote_signature, Method::FundVenue);
        self.build_fund_venue(desk_id, &q)
    }

    /// The desk's `fund_venue` counters with the verified quote `q` counted at the block time, or
    /// the refusal: `E_QUOTE_FIELDS` for a deposit address any desk's `fund_venue` paid within
    /// [`QUOTE_PAYABLE_MS`] (a quote pays once, contract-wide), `E_RESCUE_CAP` for a 33rd
    /// `fund_venue` of the desk within 65 min (its ring would forget an address a quote can still
    /// pay) or a cost ([`transfer_cost_e8`]) over what is left of the desk's hourly `fund_venue`
    /// cost budget ([`fund_cost_budget_e8`]). Writes nothing.
    pub fn counted_fund_venue(&self, desk_id: &str, q: &VerifiedQuote) -> CountedFund {
        let policy = &desk_ref(&self.desks, desk_id).policy;
        let now_ms = env::block_timestamp_ms();
        let mut counters = self.fund_counters.get(desk_id).copied().unwrap_or_default();
        let deposit = deposit_of(q);
        let deposit_sha256 = env::sha256_array(deposit.as_bytes());
        if let Some(paid_ms) = self.fund_paid.get(&deposit_sha256) {
            if now_ms.saturating_sub(*paid_ms) <= QUOTE_PAYABLE_MS {
                fail(Refusal::new(
                    E_QUOTE_FIELDS,
                    format!(
                        "deposit address {deposit} was paid by a fund_venue at {paid_ms} ms; a \
                         quote pays once"
                    ),
                ));
            }
        }
        if let Some(paid_ms) = counters.held(now_ms) {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "this desk's last {DEPOSIT_RING} fund_venue transfers were paid within 65 min, \
                     the oldest at {paid_ms} ms: the next one waits until after {} ms",
                    paid_ms.saturating_add(QUOTE_PAYABLE_MS)
                ),
            ));
        }
        let cost = transfer_cost_e8(q);
        let budget = fund_cost_budget_e8(
            policy
                .max_notional_usd
                .max(policy.unpriced_max_notional_usd),
            policy.max_transfer_cost_bps,
            policy.max_transfer_cost_flat_e6,
        );
        let cost_left = counters.remaining_cost_e8(budget, now_ms);
        if cost > cost_left {
            fail(Refusal::new(
                E_RESCUE_CAP,
                format!(
                    "the fund_venue may cost {} USD, over what is left of the hourly fund_venue \
                     cost budget, {} of {} USD",
                    format_e8(cost),
                    format_e8(cost_left),
                    format_e8(budget)
                ),
            ));
        }
        let slot = usize::from(counters.deposit_next) % DEPOSIT_RING;
        let forgotten = (counters.deposits[slot] != [0; 32])
            .then(|| (counters.deposits[slot], counters.deposit_paid_ms[slot]));
        counters.spend(0, cost, deposit_sha256, now_ms);
        CountedFund {
            counters,
            deposit_sha256,
            forgotten,
        }
    }

    /// The transfer of a verified quote of USDC on NEAR: its deposit address counted in the
    /// desk's ring and its cost in the hourly budget, its amount taken from `idle_usdc`.
    pub fn build_fund_venue(&mut self, desk_id: String, q: &VerifiedQuote) -> FundVenue {
        let deposit_text = deposit_of(q);
        let deposit: AccountId = deposit_text
            .parse()
            .map_err(|_| {
                quote_fields(format!(
                    "depositAddress {} is not a NEAR account",
                    shown(&deposit_text)
                ))
            })
            .or_fail();
        if deposit == env::current_account_id() {
            fail(quote_fields("depositAddress is the contract itself"));
        }
        let idle = self.money_ref(&desk_id).ledger.idle_usdc;
        if q.amount_in > idle {
            fail(Refusal::new(
                E_SIZE,
                format!(
                    "amountIn {} is over desk {desk_id}'s idle USDC on NEAR, {idle} (USDC × 1e6)",
                    q.amount_in
                ),
            ));
        }
        let counted = self.counted_fund_venue(&desk_id, q);
        self.fund_counters.insert(desk_id.clone(), counted.counters);
        if let Some((old, old_ms)) = counted.forgotten {
            if self.fund_paid.get(&old) == Some(&old_ms) {
                self.fund_paid.remove(&old);
            }
        }
        self.fund_paid
            .insert(counted.deposit_sha256, env::block_timestamp_ms());
        let money = self.money_mut(&desk_id);
        money.ledger.idle_usdc -= q.amount_in;
        FundVenue {
            owner: money.owner.clone(),
            desk_id,
            deposit,
            amount: q.amount_in,
        }
    }

    /// Registers the deposit address and the owner on USDC (a registered account gets the deposit
    /// back), then sends the USDC and calls [`Self::on_fund_venue`]. Each step runs whatever the
    /// one before it returned: a token that refuses a second registration does not stop the
    /// transfer, and a transfer to an unregistered address fails and is re-credited.
    pub fn send_fund_venue(&self, t: FundVenue) -> Promise {
        let usdc = self.usdc();
        storage_deposit(&usdc, &t.deposit)
            .and(storage_deposit(&usdc, &t.owner))
            .then(ft_transfer(
                &usdc,
                &t.deposit,
                t.amount,
                format!("gimbal fund_venue {}", t.desk_id),
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_FUND_VENUE_GAS)
                    .with_unused_gas_weight(0)
                    .on_fund_venue(t.desk_id, U128(t.amount)),
            )
    }

    /// Books a payout of `amount` and marks it in flight: `E_ARGS` while another one is,
    /// `E_SIZE` for 0 or more than `idle_usdc`.
    pub fn book_payout(&mut self, desk_id: &str, amount: u128) -> PendingPayout {
        let bps = self.config.fees.performance_bps;
        let money = self.money_mut(desk_id);
        if money.payout_pending {
            fail(Refusal::new(
                E_ARGS,
                format!(
                    "a payout of desk {desk_id} is still in flight; withdraw again once it settled"
                ),
            ));
        }
        let idle = money.ledger.idle_usdc;
        if amount == 0 || amount > idle {
            fail(Refusal::new(
                E_SIZE,
                format!(
                    "amount {amount} must be from 1 to desk {desk_id}'s idle USDC on NEAR, {idle} \
                     (USDC × 1e6)"
                ),
            ));
        }
        let mut books = money.books();
        let payout = books.payout(amount, bps);
        books.apply(&payout);
        money.set_books(books);
        money.payout_pending = true;
        money.payout_since_ms = env::block_timestamp_ms();
        money.payout_seq += 1;
        PendingPayout::new(payout, money.payout_seq)
    }

    /// The owner's share to the owner, then [`Self::on_payout_owner`]; a payout that is all fee
    /// (the owner's share is 0) goes straight to the fee transfer.
    pub fn send_payout(
        &self,
        desk_id: String,
        owner: AccountId,
        pending: PendingPayout,
    ) -> Promise {
        let to_owner = Payout::from(pending).to_owner();
        if to_owner == 0 {
            return self.send_fee(desk_id, owner, pending);
        }
        ft_transfer(
            &self.usdc(),
            &owner,
            to_owner,
            format!("gimbal payout {desk_id}"),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_PAYOUT_OWNER_GAS)
                .with_unused_gas_weight(0)
                .on_payout_owner(desk_id, owner, pending),
        )
    }

    /// The fee to the treasury, then [`Self::on_payout_fee`].
    fn send_fee(&self, desk_id: String, owner: AccountId, payout: PendingPayout) -> Promise {
        ft_transfer(
            &self.usdc(),
            &self.config.treasury.near,
            payout.fee.0,
            format!("gimbal performance fee {desk_id}"),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_PAYOUT_FEE_GAS)
                .with_unused_gas_weight(0)
                .on_payout_fee(desk_id, owner, payout),
        )
    }

    /// Releases the lock when payout `seq` is the one in flight.
    fn end_payout(&mut self, desk_id: &str, seq: u64) {
        if let Some(money) = self.money.get_mut(desk_id) {
            if money.settles(seq) {
                money.unlock();
            }
        }
    }
}

fn emit_payout(desk_id: &str, owner: &AccountId, p: &Payout) {
    PayoutEvent {
        desk_id,
        to: owner,
        amount: U128(p.amount),
        fee: U128(p.fee),
        profit: I128(p.profit),
        hwm: U128(p.hwm_after),
    }
    .emit();
}
