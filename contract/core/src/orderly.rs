//! Orderly (docs/interfaces.md §1.3, §1.4): the EIP-712 messages the desk's EVM key signs, the
//! desk's account id, and the private REST requests its Ed25519 key signs. Every message and body
//! is built here from typed fields, the policy and `OrderlyConfig`; the caller never passes JSON.
//!
//! - **EIP-712**, domain `{name "Orderly", version "1", chainId, verifyingContract}`: the off-chain
//!   domain (verifyingContract `0xCcCC…cccC`) for `Registration` and `AddOrderlyKey`, the on-chain
//!   one (the Orderly Ledger of the network) for `Withdraw` and `SettlePnl`. Orderly takes the JSON
//!   message with `chainId`, timestamps and nonces as numbers, `registrationNonce` and Withdraw's
//!   `amount` (raw USDC, 6 decimals) as strings, and the signature as `0x` + r ‖ s ‖ v, v = 27/28.
//! - **REST**: Ed25519 over `timestamp + METHOD + path (with its query) + body`; Orderly accepts a
//!   request for 300 s after its timestamp and keeps no request nonce. The private WebSocket login
//!   signs the timestamp alone.
//!
//! Every case of `tests/vectors/orderly.json` is checked in `tests/orderly_vectors.rs`.

use serde::{Deserialize, Serialize};

use crate::decimal::parse_e8;
use crate::eip712::{self, Field, Keccak};
use crate::errors::{shown, Refusal, E_ARGS, E_ASSET, E_DECIMAL, E_PRICE_BAND, E_SIZE};
use crate::hl::check_usdc_amount;
use crate::limits::{check_value, Valued};
use crate::msgpack::{json_string, Value};
use crate::network::Network;
use crate::policy::{is_orderly_perp, Policy};

pub const DOMAIN_NAME: &str = "Orderly";
pub const DOMAIN_VERSION: &str = "1";
/// The off-chain domain's `verifyingContract` (`Registration`, `AddOrderlyKey`), EIP-55.
pub const OFF_CHAIN_VERIFYING_CONTRACT: &str = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
/// The Orderly Ledger, the on-chain domain's `verifyingContract` (`Withdraw`, `SettlePnl`), EIP-55.
pub const LEDGER_TESTNET: &str = "0x1826B75e2ef249173FC735149AE4B8e9ea10abff";
pub const LEDGER_MAINNET: &str = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203";

pub const REGISTRATION_TYPE: &str =
    "Registration(string brokerId,uint256 chainId,uint64 timestamp,uint256 registrationNonce)";
pub const ADD_ORDERLY_KEY_TYPE: &str = "AddOrderlyKey(string brokerId,uint256 chainId,string orderlyKey,string scope,uint64 timestamp,uint64 expiration)";
pub const WITHDRAW_TYPE: &str = "Withdraw(string brokerId,uint256 chainId,address receiver,string token,uint256 amount,uint64 withdrawNonce,uint64 timestamp)";
pub const SETTLE_PNL_TYPE: &str =
    "SettlePnl(string brokerId,uint256 chainId,uint64 settleNonce,uint64 timestamp)";

/// The scope of the desk's orderly key: reading and trading, nothing else.
pub const KEY_SCOPE: &str = "read,trading";
/// Orderly keeps an orderly key for at most 365 days.
pub const MAX_KEY_LIFETIME_MS: u64 = 365 * 86_400_000;
/// Orderly accepts a signed request for 300 s after its timestamp.
pub const REQUEST_TTL_MS: u64 = 300_000;
/// How far past the block time a request timestamp may be. The engine stamps a request before it
/// sends the transaction, so its timestamp is normally behind the block's; a few seconds cover
/// clock skew. Every second allowed here is a second the signed request (public on chain once
/// signed) stays valid at Orderly past the 300 s after the block.
pub const MAX_AHEAD_MS: u64 = 5_000;
/// The token every withdrawal moves.
pub const TOKEN: &str = "USDC";
/// Orderly takes a `client_order_id` of up to 36 characters.
pub const CLIENT_ORDER_ID_MAX_LEN: usize = 36;

/// The `client_order_id` of the order signed with `request_id`: `g<request_id>`, at most 21
/// characters of `[a-z0-9]`. The contract always sets it and never takes the caller's, so every
/// order the contract signs carries an id no other signed order has. Orderly refuses a
/// `client_order_id` that is already open, so a resting order's signed request cannot be posted a
/// second time while the order rests; once it filled or was cancelled it can (see `order`).
pub fn client_order_id(request_id: u64) -> String {
    format!("g{request_id}")
}

/// The `kind` of the WebSocket login.
pub const WS_AUTH: &str = "ws_auth";

/// The Ledger of `network`.
pub const fn ledger(network: Network) -> &'static str {
    match network {
        Network::Mainnet => LEDGER_MAINNET,
        Network::Testnet => LEDGER_TESTNET,
    }
}

/// The 20 bytes of a `0x` address constant.
fn address_bytes(s: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    // The constants are valid; a test checks each one.
    let _ = hex::decode_to_slice(&s[2..], &mut out);
    out
}

/// The address in EIP-55 mixed case, as Orderly's examples and the vectors write `userAddress` and
/// `receiver`.
pub fn checksum_address(keccak: Keccak, address: &[u8; 20]) -> String {
    let lower = hex::encode(address);
    let hash = keccak(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        out.push(if nibble >= 8 {
            c.to_ascii_uppercase()
        } else {
            c
        });
    }
    out
}

