//! Hyperliquid: the actions a desk's master address signs, their bytes and digests, and the checks an
//! order passes first (docs/interfaces.md §1.3; CLAUDE.md, "Venue facts that bite").
//!
//! - **L1 actions** (`order`, `cancel`, `setReferrer`): connection id = keccak256(msgpack(action) ‖
//!   nonce as u64 big-endian ‖ `0x00`, no vault ‖ with `expiresAfter` also `0x00` ‖ expiresAfter as
//!   u64 big-endian); the key signs the EIP-712 `Agent(string source,bytes32 connectionId)` in
//!   domain `Exchange` / `1` / chainId 1337 / zero address, source `a` on mainnet and `b` on
//!   testnet. Orders and cancels carry `expiresAfter` = block time + [`EXPIRES_AFTER_MS`], in the
//!   hash and in the posted body, so a signature the MPC returns late dies on its own; Hyperliquid
//!   lists the field for order, cancel, cancelByCloid, modify and a few more, not for setReferrer.
//! - **User-signed actions** (`usdClassTransfer`, `sendAsset`, `withdraw3`, `approveBuilderFee`):
//!   EIP-712 `HyperliquidTransaction:<Name>(…)` in domain `HyperliquidSignTransaction` / `1` /
//!   chainId 0x66eee / zero address; the posted action carries the same fields plus `type`,
//!   `signatureChainId` and `hyperliquidChain`. Hyperliquid refuses `expiresAfter` on them; what
//!   bounds their life is the nonce rule: a nonce must be inside (block time − 2 days, block time +
//!   1 day) and above the smallest of the signer's 100 highest nonces used, so a late signature
//!   dies 2 days after its nonce (the block time it was built at), or once the desk has signed 100
//!   later actions.
//!
//! All hex is lowercase: Hyperliquid lowercases before it verifies. Every vector in
//! `tests/vectors/hl.json` (from the venue's own SDKs) is checked in `tests/hl_vectors.rs`.

use serde::{Deserialize, Serialize};

use crate::decimal::{format_e8, parse_e8};
use crate::eip712::{self, Field, Keccak};
use crate::errors::{shown, Refusal, E_ARGS, E_ASSET, E_DECIMAL, E_SIZE};
use crate::limits;
use crate::msgpack::Value;
use crate::network::Network;
use crate::policy::Policy;

pub const AGENT_TYPE: &str = "Agent(string source,bytes32 connectionId)";
/// The `signatureChainId` of user-signed actions, which is also their EIP-712 domain chainId.
pub const SIGNATURE_CHAIN_ID: u64 = 0x66eee;
pub const SIGNATURE_CHAIN_ID_HEX: &str = "0x66eee";
/// Prices: at most 5 significant figures (integers exempt) and `6 − szDecimals` decimals.
pub const PX_MAX_SIG_FIGS: usize = 5;
pub const PX_MAX_DECIMALS: u8 = 6;
/// USDC amounts on Hyperliquid's perp side have 6 decimals.
pub const USDC_DECIMALS: usize = 6;
/// Referral codes are 1 to 20 characters.
pub const REFERRAL_CODE_MAX_CHARS: usize = 20;
/// How long after the block time an order or cancel the contract builds stays valid (ms): its
/// `expiresAfter`.
pub const EXPIRES_AFTER_MS: u64 = 60_000;

/// The USDC spot token `sendAsset` moves, per network.
pub const fn usdc_token(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
        Network::Testnet => "USDC:0xeb62eee3685fc4c43992febcd9e75443",
    }
}

/// The desk's next nonce: Hyperliquid wants every nonce of a signer unique and close to its time.
pub fn next_nonce(block_ms: u64, last_nonce: u64) -> u64 {
    block_ms.max(last_nonce.saturating_add(1))
}

/// What the desk's EVM key signs and what the relayer posts with that signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// The action's `type`: `order`, `setReferrer`, `approveBuilderFee`, …
    pub kind: &'static str,
    /// The `/exchange` body without `signature`: `{action, nonce, vaultAddress: null}` for an L1
    /// action, `{action, nonce}` for a user-signed one.
    pub payload: Value,
    /// The EIP-712 digest.
    pub digest: [u8; 32],
}

// --- hex fields ---

/// An EVM address, written lowercase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address(pub [u8; 20]);

impl Address {
    /// `0x` and 40 hex digits of either case (EIP-55 too), else `E_ARGS` naming `field`.
    pub fn parse(field: &str, s: &str) -> Result<Self, Refusal> {
        parse_0x_hex(field, "an address of 20 bytes", s).map(Address)
    }

