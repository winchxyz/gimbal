//! Money in and out on NEAR on the mocked chain: `ft_on_transfer` (owner principal, returns from
//! anyone else, full refunds), `fund_venue` with 1Click's own signed quotes of USDC on NEAR
//! (`core/tests/vectors/oneclick-live.json`), `withdraw_to_owner` with the performance fee, and
//! every callback with a failed transfer.

use super::hl::{at, VECTOR_DESK_EVM};
use super::sol::{outcome, vector_solana};
use super::*;
use crate::desk::Ledger;
use crate::money::{
    DeskMoney, PendingPayout, FT_TRANSFER_GAS, FUND_VENUE_GAS, FUND_VENUE_MIN_GAS,
    ON_FUND_VENUE_GAS, ON_PAYOUT_FEE_GAS, ON_PAYOUT_OWNER_GAS, OWN_WORK_GAS, STORAGE_DEPOSIT_GAS,
    USDC_STORAGE_DEPOSIT, WITHDRAW_GAS, WITHDRAW_MIN_GAS,
};
use crate::rescue::{DeskCounters, DEPOSIT_RING};
use gimbal_core::errors::{E_NO_DESK, E_QUOTE_FIELDS, E_QUOTE_SIGNATURE, E_RESCUE_CAP, E_SIZE};
use gimbal_core::fees::Payout;
use gimbal_core::network::{NEAR_USDC_MAINNET, NEAR_USDC_TESTNET};
use near_sdk::json_types::U128;

const USDC: u128 = 1_000_000;
/// 2026-10-31T15:30:00Z, 47 s after 1Click signed the live fund_venue quotes.
const NOW_MS: u64 = 1_793_460_600_000;
const ORDERLY_RECEIVER: &str = "0xc48b812bb43401392c037381aca934f4069c0517";
/// The account the recorded fund_venue quotes refund to (the vectors' `contractNear` key), which
/// these tests make the desk owner.
const QUOTE_OWNER: &str = "43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c";
const HL_QUOTE: &str = "fund_venue: USDC on NEAR (contract) to Hyperliquid";
const ORDERLY_QUOTE: &str = "fund_venue: USDC on NEAR (contract) to the pinned Orderly receiver";
const SOL_HL_QUOTE: &str = "rescue Phoenix -> Hyperliquid: Solana USDC to the desk EVM address";

fn usdc() -> AccountId {
    NEAR_USDC_TESTNET.parse().unwrap()
}

fn intents() -> AccountId {
    "intents.near".parse().unwrap()
}

fn quote_owner() -> AccountId {
    QUOTE_OWNER.parse().unwrap()
}

fn live() -> Value {
    serde_json::from_str(include_str!("../../core/tests/vectors/oneclick-live.json")).unwrap()
}

/// A recorded live quote and its signature, as the relayer passes them, and its deposit address.
fn quote(name: &str) -> (String, String, String) {
    let doc = live();
    let q = doc["quotes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["name"] == name)
        .unwrap_or_else(|| panic!("no quote {name}"))
        .clone();
    (
        q["canonical_json"].as_str().unwrap().to_owned(),
        q["signature"].as_str().unwrap().to_owned(),
        q["response"]["quote"]["depositAddress"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}

fn ledger(g: &Gimbal, desk_id: &str) -> Ledger {
    g.get_desk(desk_id.into()).unwrap().ledger
}

fn pending(g: &Gimbal) -> bool {
    g.money.get("alpha").unwrap().payout_pending
}

/// `ft_on_transfer` as the token `token` calls it for `sender`.
fn transfer_in(
    g: &mut Gimbal,
    token: AccountId,
    sender: AccountId,
    amount: u128,
    msg: &str,
) -> u128 {
    called_by(token);
    match g.ft_on_transfer(sender, U128(amount), msg.into()) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer answers at once"),
    }
}

fn deposit_alpha(g: &mut Gimbal, sender: AccountId, amount: u128) {
    assert_eq!(
        transfer_in(g, usdc(), sender, amount, r#"{"desk_id":"alpha"}"#),
        0
    );
}

/// A scheduled function call with what it carries and what it waits for.
#[derive(Debug)]
struct Call {
    to: AccountId,
    method: String,
    args: Value,
    deposit: NearToken,
    gas: Gas,
    weight: u64,
    after: Vec<u64>,
}

fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            let after = r.receipt_indices.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    gas_weight,
                    ..
                } => Some(Call {
                    to: to.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap(),
                    deposit: attached_deposit,
                    gas: prepaid_gas,
                    weight: gas_weight.0,
                    after: after.clone(),
                }),
                _ => None,
            })
        })
        .collect()
}

/// A callback run with the transfer it waited for landed (`true`) or failed.
fn settled(landed: bool) {
    callback(vec![if landed {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    }]);
}

/// The fund_venue quotes' desk: `alpha` of [`QUOTE_OWNER`] on the vectors' addresses, operator
/// `operator()`, the pinned Orderly receiver, `idle` USDC on NEAR. The flat transfer bound is
/// 0.6 USDC, which the recorded 20 USDC route to Hyperliquid (0.52) needs.
fn fund_desk(idle: u128) -> Gimbal {
    fund_desk_with(
        Policy {
            max_transfer_cost_flat_e6: 600_000,
            ..policy()
        },
        idle,
    )
}