/// The desk's Orderly account id: keccak256(abi.encode(address owner, keccak256(utf8(brokerId)))).
/// One EVM address has one account per broker, known before registration.
pub fn account_id(keccak: Keccak, owner: &[u8; 20], broker_id: &str) -> [u8; 32] {
    let mut buf = [0u8; 64];
    buf[12..32].copy_from_slice(owner);
    buf[32..].copy_from_slice(&keccak(broker_id.as_bytes()));
    keccak(&buf)
}

/// The desk's orderly key: `ed25519:` and the base58 of its Ed25519 MPC key (its Solana authority).
pub fn orderly_key(authority: &[u8; 32]) -> String {
    format!("ed25519:{}", bs58::encode(authority).into_string())
}

/// The broker every message names, from `OrderlyConfig`, which `new` checked against the network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Broker<'a> {
    pub network: Network,
    pub broker_id: &'a str,
    pub chain_id: u64,
}

// --- EIP-712 ---

/// An EIP-712 message for the desk's EVM key. Broker id and chain id come from the [`Broker`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    /// Registers the desk's address with the broker; the nonce comes from the public
    /// `GET /v1/registration_nonce` (valid 2 minutes, single use).
    Registration {
        timestamp: u64,
        registration_nonce: u64,
    },
    /// Adds the desk's Ed25519 key as its orderly key, scope [`KEY_SCOPE`].
    AddOrderlyKey {
        orderly_key: String,
        timestamp: u64,
        expiration: u64,
    },
    /// Withdraws `amount_e6` raw USDC to `receiver`, the desk's own address.
    Withdraw {
        receiver: [u8; 20],
        amount_e6: u64,
        withdraw_nonce: u64,
        timestamp: u64,
    },
    /// Settles the account's realised PnL, which every withdrawal needs first.
    SettlePnl { settle_nonce: u64, timestamp: u64 },
}

impl Message {
    /// `Registration` at `block_ms` with the nonce Orderly gave: decimal digits without a leading
    /// zero that fit 64 bits (`E_ARGS`), so the string signed is the string Orderly sent.
    pub fn registration(registration_nonce: &str, block_ms: u64) -> Result<Self, Refusal> {
        let canonical = !registration_nonce.is_empty()
            && registration_nonce.bytes().all(|b| b.is_ascii_digit())
            && (registration_nonce == "0" || !registration_nonce.starts_with('0'));
        let nonce = canonical
            .then(|| registration_nonce.parse::<u64>().ok())
            .flatten()
            .ok_or_else(|| {
                Refusal::new(
                    E_ARGS,
                    format!(
                        "registration_nonce {} is not the decimal digits GET /v1/registration_nonce \
                         returns (no leading zero, at most 2^64 − 1)",
                        shown(registration_nonce)
                    ),
                )
            })?;
        Ok(Message::Registration {
            timestamp: block_ms,
            registration_nonce: nonce,
        })
    }

    /// `AddOrderlyKey` of the desk's own key (`authority`), scope [`KEY_SCOPE`], at `block_ms`; the
    /// expiration after the block time and at most [`MAX_KEY_LIFETIME_MS`] later (`E_ARGS`).
    pub fn add_orderly_key(
        authority: &[u8; 32],
        expiration_ms: u64,
        block_ms: u64,
    ) -> Result<Self, Refusal> {
        if expiration_ms <= block_ms {
            return Err(Refusal::new(
                E_ARGS,
                format!("expiration_ms {expiration_ms} is not after the block time {block_ms}"),
            ));
        }
        if expiration_ms - block_ms > MAX_KEY_LIFETIME_MS {
            return Err(Refusal::new(
                E_ARGS,
                format!(
                    "expiration_ms {expiration_ms} is more than 365 days after the block time \
                     {block_ms}; Orderly keeps a key at most that long"
                ),
            ));
        }
        Ok(Message::AddOrderlyKey {
            orderly_key: orderly_key(authority),
            timestamp: block_ms,
            expiration: expiration_ms,
        })
    }

    /// `Withdraw` of `amount` USDC to `receiver`: a canonical decimal of at most 6 decimals
    /// (`E_DECIMAL`), not zero (`E_SIZE`).
    pub fn withdraw(
        receiver: [u8; 20],
        amount: &str,
        withdraw_nonce: u64,
        timestamp: u64,
    ) -> Result<Self, Refusal> {
        let amount_e6 = usdc_e6(amount)?;
        Ok(Message::Withdraw {
            receiver,
            amount_e6,
            withdraw_nonce,
            timestamp,
        })
    }