    /// `0x` and 40 lowercase hex digits.
    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }
}

/// A client order id: 16 bytes, written `0x` + 32 lowercase hex digits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cloid(pub [u8; 16]);

impl Cloid {
    /// `0x` and 32 hex digits of either case, else `E_ARGS`.
    pub fn parse(s: &str) -> Result<Self, Refusal> {
        parse_0x_hex("cloid", "0x and 16 bytes of hex", s).map(Cloid)
    }

    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }
}

/// Exactly `0x` (lowercase x) and `2 × N` hex digits.
fn parse_0x_hex<const N: usize>(field: &str, what: &str, s: &str) -> Result<[u8; N], Refusal> {
    let mut out = [0u8; N];
    let ok = s.len() == 2 + 2 * N
        && s.starts_with("0x")
        && hex::decode_to_slice(&s[2..], &mut out).is_ok();
    if ok {
        Ok(out)
    } else {
        Err(Refusal::new(
            E_ARGS,
            format!("{field} {} is not {what}", shown(s)),
        ))
    }
}

// --- orders ---

/// Time in force, spelt as Hyperliquid spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tif {
    /// Immediate or cancel.
    Ioc,
    /// Good till cancelled.
    Gtc,
    /// Add liquidity only (post-only).
    Alo,
}

impl Tif {
    /// `Ioc`, `Gtc` or `Alo`, exactly; anything else (`ioc`, `FrontendMarket`) is `E_ARGS`.
    pub fn parse(s: &str) -> Result<Self, Refusal> {
        match s {
            "Ioc" => Ok(Tif::Ioc),
            "Gtc" => Ok(Tif::Gtc),
            "Alo" => Ok(Tif::Alo),
            _ => Err(Refusal::new(
                E_ARGS,
                format!("tif {} is not Ioc, Gtc or Alo", shown(s)),
            )),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Tif::Ioc => "Ioc",
            Tif::Gtc => "Gtc",
            Tif::Alo => "Alo",
        }
    }
}

/// `hl_order`'s `order` argument (docs/interfaces.md §1.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HlOrder {
    /// Hyperliquid's asset index; must be in the desk's `policy.hl_assets`.
    pub asset: u32,
    pub is_buy: bool,
    /// Canonical decimal, Hyperliquid's price rules ([`check_px`]).
    pub px: String,
    /// Canonical decimal with at most `szDecimals` decimals ([`check_sz`]).
    pub sz: String,
    pub reduce_only: bool,
    /// `Ioc`, `Gtc` or `Alo`.
    pub tif: String,
    /// `0x` + 32 hex, any case; signed lowercase.
    pub cloid: Option<String>,
}

/// An order in the form it is signed: tif and cloid parsed. px and sz are the caller's strings,
/// which [`check_order`] has checked are the canonical ones.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderWire {
    pub asset: u32,
    pub is_buy: bool,
    pub px: String,
    pub sz: String,
    pub reduce_only: bool,
    pub tif: Tif,
    pub cloid: Option<Cloid>,
}

impl OrderWire {
    /// The checks that need no policy: tif and cloid (`E_ARGS`).
    pub fn from_order(order: &HlOrder) -> Result<Self, Refusal> {
        Ok(Self {
            asset: order.asset,
            is_buy: order.is_buy,
            px: order.px.clone(),
            sz: order.sz.clone(),
            reduce_only: order.reduce_only,
            tif: Tif::parse(&order.tif)?,
            cloid: order.cloid.as_deref().map(Cloid::parse).transpose()?,
        })
    }
}

/// An order that passed [`check_order`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedOrder {
    pub wire: OrderWire,
    /// The policy's symbol for the asset; the reference price is the oracle price of it.
    pub symbol: String,
    pub px_e8: u128,
    pub sz_e8: u128,
    /// The oracle price the order was checked against; `None` for a symbol in `policy.unpriced`.
    pub oracle_e8: Option<u128>,
    /// In `policy.unpriced`: no price band, and capped by its `max_sz` and the smaller notional cap.
    pub unpriced: bool,
}