fn fund_desk_with(policy: Policy, idle: u128) -> Gimbal {
    let mut g = testnet();
    let mut desk = Desk::new(
        quote_owner(),
        policy,
        VECTOR_DESK_EVM.into(),
        vector_solana(),
        "woofi_dex",
    );
    desk.operator = Some(operator());
    desk.orderly_receiver = Some(ORDERLY_RECEIVER.into());
    g.desks.insert("alpha".into(), desk);
    g.desk_counters
        .insert("alpha".into(), DeskCounters::default());
    g.money
        .insert("alpha".into(), DeskMoney::new(quote_owner()));
    if idle > 0 {
        deposit_alpha(&mut g, quote_owner(), idle);
    }
    g
}

fn fund(g: &mut Gimbal, who: AccountId, name: &str) -> Result<(), String> {
    at(who, NOW_MS, yocto(0));
    let (q, sig, _) = quote(name);
    outcome(|| {
        g.fund_venue("alpha".into(), q, sig, "margin in".into())
            .detach()
    })
}

fn counters(g: &Gimbal) -> DeskCounters {
    *g.desk_counters.get("alpha").unwrap()
}

// --- ft_on_transfer ---

#[test]
fn an_owner_deposit_is_principal() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    let l = ledger(&g, "alpha");
    assert_eq!((l.deposited, l.idle_usdc), (100 * USDC, 100 * USDC));
    assert_eq!((l.withdrawn, l.fees_paid, l.hwm), (0, 0, 0));
    assert_eq!(
        get_logs(),
        vec![event(
            "deposit",
            r#"{"desk_id":"alpha","sender":"alice","amount":"100000000","principal":true,"deposited_total":"100000000","idle_usdc":"100000000"}"#
        )]
    );
}

#[test]
fn a_return_from_another_sender_never_raises_deposited() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 50 * USDC);
    // 1Click delivering a payout leg, the operator, a stranger: idle only.
    for (sender, amount) in [(intents(), 7 * USDC), (operator(), USDC), (stranger(), 2)] {
        deposit_alpha(&mut g, sender, amount);
    }
    let l = ledger(&g, "alpha");
    assert_eq!(l.deposited, 50 * USDC);
    assert_eq!(l.idle_usdc, 58 * USDC + 2);
    assert_eq!(l.fees_paid, 0, "nothing is charged on money in");
    assert_eq!(
        get_logs(),
        vec![event(
            "deposit",
            r#"{"desk_id":"alpha","sender":"charlie","amount":"2","principal":false,"deposited_total":"50000000","idle_usdc":"58000002"}"#
        )]
    );
}

#[test]
fn an_unknown_desk_or_a_bad_msg_is_refunded_whole() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 10 * USDC);
    let before = ledger(&g, "alpha");
    for msg in [
        r#"{"desk_id":"beta"}"#,
        r#"{"desk_id":"ALPHA"}"#,
        "",
        "alpha",
        r#"{"desk_id":"alpha","extra":1}"#,
        r#"{"desk":"alpha"}"#,
        r#"{"desk_id":7}"#,
        r#"[{"desk_id":"alpha"}]"#,
    ] {
        assert_eq!(
            transfer_in(&mut g, usdc(), owner(), 3 * USDC, msg),
            3 * USDC,
            "{msg}"
        );
        assert_eq!(ledger(&g, "alpha"), before, "{msg}");
        let logs = get_logs();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(
            logs[0].starts_with("refunded 3000000 to alice: "),
            "{logs:?}"
        );
    }
}