    /// The SignedAction's `kind`: the primary type.
    pub const fn kind(&self) -> &'static str {
        match self {
            Message::Registration { .. } => "Registration",
            Message::AddOrderlyKey { .. } => "AddOrderlyKey",
            Message::Withdraw { .. } => "Withdraw",
            Message::SettlePnl { .. } => "SettlePnl",
        }
    }

    pub const fn type_string(&self) -> &'static str {
        match self {
            Message::Registration { .. } => REGISTRATION_TYPE,
            Message::AddOrderlyKey { .. } => ADD_ORDERLY_KEY_TYPE,
            Message::Withdraw { .. } => WITHDRAW_TYPE,
            Message::SettlePnl { .. } => SETTLE_PNL_TYPE,
        }
    }

    pub const fn timestamp(&self) -> u64 {
        match self {
            Message::Registration { timestamp, .. }
            | Message::AddOrderlyKey { timestamp, .. }
            | Message::Withdraw { timestamp, .. }
            | Message::SettlePnl { timestamp, .. } => *timestamp,
        }
    }

    /// The domain's `verifyingContract`: the off-chain one or the Ledger.
    pub const fn verifying_contract(&self, network: Network) -> &'static str {
        match self {
            Message::Registration { .. } | Message::AddOrderlyKey { .. } => {
                OFF_CHAIN_VERIFYING_CONTRACT
            }
            Message::Withdraw { .. } | Message::SettlePnl { .. } => ledger(network),
        }
    }

    pub fn domain_separator(&self, keccak: Keccak, broker: &Broker) -> [u8; 32] {
        eip712::domain_separator(
            keccak,
            DOMAIN_NAME,
            DOMAIN_VERSION,
            broker.chain_id,
            address_bytes(self.verifying_contract(broker.network)),
        )
    }

    pub fn struct_hash(&self, keccak: Keccak, broker: &Broker) -> [u8; 32] {
        let b = Field::Str(broker.broker_id);
        let c = Field::Uint(broker.chain_id);
        let fields = match self {
            Message::Registration {
                timestamp,
                registration_nonce,
            } => vec![
                b,
                c,
                Field::Uint(*timestamp),
                Field::Uint(*registration_nonce),
            ],
            Message::AddOrderlyKey {
                orderly_key,
                timestamp,
                expiration,
            } => vec![
                b,
                c,
                Field::Str(orderly_key),
                Field::Str(KEY_SCOPE),
                Field::Uint(*timestamp),
                Field::Uint(*expiration),
            ],
            Message::Withdraw {
                receiver,
                amount_e6,
                withdraw_nonce,
                timestamp,
            } => vec![
                b,
                c,
                Field::Address(*receiver),
                Field::Str(TOKEN),
                Field::Uint(*amount_e6),
                Field::Uint(*withdraw_nonce),
                Field::Uint(*timestamp),
            ],
            Message::SettlePnl {
                settle_nonce,
                timestamp,
            } => vec![b, c, Field::Uint(*settle_nonce), Field::Uint(*timestamp)],
        };
        eip712::hash_struct(keccak, self.type_string(), &fields)
    }

    /// The 32 bytes the desk's EVM key signs.
    pub fn digest(&self, keccak: Keccak, broker: &Broker) -> [u8; 32] {
        eip712::digest(
            keccak,
            &self.domain_separator(keccak, broker),
            &self.struct_hash(keccak, broker),
        )
    }

    /// The message as Orderly's JSON carries it, fields in the type's order.
    pub fn json(&self, keccak: Keccak, broker: &Broker) -> Value {
        let mut entries = vec![
            ("brokerId", Value::str(broker.broker_id)),
            ("chainId", Value::UInt(broker.chain_id)),
        ];
        match self {
            Message::Registration {
                timestamp,
                registration_nonce,
            } => entries.extend([
                ("timestamp", Value::UInt(*timestamp)),
                (
                    "registrationNonce",
                    Value::str(registration_nonce.to_string()),
                ),
            ]),
            Message::AddOrderlyKey {
                orderly_key,
                timestamp,
                expiration,
            } => entries.extend([
                ("orderlyKey", Value::str(orderly_key.as_str())),
                ("scope", Value::str(KEY_SCOPE)),
                ("timestamp", Value::UInt(*timestamp)),
                ("expiration", Value::UInt(*expiration)),
            ]),
            Message::Withdraw {
                receiver,
                amount_e6,
                withdraw_nonce,
                timestamp,
            } => entries.extend([
                ("receiver", Value::str(checksum_address(keccak, receiver))),
                ("token", Value::str(TOKEN)),
                ("amount", Value::str(amount_e6.to_string())),
                ("withdrawNonce", Value::UInt(*withdraw_nonce)),
                ("timestamp", Value::UInt(*timestamp)),
            ]),
            Message::SettlePnl {
                settle_nonce,
                timestamp,
            } => entries.extend([
                ("settleNonce", Value::UInt(*settle_nonce)),
                ("timestamp", Value::UInt(*timestamp)),
            ]),
        }
        Value::map(entries)
    }

    /// The SignedAction's payload: `{message, userAddress}`, the desk's address in EIP-55. The
    /// relayer posts `{message, signature, userAddress}`.
    pub fn payload(&self, keccak: Keccak, broker: &Broker, desk_evm: &[u8; 20]) -> Value {
        Value::map([
            ("message", self.json(keccak, broker)),
            (
                "userAddress",
                Value::str(checksum_address(keccak, desk_evm)),
            ),
        ])
    }
}

/// A USDC amount in raw units (6 decimals): canonical with at most 6 decimals (`E_DECIMAL`), not
/// zero (`E_SIZE`), at most 2^64 − 1 units (`E_SIZE`).
pub fn usdc_e6(amount: &str) -> Result<u64, Refusal> {
    let e8 = check_usdc_amount(amount)?;
    u64::try_from(e8 / 100)
        .map_err(|_| Refusal::new(E_SIZE, format!("amount {} is too large", shown(amount))))
}

/// An EIP-712 signature as Orderly takes it: `0x` and 65 bytes of hex (either case), r ‖ s ‖ v
/// with v 27 or 28 (`E_ARGS`).
pub fn parse_signature(s: &str) -> Result<[u8; 65], Refusal> {
    let mut sig = [0u8; 65];
    let ok = s.len() == 132
        && s.starts_with("0x")
        && hex::decode_to_slice(&s[2..], &mut sig).is_ok()
        && (sig[64] == 27 || sig[64] == 28);
    if ok {
        Ok(sig)
    } else {
        Err(Refusal::new(
            E_ARGS,
            format!(
                "eip712_signature {} is not 0x and 65 bytes of hex ending in v 27 or 28",
                shown(s)
            ),
        ))
    }
}