/// The order checks, in this order: the asset is in the policy (`E_ASSET`); tif and cloid
/// (`E_ARGS`); px and sz strings (`E_DECIMAL`, a zero size `E_SIZE`); then
/// [`limits::check_value`]: an unpriced symbol within its `max_sz` and the unpriced cap at its own
/// price, any other symbol a reference price (`E_ORACLE_STALE`), the band around it
/// (`E_PRICE_BAND`) and `sz × max(px, reference)` within `max_notional_usd` (`E_SIZE`).
///
/// `reference_e8` is the symbol's stored oracle price if it is fresh, else `None`.
pub fn check_order(
    policy: &Policy,
    order: &HlOrder,
    reference_e8: Option<u128>,
) -> Result<CheckedOrder, Refusal> {
    let asset = policy
        .hl_assets
        .iter()
        .find(|a| a.index == order.asset)
        .ok_or_else(|| {
            Refusal::new(
                E_ASSET,
                format!(
                    "Hyperliquid asset {} is not in the desk's policy",
                    order.asset
                ),
            )
        })?;
    let wire = OrderWire::from_order(order)?;
    let px_e8 = check_px(&order.px, asset.sz_decimals)?;
    let sz_e8 = check_sz(&order.sz, asset.sz_decimals)?;
    let valued = limits::check_value(policy, &asset.symbol, px_e8, sz_e8, reference_e8)?;
    Ok(CheckedOrder {
        wire,
        symbol: asset.symbol.clone(),
        px_e8,
        sz_e8,
        oracle_e8: valued.oracle_e8,
        unpriced: valued.unpriced(),
    })
}

/// A price string: canonical and above zero, at most `6 − sz_decimals` decimals, and an integer or
/// at most 5 significant figures (`E_DECIMAL`). Returns it in units of 1e-8.
pub fn check_px(px: &str, sz_decimals: u8) -> Result<u128, Refusal> {
    let units = canonical("px", px)?;
    let refuse = |why: String| Err(Refusal::new(E_DECIMAL, format!("px {} {why}", shown(px))));
    if units == 0 {
        return refuse("is zero".into());
    }
    let decimals = decimals_of(px);
    let max = usize::from(PX_MAX_DECIMALS.saturating_sub(sz_decimals));
    if decimals > max {
        return refuse(format!(
            "has {decimals} decimals; with szDecimals {sz_decimals} Hyperliquid allows {max}"
        ));
    }
    if decimals > 0 && significant_figures(px) > PX_MAX_SIG_FIGS {
        return refuse(format!(
            "has more than {PX_MAX_SIG_FIGS} significant figures"
        ));
    }
    Ok(units)
}

/// A size string: canonical with at most `sz_decimals` decimals (`E_DECIMAL`), and not zero
/// (`E_SIZE`). Returns it in units of 1e-8.
pub fn check_sz(sz: &str, sz_decimals: u8) -> Result<u128, Refusal> {
    let units = canonical("sz", sz)?;
    let decimals = decimals_of(sz);
    if decimals > usize::from(sz_decimals) {
        return Err(Refusal::new(
            E_DECIMAL,
            format!(
                "sz {} has {decimals} decimals; the asset's szDecimals is {sz_decimals}",
                shown(sz)
            ),
        ));
    }
    if units == 0 {
        return Err(Refusal::new(E_SIZE, "sz is zero"));
    }
    Ok(units)
}

/// A USDC amount for `usdClassTransfer` or `withdraw3`: canonical with at most 6 decimals
/// (`E_DECIMAL`), and not zero (`E_SIZE`). Returns it in units of 1e-8.
pub fn check_usdc_amount(amount: &str) -> Result<u128, Refusal> {
    let units = canonical("amount", amount)?;
    let decimals = decimals_of(amount);
    if decimals > USDC_DECIMALS {
        return Err(Refusal::new(
            E_DECIMAL,
            format!(
                "amount {} has {decimals} decimals; USDC has {USDC_DECIMALS}",
                shown(amount)
            ),
        ));
    }
    if units == 0 {
        return Err(Refusal::new(E_SIZE, "amount is zero"));
    }
    Ok(units)
}

/// [`parse_e8`] with the argument's name in the refusal.
fn canonical(field: &str, s: &str) -> Result<u128, Refusal> {
    parse_e8(s).map_err(|r| Refusal::new(r.code, format!("{field} {}", r.msg)))
}

/// Digits after the dot of a canonical decimal.
fn decimals_of(s: &str) -> usize {
    s.split_once('.').map_or(0, |(_, frac)| frac.len())
}

/// Digits from the first non-zero one on; a canonical decimal has no trailing zeros after the dot.
fn significant_figures(s: &str) -> usize {
    s.bytes()
        .filter(u8::is_ascii_digit)
        .skip_while(|&b| b == b'0')
        .count()
}

// --- L1 actions ---