#[test]
fn another_token_is_refunded_whole() {
    let mut g = with_desk();
    // On a testnet contract the mainnet USDC is another token, as is any other contract.
    for token in [
        NEAR_USDC_MAINNET.parse().unwrap(),
        "usdt.tether-token.near".parse().unwrap(),
        owner(),
        contract_id(),
    ] {
        assert_eq!(
            transfer_in(&mut g, token, owner(), 5 * USDC, r#"{"desk_id":"alpha"}"#),
            5 * USDC
        );
        assert!(
            get_logs()[0].contains("is not USDC on NEAR"),
            "{:?}",
            get_logs()
        );
    }
    assert_eq!(ledger(&g, "alpha"), Ledger::default());
}

#[test]
fn a_mainnet_contract_takes_mainnet_usdc() {
    called_by(contract_id());
    let mut g = Gimbal::new(
        Network::Mainnet,
        "v1.signer".parse().unwrap(),
        PriceSource::OutLayer {
            contract: "price-oracle.near".parse().unwrap(),
        },
        treasury(),
        fees(),
        OrderlyConfig {
            broker_id: "gimbal_dex".into(),
            chain_id: ARBITRUM_MAINNET,
        },
    );
    g.money.insert("alpha".into(), DeskMoney::new(owner()));
    g.desks.insert(
        "alpha".into(),
        Desk::new(owner(), policy(), EVM.into(), solana(), "gimbal_dex"),
    );
    let main: AccountId = NEAR_USDC_MAINNET.parse().unwrap();
    assert_eq!(g.usdc(), main);
    assert_eq!(
        transfer_in(&mut g, usdc(), owner(), USDC, r#"{"desk_id":"alpha"}"#),
        USDC,
        "testnet USDC on mainnet"
    );
    assert_eq!(
        transfer_in(&mut g, main, owner(), USDC, r#"{"desk_id":"alpha"}"#),
        0
    );
    assert_eq!(ledger(&g, "alpha").deposited, USDC);
}

#[test]
fn a_paused_desk_still_takes_deposits_and_adds_no_storage() {
    let mut g = with_desk();
    g.desks.get_mut("alpha").unwrap().paused = true;
    g.flush_desks();
    // One context for both: the mock counts storage from each testing_env!.
    called_by(usdc());
    let before = env::storage_usage();
    for sender in [owner(), intents()] {
        let _ = g.ft_on_transfer(sender, U128(USDC), r#"{"desk_id":"alpha"}"#.into());
    }
    g.flush_desks();
    assert_eq!(env::storage_usage(), before);
    assert_eq!(ledger(&g, "alpha").idle_usdc, 2 * USDC);
}

/// The desk's ledger is its own record, written by `create_desk` (the owner pays for it) and
/// shown by `get_desk` where the desk's JSON always had it.
#[test]
fn the_ledger_lives_beside_the_desk_record() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 3 * USDC);
    assert_eq!(g.desks.get("alpha").unwrap().ledger, Ledger::default());
    let view = serde_json::to_value(g.get_desk("alpha".into()).unwrap()).unwrap();
    assert_eq!(
        view["ledger"],
        json!({"deposited": 3_000_000, "withdrawn": 0, "fees_paid": 0, "hwm": 0, "idle_usdc": 3_000_000})
    );
    assert_eq!(g.money.get("alpha").unwrap().owner, owner());
}

// --- fund_venue ---

#[test]
fn fund_venue_pays_the_quotes_deposit_address_from_idle() {
    let mut g = fund_desk(30 * USDC);
    let (_, _, deposit) = quote(HL_QUOTE);
    fund(&mut g, operator(), HL_QUOTE).unwrap();
    assert_eq!(ledger(&g, "alpha").idle_usdc, 10 * USDC, "20 USDC left");
    assert_eq!(ledger(&g, "alpha").deposited, 30 * USDC);

    let c = calls();
    assert_eq!(c.len(), 4, "{c:?}");
    let deposit_id: AccountId = deposit.parse().unwrap();
    assert_eq!(
        (&c[0].to, c[0].method.as_str()),
        (&usdc(), "storage_deposit")
    );
    assert_eq!(
        c[0].args,
        json!({"account_id": deposit_id, "registration_only": true})
    );
    assert_eq!(
        (c[0].deposit, c[0].gas),
        (USDC_STORAGE_DEPOSIT, STORAGE_DEPOSIT_GAS)
    );
    assert_eq!(
        c[1].args,
        json!({"account_id": QUOTE_OWNER, "registration_only": true})
    );
    assert_eq!((&c[2].to, c[2].method.as_str()), (&usdc(), "ft_transfer"));
    assert_eq!(
        c[2].args,
        json!({"receiver_id": deposit, "amount": "20000000", "memo": "gimbal fund_venue alpha"})
    );
    assert_eq!((c[2].deposit, c[2].gas), (ONE_YOCTO, FT_TRANSFER_GAS));
    assert_eq!(
        c[2].after.len(),
        2,
        "the transfer waits for both registrations"
    );
    assert_eq!(
        (&c[3].to, c[3].method.as_str()),
        (&contract_id(), "on_fund_venue")
    );
    assert_eq!(c[3].args, json!({"desk_id": "alpha", "amount": "20000000"}));
    assert_eq!((c[3].gas, c[3].weight), (ON_FUND_VENUE_GAS, 0));
    assert_eq!(c[3].after.len(), 1);

    // The deposit address is in the ring and the cost in the budget; the amount is not capped.
    let k = counters(&g);
    assert!(k.paid(&env::sha256_array(deposit.as_bytes())));
    assert_eq!(k.rescue_spent_e8, 0);
    assert_eq!(k.rescue_cost_e8, 2_000_000_000 - 1_948_095_100);
    // No event, no fee.
    assert!(get_logs().is_empty());
    assert_eq!(ledger(&g, "alpha").fees_paid, 0);

    // Landed: true, the ledger stays.
    settled(true);
    assert!(g.on_fund_venue("alpha".into(), U128(20 * USDC)));
    assert_eq!(ledger(&g, "alpha").idle_usdc, 10 * USDC);
}

#[test]
fn a_failed_fund_venue_transfer_is_credited_back() {
    let mut g = fund_desk(20 * USDC);
    fund(&mut g, quote_owner(), HL_QUOTE).unwrap();
    assert_eq!(ledger(&g, "alpha").idle_usdc, 0);
    settled(false);
    assert!(!g.on_fund_venue("alpha".into(), U128(20 * USDC)));
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.idle_usdc, l.deposited, l.withdrawn),
        (20 * USDC, 20 * USDC, 0)
    );
    // The address stays paid: the engine asks for a fresh quote.
    let got = fund(&mut g, operator(), HL_QUOTE).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
}

#[test]
fn fund_venue_pays_the_pinned_orderly_receiver() {
    let mut g = fund_desk(10 * USDC);
    fund(&mut g, operator(), ORDERLY_QUOTE).unwrap();
    assert_eq!(ledger(&g, "alpha").idle_usdc, 0);
    let (_, _, deposit) = quote(ORDERLY_QUOTE);
    assert_eq!(calls()[2].args["receiver_id"], deposit);
    // Without the pinned receiver it is no desk address.
    let mut g = fund_desk(10 * USDC);
    g.desks.get_mut("alpha").unwrap().orderly_receiver = None;
    let got = fund(&mut g, operator(), ORDERLY_QUOTE).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert!(got.contains("is not a desk address"), "{got}");
    assert_eq!(ledger(&g, "alpha").idle_usdc, 10 * USDC);
}

