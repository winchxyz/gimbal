//! The two settings a frozen contract needs to follow its venues (docs/interfaces.md §1.2, §1.7):
//!
//! - `set_phoenix_accounts`: the desk owner replaces Phoenix's and Ember's own accounts (never a
//!   program id, never one of the desk's derived accounts), so a Phoenix that moves its global
//!   configuration or vault does not lock the desk's collateral in;
//! - `propose_oneclick_key` / `accept_oneclick_key`: a second 1Click quote-signing key besides
//!   the pinned one, for when 1Click rotates its key. Two parties: the treasury account proposes
//!   one key for every desk, and each desk owner accepts that exact proposal for the desk; it is
//!   used 24 h after the acceptance, and only while that proposal stands: every proposal is
//!   numbered, so proposing an older key again needs a new acceptance and a new day. The field
//!   rules, the fee bound and the pinned destinations stay as they are;
//! - `distrust_pinned_oneclick_key`: the desk owner stops the pinned key from signing the desk's
//!   quotes, for good (it only narrows: then only an accepted second key does).
//!
//! The record also holds whether the contract signed Orderly's `ip_restriction` for the desk's
//! current IP list, which a mainnet Orderly order that is not reduce-only needs.
//!
//! Why the key takes two parties: a quote signed by the accepted key passes every check the
//! pinned key's does, depositAddress included, and the contract cannot tell a deposit address
//! from any other address. A key only the desk owner set would let the owner sign quotes paying
//! anyone, past the protocol fee; one only the treasury set would let it pay itself out of every
//! desk. With both, neither can, and the operator can do neither.
//!
//! Each desk's record ([`DeskSettings`]) has a fixed size and is stored by `create_desk`, so the
//! setters add no storage and take exactly 1 yoctoNEAR (the owner's or treasury's wallet).

use gimbal_core::errors::{Refusal, E_ARGS, E_NOT_ALLOWED};
use gimbal_core::ids::check_base58_32;
use gimbal_core::oneclick::ONECLICK_PUBLIC_KEY_B58;
use gimbal_core::phoenix::PhoenixAccounts;
use gimbal_core::solana::{b58, Pubkey};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, near};

use crate::deposit::check_one_yocto;
use crate::events::{
    Event, OneclickKeyAccepted, OneclickKeyProposed, PhoenixAccountsSet,
    PinnedOneclickKeyDistrusted,
};
use crate::sol::desk_accounts;
use crate::{desk_ref, owner_desk, Gimbal, GimbalExt, OrFail};

/// How long after `accept_oneclick_key` the accepted key starts to sign quotes for the desk.
pub const ONECLICK_KEY_DELAY_MS: u64 = 24 * 3_600_000;

/// What each desk keeps besides its record, counters and money: fixed size (338 bytes).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeskSettings {
    /// Phoenix's and Ember's accounts, in [`PhoenixAccounts::entries`] order.
    pub phoenix: [Pubkey; 9],
    /// The second 1Click key the owner accepted; all zero for none.
    pub oneclick_key: Pubkey,
    /// Block time (ms) from which it signs quotes for the desk.
    pub oneclick_key_from_ms: u64,
    /// The number of the treasury's proposal the owner accepted ([`Gimbal::accepted_oneclick_key`]).
    pub oneclick_key_seq: u64,
    /// The owner distrusted 1Click's pinned key (`distrust_pinned_oneclick_key`); never cleared.
    pub pinned_key_distrusted: bool,
    /// The contract signed `ip_restriction` for the desk's current Orderly IP list;
    /// `set_orderly_ips` clears it.
    pub orderly_ips_applied: bool,
}

impl Default for DeskSettings {
    fn default() -> Self {
        Self {
            phoenix: PhoenixAccounts::PINNED.entries().map(|(_, k)| k),
            oneclick_key: [0; 32],
            oneclick_key_from_ms: 0,
            oneclick_key_seq: 0,
            pinned_key_distrusted: false,
            orderly_ips_applied: false,
        }
    }
}

