//! The performance fee (docs/interfaces.md §1.2): a share of the profit the owner is paid out above
//! the desk's high-water mark, charged on `withdraw_to_owner` only. Nothing is charged on deposits,
//! fund moves between venues, rescues or losses.
//!
//! On a payout `x` (taken from the desk's idle USDC, the fee included):
//! `profit = withdrawn + x − deposited`; the mark goes to `max(hwm, profit)` and the fee is what
//! that adds to the fees the mark stands for, `⌊bps × mark / 10⁴⌋`: `fee = ⌊bps × max(hwm, profit)
//! / 10⁴⌋ − ⌊bps × hwm / 10⁴⌋`, which is `performance_bps × max(0, profit − hwm) / 10⁴` up to the
//! rounding. `withdrawn` counts every payout whole, the fee included, so `withdrawn − fees_paid` is
//! what the owner received and `profit` is the desk's profit before fees.
//!
//! The fees telescope: whenever they all landed, the fees charged up to a mark are exactly
//! `⌊bps × mark / 10⁴⌋`, so a payout split in any number of parts costs the owner exactly what it
//! would unsplit, for every bps, and rounding never goes to the treasury. A fee is never more than
//! `x`: when less than the fee due is charged (a payout smaller than the fee due, after a failed
//! fee transfer), the mark rises only to the highest one that fee pays for, and the rest stays
//! due.
//!
//! A payout is two transfers, the owner's share first and the fee after it. [`Books::undo_payout`]
//! takes the whole payout back when the owner's transfer failed (nothing left the contract), and
//! [`Books::undo_fee`] takes the fee back when only the fee transfer failed: the desk keeps the fee
//! in its idle USDC and the high-water mark goes back to where it was, so the next payout charges it
//! again, once.

/// What a desk's ledger says about fees, USDC × 1e6: the fields of the contract's `Ledger` the fee
/// formula reads and writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Books {
    /// The owner's own deposits.
    pub deposited: u128,
    /// Every payout to the owner, whole (the fee included).
    pub withdrawn: u128,
    /// Every fee the treasury received.
    pub fees_paid: u128,
    /// The highest `profit` a payout reached, never below 0.
    pub hwm: u128,
    /// USDC the contract holds for the desk.
    pub idle_usdc: u128,
}

/// How one payout splits, and what it changed, so a failed transfer can be taken back exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payout {
    /// What the payout takes from the desk's idle USDC: the owner's share and the fee.
    pub amount: u128,
    /// The performance fee, to the treasury; at most `amount`.
    pub fee: u128,
    /// `withdrawn + amount − deposited` at the payout, before fees; negative after a loss.
    pub profit: i128,
    /// The high-water mark before the payout.
    pub hwm_before: u128,
    /// The high-water mark after it.
    pub hwm_after: u128,
}

impl Payout {
    /// What the owner receives.
    pub const fn to_owner(&self) -> u128 {
        self.amount - self.fee
    }
}

/// The highest mark whose fees, `⌊bps × mark / 10⁴⌋`, are at most `fees`: ⌊((fees + 1) × 10⁴ − 1)
/// / bps⌋. With bps ≤ 10⁴ the fees of a mark rise by at most 1 per unit, so that mark's fees are
/// exactly `fees` whenever a higher mark's are more.
fn mark_paid_by(fees: u128, performance_bps: u16) -> u128 {
    if performance_bps == 0 {
        return u128::MAX;
    }
    fees.checked_add(1)
        .and_then(|f| f.checked_mul(10_000))
        .map_or(u128::MAX, |v| (v - 1) / u128::from(performance_bps))
}

/// `performance_bps × value / 10⁴`, rounded down, without the product overflowing.
pub fn share_down(value: u128, performance_bps: u16) -> u128 {
    let bps = u128::from(performance_bps);
    (value / 10_000) * bps + (value % 10_000) * bps / 10_000
}

/// `a − b` as a signed number; saturates far beyond any USDC amount.
fn signed_diff(a: u128, b: u128) -> i128 {
    let clamp = |v: u128| i128::try_from(v).unwrap_or(i128::MAX);
    if a >= b {
        clamp(a - b)
    } else {
        -clamp(b - a)
    }
}

