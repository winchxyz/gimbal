# Mainnet canary runbook

The canary is the first Gimbal deployment on NEAR mainnet: one new contract account, one desk with small limits
(20 USD per leg), and the engine's venue setup. A person runs every step that sends a transaction. Every script
here is a **dry run by default**: it reads mainnet, prints the transactions it would send (signer, receiver,
method, full args, deposit, gas) and the balances before and after, and signs, sends and writes nothing. Only
`--send` signs, and only `--send` (deploy, desk) or `--write` (relayer-wallet) writes a file.

**Run every `--send` and `--write` from the main checkout, never from a linked git worktree.** The keys go to
`.keys/` (and the relayer key to `.env`) at the root of the checkout the script runs from. Both are gitignored,
and removing a worktree deletes its ignored files without a warning. That would take the contract account's only
full-access key with it. The scripts refuse `--send` and `--write` inside a linked worktree (a checkout whose
`.git` is a file). Dry runs work anywhere and print a warning there. Every file a script writes is printed with
its absolute path.

Guards that every script applies:

- Mainnet only. Account ids must be `<name>.near` or 64-hex implicit accounts. The one exception is the named
  system accounts (`v1.signer`, `near`). Every RPC endpoint must report chain `mainnet` before it is used. The
  testnet scripts in `tools/testnet/` are separate and unchanged.
- No key is printed. A key file is reported only as "matches" or "does not match" the account's full-access
  key.
- The settings that `new()` fixes for good are printed in full: the Orderly broker id and the three referral
  codes. They are public in `config()` once deployed, so the dry run is the last chance to check them. A value
  set in the shell environment wins over `.env`; when that happens, the script prints a warning naming it. The
  broker id must be the engine's mainnet broker (`engine/src/scanner/config.ts`, `ORDERLY_BROKERS.mainnet`).
  Any other id is refused, including the testnet broker `woofi_dex`.
- Nothing is overwritten. A key file or env file that exists is refused, and `.env` entries are only filled when
  they are empty.
- Every transaction is waited for until final before the next one is sent.

Placeholders: `<funder>.near` pays for the contract account; `<contract>.near` is the new contract account;
`<owner>.near` owns the desk (it may be the funder); `<desk_id>` is the desk (1 to 32 characters of a-z, 0-9, -).

## What this contract version can do

The contract on main (C8) has the money methods on NEAR: **`ft_on_transfer`** (an owner's USDC deposit),
**`fund_venue`** (idle USDC to a venue through 1Click), **`withdraw_to_owner`** (idle USDC back to the owner, with
the performance fee) and **`clear_payout_lock`** (the owner clears a payout stuck for over an hour). The deploy dry
run lists which of the four the wasm exports (`methods ... money methods ...`) and warns when any is missing.
Compare its code hash with `view_account`'s `code_hash` to know what is deployed.

The first canary, `gimbal-canary.near`, runs code from before C8, without these methods. **Send nothing to its
desk's addresses**: the contract could not take it out. It is retired ("Retiring a canary"), and the second canary
takes a new account with the C8 code (section 8). A canary is never redeployed or migrated in place: the deploy
script refuses an account that exists and proposes the next free name.

Money paths that are **not available yet**:

- **Hyperliquid -> NEAR in one hop.** 1Click answers "Quoting for this pair is not available" for every quote out
  of HyperCore (section 7, quotes step), so `hl_send_to_intents` cannot bring USDC back. The return goes through
  Arbitrum instead, in two stages (section 8, step 9, `hl-return.mjs`): `hl_withdraw` (owner) to the desk's own
  EVM address on Arbitrum, then `evm_usdc_to_intents` (operator) and 1Click from Arbitrum USDC to the contract.
  It costs Hyperliquid's 1 USDC withdrawal fee, the 1Click cost and the relayer's Arbitrum gas, so the fixed
  1 USDC weighs on small amounts.
- **Orderly.** `fund.mjs orderly` needs the receiver pinned with `set_orderly_receiver` (an owner call these tools
  do not make) and at least 6 USDC out.

## Retiring a canary

```
node tools/mainnet/retire.mjs <contract>.near                                # dry run
node tools/mainnet/retire.mjs <contract>.near --unregister-usdc [--send]     # first, when it is registered on USDC
node tools/mainnet/retire.mjs <contract>.near --send --engine-stopped        # from the main checkout
node tools/mainnet/retire.mjs <contract>.near --beneficiary <funder>.near --creation-tx <hash>   # nearblocks has no record
```

Retiring sends one **DeleteAccount** for `<contract>.near`, signed with `.keys/<contract>.near.json`. Its whole
NEAR balance, the NEAR held for the code's storage included, goes to the beneficiary. A **locked** contract (the
final deploy, section 8, "Final deploy") has no key left and can never be retired; a canary is never locked.

**Why the checks.** After the deletion anyone can register `<contract>.near` again. Every desk address is an MPC
key derived from the contract's name (`gimbal/<desk_id>/evm`, `gimbal/<desk_id>/sol` with the contract as
predecessor), so whoever takes the name controls those addresses: the Hyperliquid account, the Solana authority
and its token accounts, the EVM address on Arbitrum and HyperEVM, Phoenix and Orderly. Anything left there, on its
way there, or sent there later, is theirs. So the script deletes only when every one of them holds at most dust and
nothing is in flight, and **nothing may be sent to the old desk addresses afterwards**.

**Every read fails closed:** an HTTP error, a timeout, an answer of an unexpected shape or an amount that is not a
number refuses the delete. Nothing is ever counted as 0 because it could not be read.

What it does:

- **Beneficiary:** the account that created `<contract>.near`. nearblocks names the creating transaction; the
  archival RPC (`archival-rpc.mainnet.fastnear.com`) must confirm it is a `near.create_account` of exactly that
  account by that signer, whose result is `true`. It never guesses: when nearblocks has no record (or is down) it
  refuses unless you pass `--beneficiary <funder>.near --creation-tx <hash>`, which is confirmed the same way. A
  `--beneficiary` that differs from the confirmed creator is refused.
- **Desks:** the contract's own Desks map (`view_state`, prefix 0), read again at every pass, and `--desks a,b`.
  A desk list that cannot be read is a refusal; a desk that appears between the venue reads and the NEAR reads
  refuses (run again).
- **Balances, per desk:**
  - Hyperliquid: every perp dex `perpDexs` lists (main, `xyz`, ...: account value, cash, open positions), spot
    balances, vault equities, staked HYPE (`delegatorSummary`: delegated, undelegated, pending withdrawals),
    sub-accounts, and a `withdraw` in the non-funding ledger within the last 30 min (it may still be on its way to
    Arbitrum);
  - Phoenix: the trader (PDA 0) of the desk's Solana authority, every subaccount's collateral, positions, limit
    orders, splines, triggers, escrow requests, locked deposit and spot collateral. The API leaves a list out when
    it is empty (Phoenix's own SDK reads a missing list as empty), so a missing list is empty; one of another type
    refuses;
  - Solana: the authority's SOL, its USDC and PhUSD token accounts (only "could not find account" counts as "never
    created"), and every account it owns under SPL Token and Token-2022 (any non-zero balance refuses);
  - EVM: USDC, USDC.e and ETH on Arbitrum, HYPE and USDC on HyperEVM (an `eth_call` answer of `0x` refuses);
  - Orderly under the contract's broker: registered (only code -1607, "Account not found", means no; any other
    `success: false` refuses), the key's state; holding and positions are not public, so `--send` makes one signed
    `orderly_request` of kind `holding` and one of kind `positions` with the engine's operator key (any other call
    is refused; a position, a pending order, unsettled PnL over 0.01 USDC or a field that is not a number refuses);
    and any `orderly_request` of kind `withdraw_request` the contract received within 30 min (nearblocks);
  - the contract, measured against the latest final block (not this machine's clock): the desk's `idle_usdc` in
    the books; the Hyperliquid nonce (an action signed within 30 min may be a withdraw in flight); the rescue ring;
    on C8 code the money record (`payout_pending` or `idle_usdc` over 0 refuses) and the `fund_venue` ring (a slot
    paid within 65 min means money may be in flight: refused, wait). A missing record refuses: `create_desk`
    writes all of them.
- **The contract's own tokens:** USDC on NEAR and whether it is registered on USDC, every NEP-141 token the
  nearblocks inventory lists, and its `intents.near` balances (`mt_tokens_for_owner`).
- **USDC registration:** while the contract is registered on USDC anyone can transfer USDC to it, also in the
  seconds before the DeleteAccount, and that USDC would be lost. So retire refuses while it is registered.
  `--unregister-usdc` is the separate step: a dry run prints `storage_unregister({"force":false})` on USDC with
  1 yoctoNEAR, signed by the contract's own key; `--send` signs it (refused while the contract holds any USDC) and
  checks the registration is gone. Its 0.00125 NEAR deposit comes back to the contract. Anyone can register it
  again with `storage_deposit`, so retire reads the registration once more right before signing.
- **Not covered** (printed in every run): Orderly under any other broker; Orderly's withdrawal history (no
  `orderly_request` kind reads it: the contract's `withdraw_request` calls of the last 30 min are read from
  nearblocks instead); EVM chains other than Arbitrum and HyperEVM; Phoenix trader PDAs other than 0; Solana stake
  accounts and NFTs; NEP-141 tokens nearblocks does not index; NEAR NFTs; a transfer made in the seconds between
  the last NEAR read and the DeleteAccount (the `window` line).
