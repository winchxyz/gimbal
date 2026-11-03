//! A deterministic fuzz of the Solana message parser and the three checks on top of it
//! (`check_message` for `sol_sign` and `sol_sign_rescue`, `check_registration` and
//! `check_onboarding` for `sol_sign_register`): random bytes, truncations, bit flips, splices and
//! length fields set past what follows them, seeded with every `message_hex` of
//! `vectors/solana*.json`. Every input must come back as a value or a refusal; a panic fails the
//! case and names its input. The RNG is a fixed-seed SplitMix64, so a failure replays.
//!
//! The default suite runs [`QUICK_CASES`]; `cargo test --release -p gimbal-core --test
//! solana_fuzz -- --ignored --nocapture` runs [`LONG_CASES`].

use gimbal_core::phoenix::{
    check_message, check_onboarding, check_registration, Onboarding, Rescue,
};
use gimbal_core::policy::{PhoenixMarket, Policy};
use gimbal_core::solana::{parse_message, phoenix_trader_address, Format, Pubkey, SolDesk};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

const QUICK_CASES: u64 = 20_000;
const LONG_CASES: u64 = 1_000_000;
const SEED: u64 = 0x6a09_e667_f3bc_c908;

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

const FILES: [&str; 3] = [
    include_str!("vectors/solana.json"),
    include_str!("vectors/solana-review.json"),
    include_str!("vectors/solana-onboarding.json"),
];

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A number below `n` (`n` > 0).
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn byte(&mut self) -> u8 {
        self.next() as u8
    }

    fn chance(&mut self, one_in: u64) -> bool {
        self.next().is_multiple_of(one_in)
    }
}

fn key(v: &Value) -> Pubkey {
    let bytes = bs58::decode(v.as_str().unwrap()).into_vec().unwrap();
    bytes.try_into().unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap()
}

