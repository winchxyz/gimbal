//! 1Click quotes (docs/interfaces.md §1.3, "1Click quotes"): the signature check and the field
//! rules every transfer through 1Click passes before the contract signs it.
//!
//! `quote` is the canonical JSON the relayer hashed, passed exactly as hashed; `quote_signature`
//! is 1Click's `ed25519:<base58>`. The signature is checked first, over the UTF-8 of
//! base58(sha256(`quote`)), before anything is parsed (`E_QUOTE_SIGNATURE`). Then the fields, in
//! the order of `field_rule` in `tests/vectors/oneclick.json`: a live quote, the method's origin
//! asset (and a destination asset that is not it), `refundTo`, `recipientType`, the recipient and
//! destination pair, the deadline, and for a rescue the remaining hourly cap (`E_QUOTE_FIELDS`,
//! `E_RESCUE_CAP`). [`check_cost`] bounds what one transfer may cost through the signed
//! `minAmountOut`; [`transfer_cost_e8`] and [`rescue_cost_budget_e8`] bound what the rescues of an
//! hour may cost together.
//!
//! sha256 and the Ed25519 check come from the caller, so the contract uses the host's.

use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::decimal::format_e8;
use crate::errors::{shown, Refusal, E_QUOTE_FIELDS, E_QUOTE_SIGNATURE, E_RESCUE_CAP};
use crate::ids::decode_base58_32;
use crate::solana::Sha256;

/// 1Click's quote signing key (CLAUDE.md), base58.
pub const ONECLICK_PUBLIC_KEY_B58: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/// Whether `signature` is `public_key`'s Ed25519 signature of `message`: the host's
/// `ed25519_verify` in the contract.
pub type Ed25519Verify = fn(signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool;

/// USDC on Solana, as 1Click names it (6 decimals).
pub const SOL_USDC: &str = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
/// USDC on HyperCore (8 decimals).
pub const HL_USDC: &str = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";
/// USDC on Arbitrum (6 decimals): the Orderly receiver's asset.
pub const ARB_USDC: &str = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
/// USDC on NEAR (6 decimals): what the contract receives for a payout.
pub const NEAR_USDC: &str =
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/// The least `minAmountOut` of a quote into the Orderly receiver, USDC × 1e6: Orderly loses a
/// deposit under 5 USDC, and the margin covers the transfer's own cost.
pub const ORDERLY_MIN_OUT_E6: u128 = 6_000_000;

/// The decimals of a USDC asset 1Click quotes.
pub fn decimals(asset: &str) -> Option<u32> {
    match asset {
        SOL_USDC | ARB_USDC | NEAR_USDC => Some(6),
        HL_USDC => Some(8),
        _ => None,
    }
}

/// The method a quote is checked for: each moves USDC out of one place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// From the desk's Solana USDC account (`refundTo` = the desk's Solana authority).
    SolSignRescue,
    /// From the desk's Hyperliquid perp balance (`refundTo` = the desk's EVM address).
    HlSendToIntents,
    /// From the desk's Arbitrum address, after an Orderly withdrawal (`refundTo` = the desk EVM).
    EvmUsdcToIntents,
    /// From the contract's USDC on NEAR (`refundTo` = the contract), C8; no rescue cap.
    FundVenue,
}

impl Method {
    pub fn parse(s: &str) -> Option<Method> {
        match s {
            "sol_sign_rescue" => Some(Method::SolSignRescue),
            "hl_send_to_intents" => Some(Method::HlSendToIntents),
            "evm_usdc_to_intents" => Some(Method::EvmUsdcToIntents),
            "fund_venue" => Some(Method::FundVenue),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Method::SolSignRescue => "sol_sign_rescue",
            Method::HlSendToIntents => "hl_send_to_intents",
            Method::EvmUsdcToIntents => "evm_usdc_to_intents",
            Method::FundVenue => "fund_venue",
        }
    }