impl Books {
    /// The fee and the new high-water mark of a payout of `amount` (§1.2). Changes nothing; the
    /// caller checked `amount ≤ idle_usdc`.
    pub fn payout(&self, amount: u128, performance_bps: u16) -> Payout {
        let paid = self.withdrawn.saturating_add(amount);
        let target = self.hwm.max(paid.saturating_sub(self.deposited));
        let charged = share_down(self.hwm, performance_bps);
        let due = share_down(target, performance_bps) - charged;
        let (fee, hwm_after) = if due <= amount {
            (due, target)
        } else {
            // Cut to the payout: the mark rises only as far as the fee pays for.
            let mark = mark_paid_by(charged + amount, performance_bps);
            (amount, mark.clamp(self.hwm, target))
        };
        Payout {
            amount,
            fee,
            profit: signed_diff(paid, self.deposited),
            hwm_before: self.hwm,
            hwm_after,
        }
    }

    /// Books payout `p` before its transfers go out: idle down by the whole amount, withdrawn and
    /// fees up, the new high-water mark.
    pub fn apply(&mut self, p: &Payout) {
        self.idle_usdc = self.idle_usdc.saturating_sub(p.amount);
        self.withdrawn = self.withdrawn.saturating_add(p.amount);
        self.fees_paid = self.fees_paid.saturating_add(p.fee);
        self.hwm = p.hwm_after;
    }

    /// Takes back payout `p` whole: the owner's transfer failed and the fee was not sent.
    pub fn undo_payout(&mut self, p: &Payout) {
        self.return_payout(p);
        self.hwm = p.hwm_before;
    }

    /// The amounts of [`Self::undo_payout`] alone, the high-water mark left as it is: for a payout
    /// settled after a later one was booked, whose mark is that later payout's.
    pub fn return_payout(&mut self, p: &Payout) {
        self.idle_usdc = self.idle_usdc.saturating_add(p.amount);
        self.withdrawn = self.withdrawn.saturating_sub(p.amount);
        self.fees_paid = self.fees_paid.saturating_sub(p.fee);
    }

    /// Takes back the fee of payout `p`: the owner received `p.to_owner()`, the fee transfer
    /// failed. The ledger is then that of a payout of `p.to_owner()` that set no high-water mark,
    /// whose fee is still due: the fee stays in the desk's idle USDC and the next payout charges it.
    pub fn undo_fee(&mut self, p: &Payout) {
        self.return_fee(p);
        self.hwm = p.hwm_before;
    }

    /// The amounts of [`Self::undo_fee`] alone, the high-water mark left as it is (see
    /// [`Self::return_payout`]).
    pub fn return_fee(&mut self, p: &Payout) {
        self.idle_usdc = self.idle_usdc.saturating_add(p.fee);
        self.withdrawn = self.withdrawn.saturating_sub(p.fee);
        self.fees_paid = self.fees_paid.saturating_sub(p.fee);
    }

    /// An owner deposit: principal and idle USDC.
    pub fn deposit_principal(&mut self, amount: u128) {
        self.deposited = self.deposited.saturating_add(amount);
        self.idle_usdc = self.idle_usdc.saturating_add(amount);
    }

