# Gimbal

**Stays level when the market doesn't.** A delta-neutral funding-carry desk with no private keys: one NEAR
contract owns accounts on Hyperliquid, Orderly and Phoenix through Chain Signatures, signs every order itself,
and moves margin between them through NEAR Intents before a leg can be liquidated.

Built for NEAR HACKATHON, Nov 1–14, 2026. Tracks: DeFi, Security, Agents. This repository started on Oct 30,
2026, inside the build window, which runs from the announcement on Oct 19 to Nov 14 (rule Q-001 in the
hackathon's HACKATHON.md).

<!-- fill: one screenshot of the Desk screen, 1600 px wide -->

## The problem

A funding-carry hedge is two positions that cancel out: short on one venue, long on another, earning the
difference in funding. It fails in two ways:

1. **One leg gets liquidated** while the other is winning, because margin sits on the wrong venue.
2. **Whoever runs it holds keys** to both accounts — a bot key, an API key, an agent key — and a leaked key
   can drain everything.

## What Gimbal does

- **No keys.** Each desk's venue accounts are MPC keys derived for the `gimbal` contract. The contract builds
  each Hyperliquid action and Orderly request and parses each Solana transaction itself, checks it against the
  owner's policy, then asks NEAR's MPC network to sign. No private key for those accounts exists anywhere.
- **Finds windows.** The engine re-prices funding windows across venues after fees, slippage, basis and
  funding timing, and opens both legs when a window clears the owner's threshold.
- **Never lets a leg die.** It watches margin on both venues and moves USDC to the weaker leg through
  NEAR Intents 1Click; the contract verifies the 1Click quote signature, so the deposit address cannot be swapped.
- **Explains itself.** Every action is a NEP-297 event on NEAR plus a journal entry with explorer links.

## How it works

<!-- fill: the diagram from docs/ (contract → MPC → venues; engine → contract; Intents between venues) -->

### Rescue routes: live on mainnet or replay only

A rescue moves USDC to the leg that is short of margin. On mainnet the engine's `serve` moves real money only with
`GIMBAL_RESCUE=1`, and only on the routes marked live; it prints the list at start. The steps and the checks before
a first live rescue are in [tools/mainnet/README.md](tools/mainnet/README.md), "The live rescue".

| route | on mainnet | how |
|---|---|---|
| reserve (the desk's idle USDC on NEAR) → Hyperliquid | live | `fund_venue` into HyperCore USDC |
| reserve → Phoenix | live | `fund_venue` into the desk's Solana USDC, then a deposit into Phoenix |
| Phoenix → Hyperliquid | live | one Solana transaction (`sol_sign_rescue`) to the 1Click deposit address |
| Hyperliquid → Phoenix | replay only | wired (`hl_withdraw`, `evm_usdc_to_intents`, the deposit), not yet dry-run on mainnet |
| reserve or Phoenix → Orderly | replay only | an Orderly landing needs Orderly's private API, which `serve` does not open |
| Hyperliquid → Orderly | not built | Arbitrum USDC into Arbitrum USDC, which 1Click does not quote |

The two Phoenix routes also need a Solana RPC that serves transaction history; without one `serve` refuses them and
says why. Replay-only routes run in `npm run demo` on recorded mainnet responses. 1Click has no testnet, so on
testnet every rescue is replayed. When no route can pay, the engine reduces both legs reduce-only by the same size
instead.

## NEAR features used

| Feature | Where | What for |
|---|---|---|
| Chain Signatures (MPC, `v1.signer`) | `contract/src/…` | signs Hyperliquid and Orderly EIP-712 (secp256k1), Orderly API requests and Solana transactions (Ed25519), and Arbitrum USDC transfers (EIP-3009) |
| NEAR Intents / 1Click | `engine/src/rescue/…`, `contract/src/intents.rs` | cross-chain margin moves; quote signature checked on-chain |
| FunctionCall access keys | `docs/…` | the engine can call only operator methods, cannot attach deposits |
| NEP-297 events | `contract/src/events.rs` | auditable on-chain journal |
| OutLayer TEE price oracle | `contract/src/oracle.rs` | price band on every order |
| NEAR AI Cloud (TEE) | `engine/src/ai/…` | drafts the desk policy from the owner's words (the owner signs it); vetoes trap windows (can only refuse); writes journal explanations. Never in the signing path |

<!-- fill: exact file paths once the code exists -->

## Try it

### 1. Replay demo — 2 minutes, no keys

```bash
npm install
npm run demo
```

Open http://localhost:5190. You should see:

<!-- fill: exact "do X → see Y" list, e.g.
1. Windows screen: N windows ranked by net APR; the top one shows its cost waterfall.
2. After ~20 s the desk opens both legs; Journal shows two `enter` entries.
3. Press "Stress" on Rescue: margin on the Hyperliquid leg drops, the rescue runs step by step, the desk returns to level.
4. Security: policy, contract and MPC addresses, "keys that exist: 0". -->

### 2. Contract tests

```bash
cd contract && cargo test --workspace
```

<!-- fill: what passes: digest vectors from the venue SDKs, every refusal code, Solana parser attacks -->

### 3. Testnet

The final contract code (main at `b73beb5`) runs on NEAR testnet at
[`gimbal-final-fcf135.testnet`](https://testnet.nearblocks.io/address/gimbal-final-fcf135.testnet), deployed
2026-11-03. It is the same wasm the mainnet final deploy uses (that deploy is not made yet):

| | |
|---|---|
| wasm sha256 | `da4bff79edb36baec4a4c5a636a267abe9c0505fa30790a2771584a14b2e30fa` (`cargo near build non-reproducible-wasm --no-abi`) |
| code hash (`view_account`) | `Fh96HRMGw6RcZDzFLnbjgoUZXMa2W4pGMbj8eRuZZ6Uh` |
| deploy + `new` | [`EjKZNnRjS8AUkuL9s3kMtVmLFHLbQTW8WdrkeTrdSsTD`](https://testnet.nearblocks.io/txns/EjKZNnRjS8AUkuL9s3kMtVmLFHLbQTW8WdrkeTrdSsTD) |
| config | network `Testnet`, MPC `v1.signer-prod.testnet`, price source `Mock` (`price-oracle.testnet` returns null prices), Orderly broker `woofi_dex` on chain 421614, no referral codes |
| desk `final-1` | [`create_desk` `5MLj2NfSMYh54kYWvjLDM9DBuXndRgqkRPyGge4DLJtw`](https://testnet.nearblocks.io/txns/5MLj2NfSMYh54kYWvjLDM9DBuXndRgqkRPyGge4DLJtw), policy `tools/testnet-policy.json` |
| desk EVM address (Hyperliquid, Orderly) | `0x6dc11a853ca5afaa44fb926bf26ff0b3950928cb` |
| desk Solana authority | `3CfwbY27qA1UBukpcqEYfjCxHYkU6dpA3dkUraLdHcTB` |
| first signature | [`hl_order` `9RgCHtyJ4g8PBoHd4fMPivaJrckoBQMPRPTVbnzC3ARQ`](https://testnet.nearblocks.io/txns/9RgCHtyJ4g8PBoHd4fMPivaJrckoBQMPRPTVbnzC3ARQ): an unpriced BTC order signed by the MPC network; Hyperliquid testnet recovered the desk's address from it and refused the order because that address holds no funds yet |

Read it without keys (NEAR CLI):

```bash
near contract call-function as-read-only gimbal-final-fcf135.testnet config json-args '{}' network-config testnet now
near contract call-function as-read-only gimbal-final-fcf135.testnet get_desk json-args '{"desk_id":"final-1"}' network-config testnet now
```

The other views: `version`, `prices`, `desks_of {"owner"}`, `get_desk_counters {"desk_id"}`,
`get_desk_settings {"desk_id"}`.

Create your own desk from a testnet account whose full-access key file is in `.keys/<account>.json`:

```bash
node tools/testnet/desk.mjs gimbal-final-fcf135.testnet <desk_id> --owner <account>.testnet
```

It derives the desk's addresses from the MPC contract, as `create_desk` checks them, and attaches 0.5 NEAR for
storage (the rest is refunded).

Check the desk's signing (one MPC signature per step, from the desk owner's account, 300 TGas):

```bash
node tools/testnet/live.mjs gimbal-final-fcf135.testnet <desk_id> hl --owner <account>.testnet
```

The contract signs an unpriced BTC order far under the mid. The script recomputes the EIP-712 digest itself,
without trusting the contract, and prints `recovers to 0x… (the desk EVM address)`. Then it posts the order to
Hyperliquid testnet, which names the address it recovered. A desk with no funds there is refused with
`User or API Wallet 0x… does not exist.`, which shows the same address. The other steps (`register`, `add-key`,
`faucet`, `order`, `ws`, `settle`, ...) are listed at the top of `tools/testnet/live.mjs`. 1Click has no
testnet, so rescues run live only on mainnet.

### 4. Mainnet evidence

<!-- fill: table — action · time · NEAR tx · venue tx — for: desk created, both legs opened, funding paid,
rescue through Intents (with measured seconds), four refusals -->

## Fees

10% of profit above the owner's high-water mark, charged by the contract when profit is paid out;
0.01% per Hyperliquid fill through Hyperliquid's builder code; and 0.01% per Orderly taker fill as Gimbal's
Orderly broker markup (maker fills carry none). Nothing on deposits, margin rescues or
losses; no management fee. Every charge is a `fee_charged` event on NEAR. Each desk also uses the referral
codes fixed in the contract's config, where a venue has one: on Hyperliquid the desk pays 4% less in fees, and
Hyperliquid pays the code's owner 10% of the fees the desk pays.

<!-- fill: Orderly and Phoenix referral terms once those codes are decided -->

## Security model

The contract builds every payload the desk's MPC keys sign and refuses anything outside the owner's policy;
[docs/interfaces.md](docs/interfaces.md) §1.3 and §1.5 list each rule and its refusal code, and the contract's unit
tests pin them. The operator key (a FunctionCall key on the owner's account) can trade inside the policy and move
margin between the desk's own venue accounts; it cannot pay anyone else, change the policy or resume a paused desk.

### What cannot be stolen

- **No key to leak.** The desk's venue accounts are MPC keys of the contract. The only key the engine holds over desk
  money is the operator key; its other key is a gas-only Arbitrum wallet, which only submits USDC authorizations the
  contract signed (USDC checks the signature) and holds a few dollars of ETH, never desk money.
- **Owner methods stay the owner's.** Policy, operator, Orderly receiver and IP list, Phoenix accounts, 1Click key,
  payouts and resume check that the caller is the desk's owner, which refuses a separate operator account set with
  `set_operator`. The engine's FunctionCall key sits on the owner's account, so the contract sees the owner; it is
  stopped by the deposit rule instead: every owner method needs 1 yoctoNEAR or a storage deposit attached, and a
  FunctionCall key cannot attach one.
- **Money moves only to the desk's own accounts, with two owner-side exceptions.** A 1Click quote is paid only when
  1Click's signature over it verifies on chain, and its recipient must be the desk's EVM address, its Solana
  authority, the Orderly receiver the owner pinned, or the contract itself for this desk. `hl_withdraw` goes only to
  the desk's EVM address on Arbitrum, an Orderly withdrawal only to the same address. A quote's `refundTo` is pinned
  per method: the desk address the money came from, or the owner for `fund_venue`. The exceptions are the Orderly
  receiver, which is whatever address the owner pins, and `fund_venue` refunds, which go to the owner ("Owner skips
  the performance fee" below).
- **Out to the owner only.** USDC reaches the owner through `withdraw_to_owner` (owner only, charges the fee) or as
  a 1Click refund of a `fund_venue`, whose `refundTo` is pinned to the owner.
- **How fast.** Transfers out of a venue are capped per sliding hour by amount (`rescue_cap_usd_per_hour`), by cost
  (the hourly cost budget) and by count (32 deposit addresses per 65 min); `fund_venue` has its own ring and budget.

What a rogue operator can still do is lose money inside these bounds: trade badly within the policy, pay transfer
fees, and spend the desk's SOL on Solana fees. The risks below are those bounds and the residuals the human
accepted: each is described, not fixed.

### Accepted risks

Each at the default policy: what can happen, its bound, and why it is accepted.

- **Wash trading.** An operator trading against itself at the price band's edges loses about
  2 × `max_hourly_notional_usd` × `price_band_bps` / 10⁴ per sliding hour on average, up to about 4 × in a single
  hour, plus closing the positions held at its start and the venue fees. The causes: reduce-only closes are free
  (not counted), and the meter decays linearly. Accepted because reduce-only orders and cancels must never meet the
  cap: `panic_close`, a rescue's reduce and the ADL unwind rely on them.
- **1Click `appFees` skim.** 1Click leaves `appFees` out of the signed quote, so whoever requests a quote can add a
  fee to a stranger. Bound: a quote's fee (`amountIn − amountOut`) is at most 1 USDC + 25 bps of `amountIn`, so the
  skim is at most that less 1Click's real fee (about 0.69 USDC on a 4 USDC transfer); all rescue quotes of a sliding
  hour share the quote part of the hourly cost budget (1 USD), which leaves the room for four 1 USDC venue fees
  untouched, and `fund_venue` has a budget of its own. Accepted because the contract cannot see `appFees`; it bounds
  what it can see, the signed `amountOut` and `minAmountOut`. Gimbal itself sends no `appFees`.
- **Owner skips the performance fee.** Two paths. The contract cannot derive Orderly's receiver address, so it
  takes any address the owner pins with `set_orderly_receiver` (once per desk); an owner who pins its own wallet can
  move the desk's money there with `fund_venue` or a rescue, past `withdraw_to_owner` and its fee. And a `fund_venue`
  refund lands at the owner and leaves the books as spent, so idle USDC that held profit reaches the owner without
  the fee. Bound: only the treasury's fee is at risk, the money is the owner's own, and the operator can neither pin
  nor change the receiver, nor pick the refund address. On the refund path the treasury loses at most
  `performance_bps` (10 %) of the refunded amount, and a deliberate refund is made hard: a `fund_venue` quote must
  leave 0.5 % between `amountOut` and `minAmountOut`, so it cannot be built to fail. Accepted because only the owner
  can do it, and only to itself.
- **Phoenix accounts.** `set_phoenix_accounts` (owner only) replaces Phoenix's and Ember's shared accounts. The
  contract checks what it can: no program id, mint, onboarder, permission or risk authority, none of the desk's own
  derived accounts, no two alike, the program-derived ones off the curve. Every desk-side account stays derived and
  pinned, and the accounts are passed only to the pinned Phoenix and Ember programs, at their positions; that a
  wrong one makes those instructions fail rests on those programs' own account checks. Accepted because the contract is frozen
  and Phoenix may move these accounts; only the owner can set them.
- **Orderly order repeat.** A signed Orderly order and its signature are public, and Orderly refuses a copy only
  while the original is still open: a copy of a filled IOC or a cancelled limit order is accepted within the 300 s
  window of the request's timestamp. A copy is not signed again, so the contract's hourly notional meter does not
  count it. Bound: on a mainnet contract an order that is not reduce-only is refused until the owner set an IP list
  and the contract signed the key's IP restriction for it. The contract marks the list applied when it signs that
  request and cannot see whether the relayer posted it; once Orderly has it, Orderly takes copies only from the
  listed IPs, so only someone who can send from the relayer host can repeat an order, and only the same order (side,
  size, limit price inside the band) for 300 s. Reduce-only orders are never gated, so a desk can always close; a
  copy of one can only reduce a position. The engine reconciles positions after every order and closes any excess
  reduce-only (seen on testnet on 2026-10-31). Accepted because the contract sees signatures, not Orderly's book,
  and Orderly has no once-only order nonce; the relayer host runs the engine, which already holds the operator key's
  trading power inside the policy.
- **Address registration spam.** Each `fund_venue` registers the new 1Click deposit address on USDC, 0.00125 NEAR
  from the contract's balance (the owner's registration, when it exists already, comes back). Bound: a desk's
  `fund_venue` ring takes at most 32 transfers per 65 min, about 0.9 NEAR a day per desk. The cost falls on the
  contract's NEAR and on the desk's USDC (each transfer pays real 1Click fees, inside the `fund_venue` cost budget);
  a rogue operator pays nothing of its own. Accepted because a transfer to an unregistered address fails, so the
  registration cannot be skipped, and the bound is small. The contract's NEAR balance is watched.
- **Rescues held after a restart.** Paying twice is what the rescuer guards against, so after a restart it trusts
  only its state file and chain facts. A payment that may have been signed stays held until 1Click settles it or the
  chain proves it can never run; while anything is held no transfer starts. A payment that was never signed is
  released once a final NEAR block past the quote's payable end (at most an hour after 1Click signed it) plus 60 s
  shows that the contract never paid its deposit address. A missing or unusable state file holds every transfer
  until the owner reconciles and starts once with
  `GIMBAL_RESCUE_FRESH=<contract>/<desk>`, which `serve` refuses for 65 min after the desk's last rescue or
  `fund_venue` on chain and after the last trace of its rescuers in the state directory. A first run counts the
  rescue cap as used in full, freeing over its first hour, so Phoenix → Hyperliquid may wait up to that hour; the
  reserve routes do not count against that cap. Bound: a restart over a usable state file with nothing in flight
  blocks nothing; one without a usable file holds transfers for about 65 min, then the cap frees over an hour. A
  payment that may really have run stays held until it is settled or the owner reconciles it. Reducing both legs
  reduce-only and `panic_close` run all along. Accepted because a NEAR call can land long after the engine
  gave up on it, and the contract keeps a quote payable for up to 65 min; nothing on chain shows such a call before
  it lands.
- **No 1Click quotes out of HyperCore.** 1Click answers "Quoting for this pair is not available" for every quote out
  of HyperCore (first seen 2026-10-31), so `hl_send_to_intents`, the one-hop route out of Hyperliquid, cannot run.
  Hyperliquid → Arbitrum goes through `hl_withdraw` to the desk's own Arbitrum address, then `evm_usdc_to_intents`
  and 1Click from Arbitrum USDC. Bound: it costs Hyperliquid's 1 USDC withdrawal fee, the 1Click fee and the
  relayer's Arbitrum gas; an operator withdrawal is at least 10 USDC, and the route counts against the rescue cap
  twice. Every hop ends at a desk address, so it adds cost and time, not a way out. The Hyperliquid → Phoenix rescue
  runs in replay only, and Hyperliquid → Orderly is not built. Accepted because the gap is on 1Click's side; the
  contract keeps `hl_send_to_intents` for when quoting opens.

Other bounded residuals:

- **Paused rescues.** A paused desk still signs rescues; their Solana fees and the rent of each deposit owner's new
  token account are lost to the desk: at most about 0.078 SOL per 65 min, about 0.01 SOL an hour after that.
- **Urgent Solana fees.** Urgent `cancel_all` and reduce-only `sol_sign` messages have no count limit, on running and
  paused desks: up to 0.000405 SOL each, bounded only by the operator key's NEAR allowance.
- **Spot after a pause.** Spot pairs take no reduce-only orders, so after `panic_close` a spot holding is sold only
  once the desk resumes. Gimbal trades no spot today.
- **1Click key rotation.** A second quote key needs the treasury's proposal, the owner's acceptance and a day, so a
  rotation pauses quoted transfers for at least a day; the treasury should be a multisig. An owner can distrust
  1Click's pinned key for a desk, for good.
- **Prices.** The seven oracle ids are fixed and asked together; if one breaks, owners move symbols to `unpriced`.
  `refresh_prices` costs the contract up to 29–58 NEAR a day if spammed, so its balance is watched.
- **Frozen venues.** A new Phoenix or Ember program id, PhUSD mint, onboarder or permission account needs a new
  contract.

## Limits

<!-- fill: honest limits — funding gaps on BTC/ETH are small; MPC signing takes seconds (one took 120 s), not
for HFT; a rescue takes about a minute; Phoenix has no devnet; 1Click has no testnet, so the testnet rescue is
replayed; trust in MPC network, Intents, venues -->

## Repo map

<!-- fill: one line per folder -->

## License

Business Source License 1.1 (see `LICENSE`). Free for evaluation, testing, research and judging, and for
running desks with your own funds; offering it to others as a service needs permission. It becomes MIT
on 2028-11-14.