    /// The asset the method sends.
    pub const fn origin_asset(self) -> &'static str {
        match self {
            Method::SolSignRescue => SOL_USDC,
            Method::HlSendToIntents => HL_USDC,
            Method::EvmUsdcToIntents => ARB_USDC,
            Method::FundVenue => NEAR_USDC,
        }
    }

    /// Whether the hourly rescue cap bounds it.
    pub const fn is_rescue(self) -> bool {
        !matches!(self, Method::FundVenue)
    }
}

/// The addresses a quote may pay or refund to.
#[derive(Clone, Copy, Debug)]
pub struct DeskAddresses<'a> {
    pub desk_id: &'a str,
    /// Lowercase 0x address.
    pub evm: &'a str,
    /// Base58 Solana authority.
    pub sol: &'a str,
    /// The pinned Orderly receiver on Arbitrum, lowercase, once set.
    pub orderly_receiver: Option<&'a str>,
}

/// What a quote is checked against.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub desk: DeskAddresses<'a>,
    /// The contract's account id: `refundTo` of `fund_venue`, recipient of a payout.
    pub contract: &'a str,
    pub now_ms: u64,
    /// What is left of the desk's hourly rescue cap, USD × 1e8 (a USDC counts as 1 USD).
    pub remaining_cap_e8: u128,
    /// Accept a dry quote, which has no deposit address. Only the tests of the recorded dry quotes
    /// set it; the contract never does.
    pub dry_ok: bool,
}

/// A quote that passed [`verify_quote`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedQuote {
    pub method: Method,
    /// Where the method sends the USDC: a Solana address for `sol_sign_rescue`, a lowercase 0x
    /// address for `hl_send_to_intents` and `evm_usdc_to_intents`, a NEAR account for
    /// `fund_venue`. `None` only for a dry quote accepted under [`Context::dry_ok`].
    pub deposit_address: Option<String>,
    /// In the origin asset's units.
    pub amount_in: u128,
    /// USDC × 1e8.
    pub amount_in_e8: u128,
    /// USDC × 1e8, in the destination asset.
    pub min_amount_out_e8: u128,
    pub destination_asset: String,
    pub recipient: String,
    pub deadline_ms: u64,
}

/// The signed fields (oneclick.json `signed_fields`). Anything else in a signed quote is refused.
/// The `IgnoredAny` members are named only so that `deny_unknown_fields` accepts them.
#[derive(Deserialize)]
#[allow(dead_code)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fields {
    dry: bool,
    swap_type: String,
    slippage_tolerance: IgnoredAny,
    origin_asset: String,
    deposit_type: String,
    destination_asset: String,
    amount: String,
    refund_to: String,
    refund_type: String,
    recipient: String,
    recipient_type: String,
    deadline: String,
    #[serde(default)]
    quote_waiting_time_ms: Option<IgnoredAny>,
    #[serde(default)]
    referral: Option<IgnoredAny>,
    #[serde(default)]
    virtual_chain_recipient: Option<IgnoredAny>,
    #[serde(default)]
    virtual_chain_refund_recipient: Option<IgnoredAny>,
    #[serde(default)]
    custom_recipient_msg: Option<String>,
    amount_in: String,
    amount_in_formatted: IgnoredAny,
    amount_in_usd: IgnoredAny,
    min_amount_in: IgnoredAny,
    amount_out: IgnoredAny,
    amount_out_formatted: IgnoredAny,
    amount_out_usd: IgnoredAny,
    min_amount_out: String,
    #[serde(default)]
    deposit_address: Option<String>,
    #[serde(default)]
    deposit_memo: Option<IgnoredAny>,
    #[serde(default)]
    time_when_inactive: Option<IgnoredAny>,
    #[serde(default)]
    time_estimate: Option<IgnoredAny>,
    #[serde(default)]
    refund_fee: Option<IgnoredAny>,
    #[serde(default)]
    withdraw_fee: Option<IgnoredAny>,
    timestamp: IgnoredAny,
}

