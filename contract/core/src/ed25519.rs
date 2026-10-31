//! Whether 32 bytes decode to a point of Ed25519, the test Solana runs on every program-derived
//! address (a PDA must be off the curve, so no private key can sign for it). The bytes are read
//! as curve25519-dalek's `CompressedEdwardsY::decompress` reads them: y from the low 255 bits,
//! taken mod p, and the sign bit ignored; the point exists if (y² − 1) / (d·y² + 1) has a square
//! root. Everything checked here is public, so nothing needs to run in constant time.
//!
//! The contract runs this up to a few times per PDA, so the field is written for wasm: ten limbs
//! in radix 2^25.5 (ref10's layout), products in native 64-bit multiplies (wasm has no 64 × 64 →
//! 128 multiply), and straight-line code, which `opt-level = "z"` does not roll into loops. The
//! products are `Wrapping`: the release profile checks overflow, and a checked 64-bit multiply
//! costs a 128-bit one on wasm32. The bounds below show they never wrap, and the tests compare
//! thousands of results with curve25519-dalek.

use core::num::Wrapping;

/// An element of GF(p), p = 2^255 − 19: Σ limb[k] · 2^e(k) with e(k) = 25k + ⌈k/2⌉, so even limbs
/// are 26 bits wide and odd ones 25. "Carried" means every limb is below 2^26, which every
/// operation returns; `mul` and `square` take limbs below 2^27, so each sum of products stays
/// below 2^63 (the largest, h0 of a square, is at most 267 · 2^54).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fe([u64; 10]);

const MASK_26: u64 = (1 << 26) - 1;
const MASK_25: u64 = (1 << 25) - 1;

const N4: Wrapping<u64> = Wrapping(4);
const N19: Wrapping<u64> = Wrapping(19);
const N38: Wrapping<u64> = Wrapping(38);
const N76: Wrapping<u64> = Wrapping(76);

/// The curve constant d = −121665 / 121666 mod p.
const D: Fe = Fe([
    0x35978a3, 0xd37284, 0x3156ebd, 0x6a0a0e, 0x1c029, 0x179e898, 0x3a03cbb, 0x1ce7198, 0x2e2b6ff,
    0x1480db3,
]);

/// 2p in limbs, each at least any carried limb, so `a + 2p − b` never goes below zero.
const TWO_P: [u64; 10] = [
    0x7ffffda, 0x3fffffe, 0x7fffffe, 0x3fffffe, 0x7fffffe, 0x3fffffe, 0x7fffffe, 0x3fffffe,
    0x7fffffe, 0x3fffffe,
];