impl DeskSettings {
    /// The Phoenix accounts as the core takes them.
    pub fn infra(&self) -> PhoenixAccounts {
        let [log_authority, global_configuration, perp_asset_map, withdraw_queue, global_vault, global_trader_index, active_trader_buffer, ember_state, ember_vault] =
            self.phoenix;
        PhoenixAccounts {
            log_authority,
            global_configuration,
            perp_asset_map,
            withdraw_queue,
            global_vault,
            global_trader_index,
            active_trader_buffer,
            ember_state,
            ember_vault,
        }
    }
}

/// `set_phoenix_accounts`'s argument and `get_desk_settings`'s view of them: base58, every field
/// named.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PhoenixAccountsJson {
    pub log_authority: String,
    pub global_configuration: String,
    pub perp_asset_map: String,
    pub withdraw_queue: String,
    pub global_vault: String,
    pub global_trader_index: String,
    pub active_trader_buffer: String,
    pub ember_state: String,
    pub ember_vault: String,
}

impl PhoenixAccountsJson {
    pub fn of(a: &PhoenixAccounts) -> Self {
        let [l, g, p, w, v, i, b, s, e] = a.entries().map(|(_, k)| b58(&k));
        Self {
            log_authority: l,
            global_configuration: g,
            perp_asset_map: p,
            withdraw_queue: w,
            global_vault: v,
            global_trader_index: i,
            active_trader_buffer: b,
            ember_state: s,
            ember_vault: e,
        }
    }

    /// The accounts, each a base58 32-byte key (`E_ARGS`).
    pub fn parse(&self) -> Result<PhoenixAccounts, Refusal> {
        let key = |name: &str, v: &str| check_base58_32(name, v);
        Ok(PhoenixAccounts {
            log_authority: key("log_authority", &self.log_authority)?,
            global_configuration: key("global_configuration", &self.global_configuration)?,
            perp_asset_map: key("perp_asset_map", &self.perp_asset_map)?,
            withdraw_queue: key("withdraw_queue", &self.withdraw_queue)?,
            global_vault: key("global_vault", &self.global_vault)?,
            global_trader_index: key("global_trader_index", &self.global_trader_index)?,
            active_trader_buffer: key("active_trader_buffer", &self.active_trader_buffer)?,
            ember_state: key("ember_state", &self.ember_state)?,
            ember_vault: key("ember_vault", &self.ember_vault)?,
        })
    }
}

/// `get_desk_settings`: the desk's Phoenix accounts and its second 1Click key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct DeskSettingsView {
    pub phoenix_accounts: PhoenixAccountsJson,
    /// The accepted second 1Click key, base58; `null` for none.
    pub oneclick_key: Option<String>,
    /// When it starts to sign quotes (ms); 0 for none.
    pub oneclick_key_from_ms: u64,
    /// Whether it signs quotes for the desk now: past `oneclick_key_from_ms` and still the
    /// treasury's proposal the owner accepted.
    pub oneclick_key_active: bool,
    /// Whether 1Click's pinned key signs quotes for the desk: false once the owner distrusted it.
    pub pinned_key_trusted: bool,
    /// Whether the contract signed `ip_restriction` for the desk's current Orderly IP list.
    pub orderly_ips_applied: bool,
}

/// A 1Click key argument: base58 of 32 bytes, not all zero and not the pinned key (`E_ARGS`).
pub fn check_oneclick_key(key: &str) -> Result<Pubkey, Refusal> {
    let k = check_base58_32("key", key)?;
    if k == [0; 32] {
        return Err(Refusal::new(E_ARGS, "key is all zero"));
    }
    if key == ONECLICK_PUBLIC_KEY_B58 {
        return Err(Refusal::new(
            E_ARGS,
            "key is 1Click's pinned key, which the desks trust until their owners distrust it",
        ));
    }
    Ok(k)
}