fn fields(msg: impl AsRef<str>) -> Refusal {
    Refusal::new(E_QUOTE_FIELDS, msg.as_ref())
}

/// `quote_signature` is 1Click's signature of `quote` (`E_QUOTE_SIGNATURE`).
pub fn check_signature(
    sha256: Sha256,
    verify: Ed25519Verify,
    quote: &str,
    quote_signature: &str,
) -> Result<(), Refusal> {
    let bad = |msg: &str| Refusal::new(E_QUOTE_SIGNATURE, msg);
    let encoded = quote_signature
        .strip_prefix("ed25519:")
        .ok_or_else(|| bad("quote_signature is not ed25519:<base58>"))?;
    let mut signature = [0u8; 64];
    if encoded.len() > 88 || !matches!(bs58::decode(encoded).onto(&mut signature[..]), Ok(64)) {
        return Err(bad("quote_signature is not 64 bytes of base58"));
    }
    let key = decode_base58_32(ONECLICK_PUBLIC_KEY_B58).ok_or_else(|| bad("1Click key"))?;
    let message = bs58::encode(sha256(quote.as_bytes())).into_string();
    if verify(&signature, message.as_bytes(), &key) {
        Ok(())
    } else {
        Err(bad(
            "quote_signature is not 1Click's signature of this quote (it covers the exact string)",
        ))
    }
}