    /// USDC from anyone but the owner (1Click returns and refunds): idle only, never principal,
    /// so it counts as profit when it is paid out.
    pub fn deposit_return(&mut self, amount: u128) {
        self.idle_usdc = self.idle_usdc.saturating_add(amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000;
    const BPS: u16 = 1000;

    /// Pays `amount` out of `b` as the contract does when both transfers land; returns the fee.
    fn pay(b: &mut Books, amount: u128) -> u128 {
        assert!(
            amount <= b.idle_usdc,
            "the test pays out more than the desk holds"
        );
        let p = b.payout(amount, BPS);
        b.apply(&p);
        p.fee
    }

    /// The desk's venues earn or lose `delta` and it all comes back to idle as returns.
    fn venue_result(b: &mut Books, back: u128) {
        b.deposit_return(back);
    }

    #[test]
    fn the_share_rounds_down_and_never_overflows() {
        assert_eq!(share_down(10 * USDC, 1000), USDC);
        assert_eq!(share_down(9, 1000), 0);
        assert_eq!(share_down(19, 1000), 1);
        assert_eq!(share_down(99_999, 1), 9);
        assert_eq!(share_down(u128::MAX, 10_000), u128::MAX);
        assert_eq!(share_down(u128::MAX, 0), 0);
        assert_eq!(
            share_down(u128::MAX, 5000),
            u128::MAX / 10_000 * 5000 + (u128::MAX % 10_000) * 5000 / 10_000
        );
    }

    /// Profit, a loss, the recovery up to the old mark (no fee), then new profit above it.
    #[test]
    fn the_high_water_mark_across_profit_loss_recovery_and_new_profit() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        // The desk earns 10: paying out all 110 charges 10% of 10.
        b.idle_usdc = 0;
        venue_result(&mut b, 110 * USDC);
        assert_eq!(pay(&mut b, 110 * USDC), USDC);
        assert_eq!(
            (b.withdrawn, b.fees_paid, b.hwm),
            (110 * USDC, USDC, 10 * USDC)
        );

        // A new deposit of 100 loses 20: nothing is charged on the 80 paid out.
        b.deposit_principal(100 * USDC);
        b.idle_usdc = 0;
        venue_result(&mut b, 80 * USDC);
        assert_eq!(pay(&mut b, 80 * USDC), 0);
        assert_eq!(b.hwm, 10 * USDC, "a loss leaves the mark");
        let p = b.payout(0, BPS);
        assert_eq!(p.profit, -10 * USDC as i128);

        // Another 100 earns 20, which only makes the 20 lost back: profit is 10 again, no fee.
        b.deposit_principal(100 * USDC);
        b.idle_usdc = 0;
        venue_result(&mut b, 120 * USDC);
        assert_eq!(pay(&mut b, 120 * USDC), 0);
        assert_eq!(b.hwm, 10 * USDC);

        // Another 100 earns 5 above the mark: 10% of 5.
        b.deposit_principal(100 * USDC);
        b.idle_usdc = 0;
        venue_result(&mut b, 105 * USDC);
        assert_eq!(pay(&mut b, 105 * USDC), USDC / 2);
        assert_eq!(b.hwm, 15 * USDC);
        assert_eq!(b.fees_paid, USDC + USDC / 2);
        // In all: 400 deposited, 415 paid out, 15 profit, 1.5 fees.
        assert_eq!((b.deposited, b.withdrawn), (400 * USDC, 415 * USDC));
    }

    /// Payouts below the principal charge nothing; the fee starts once payouts pass it.
    #[test]
    fn partial_payouts_charge_only_above_the_principal() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        venue_result(&mut b, 20 * USDC);
        assert_eq!(pay(&mut b, 60 * USDC), 0);
        assert_eq!(b.hwm, 0);
        assert_eq!(pay(&mut b, 40 * USDC), 0, "exactly the principal back");
        assert_eq!(pay(&mut b, 20 * USDC), 2 * USDC);
        assert_eq!(b.idle_usdc, 0);
        assert_eq!(b.hwm, 20 * USDC);
    }

    #[test]
    fn deposits_and_returns_charge_nothing() {
        let mut b = Books::default();
        b.deposit_principal(50 * USDC);
        b.deposit_return(7 * USDC);
        assert_eq!(b.fees_paid, 0);
        assert_eq!(
            b.deposited,
            50 * USDC,
            "a return never raises the principal"
        );
        assert_eq!(b.idle_usdc, 57 * USDC);
        // The 7 a stranger or 1Click sent counts as profit when it is paid out.
        assert_eq!(pay(&mut b, 57 * USDC), 700_000);
    }