/// A quote pays once: after its deposit address was paid the same quote is refused, with nothing
/// taken from the desk.
#[test]
fn a_replayed_fund_venue_quote_is_refused() {
    let mut g = fund_desk(50 * USDC);
    fund(&mut g, operator(), HL_QUOTE).unwrap();
    let after_first = (ledger(&g, "alpha"), counters(&g));
    for who in [operator(), quote_owner()] {
        let got = fund(&mut g, who, HL_QUOTE).unwrap_err();
        assert!(
            got.starts_with(&format!(
                "{E_QUOTE_FIELDS}: deposit address {} was paid by one of this desk's last {DEPOSIT_RING}",
                quote(HL_QUOTE).2
            )),
            "{got}"
        );
        assert_eq!((ledger(&g, "alpha"), counters(&g)), after_first);
    }
    // A rescue quote that paid an address first blocks the fund_venue of it too: one ring.
    let mut g = fund_desk(50 * USDC);
    let mut k = counters(&g);
    k.spend(
        0,
        0,
        env::sha256_array(quote(ORDERLY_QUOTE).2.as_bytes()),
        NOW_MS,
    );
    g.desk_counters.insert("alpha".into(), k);
    assert!(fund(&mut g, operator(), ORDERLY_QUOTE)
        .unwrap_err()
        .starts_with(E_QUOTE_FIELDS));
}

/// The 32-slot ring holds every address for the 65 min a quote stays payable: a 33rd transfer in
/// that time is refused before anything is spent.
#[test]
fn fund_venue_shares_the_ring_limit() {
    let mut g = fund_desk(50 * USDC);
    let mut k = counters(&g);
    for n in 0..DEPOSIT_RING {
        k.spend(0, 0, [n as u8 + 1; 32], NOW_MS - 1000);
    }
    g.desk_counters.insert("alpha".into(), k);
    let got = fund(&mut g, operator(), HL_QUOTE).unwrap_err();
    assert!(got.starts_with(E_RESCUE_CAP), "{got}");
    assert_eq!(ledger(&g, "alpha").idle_usdc, 50 * USDC);
}

#[test]
fn fund_venue_counts_against_the_hourly_cost_budget() {
    // Cap 20 USD: budget max(0.2, 2 × 0.6) = 1.2 USD; 0.7 of it spent already.
    let mut g = fund_desk_with(
        Policy {
            rescue_cap_usd_per_hour: 20,
            max_transfer_cost_flat_e6: 600_000,
            ..policy()
        },
        50 * USDC,
    );
    let mut k = counters(&g);
    k.spend(0, 70_000_000, [9; 32], NOW_MS);
    g.desk_counters.insert("alpha".into(), k);
    let got = fund(&mut g, operator(), HL_QUOTE).unwrap_err();
    assert!(
        got.starts_with(&format!("{E_RESCUE_CAP}: the rescue may cost 0.519049 USD")),
        "{got}"
    );
    assert_eq!(ledger(&g, "alpha").idle_usdc, 50 * USDC);
    // The Orderly route costs 0.107148: it fits.
    fund(&mut g, operator(), ORDERLY_QUOTE).unwrap();
}

/// The hourly rescue cap bounds money out of venues; fund_venue moves money into them.
#[test]
fn the_rescue_cap_does_not_bound_fund_venue() {
    let mut g = fund_desk_with(
        Policy {
            rescue_cap_usd_per_hour: 3,
            max_transfer_cost_flat_e6: 600_000,
            ..policy()
        },
        20 * USDC,
    );
    fund(&mut g, operator(), HL_QUOTE).unwrap();
    assert_eq!(counters(&g).rescue_spent_e8, 0);
}

#[test]
fn fund_venue_needs_the_desks_idle_usdc() {
    let mut g = fund_desk(20 * USDC - 1);
    let got = fund(&mut g, operator(), HL_QUOTE).unwrap_err();
    assert!(
        got.starts_with(&format!(
            "{E_SIZE}: amountIn 20000000 is over desk alpha's idle USDC on NEAR, 19999999"
        )),
        "{got}"
    );
    assert_eq!(counters(&g), DeskCounters::default(), "nothing counted");
    assert!(get_created_receipts().is_empty());
}

/// The recorded quotes refund to their owner account. A desk of another owner refuses them: a
/// refund would reach someone who is not the desk's owner.
#[test]
fn fund_venue_refunds_only_to_the_desk_owner() {
    let mut g = fund_desk(20 * USDC);
    g.desks.get_mut("alpha").unwrap().owner = owner();
    let got = fund(&mut g, operator(), HL_QUOTE).unwrap_err();
    assert!(got.starts_with(E_QUOTE_FIELDS), "{got}");
    assert!(got.contains("refundTo"), "{got}");
    assert_eq!(ledger(&g, "alpha").idle_usdc, 20 * USDC);
}