#[near]
impl Gimbal {
    /// Replaces the desk's Phoenix and Ember accounts ([`PhoenixAccounts::check`]: no program id,
    /// mint or Phoenix onboarding key, none of the desk's derived accounts, no two alike, the
    /// program-derived ones off the curve; `E_ARGS`). Owner only, exactly 1 yoctoNEAR
    /// (`E_NOT_ALLOWED`), also on a paused desk; the record is prepaid, so no storage is added.
    /// Event `phoenix_accounts_set`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_phoenix_accounts(&mut self, desk_id: String, accounts: PhoenixAccountsJson) {
        let desk = owner_desk(&self.desks, &desk_id, "set_phoenix_accounts");
        check_one_yocto("set_phoenix_accounts", env::attached_deposit()).or_fail();
        let infra = accounts.parse().or_fail();
        infra.check(&desk_accounts(desk).or_fail()).or_fail();
        let mut settings = self.settings_of(&desk_id);
        settings.phoenix = infra.entries().map(|(_, k)| k);
        self.desk_settings.insert(desk_id.clone(), settings);
        PhoenixAccountsSet {
            desk_id: &desk_id,
            accounts: &PhoenixAccountsJson::of(&infra),
        }
        .emit();
    }

    /// The treasury account (`config.treasury.near`) proposes a second 1Click quote-signing key
    /// for every desk, or withdraws the proposal with `null`. A desk uses it only after its owner
    /// accepted that exact proposal ([`Self::accept_oneclick_key`]); every call numbers a new
    /// proposal and ends every earlier acceptance, even one of the same key. Exactly 1 yoctoNEAR
    /// (`E_NOT_ALLOWED`); anyone else is `E_NOT_ALLOWED`; a key as [`check_oneclick_key`]
    /// (`E_ARGS`). Event `oneclick_key_proposed`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn propose_oneclick_key(&mut self, key: Option<String>) {
        let by = env::predecessor_account_id();
        if by != self.config.treasury.near {
            crate::fail(Refusal::new(
                E_NOT_ALLOWED,
                format!(
                    "only the treasury account {} proposes a 1Click key",
                    self.config.treasury.near
                ),
            ));
        }
        check_one_yocto("propose_oneclick_key", env::attached_deposit()).or_fail();
        self.oneclick_key_proposal = match &key {
            Some(k) => check_oneclick_key(k).or_fail(),
            None => [0; 32],
        };
        // C10 round 2: without the number, proposing K, then K2, then K again would bring back
        // every acceptance of K at once, past its day.
        self.oneclick_proposal_seq = self.oneclick_proposal_seq.saturating_add(1);
        OneclickKeyProposed {
            key: key.as_deref(),
        }
        .emit();
    }

    /// The desk owner accepts the treasury's proposed 1Click key for the desk, or clears the
    /// desk's accepted key with `null`. The key must be the current proposal (`E_ARGS`); it signs
    /// quotes for the desk from [`ONECLICK_KEY_DELAY_MS`] after this call, and only while that
    /// proposal stands (no newer `propose_oneclick_key`). Owner only, exactly 1 yoctoNEAR
    /// (`E_NOT_ALLOWED`); the record is prepaid. Event `oneclick_key_accepted`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn accept_oneclick_key(&mut self, desk_id: String, key: Option<String>) {
        owner_desk(&self.desks, &desk_id, "accept_oneclick_key");
        check_one_yocto("accept_oneclick_key", env::attached_deposit()).or_fail();
        let mut settings = self.settings_of(&desk_id);
        let from_ms = match &key {
            Some(k) => {
                let k = check_oneclick_key(k).or_fail();
                if k != self.oneclick_key_proposal {
                    crate::fail(Refusal::new(
                        E_ARGS,
                        "key is not the treasury's proposed 1Click key (oneclick_key_proposal)",
                    ));
                }
                settings.oneclick_key = k;
                settings.oneclick_key_seq = self.oneclick_proposal_seq;
                env::block_timestamp_ms().saturating_add(ONECLICK_KEY_DELAY_MS)
            }
            None => {
                settings.oneclick_key = [0; 32];
                settings.oneclick_key_seq = 0;
                0
            }
        };
        settings.oneclick_key_from_ms = from_ms;
        self.desk_settings.insert(desk_id.clone(), settings);
        OneclickKeyAccepted {
            desk_id: &desk_id,
            key: key.as_deref(),
            from_ms,
        }
        .emit();
    }

    /// The desk owner stops 1Click's pinned key from signing the desk's quotes, for good: from
    /// then on only a second key the owner accepted ([`Self::accept_oneclick_key`]) verifies them,
    /// for the rescues and `fund_venue` alike. For when the pinned key may have leaked; it only
    /// narrows what the contract accepts, and with no live second key no quote passes until one
    /// is. Owner only, exactly 1 yoctoNEAR (`E_NOT_ALLOWED`), also on a paused desk; the record is
    /// prepaid. Event `pinned_oneclick_key_distrusted`.
    #[payable]
    #[deny_unknown_arguments]
    pub fn distrust_pinned_oneclick_key(&mut self, desk_id: String) {
        owner_desk(&self.desks, &desk_id, "distrust_pinned_oneclick_key");
        check_one_yocto("distrust_pinned_oneclick_key", env::attached_deposit()).or_fail();
        let mut settings = self.settings_of(&desk_id);
        settings.pinned_key_distrusted = true;
        self.desk_settings.insert(desk_id.clone(), settings);
        PinnedOneclickKeyDistrusted { desk_id: &desk_id }.emit();
    }

    /// The desk's Phoenix accounts and second 1Click key, or `null` when there is no such desk.
    pub fn get_desk_settings(&self, desk_id: String) -> Option<DeskSettingsView> {
        self.desks.get(&desk_id)?;
        let s = self.settings_of(&desk_id);
        let now_ms = env::block_timestamp_ms();
        Some(DeskSettingsView {
            phoenix_accounts: PhoenixAccountsJson::of(&s.infra()),
            oneclick_key: (s.oneclick_key != [0; 32]).then(|| b58(&s.oneclick_key)),
            oneclick_key_from_ms: s.oneclick_key_from_ms,
            oneclick_key_active: self.accepted_oneclick_key(&desk_id, now_ms).is_some(),
            pinned_key_trusted: !s.pinned_key_distrusted,
            orderly_ips_applied: s.orderly_ips_applied,
        })
    }

    /// The treasury's proposed second 1Click key, base58; `null` for none.
    pub fn oneclick_key_proposal(&self) -> Option<String> {
        (self.oneclick_key_proposal != [0; 32]).then(|| b58(&self.oneclick_key_proposal))
    }
}