- **Dust:** 0.01 USDC, 0.001 SOL, 0.0001 ETH or HYPE on an EVM chain, 0.001 staked HYPE. Anything over it is
  listed and refused. NEAR also refuses to delete an account with over 10 kB of data besides its code; the `state`
  line shows how much it has.
- `--send` needs `--engine-stopped`: you stop the engine and any operator of these desks first and say so (nothing
  of ours may move money during the retirement). It reads `.keys/<contract>.near.json` (it must be the account's
  full-access key) and, for a desk registered on Orderly, `.keys/engine-mainnet-<contract>.near.env`; makes the
  signed Orderly reads; then reads **everything above again**, the venues first (tens of seconds) and the NEAR
  side last (the desk list, the books and records, the tokens, the USDC registration and balance), and sends the
  DeleteAccount right after, only when all of it is clean. The `window` line prints the seconds from the first of
  those last NEAR reads to the signature. Then it checks that the account is gone and the beneficiary's balance
  went up.

- **Cost:** the DeleteAccount's action fees (under 0.001 NEAR, paid from the deleted balance), and for an Orderly
  desk two operator calls (about 0.001 NEAR each; 0.3 NEAR of the key's allowance held per call until the refund).
- **Check after:** nearblocks.io/address/`<contract>.near` shows the deletion, and `view.mjs --keys
  <contract>.near` answers that the account does not exist.

## 0. Before you start

- Node 24 or later. From the repo root, run `npm ci`, then `npm run build` (the engine imports the built
  `@gimbal/shared`).
- The contract wasm: `cd contract && cargo near build non-reproducible-wasm --no-abi`. This writes
  `contract/target/near/gimbal.wasm`. The deploy dry run prints its size and sha256; compare them with the build
  you mean to ship.
- `.env` in the main checkout (a copy of `.env.example`, gitignored). The scripts read these entries. The shell
  environment wins over the file (with a warning for the settings `new()` fixes), and an empty value means
  "not set":

  | name | used by | |
  |---|---|---|
  | `ORDERLY_BROKER_ID` | deploy, desk | required; must be the engine's mainnet broker; `new()` fixes it for the contract's life |
  | `HL_REFERRAL_CODE`, `ORDERLY_REFERRAL_CODE`, `PHOENIX_REFERRAL_CODE` | deploy | empty → `null` (no code); fixed by `new()` |
  | `RELAYER_EVM_PRIVATE_KEY` | relayer-wallet | written by step 5 (`--write`) when empty |
  | `ARBITRUM_RPC_URL` | relayer-wallet `--check` | optional; default `https://arb1.arbitrum.io/rpc` |
  | `ONECLICK_API_KEY` | fund | optional; sent as a header only, never printed; without it 1Click adds 0.2 % |

  retire and fund read `SOLANA_RPC_URL`, `ARBITRUM_RPC_URL` and `HYPEREVM_RPC_URL` from the shell environment
  only (defaults `https://api.mainnet-beta.solana.com`, `https://arb1.arbitrum.io/rpc` and
  `https://rpc.hyperliquid.xyz/evm`) and print only their hosts.

  `NEAR_RPC_URL` is read from the **shell environment only**, never from `.env`, because `.env` often holds a
  testnet RPC. It is optional and tried first, before the public `free.rpc.fastnear.com` and `near.drpc.org`.
  (`rpc.mainnet.near.org` is deprecated and not used.)

- Key files: JSON with `account_id` and `private_key` (`ed25519:...`); `public_key` and `network` are optional
  and checked when present. This is the format near CLI keeps in its legacy credentials directory. The funder's
  key and the owner's key must be **full-access** keys of those accounts. The keys these scripts create go to
  `.keys/` (gitignored, file mode 0600).

Read-only helper for the checks below (nothing is signed):

```
node tools/mainnet/view.mjs <contract>.near config | version | prices
node tools/mainnet/view.mjs <contract>.near get_desk '{"desk_id":"<desk_id>"}'
node tools/mainnet/view.mjs --keys <account>.near
```

## 1. Policy

```
node tools/mainnet/policy.mjs
```

This rebuilds the canary policy from live Hyperliquid, Phoenix and Orderly data and compares it with
`tools/mainnet-canary-policy.json`. The assets are the contract's oracle assets (BTC, ETH, SOL, DOGE, LTC):
Hyperliquid index and szDecimals, Phoenix orderbook, lot and tick, and Orderly `PERP_<X>_USDC`. The limits are
20 USD per leg, a 100 bps price band, a 900 s oracle age, a 20 USD per hour rescue cap, transfer cost at most
300 bps / 1 USD, and nothing unpriced.

`node tools/mainnet/policy.mjs --final` does the same for the final contract, whose oracle assets add XLM
(OutLayer id `xlm`) and ZEC (`zec.omft.near`), against `tools/mainnet-final-policy.json`, with the same limits
but a 50 USD per hour rescue cap (`FINAL_LIMITS` in `venues.mjs`).
Phoenix lists both; Orderly lists `PERP_ZEC_USDC` but not `PERP_XLM_USDC` (only `PERP_XLM_USDC_mythos`, another
market), so the final policy trades XLM on Hyperliquid and Phoenix only. The prices step of `checks.mjs` refreshes
the oracle assets the desk's own policy trades, so it never asks the canary for XLM or ZEC.

Why 300 bps / 1 USD: the contract refuses a 1Click quote whose `amountIn - minAmountOut` is over
max(`amountIn` x `max_transfer_cost_bps`, `max_transfer_cost_flat_e6`). That gap is 1Click's fee plus the
slippage room, and `fund_venue` itself needs at least 0.5 % of room. Measured on mainnet quotes: 20 USDC from
NEAR to Hyperliquid may cost 0.52 USDC (about 2.6 %, most of it the HyperCore withdraw fee), 10 USDC to the
Orderly receiver 0.11 USDC, and without an API key 1Click adds 0.2 %. The old 100 bps / 0.5 USD refused the
Hyperliquid route outright. At canary sizes (under 33 USDC) the flat 1 USD decides. The same numbers bound the
hourly budgets: `fund_venue` may spend 4 x max(20 x 3 %, 1) = 4 USD an hour in transfer costs, the rescues
max(20 x 3 %, 2 x 1) = 2 USD (also at the final 50 USD cap: max(50 x 3 %, 2 x 1) = 2 USD).

Why the final cap is 50 USD: the contract counts a Hyperliquid rescue twice, its `hl_withdraw` and then its
bridge, and Hyperliquid's 1 USDC withdraw fee means the engine sends at least about 10.5 USDC to keep the fees
under 10 % of what it moves; at 20 USD no rescue out of Hyperliquid fits. Every rescue pays only the desk's own
pinned addresses, so the cap bounds what rescues may cost in fees, not what could be taken. The smallest rescue
per route at the final policy, with a 1Click key, in USD of margin the leg needs (engine/src/rescue/plan.ts):
reserve -> Hyperliquid 2.86, reserve -> Orderly any (it sends at least 6.20), Phoenix -> Hyperliquid 2.86 (up to
49.40), Hyperliquid -> Phoenix 10.39 (up to 24.31, the cap). A smaller rescue reduces both legs instead.

- **Cost:** none (public reads).
- **Check:** it ends with `tools/mainnet-canary-policy.json: matches live data` (exit 0). On a difference it
  exits 1 and lists the fields. Review them; `--write` updates the file, which then goes in through a PR. Step 3
  checks the policy again just before it sends.

## 2. Deploy the contract

```
node tools/mainnet/deploy.mjs <contract>.near --funder <funder>.near --key-file <funder key json> \
     --treasury-near <treasury>.near --hl-builder 0x<40 hex>
```

Read the dry run:

- **tx 1** (signed by the funder): `near.create_account` with the initial balance attached.
- **tx 2** (signed by the new account's own key): DeployContract plus `new(...)`:
  - network Mainnet, MPC `v1.signer`, oracle OutLayer `price-oracle.near`;
  - the treasury: the NEAR account, the HL builder lowercased, the referral codes from `.env`;
  - fees: 1000 bps performance, 10 tenth-bps builder fee;
  - Orderly: the broker from `.env` on chain 42161.
- **tx 3**, printed as its own later run: the **DeleteKey** that locks the account (final deploy only, section 8,
  "Final deploy"). `--send` never sends it. For a name with `canary` in it the dry run prints `tx 3: none: a
  canary is never locked (it gets retired)`.

Every value given to `new()` is permanent, so check each one now. The `env` lines show the broker id and
the referral codes in full and say where each came from; a `warning` line means the shell environment set it
over `.env`. The `methods` line shows whether the wasm has the money methods (see "What this contract version
can do"). The `treasury` line is a read-only `storage_balance_of` on USDC on NEAR
(`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) for the treasury: it must be registered,
else every fee transfer of `withdraw_to_owner` fails and the fee stays in the desk's `idle_usdc`, due again at the
next payout. When the line says `NOT registered`, register it before the first payout with a profit:
`storage_deposit({"account_id":"<treasury>","registration_only":true})` on that contract with 0.00125 NEAR
(anyone may pay it). The script refuses in these cases:

- the account exists (it never redeploys or migrates; it names the first free `<stem><n>.near` after it);
- `v1.signer`, `price-oracle.near` or the treasury does not exist;
- the balance is under code size × 1e19 + 0.5 NEAR;
- the funder cannot pay the balance + 0.2 NEAR;
- `ORDERLY_BROKER_ID` is empty, or is not the engine's mainnet broker (`woofi_dex`, the testnet broker, is
  refused by name);
- the key file is not a full-access key of the funder;
- with `--send`: the checkout is a linked git worktree.

It warns when the builder has under 100 USDC on Hyperliquid. Hyperliquid needs that before an order can carry
the builder fee; it is not needed to deploy.

Then send:

```
node tools/mainnet/deploy.mjs <same arguments> --send
```

This sends tx 1, waits for final, sends tx 2, waits for final, then prints both hashes (nearblocks links) and
`config()`, which it compares with the init args, and (not for a canary) the lock command. The new full-access
key is written to
`.keys/<contract>.near.json` (the script prints its absolute path). It is the contract account's only key.
**Back it up right after tx 1** (the script says `back up ... now` at that point), before anything else
happens. Without it nothing can sign for the account: no retry of tx 2, and no DeleteAccount to get the NEAR
back. If tx 1 went through and tx 2 failed, `--resume` (with the same arguments and `--send`) sends tx 2 only. It
works only while the account has no code and `.keys/<contract>.near.json` is its full-access key.

- **Cost:** the initial balance. The default is code size × 1e19 + 0.5 NEAR, rounded up to 0.1: **6.8 NEAR**
  for the C8 wasm (626,668 bytes). It moves from the funder to the contract and stays there until the account is
  retired: about 6.27 NEAR is held for the code's storage, and the rest pays tx 2's gas and the state. The funder
  needs the balance + 0.2 NEAR free, 7.0 NEAR. The dry run's `gas` line gives the most each transaction can burn,
  worked out from the live runtime fees:
  - tx 1: about 101.3 TGas (100 prepaid + action fees), at most about 0.0102 NEAR.
  - tx 2: about 146.4 TGas, at most about 0.0147 NEAR. That is 100 TGas prepaid for `new()`, about 45.2 TGas for
    DeployContract (about 71.4 Mgas per byte of wasm), and about 1.2 TGas of action fees.

  The unused part is refunded.
- **Check after:**
  - `view.mjs <contract>.near config` shows Mainnet, `v1.signer`, `price-oracle.near`, your treasury and the
    fees.
  - `view.mjs <contract>.near version` answers.
  - `view.mjs --keys <contract>.near` lists exactly one FullAccess key, the public key the deploy printed.
  - nearblocks.io/address/`<contract>.near` shows both transactions as successful.

## 3. Desk and operator key

```
node tools/mainnet/desk.mjs <contract>.near <desk_id> --owner <owner>.near --key-file <owner key json> \
     --policy tools/mainnet-canary-policy.json [--allowance 5]
```

The dry run also works before the contract exists, and without `--key-file`. It plans:

- **tx 1** (signed by the owner): `create_desk(desk_id, policy, evm_address, solana)` with 0.5 NEAR attached. The
  addresses come from `v1.signer.derived_public_key` for `gimbal/<desk_id>/evm` and `gimbal/<desk_id>/sol`, with
  the contract as predecessor, exactly as the testnet script derives them.
- **tx 2** (signed by the owner): AddKey on the owner's account. This is a new **FunctionCall** key for the
  engine, with receiver `<contract>.near`, allowance `--allowance` NEAR, and only the 21 operator methods
  (docs/interfaces.md §1.3, plus `set_paused`, which the engine may only use to pause). It is never a full-access
  key.
- The engine env file `.keys/engine-mainnet-<contract>.near.env` (names below; no value is printed).

It prints the desk's addresses with explorer links. Keep them for funding:

- the EVM address (Hyperliquid, Arbitrum);
- the Solana authority;
- the USDC and PhUSD token accounts;
- the Phoenix trader account;
- the Orderly account id.

It refuses in these cases:

- the policy does not match live data or breaks a contract rule;
- `config()` is not a Mainnet Gimbal contract with `v1.signer`, `price-oracle.near`, Orderly chain 42161 and the
  engine's mainnet broker;
- `ORDERLY_BROKER_ID` (printed in full) is not the contract's broker id, or not the engine's mainnet broker;
- the desk exists under another owner, or its stored addresses are not the MPC-derived ones;
- an operator key file exists but its key is on chain with other permissions;
- the owner cannot pay 0.5 + 0.2 NEAR;
- the key file is not the owner's full-access key;
- with `--send`: the checkout is a linked git worktree.

Then send:

```
node tools/mainnet/desk.mjs <same arguments> --send
```

This sends one transaction at a time and waits for final after each one. It writes
`.keys/operator-<contract>.near.json` before the AddKey, and writes the env file last; it prints the absolute
path of each. A rerun skips whatever is
already done (an existing desk, or an operator key already on chain), and when everything is done it says
`nothing to send`.

- **Cost:**
  - `create_desk`: 0.5 NEAR attached. The contract keeps what the desk's storage takes and refunds the rest.
  - Gas, from the dry run's `gas` line: `create_desk` can burn at most about 151.3 TGas (150 prepaid + action
    fees), about 0.0152 NEAR. AddKey burns about 0.5 TGas of action fees. The real total is about 0.002 NEAR.
  - The new key: a few hundred bytes of storage on the owner's account (a few thousandths of a NEAR held).
  - The allowance is not a transfer. It is the most the engine's key may burn on gas from the owner's balance.
- **Check after:**
  - The same dry-run command now prints `nothing to send`.
  - `view.mjs <contract>.near get_desk '{"desk_id":"<desk_id>"}'` shows the policy and the addresses above.
  - `view.mjs --keys <owner>.near` lists the new FunctionCall key: receiver `<contract>.near`, the allowance and
    21 methods.
  - `.keys/operator-<contract>.near.json` and `.keys/engine-mainnet-<contract>.near.env` exist.

## 4. Funding

Funding goes through the contract, never straight to a desk address: the owner deposits USDC on NEAR into the
desk (`deposit.mjs`), and the engine's key sends it to a venue with `fund_venue` (`fund.mjs`). Section 8 has the
commands. **Send nothing to the desk's addresses on a contract without the money methods.** Until a desk is
funded, the setup steps in step 6 that depend on funding stay waiting or fail, and that is expected:

- **Hyperliquid:** `hl_set_referrer` and `hl_approve_builder_fee` need the desk's EVM address to exist on
  Hyperliquid, which happens with its first USDC deposit. Until then those two steps wait; run POST /setup
  again after the deposit.
- **Phoenix:** the desk's Solana authority is the fee payer of the registration transaction
  (`engine/src/setup/phoenix.ts`), so it likely needs a little SOL before `phoenix_register` can succeed: at least
  the 0.000005 SOL signature fee. Whether it also pays the trader account's rent is not checked yet.
- **Orderly:** after `orderly_receiver_lookup`, the owner pins the receiver with `set_orderly_receiver` (an
  owner call, not part of this runbook).

## 5. Relayer wallet

```
node tools/mainnet/relayer-wallet.mjs
node tools/mainnet/relayer-wallet.mjs --write
node tools/mainnet/relayer-wallet.mjs --check
```

- Without a flag, the script is a dry run. If `.env` already has the key, it prints the wallet's address;
  otherwise it says what `--write` would do. It writes nothing.
- `--write` (from the main checkout) puts a new key into `.env` `RELAYER_EVM_PRIVATE_KEY`, but only when that
  entry is empty; it never overwrites. It prints the absolute path of the file and the address, never the key.
- Send a few dollars of ETH on **Arbitrum One** to that address. This wallet is not a desk address: it pays gas
  for the Orderly money path (it submits the EIP-3009 transfers the contract signed) and never holds desk money.
- `--check` confirms that the RPC answers chain 42161 and prints the wallet's ETH balance.

Venue setup (step 6) does not use this wallet; the bridge stage of `hl-return.mjs` (section 8, step 9) does.

- **Cost:** the ETH you send (a few dollars).
- **Check after:** `--check` shows the balance, and arbiscan.io/address/`<address>` shows the transfer.

## 6. Engine in mainnet mode: venue setup

From the repo root, with the env file that step 3 wrote:

```
GIMBAL_SETUP=1 node --env-file=.keys/engine-mainnet-<contract>.near.env engine/src/cli/serve.ts
```

(In PowerShell, run `$env:GIMBAL_SETUP='1'` first, then the same `node` command.)

- Only that file is loaded, not `.env`, so a testnet value in `.env` cannot slip in. Variables already set in the
  shell override the file.
- `GIMBAL_SETUP=1` turns on POST /setup, the only part of the engine that signs (through `OPERATOR_PRIVATE_KEY`).
- The engine refuses to start if `NEAR_NETWORK` and `GIMBAL_MODE` differ, if the contract id is not a `.near`
  account, if `config().network` is not mainnet, or if `HL_API_URL` / `ORDERLY_API_URL` look like testnet URLs.
- When it is ready it logs `venue setup: on (POST /setup), operator <owner>.near, mainnet`. Stop it with Ctrl+C.

In a second terminal:

```
curl -s -X POST http://127.0.0.1:8790/setup -H 'content-type: application/json' -d '{"deskId":"<desk_id>"}'
curl -s http://127.0.0.1:8790/state
curl -sN http://127.0.0.1:8790/events
```

- POST /setup answers `{"ok":true}` when the run has started, or `{"ok":false,"reason":...}` when it did not
  start. Without `content-type: application/json` it is refused (415).
- Progress is the `setup` entry of GET /state, or the `setup` events on /events. Each step is `pending`,
  `running`, `done`, `skipped` or `failed`, with `detail` and its transactions.
- The steps, in order:
  - `hl_set_referrer`, `hl_approve_builder_fee`
  - `orderly_register`, `orderly_add_key`, `orderly_receiver_lookup`, `orderly_referral_bind`, `orderly_ip_restriction`
  - `phoenix_register`, `phoenix_referral`
- Each step reads the venue first and skips what is already done, so running POST /setup again is safe. A
  referral step without a code is `skipped`. `orderly_ip_restriction` is skipped without a `set_orderly_ips` list.

- **Cost:** each operator call reserves about 0.3 NEAR of gas, held against both the key's allowance and the
  owner's balance until the refund. The real fee is about 0.001 NEAR. The contract pays 1 yoctoNEAR per MPC
  signature. Before funding, setup makes a handful of signed calls:
  - Orderly register and add-key;
  - the Phoenix registration;
  - the referral activations, only when codes are set.

  After the Hyperliquid deposit it makes up to two more. In total it costs well under 0.05 NEAR. Keep
  0.3 NEAR free per call in flight.
- **Check after:**
  - Before funding, the Orderly steps should end `done` or `skipped`. The two Hyperliquid steps wait for a
    deposit, and `phoenix_register` may fail for want of SOL. Both are expected until the desk is funded
    (section 8).
  - The Orderly `get_account` link printed in step 3 answers.
  - nearblocks.io/address/`<owner>.near` shows the operator key's calls to `<contract>.near`.
  - Later, once funded: every step is `done` or `skipped`, and solscan shows the Phoenix trader account.

## 7. Canary checks without USDC

```
node tools/mainnet/checks.mjs <contract>.near <desk_id> [--step prices|orderly|quotes] [--env-file <file>]
node tools/mainnet/checks.mjs <contract>.near <desk_id> [--step prices|orderly|quotes] --send
```

Three checks that move no funds. Without `--step` it runs all three, in this order. Each step can also run alone,
and running it again is safe.

- **prices:** one `refresh_prices` for BTC, ETH, SOL, DOGE and LTC, signed by the engine's operator key. This is
  the first OutLayer price call. The contract attaches 0.02 NEAR to `price-oracle.near` from its own balance (most
  of it comes back), and the caller pays the gas. The step prints every receipt with its gas and logs, the gas and
  NEAR burnt, the change in the contract's balance, the caller's balance and the key's allowance, and `prices()`.
  OutLayer answers asynchronously, so `prices()` is read every 5 s for up to 3 min until each asset has a newer
  price. A second run within 30 s asks the oracle nothing (the contract's own skip).
- **orderly:** under the contract's broker (`gimbal_dex`) on its chain (42161). The step uses the engine's own
  setup code (`runSetup`, `OrderlyDeskClient`, `NearContractClient`) cut down to three steps:
  - `orderly_register`, skipped when Orderly already has the account;
  - `orderly_add_key`, skipped when the desk's key is active with the trading scope;
  - the signed GET `/v1/client/asset/receiver_address?chain_id=42161&token=USDC`. The whole answer is printed.

  It binds no referral code and sets no IP restriction. It does not pin the receiver: `set_orderly_receiver` is
  the owner's call.
- **quotes:** dry 1Click quotes (`dry: true`). They reserve no deposit address. The step asks two quotes out of
  HyperCore: to the desk's Solana authority (Solana USDC), and to the contract with `{"desk_id":"<desk_id>"}`
  (USDC on NEAR). It also asks one control quote into HyperCore. The question is whether 1Click still answers
  "Quoting for this pair is not available". These quotes are reads, so the dry run asks them too.

The dry run needs no key. It prints every call with its public values in full: signer, receiver, method, args,
gas, the Orderly URLs and headers, and the quote bodies. It also prints the Orderly account's state and the
balances.

`--send` works like this:

- It reads `.keys/engine-mainnet-<contract>.near.env` (or `--env-file`), and only at that point.
- It checks the file against the chain before it signs anything: the network, the contract, the desk, the
  owner or operator account, and the broker. The key must be on chain as the operator FunctionCall key.
- It never prints the key.
- It refuses in a linked git worktree.

The script can make only these contract calls: `refresh_prices`, `orderly_register`, `orderly_add_key`, and
`orderly_request` of kind `receiver_address`. It refuses any other call (a money method, another Orderly kind,
another contract) before signing. It writes no file. It ends with one block, `=== gimbal canary checks ... ===`
to `=== end ===`, to paste back.

- **Cost:** each signed call reserves about 0.3 NEAR of gas against the key's allowance until the refund.
  - `refresh_prices` burns at most the gas cap in the dry run's `gas` line (about 0.03 NEAR), and most of that is
    refunded. On top of that, OutLayer keeps part of the 0.02 NEAR the contract attaches.
  - The Orderly step makes at most three MPC calls, each about 0.001 NEAR plus 1 yoctoNEAR.
  - The quotes are free.
- **Check after:**
  - `view.mjs <contract>.near prices` lists the five assets.
  - `https://api.orderly.org/v1/get_account?address=<desk EVM>&broker_id=gimbal_dex` answers with the desk's
    account id.
  - Running the orderly step again prints `orderly_register done` and `orderly_add_key done` without signing
    either.

## 8. Canary 2 with money

The second canary: retire `gimbal-canary.near`, deploy the C8 code to a fresh account, **`gimbal-canary2.near`**
(free on 2026-11-01; the deploy dry run checks it again), create its desk `canary`, and put a small amount of
USDC through it: deposit, fund one venue, withdraw back to the owner. Run every command from the main checkout,
in this order, the dry run first and `--send` only after reading it. Each script ends with one block,
`=== gimbal <script> ... ===` to `=== end ===`: paste it back.

What it takes, in all: **about 30 USDC on NEAR** on the owner for the first pair (12 to Hyperliquid, the rest
stays idle or funds the second leg), and NEAR: 7.0 free on the funder for the deploy (the retirement returns
about 6.3), 0.7 free on the owner for the desk, and 0.3 NEAR free on the owner per operator call in flight.

1. **Retire the old canary** ("Retiring a canary"):

   ```
   node tools/mainnet/retire.mjs gimbal-canary.near
   node tools/mainnet/retire.mjs gimbal-canary.near --send --engine-stopped
   ```

   The dry run prints the creator (the beneficiary), every desk balance (all 0 on 2026-11-01), the contract's
   USDC (not registered on USDC on 2026-11-01, so no `--unregister-usdc` step) and the DeleteAccount. Stop the
   engine first. `--send` reads the Orderly holding and positions with two signed calls, every balance again (NEAR
   side last), and deletes. Returns about **6.30 NEAR** to the funder; costs under 0.001 NEAR.

2. **Policy:** `node tools/mainnet/policy.mjs` must end `matches live data` (section 1; 300 bps / 1 USD).

3. **Deploy** (section 2):

   ```
   node tools/mainnet/deploy.mjs gimbal-canary2.near --funder <funder>.near --key-file <funder key json> \
        --treasury-near <treasury> --hl-builder 0x<40 hex>
   node tools/mainnet/deploy.mjs <same arguments> --send
   ```

   Check `methods ... ft_on_transfer yes, fund_venue yes, withdraw_to_owner yes, clear_payout_lock yes`, the
   `treasury ... is registered on USDC on NEAR` line, and `contract gimbal-canary2.near: does not exist: the name
   is free`. Costs **6.8 NEAR** (stays in the contract) plus at most 0.025 NEAR of gas; the funder needs 7.0 free.
   Back up `.keys/gimbal-canary2.near.json` right after tx 1.

4. **Desk** (section 3):

   ```
   node tools/mainnet/desk.mjs gimbal-canary2.near canary --owner <owner>.near --key-file <owner key json> \
        --policy tools/mainnet-canary-policy.json
   node tools/mainnet/desk.mjs <same arguments> --send
   ```

   0.5 NEAR attached to `create_desk`; the C8 contract keeps what the desk's storage takes (about 0.04 to 0.12
   NEAR) and refunds the rest. It writes `.keys/operator-gimbal-canary2.near.json` and
   `.keys/engine-mainnet-gimbal-canary2.near.env`. New desk addresses: everything in sections 6 and 7 is for this
   desk and must be run again.

5. **Venue setup and checks for the new desk:** section 6 with `.keys/engine-mainnet-gimbal-canary2.near.env`
   (Orderly `done`; the Hyperliquid steps wait for step 7), then section 7:

   ```
   node tools/mainnet/checks.mjs gimbal-canary2.near canary
   node tools/mainnet/checks.mjs gimbal-canary2.near canary --send
   ```

   `refresh_prices` goes out at 300 TGas (the C8 contract refuses under 240). To fund Orderly later, the owner
   pins the receiver that the orderly step prints with `set_orderly_receiver` (not in these tools).

6. **Deposit** 30 USDC from the owner:

   ```
   node tools/mainnet/deposit.mjs gimbal-canary2.near canary 30
   node tools/mainnet/deposit.mjs gimbal-canary2.near canary 30 --key-file <owner key json> --send
   ```

   The dry run prints, when the contract is not on USDC yet (a new one never is), tx 1:
   `storage_deposit({"account_id":"gimbal-canary2.near","registration_only":true})` with 0.00125 NEAR; then
   `ft_transfer_call` on USDC with `{"receiver_id":"gimbal-canary2.near","amount":"30000000","msg":"{\"desk_id\":\"canary\"}"}`,
   1 yoctoNEAR, 150 TGas, and the ledger it expects (`deposited` and `idle_usdc` up by 30). It refuses while the
   owner holds less than the amount on NEAR. `--key-file` must be the owner's full-access key (`.keys/` has none:
   point it at the owner's wallet key file). After: the `deposit` event, `ft_transfer_call` returned the whole
   amount, and the ledger. Costs about 0.00125 NEAR plus gas (keep 0.05 NEAR free).

7. **Fund Hyperliquid** with 12 USDC:

   ```
   node tools/mainnet/fund.mjs gimbal-canary2.near canary hyperliquid 12
   node tools/mainnet/fund.mjs gimbal-canary2.near canary hyperliquid 12 --send
   ```

   The dry run asks a **dry** 1Click quote (it reserves nothing): USDC on NEAR -> HyperCore USDC, `refundTo` the
   owner, `recipient` the desk's EVM address, 100 bps slippage. It checks it with the contract's rules (1Click's
   signature, the fields, at least 50 bps of room below `amountOut`, the cost bound, the hourly budget) and prints
   `fund_venue(desk_id, quote, quote_signature, reason)` in full, 300 TGas, signed by the operator key. Measured
   on 2026-11-01: 12 USDC may cost 0.44 USDC of the 1 USD allowed, with 102 bps of room. `--send` asks a **live**
   quote only after every other check passed, checks it the same way and against what you typed (the venue's
   `recipient` and `destinationAsset`, `amountIn` = the amount in 6-decimal base units, `slippageTolerance` =
   `--slippage-bps`; any mismatch refuses before signing), sends `fund_venue`, posts the deposit to 1Click and
   polls its status and the venue (`--timeout-s`, default 900). `landed: yes` means 1Click SUCCESS **and** the
   venue's own record of the delivery: on Hyperliquid an incoming entry (`deposit`, `send`, `internalTransfer` or
   `spotTransfer`) to the desk address in its non-funding ledger since the `fund_venue`, of at least
   `minAmountOut` (a balance also moves with PnL, so it is shown only); on Solana the USDC token account up by at
   least `minAmountOut`. Without such an entry, and always on Orderly (its holding is not public), it says
   `landed: unconfirmed`.
   A refund goes to the owner on NEAR, not to the desk. After it lands, run POST /setup again (section 6) for
   `hl_set_referrer` and `hl_approve_builder_fee`. The same command with `solana 8` funds the Phoenix leg (the
   Solana authority also needs a little SOL, which 1Click does not send); `orderly` needs the pinned receiver and
   at least 7 USDC.
   `--send` takes the live rescuer's lock of the contract and desk for its whole run, as `hl-return.mjs` does
   (step 9), and refuses before reading anything or signing while a rescuer holds it: the rescuer's reserve route
   is `fund_venue` too, with the same idle USDC, `fund_venue` ring and hourly cost budget. Stop the rescuer first;
   one started meanwhile refuses to start. The dry run prints whether the lock is held.

8. **Withdraw** 5 USDC back to the owner:

   ```
   node tools/mainnet/withdraw.mjs gimbal-canary2.near canary 5
   node tools/mainnet/withdraw.mjs gimbal-canary2.near canary 5 --key-file <owner key json> --send
   ```

   The dry run prints `withdraw_to_owner({"desk_id":"canary","amount":"5000000"})` with 1 yoctoNEAR and 300 TGas
   (the contract refuses under 150) and the expected split before anything is sent: with no profit yet the fee is
   0 and all 5 USDC go to the owner. It refuses an amount over `idle_usdc` (USDC on a venue must come back first)
   and an owner not registered on USDC. `--send` prints the events and the ledger after: `payout`, and
   `fee_charged` only when a fee above 0 reached the treasury (a payout with no fee logs `payout` alone). `all`
   withdraws the whole `idle_usdc`.

9. **Return from Hyperliquid** to the desk on NEAR, through Arbitrum (1Click quotes nothing out of HyperCore,
   "What this contract version can do"). Two stages, each with its dry run first:

   ```
   node tools/mainnet/hl-return.mjs gimbal-canary2.near canary withdraw all
   node tools/mainnet/hl-return.mjs gimbal-canary2.near canary withdraw all --key-file <owner key json> --send
   node tools/mainnet/hl-return.mjs gimbal-canary2.near canary bridge all
   node tools/mainnet/hl-return.mjs gimbal-canary2.near canary bridge all --send
   ```

   - **withdraw** (owner): reads the desk's Hyperliquid perps `withdrawable` and its Arbitrum USDC, and prints
     `hl_withdraw({"desk_id":"canary","amount":"11.682396"})` (the amount as a decimal string with at most 6
     decimals, as `hl_usd_class_transfer` takes it) with 1 yoctoNEAR and 300 TGas (an action method needs 85). It
     refuses an amount over the withdrawable or not above Hyperliquid's 1 USDC fee; `all` is the withdrawable.
     `--send` needs the owner's full-access key: the contract signs a Hyperliquid `withdraw3` to the desk's own
     EVM address (checked: destination, amount, `hyperliquidChain` `Mainnet`, `signatureChainId` `0x66eee`), the
     script posts it to `/exchange` (the engine's Hyperliquid submitter, which waits 5 s for the ledger), then says
     what it waits for and reads, together until `--timeout-s` (default 900), Hyperliquid's non-funding ledger for
     the `withdraw` and the desk EVM's Arbitrum USDC until it is up by amount - 1, with a progress line each minute:
     `arrived: yes` or `not yet`. Hyperliquid books the withdraw with `nonce` = the withdraw3 `time` x 1000 and
     `usdc` = amount - fee (mainnet, 2026-11-03: `{"type":"withdraw","usdc":"10.682396","nonce":1793669928713000,
     "fee":"1.0"}` about 231 s after time 1793669928713). The dry run warns when what arrives is over the desk's
     hourly rescue cap (the bridge then goes in parts). Dry run on 2026-11-03: 11.682396 withdrawable, 10.682396
     expected on Arbitrum.
   - **bridge** (the operator key, default `.keys/operator-<contract>.json`, and the relayer wallet of section 5):
     reads the desk EVM's Arbitrum USDC (`all` = the whole balance), asks a dry 1Click quote Arbitrum USDC ->
     USDC on NEAR, `recipient` the contract with `customRecipientMsg` `{"desk_id":"canary"}`, `refundTo` the desk
     EVM address, 100 bps (`--slippage-bps`), and checks it with the contract's rules (signature, fields, the
     policy's cost bound, the hourly rescue cap and cost budget: 20 USD and 2 USD an hour on the canary, so more
     than 20 USDC goes in parts an hour apart). It checks that the relayer wallet exists and holds ETH for one
     transfer. The dry run shows the quote even when the USDC is not on Arbitrum yet, then lists what `--send`
     would refuse. `--send` refuses a short balance or a missing or empty relayer before it asks a live quote,
     checks the live quote the same way and against what was asked, sends `evm_usdc_to_intents` (an EIP-3009
     authorization from the desk EVM to the deposit address, valid 300 s), has the relayer submit it on Arbitrum
     (the engine's Arbitrum submitter; the relayer pays the gas), posts the deposit to 1Click and polls its status
     and the desk's ledger. `landed: yes` means 1Click SUCCESS **and** `idle_usdc` up by at least
     `minAmountOut`; it also prints the contract's `deposit` event. 1Click delivers from its own account, not the
     owner's, so the credit is `idle_usdc` only (`principal: false`, `deposited` unchanged): at a payout it counts
     toward profit only once the owner's withdrawals pass what they deposited. A refund goes to the desk EVM
     address on Arbitrum: bridge again. Dry run on 2026-11-03 for 10.6 USDC: `amountOut` 10.598642,
     `minAmountOut` 10.492655, may cost 0.107 of the 1 USD allowed, 25 s. On mainnet the same day, bridge 2 and
     bridge all (8.682396) each landed in about 45 s, delivered by `ft_transfer_call` from `intents.near`
     (`deposit` event with `principal: false`).
   - **Cost:** the 1 USDC Hyperliquid fee, the 1Click cost (at most `amountIn` - `minAmountOut`; about 0.01 %
     expected on 2026-11-03), and the relayer's Arbitrum gas for one transfer (a fraction of a cent). Then step 8
     pays the `idle_usdc` out to the owner.
   - **Rerun midway:** each stage reads the chain again first. After a withdraw, Hyperliquid's withdrawable is
     already down, so a second `withdraw all` refuses (at most the 1 USDC fee left); both stages list Hyperliquid
     withdrawals of the last 24 h and mark those under 30 min old as possibly in flight. Before signing anything,
     `--send` also refuses (the dry run lists the same lines as `would refuse at --send`):
     - **withdraw**, while a Hyperliquid withdrawal under 30 min old exists, or while an earlier `hl_withdraw` of
       the desk (nearblocks, the last 2 days; the desk's Hyperliquid nonce from the contract state covers the
       last minutes nearblocks may not have indexed, and stands in when nearblocks cannot be read) has no
       `withdraw` in the ledger with its nonce: Hyperliquid takes a withdraw3 until about its time + 2 days (its
       nonce window), and the line prints that end. Each ledger entry books at most one call. Each earlier call
       prints as `booked` or `not in the Hyperliquid ledger`.
     - **bridge**, while an earlier `evm_usdc_to_intents` of the desk (nearblocks, the last 24 h) may still be
       used or has not settled: its authorization is valid until its block time + 300 s, and its deposit address
       (the quote's own `depositAddress`) must be 1Click `SUCCESS` or `REFUNDED`, or expired and still
       `PENDING_DEPOSIT`. `PROCESSING`, `KNOWN_DEPOSIT_TX`, `INCOMPLETE_DEPOSIT`, `FAILED` or an unreadable status
       refuse. For what nearblocks has not indexed yet, it also reads the desk's counters from the contract state:
       the EIP-3009 counter gives the last authorization's nonce (keccak256 of the desk id and the counter as a
       big-endian u64), and Arbitrum USDC's `authorizationState(desk EVM, nonce)` tells whether it was used. An
       unused one refuses until the newest rescue in the deposit ring is 300 s + 60 s old (the latest its
       validBefore can be). A used one refuses for 10 min when it is newer than every call nearblocks lists. This
       check runs before the live quote.
     - Anything unreadable refuses (fails closed): nearblocks, the contract state (the desk's Hyperliquid nonce
       or counters), or `authorizationState`. `--again` sends anyway and prints each overridden reason as
       `override:` in the block: use it only after reading the ledger or the 1Click status yourself.
     - Cases that refuse although nothing is wrong, and need `--again` once you have checked:
       - withdraw, for 10 min after any newer Hyperliquid action of the desk that nearblocks does not list as an
         `hl_withdraw` (an engine order, a transfer): the desk's nonce cannot tell which action it was;
       - bridge, for 10 min after any newer rescue of the desk (`hl_send_to_intents`, a Solana rescue) while the
         last authorization was used: the deposit ring is shared by all rescues;
       - bridge, for 24 h, when a 1Click deposit address of an earlier `evm_usdc_to_intents` never got its deposit
         and 1Click does not answer `PENDING_DEPOSIT` for it after the authorization expired (any other status or
         no answer counts as not settled).
     - **A live rescuer of the desk** (the engine's, `engine/src/rescue/lock.ts`): `--send` of either stage takes
       the rescuer's lock of the contract and desk for its whole run (on Windows the named pipe
       `\\.\pipe\gimbal-rescue-mainnet-<contract>-<desk>`) and refuses, before reading anything or signing, while a
       rescuer holds it. Both sign with the desk's EIP-3009 counter, spend its Arbitrum USDC and count against its
       rescue cap, so they must not run together; `--again` does not lift this: stop the rescuer first. A rescuer
       started meanwhile refuses to start. The dry run prints whether the lock is held.

     The bridge moves only USDC that is on Arbitrum: with some still in flight, `all` takes what arrived, and a
     typed amount over the balance refuses at `--send`. If the relayer's outcome is unknown, the block names the
     authorization and its expiry: do not bridge again before then (it may still execute); afterwards the balance
     tells. When the NEAR transaction itself fails (or its outcome or SignedAction cannot be read), the block ends
     with an `open:` line: a signature may already be public. For withdraw, a late withdraw3 can still be posted
     within Hyperliquid's nonce window: check the ledger before any rerun. For bridge, the rescue is counted and a
     late authorization is valid until block time + 300 s: do not rerun before then. The contract's deposit ring
     refuses a deposit address paid before, and USDC refuses an authorization used before.

### Final deploy: deploy, check, lock

The final reviewed deploy ends with **no access key on the contract account**, so no key, ours included, can
deploy new code to it, sign for it or retire it. No key can move its NEAR either; only the contract's own methods
spend it (`refresh_prices`' oracle deposit, refunds). The canaries are never locked (they get retired): `--lock`
refuses any name with `canary` in it. Lock before any USDC goes in, and only after the checks below. Run every
command from the main checkout, the dry run first:

1. **Policy:** `node tools/mainnet/policy.mjs` ends `matches live data`.
2. **Reproducible build** of the reviewed commit, from a clean checkout whose commit is pushed:

   ```
   cd contract && cargo near build reproducible-wasm
   ```

   It builds inside the Docker image pinned in `contract/Cargo.toml` and writes the image, the command and the
   source (`git+<repo>?rev=<commit>`) into the wasm's NEP-330 metadata (`contract_source_metadata()`'s
   `build_info`), so anyone with that commit and the image can build the same bytes and compare the code hash.
   It needs:
   - **Docker's engine running** (start Docker Desktop; `docker version` must show a Server section);
   - a `[package.metadata.near.reproducible_build]` section in `contract/Cargo.toml` (the image, its digest and
     the build command). **On 2026-11-03 the section is missing** (a contract PR adds it), and Docker Desktop is
     installed but its engine was not running.

   The lock reads which kind of build the wasm is, and refuses a non-reproducible one unless `--non-reproducible`
   (step 5). The repo is public from the hackathon submission; the commit is named so anyone can rebuild it then.
3. **Deploy** (section 2) to a fresh `<contract>.near`:

   ```
   node tools/mainnet/deploy.mjs <contract>.near --funder <funder>.near --key-file <funder key json> \
        --treasury-near <treasury> --hl-builder 0x<40 hex>
   node tools/mainnet/deploy.mjs <same arguments> --send
   ```

   The dry run's `build` line says `reproducible` (with the image and the source) or `non-reproducible`; it
   prints tx 1, tx 2 and tx 3 (the DeleteKey) as its own later run. `--send` sends tx 1 and tx 2 only, and ends
   with the lock command (`--lock`, then the same with `--send --confirm-lock <contract>.near`).
4. **Check the deployed contract** before locking it: `view.mjs <contract>.near config` and `version`,
   `view.mjs --keys <contract>.near` (exactly one FullAccess key, the one the deploy printed), and both
   transactions on nearblocks.io/address/`<contract>.near`. After the lock nothing can be fixed: a wrong treasury,
   referral code or broker stays for good.
5. **Lock** (tx 3):

   ```
   node tools/mainnet/deploy.mjs <contract>.near --lock --treasury-near <treasury> --hl-builder 0x<40 hex>
   node tools/mainnet/deploy.mjs <contract>.near --lock --treasury-near <treasury> --hl-builder 0x<40 hex> \
        --send --confirm-lock <contract>.near
   ```

   `--lock` is its own run on an account deployed earlier: it takes no `--funder`, `--key-file`, `--balance` or
   `--resume`, so it also works as the resume after a lock whose outcome was not seen. It refuses any name with
   `canary` in it. `--lock --send` needs `--treasury-near`, `--hl-builder` and `--confirm-lock` with the contract
   account typed again exactly; the dry run may leave out the treasury and the builder (then `config()`'s are taken
   as they are, with a warning). It reads `.env` for the broker and the referral codes, like the deploy. Before
   signing it checks, and the dry run prints each check:
   - the checkout: clean (`git status --porcelain` empty) and its commit on a branch of `origin`
     (`refs/remotes/origin/*`, no other remote), read after `git fetch --prune origin` (a failed fetch counts as
     not pushed);
   - the build: the wasm's NEP-330 `build_info` is filled (a reproducible build), its snapshot names
     `https://github.com/winchxyz/gimbal`, and the commit it names is the checkout's `HEAD` (else it refuses:
     check out that commit and lock from there). The lock does not rebuild a reproducible wasm in Docker: the
     evidence says what its `build_info` names, and anyone can rebuild that to compare. A non-reproducible wasm is
     refused, with why `reproducible-wasm` cannot run here now (Docker not installed, Docker's engine not running:
     "start Docker Desktop", or the missing `Cargo.toml` section), unless `--non-reproducible`, which rebuilds it
     first (below);
   - the wasm exports every method a locked contract needs, since its code never changes again: every method
     of the table in `docs/interfaces.md` §1.3 (owner, operator and public ones), every view on its `Views:` line
     (`config`, `get_desk`, `desks_of`, `prices`, `version`) and every `#[private]` callback in `contract/src`
     (`on_signed`, the payout callbacks, ...; 44 in all on 2026-11-03). The list is read from this checkout, not
     kept by hand, so a method the table, the views or the contract gains is required from then on; a missing one
     is named and refused. The reading refuses rather than guesses: a table row whose method is not
     `` `name(args)` `` in lowercase, a `#[private]` it cannot match to a `pub fn`, no contract source, or a table
     without the money methods, `panic_close`, `hl_withdraw`, `hl_send_to_intents`, `evm_usdc_to_intents` or the
     five views;
   - `code_hash` (`view_account`) equals the base58 sha256 of `contract/target/near/gimbal.wasm`;
   - `version()` equals the `[package]` version in `contract/Cargo.toml` (and the version in the wasm's metadata);
   - `config()` is exactly what `new()` was given on mainnet: Mainnet, `v1.signer`, OutLayer `price-oracle.near`,
     fees 1000 / 10, Orderly `gimbal_dex` on 42161, the referral codes from `.env`, the treasury and the builder
     (every differing field is printed);
   - the treasury exists and is registered on USDC on NEAR (as the deploy checks it);
   - `view_access_key_list` is exactly one key, the FullAccess key in `.keys/<contract>.near.json`. Any other key
     is printed and refused: whoever holds it could still deploy code after the lock.

   The `balance` line prints the NEAR free above storage: after the lock no key can move it; only the contract's
   own methods spend it (`refresh_prices`' oracle deposit, refunds).

   **`--non-reproducible`** (while the reproducible build cannot run): the wasm on disk may be any earlier build,
   so the lock deletes `contract/target/near/gimbal.wasm`, rebuilds it in the clean checkout (`cd contract &&
   cargo near build non-reproducible-wasm --no-abi`, minutes), reads the checkout again (the build must not change
   it: commit what it writes), and only those bytes are compared with the deployed `code_hash`. It refuses a dirty
   checkout, a set `CARGO_TARGET_DIR` or `CARGO_BUILD_TARGET_DIR`, a wasm still there after the deletion, a failed
   build, a build that wrote no file (a file time older than the rebuild is only a warning: the file did not exist
   before the build, and a copy keeps its source's time), a file that cargo-near says it wrote elsewhere (its
   `- Binary:` line, colours stripped), a rebuilt file with a non-null `build_info` (not what
   non-reproducible-wasm writes, so a stale file) and a different hash. The evidence then says exactly that:
   rebuilt from that clean commit, with that cargo-near and rustc, the sha256 equals the deployed code; another
   machine may not rebuild the same bytes. The dry run rebuilds too.

   It refuses when any check fails, when the account does not exist or has no code, and on any chain but mainnet
   (testnet contracts stay upgradeable; there is no flag for testnet). `--send` sends one DeleteKey of that key,
   signed by that key itself, waits for final, then reads `view_access_key_list` (it must be empty) and
   `code_hash` (unchanged). If the DeleteKey fails, read the key list (rerun the `--lock` dry run) before anything
   else.

   - **Cost:** the DeleteKey's action fees, at most about 0.5 TGas (under 0.0001 NEAR) from the contract's balance.
   - **After:** `.keys/<contract>.near.json` is on no account any more and can sign nothing: you can delete it.
     No key can move the contract's NEAR; only its own methods spend it (anyone can still send it NEAR).
   - **Rerun:** an account that has no keys already prints `nothing to send` and the evidence block below
     without the hash: take the DeleteKey's hash from nearblocks.io/address/`<contract>.near`.

6. **Evidence:** `--send` ends with a block to paste back:

   ```
   === gimbal lock <time> ===
   contract:  <contract>.near https://nearblocks.io/address/<contract>.near
   DeleteKey: tx <hash> https://nearblocks.io/txns/<hash>
   code_hash: <base58>
   sha256:    <hex> (contract/target/near/gimbal.wasm, <bytes> bytes)
   version:   <version> (contract/Cargo.toml, version() on chain)
   checkout:  commit <commit>, clean, on a branch of origin after git fetch --prune origin
   build:     reproducible: its NEP-330 build_info names cargo near build reproducible-wasm, image <image@digest>, source git+https://github.com/winchxyz/gimbal?rev=<commit> (not rebuilt by this run)
   keys:      view_access_key_list is empty
   README:
   Contract has no access keys: DeleteKey tx <hash> (https://nearblocks.io/txns/<hash>), code_hash <base58> (sha256 <hex>); its NEP-330 build_info names a reproducible build (<image@digest>) of git+https://github.com/winchxyz/gimbal?rev=<commit>.
   === end ===
   ```

   The last line goes into the project README (the mainnet evidence and security sections). Anyone can check the
   lock: `view.mjs --keys <contract>.near` lists no key and nearblocks shows the DeleteKey. With a reproducible
   build anyone can also rebuild the named commit in the named image and get the same `code_hash`.

   With `--non-reproducible` the `build` line and the README line say only what the run verified:
   `Contract has no access keys: DeleteKey tx <hash> (<link>), code_hash <base58>. Its code is a non-reproducible
   build of commit <commit> (cargo-near <version>, rustc <version>): rebuilt from that clean commit when it was
   locked, its sha256 <hex> equals the deployed code; another machine may not rebuild the same bytes.` The repo
   is public from the hackathon submission; the commit is named so anyone can rebuild it then.

Then the desk and the money steps (steps 4 to 9 above) run as for the canary: none of them needs the contract
account's key.

## Access keys

`node tools/mainnet/keys.mjs list <owner>.near` prints every access key of an account with its permission: FullAccess,
or FunctionCall with the receiver (and whether that account exists and has code), the methods and the allowance left.
It only reads. `node tools/mainnet/keys.mjs delete <owner>.near <public_key> --key-file <owner key json>` plans one
DeleteKey and signs nothing; add `--send`, from the main checkout, to send it. It refuses a key the account does not
have, a full-access key, and at `--send` a key file that is not a full-access key of the account or that is the key
to delete. Use it to remove an operator key whose contract was retired (receiver `gimbal-canary.near`): a retired
name can be registered again by anyone.

## 9. The carry pair: short Hyperliquid, long Phoenix

`engine/src/cli/pair-mainnet.ts` (`npm run pair-mainnet -w engine -- ...`) is a dry run unless `--send` is given,
and `--send` refuses in a linked worktree. Pass the engine env file by path:

```
node --env-file=.keys/engine-mainnet-<contract>.near.env engine/src/cli/pair-mainnet.ts status
node --env-file=... engine/src/cli/pair-mainnet.ts fund-phoenix 15            # USDC -> Ember wrap -> Phoenix deposit
node --env-file=... engine/src/cli/pair-mainnet.ts defund-phoenix all         # Phoenix withdraw -> Ember unwrap -> USDC
node --env-file=... engine/src/cli/pair-mainnet.ts open ETH 15 --short hyperliquid --long phoenix --leverage 2
node --env-file=... engine/src/cli/pair-mainnet.ts close ETH
```

- Every Phoenix transaction is one legacy message signed by `sol_sign` (compute budget first, fee at most 600,000
  lamports; orders at the 600k unit limit and `--priority-microlamports`, default 100,000, at most 200,000). The money
  moves print the message, its instructions and a simulation, and refuse at `--send` when the simulation fails or
  did not run. The desk authority pays the Solana fees, so it needs SOL: `status` prints the balance and every
  command says how much more to send.
- Before the first deposit the desk's Phoenix trader must be registered (`phoenix_register` in the venue setup,
  signed with `sol_sign_register`). `defund-phoenix all` refuses while Phoenix holds a position; an amount must leave
  the cross subaccount under the leverage cap and more than 40 % from liquidation, valued at the mark. Only a trader
  proven unregistered skips the check: a trader state or account that cannot be read refuses the withdrawal.
- `open` prints both legs' funding (now and the 7-day mean), the gross APR, the spread expected over `--hold-days`
  against the round trip (taker fees, half spreads, `--basis-bps`), the size, the effective leverage and the
  liquidation distance per leg, and simulates the Phoenix IOC unsigned. It refuses when the spread does not cover the
  round trip, a leg is 40 % or less from liquidation, legUsd is over `max_notional_usd` less the band (19.80 at 20 and
  100 bps), the IOC simulation fails or uses more than 560k units, the policy's Phoenix market differs from the
  exchange's (orderbook, spline, lot, tick) or the market is not active, the Hyperliquid coin is not in cross
  margin, or Hyperliquid has a resting order for the coin (an earlier run's post-only order could fill outside the
  pair; an open-orders read that fails refuses too). Equity, maintenance and open notional are the cross margin of each venue, notional at the mark. `close`
  takes a market in maintenance or suspended (its orders are reduce-only), never an orderbook, lot or tick mismatch.
- Leverage: the contract has no update-leverage action, so Hyperliquid keeps the account's own setting. What is
  checked is each leg's effective leverage, (notional already open + legUsd) / equity: at most `--leverage` (2 or
  less), and at most 1.5 on a venue without a live rescue (`LIVE_RESCUE` in `engine/src/trade/carry-plan.ts`:
  Phoenix until the Phoenix -> Hyperliquid rescue merges).
- The Hyperliquid short goes first as post-only limits at the touch: placed at most every `--reprice-s` (30 or more,
  after a crossing refusal too, and across the parts of one open), at most `--max-orders` signed post-only orders for the whole open or close, over all
  its parts (6 or fewer: from C10 the contract meters signed notional that is not reduce-only per rolling hour, and
  every reprice counts), for `--maker-timeout-s` (default 120); an IOC for the rest only with `--taker-fallback`. The
  Phoenix long follows as one IOC for what filled. When the maker order ends with a post-only order that has no
  answer, Phoenix still buys what the settled parts filled (whole common lots), and the watch keeps the rest. `close`
  does the same reduce-only, and what the maker leg leaves goes to the close's IOC retry.
- A stored price's `at_ms` is the oracle's timestamp less its 600 s recency, so a price fresh from `refresh_prices`
  lives `oracle_max_age_s` - 600 s (300 s at 900). The maker timeout plus 120 s must fit that, or the command
  refuses (`--maker-timeout-s 180` at most with 900). The price is refreshed only after the refusals are checked:
  before each part when it would not live the maker timeout plus 120 s more (and checked against the same margin
  after), and whenever an order (an unwind, a close) finds it within 30 s of `oracle_max_age_s`; never within 30 s
  of one that went on chain (it ran, or it was sent with no final outcome), since the contract skips that refresh.
  One refused, failed on chain (reverted) or failed before the chain is retried.
- An outcome that cannot be proven ends with `open:` lines (exit code 3): reconcile those before running again. A
  post-only order whose state could not be settled is cancelled by its id once more before the process ends; both
  legs are then read again and printed, Phoenix is brought back to the operation's target net by one IOC when a late
  fill left it off by a whole lot, and what stays off is printed exactly. The target net is the sum of the
  operation's targets: for `open`, hl + px as the open found them (an older imbalance stays as it was); for `close`,
  0 (both legs flat), so a close that found the legs off sells or buys Phoenix back against a flat Hyperliquid.
- Risk in the open's target net: it is read from Phoenix when the open starts, and a fresh process reads the Phoenix
  trader snapshot with no slot floor, so a snapshot that lags an earlier run's last Phoenix IOC by a few seconds sets
  the target wrong, and the residual hedge then trades toward it. The script keeps no state between runs, so it
  cannot see how the last one ended: after a run that ended with `open:` lines, reconcile both legs with `status`
  (and wait a few seconds after the last Phoenix order) before the next `open`.

### Serve holding the pair

Serve (`engine/src/cli/serve-pair.ts`, `docs/interfaces.md` "serve pair") holds the open pair with reduce-only
closes only (panic_close, a rescue's reduce, the ADL unwind). It trades only with `GIMBAL_TRADE=1`, from the main
checkout, never with `--once`, and holds the per-desk trader lock that `pair-mainnet --send` takes too: stop serve
before any `pair-mainnet --send`.

1. Check both legs: `npm run monitor -w engine -- --mainnet` (read-only).
2. First start, no trader state file yet:
   `GIMBAL_MODE=mainnet GIMBAL_TRADE=1 GIMBAL_TRADER_FRESH=<contract>/<desk> npm run serve -w engine`.
   `GIMBAL_TRADER_FRESH` applies only when the state file is missing or unusable; over a usable file it is ignored
   with a line saying so.
3. Check the start lines: `live      TRADES (GIMBAL_TRADE=1)`, the `pair` line with the state file and the lock, and
   no `ADL -> alert only` line.
4. Remove `GIMBAL_TRADER_FRESH` from the env. Every later start:
   `GIMBAL_MODE=mainnet GIMBAL_TRADE=1 npm run serve -w engine`.
5. Stop with Ctrl-C: serve starts no new trigger, waits up to 180 s for the ADL attempt or close in flight, then
   turns trading off and releases the lock.

**Reconcile an ADL hold.** After a crash in the middle of a close, or a stop that passed 180 s, the state file still
holds orders in flight and ADL only alerts. Serve settles them itself once they are 10 min old (at start, or on a
timer): when both legs read their saved baselines moved by those orders and offset each other, the reads are adopted
and the hold ends. When only one leg moved (an ADL looks the same as an order that never went out), the hold ends but
the saved baselines stay, so the ADL watch unwinds both legs reduce-only; the journal gets an `owner:` line. When a
leg is not explained at all, the start line `ADL -> alert only: ... can no longer run, but <leg> reads ...` stays (and
an `owner:` journal line), and the owner:

- checks both legs: `npm run monitor -w engine -- --mainnet`;
- to close them: stops serve, runs `pair-mainnet close <SYM> --send`, starts serve again (the close result clears it);
- if the legs are right as they are: stops serve, moves the trader state file aside (its path is on the `pair` start
  line: `trader-mainnet-<contract>-<desk>-<evm>.json` in `GIMBAL_STATE_DIR`, default `%LOCALAPPDATA%/gimbal/state` or
  `$XDG_STATE_HOME/gimbal`), then starts serve once with `GIMBAL_TRADER_FRESH=<contract>/<desk>` and removes it again.

**Clear a lock file.** The lock is `locks/trader-mainnet-<contract>-<desk>.lock` in the per-user state directory
(`%LOCALAPPDATA%/gimbal/state/locks/` or `$XDG_STATE_HOME/gimbal/locks/`). A lock whose process is gone is taken
over by itself. When serve or `pair-mainnet --send` refuses with "the trader lock ... holds no pid" (an empty or
partly written file, left by a crash while it was being made): check that no serve and no `pair-mainnet` runs for
this desk (Task Manager or `ps`), then delete that one file and start again.

## Files the scripts write

All of them are gitignored and are written in the main checkout only (never in a linked worktree). None is ever
overwritten, and each is printed with its absolute path when written:

| file | written by | content |
|---|---|---|
| `.keys/<contract>.near.json` | deploy `--send` | the contract account's only full-access key: back it up right after tx 1; after `--lock --send` it is on no account and can be deleted |
| `.keys/operator-<contract>.near.json` | desk `--send` | the engine's FunctionCall key on the owner's account |
| `.keys/engine-mainnet-<contract>.near.env` | desk `--send` | the engine settings below |
| `.env` `RELAYER_EVM_PRIVATE_KEY` | relayer-wallet `--write` | the Arbitrum gas wallet's key, only into an empty entry |

## Engine env file

These are the names `engine/src/cli/serve.ts`, `engine/src/cli/serve-contract.ts` and
`engine/src/setup/serve-setup.ts` read. The last three in the table appear in `.env.example`, and the engine
does not need them for setup.

| name | value |
|---|---|
| `GIMBAL_MODE`, `NEAR_NETWORK` | `mainnet` (the engine refuses when they differ) |
| `GIMBAL_CONTRACT_ID`, `DESK_ID` | `<contract>.near`, `<desk_id>` |
| `OWNER_ACCOUNT_ID` | `<owner>.near`: the account the operator key belongs to |
| `OPERATOR_ACCOUNT_ID` | empty, so the engine uses `OWNER_ACCOUNT_ID` |
| `OPERATOR_PRIVATE_KEY` | the FunctionCall key from `.keys/operator-<contract>.near.json` |
| `HL_API_URL`, `ORDERLY_API_URL` | `https://api.hyperliquid.xyz`, `https://api.orderly.org` |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` (Phoenix registration on mainnet); a private RPC can replace it |
| `ORDERLY_BROKER_ID` | the contract's broker id (`config().orderly.broker_id`) |
| `OPERATOR_ALLOWANCE_NEAR` | the allowance set in step 3 (the engine reads what is left on chain) |
| `PHOENIX_API_URL` | `https://perp-api.phoenix.trade` |

To use a private NEAR RPC, add `NEAR_RPC_URL=<a mainnet RPC>` to this file. The engine port is `ENGINE_PORT`,
8790 by default.