// --- REST ---

/// `orderly_request`'s `req` (docs/interfaces.md §1.3). `kind` picks the request; every other field
/// either belongs to that kind or must be left out (`null`), and `reduce_only` true only on an
/// order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderlyRequest {
    pub kind: String,
    #[serde(default)]
    pub symbol: Option<String>,
    /// `BUY` or `SELL`.
    #[serde(default)]
    pub side: Option<String>,
    /// `IOC`, `LIMIT` or `MARKET` (refused: no price limit).
    #[serde(default)]
    pub order_type: Option<String>,
    /// Canonical decimal.
    #[serde(default)]
    pub price: Option<String>,
    /// Canonical decimal, base units.
    #[serde(default)]
    pub quantity: Option<String>,
    #[serde(default)]
    pub reduce_only: bool,
    /// Must be absent or null: the contract sets every order's `client_order_id` itself
    /// ([`client_order_id`]), so no caller can pick one.
    #[serde(default)]
    pub client_order_id: Option<String>,
    #[serde(default)]
    pub order_id: Option<u64>,
    /// The request's `orderly-timestamp`, ms.
    pub timestamp_ms: u64,
    /// withdraw_request: USDC, canonical decimal (the amount `orderly_withdraw` signed).
    #[serde(default)]
    pub amount: Option<String>,
    /// settle_pnl / withdraw_request: the nonce the EIP-712 message signed.
    #[serde(default)]
    pub nonce: Option<u64>,
    /// settle_pnl / withdraw_request: the EIP-712 message's timestamp.
    #[serde(default)]
    pub signed_at_ms: Option<u64>,
    /// settle_pnl / withdraw_request: the signature `orderly_settle_pnl` / `orderly_withdraw`
    /// returned, `0x` + r ‖ s ‖ v.
    #[serde(default)]
    pub eip712_signature: Option<String>,
    /// funding_fee_history: the window (ms) and the page.
    #[serde(default)]
    pub start_t: Option<u64>,
    #[serde(default)]
    pub end_t: Option<u64>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub size: Option<u32>,
}

/// The request kinds and the fields each takes besides `kind` and `timestamp_ms`.
const KINDS: [(&str, &[&str]); 13] = [
    (
        "order",
        &[
            "symbol",
            "side",
            "order_type",
            "price",
            "quantity",
            "reduce_only",
        ],
    ),
    ("cancel", &["symbol", "order_id"]),
    ("cancel_all", &["symbol"]),
    ("receiver_address", &[]),
    ("settle_nonce", &[]),
    ("withdraw_nonce", &[]),
    ("settle_pnl", &["nonce", "signed_at_ms", "eip712_signature"]),
    (
        "withdraw_request",
        &["amount", "nonce", "signed_at_ms", "eip712_signature"],
    ),
    ("referral_bind", &[]),
    (
        "funding_fee_history",
        &["symbol", "start_t", "end_t", "page", "size"],
    ),
    ("positions", &[]),
    ("holding", &[]),
    ("ip_restriction", &[]),
];

impl OrderlyRequest {
    /// The fields set, by name: `Some`, and `reduce_only` when true.
    fn present(&self) -> Vec<&'static str> {
        let set = [
            ("symbol", self.symbol.is_some()),
            ("side", self.side.is_some()),
            ("order_type", self.order_type.is_some()),
            ("price", self.price.is_some()),
            ("quantity", self.quantity.is_some()),
            ("reduce_only", self.reduce_only),
            ("client_order_id", self.client_order_id.is_some()),
            ("order_id", self.order_id.is_some()),
            ("amount", self.amount.is_some()),
            ("nonce", self.nonce.is_some()),
            ("signed_at_ms", self.signed_at_ms.is_some()),
            ("eip712_signature", self.eip712_signature.is_some()),
            ("start_t", self.start_t.is_some()),
            ("end_t", self.end_t.is_some()),
            ("page", self.page.is_some()),
            ("size", self.size.is_some()),
        ];
        set.iter().filter(|(_, on)| *on).map(|(f, _)| *f).collect()
    }
}

/// A REST call (or the WebSocket login) ready for the desk's Ed25519 key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signable {
    pub kind: &'static str,
    /// `GET`, `POST` or `DELETE`; empty for the WebSocket login.
    pub method: &'static str,
    /// With its query string, which is signed too.
    pub path: String,
    /// The exact JSON text sent; empty for GET and DELETE.
    pub body: String,
    pub timestamp: u64,
    /// A paused desk may send it: reads, cancels, reduce-only orders and the WebSocket login.
    pub reduces_risk: bool,
    /// The order it places, as it was checked.
    pub order: Option<OrderlyOrder>,
    /// `withdraw_request`: the USDC it moves, canonical decimal.
    pub amount: Option<String>,
    /// `settle_pnl` / `withdraw_request`: the digest of the EIP-712 message the body embeds and the
    /// signature passed for it, which must recover to the desk's address before the request is
    /// signed.
    pub eip712: Option<([u8; 32], [u8; 65])>,
}

impl Signable {
    /// What the key signs: timestamp + METHOD + path + body, no separators.
    ///
    /// The same Ed25519 key (the desk's Solana authority) signs these and Solana messages, so no
    /// payload of one kind may read as the other. Every Orderly payload starts with the
    /// timestamp's 13 ASCII digits ([`check_timestamp`] keeps it within minutes of the block
    /// time, a 13-digit ms count until the year 2286), so its first byte is 0x31 to 0x39. A Solana
    /// message the contract signs starts with its signer count, 1 or 2, or the version 0 prefix
    /// 0x80 (`sol_sign`, `sol_sign_rescue`, `sol_sign_register`): never an ASCII digit.
    pub fn message(&self) -> String {
        format!(
            "{}{}{}{}",
            self.timestamp, self.method, self.path, self.body
        )
    }