    /// An owner taking back a deposit at once pays nothing, however it is split.
    #[test]
    fn taking_the_principal_back_is_free() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        for _ in 0..4 {
            assert_eq!(pay(&mut b, 25 * USDC), 0);
        }
        assert_eq!((b.fees_paid, b.hwm, b.idle_usdc), (0, 0, 0));
    }

    /// The fees telescope, so splitting a payout costs the owner exactly what it would unsplit.
    #[test]
    fn rounding_goes_to_the_owner() {
        let mut b = Books::default();
        b.deposit_principal(1);
        venue_result(&mut b, 19);
        // Profit 19 base units: 10% is 1.9, charged 1.
        assert_eq!(b.payout(20, BPS).fee, 1);
        // Paid in single units: the fee of 1 comes when the mark reaches 10, the total is the
        // unsplit payout's.
        let mut split = b;
        let total: u128 = (0..20).map(|_| pay(&mut split, 1)).sum();
        assert_eq!(total, 1);
        assert_eq!(split.hwm, 19);
        // A fee rounded down never charges the remainder twice: 15 then 5 is 1 + 1, as 20 at once.
        let mut e = Books::default();
        e.deposit_principal(100);
        e.deposit_return(20);
        assert_eq!(pay(&mut e, 115), 1);
        assert_eq!(pay(&mut e, 5), 1);
        let mut f = Books::default();
        f.deposit_principal(100);
        f.deposit_return(20);
        assert_eq!(pay(&mut f, 120), 2);
        // At 33.33%: 1/3 of 10 is 3.33, charged 3.
        let mut c = Books::default();
        c.deposit_return(10);
        assert_eq!(c.payout(10, 3333).fee, 3);
        // 100%: the whole profit, never more than the payout.
        let mut d = Books::default();
        d.deposit_return(10);
        assert_eq!(d.payout(10, 10_000).fee, 10);
        assert_eq!(d.payout(4, 10_000).fee, 4);
        // 0 bps: nothing.
        assert_eq!(d.payout(10, 0).fee, 0);
    }

    /// The owner's transfer failed: the ledger is back where it was.
    #[test]
    fn a_failed_owner_transfer_restores_the_ledger() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        venue_result(&mut b, 10 * USDC);
        let before = b;
        let p = b.payout(110 * USDC, BPS);
        assert_eq!((p.fee, p.to_owner()), (USDC, 109 * USDC));
        b.apply(&p);
        assert_ne!(b, before);
        b.undo_payout(&p);
        assert_eq!(b, before);
        // The same payout charges the same fee again.
        assert_eq!(b.payout(110 * USDC, BPS), p);
    }

    /// Only the fee transfer failed: the owner keeps what they received, the fee stays with the
    /// desk, and the next payout charges it once, never twice.
    #[test]
    fn a_failed_fee_transfer_charges_the_fee_once_later() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        venue_result(&mut b, 10 * USDC);
        let p = b.payout(110 * USDC, BPS);
        b.apply(&p);
        b.undo_fee(&p);
        assert_eq!(b.idle_usdc, USDC, "the fee is back in the desk");
        assert_eq!(b.withdrawn, 109 * USDC, "the owner received 109");
        assert_eq!((b.fees_paid, b.hwm), (0, 0));
        // Paying out the 1 left sends it all to the treasury: the fee is charged once.
        let q = b.payout(USDC, BPS);
        assert_eq!((q.fee, q.to_owner()), (USDC, 0));
        b.apply(&q);
        assert_eq!(
            (b.fees_paid, b.hwm, b.withdrawn),
            (USDC, 10 * USDC, 110 * USDC)
        );
        // Then nothing is due any more.
        venue_result(&mut b, 5 * USDC);
        assert_eq!(b.payout(5 * USDC, BPS).fee, USDC / 2);
    }

    /// Review item 4: after a failed fee transfer, payouts smaller than the fee due each take the
    /// payout, and the mark rises only by what they covered, so the whole fee is still charged.
    #[test]
    fn a_fee_cut_to_the_payout_leaves_the_rest_due() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        venue_result(&mut b, 10 * USDC);
        let p = b.payout(110 * USDC, BPS);
        b.apply(&p);
        b.undo_fee(&p);
        assert_eq!(pay(&mut b, USDC / 2), USDC / 2);
        // The highest mark 0.5 pays for at 10 %: its fees are 0.5, the next unit's more.
        assert_eq!(b.hwm, 5 * USDC + 9);
        assert_eq!(share_down(b.hwm, BPS), USDC / 2);
        assert_eq!(share_down(b.hwm + 1, BPS), USDC / 2 + 1);
        assert_eq!(pay(&mut b, USDC / 2), USDC / 2);
        assert_eq!((b.fees_paid, b.hwm, b.idle_usdc), (USDC, 10 * USDC, 0));
    }

    /// Re-review B: for every bps, a payout paid in parts (single units, uneven parts, or after a
    /// failed fee in parts smaller than the fee due) charges exactly the unsplit fee,
    /// ⌊bps × profit / 10⁴⌋, never more or less. The ceiling rule overshot at 3333 (2 for 3).
    #[test]
    fn split_payouts_charge_exactly_the_unsplit_fee_at_every_bps() {
        for bps in [0u16, 1, 7, 1000, 2500, 3333, 6667, 9999, 10_000] {
            for profit in [1u128, 3, 9, 10, 19, 31, 99, 1_234, 10_001] {
                let fresh = || {
                    let mut b = Books::default();
                    b.deposit_principal(1_000);
                    b.deposit_return(profit);
                    b
                };
                let total = 1_000 + profit;
                let want = share_down(profit, bps);
                let pay_all = |b: &mut Books, parts: &[u128]| -> u128 {
                    parts
                        .iter()
                        .map(|&x| {
                            let p = b.payout(x, bps);
                            assert!(p.fee <= x);
                            b.apply(&p);
                            p.fee
                        })
                        .sum()
                };
                let mut whole = fresh();
                assert_eq!(pay_all(&mut whole, &[total]), want, "bps {bps}, {profit}");
                // The principal back first, then the profit one unit at a time.
                let mut units = fresh();
                let mut parts = vec![1_000];
                parts.extend(std::iter::repeat_n(1, profit as usize));
                assert_eq!(
                    pay_all(&mut units, &parts),
                    want,
                    "bps {bps}, {profit} in units"
                );
                // Uneven parts across the principal.
                let mut uneven = fresh();
                let mut left = total;
                let mut parts = vec![];
                for size in [997, 2, 5, 1, 13, 3].iter().cycle() {
                    if left == 0 {
                        break;
                    }
                    let x = (*size as u128).min(left);
                    parts.push(x);
                    left -= x;
                }
                assert_eq!(
                    pay_all(&mut uneven, &parts),
                    want,
                    "bps {bps}, {profit} uneven"
                );
                // The fee transfer of the whole payout fails, then single units pay what is due.
                let mut failed = fresh();
                let p = failed.payout(total, bps);
                failed.apply(&p);
                failed.undo_fee(&p);
                let rest = vec![1; failed.idle_usdc as usize];
                assert_eq!(
                    pay_all(&mut failed, &rest),
                    want,
                    "bps {bps}, {profit} after a failed fee"
                );
                for b in [whole, units, uneven, failed] {
                    assert_eq!((b.fees_paid, b.idle_usdc), (want, 0), "bps {bps}, {profit}");
                }
            }
        }
    }

    /// After a failed fee, a payout smaller than the fee due takes at most the payout.
    #[test]
    fn a_fee_never_exceeds_the_payout() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        venue_result(&mut b, 100 * USDC);
        let p = b.payout(200 * USDC, BPS);
        assert_eq!(p.fee, 10 * USDC);
        b.apply(&p);
        b.undo_fee(&p);
        let q = b.payout(USDC, BPS);
        assert_eq!(q.fee, USDC);
        assert_eq!(q.to_owner(), 0);
    }

    /// Profit as the formula has it, also after a loss, at the payout's moment.
    #[test]
    fn profit_is_signed() {
        let mut b = Books::default();
        b.deposit_principal(100 * USDC);
        assert_eq!(b.payout(40 * USDC, BPS).profit, -60 * USDC as i128);
        b.withdrawn = 100 * USDC;
        assert_eq!(b.payout(30 * USDC, BPS).profit, 30 * USDC as i128);
        assert_eq!(signed_diff(u128::MAX, 0), i128::MAX);
        assert_eq!(signed_diff(0, u128::MAX), -i128::MAX);
    }
}