/// `{type:"order", orders:[{a,b,p,s,r,t:{limit:{tif}},c?}], grouping:"na", builder:{b,f}}`: the
/// cloid `c` follows `t` when set; `builder` is always there, with `f` in tenths of a bp.
pub fn order_action(order: &OrderWire, builder: &Address, fee_tenth_bps: u16) -> Value {
    let mut fields = vec![
        ("a", Value::UInt(order.asset.into())),
        ("b", Value::Bool(order.is_buy)),
        ("p", Value::str(order.px.as_str())),
        ("s", Value::str(order.sz.as_str())),
        ("r", Value::Bool(order.reduce_only)),
        (
            "t",
            Value::map([(
                "limit",
                Value::map([("tif", Value::str(order.tif.as_str()))]),
            )]),
        ),
    ];
    if let Some(cloid) = &order.cloid {
        fields.push(("c", Value::str(cloid.to_hex())));
    }
    Value::map([
        ("type", Value::str("order")),
        ("orders", Value::Array(vec![Value::map(fields)])),
        ("grouping", Value::str("na")),
        (
            "builder",
            Value::map([
                ("b", Value::str(builder.to_hex())),
                ("f", Value::UInt(fee_tenth_bps.into())),
            ]),
        ),
    ])
}

/// `{type:"cancel", cancels:[{a, o}]}`.
pub fn cancel_action(asset: u32, oid: u64) -> Value {
    Value::map([
        ("type", Value::str("cancel")),
        (
            "cancels",
            Value::Array(vec![Value::map([
                ("a", Value::UInt(asset.into())),
                ("o", Value::UInt(oid)),
            ])]),
        ),
    ])
}

/// `{type:"setReferrer", code}`.
pub fn set_referrer_action(code: &str) -> Value {
    Value::map([
        ("type", Value::str("setReferrer")),
        ("code", Value::str(code)),
    ])
}

/// The configured referral code (`treasury.referral_codes.hyperliquid`) for `setReferrer`; none
/// configured, or one that is not 1 to 20 characters, is `E_ARGS`.
pub fn referral_code(code: Option<&str>) -> Result<&str, Refusal> {
    let code = code.ok_or_else(|| {
        Refusal::new(
            E_ARGS,
            "no Hyperliquid referral code is configured (treasury.referral_codes.hyperliquid is null), so venue setup skips hl_set_referrer",
        )
    })?;
    check_referral_code(code)?;
    Ok(code)
}

/// 1 to [`REFERRAL_CODE_MAX_CHARS`] characters, else `E_ARGS`.
pub fn check_referral_code(code: &str) -> Result<(), Refusal> {
    let chars = code.chars().count();
    if chars == 0 || chars > REFERRAL_CODE_MAX_CHARS {
        return Err(Refusal::new(
            E_ARGS,
            format!(
                "Hyperliquid referral code has {chars} characters, not 1 to {REFERRAL_CODE_MAX_CHARS}"
            ),
        ));
    }
    Ok(())
}

/// keccak256(msgpack(action) ‖ nonce as u64 big-endian ‖ `0x00`): no vault address, no expiry.
pub fn connection_id(keccak: Keccak, action: &Value, nonce: u64) -> [u8; 32] {
    expiring_connection_id(keccak, action, nonce, None)
}

/// [`connection_id`], and with `expires_after` (ms) also `0x00` ‖ expires_after as u64 big-endian
/// after the vault byte, as Hyperliquid's own SDK hashes it (`action_hash` of
/// hyperliquid-python-sdk 0.x, `signing.py`).
pub fn expiring_connection_id(
    keccak: Keccak,
    action: &Value,
    nonce: u64,
    expires_after: Option<u64>,
) -> [u8; 32] {
    let mut bytes = action.to_msgpack();
    bytes.extend_from_slice(&nonce.to_be_bytes());
    bytes.push(0x00);
    if let Some(expires_after) = expires_after {
        bytes.push(0x00);
        bytes.extend_from_slice(&expires_after.to_be_bytes());
    }
    keccak(&bytes)
}

/// The domain of L1 actions: `Exchange`, version `1`, chainId 1337, zero address.
pub fn exchange_domain_separator(keccak: Keccak) -> [u8; 32] {
    eip712::domain_separator(keccak, "Exchange", "1", 1337, [0; 20])
}

/// hashStruct of `Agent{source, connectionId}`.
pub fn agent_struct_hash(keccak: Keccak, network: Network, connection_id: &[u8; 32]) -> [u8; 32] {
    eip712::hash_struct(
        keccak,
        AGENT_TYPE,
        &[
            Field::Str(network.hl_source()),
            Field::Bytes32(*connection_id),
        ],
    )
}

