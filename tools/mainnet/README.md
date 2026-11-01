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

The contract on main has **no `ft_on_transfer`, `fund_venue`, `withdraw_to_owner` or `panic_close` yet**. Those
methods move money into a desk and back out; they come in later versions. This runbook therefore covers only:

- deploying the contract;
- creating the desk with its operator key;
- the venue setup, which needs no funds except the first Hyperliquid deposit and a little SOL (step 4).

**Do not send funds to the canary desk's addresses until the deployed code has those methods.** Money sent there
now could not be taken out by the contract. The deploy dry run lists which of the four methods the wasm exports
(`methods ... money methods ...`) and warns when any is missing. Compare its code hash with
`view_account`'s `code_hash` to know what is deployed.

To retire the canary, send a **DeleteAccount** transaction for `<contract>.near`, signed with
`.keys/<contract>.near.json`, with beneficiary `<funder>.near` (for example with near CLI's
`account delete-account`). This returns the account's whole balance to the funder, including the NEAR held for
the code's storage. Do it only when nothing is left on any of the desk's addresses. After the deletion anyone
can register `<contract>.near` again, and the desk's MPC-derived addresses belong to whoever holds that name:
never send anything to them afterwards.

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
100 bps / 0.5 USD, and nothing unpriced.

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

Every value given to `new()` is permanent, so check each one now. The `env` lines show the broker id and
the referral codes in full and say where each came from; a `warning` line means the shell environment set it
over `.env`. The `methods` line shows whether the wasm has the money methods (see "What this contract version
can do"). The script refuses in these cases:

- the account exists (it never redeploys);
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
`config()`, which it compares with the init args. The new full-access key is written to
`.keys/<contract>.near.json` (the script prints its absolute path). It is the contract account's only key.
**Back it up right after tx 1** (the script says `back up ... now` at that point), before anything else
happens. Without it nothing can sign for the account: no retry of tx 2, and no DeleteAccount to get the NEAR
back. If tx 1 went through and tx 2 failed, `--resume` (with the same arguments and `--send`) sends tx 2 only. It
works only while the account has no code and `.keys/<contract>.near.json` is its full-access key.

- **Cost:** the initial balance. The default is code size × 1e19 + 0.5 NEAR, rounded up to 0.1: **6.2 NEAR**
  for the current 569,702-byte wasm. It moves from the funder to the contract and stays there: about 5.7 NEAR is
  held for the code's storage, and the rest pays tx 2's gas and the state. The dry run's `gas` line gives the
  most each transaction can burn, worked out from the live runtime fees:
  - tx 1: about 101.2 TGas (100 prepaid + action fees), at most about 0.0102 NEAR.
  - tx 2: about 142.3 TGas, at most about 0.0143 NEAR. That is 100 TGas prepaid for `new()`, about 41 TGas for
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
  engine, with receiver `<contract>.near`, allowance `--allowance` NEAR, and only the 19 operator methods
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
    19 methods.
  - `.keys/operator-<contract>.near.json` and `.keys/engine-mainnet-<contract>.near.env` exist.

## 4. Funding (not covered yet, and not with this contract version)

Funding the desk is left for a later runbook. **Send nothing to the desk's addresses while the deployed code
lacks the money methods** (see "What this contract version can do"). Until then, the setup steps in step 6 that
depend on funding stay waiting or fail, and that is expected:

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

Venue setup (step 6) does not use this wallet.

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
  - With this contract version and no funding, the Orderly steps should end `done` or `skipped`. The two
    Hyperliquid steps wait for a deposit, and `phoenix_register` may fail for want of SOL. Both are expected
    until the money methods are deployed.
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

## Files the scripts write

All of them are gitignored and are written in the main checkout only (never in a linked worktree). None is ever
overwritten, and each is printed with its absolute path when written:

| file | written by | content |
|---|---|---|
| `.keys/<contract>.near.json` | deploy `--send` | the contract account's only full-access key: back it up right after tx 1 |
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