/// The checks of a quote for `method` at `ctx`, in the order of the module doc. EVM addresses
/// compare case-insensitively, everything else exactly.
pub fn verify_quote(
    sha256: Sha256,
    verify: Ed25519Verify,
    quote: &str,
    quote_signature: &str,
    method: Method,
    ctx: &Context,
) -> Result<VerifiedQuote, Refusal> {
    check_signature(sha256, verify, quote, quote_signature)?;
    let f: Fields = serde_json::from_str(quote)
        .map_err(|e| fields(format!("the quote is not a 1Click quote: {e}")))?;

    // A live quote, with a deposit address.
    let deposit_address = match (&f.deposit_address, f.dry) {
        (Some(a), false) => Some(a.clone()),
        (None, true) if ctx.dry_ok => None,
        _ => {
            return Err(fields(
                "not a live quote with a deposit address (a dry quote cannot be paid)",
            ))
        }
    };

    if f.origin_asset != method.origin_asset() {
        return Err(fields(format!(
            "originAsset {} is not what {} sends ({})",
            shown(&f.origin_asset),
            method.name(),
            method.origin_asset()
        )));
    }
    // Out of an asset into the same asset moves nothing a desk needs and only pays fees, each up
    // to what `check_cost` allows: a loop an operator could repeat to drain the desk.
    if f.destination_asset == f.origin_asset {
        return Err(fields(format!(
            "destinationAsset is the originAsset {}: a transfer into the same asset only pays fees",
            method.origin_asset()
        )));
    }

    let refund_to_ok = match method {
        Method::SolSignRescue => f.refund_to == ctx.desk.sol,
        Method::HlSendToIntents | Method::EvmUsdcToIntents => same_evm(&f.refund_to, ctx.desk.evm),
        // TODO(C8 fund_venue): a 1Click refund to refundTo = the contract most likely arrives as
        // a plain `ft_transfer` (no `ft_on_transfer`, no msg), which credits no desk: fund_venue
        // must record the deposit address it paid per desk and credit a refund from it, or the
        // owner's USDC sits in the contract unassigned.
        Method::FundVenue => f.refund_to == ctx.contract,
    };
    if !refund_to_ok {
        return Err(fields(format!(
            "refundTo {} is not where {} takes money from",
            shown(&f.refund_to),
            method.name()
        )));
    }

    if f.recipient_type != "DESTINATION_CHAIN" {
        return Err(fields(format!(
            "recipientType {} is not DESTINATION_CHAIN",
            shown(&f.recipient_type)
        )));
    }

    let min_amount_out = integer("minAmountOut", &f.min_amount_out)?;
    check_recipient(&f, min_amount_out, ctx)?;

    // Rules of this contract besides the vectors' field rule.
    if f.swap_type != "EXACT_INPUT" {
        return Err(fields(format!(
            "swapType {} is not EXACT_INPUT",
            shown(&f.swap_type)
        )));
    }
    if f.deposit_type != "ORIGIN_CHAIN" || f.refund_type != "ORIGIN_CHAIN" {
        return Err(fields("depositType and refundType must be ORIGIN_CHAIN"));
    }
    if f.deposit_memo.is_some() {
        return Err(fields("a deposit memo cannot be paid"));
    }
    if f.virtual_chain_recipient.is_some() || f.virtual_chain_refund_recipient.is_some() {
        return Err(fields("virtual chain recipients are not desk addresses"));
    }
    let amount_in = integer("amountIn", &f.amount_in)?;
    if f.amount != f.amount_in || amount_in == 0 {
        return Err(fields(format!(
            "amountIn {} must equal the requested amount {} and not be zero",
            shown(&f.amount_in),
            shown(&f.amount)
        )));
    }
    let deposit_address = deposit_address
        .map(|a| deposit_form(method, &a))
        .transpose()?;

    let deadline_ms = parse_time_ms(&f.deadline)
        .ok_or_else(|| fields(format!("deadline {} is not a UTC time", shown(&f.deadline))))?;
    if ctx.now_ms >= deadline_ms {
        return Err(fields(format!(
            "deadline {} passed (now {} ms)",
            f.deadline, ctx.now_ms
        )));
    }

    let origin_decimals = decimals(method.origin_asset()).unwrap_or(6);
    let amount_in_e8 = to_e8(amount_in, origin_decimals)?;
    if method.is_rescue() && amount_in_e8 > ctx.remaining_cap_e8 {
        return Err(Refusal::new(
            E_RESCUE_CAP,
            format!(
                "amountIn {} USDC is over what is left of the hourly rescue cap, {} USD",
                format_e8(amount_in_e8),
                format_e8(ctx.remaining_cap_e8)
            ),
        ));
    }

    let destination_decimals = decimals(&f.destination_asset).unwrap_or(6);
    Ok(VerifiedQuote {
        method,
        deposit_address,
        amount_in,
        amount_in_e8,
        min_amount_out_e8: to_e8(min_amount_out, destination_decimals)?,
        destination_asset: f.destination_asset,
        recipient: f.recipient,
        deadline_ms,
    })
}

/// The recipient and destination pairs a quote may pay: the pinned Orderly receiver (Arbitrum
/// USDC, `minAmountOut` ≥ 6 USDC), the desk EVM address (HyperCore USDC), the desk Solana
/// authority (Solana USDC), the contract (USDC on NEAR, `customRecipientMsg` exactly
/// `{"desk_id":"<desk>"}`). A recipient message goes with the contract only.
fn check_recipient(f: &Fields, min_amount_out: u128, ctx: &Context) -> Result<(), Refusal> {
    let to = f.recipient.as_str();
    let dest = f.destination_asset.as_str();
    let to_contract = to == ctx.contract && dest == NEAR_USDC;
    if to_contract {
        let want = format!("{{\"desk_id\":\"{}\"}}", ctx.desk.desk_id);
        if f.custom_recipient_msg.as_deref() != Some(want.as_str()) {
            return Err(fields(format!(
                "customRecipientMsg must name this desk exactly, {want}"
            )));
        }
        return Ok(());
    }
    if f.custom_recipient_msg.is_some() {
        return Err(fields(
            "customRecipientMsg goes only with the contract as recipient",
        ));
    }
    let to_orderly = ctx.desk.orderly_receiver.is_some_and(|r| same_evm(to, r)) && dest == ARB_USDC;
    if to_orderly {
        if min_amount_out < ORDERLY_MIN_OUT_E6 {
            return Err(fields(format!(
                "minAmountOut {} is below 6 USDC for the Orderly receiver (Orderly loses a \
                 deposit under 5)",
                format_e8(min_amount_out * 100)
            )));
        }
        return Ok(());
    }
    let to_desk =
        (same_evm(to, ctx.desk.evm) && dest == HL_USDC) || (to == ctx.desk.sol && dest == SOL_USDC);
    if to_desk {
        return Ok(());
    }
    Err(fields(format!(
        "recipient {} with destinationAsset {} is not a desk address (desk EVM on HyperCore, desk \
         Solana authority, the pinned Orderly receiver on Arbitrum, the contract on NEAR)",
        shown(to),
        shown(dest)
    )))
}

