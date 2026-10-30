//! What an owner method must attach (docs/interfaces.md §1.3).
//!
//! The engine's operator key is a FunctionCall key on the owner's own account, so the contract sees
//! the owner either way. A FunctionCall key cannot attach a deposit, so requiring one keeps that key
//! out of owner methods: exactly 1 yoctoNEAR for those that add no storage, at least 1 yoctoNEAR and
//! the storage they add for `create_desk`, `set_policy` and `set_operator`. Without it the call is
//! `E_NOT_ALLOWED`; with too little for the storage, `E_DEPOSIT`.

use gimbal_core::errors::{Refusal, E_DEPOSIT, E_NOT_ALLOWED};
use near_sdk::NearToken;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Owner methods that add no storage (`set_paused(false)` now; `withdraw_to_owner`,
/// `set_orderly_receiver`, `hl_withdraw`, `panic_close` and `set_mock_price` later).
pub fn check_one_yocto(method: &str, attached: NearToken) -> Result<(), Refusal> {
    if attached == ONE_YOCTO {
        Ok(())
    } else {
        Err(Refusal::new(
            E_NOT_ALLOWED,
            format!(
                "{method} needs exactly 1 yoctoNEAR attached, which only the owner's wallet can attach; attached {}",
                attached.as_yoctonear()
            ),
        ))
    }
}

/// Storage methods, before their writes: at least 1 yoctoNEAR, for the same reason.
pub fn check_some_deposit(method: &str, attached: NearToken) -> Result<(), Refusal> {
    if attached.is_zero() {
        Err(Refusal::new(
            E_NOT_ALLOWED,
            format!("{method} needs a deposit of at least 1 yoctoNEAR from the owner's wallet"),
        ))
    } else {
        Ok(())
    }
}

/// Pausing is an operator method: no deposit, or the 1 yoctoNEAR a wallet may attach to every owner
/// call. More would stay in the contract, so it is refused.
pub fn check_pause_deposit(attached: NearToken) -> Result<(), Refusal> {
    if attached > ONE_YOCTO {
        Err(Refusal::new(
            E_DEPOSIT,
            format!(
                "pausing takes no deposit (0 or 1 yoctoNEAR); attached {}",
                attached.as_yoctonear()
            ),
        ))
    } else {
        Ok(())
    }
}

/// What a storage method keeps of its deposit: the storage it added, and at least the 1 yoctoNEAR
/// that proved the owner's wallet. Freed storage is not paid back.
pub fn storage_charge(added_bytes: u64, byte_cost: NearToken) -> NearToken {
    let cost = byte_cost.saturating_mul(u128::from(added_bytes));
    if cost < ONE_YOCTO {
        ONE_YOCTO
    } else {
        cost
    }
}

/// The part of `attached` to refund after a storage method added `added_bytes`, or `E_DEPOSIT`
/// when the deposit does not cover [`storage_charge`]. `what` names the call in the message.
pub fn refund_after(
    what: &str,
    added_bytes: u64,
    byte_cost: NearToken,
    attached: NearToken,
) -> Result<NearToken, Refusal> {
    let charge = storage_charge(added_bytes, byte_cost);
    if attached < charge {
        return Err(Refusal::new(
            E_DEPOSIT,
            format!(
                "{what} takes {added_bytes} bytes of storage: attach at least {} yoctoNEAR, not {}",
                charge.as_yoctonear(),
                attached.as_yoctonear()
            ),
        ));
    }
    Ok(attached.saturating_sub(charge))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTE: NearToken = NearToken::from_yoctonear(10_000_000_000_000_000_000);

    fn yocto(n: u128) -> NearToken {
        NearToken::from_yoctonear(n)
    }

    #[test]
    fn one_yocto_exactly() {
        check_one_yocto("set_paused(false)", ONE_YOCTO).unwrap();
        for wrong in [0, 2, 10u128.pow(24)] {
            let r = check_one_yocto("set_paused(false)", yocto(wrong)).unwrap_err();
            assert_eq!(r.code, E_NOT_ALLOWED);
            assert!(
                r.msg
                    .starts_with("set_paused(false) needs exactly 1 yoctoNEAR"),
                "{r}"
            );
        }
    }

    #[test]
    fn storage_methods_need_some_deposit() {
        let r = check_some_deposit("set_policy", yocto(0)).unwrap_err();
        assert_eq!(r.code, E_NOT_ALLOWED);
        check_some_deposit("set_policy", ONE_YOCTO).unwrap();
    }

    #[test]
    fn pausing_takes_at_most_one_yocto() {
        check_pause_deposit(yocto(0)).unwrap();
        check_pause_deposit(ONE_YOCTO).unwrap();
        assert_eq!(check_pause_deposit(yocto(2)).unwrap_err().code, E_DEPOSIT);
    }

    #[test]
    fn the_charge_is_the_storage_added_and_at_least_one_yocto() {
        assert_eq!(storage_charge(0, BYTE), ONE_YOCTO);
        assert_eq!(
            storage_charge(580, BYTE),
            yocto(5_800_000_000_000_000_000_000)
        );
        let attached = yocto(10u128.pow(22));
        assert_eq!(
            refund_after("x", 580, BYTE, attached).unwrap(),
            yocto(10u128.pow(22) - 5_800_000_000_000_000_000_000)
        );
        assert_eq!(refund_after("x", 0, BYTE, ONE_YOCTO).unwrap(), yocto(0));
        let r = refund_after(
            "desk alpha",
            580,
            BYTE,
            yocto(5_799_999_999_999_999_999_999),
        )
        .unwrap_err();
        assert_eq!(r.code, E_DEPOSIT);
        assert_eq!(
            r.msg,
            "desk alpha takes 580 bytes of storage: attach at least 5800000000000000000000 yoctoNEAR, not 5799999999999999999999"
        );
    }
}