/// An L1 action ready to sign at `nonce`; with `expires_after` (ms) Hyperliquid refuses it after
/// that time. The payload is `{action, nonce, vaultAddress: null}`, plus `expiresAfter` when set.
pub fn prepare_l1(
    keccak: Keccak,
    network: Network,
    kind: &'static str,
    action: Value,
    nonce: u64,
    expires_after: Option<u64>,
) -> Prepared {
    let connection = expiring_connection_id(keccak, &action, nonce, expires_after);
    let digest = eip712::digest(
        keccak,
        &exchange_domain_separator(keccak),
        &agent_struct_hash(keccak, network, &connection),
    );
    let mut payload = vec![
        ("action", action),
        ("nonce", Value::UInt(nonce)),
        ("vaultAddress", Value::Nil),
    ];
    if let Some(expires_after) = expires_after {
        payload.push(("expiresAfter", Value::UInt(expires_after)));
    }
    Prepared {
        kind,
        payload: Value::map(payload),
        digest,
    }
}

// --- user-signed actions ---

/// A user-signed action. Its `nonce` (`time` for a withdrawal) is also the outer `nonce`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserAction {
    /// Moves USDC between the spot and perp balances.
    UsdClassTransfer {
        amount: String,
        to_perp: bool,
        nonce: u64,
    },
    /// Sends `token` to `destination`, from the perp balance when `source_dex` is `""`. Never
    /// from a sub-account. A destination Hyperliquid has not seen costs the sender 1 USDC more.
    SendAsset {
        destination: Address,
        source_dex: String,
        destination_dex: String,
        token: String,
        amount: String,
        nonce: u64,
    },
    /// Withdraws USDC to `destination` on Arbitrum.
    Withdraw {
        destination: Address,
        amount: String,
        time: u64,
    },
    /// Lets `builder` charge up to `max_fee_rate` (`"0.01%"`) per fill. Only a master address can
    /// sign it, never an agent.
    ApproveBuilderFee {
        max_fee_rate: String,
        builder: Address,
        nonce: u64,
    },
}

/// A member of a user-signed action, as typed data and as JSON.
enum Item<'a> {
    Text(&'a str),
    Hex(String),
    Flag(bool),
    Number(u64),
    Addr(&'a Address),
}

impl UserAction {
    /// The action's `type`.
    pub const fn kind(&self) -> &'static str {
        match self {
            UserAction::UsdClassTransfer { .. } => "usdClassTransfer",
            UserAction::SendAsset { .. } => "sendAsset",
            UserAction::Withdraw { .. } => "withdraw3",
            UserAction::ApproveBuilderFee { .. } => "approveBuilderFee",
        }
    }

    /// The EIP-712 type it is signed as.
    pub const fn type_string(&self) -> &'static str {
        match self {
            UserAction::UsdClassTransfer { .. } => "HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)",
            UserAction::SendAsset { .. } => "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)",
            UserAction::Withdraw { .. } => "HyperliquidTransaction:Withdraw(string hyperliquidChain,string destination,string amount,uint64 time)",
            UserAction::ApproveBuilderFee { .. } => "HyperliquidTransaction:ApproveBuilderFee(string hyperliquidChain,string maxFeeRate,address builder,uint64 nonce)",
        }
    }

    pub const fn nonce(&self) -> u64 {
        match self {
            UserAction::UsdClassTransfer { nonce, .. }
            | UserAction::SendAsset { nonce, .. }
            | UserAction::ApproveBuilderFee { nonce, .. } => *nonce,
            UserAction::Withdraw { time, .. } => *time,
        }
    }

    /// The members after `hyperliquidChain`, in the type's order, with their JSON names.
    fn items(&self) -> Vec<(&'static str, Item<'_>)> {
        match self {
            UserAction::UsdClassTransfer {
                amount,
                to_perp,
                nonce,
            } => vec![
                ("amount", Item::Text(amount)),
                ("toPerp", Item::Flag(*to_perp)),
                ("nonce", Item::Number(*nonce)),
            ],
            UserAction::SendAsset {
                destination,
                source_dex,
                destination_dex,
                token,
                amount,
                nonce,
            } => vec![
                ("destination", Item::Hex(destination.to_hex())),
                ("sourceDex", Item::Text(source_dex)),
                ("destinationDex", Item::Text(destination_dex)),
                ("token", Item::Text(token)),
                ("amount", Item::Text(amount)),
                ("fromSubAccount", Item::Text("")),
                ("nonce", Item::Number(*nonce)),
            ],
            UserAction::Withdraw {
                destination,
                amount,
                time,
            } => vec![
                ("destination", Item::Hex(destination.to_hex())),
                ("amount", Item::Text(amount)),
                ("time", Item::Number(*time)),
            ],
            UserAction::ApproveBuilderFee {
                max_fee_rate,
                builder,
                nonce,
            } => vec![
                ("maxFeeRate", Item::Text(max_fee_rate)),
                ("builder", Item::Addr(builder)),
                ("nonce", Item::Number(*nonce)),
            ],
        }
    }

    /// The action as posted: `type`, `signatureChainId`, `hyperliquidChain`, then the members.
    pub fn action(&self, network: Network) -> Value {
        let mut entries = vec![
            ("type", Value::str(self.kind())),
            ("signatureChainId", Value::str(SIGNATURE_CHAIN_ID_HEX)),
            ("hyperliquidChain", Value::str(network.hl_chain())),
        ];
        for (name, item) in self.items() {
            let value = match item {
                Item::Text(s) => Value::str(s),
                Item::Hex(s) => Value::Str(s),
                Item::Flag(b) => Value::Bool(b),
                Item::Number(n) => Value::UInt(n),
                Item::Addr(a) => Value::str(a.to_hex()),
            };
            entries.push((name, value));
        }
        Value::map(entries)
    }

    /// hashStruct of the action.
    pub fn struct_hash(&self, keccak: Keccak, network: Network) -> [u8; 32] {
        let items = self.items();
        let mut fields = vec![Field::Str(network.hl_chain())];
        for (_, item) in &items {
            fields.push(match item {
                Item::Text(s) => Field::Str(s),
                Item::Hex(s) => Field::Str(s),
                Item::Flag(b) => Field::Bool(*b),
                Item::Number(n) => Field::Uint(*n),
                Item::Addr(a) => Field::Address(a.0),
            });
        }
        eip712::hash_struct(keccak, self.type_string(), &fields)
    }

    /// The action ready to sign.
    pub fn prepare(&self, keccak: Keccak, network: Network) -> Prepared {
        let digest = eip712::digest(
            keccak,
            &sign_transaction_domain_separator(keccak),
            &self.struct_hash(keccak, network),
        );
        Prepared {
            kind: self.kind(),
            payload: Value::map([
                ("action", self.action(network)),
                ("nonce", Value::UInt(self.nonce())),
            ]),
            digest,
        }
    }
}

