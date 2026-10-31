# Gimbal — notes for coding agents

Gimbal is a delta-neutral funding-carry desk with no private keys. A NEAR contract owns trading accounts
on Hyperliquid (EVM), Orderly (EVM-type account) and Phoenix (Solana) through Chain Signatures, builds every
order itself, checks it against the owner's policy and only then asks the MPC network to sign. An engine scans
funding windows, opens both legs, watches margin, and moves margin between venues through NEAR Intents (1Click)
before a leg can be liquidated. Built for NEAR HACKATHON (Nov 1–14, 2026).

The same code runs on testnet and mainnet (network chosen by config: `GIMBAL_MODE`, `NEAR_NETWORK`, venue URLs),
plus a replay mode that plays recorded mainnet data for the demo. Only URLs, ids and the price source differ.

## Layout and ownership

| Folder | What | Language |
|---|---|---|
| `contract/core/` | crate `gimbal-core`: pure logic with no near-sdk — decimals, policy checks, action builders and digests, Solana parser, quote verification | Rust, pure-Rust deps only |
| `contract/` | the `gimbal` NEAR contract: state, desks, MPC calls, events; wires `gimbal-core` to the chain. Its `Cargo.toml` is also the workspace root | Rust, near-sdk 5.29 |
| `engine/` | venue readers, scanner, strategy, risk, rescue, relayer, journal, SSE server, replay | TypeScript, Node 24 |
| `web/` | dashboard: Windows, Desk, Journal, Rescue, Security, onboarding | TypeScript, Vite, React |
| `shared/` | types shared by engine and web | TypeScript |
| `tools/` | test-vector generators (venue SDKs → JSON fixtures for contract tests) | TypeScript / JS |
| `docs/` | `interfaces.md` (the contract between the parts), design notes | Markdown |
| `design/` | the designer's deliverables: `tokens.css`, `tokens.json`, screen mockups, `HANDOFF.md`; read-only for everyone else | HTML, CSS, PNG |

Work only inside the folder your task names. `shared/` and `docs/interfaces.md` change only together
with the Rust types, in one change. The web copies tokens from `design/` into `web/`; nobody edits `design/`
except the designer.

## Commands

```bash
npm run ci                       # everything below, in order; one line when green, else the failing step's tail
npm install                      # root workspaces, in order: shared, engine, web, tools
npm run build                    # shared first: engine and web import its dist/
npm run demo                     # replay mode: engine + web, no keys needed
npm test                         # all workspaces; run npm run build first; the output must say "tests N" with N > 0
npm run typecheck
cd contract && cargo fmt --all --check
cd contract && cargo test -p gimbal-core   # logic tests: digest vectors, parser, every refusal (native, fast)
cd contract && cargo near build non-reproducible-wasm --no-abi   # wasm, default (gnu) toolchain; the ABI step fails to link on Windows
```

On Windows the near-sdk tests and clippy build with the MSVC toolchain, in their own target dir (no rustup
override, so the wasm build keeps the gnu default):

```bash
cd contract
export AWS_LC_SYS_PREBUILT_NASM=1 CARGO_TARGET_DIR=target/msvc
cargo +stable-x86_64-pc-windows-msvc clippy --workspace --all-targets -- -D warnings
cargo +stable-x86_64-pc-windows-msvc test --workspace   # plain `cargo test` runs only `gimbal`
```

- near-sdk is pinned `"~5.29"` (a plain `"5.29"` resolves to 5.30). `contract/Cargo.lock` is committed; keep it in
  every contract PR that changes dependencies.
- GitHub Actions does not run for this repo yet: run `npm run ci` before opening a PR and paste its output.

## Rules