#[test]
fn fund_venue_refusals() {
    // Strangers, other origins, tampered quotes, too little gas, no desk.
    let mut g = fund_desk(50 * USDC);
    let got = fund(&mut g, stranger(), HL_QUOTE).unwrap_err();
    assert!(got.starts_with(E_NOT_ALLOWED), "{got}");
    let got = fund(&mut g, operator(), SOL_HL_QUOTE).unwrap_err();
    assert!(
        got.starts_with(E_QUOTE_FIELDS) && got.contains("originAsset"),
        "{got}"
    );
    let (q, sig, _) = quote(HL_QUOTE);
    at(operator(), NOW_MS, yocto(0));
    let got = outcome(|| {
        g.fund_venue(
            "alpha".into(),
            q.replace("20000000", "20000001"),
            sig.clone(),
            "r".into(),
        )
        .detach()
    })
    .unwrap_err();
    assert!(got.starts_with(E_QUOTE_SIGNATURE), "{got}");
    // An hour and a bit after 1Click signed it.
    at(operator(), NOW_MS + 3_600_000, yocto(0));
    let got = outcome(|| {
        g.fund_venue("alpha".into(), q.clone(), sig.clone(), "r".into())
            .detach()
    })
    .unwrap_err();
    assert!(
        got.starts_with(E_QUOTE_FIELDS) && got.contains("more than 1 h"),
        "{got}"
    );
    // Too little gas.
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(operator())
        .block_timestamp(NOW_MS * 1_000_000)
        .prepaid_gas(Gas::from_gas(FUND_VENUE_MIN_GAS.as_gas() - 1))
        .build());
    let got = outcome(|| {
        g.fund_venue("alpha".into(), q.clone(), sig.clone(), "r".into())
            .detach()
    })
    .unwrap_err();
    assert!(
        got.starts_with("E_ARGS: fund_venue needs at least 110 TGas"),
        "{got}"
    );
    // A reason over 280 characters.
    at(operator(), NOW_MS, yocto(0));
    let got = outcome(|| {
        g.fund_venue("alpha".into(), q.clone(), sig.clone(), "x".repeat(281))
            .detach()
    })
    .unwrap_err();
    assert!(got.starts_with(E_ARGS), "{got}");
    let got = outcome(|| {
        g.fund_venue("beta".into(), q.clone(), sig.clone(), "r".into())
            .detach()
    })
    .unwrap_err();
    assert!(got.starts_with(E_NO_DESK), "{got}");
    assert_eq!(ledger(&g, "alpha").idle_usdc, 50 * USDC);
    assert_eq!(counters(&g), DeskCounters::default());
}

#[test]
fn fund_venue_passes_a_paused_desk() {
    let mut g = fund_desk(20 * USDC);
    g.desks.get_mut("alpha").unwrap().paused = true;
    fund(&mut g, operator(), HL_QUOTE).unwrap();
    assert_eq!(ledger(&g, "alpha").idle_usdc, 0);
}

// --- withdraw_to_owner ---

/// `withdraw_to_owner` from the owner's wallet (1 yoctoNEAR).
fn withdraw(g: &mut Gimbal, amount: u128) -> Result<(), String> {
    call(owner(), ONE_YOCTO);
    outcome(|| g.withdraw_to_owner("alpha".into(), U128(amount)).detach())
}

/// The payout the last `withdraw_to_owner` scheduled, from its callback's arguments.
fn scheduled_payout() -> (String, PendingPayout) {
    let c = calls();
    let cb = c
        .iter()
        .find(|c| c.method == "on_payout_owner" || c.method == "on_payout_fee")
        .expect("a payout callback");
    (
        cb.method.clone(),
        serde_json::from_value(cb.args["payout"].clone()).unwrap(),
    )
}

/// One whole payout of `amount`: the owner's transfer and the fee transfer landing (`owner_ok`,
/// `fee_ok`); returns the fee charged.
fn pay_out(g: &mut Gimbal, amount: u128, owner_ok: bool, fee_ok: bool) -> u128 {
    withdraw(g, amount).unwrap();
    let (method, p) = scheduled_payout();
    if method == "on_payout_owner" {
        settled(owner_ok);
        match g.on_payout_owner("alpha".into(), owner(), p) {
            PromiseOrValue::Value(paid) => {
                assert_eq!(paid, owner_ok);
                assert!(!pending(g));
                return if owner_ok { p.fee.0 } else { 0 };
            }
            PromiseOrValue::Promise(next) => next.detach(),
        }
    }
    let (method, p) = scheduled_payout();
    assert_eq!(method, "on_payout_fee");
    settled(fee_ok);
    g.on_payout_fee("alpha".into(), owner(), p);
    assert!(!pending(g));
    if fee_ok {
        p.fee.0
    } else {
        0
    }
}

#[test]
fn a_payout_below_the_principal_charges_nothing() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    withdraw(&mut g, 40 * USDC).unwrap();
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!((&c[0].to, c[0].method.as_str()), (&usdc(), "ft_transfer"));
    assert_eq!(
        c[0].args,
        json!({"receiver_id": "alice", "amount": "40000000", "memo": "gimbal payout alpha"})
    );
    assert_eq!((c[0].deposit, c[0].gas), (ONE_YOCTO, FT_TRANSFER_GAS));
    assert_eq!(c[1].method, "on_payout_owner");
    assert_eq!((c[1].gas, c[1].weight), (ON_PAYOUT_OWNER_GAS, 0));
    assert!(pending(&g));
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.idle_usdc, l.withdrawn, l.fees_paid, l.hwm),
        (60 * USDC, 40 * USDC, 0, 0)
    );
    assert!(get_logs().is_empty(), "events wait for the transfers");

    let (_, p) = scheduled_payout();
    settled(true);
    match g.on_payout_owner("alpha".into(), owner(), p) {
        PromiseOrValue::Value(paid) => assert!(paid),
        PromiseOrValue::Promise(_) => panic!("no fee, no fee transfer"),
    }
    assert!(!pending(&g));
    assert_eq!(
        get_logs(),
        vec![event(
            "payout",
            r#"{"desk_id":"alpha","to":"alice","amount":"40000000","fee":"0","profit":"-60000000","hwm":"0"}"#
        )]
    );
}