/// Every `message_hex` in the three files, once each.
fn seeds() -> Vec<Vec<u8>> {
    fn walk(v: &Value, out: &mut Vec<Vec<u8>>) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => {
                for (k, x) in o {
                    match (k.as_str(), x.as_str()) {
                        ("message_hex", Some(h)) => out.push(hex::decode(h).unwrap()),
                        _ => walk(x, out),
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = vec![];
    for f in FILES {
        walk(&serde_json::from_str(f).unwrap(), &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// The offsets and lengths of the compact-u16 fields of a message the parser reads (key count,
/// instruction count, each account count and data length, a version 0 lookup count), or none
/// when it is malformed.
fn length_fields(b: &[u8]) -> Vec<(usize, usize)> {
    fn compact(b: &[u8], at: &mut usize) -> Option<(usize, usize, usize)> {
        let start = *at;
        let mut value = 0usize;
        for i in 0..3 {
            let byte = *b.get(*at)?;
            *at += 1;
            value |= usize::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                return Some((start, *at - start, value));
            }
        }
        None
    }
    fn walk(b: &[u8]) -> Option<Vec<(usize, usize)>> {
        let mut out = vec![];
        let v0 = b.first()? & 0x80 != 0;
        let mut at = usize::from(v0) + 3;
        let (o, l, keys) = compact(b, &mut at)?;
        out.push((o, l));
        at = at.checked_add(32 * keys + 32)?;
        let (o, l, ixs) = compact(b, &mut at)?;
        out.push((o, l));
        for _ in 0..ixs {
            at += 1;
            let (o, l, n) = compact(b, &mut at)?;
            out.push((o, l));
            at += n;
            let (o, l, n) = compact(b, &mut at)?;
            out.push((o, l));
            at += n;
        }
        if v0 {
            let (o, l, _) = compact(b, &mut at)?;
            out.push((o, l));
        }
        Some(out)
    }
    walk(b).unwrap_or_default()
}

/// A compact-u16 the parser may or may not take: past the bytes left, at the 16-bit edge, over
/// it in three bytes, a fourth continuation byte, non-canonical forms.
fn odd_length(rng: &mut Rng) -> Vec<u8> {
    let choices: [&[u8]; 12] = [
        &[0x7f],
        &[0x80, 0x01],
        &[0xff, 0x7f],
        &[0xff, 0xff, 0x03],
        &[0xff, 0xff, 0x7f],
        &[0xff, 0xff, 0xff],
        &[0xff, 0xff, 0xff, 0x0f],
        &[0x80, 0x00],
        &[0x80, 0x80, 0x00],
        &[0x80, 0x80, 0x80, 0x00],
        &[0x00],
        &[0xc0, 0x84, 0x3d],
    ];
    match rng.below(3) {
        0 => choices[rng.below(choices.len())].to_vec(),
        1 => {
            // A value a little past the end of most messages, in its canonical form.
            let mut n = 1200 + rng.below(300);
            let mut out = vec![];
            loop {
                let low = (n & 0x7f) as u8;
                n >>= 7;
                if n == 0 {
                    out.push(low);
                    return out;
                }
                out.push(low | 0x80);
            }
        }
        _ => vec![rng.byte(), rng.byte() | 0x80, rng.byte()]
            .into_iter()
            .take(1 + rng.below(3))
            .collect(),
    }
}

const INTERESTING: [u8; 10] = [0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0x81, 0xfe, 0xff, 0x40];

/// One mutation of `input`.
fn mutate_once(rng: &mut Rng, seeds: &[Vec<u8>], input: &mut Vec<u8>) {
    let len = input.len();
    match rng.below(14) {
        // Random bytes, any length up to past the transaction size.
        0 => {
            let n = rng.below(1400);
            *input = (0..n).map(|_| rng.byte()).collect();
        }
        // A truncation.
        1 => input.truncate(rng.below(len + 1)),
        // Bit flips.
        2 if len > 0 => {
            for _ in 0..1 + rng.below(8) {
                let i = rng.below(len);
                input[i] ^= 1 << rng.below(8);
            }
        }
        // A byte set to an edge value.
        3 if len > 0 => {
            let i = rng.below(len);
            input[i] = INTERESTING[rng.below(INTERESTING.len())];
        }
        // Inserted bytes.
        4 => {
            let at = rng.below(len + 1);
            let n = 1 + rng.below(40);
            let extra: Vec<u8> = (0..n).map(|_| rng.byte()).collect();
            input.splice(at..at, extra);
        }
        // A removed range.
        5 if len > 0 => {
            let at = rng.below(len);
            let n = 1 + rng.below((len - at).min(64));
            input.drain(at..at + n);
        }
        // A length field of the message set past what follows it, or to an odd encoding.
        6 | 7 => {
            let fields = length_fields(input);
            if fields.is_empty() {
                return mutate_once(rng, seeds, input);
            }
            let (at, n) = fields[rng.below(fields.len())];
            let value = odd_length(rng);
            input.splice(at..at + n, value);
        }
        // An odd compact-u16 anywhere.
        8 => {
            let at = rng.below(len + 1);
            let value = odd_length(rng);
            let end = (at + value.len()).min(len);
            input.splice(at..end, value);
        }
        // A splice of two seeds.
        9 => {
            let other = &seeds[rng.below(seeds.len())];
            let cut = rng.below(len + 1);
            let from = rng.below(other.len() + 1);
            input.truncate(cut);
            input.extend_from_slice(&other[from..]);
        }
        // The header: signer and read-only counts.
        10 => {
            let v0 = input.first().is_some_and(|b| b & 0x80 != 0);
            let at = usize::from(v0) + rng.below(3);
            if at < len {
                input[at] = INTERESTING[rng.below(INTERESTING.len())];
            }
        }
        // The version prefix: added, removed, another version.
        11 => match input.first().copied() {
            Some(0x80) if rng.chance(2) => {
                input.remove(0);
            }
            Some(b) if b & 0x80 != 0 => input[0] = 0x80 | rng.byte(),
            _ => input.insert(0, 0x80),
        },
        // An account or program index past the keys, inside the instruction area.
        12 if len > 0 => {
            let from = len - (len / 3).max(1);
            let i = from + rng.below(len - from);
            input[i] = 0xff - rng.byte() % 8;
        }
        // Trailing bytes, or a duplicated tail.
        _ => {
            if rng.chance(2) && len > 0 {
                let from = rng.below(len);
                let tail = input[from..].to_vec();
                input.extend_from_slice(&tail);
            } else {
                input.push(rng.byte());
            }
        }
    }
}

/// What the fuzz saw: how each target ended, by refusal code or `ok`.
#[derive(Default)]
struct Tally(BTreeMap<String, u64>);

impl Tally {
    fn count<T>(&mut self, target: &str, r: &Result<T, gimbal_core::Refusal>) {
        let end = match r {
            Ok(_) => "ok",
            Err(e) => e.code,
        };
        *self.0.entry(format!("{target} {end}")).or_insert(0) += 1;
    }
}

struct Targets {
    policy: Policy,
    desk: SolDesk,
    prices: BTreeMap<String, u128>,
    rescue: Rescue,
    authority: Pubkey,
    trader: Pubkey,
}

impl Targets {
    fn new() -> Targets {
        let doc: Value = serde_json::from_str(FILES[0]).unwrap();
        let ctx = &doc["ctx"]["sol_sign"];
        let policy = Policy {
            hl_assets: vec![],
            phoenix_markets: ctx["markets"]
                .as_object()
                .unwrap()
                .values()
                .map(|m| PhoenixMarket {
                    symbol: m["symbol"].as_str().unwrap().into(),
                    orderbook: m["orderbook"].as_str().unwrap().into(),
                    base_lot_e8: num(&m["base_lot_e8"]),
                    tick_e8: num(&m["tick_usd_e8"]),
                })
                .collect(),
            orderly_symbols: vec![],
            max_notional_usd: num(&ctx["max_notional_usd"]),
            price_band_bps: u32::try_from(num(&ctx["price_band_bps"])).unwrap(),
            oracle_max_age_s: 300,
            rescue_cap_usd_per_hour: 0,
            max_transfer_cost_bps: 0,
            max_transfer_cost_flat_e6: 0,
            unpriced: vec![],
            unpriced_max_notional_usd: 0,
            max_hourly_notional_usd: None,
        };
        policy.validate().unwrap();
        let prices = ctx["reference_prices_e8"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(s, p)| (s.clone(), p.as_str().unwrap().parse().unwrap()))
            .collect();
        let r = &doc["ctx"]["sol_sign_rescue"]["rescue"];
        let rescue = Rescue::new(sha256, key(&r["deposit_owner"]), num(&r["amount_in"])).unwrap();
        let authority = key(&doc["desk"]["authority"]);
        Targets {
            policy,
            desk: SolDesk::derive(sha256, authority).unwrap(),
            prices,
            rescue,
            authority,
            trader: phoenix_trader_address(sha256, &authority).unwrap(),
        }
    }

    /// Every target on `bytes`; the parser's answer first.
    fn run(&self, bytes: &[u8], tally: &mut Tally) {
        let parsed = parse_message(bytes);
        tally.count("parse_message", &parsed);
        let format = parsed.as_ref().ok().map(|m| m.format);
        let reference = |s: &str| self.prices.get(s).copied();
        let sign = check_message(sha256, &self.policy, &self.desk, bytes, &reference, None);
        tally.count("check_message", &sign);
        let rescue = check_message(
            sha256,
            &self.policy,
            &self.desk,
            bytes,
            &reference,
            Some(&self.rescue),
        );
        tally.count("check_message(rescue)", &rescue);
        let registration = check_registration(&self.authority, &self.trader, bytes);
        tally.count("check_registration", &registration);
        for which in [Onboarding::Register, Onboarding::ReferralActivate] {
            let r = check_onboarding(&self.authority, &self.trader, bytes, which);
            tally.count(&format!("check_onboarding({})", which.kind()), &r);
        }
        // Whatever passed, parsed.
        for ok in [sign.is_ok(), rescue.is_ok(), registration.is_ok()] {
            assert!(
                !ok || format.is_some(),
                "a check passed what the parser refused"
            );
        }
        if sign.is_ok() || rescue.is_ok() {
            assert_eq!(format, Some(Format::Legacy));
        }
    }
}

/// `cases` mutated inputs from the seeds, each run through every target; panics with the case
/// number and the input's hex on the first panic.
fn fuzz(cases: u64) -> Tally {
    let seeds = seeds();
    assert!(seeds.len() >= 150, "{} seeds", seeds.len());
    let targets = Targets::new();
    let mut tally = Tally::default();
    // The seeds themselves first.
    for s in &seeds {
        targets.run(s, &mut tally);
    }
    let mut rng = Rng(SEED);
    for case in 0..cases {
        let mut input = seeds[rng.below(seeds.len())].clone();
        for _ in 0..1 + rng.below(4) {
            mutate_once(&mut rng, &seeds, &mut input);
        }
        // The panic hook prints the panic itself; this adds the input that caused it.
        let ran = catch_unwind(AssertUnwindSafe(|| targets.run(&input, &mut tally)));
        assert!(
            ran.is_ok(),
            "case {case} panicked on input {}",
            hex::encode(&input)
        );
    }
    tally
}

fn report(cases: u64, tally: &Tally) {
    eprintln!("solana fuzz: {cases} mutated cases + the seeds, no panic");
    for (end, n) in &tally.0 {
        eprintln!("  {end}: {n}");
    }
}

#[test]
fn the_parser_and_its_checks_refuse_rather_than_panic() {
    let tally = fuzz(QUICK_CASES);
    // The mutations reach past the parser: some inputs parse, some even pass a check.
    let seen = |prefix: &str| {
        tally
            .0
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(_, n)| n)
            .sum::<u64>()
    };
    assert!(seen("parse_message ok") > QUICK_CASES / 20, "{:?}", tally.0);
    assert!(seen("parse_message E_SOL_MESSAGE") > QUICK_CASES / 4);
    assert!(seen("check_message ok") > 0);
    assert!(seen("check_message E_SOL_ACCOUNT") > 0);
    assert!(seen("check_message E_SOL_PROGRAM") > 0);
    report(QUICK_CASES, &tally);
}

#[test]
#[ignore = "the long run: cargo test --release -p gimbal-core --test solana_fuzz -- --ignored"]
fn a_million_cases() {
    let tally = fuzz(LONG_CASES);
    report(LONG_CASES, &tally);
}

/// The RNG is the published SplitMix64, so a case number replays.
#[test]
fn the_rng_is_splitmix64() {
    let mut rng = Rng(0);
    assert_eq!(rng.next(), 0xe220_a839_7b1d_cdaf);
    assert_eq!(rng.next(), 0x6e78_9e6a_a1b9_65f4);
}
