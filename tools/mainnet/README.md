# Mainnet canary runbook

The canary is the first Gimbal deployment on NEAR mainnet: one new contract account, one desk with small limits
(20 USD per leg), and the engine's venue setup. A person runs every step that sends a transaction. Every script
here is a **dry run by default**: it reads mainnet, prints the transactions it would send (signer, receiver,
method, full args, deposit, gas) and the balances before and after, and signs, sends and writes nothing. Only
`--send` signs.

Guards that every script applies:

- Mainnet only. Account ids must be `<name>.near` or 64-hex implicit accounts. The one exception is the named
  system accounts (`v1.signer`, `near`). Every RPC endpoint must report chain `mainnet` before it is used. The
  testnet scripts in `tools/testnet/` are separate and unchanged.
- No key or `.env` value is printed. A key file is reported only as "matches" or "does not match" the account's
  full-access key. Values read from `.env` show by name and length (`<ORDERLY_BROKER_ID from .env, 10 characters>`).
- Nothing is overwritten. A key file or env file that exists is refused, and `.env` entries are only filled when
  they are empty.
- Every transaction is waited for until final before the next one is sent.

Placeholders: `<funder>.near` pays for the contract account; `<contract>.near` is the new contract account;
`<owner>.near` owns the desk (it may be the funder); `<desk_id>` is the desk (1 to 32 characters of a-z, 0-9, -).

## 0. Before you start

- Node 24 or later. From the repo root, run `npm ci`, then `npm run build` (the engine imports the built
  `@gimbal/shared`).
- The contract wasm: `cd contract && cargo near build non-reproducible-wasm --no-abi`. This writes
  `contract/target/near/gimbal.wasm`. The deploy dry run prints its size and sha256; compare them with the build
  you mean to ship.
- `.env` (a copy of `.env.example`, gitignored). The scripts read these entries; the shell environment wins over
  the file, and an empty value means "not set":

  | name | used by | |
  |---|---|---|
  | `ORDERLY_BROKER_ID` | deploy, desk | required; `new()` fixes it for the contract's life |
  | `HL_REFERRAL_CODE`, `ORDERLY_REFERRAL_CODE`, `PHOENIX_REFERRAL_CODE` | deploy | empty → `null` (no code); fixed by `new()` |
  | `NEAR_RPC_URL` | all | optional; tried first, before `free.rpc.fastnear.com` and `rpc.mainnet.near.org` |
  | `RELAYER_EVM_PRIVATE_KEY` | relayer-wallet | written by step 5 when empty |
  | `ARBITRUM_RPC_URL` | relayer-wallet `--check` | optional; default `https://arb1.arbitrum.io/rpc` |

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

Every value given to `new()` is permanent, so check each one now. The script refuses in these cases:

- the account exists (it never redeploys);
- `v1.signer`, `price-oracle.near` or the treasury does not exist;
- the balance is under code size × 1e19 + 0.5 NEAR;
- the funder cannot pay the balance + 0.2 NEAR;
- `ORDERLY_BROKER_ID` is empty;
- the key file is not a full-access key of the funder.

It warns when the builder has under 100 USDC on Hyperliquid. Hyperliquid needs that before an order can carry
the builder fee; it is not needed to deploy.

Then send:

```
node tools/mainnet/deploy.mjs <same arguments> --send
```

This sends tx 1, waits for final, sends tx 2, waits for final, then prints both hashes (nearblocks links) and
`config()`, which it compares with the init args. The new full-access key is in `.keys/<contract>.near.json`; back
it up. It is the contract account's only key. If tx 1 went through and tx 2 failed, `--resume` (with the same
arguments and `--send`) sends tx 2 only. It works only while the account has no code and `.keys/<contract>.near.json`
is its full-access key.

- **Cost:** the initial balance. The default is code size × 1e19 + 0.5 NEAR, rounded up to 0.1: **6.2 NEAR**
  for the current 569,702-byte wasm. It moves from the funder to the contract and stays there: about 5.7 NEAR is
  held for the code's storage, and the rest pays tx 2's gas and the state. Gas: tx 1 at most 0.0105 NEAR
  prepaid, tx 2 at most 0.011; the unused part is refunded and the real fee is well under 0.01 NEAR.
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
- `config()` is not a Mainnet Gimbal contract with `v1.signer`, `price-oracle.near` and Orderly chain 42161;
- `ORDERLY_BROKER_ID` is not the contract's broker id;
- the desk exists under another owner, or its stored addresses are not the MPC-derived ones;
- an operator key file exists but its key is on chain with other permissions;
- the owner cannot pay 0.5 + 0.2 NEAR;
- the key file is not the owner's full-access key.

Then send:

```
node tools/mainnet/desk.mjs <same arguments> --send
```

This sends one transaction at a time and waits for final after each one. It writes
`.keys/operator-<contract>.near.json` before the AddKey, and writes the env file last. A rerun skips whatever is
already done (an existing desk, or an operator key already on chain), and when everything is done it says
`nothing to send`.

- **Cost:**
  - `create_desk`: 0.5 NEAR attached. The contract keeps what the desk's storage takes and refunds the rest.
  - Gas for both transactions: at most 0.015 NEAR prepaid, about 0.002 NEAR real.
  - The new key: a few hundred bytes of storage on the owner's account (a few thousandths of a NEAR held).
  - The allowance is not a transfer. It is the most the engine's key may burn on gas from the owner's balance.
- **Check after:**
  - The same dry-run command now prints `nothing to send`.
  - `view.mjs <contract>.near get_desk '{"desk_id":"<desk_id>"}'` shows the policy and the addresses above.
  - `view.mjs --keys <owner>.near` lists the new FunctionCall key: receiver `<contract>.near`, the allowance and
    19 methods.
  - `.keys/operator-<contract>.near.json` and `.keys/engine-mainnet-<contract>.near.env` exist.

## 4. Funding (not covered yet)

Funding the desk is left for a later runbook. Some setup steps in step 6 depend on it:

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
node tools/mainnet/relayer-wallet.mjs --check
```

The first command writes a new key into `.env` `RELAYER_EVM_PRIVATE_KEY`, but only when that entry is empty; it
never overwrites. It prints the address. Send a few dollars of ETH on **Arbitrum One** to that address. This
wallet pays gas for the Orderly money path (it submits the EIP-3009 transfers the contract signed) and never
holds desk money. `--check` confirms that the RPC answers chain 42161 and prints the wallet's ETH balance. Venue
setup (step 6) does not use this wallet.

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
  - Every step is `done` or `skipped`; the two Hyperliquid steps wait until the deposit.
  - The Orderly `get_account` link printed in step 3 answers.
  - solscan shows the Phoenix trader account.
  - nearblocks.io/address/`<owner>.near` shows the operator key's calls to `<contract>.near`.

## Files the scripts write

All of them are gitignored, and none is ever overwritten:

| file | written by | content |
|---|---|---|
| `.keys/<contract>.near.json` | deploy `--send` | the contract account's full-access key |
| `.keys/operator-<contract>.near.json` | desk `--send` | the engine's FunctionCall key on the owner's account |
| `.keys/engine-mainnet-<contract>.near.env` | desk `--send` | the engine settings below |
| `.env` `RELAYER_EVM_PRIVATE_KEY` | relayer-wallet | the Arbitrum gas wallet's key, only into an empty entry |

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