#[test]
fn a_payout_with_profit_pays_the_owner_first_then_the_fee() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    // 1Click brings 110 back from the venues: 100 sent out earlier plus 10 profit.
    g.money.get_mut("alpha").unwrap().ledger.idle_usdc = 0;
    deposit_alpha(&mut g, intents(), 110 * USDC);
    withdraw(&mut g, 110 * USDC).unwrap();
    let c = calls();
    assert_eq!(c[0].args["amount"], "109000000", "the owner's share");
    let (_, p) = scheduled_payout();
    assert_eq!(
        Payout::from(p),
        Payout {
            amount: 110 * USDC,
            fee: USDC,
            profit: 10 * USDC as i128,
            hwm_before: 0,
            hwm_after: 10 * USDC
        }
    );
    settled(true);
    let next = match g.on_payout_owner("alpha".into(), owner(), p) {
        PromiseOrValue::Promise(next) => next,
        PromiseOrValue::Value(_) => panic!("a fee is due"),
    };
    next.detach();
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        c[0].args,
        json!({"receiver_id": "fargo", "amount": "1000000", "memo": "gimbal performance fee alpha"})
    );
    assert_eq!((c[0].to.clone(), c[0].deposit), (usdc(), ONE_YOCTO));
    assert_eq!(
        (c[1].method.as_str(), c[1].gas),
        ("on_payout_fee", ON_PAYOUT_FEE_GAS)
    );
    assert!(pending(&g), "in flight until the fee settles");
    assert!(get_logs().is_empty());

    settled(true);
    assert!(g.on_payout_fee("alpha".into(), owner(), p));
    assert!(!pending(&g));
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.deposited, l.withdrawn, l.fees_paid, l.hwm, l.idle_usdc),
        (100 * USDC, 110 * USDC, USDC, 10 * USDC, 0)
    );
    assert_eq!(
        get_logs(),
        vec![
            event(
                "payout",
                r#"{"desk_id":"alpha","to":"alice","amount":"110000000","fee":"1000000","profit":"10000000","hwm":"10000000"}"#
            ),
            event(
                "fee_charged",
                r#"{"desk_id":"alpha","kind":"performance","amount":"1000000","treasury":"fargo"}"#
            ),
        ]
    );
}

/// Profit, a loss, the recovery to the old mark and new profit, through the contract.
#[test]
fn the_high_water_mark_through_the_contract() {
    let mut g = with_desk();
    let send_out = |g: &mut Gimbal| g.money.get_mut("alpha").unwrap().ledger.idle_usdc = 0;
    deposit_alpha(&mut g, owner(), 100 * USDC);
    send_out(&mut g);
    deposit_alpha(&mut g, intents(), 110 * USDC);
    assert_eq!(pay_out(&mut g, 110 * USDC, true, true), USDC);
    // Loss: 100 in, 80 back.
    deposit_alpha(&mut g, owner(), 100 * USDC);
    send_out(&mut g);
    deposit_alpha(&mut g, intents(), 80 * USDC);
    assert_eq!(pay_out(&mut g, 80 * USDC, true, true), 0);
    // Recovery: 100 in, 120 back, back at the mark.
    deposit_alpha(&mut g, owner(), 100 * USDC);
    send_out(&mut g);
    deposit_alpha(&mut g, intents(), 120 * USDC);
    assert_eq!(pay_out(&mut g, 120 * USDC, true, true), 0);
    // New profit: 100 in, 105 back, 5 above the mark.
    deposit_alpha(&mut g, owner(), 100 * USDC);
    send_out(&mut g);
    deposit_alpha(&mut g, intents(), 105 * USDC);
    assert_eq!(pay_out(&mut g, 105 * USDC, true, true), USDC / 2);
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.deposited, l.withdrawn, l.fees_paid, l.hwm),
        (400 * USDC, 415 * USDC, 3 * USDC / 2, 15 * USDC)
    );
}

#[test]
fn a_failed_owner_transfer_restores_the_ledger() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    deposit_alpha(&mut g, intents(), 10 * USDC);
    let before = ledger(&g, "alpha");
    assert_eq!(pay_out(&mut g, 110 * USDC, false, true), 0);
    assert_eq!(ledger(&g, "alpha"), before);
    assert!(!pending(&g));
    assert!(
        get_logs().iter().all(|l| !l.starts_with("EVENT_JSON")),
        "{:?}",
        get_logs()
    );
    // The same payout goes through afterwards, with the same fee.
    assert_eq!(pay_out(&mut g, 110 * USDC, true, true), USDC);
}