/// The deposit address in the form the method pays: a 32-byte base58 Solana address, or an EVM
/// address returned in lowercase.
fn deposit_form(method: Method, address: &str) -> Result<String, Refusal> {
    match method {
        Method::SolSignRescue => decode_base58_32(address)
            .map(|_| address.to_owned())
            .ok_or_else(|| {
                fields(format!(
                    "depositAddress {} is not a Solana address",
                    shown(address)
                ))
            }),
        Method::HlSendToIntents | Method::EvmUsdcToIntents => {
            let lower = address.to_ascii_lowercase();
            if crate::ids::is_lower_evm_address(&lower) {
                Ok(lower)
            } else {
                Err(fields(format!(
                    "depositAddress {} is not an EVM address",
                    shown(address)
                )))
            }
        }
        Method::FundVenue => Ok(address.to_owned()),
    }
}

/// `minAmountOut` ≥ `amountIn` − max(`amountIn` × `max_bps` / 10⁴, `max_flat_e6`), in USDC
/// (`E_QUOTE_FIELDS`): 1Click's fees are not in the signed quote, so the signed minimum is the
/// only bound on what a transfer costs.
pub fn check_cost(q: &VerifiedQuote, max_bps: u32, max_flat_e6: u64) -> Result<(), Refusal> {
    let share = q.amount_in_e8 * u128::from(max_bps) / 10_000;
    let allowed = share.max(u128::from(max_flat_e6) * 100);
    let cost = q.amount_in_e8.saturating_sub(q.min_amount_out_e8);
    if cost > allowed {
        return Err(fields(format!(
            "the transfer may cost {} USDC (amountIn − minAmountOut), over the policy's {} USDC",
            format_e8(cost),
            format_e8(allowed)
        )));
    }
    Ok(())
}

/// What a verified transfer may cost the desk through its quote, USD × 1e8: `amountIn` −
/// `minAmountOut` (0 for a quote that pays out at least what it takes). The rescue cost budget
/// counts it.
///
/// Hyperliquid's 1 USDC `sendAsset` fee for `hl_send_to_intents` is not in it. The budget bounds
/// what a quote's `appFees` can pay to a third party, and that shows only in the signed quote.
/// The send fee is burnt by Hyperliquid, like trading fees, which the contract does not bound
/// either; counting it would fill the 1 USD budget of the policy defaults with a single send.
pub fn transfer_cost_e8(q: &VerifiedQuote) -> u128 {
    q.amount_in_e8.saturating_sub(q.min_amount_out_e8)
}

/// What the rescues of an hour may cost together, USD × 1e8: max(`cap_usd` × `max_bps` / 10⁴,
/// 2 × `max_flat_e6`), the policy's per-transfer bound applied once to the whole hourly cap, or
/// two transfers at the flat bound. Without it many small rescues, each within [`check_cost`]
/// (the flat part allows 0.5 USDC on any amount), could pay most of the cap away in fees.
pub fn rescue_cost_budget_e8(cap_usd: u64, max_bps: u32, max_flat_e6: u64) -> u128 {
    let share = u128::from(cap_usd) * 100_000_000 * u128::from(max_bps) / 10_000;
    share.max(2 * u128::from(max_flat_e6) * 100)
}

