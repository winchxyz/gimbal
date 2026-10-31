//! Whether 32 bytes decode to a point of Ed25519, the test Solana runs on every program-derived
//! address (a PDA must be off the curve, so no private key can sign for it). The bytes are read
//! as curve25519-dalek's `CompressedEdwardsY::decompress` reads them: y from the low 255 bits,
//! taken mod p, and the sign bit ignored; the point exists if (y² − 1) / (d·y² + 1) has a square
//! root. Everything checked here is public, so nothing needs to run in constant time.

/// An element of GF(p), p = 2^255 − 19, as four little-endian 64-bit limbs. The value is below
/// 2^256 and is reduced mod p only by [`Fe::canonical`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fe([u64; 4]);

/// p = 2^255 − 19.
const P: [u64; 4] = [
    0xffff_ffff_ffff_ffed,
    0xffff_ffff_ffff_ffff,
    0xffff_ffff_ffff_ffff,
    0x7fff_ffff_ffff_ffff,
];

/// The curve constant d = −121665 / 121666 mod p.
const D: Fe = Fe([
    0x75eb_4dca_1359_78a3,
    0x0070_0a4d_4141_d8ab,
    0x8cc7_4079_7779_e898,
    0x5203_6cee_2b6f_fe73,
]);

const ONE: Fe = Fe([1, 0, 0, 0]);

/// 2^256 mod p: what a carry out of the top limb is worth.
const WRAP: u64 = 38;

impl Fe {
    /// y from 32 little-endian bytes, the top bit (the x sign) dropped.
    fn from_bytes(bytes: &[u8; 32]) -> Fe {
        let mut limbs = [0u64; 4];
        let (words, _) = bytes.as_chunks::<8>();
        for (limb, word) in limbs.iter_mut().zip(words) {
            *limb = u64::from_le_bytes(*word);
        }
        limbs[3] &= 0x7fff_ffff_ffff_ffff;
        Fe(limbs)
    }

    /// Adds `extra` (worth `extra` units) and folds every carry out of the top limb back in.
    fn fold(mut limbs: [u64; 4], mut extra: u64) -> Fe {
        while extra != 0 {
            let mut carry = u128::from(extra);
            for limb in limbs.iter_mut() {
                let sum = u128::from(*limb) + carry;
                *limb = sum as u64;
                carry = sum >> 64;
                if carry == 0 {
                    break;
                }
            }
            extra = (carry as u64) * WRAP;
        }
        Fe(limbs)
    }

    fn add(self, other: Fe) -> Fe {
        let mut limbs = [0u64; 4];
        let mut carry = 0u128;
        for (i, limb) in limbs.iter_mut().enumerate() {
            let sum = u128::from(self.0[i]) + u128::from(other.0[i]) + carry;
            *limb = sum as u64;
            carry = sum >> 64;
        }
        Fe::fold(limbs, (carry as u64) * WRAP)
    }

    /// `self − other` as `self + (p − other)`, with `other` reduced first so nothing borrows.
    fn sub(self, other: Fe) -> Fe {
        let b = other.canonical();
        let mut neg = [0u64; 4];
        let mut borrow = 0u64;
        for (i, limb) in neg.iter_mut().enumerate() {
            let (d1, b1) = P[i].overflowing_sub(b[i]);
            let (d2, b2) = d1.overflowing_sub(borrow);
            *limb = d2;
            borrow = u64::from(b1 || b2);
        }
        self.add(Fe(neg))
    }