#[test]
fn a_failed_fee_transfer_keeps_the_fee_with_the_desk_due_once() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    deposit_alpha(&mut g, intents(), 10 * USDC);
    assert_eq!(pay_out(&mut g, 110 * USDC, true, false), 0);
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.idle_usdc, l.withdrawn, l.fees_paid, l.hwm),
        (USDC, 109 * USDC, 0, 0)
    );
    assert_eq!(
        get_logs().last().unwrap(),
        &event(
            "payout",
            r#"{"desk_id":"alpha","to":"alice","amount":"109000000","fee":"0","profit":"9000000","hwm":"0"}"#
        )
    );
    // The 1 left is the fee: paying it out sends it all to the treasury, with no owner transfer.
    withdraw(&mut g, USDC).unwrap();
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(c[0].args["receiver_id"], "fargo");
    assert_eq!(c[1].method, "on_payout_fee");
    let (_, p) = scheduled_payout();
    // Failing again keeps it with the desk once more.
    settled(false);
    assert!(!g.on_payout_fee("alpha".into(), owner(), p));
    assert_eq!(ledger(&g, "alpha").idle_usdc, USDC);
    assert!(get_logs().iter().all(|l| !l.starts_with("EVENT_JSON")));
    assert_eq!(pay_out(&mut g, USDC, true, true), USDC);
    let l = ledger(&g, "alpha");
    assert_eq!(
        (l.idle_usdc, l.withdrawn, l.fees_paid, l.hwm),
        (0, 110 * USDC, USDC, 10 * USDC)
    );
}

#[test]
fn one_payout_at_a_time() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 100 * USDC);
    withdraw(&mut g, 10 * USDC).unwrap();
    let (_, p) = scheduled_payout();
    let got = withdraw(&mut g, 10 * USDC).unwrap_err();
    assert!(
        got.starts_with("E_ARGS: a payout of desk alpha is still in flight"),
        "{got}"
    );
    assert_eq!(ledger(&g, "alpha").idle_usdc, 90 * USDC);
    // Deposits and fund moves go on meanwhile.
    deposit_alpha(&mut g, intents(), USDC);
    settled(true);
    let _ = g.on_payout_owner("alpha".into(), owner(), p);
    withdraw(&mut g, 10 * USDC).unwrap();
}

#[test]
fn withdraw_to_owner_refusals() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 10 * USDC);
    // The operator key (no deposit), the operator account, a stranger.
    called_by(owner());
    assert_refused(
        "E_NOT_ALLOWED: withdraw_to_owner needs exactly 1 yoctoNEAR",
        || {
            g.withdraw_to_owner("alpha".into(), U128(USDC)).detach();
        },
    );
    call(owner(), yocto(2));
    assert_refused("E_NOT_ALLOWED: ", || {
        g.withdraw_to_owner("alpha".into(), U128(USDC)).detach();
    });
    for who in [operator(), stranger()] {
        call(who, ONE_YOCTO);
        assert_refused(
            "E_NOT_ALLOWED: withdraw_to_owner on desk alpha is for its owner",
            || {
                g.withdraw_to_owner("alpha".into(), U128(USDC)).detach();
            },
        );
    }
    for amount in [0, 10 * USDC + 1] {
        let got = withdraw(&mut g, amount).unwrap_err();
        assert!(
            got.starts_with(&format!("{E_SIZE}: amount {amount} must be from 1")),
            "{got}"
        );
    }
    call(owner(), ONE_YOCTO);
    assert_refused("E_NO_DESK", || {
        g.withdraw_to_owner("beta".into(), U128(USDC)).detach();
    });
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract_id())
        .predecessor_account_id(owner())
        .attached_deposit(ONE_YOCTO)
        .prepaid_gas(Gas::from_gas(WITHDRAW_MIN_GAS.as_gas() - 1))
        .build());
    assert_refused("E_ARGS: withdraw_to_owner needs at least 105 TGas", || {
        g.withdraw_to_owner("alpha".into(), U128(USDC)).detach();
    });
    assert_eq!(ledger(&g, "alpha").idle_usdc, 10 * USDC);
    assert!(!pending(&g));
}

#[test]
fn a_paused_desk_still_pays_its_owner() {
    let mut g = with_desk();
    deposit_alpha(&mut g, owner(), 10 * USDC);
    g.desks.get_mut("alpha").unwrap().paused = true;
    assert_eq!(pay_out(&mut g, 10 * USDC, true, true), 0);
    assert_eq!(ledger(&g, "alpha").withdrawn, 10 * USDC);
}

/// Rescues and fund moves never touch the fee: only a payout charges it.
#[test]
fn rescues_and_fund_moves_charge_no_fee() {
    let mut g = fund_desk(30 * USDC);
    fund(&mut g, operator(), HL_QUOTE).unwrap();
    at(operator(), NOW_MS, yocto(0));
    let (q, sig, _) = quote("Orderly money out: Arbitrum USDC (desk EVM) to Hyperliquid");
    outcome(|| g.prepare_evm_usdc_to_intents("alpha".into(), q, sig, "out".into())).unwrap();
    let l = ledger(&g, "alpha");
    assert_eq!((l.fees_paid, l.hwm, l.withdrawn), (0, 0, 0));
    assert_eq!(l.idle_usdc, 10 * USDC);
}

// --- gas and storage ---

/// Host gas the three methods use on the mocked chain (wasm execution comes on top; the static
/// allocations below bound the rest of each transaction), their total prepaid need against 300
/// TGas, and the storage they add (none). Printed with `--nocapture`.
/// The gas the call used itself since `gas0`: the mock's used gas counts the gas attached to the
/// calls it scheduled, which is the callees' share, not the caller's.
fn own_gas(gas0: Gas) -> Gas {
    let attached: u64 = calls().iter().map(|c| c.gas.as_gas()).sum();
    Gas::from_gas(env::used_gas().as_gas() - gas0.as_gas() - attached)
}