    /// The SignedAction's payload: `{method, path, body, timestamp, message}`.
    pub fn payload(&self) -> Value {
        Value::map([
            ("method", Value::str(self.method)),
            ("path", Value::str(self.path.as_str())),
            ("body", Value::str(self.body.as_str())),
            ("timestamp", Value::UInt(self.timestamp)),
            ("message", Value::str(self.message())),
        ])
    }
}

/// An order that passed the policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderlyOrder {
    pub symbol: String,
    pub buy: bool,
    /// The caller's canonical strings, as the body carries them.
    pub price: String,
    pub quantity: String,
    pub px_e8: u128,
    pub sz_e8: u128,
    pub reduce_only: bool,
    pub valued: Valued,
}

/// What a request is checked against.
pub struct Context<'a> {
    pub keccak: Keccak,
    pub broker: Broker<'a>,
    pub policy: &'a Policy,
    pub desk_evm: [u8; 20],
    /// `treasury.referral_codes.orderly`: the only code `referral_bind` can carry.
    pub referral_code: Option<&'a str>,
    pub block_ms: u64,
    /// The `request_id` the signature of this request gets; an order's `client_order_id` is
    /// [`client_order_id`] of it.
    pub request_id: u64,
    /// The oracle price of a base symbol (`ETH` for `PERP_ETH_USDC`) if it is fresh.
    pub reference: &'a dyn Fn(&str) -> Option<u128>,
    /// The desk's orderly key, `ed25519:<base58>` ([`orderly_key`] of its Solana authority).
    pub orderly_key: &'a str,
    /// The relayer IPs the owner set with `set_orderly_ips`, if any: what `ip_restriction` applies.
    pub orderly_ips: Option<&'a [String]>,
    /// Whether the contract signed an `ip_restriction` for the current list (`set_orderly_ips`
    /// clears it): what a mainnet order that is not reduce-only waits for.
    pub ips_applied: bool,
}

/// The base asset of `PERP_<BASE>_USDC`: the symbol prices and `policy.unpriced` use (`ETH`).
pub fn base_of(symbol: &str) -> &str {
    symbol
        .strip_prefix("PERP_")
        .and_then(|rest| rest.strip_suffix("_USDC"))
        .unwrap_or(symbol)
}

/// `timestamp` (ms) is inside Orderly's window at `block_ms`: at most [`REQUEST_TTL_MS`] before it
/// and [`MAX_AHEAD_MS`] after it (`E_ARGS`).
pub fn check_timestamp(field: &str, timestamp: u64, block_ms: u64) -> Result<(), Refusal> {
    if timestamp.saturating_add(REQUEST_TTL_MS) < block_ms {
        return Err(Refusal::new(
            E_ARGS,
            format!(
                "{field} {timestamp} is more than 300 s before the block time {block_ms}; Orderly \
                 would refuse it"
            ),
        ));
    }
    if timestamp > block_ms.saturating_add(MAX_AHEAD_MS) {
        return Err(Refusal::new(
            E_ARGS,
            format!(
                "{field} {timestamp} is more than {} s after the block time {block_ms}",
                MAX_AHEAD_MS / 1000
            ),
        ));
    }
    Ok(())
}

/// The WebSocket login: the timestamp alone, in decimal (method, path and body blank), within the
/// request window at `block_ms`.
///
/// Accepted risk: the signed login is public once signed (the `SignedAction` result and the MPC's
/// answer are on chain) and the account id and orderly key are in `get_desk`, so anyone can open
/// the desk's private stream with it until Orderly's window closes, and read the account's
/// positions, balances and order events. It grants no trading. The signed reads of
/// [`build_request`] are replayable the same way, with the same read-only exposure.
pub fn ws_auth(timestamp: u64, block_ms: u64) -> Result<Signable, Refusal> {
    check_timestamp("timestamp", timestamp, block_ms)?;
    Ok(Signable {
        kind: WS_AUTH,
        method: "",
        path: String::new(),
        body: String::new(),
        timestamp,
        reduces_risk: true,
        order: None,
        amount: None,
        eip712: None,
    })
}

/// A perp symbol in Orderly's form (`E_ARGS`), for the requests that put one in a query string.
fn check_symbol_form(symbol: &str) -> Result<(), Refusal> {
    if is_orderly_perp(symbol) {
        Ok(())
    } else {
        Err(Refusal::new(
            E_ARGS,
            format!(
                "symbol {} is not PERP_<BASE>_USDC with BASE of A-Z and 0-9",
                shown(symbol)
            ),
        ))
    }
}

/// The body of `POST /v1/order`, keys in Gimbal's order: symbol, client_order_id (when set),
/// order_type, order_price (not for MARKET), order_quantity, side, reduce_only (only when true).
/// Prices and quantities are their canonical digits written as bare JSON numbers.
pub fn order_body(
    symbol: &str,
    client_order_id: Option<&str>,
    order_type: &str,
    price: Option<&str>,
    quantity: &str,
    side: &str,
    reduce_only: bool,
) -> String {
    let mut body = format!("{{\"symbol\":{}", json_string(symbol));
    if let Some(id) = client_order_id {
        body.push_str(&format!(",\"client_order_id\":{}", json_string(id)));
    }
    body.push_str(&format!(",\"order_type\":{}", json_string(order_type)));
    if let Some(price) = price {
        body.push_str(&format!(",\"order_price\":{price}"));
    }
    body.push_str(&format!(
        ",\"order_quantity\":{quantity},\"side\":{}",
        json_string(side)
    ));
    if reduce_only {
        body.push_str(",\"reduce_only\":true");
    }
    body.push('}');
    body
}