    fn mul(self, other: Fe) -> Fe {
        let mut wide = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let cur = u128::from(self.0[i]) * u128::from(other.0[j])
                    + u128::from(wide[i + j])
                    + carry;
                wide[i + j] = cur as u64;
                carry = cur >> 64;
            }
            wide[i + 4] = carry as u64;
        }
        // wide = low + high · 2^256, and 2^256 ≡ 38.
        let mut limbs = [0u64; 4];
        let mut carry = 0u128;
        for (i, limb) in limbs.iter_mut().enumerate() {
            let cur = u128::from(wide[i]) + u128::from(wide[i + 4]) * u128::from(WRAP) + carry;
            *limb = cur as u64;
            carry = cur >> 64;
        }
        Fe::fold(limbs, (carry as u64) * WRAP)
    }

    fn square(self) -> Fe {
        self.mul(self)
    }

    /// `self^(2^k)`.
    fn pow2k(self, k: u32) -> Fe {
        (0..k).fold(self, |x, _| x.square())
    }

    /// The value mod p, in [0, p).
    fn canonical(self) -> [u64; 4] {
        let mut limbs = self.0;
        // Below 2^256 = 2p + 38, so two subtractions are enough.
        for _ in 0..2 {
            if !below_p(&limbs) {
                let mut borrow = 0u64;
                for (i, limb) in limbs.iter_mut().enumerate() {
                    let (d1, b1) = limb.overflowing_sub(P[i]);
                    let (d2, b2) = d1.overflowing_sub(borrow);
                    *limb = d2;
                    borrow = u64::from(b1 || b2);
                }
            }
        }
        limbs
    }

    /// `self^(2^250 − 1)`, by the addition chain of ref10's `pow22501`: 254 squarings and 11
    /// multiplications.
    fn pow22501(self) -> Fe {
        let t0 = self.square(); // 2
        let t1 = t0.pow2k(2); // 8
        let t2 = self.mul(t1); // 9
        let t3 = t0.mul(t2); // 11
        let t4 = t3.square(); // 22
        let t5 = t2.mul(t4); // 2^5 − 1
        let t7 = t5.pow2k(5).mul(t5); // 2^10 − 1
        let t9 = t7.pow2k(10).mul(t7); // 2^20 − 1
        let t11 = t9.pow2k(20).mul(t9); // 2^40 − 1
        let t13 = t11.pow2k(10).mul(t7); // 2^50 − 1
        let t15 = t13.pow2k(50).mul(t13); // 2^100 − 1
        let t17 = t15.pow2k(100).mul(t15); // 2^200 − 1
        t17.pow2k(50).mul(t13) // 2^250 − 1
    }

    /// The Legendre symbol `self^((p − 1) / 2)`: 0, 1 (a non-zero square) or p − 1, reduced.
    /// (p − 1) / 2 = 2^254 − 10 = (2^250 − 1) · 2^4 + 6.
    fn legendre(self) -> [u64; 4] {
        let x2 = self.square();
        let x6 = x2.square().mul(x2);
        self.pow22501().pow2k(4).mul(x6).canonical()
    }
}

fn below_p(limbs: &[u64; 4]) -> bool {
    for i in (0..4).rev() {
        if limbs[i] != P[i] {
            return limbs[i] < P[i];
        }
    }
    false
}

/// True if `bytes` is the compressed form of an Ed25519 point, as curve25519-dalek decides it
/// (Solana's `bytes_are_curve_point`): x² = (y² − 1) / (d·y² + 1) has a solution. d·y² + 1 is
/// never 0 (−1/d is not a square), so that holds exactly when (y² − 1)(d·y² + 1) is 0 or a square.
pub fn is_on_curve(bytes: &[u8; 32]) -> bool {
    let y = Fe::from_bytes(bytes);
    let yy = y.square();
    let u = yy.sub(ONE);
    let v = D.mul(yy).add(ONE);
    let chi = u.mul(v).legendre();
    chi == [0; 4] || chi == ONE.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(n: u64) -> Fe {
        Fe([n, 0, 0, 0])
    }

    fn hex32(s: &str) -> [u8; 32] {
        let v = hex::decode(s).unwrap();
        v.try_into().unwrap()
    }

    #[test]
    fn d_is_minus_121665_over_121666() {
        let zero = D.mul(fe(121_666)).add(fe(121_665)).canonical();
        assert_eq!(zero, [0; 4]);
    }

    #[test]
    fn arithmetic_wraps_mod_p() {
        let p_minus_1 = Fe([P[0] - 1, P[1], P[2], P[3]]);
        assert_eq!(p_minus_1.add(ONE).canonical(), [0; 4]);
        assert_eq!(fe(0).sub(ONE).canonical(), p_minus_1.0);
        assert_eq!(p_minus_1.mul(p_minus_1).canonical(), ONE.0, "(−1)² = 1");
        let all = Fe([u64::MAX; 4]); // 2^256 − 1 ≡ 37
        assert_eq!(all.canonical(), [37, 0, 0, 0]);
        assert_eq!(all.mul(all).canonical(), [37 * 37, 0, 0, 0]);
        assert_eq!(all.add(all).canonical(), [74, 0, 0, 0]);
    }

    #[test]
    fn legendre_tells_squares() {
        assert_eq!(fe(0).legendre(), [0; 4]);
        assert_eq!(fe(4).legendre(), ONE.0);
        // 2 is not a square mod p (p ≡ 5 mod 8).
        assert_eq!(fe(2).legendre(), fe(0).sub(ONE).canonical());
        // −1 is (p ≡ 1 mod 4).
        assert_eq!(fe(0).sub(ONE).legendre(), ONE.0);
    }

    #[test]
    fn known_points_and_non_points() {
        // The base point (y = 4/5) and the identity (y = 1).
        let base = hex32("5866666666666666666666666666666666666666666666666666666666666666");
        assert!(is_on_curve(&base));
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(is_on_curve(&identity));
        // The sign bit does not matter.
        identity[31] = 0x80;
        assert!(is_on_curve(&identity));
        // y = 0: x² = −1, which has roots.
        assert!(is_on_curve(&[0; 32]));
        // y = 2: x² = 3 / (4d + 1) has none.
        let mut two = [0u8; 32];
        two[0] = 2;
        assert!(!is_on_curve(&two));
    }
}