#[test]
fn gas_and_storage_of_the_money_methods() {
    // The mock counts storage from each testing_env!, so every method is measured inside its
    // own context, with the maps flushed before and after.
    let mut g = with_desk();
    g.flush_desks();
    let record = near_sdk::borsh::to_vec(g.money.get("alpha").unwrap())
        .unwrap()
        .len();
    called_by(usdc());
    let storage = env::storage_usage();
    let gas0 = env::used_gas();
    let _ = g.ft_on_transfer(owner(), U128(100 * USDC), r#"{"desk_id":"alpha"}"#.into());
    let deposit_gas = own_gas(gas0);
    g.flush_desks();
    assert_eq!(env::storage_usage(), storage, "a deposit adds no storage");
    // A return, so the payout below charges a fee: on_payout_owner then schedules its transfer.
    deposit_alpha(&mut g, intents(), 10 * USDC);

    call(owner(), ONE_YOCTO);
    let storage = env::storage_usage();
    let gas0 = env::used_gas();
    g.withdraw_to_owner("alpha".into(), U128(110 * USDC))
        .detach();
    let withdraw_gas = own_gas(gas0);
    g.flush_desks();
    assert_eq!(env::storage_usage(), storage, "a payout adds no storage");
    let (_, p) = scheduled_payout();
    settled(true);
    let storage = env::storage_usage();
    let gas0 = env::used_gas();
    let _ = g.on_payout_owner("alpha".into(), owner(), p);
    let owner_cb_gas = own_gas(gas0);
    g.flush_desks();
    assert_eq!(
        env::storage_usage(),
        storage,
        "its callback adds no storage"
    );
    let (method, p) = scheduled_payout();
    assert_eq!((method.as_str(), p.fee.0), ("on_payout_fee", USDC));
    settled(true);
    let gas0 = env::used_gas();
    assert!(g.on_payout_fee("alpha".into(), owner(), p));
    let fee_cb_gas = own_gas(gas0);

    let mut f = fund_desk(30 * USDC);
    f.flush_desks();
    at(operator(), NOW_MS, yocto(0));
    let storage = env::storage_usage();
    let (q, sig, _) = quote(HL_QUOTE);
    let gas0 = env::used_gas();
    f.fund_venue("alpha".into(), q, sig, "margin in".into())
        .detach();
    let fund_gas = own_gas(gas0);
    f.flush_desks();
    assert_eq!(env::storage_usage(), storage, "fund_venue adds no storage");
    settled(true);
    let gas0 = env::used_gas();
    assert!(f.on_fund_venue("alpha".into(), U128(20 * USDC)));
    let fund_cb_gas = own_gas(gas0);

    let t = |g: Gas| g.as_gas() as f64 / 1e12;
    println!(
        "host gas with receipt fees (TGas): ft_on_transfer {:.2}, fund_venue {:.2}, on_fund_venue {:.2}, withdraw_to_owner {:.2}, on_payout_owner {:.2}, on_payout_fee {:.2}",
        t(deposit_gas),
        t(fund_gas),
        t(fund_cb_gas),
        t(withdraw_gas),
        t(owner_cb_gas),
        t(fee_cb_gas),
    );
    println!("money record per desk: {record} bytes of value");
    println!(
        "prepaid floors (TGas): fund_venue {}, withdraw_to_owner {}",
        FUND_VENUE_MIN_GAS.as_tgas(),
        WITHDRAW_MIN_GAS.as_tgas()
    );
    // Each method's host gas and receipt fees, plus the wasm work the mock does not meter, fit
    // the share its floor gives it; a callback that ran out would leave the payout lock held.
    let fits = |used: Gas, share: Gas| used.as_gas() + OWN_WORK_GAS.as_gas() <= share.as_gas();
    assert!(fits(fund_gas, FUND_VENUE_GAS), "fund_venue {fund_gas}");
    assert!(fits(fund_cb_gas, ON_FUND_VENUE_GAS), "{fund_cb_gas}");
    assert!(fits(withdraw_gas, WITHDRAW_GAS), "withdraw {withdraw_gas}");
    let attached = FT_TRANSFER_GAS.as_gas() + ON_PAYOUT_FEE_GAS.as_gas();
    assert!(
        fits(
            owner_cb_gas,
            Gas::from_gas(ON_PAYOUT_OWNER_GAS.as_gas() - attached)
        ),
        "on_payout_owner {owner_cb_gas}"
    );
    assert!(fits(fee_cb_gas, ON_PAYOUT_FEE_GAS), "{fee_cb_gas}");
    assert!(deposit_gas < Gas::from_tgas(5), "{deposit_gas}");
    assert!(FUND_VENUE_MIN_GAS <= Gas::from_tgas(300));
    assert!(WITHDRAW_MIN_GAS <= Gas::from_tgas(300));
}

#[test]
fn create_desk_writes_the_money_record() {
    // The money record is part of the desk's storage, paid by the owner at create_desk.
    let mut g = testnet();
    call(owner(), NearToken::from_near(1));
    g.create_desk("alpha".into(), policy(), EVM.into(), solana())
        .detach();
    let (id, desk, attached) = scheduled_callback();
    callback(mpc_answers());
    run_callback(&mut g, id, desk, attached).unwrap();
    assert_eq!(g.money.get("alpha").unwrap(), &DeskMoney::new(owner()));
}