/// The body of `POST /v1/settle_pnl` and `POST /v1/withdraw_request`: the EIP-712 message, its
/// signature (lowercase hex), the desk's address and the Ledger, both EIP-55.
pub fn signed_message_body(
    keccak: Keccak,
    broker: &Broker,
    message: &Message,
    signature: &[u8; 65],
    desk_evm: &[u8; 20],
) -> String {
    format!(
        "{{\"message\":{},\"signature\":{},\"userAddress\":{},\"verifyingContract\":{}}}",
        message.json(keccak, broker).to_json(),
        json_string(&format!("0x{}", hex::encode(signature))),
        json_string(&checksum_address(keccak, desk_evm)),
        json_string(message.verifying_contract(broker.network)),
    )
}

/// Builds and checks one `orderly_request`, in this order: the timestamp inside Orderly's window
/// (`E_ARGS`); a known kind, only the fields that kind takes and every field it needs (`E_ARGS`);
/// then per kind:
///
/// - `order`: a symbol of the policy (`E_ASSET`), side `BUY`/`SELL` and type `IOC`/`LIMIT`
///   (`E_ARGS`; `MARKET` has no price limit, `E_PRICE_BAND`), canonical price above zero and
///   quantity (`E_DECIMAL`), then
///   [`check_value`] for the base symbol at its reference price (`E_SIZE`, `E_ORACLE_STALE`,
///   `E_PRICE_BAND`); `POST /v1/order` with the contract's `client_order_id` (a caller's is
///   `E_ARGS`);
/// - `cancel`: `DELETE /v1/order?order_id=<id>&symbol=<symbol>`; `cancel_all`:
///   `DELETE /v1/orders?symbol=<symbol>`; the symbol in Orderly's form (`E_ARGS`) but not
///   necessarily still in the policy, so a dropped market can be cancelled;
/// - `receiver_address` (`GET /v1/client/asset/receiver_address?chain_id=<chain>&token=USDC`),
///   `settle_nonce`, `withdraw_nonce`, `funding_fee_history` (`GET /v1/funding_fee/history` with
///   `symbol`, `start_t`, `end_t`, `page`, `size` in that order, each only when set), `positions`
///   (`GET /v1/positions`) and `holding` (`GET /v1/client/holding`): reads. The private stream
///   pushes no snapshot on subscribe, so the engine reads positions and holdings once per session.
///   A signed read is replayable inside Orderly's window, a read-only exposure (see [`ws_auth`]);
/// - `settle_pnl` / `withdraw_request`: `POST /v1/settle_pnl` / `POST /v1/withdraw_request` with
///   the EIP-712 message rebuilt from the typed fields (receiver the desk, token USDC) and the
///   signature passed (`E_ARGS` if malformed; the caller checks it recovers to the desk);
/// - `referral_bind`: `POST /v1/referral/bind {"referral_code"}` with the configured code only
///   (`E_ARGS` when none is configured);
/// - `ip_restriction`: `POST /v1/client/set_orderly_key_ip_restriction {"orderly_key",
///   "ip_restriction_list"}` with the desk's orderly key and the owner's IP list joined by commas
///   (`E_ARGS` when the owner set none). It only narrows where the key works, so it passes a
///   paused desk. This is the mainnet answer to the order replay ([`order`]): a copy posted from
///   any other address is refused.
pub fn build_request(ctx: &Context, req: &OrderlyRequest) -> Result<Signable, Refusal> {
    check_timestamp("timestamp_ms", req.timestamp_ms, ctx.block_ms)?;
    if req.client_order_id.is_some() {
        return Err(Refusal::new(
            E_ARGS,
            "client_order_id is the contract's (g<request_id>), never the caller's: leave it null",
        ));
    }
    let (kind, fields) = KINDS
        .iter()
        .find(|(k, _)| *k == req.kind)
        .copied()
        .ok_or_else(|| {
            Refusal::new(
                E_ARGS,
                format!("kind {} is not an Orderly request kind", shown(&req.kind)),
            )
        })?;
    for field in req.present() {
        if !fields.contains(&field) {
            return Err(Refusal::new(
                E_ARGS,
                format!("{field} has no place in a {kind} request"),
            ));
        }
    }
    let need = |field: &str, v: Option<&str>| -> Result<String, Refusal> {
        v.map(str::to_owned)
            .ok_or_else(|| Refusal::new(E_ARGS, format!("a {kind} request needs {field}")))
    };
    let need_u64 = |field: &str, v: Option<u64>| {
        v.ok_or_else(|| Refusal::new(E_ARGS, format!("a {kind} request needs {field}")))
    };
    let read = |path: String| Signable {
        kind,
        method: "GET",
        path,
        body: String::new(),
        timestamp: req.timestamp_ms,
        reduces_risk: true,
        order: None,
        amount: None,
        eip712: None,
    };
    let signed = match kind {
        "order" => return order(ctx, req),
        "cancel" => {
            let symbol = need("symbol", req.symbol.as_deref())?;
            let order_id = need_u64("order_id", req.order_id)?;
            check_symbol_form(&symbol)?;
            Signable {
                method: "DELETE",
                ..read(format!("/v1/order?order_id={order_id}&symbol={symbol}"))
            }
        }
        "cancel_all" => {
            let symbol = need("symbol", req.symbol.as_deref())?;
            check_symbol_form(&symbol)?;
            Signable {
                method: "DELETE",
                ..read(format!("/v1/orders?symbol={symbol}"))
            }
        }
        "receiver_address" => read(format!(
            "/v1/client/asset/receiver_address?chain_id={}&token={TOKEN}",
            ctx.broker.chain_id
        )),
        "settle_nonce" => read("/v1/settle_nonce".into()),
        "withdraw_nonce" => read("/v1/withdraw_nonce".into()),
        "positions" => read("/v1/positions".into()),
        "holding" => read("/v1/client/holding".into()),
        "funding_fee_history" => {
            if let Some(symbol) = &req.symbol {
                check_symbol_form(symbol)?;
            }
            let params: Vec<String> = [
                ("symbol", req.symbol.clone()),
                ("start_t", req.start_t.map(|v| v.to_string())),
                ("end_t", req.end_t.map(|v| v.to_string())),
                ("page", req.page.map(|v| v.to_string())),
                ("size", req.size.map(|v| v.to_string())),
            ]
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| format!("{k}={v}")))
            .collect();
            let query = if params.is_empty() {
                String::new()
            } else {
                format!("?{}", params.join("&"))
            };
            read(format!("/v1/funding_fee/history{query}"))
        }
        "settle_pnl" | "withdraw_request" => {
            let nonce = need_u64("nonce", req.nonce)?;
            let signed_at = need_u64("signed_at_ms", req.signed_at_ms)?;
            let signature =
                parse_signature(&need("eip712_signature", req.eip712_signature.as_deref())?)?;
            let (message, amount, path) = if kind == "settle_pnl" {
                let message = Message::SettlePnl {
                    settle_nonce: nonce,
                    timestamp: signed_at,
                };
                (message, None, "/v1/settle_pnl")
            } else {
                let amount = need("amount", req.amount.as_deref())?;
                let message = Message::withdraw(ctx.desk_evm, &amount, nonce, signed_at)?;
                (message, Some(amount), "/v1/withdraw_request")
            };
            Signable {
                method: "POST",
                body: signed_message_body(
                    ctx.keccak,
                    &ctx.broker,
                    &message,
                    &signature,
                    &ctx.desk_evm,
                ),
                reduces_risk: false,
                amount,
                eip712: Some((message.digest(ctx.keccak, &ctx.broker), signature)),
                ..read(path.into())
            }
        }
        "referral_bind" => {
            let code = ctx.referral_code.ok_or_else(|| {
                Refusal::new(
                    E_ARGS,
                    "no Orderly referral code is configured (treasury.referral_codes.orderly); \
                     setup skips referral_bind",
                )
            })?;
            Signable {
                method: "POST",
                body: format!("{{\"referral_code\":{}}}", json_string(code)),
                reduces_risk: false,
                ..read("/v1/referral/bind".into())
            }
        }
        "ip_restriction" => {
            let ips = ctx.orderly_ips.ok_or_else(|| {
                Refusal::new(
                    E_ARGS,
                    "the owner set no IP list for the orderly key (set_orderly_ips); setup skips \
                     ip_restriction",
                )
            })?;
            check_ip_list(ips)?;
            Signable {
                method: "POST",
                body: format!(
                    "{{\"orderly_key\":{},\"ip_restriction_list\":{}}}",
                    json_string(ctx.orderly_key),
                    json_string(&ips.join(","))
                ),
                ..read(IP_RESTRICTION_PATH.into())
            }
        }
        // KINDS lists exactly the kinds matched above.
        _ => return Err(Refusal::new(E_ARGS, format!("kind {kind} is not built"))),
    };
    Ok(signed)
}