fn same_evm(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// A base-unit amount: decimal digits without leading zeros, at most u128.
fn integer(field: &str, s: &str) -> Result<u128, Refusal> {
    let canonical =
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    canonical
        .then(|| s.parse::<u128>().ok())
        .flatten()
        .ok_or_else(|| fields(format!("{field} {} is not an amount", shown(s))))
}

/// An amount in an asset of `decimals` (at most 8), as USDC × 1e8.
fn to_e8(amount: u128, decimals: u32) -> Result<u128, Refusal> {
    10u128
        .checked_pow(8u32.saturating_sub(decimals))
        .and_then(|scale| amount.checked_mul(scale))
        .ok_or_else(|| fields("amount out of range"))
}

/// `YYYY-MM-DDTHH:MM:SS[.f{1,3}]Z` as ms since the Unix epoch, years 1970 to 9999.
pub fn parse_time_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let (main, rest) = (b.get(..19)?, b.get(19..)?);
    let num = |range: core::ops::Range<usize>| -> Option<i64> {
        let digits = main.get(range)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            digits
                .iter()
                .fold(0i64, |n, d| n * 10 + i64::from(d - b'0')),
        )
    };
    let seps = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if seps.iter().any(|&(i, c)| main[i] != c) {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = match rest {
        [b'Z'] => 0,
        [b'.', frac @ .., b'Z'] if (1..=3).contains(&frac.len()) => {
            if !frac.iter().all(u8::is_ascii_digit) {
                return None;
            }
            let n = frac.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0'));
            n * 10i64.pow(3 - frac.len() as u32)
        }
        _ => return None,
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || day < 1
        || day > month_days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days from 1970-01-01 (Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis;
    u64::try_from(ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_times() {
        assert_eq!(parse_time_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time_ms("1970-01-01T00:00:00.001Z"), Some(1));
        assert_eq!(parse_time_ms("1970-01-01T00:00:00.5Z"), Some(500));
        // The vectors' deadline and the field case at that very ms.
        assert_eq!(
            parse_time_ms("2026-10-27T04:20:18.239Z"),
            Some(1_793_074_818_239)
        );
        assert_eq!(
            parse_time_ms("2000-02-29T23:59:59.999Z"),
            Some(951_868_799_999)
        );
        assert_eq!(
            parse_time_ms("2024-12-31T23:59:59Z"),
            Some(1_735_689_599_000)
        );
        for bad in [
            "",
            "2026-10-27T04:20:18.239",
            "2026-10-27 04:20:18.239Z",
            "2026-10-27T04:20:18.2390Z",
            "2026-10-27T04:20:18.Z",
            "2026-13-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "1900-02-28T00:00:00Z",
            "2026-10-27T24:00:00Z",
            "2026-10-27T04:60:00Z",
            "2026-10-27T04:20:60Z",
            "2026-10-27T04:20:18+00:00",
            "+2026-10-27T04:20:18Z",
            "2026-1a-27T04:20:18Z",
        ] {
            assert_eq!(parse_time_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn amounts() {
        assert_eq!(integer("x", "0").unwrap(), 0);
        assert_eq!(integer("x", "4000000").unwrap(), 4_000_000);
        for bad in ["", "04", "4.0", "-4", "+4", " 4", "1e6"] {
            assert_eq!(integer("x", bad).unwrap_err().code, E_QUOTE_FIELDS, "{bad}");
        }
        assert_eq!(to_e8(4_000_000, 6).unwrap(), 400_000_000);
        assert_eq!(to_e8(400_000_000, 8).unwrap(), 400_000_000);
        assert!(to_e8(u128::MAX, 6).is_err());
    }

    #[test]
    fn the_signing_key_decodes() {
        assert!(decode_base58_32(ONECLICK_PUBLIC_KEY_B58).is_some());
    }

    fn verified(amount_in_e8: u128, min_amount_out_e8: u128) -> VerifiedQuote {
        VerifiedQuote {
            method: Method::SolSignRescue,
            deposit_address: None,
            amount_in: amount_in_e8 / 100,
            amount_in_e8,
            min_amount_out_e8,
            destination_asset: HL_USDC.into(),
            recipient: String::new(),
            deadline_ms: 0,
        }
    }

    /// The policy defaults (100 bp, 0.5 USDC) against the recorded quotes' costs.
    #[test]
    fn the_cost_bound() {
        // 4 USDC to Hyperliquid, 0.355777 USDC: under the flat 0.5.
        assert!(check_cost(&verified(400_000_000, 364_422_300), 100, 500_000).is_ok());
        // 20 USDC from NEAR, 0.519006: over max(0.2, 0.5).
        let r = check_cost(&verified(2_000_000_000, 1_948_099_400), 100, 500_000).unwrap_err();
        assert_eq!(r.code, E_QUOTE_FIELDS);
        assert_eq!(
            r.msg,
            "the transfer may cost 0.519006 USDC (amountIn − minAmountOut), over the policy's 0.5 \
             USDC"
        );
        // The edges: exactly the flat part, exactly the share.
        assert!(check_cost(&verified(400_000_000, 350_000_000), 100, 500_000).is_ok());
        assert!(check_cost(&verified(400_000_000, 349_999_999), 100, 500_000).is_err());
        assert!(check_cost(&verified(10_000_000_000, 9_900_000_000), 100, 500_000).is_ok());
        assert!(check_cost(&verified(10_000_000_000, 9_899_999_999), 100, 500_000).is_err());
        // A quote paying out more than it takes costs nothing.
        assert!(check_cost(&verified(400_000_000, 500_000_000), 0, 0).is_ok());
    }

    #[test]
    fn the_cost_of_a_transfer_and_the_hourly_budget() {
        // 4 in, 3.644223 out: 0.355777; nothing for a quote paying out more than it takes.
        assert_eq!(
            transfer_cost_e8(&verified(400_000_000, 364_422_300)),
            35_577_700
        );
        assert_eq!(transfer_cost_e8(&verified(400_000_000, 500_000_000)), 0);
        // Hyperliquid's 1 USDC sendAsset fee is a burn, not a quote cost: the same for every
        // method.
        let hl = VerifiedQuote {
            method: Method::HlSendToIntents,
            ..verified(400_000_000, 364_422_300)
        };
        assert_eq!(transfer_cost_e8(&hl), 35_577_700);
        // The defaults (100 bp, 0.5 USDC): 1 USD an hour up to a 100 USD cap (two flat
        // transfers), then 1% of the cap.
        assert_eq!(rescue_cost_budget_e8(50, 100, 500_000), 100_000_000);
        assert_eq!(rescue_cost_budget_e8(100, 100, 500_000), 100_000_000);
        assert_eq!(rescue_cost_budget_e8(1000, 100, 500_000), 1_000_000_000);
        assert_eq!(rescue_cost_budget_e8(0, 100, 0), 0);
        assert_eq!(
            rescue_cost_budget_e8(u64::MAX, u32::MAX, u64::MAX),
            u128::from(u64::MAX) * 100_000_000 * u128::from(u32::MAX) / 10_000
        );
    }

    #[test]
    fn methods() {
        for m in [
            Method::SolSignRescue,
            Method::HlSendToIntents,
            Method::EvmUsdcToIntents,
            Method::FundVenue,
        ] {
            assert_eq!(Method::parse(m.name()), Some(m));
            assert!(decimals(m.origin_asset()).is_some());
        }
        assert!(!Method::FundVenue.is_rescue());
        assert_eq!(Method::parse("hl_withdraw"), None);
    }
}
