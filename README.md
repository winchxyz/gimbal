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

<!-- fill: deployed contract id, how to create a desk, what to watch -->

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

Bounds and accepted residuals, at the default policy:

- **Wash trading.** An operator trading against itself at the band's edge loses at most about
  2 × `max_hourly_notional_usd` × `price_band_bps` / 10⁴ per sliding hour, plus venue fees.
- **Transfer fees.** 1Click's `appFees` are not in the signed quote; each quote's fee is bounded by 1 USDC + 25 bps
  and all quotes of a sliding hour by the hourly cost budget's quote share (1 USD), with its own room for four
  1 USDC venue fees.
- **Paused rescues.** A paused desk still signs rescues; their Solana fees and the rent of each deposit owner's new
  token account are lost to the desk: at most about 0.078 SOL per 65 min, about 0.01 SOL an hour after that.
- **Orderly replay.** A signed Orderly order can be posted again within its 300 s window; on mainnet opening orders
  need the key's IP restriction signed first.
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