impl Gimbal {
    /// The desk's settings, or the defaults before `create_desk` stored them.
    pub fn settings_of(&self, desk_id: &str) -> DeskSettings {
        self.desk_settings.get(desk_id).copied().unwrap_or_default()
    }

    /// The second key quotes for the desk may be signed with at `now_ms`: the one its owner
    /// accepted, once its delay has passed, while the proposal the owner accepted is still the
    /// treasury's latest (same key, same number).
    pub fn accepted_oneclick_key(&self, desk_id: &str, now_ms: u64) -> Option<Pubkey> {
        let s = self.settings_of(desk_id);
        (s.oneclick_key != [0; 32]
            && s.oneclick_key == self.oneclick_key_proposal
            && s.oneclick_key_seq == self.oneclick_proposal_seq
            && now_ms >= s.oneclick_key_from_ms)
            .then_some(s.oneclick_key)
    }

    /// Whether 1Click's pinned key signs the desk's quotes: until its owner distrusted it.
    pub fn pinned_oneclick_key_trusted(&self, desk_id: &str) -> bool {
        !self.settings_of(desk_id).pinned_key_distrusted
    }

    /// The desk's Solana accounts with its Phoenix accounts ([`desk_accounts`] + settings).
    pub fn sol_desk(&self, desk_id: &str) -> gimbal_core::solana::SolDesk {
        let mut d = desk_accounts(desk_ref(&self.desks, desk_id)).or_fail();
        d.infra = self.settings_of(desk_id).infra();
        d
    }
}