/// The domain of user-signed actions: `HyperliquidSignTransaction`, version `1`, chainId 0x66eee,
/// zero address (the same on both networks; `hyperliquidChain` carries the network).
pub fn sign_transaction_domain_separator(keccak: Keccak) -> [u8; 32] {
    eip712::domain_separator(
        keccak,
        "HyperliquidSignTransaction",
        "1",
        SIGNATURE_CHAIN_ID,
        [0; 20],
    )
}

/// `ApproveBuilderFee.maxFeeRate` for a fee in tenths of a bp: f / 1000 as a canonical decimal and
/// `%`, so 10 (1 bp) is `"0.01%"`.
pub fn max_fee_rate(fee_tenth_bps: u16) -> String {
    // f / 1000 % in units of 1e-8 is f × 1e5.
    format!("{}%", format_e8(u128::from(fee_tenth_bps) * 100_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{E_ORACLE_STALE, E_PRICE_BAND};
    use crate::policy::{HlAsset, UnpricedAsset};

    fn policy() -> Policy {
        Policy {
            hl_assets: vec![
                HlAsset {
                    index: 1,
                    symbol: "ETH".into(),
                    sz_decimals: 4,
                },
                HlAsset {
                    index: 159,
                    symbol: "HYPE".into(),
                    sz_decimals: 2,
                },
            ],
            phoenix_markets: vec![],
            orderly_symbols: vec![],
            max_notional_usd: 1000,
            price_band_bps: 200,
            oracle_max_age_s: 300,
            rescue_cap_usd_per_hour: 0,
            max_transfer_cost_bps: 0,
            max_transfer_cost_flat_e6: 0,
            unpriced: vec![UnpricedAsset {
                symbol: "HYPE".into(),
                max_sz: "3".into(),
            }],
            unpriced_max_notional_usd: 100,
        }
    }

    /// ETH's oracle price in these tests: 2500 USD.
    const ETH_E8: Option<u128> = Some(250_000_000_000);

    fn order(asset: u32, px: &str, sz: &str) -> HlOrder {
        HlOrder {
            asset,
            is_buy: true,
            px: px.into(),
            sz: sz.into(),
            reduce_only: false,
            tif: "Ioc".into(),
            cloid: None,
        }
    }

    fn refused(r: Result<impl std::fmt::Debug, Refusal>) -> Refusal {
        r.expect_err("should be refused")
    }

    #[test]
    fn notional_cap_messages_name_the_cap() {
        let r = refused(check_order(&policy(), &order(1, "2500", "0.4001"), ETH_E8));
        assert_eq!(r.code, E_SIZE);
        assert_eq!(
            r.msg,
            "ETH 2500 x 0.4001 = 1000.25 USD is over max_notional_usd 1000"
        );
        let r = refused(check_order(&policy(), &order(159, "50", "3"), None));
        assert_eq!(
            r.to_string(),
            "E_SIZE: HYPE 50 x 3 = 150 USD is over the unpriced cap, min(max_notional_usd, unpriced_max_notional_usd) 100"
        );
        let mut p = policy();
        p.max_notional_usd = 50;
        let r = refused(check_order(&p, &order(159, "39.9", "2.5"), None));
        assert!(r.msg.ends_with("unpriced_max_notional_usd) 50"), "{r}");
        p.max_notional_usd = 0;
        assert_eq!(
            refused(check_order(&p, &order(1, "2500", "0.0001"), ETH_E8)).code,
            E_SIZE
        );
    }

    /// The review of C3: `px:"1", sz:"1000"` on ETH fit a 1000 USD cap when a sell was valued at
    /// its own limit price.
    #[test]
    fn a_sell_at_a_tiny_limit_price_is_valued_at_the_oracle() {
        let mut sell = order(1, "1", "1000");
        sell.is_buy = false;
        assert_eq!(
            refused(check_order(&policy(), &sell, ETH_E8)).code,
            E_PRICE_BAND
        );
        let mut wide = policy();
        wide.price_band_bps = 10_000;
        let r = refused(check_order(&wide, &sell, ETH_E8));
        assert_eq!(
            r.to_string(),
            "E_SIZE: ETH 2500 (the oracle price, above the limit 1) x 1000 = 2500000 USD is over max_notional_usd 1000"
        );
        // A sell that fits at the oracle price passes, whatever its limit.
        sell.sz = "0.4".into();
        check_order(&wide, &sell, ETH_E8).unwrap();
    }

    #[test]
    fn a_priced_asset_without_a_fresh_oracle_price_is_refused() {
        let r = refused(check_order(&policy(), &order(1, "2500", "0.1"), None));
        assert_eq!(r.code, E_ORACLE_STALE);
        // An unpriced symbol needs none: its size is capped in base units instead.
        let r = refused(check_order(&policy(), &order(159, "1", "3.01"), None));
        assert_eq!(
            r.to_string(),
            "E_SIZE: HYPE size 3.01 is over its max_sz 3 (an unpriced symbol, capped in base units)"
        );
    }

    #[test]
    fn a_notional_past_u128_is_over_any_cap() {
        let mut p = policy();
        p.max_notional_usd = crate::policy::MAX_SAFE_INTEGER;
        p.price_band_bps = 10_000;
        p.hl_assets[0].sz_decimals = 0;
        let huge = "3".repeat(30);
        let reference = Some(parse_e8(&huge).unwrap());
        let r = refused(check_order(&p, &order(1, &huge, &huge), reference));
        assert_eq!(r.code, E_SIZE);
        assert!(r.msg.contains("more than 2^128 / 1e16"), "{r}");
    }

    #[test]
    fn the_checks_run_in_order() {
        // An asset outside the policy is refused before its malformed strings are looked at.
        let mut o = order(7, "x", "0");
        o.tif = "ioc".into();
        assert_eq!(refused(check_order(&policy(), &o, ETH_E8)).code, E_ASSET);
        o.asset = 1;
        assert_eq!(refused(check_order(&policy(), &o, ETH_E8)).code, E_ARGS);
        o.tif = "Ioc".into();
        assert_eq!(refused(check_order(&policy(), &o, ETH_E8)).code, E_DECIMAL);
        o.px = "2500".into();
        assert_eq!(refused(check_order(&policy(), &o, ETH_E8)).code, E_SIZE);
        // A size of its own is checked before the oracle.
        assert_eq!(refused(check_order(&policy(), &o, None)).code, E_SIZE);
        o.sz = "1".into();
        assert_eq!(
            refused(check_order(&policy(), &o, None)).code,
            E_ORACLE_STALE
        );
        o.px = "3000".into();
        assert_eq!(
            refused(check_order(&policy(), &o, ETH_E8)).code,
            E_PRICE_BAND
        );
        o.px = "2500".into();
        assert_eq!(refused(check_order(&policy(), &o, ETH_E8)).code, E_SIZE);
    }

    #[test]
    fn a_checked_order_carries_its_units_and_wire_form() {
        let mut o = order(1, "2500.5", "0.1");
        o.cloid = Some("0xABCDEF0123456789ABCDEF0123456789".into());
        let c = check_order(&policy(), &o, ETH_E8).unwrap();
        assert_eq!((c.px_e8, c.sz_e8), (250_050_000_000, 10_000_000));
        assert_eq!(c.symbol, "ETH");
        assert_eq!(c.oracle_e8, ETH_E8);
        assert!(!c.unpriced);
        assert_eq!(
            c.wire.cloid.unwrap().to_hex(),
            "0xabcdef0123456789abcdef0123456789"
        );
        let hype = check_order(&policy(), &order(159, "39.9", "2.5"), None).unwrap();
        assert!(hype.unpriced);
        assert_eq!(hype.oracle_e8, None);
    }

    #[test]
    fn px_and_sz_messages() {
        assert_eq!(
            check_px("2400.55", 4).unwrap_err().to_string(),
            "E_DECIMAL: px \"2400.55\" has more than 5 significant figures"
        );
        assert_eq!(
            check_px("0.1", 6).unwrap_err().to_string(),
            "E_DECIMAL: px \"0.1\" has 1 decimals; with szDecimals 6 Hyperliquid allows 0"
        );
        assert_eq!(
            check_px("2400.50", 4).unwrap_err().to_string(),
            "E_DECIMAL: px \"2400.50\" has a trailing zero after the dot"
        );
        assert_eq!(
            check_sz("1.555", 2).unwrap_err().to_string(),
            "E_DECIMAL: sz \"1.555\" has 3 decimals; the asset's szDecimals is 2"
        );
        assert_eq!(
            check_sz("0", 2).unwrap_err().to_string(),
            "E_SIZE: sz is zero"
        );
        // A policy that was never validated cannot underflow the decimals rule.
        assert_eq!(check_px("1", 9).unwrap(), 100_000_000);
    }

    #[test]
    fn usdc_amounts_have_at_most_6_decimals() {
        assert_eq!(check_usdc_amount("12.5").unwrap(), 1_250_000_000);
        assert_eq!(check_usdc_amount("0.000001").unwrap(), 100);
        let r = check_usdc_amount("0.0000001").unwrap_err();
        assert_eq!(
            r.to_string(),
            "E_DECIMAL: amount \"0.0000001\" has 7 decimals; USDC has 6"
        );
        assert_eq!(check_usdc_amount("10.0").unwrap_err().code, E_DECIMAL);
        assert_eq!(check_usdc_amount("-1").unwrap_err().code, E_DECIMAL);
        assert_eq!(check_usdc_amount("0").unwrap_err().code, E_SIZE);
    }

    #[test]
    fn hex_fields_are_exact_length_with_a_lowercase_prefix() {
        let long = format!("0x{}", "a".repeat(10_000));
        let r = Address::parse("destination", &long).unwrap_err();
        assert_eq!(r.code, E_ARGS);
        assert!(r.msg.len() < 120, "{r}");
        assert!(Cloid::parse("0x0123456789abcdef0123456789abcde").is_err());
        assert!(Cloid::parse("0x0123456789abcdef0123456789abcdé").is_err());
        assert_eq!(
            Cloid::parse("0x0123").unwrap_err().to_string(),
            "E_ARGS: cloid \"0x0123\" is not 0x and 16 bytes of hex"
        );
    }

    #[test]
    fn nonces_increase_per_desk() {
        assert_eq!(next_nonce(1_000, 0), 1_000);
        assert_eq!(next_nonce(1_000, 1_000), 1_001);
        assert_eq!(next_nonce(1_000, 5_000), 5_001);
        assert_eq!(next_nonce(9_000, 5_000), 9_000);
        assert_eq!(next_nonce(0, u64::MAX), u64::MAX);
    }

    #[test]
    fn referral_codes() {
        assert_eq!(referral_code(Some("TESTCODE")).unwrap(), "TESTCODE");
        let r = referral_code(None).unwrap_err();
        assert_eq!(r.code, E_ARGS);
        assert!(
            r.msg
                .starts_with("no Hyperliquid referral code is configured"),
            "{r}"
        );
        assert_eq!(
            check_referral_code("").unwrap_err().msg,
            "Hyperliquid referral code has 0 characters, not 1 to 20"
        );
        // Characters, not bytes.
        check_referral_code(&"\u{e9}".repeat(20)).unwrap();
    }

    #[test]
    fn fee_rates() {
        assert_eq!(max_fee_rate(0), "0%");
        assert_eq!(max_fee_rate(10), "0.01%");
        assert_eq!(max_fee_rate(1000), "1%");
    }
}