const ONE: Fe = Fe([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/// The bit offset of each limb.
const OFFSET: [u32; 10] = [0, 26, 51, 77, 102, 128, 153, 179, 204, 230];

/// The bit width of each limb.
const WIDTH: [u32; 10] = [26, 25, 26, 25, 26, 25, 26, 25, 26, 25];

/// Each limb's width mask.
const fn mask(k: usize) -> u64 {
    (1 << WIDTH[k]) - 1
}

/// The limbs as `Wrapping`, written out: `array::map` would be a loop of closure calls.
#[inline(always)]
fn wrap(a: [u64; 10]) -> [Wrapping<u64>; 10] {
    [
        Wrapping(a[0]),
        Wrapping(a[1]),
        Wrapping(a[2]),
        Wrapping(a[3]),
        Wrapping(a[4]),
        Wrapping(a[5]),
        Wrapping(a[6]),
        Wrapping(a[7]),
        Wrapping(a[8]),
        Wrapping(a[9]),
    ]
}

#[inline(always)]
fn unwrap(h: [Wrapping<u64>; 10]) -> [u64; 10] {
    [
        h[0].0, h[1].0, h[2].0, h[3].0, h[4].0, h[5].0, h[6].0, h[7].0, h[8].0, h[9].0,
    ]
}

impl Fe {
    /// y from 32 little-endian bytes, the top bit (the x sign) dropped: limb k is bits
    /// [e(k), e(k) + width) of the low 255.
    fn from_bytes(bytes: &[u8; 32]) -> Fe {
        let mut padded = [0u8; 40];
        padded[..32].copy_from_slice(bytes);
        padded[31] &= 0x7f;
        let mut limbs = [0u64; 10];
        for (k, limb) in limbs.iter_mut().enumerate() {
            let at = (OFFSET[k] / 8) as usize;
            let mut word = [0u8; 8];
            word.copy_from_slice(&padded[at..at + 8]);
            *limb = (u64::from_le_bytes(word) >> (OFFSET[k] % 8)) & mask(k);
        }
        Fe(limbs)
    }

    /// Carries every limb into the next, the top one into limb 0 times 19 (2^255 ≡ 19), and limb
    /// 0 once more. Takes limbs below 2^63; returns them below 2^26 (limb 1 at most 2^25 + 2^17).
    /// Wrapping adds, since each sum is far below 2^64: a limb below 2^26 plus a carry below 2^39.
    fn carry(h: [u64; 10]) -> Fe {
        let [h0, h1, h2, h3, h4, h5, h6, h7, h8, h9] = h;
        let h1 = h1.wrapping_add(h0 >> 26);
        let h2 = h2.wrapping_add(h1 >> 25);
        let h3 = h3.wrapping_add(h2 >> 26);
        let h4 = h4.wrapping_add(h3 >> 25);
        let h5 = h5.wrapping_add(h4 >> 26);
        let h6 = h6.wrapping_add(h5 >> 25);
        let h7 = h7.wrapping_add(h6 >> 26);
        let h8 = h8.wrapping_add(h7 >> 25);
        let h9 = h9.wrapping_add(h8 >> 26);
        let h0 = (h0 & MASK_26).wrapping_add((h9 >> 25).wrapping_mul(19));
        let h1 = (h1 & MASK_25).wrapping_add(h0 >> 26);
        Fe([
            h0 & MASK_26,
            h1,
            h2 & MASK_26,
            h3 & MASK_25,
            h4 & MASK_26,
            h5 & MASK_25,
            h6 & MASK_26,
            h7 & MASK_25,
            h8 & MASK_26,
            h9 & MASK_25,
        ])
    }

    fn add(self, other: Fe) -> Fe {
        let (a, b) = (self.0, other.0);
        Fe::carry([
            a[0] + b[0],
            a[1] + b[1],
            a[2] + b[2],
            a[3] + b[3],
            a[4] + b[4],
            a[5] + b[5],
            a[6] + b[6],
            a[7] + b[7],
            a[8] + b[8],
            a[9] + b[9],
        ])
    }

    /// `self − other` as `self + 2p − other`; `other` is carried, so no limb goes below zero.
    fn sub(self, other: Fe) -> Fe {
        let (a, b) = (self.0, other.0);
        Fe::carry([
            a[0] + TWO_P[0] - b[0],
            a[1] + TWO_P[1] - b[1],
            a[2] + TWO_P[2] - b[2],
            a[3] + TWO_P[3] - b[3],
            a[4] + TWO_P[4] - b[4],
            a[5] + TWO_P[5] - b[5],
            a[6] + TWO_P[6] - b[6],
            a[7] + TWO_P[7] - b[7],
            a[8] + TWO_P[8] - b[8],
            a[9] + TWO_P[9] - b[9],
        ])
    }

    /// f_i · g_j lands on limb i + j, doubled when i and j are both odd (e(i) + e(j) = e(i + j) + 1),
    /// and past limb 9 it folds back times 19 (e(k + 10) = e(k) + 255).
    fn mul(self, other: Fe) -> Fe {
        let [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9] = wrap(self.0);
        let [g0, g1, g2, g3, g4, g5, g6, g7, g8, g9] = wrap(other.0);
        let f1_2 = f1 + f1;
        let f3_2 = f3 + f3;
        let f5_2 = f5 + f5;
        let f7_2 = f7 + f7;
        let f9_2 = f9 + f9;
        let g1_19 = g1 * N19;
        let g2_19 = g2 * N19;
        let g3_19 = g3 * N19;
        let g4_19 = g4 * N19;
        let g5_19 = g5 * N19;
        let g6_19 = g6 * N19;
        let g7_19 = g7 * N19;
        let g8_19 = g8 * N19;
        let g9_19 = g9 * N19;
        let h0 = f0 * g0
            + f1_2 * g9_19
            + f2 * g8_19
            + f3_2 * g7_19
            + f4 * g6_19
            + f5_2 * g5_19
            + f6 * g4_19
            + f7_2 * g3_19
            + f8 * g2_19
            + f9_2 * g1_19;
        let h1 = f0 * g1
            + f1 * g0
            + f2 * g9_19
            + f3 * g8_19
            + f4 * g7_19
            + f5 * g6_19
            + f6 * g5_19
            + f7 * g4_19
            + f8 * g3_19
            + f9 * g2_19;
        let h2 = f0 * g2
            + f1_2 * g1
            + f2 * g0
            + f3_2 * g9_19
            + f4 * g8_19
            + f5_2 * g7_19
            + f6 * g6_19
            + f7_2 * g5_19
            + f8 * g4_19
            + f9_2 * g3_19;
        let h3 = f0 * g3
            + f1 * g2
            + f2 * g1
            + f3 * g0
            + f4 * g9_19
            + f5 * g8_19
            + f6 * g7_19
            + f7 * g6_19
            + f8 * g5_19
            + f9 * g4_19;
        let h4 = f0 * g4
            + f1_2 * g3
            + f2 * g2
            + f3_2 * g1
            + f4 * g0
            + f5_2 * g9_19
            + f6 * g8_19
            + f7_2 * g7_19
            + f8 * g6_19
            + f9_2 * g5_19;
        let h5 = f0 * g5
            + f1 * g4
            + f2 * g3
            + f3 * g2
            + f4 * g1
            + f5 * g0
            + f6 * g9_19
            + f7 * g8_19
            + f8 * g7_19
            + f9 * g6_19;
        let h6 = f0 * g6
            + f1_2 * g5
            + f2 * g4
            + f3_2 * g3
            + f4 * g2
            + f5_2 * g1
            + f6 * g0
            + f7_2 * g9_19
            + f8 * g8_19
            + f9_2 * g7_19;
        let h7 = f0 * g7
            + f1 * g6
            + f2 * g5
            + f3 * g4
            + f4 * g3
            + f5 * g2
            + f6 * g1
            + f7 * g0
            + f8 * g9_19
            + f9 * g8_19;
        let h8 = f0 * g8
            + f1_2 * g7
            + f2 * g6
            + f3_2 * g5
            + f4 * g4
            + f5_2 * g3
            + f6 * g2
            + f7_2 * g1
            + f8 * g0
            + f9_2 * g9_19;
        let h9 = f0 * g9
            + f1 * g8
            + f2 * g7
            + f3 * g6
            + f4 * g5
            + f5 * g4
            + f6 * g3
            + f7 * g2
            + f8 * g1
            + f9 * g0;
        Fe::carry(unwrap([h0, h1, h2, h3, h4, h5, h6, h7, h8, h9]))
    }

    /// [`Fe::mul`] of `self` by itself, each pair of limbs once (doubled).
    fn square(self) -> Fe {
        let [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9] = wrap(self.0);
        let f1_2 = f1 + f1;
        let f2_2 = f2 + f2;
        let f3_2 = f3 + f3;
        let f3_4 = f3 * N4;
        let f4_2 = f4 + f4;
        let f5_2 = f5 + f5;
        let f5_4 = f5 * N4;
        let f5_38 = f5 * N38;
        let f6_2 = f6 + f6;
        let f6_19 = f6 * N19;
        let f6_38 = f6 * N38;
        let f7_2 = f7 + f7;
        let f7_4 = f7 * N4;
        let f7_38 = f7 * N38;
        let f7_76 = f7 * N76;
        let f8_2 = f8 + f8;
        let f8_19 = f8 * N19;
        let f8_38 = f8 * N38;
        let f9_2 = f9 + f9;
        let f9_38 = f9 * N38;
        let f9_76 = f9 * N76;
        let h0 = f0 * f0 + f1 * f9_76 + f2 * f8_38 + f3 * f7_76 + f4 * f6_38 + f5 * f5_38;
        let h1 = f0 * f1_2 + f2 * f9_38 + f3 * f8_38 + f4 * f7_38 + f5 * f6_38;
        let h2 = f0 * f2_2 + f1 * f1_2 + f3 * f9_76 + f4 * f8_38 + f5 * f7_76 + f6 * f6_19;
        let h3 = f0 * f3_2 + f1 * f2_2 + f4 * f9_38 + f5 * f8_38 + f6 * f7_38;
        let h4 = f0 * f4_2 + f1 * f3_4 + f2 * f2 + f5 * f9_76 + f6 * f8_38 + f7 * f7_38;
        let h5 = f0 * f5_2 + f1 * f4_2 + f2 * f3_2 + f6 * f9_38 + f7 * f8_38;
        let h6 = f0 * f6_2 + f1 * f5_4 + f2 * f4_2 + f3 * f3_2 + f7 * f9_76 + f8 * f8_19;
        let h7 = f0 * f7_2 + f1 * f6_2 + f2 * f5_2 + f3 * f4_2 + f8 * f9_38;
        let h8 = f0 * f8_2 + f1 * f7_4 + f2 * f6_2 + f3 * f5_4 + f4 * f4 + f9 * f9_38;
        let h9 = f0 * f9_2 + f1 * f8_2 + f2 * f7_2 + f3 * f6_2 + f4 * f5_2;
        Fe::carry(unwrap([h0, h1, h2, h3, h4, h5, h6, h7, h8, h9]))
    }

    /// `self^(2^k)`.
    fn pow2k(self, k: u32) -> Fe {
        let mut x = self;
        for _ in 0..k {
            x = x.square();
        }
        x
    }

    /// The value mod p, in [0, p), as carried limbs. A carried value is below 2p, so it is reduced
    /// by subtracting p once when it is at least p: q = ⌊(h + 19) / 2^255⌋ says whether.
    fn canonical(self) -> [u64; 10] {
        let mut h = self.0;
        let mut q = (h[0] + 19) >> 26;
        for k in 1..10 {
            q = (h[k] + q) >> WIDTH[k];
        }
        h[0] += 19 * q;
        for k in 0..9 {
            h[k + 1] += h[k] >> WIDTH[k];
            h[k] &= mask(k);
        }
        // The carry out of limb 9 is q · 2^255, the p subtracted with the 19 above.
        h[9] &= MASK_25;
        h
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
    fn legendre(self) -> [u64; 10] {
        let x2 = self.square();
        let x6 = x2.square().mul(x2);
        self.pow22501().pow2k(4).mul(x6).canonical()
    }
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
    chi == [0; 10] || chi == ONE.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(n: u64) -> Fe {
        Fe([n, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    }

    fn hex32(s: &str) -> [u8; 32] {
        let v = hex::decode(s).unwrap();
        v.try_into().unwrap()
    }

    fn le(n: u8, top: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = n;
        b[31] = top;
        b
    }

    /// p − 1 + `extra` as bytes (`extra` ≤ 19 keeps it below 2^255).
    fn p_minus_1_plus(extra: u8) -> [u8; 32] {
        let mut b = [0xffu8; 32];
        b[31] = 0x7f;
        b[0] = 0xec + extra;
        b
    }

    #[test]
    fn d_is_minus_121665_over_121666() {
        let zero = D.mul(fe(121_666)).add(fe(121_665)).canonical();
        assert_eq!(zero, [0; 10]);
    }

    #[test]
    fn bytes_at_or_above_p_are_taken_mod_p() {
        let p_minus_1 = Fe::from_bytes(&p_minus_1_plus(0));
        assert_eq!(p_minus_1.add(ONE).canonical(), [0; 10]);
        assert_eq!(fe(0).sub(ONE).canonical(), p_minus_1.canonical());
        assert_eq!(
            Fe::from_bytes(&p_minus_1_plus(1)).canonical(),
            [0; 10],
            "p ≡ 0"
        );
        assert_eq!(
            Fe::from_bytes(&p_minus_1_plus(2)).canonical(),
            ONE.0,
            "p + 1 ≡ 1"
        );
        // 2^255 − 1 ≡ 18; the sign bit is not part of y.
        let mut top = [0xffu8; 32];
        assert_eq!(Fe::from_bytes(&top).canonical(), fe(18).0);
        top[31] = 0x7f;
        assert_eq!(Fe::from_bytes(&top).canonical(), fe(18).0);
    }

    #[test]
    fn arithmetic_wraps_mod_p() {
        let minus_1 = fe(0).sub(ONE);
        assert_eq!(minus_1.mul(minus_1).canonical(), ONE.0, "(−1)² = 1");
        assert_eq!(minus_1.square().canonical(), ONE.0);
        let minus_2 = minus_1.add(minus_1);
        assert_eq!(minus_2.square().canonical(), fe(4).0);
        assert_eq!(minus_2.mul(minus_1).canonical(), fe(2).0);
        // 2^128 · 2^128 = 2^256 ≡ 38.
        let mut b = [0u8; 32];
        b[16] = 1;
        let x = Fe::from_bytes(&b);
        assert_eq!(x.mul(x).canonical(), fe(38).0);
        assert_eq!(x.square().canonical(), fe(38).0);
    }

    #[test]
    fn square_is_mul_by_itself() {
        let mut x = Fe::from_bytes(&hex32(
            "5866666666666666666666666666666666666666666666666666666666666666",
        ));
        for _ in 0..200 {
            let next = x.mul(D).add(ONE);
            assert_eq!(x.square().canonical(), x.mul(x).canonical());
            x = next;
        }
    }

    #[test]
    fn legendre_tells_squares() {
        assert_eq!(fe(0).legendre(), [0; 10]);
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
        assert!(is_on_curve(&le(1, 0)));
        // The sign bit does not matter.
        assert!(is_on_curve(&le(1, 0x80)));
        // y = 0: x² = −1, which has roots.
        assert!(is_on_curve(&[0; 32]));
        // y = 2: x² = 3 / (4d + 1) has none.
        assert!(!is_on_curve(&le(2, 0)));
    }
}