- **Git flow:** one branch per task, pushed to the private GitHub repo and merged through a PR. The
  orchestrator merges once CI is green and its review passes (the human's standing OK). Never push to `main`.
- **Never without the human's explicit OK in chat:** make the repo public, post anywhere, submit
  the hackathon form, deploy to mainnet, sign or send any mainnet transaction, spend tokens.
- **Real-money transactions are run by the human.** Write the script, dry-run it, hand over the command.
- **No secrets in git.** Keys live in `.env` (gitignored) or `.keys/` (gitignored). `.env.example` lists names only.
- **No personal data** in code, commits or docs: no names, emails, local paths.
- **No model in the signing path.** NEAR AI may draft a policy (the owner edits and signs the contract part
  and confirms the engine rules), veto a window (it can only remove one) and write journal text. Nothing a
  model returns is sent to the contract or a venue.
- **Two mainnet contracts:** a capped canary (day 7, ≤ 20 USDC notional per leg) and the final reviewed deploy
  (day 11). Both are deployed and funded by the human.
- Before the first commit in a new clone, check `git rev-parse --show-toplevel` is this folder.
- Commit identity is the repo's local git config; never override it on the command line.

## Conventions

- English everywhere. Comments explain why, not what.
- TypeScript strict; no `any` in `shared/`. Rust: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`.
- Every contract check has a unit test that proves the refusal (`E_*` code from `docs/interfaces.md`).
- Every byte the contract signs has a test vector produced by the venue's own SDK (`tools/vectors/`).
- Numbers shown to users are real: live data, or replay of recorded live data, labelled as such.
- Docs and README: plain statements, exact steps, no marketing.

## Venue facts that bite

**Hyperliquid**
- L1 actions (orders): msgpack(action) ‖ nonce (u64 BE) ‖ `0x00` (no vault) → keccak → EIP-712 `Agent(string source,bytes32 connectionId)`, domain `Exchange` / version 1 / chainId 1337 / zero address; source `a` mainnet, `b` testnet.
- msgpack field order matters: order = `{type, orders:[{a,b,p,s,r,t:{limit:{tif}}}], grouping:"na"}`.
- User-signed actions (usdClassTransfer, sendAsset, withdraw3): domain `HyperliquidSignTransaction` / version 1 / chainId `0x66eee`, type names prefixed `HyperliquidTransaction:`.
- Nonces must be unique per signer: the contract uses `max(block_ms, last_nonce + 1)` per desk.
- User-signed action JSON carries `type`, `signatureChainId` (`0x66eee`, equal to the domain chainId) and `hyperliquidChain`.
- All hex in actions is lowercase (addresses, cloid `0x` + 32 hex): Hyperliquid lowercases before verifying.
- Prices: ≤ 5 significant figures (integers exempt) and ≤ 6 − szDecimals decimals; sizes truncated to szDecimals; no trailing zeros.
- Agent wallets cannot withdraw — and Gimbal uses no agent wallets at all.
- Builder codes: every order carries `builder: {b, f}` (f in tenths of a bp, perps max 100 = 0.1%); the desk's
  master address must sign `ApproveBuilderFee` once; the builder address needs ≥ 100 USDC in perps.
- Referral: each desk's master address signs the L1 action `{type:"setReferrer", code}` once, before its first
  order, with `treasury.referral_codes.hyperliquid` only.
- `sendAsset` to an address Hyperliquid has not seen (every 1Click deposit address) costs the sender a 1 USDC
  activation fee on top of `amount`: keep `amount + 1 USDC ≤ withdrawable`, or it fails with
  "Insufficient USDC balance for token transfer gas".

**Phoenix (Solana)**
- SDK `@ellipsis-labs/rise` pinned at 0.6.2; API `https://perp-api.phoenix.trade`.
- Orders need ~190k CU: set the compute limit to 400k and a priority fee (100,000 µlamports/CU);
  rebroadcast every 2 s until confirmed or `lastValidBlockHeight` passes. Public RPCs drop transactions otherwise.
- Collateral is PhUSD (Ember-wrapped USDC). Funding accrues hourly, settles daily (`unsettledFunding…`).
- The API's `fundingRate` field has different units per market (×1e4, ×100 or ×1): never use it.
  The hourly rate is `fundingAmountPerUnit / markPrice`; positive means longs pay shorts, as on Hyperliquid.
- Funding accrues in whole quote lots per base lot, so coarse markets print zero for many hours (XRP ~80%).
- Funding history: `/v1/funding/overview?startTime&endTime&perMarketLimit` (ms; ≤ 1 year per call;
  without parameters it returns only the last 168 h).
- Taker fee 3.5 bps, maker 0.5 bps on every market.
- Onboarding needs no wallet login and no invite: `build-register-ixs` returns the instructions with no session,
  the desk signs only as fee payer, Phoenix's API co-signs and sends (onboarder key
  `EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z`). The referral code goes in the `referral/activate-tx` HTTP
  body, never in the signed bytes; that transaction is v0 (no lookups). Steps: interfaces §1.3.