/// Where `ip_restriction` posts.
pub const IP_RESTRICTION_PATH: &str = "/v1/client/set_orderly_key_ip_restriction";

/// The most addresses `set_orderly_ips` takes.
pub const MAX_ORDERLY_IPS: usize = 10;

/// An IP list for the orderly key: 1 to [`MAX_ORDERLY_IPS`] distinct addresses, each IPv4 in
/// dotted decimal without leading zeros or IPv6 in RFC 5952 form (lowercase, zeros compressed
/// once at the longest run), exactly as Rust's own formatting writes it (`E_ARGS`). No ranges:
/// the key is meant for the relayer's few addresses.
pub fn check_ip_list(ips: &[String]) -> Result<(), Refusal> {
    if ips.is_empty() || ips.len() > MAX_ORDERLY_IPS {
        return Err(Refusal::new(
            E_ARGS,
            format!("{} IP addresses; give 1 to {MAX_ORDERLY_IPS}", ips.len()),
        ));
    }
    for (i, ip) in ips.iter().enumerate() {
        let canonical = ip
            .parse::<std::net::IpAddr>()
            .is_ok_and(|parsed| parsed.to_string() == *ip);
        if !canonical {
            return Err(Refusal::new(
                E_ARGS,
                format!(
                    "ips[{i}] {} is not an IPv4 or IPv6 address in canonical form",
                    shown(ip)
                ),
            ));
        }
        if ips[..i].contains(ip) {
            return Err(Refusal::new(
                E_ARGS,
                format!("ips[{i}] {ip} is listed twice"),
            ));
        }
    }
    Ok(())
}