- One transaction fits Phoenix withdraw + Ember unwrap + a 1Click transfer (~980 bytes of 1232).

**Orderly**: an EVM-type account owned by the desk's EVM address; the desk's Ed25519 MPC key is registered as
its orderly key (EIP-712 `AddOrderlyKey`, ≤ 365 days); private REST calls sign `timestamp + METHOD + path + body`,
valid 300 s. Private reads go over one authenticated WebSocket session (never one MPC signature per read); the
order book is only on the public WebSocket. Funding periods are 8 h or 4 h — normalise per hour. No agent keys.
Broker id and chain id are fixed in the contract (`OrderlyConfig`).
- Broker: mainnet runs under Gimbal's own broker `gimbal_dex`: taker 4 bps (Orderly's 3 bps + Gimbal's 1 bp
  markup), maker 0, crypto and RWA alike. Testnet runs under `woofi_dex` (Gimbal's broker is mainnet only).
- Referral: none. With its own broker Gimbal binds no code (`referral_codes.orderly` = None, setup skips
  `referral_bind`).
- Money in: 1Click sends USDC on Arbitrum to the account's exclusive receiver address; Orderly sweeps it into
  its vault and credits it in 1–2 min. Below 5 USDC it is lost, never refunded.
- Money out: settle PnL first (EIP-712 `SettlePnl`), then EIP-712 `Withdraw` to the desk's EVM address on Arbitrum (40–52 s for small amounts, 1 USDC fee),
  then an EIP-3009 `TransferWithAuthorization` of USDC to a verified 1Click deposit address, submitted by a
  gas-only relayer wallet. That is four MPC signatures and several hops, so Orderly is never a rescue source.

**NEAR Intents 1Click** (`https://1click.chaindefuser.com/v0`)
- HyperCore USDC: `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` (8 decimals; lands in perps;
  0.2 USDC fee; minimum 0.5). Solana USDC: `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`.
- Quotes are signed: Ed25519 key `reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` over the UTF-8 of
  `base58(sha256(json-stable-stringify(request fields ∪ quote fields ∪ timestamp)))`.
- After depositing, POST `/deposit/submit` `{txHash, depositAddress}`; poll `/status?depositAddress=`.
- Without a 1Click API key every transfer pays +0.2 % (20 bps); with a key (Authorization header, from the
  partner portal) USDC→USDC routes cost 1 bp. Gimbal sends no `appFees`.
- Measured on mainnet 2026-10-27: Phoenix → Hyperliquid took 65 s until the margin landed (the quote's estimate
  said ~30 s), fee 0.32 USDC on 4 USDC; Hyperliquid → 1Click took 54 s, fee 0.21 USDC plus Hyperliquid's 1 USDC
  activation fee. Fees are roughly flat per transfer, so small transfers lose a large share.
- 1Click has no testnet. On testnet the rescue is shown in replay (recorded mainnet responses); it runs live
  only on mainnet.

**NEAR**
- MPC `sign({request:{path, payload_v2:{Ecdsa|Eddsa: hex}, domain_id}})`, 1 yocto deposit. Usually 5–6 s per
  signature, but one took 120 s on mainnet (2026-10-27) and a request can time out after 120 s: never assume
  a bound, retry once with fresh timestamps and nonces.
- A 300 TGas call reserves ~0.3 NEAR of attached gas up front (the real fee is ~0.001 NEAR, the rest is
  refunded), so the calling account needs ≥ 0.3 NEAR free per call in flight. The operator key's allowance
  (default 5 NEAR) is charged too: keep at most min(balance, allowance) / 0.3 NEAR signatures in flight.
- USDC on NEAR comes in only through `ft_transfer_call` with `msg` `{"desk_id":"<id>"}`: the owner's deposits count
  as principal, everything else (1Click returns, refunds) lands in `idle_usdc`.
- OutLayer `price-oracle.near`: use the on-demand path (`request_price_data`, or `oracle_call` →
  `oracle_on_call`, which must check the caller is the oracle); the cached views are stale.
  `price-oracle.testnet` returns null prices, so testnet and replay use the Mock price source.