/// The `order` kind of [`build_request`].
///
/// RESIDUAL RISK, replay: the signed request is public on chain once `on_signed` returns, and
/// Orderly takes the same signed request again until 300 s after its timestamp. The contract's
/// `client_order_id` only stops a copy while the first order is open. Tested on testnet
/// (PR 30 round 2): a copy of a resting LIMIT was refused (HTTP 409, -1007 "The client_order_id
/// is repeated."), but after that LIMIT was cancelled the same copy was accepted as a new order,
/// and a copy of an IOC that had filled was accepted and filled again: the position doubled.
/// So anyone who reads the chain can post a signed order N times inside the window, each one
/// up to the policy's size, bounded only by the account's margin. A copy of a reduce-only order
/// can only shrink the position.
///
/// Decided (PR 30 round 2): an accepted, documented residual risk for now. The window is
/// Orderly's timestamp window, each copy is capped by the policy's size, and every copy shows
/// in the desk's own account: the engine reconciles positions after each order and closes any
/// excess reduce-only. For mainnet the request kind `ip_restriction` sets Orderly's key IP
/// restriction (`POST /v1/client/set_orderly_key_ip_restriction`) to the owner's list
/// (`set_orderly_ips`), so only the relayer can use the desk key.
fn order(ctx: &Context, req: &OrderlyRequest) -> Result<Signable, Refusal> {
    let need = |field: &str, v: &Option<String>| {
        v.clone()
            .ok_or_else(|| Refusal::new(E_ARGS, format!("an order request needs {field}")))
    };
    let symbol = need("symbol", &req.symbol)?;
    if !ctx.policy.orderly_symbols.contains(&symbol) {
        return Err(Refusal::new(
            E_ASSET,
            format!(
                "Orderly symbol {} is not in the desk's policy",
                shown(&symbol)
            ),
        ));
    }
    // The replay above: on mainnet an order that can grow a position waits for the owner's IP
    // list and for the contract to have signed `ip_restriction` of that list (C10 round 2: a list
    // that was only set changes nothing at Orderly), so a copy posted from elsewhere is refused.
    if ctx.broker.network == Network::Mainnet && !req.reduce_only && !ctx.ips_applied {
        return Err(Refusal::new(
            E_ARGS,
            "on mainnet an order that is not reduce-only needs the owner's relayer IP list \
             applied first (set_orderly_ips, then orderly_request kind ip_restriction for that \
             list): anyone could post a copy of the signed order again",
        ));
    }
    let side = need("side", &req.side)?;
    let buy = match side.as_str() {
        "BUY" => true,
        "SELL" => false,
        _ => {
            return Err(Refusal::new(
                E_ARGS,
                format!("side {} is not BUY or SELL", shown(&side)),
            ))
        }
    };
    let order_type = need("order_type", &req.order_type)?;
    match order_type.as_str() {
        "IOC" | "LIMIT" => {}
        "MARKET" => {
            return Err(Refusal::new(
                E_PRICE_BAND,
                format!(
                    "a MARKET order on {symbol} has no price limit to check against the band; send \
                     IOC with a price"
                ),
            ))
        }
        _ => {
            return Err(Refusal::new(
                E_ARGS,
                format!(
                    "order_type {} is not IOC, LIMIT or MARKET",
                    shown(&order_type)
                ),
            ))
        }
    }
    let price = need("price", &req.price)?;
    let quantity = need("quantity", &req.quantity)?;
    let decimal = |field: &str, s: &str| {
        parse_e8(s).map_err(|r| Refusal::new(r.code, format!("{field} {}", r.msg)))
    };
    let px_e8 = decimal("price", &price)?;
    if px_e8 == 0 {
        return Err(Refusal::new(E_DECIMAL, "price is zero"));
    }
    let sz_e8 = decimal("quantity", &quantity)?;
    let base = base_of(&symbol);
    let valued = check_value(ctx.policy, base, px_e8, sz_e8, (ctx.reference)(base))?;
    let body = order_body(
        &symbol,
        Some(&client_order_id(ctx.request_id)),
        &order_type,
        Some(&price),
        &quantity,
        &side,
        req.reduce_only,
    );
    Ok(Signable {
        kind: "order",
        method: "POST",
        path: "/v1/order".into(),
        body,
        timestamp: req.timestamp_ms,
        reduces_risk: req.reduce_only,
        order: Some(OrderlyOrder {
            symbol,
            buy,
            price,
            quantity,
            px_e8,
            sz_e8,
            reduce_only: req.reduce_only,
            valued,
        }),
        amount: None,
        eip712: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_constants_are_20_bytes() {
        for s in [OFF_CHAIN_VERIFYING_CONTRACT, LEDGER_TESTNET, LEDGER_MAINNET] {
            let mut out = [0u8; 20];
            assert_eq!(s.len(), 42);
            hex::decode_to_slice(&s[2..], &mut out).unwrap();
            assert_eq!(address_bytes(s), out);
        }
        assert_eq!(ledger(Network::Testnet), LEDGER_TESTNET);
        assert_eq!(ledger(Network::Mainnet), LEDGER_MAINNET);
    }

    #[test]
    fn every_kind_is_listed_once() {
        for (i, (kind, _)) in KINDS.iter().enumerate() {
            assert!(KINDS[i + 1..].iter().all(|(k, _)| k != kind), "{kind}");
        }
    }

    #[test]
    fn the_contracts_client_order_ids_fit_orderly() {
        assert_eq!(client_order_id(0), "g0");
        assert_eq!(client_order_id(42), "g42");
        let longest = client_order_id(u64::MAX);
        assert!(longest.len() <= CLIENT_ORDER_ID_MAX_LEN, "{longest}");
        assert!(longest
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    }

    #[test]
    fn base_symbols() {
        assert_eq!(base_of("PERP_ETH_USDC"), "ETH");
        assert_eq!(base_of("PERP_1000PEPE_USDC"), "1000PEPE");
        assert_eq!(base_of("ETH"), "ETH");
    }
}
