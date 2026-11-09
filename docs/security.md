# Security model

The contract builds every payload the desk's MPC keys sign and refuses anything outside the owner's policy;
[interfaces.md](interfaces.md) §1.3 and §1.5 list each rule and its refusal code, and the contract's unit tests pin
them. The operator key (a FunctionCall key on the owner's account) can trade inside the policy and move margin
between the desk's own venue accounts; it cannot pay anyone else, change the policy or resume a paused desk. The
README lists these points one line each; this page has the full text.

## What cannot be stolen

### No key to leak

The desk's venue accounts are MPC keys of the contract. The only key the engine holds over desk money is the operator
key; its other key is a gas-only Arbitrum wallet, which only submits USDC authorizations the contract signed (USDC
checks the signature) and holds a few dollars of ETH, never desk money.

### Owner methods stay the owner's

Policy, operator, Orderly receiver and IP list, Phoenix accounts, 1Click key, payouts and resume check that the
caller is the desk's owner, which refuses a separate operator account set with `set_operator`. The engine's
FunctionCall key sits on the owner's account, so the contract sees the owner; it is stopped by the deposit rule
instead: every owner method needs 1 yoctoNEAR or a storage deposit attached, and a FunctionCall key cannot attach
one.

### Money moves only to the desk's own accounts, with two owner-side exceptions

A 1Click quote is paid only when 1Click's signature over it verifies on chain, and its recipient must be the desk's
EVM address, its Solana authority, the Orderly receiver the owner pinned, or the contract itself for this desk.
`hl_withdraw` goes only to the desk's EVM address on Arbitrum, an Orderly withdrawal only to the same address. A
quote's `refundTo` is pinned per method: the desk address the money came from, or the owner for `fund_venue`. The
exceptions are the Orderly receiver, which is whatever address the owner pins, and `fund_venue` refunds, which go to
the owner ([Owner skips the performance fee](#owner-skips-the-performance-fee)).

### Out to the owner only

USDC reaches the owner through `withdraw_to_owner` (owner only, charges the fee) or as a 1Click refund of a
`fund_venue`, whose `refundTo` is pinned to the owner.

### How fast

Transfers out of a venue are capped per sliding hour by amount (`rescue_cap_usd_per_hour`), by cost (the hourly cost
budget) and by count (32 deposit addresses per 65 min); `fund_venue` has its own ring and budget.

## What a rogue operator can still do

Lose money inside these bounds: trade badly within the policy, pay transfer fees, and spend the desk's SOL on Solana
fees. The risks below are those bounds and the residuals the design accepts: each is described, not fixed.

The engine runs on a server (Railway, [deploy-railway.md](deploy-railway.md)) with only the operator key over desk
money (plus the gas-only relayer wallet): a FunctionCall key limited to the 21 operator methods and a 5 NEAR gas
allowance. It cannot call `withdraw_to_owner`, `set_policy` or resume a paused desk, so a stolen server key is a
rogue operator in the sense above and nothing more.

## Accepted risks

Each at the default policy: what can happen, its bound, and why it is accepted.

### Wash trading

An operator trading against itself at the price band's edges loses about 2 × `max_hourly_notional_usd` ×
`price_band_bps` / 10⁴ per sliding hour on average, up to about 4 × in a single hour, plus closing the positions held
at its start and the venue fees. The causes: reduce-only closes are free (not counted), and the meter decays
linearly. Accepted because reduce-only orders and cancels must never meet the cap: `panic_close`, a rescue's reduce
and the ADL unwind rely on them.

### 1Click `appFees` skim

1Click leaves `appFees` out of the signed quote, so whoever requests a quote can add a fee to a stranger. Bound: a
quote's fee (`amountIn − amountOut`) is at most 1 USDC + 25 bps of `amountIn`, so the skim is at most that less
1Click's real fee (about 0.69 USDC on a 4 USDC transfer); all rescue quotes of a sliding hour share the quote part of
the hourly cost budget (1 USD), which leaves the room for four 1 USDC venue fees untouched, and `fund_venue` has a
budget of its own. Accepted because the contract cannot see `appFees`; it bounds what it can see, the signed
`amountOut` and `minAmountOut`. Gimbal itself sends no `appFees`.

### Owner skips the performance fee

Two paths. The contract cannot derive Orderly's receiver address, so it takes any address the owner pins with
`set_orderly_receiver` (once per desk); an owner who pins its own wallet can move the desk's money there with
`fund_venue` or a rescue, past `withdraw_to_owner` and its fee. And a `fund_venue` refund lands at the owner and
leaves the books as spent, so idle USDC that held profit reaches the owner without the fee. Bound: only the
treasury's fee is at risk, the money is the owner's own, and the operator can neither pin nor change the receiver,
nor pick the refund address. On the refund path the treasury loses at most `performance_bps` (10 %) of the refunded
amount, and a deliberate refund is made hard: a `fund_venue` quote must leave 0.5 % between `amountOut` and
`minAmountOut`, so it cannot be built to fail. Accepted because only the owner can do it, and only to itself.

### Phoenix accounts

`set_phoenix_accounts` (owner only) replaces Phoenix's and Ember's shared accounts. The contract checks what it can:
no program id, mint, onboarder, permission or risk authority, none of the desk's own derived accounts, no two alike,
the program-derived ones off the curve. Every desk-side account stays derived and pinned, and the accounts are passed
only to the pinned Phoenix and Ember programs, at their positions; that a wrong one makes those instructions fail
rests on those programs' own account checks. Accepted because the contract is frozen and Phoenix may move these
accounts; only the owner can set them.

### Orderly order repeat

A signed Orderly order and its signature are public, and Orderly refuses a copy only while the original is still
open: a copy of a filled IOC or a cancelled limit order is accepted within the 300 s window of the request's
timestamp. A copy is not signed again, so the contract's hourly notional meter does not count it. Bound: on a mainnet
contract an order that is not reduce-only is refused until the owner set an IP list and the contract signed the key's
IP restriction for it. The contract marks the list applied when it signs that request and cannot see whether the
relayer posted it; once Orderly has it, Orderly takes copies only from the listed IPs, so only someone who can send
from the relayer host can repeat an order, and only the same order (side, size, limit price inside the band) for 300
s. Reduce-only orders are never gated, so a desk can always close; a copy of one can only reduce a position. The
engine reconciles positions after every order and closes any excess reduce-only (seen on testnet on 2026-10-31).
Accepted because the contract sees signatures, not Orderly's book, and Orderly has no once-only order nonce; the
relayer host runs the engine, which already holds the operator key's trading power inside the policy.

### Address registration spam

Each `fund_venue` registers the new 1Click deposit address on USDC, 0.00125 NEAR from the contract's balance (the
owner's registration, when it exists already, comes back). Bound: a desk's `fund_venue` ring takes at most 32
transfers per 65 min, about 0.9 NEAR a day per desk. The cost falls on the contract's NEAR and on the desk's USDC
(each transfer pays real 1Click fees, inside the `fund_venue` cost budget); a rogue operator pays nothing of its own.
Accepted because a transfer to an unregistered address fails, so the registration cannot be skipped, and the bound is
small. The contract's NEAR balance is watched.

### Rescues held after a restart

Paying twice is what the rescuer guards against, so after a restart it trusts only its state file and chain facts. A
payment that may have been signed stays held until 1Click settles it or the chain proves it can never run; while
anything is held no transfer starts. A payment that was never signed is released once a final NEAR block past the
quote's payable end (at most an hour after 1Click signed it) plus 60 s shows that the contract never paid its deposit
address. A missing or unusable state file holds every transfer until the owner reconciles and starts once with
`GIMBAL_RESCUE_FRESH=<contract>/<desk>`, which `serve` refuses for 65 min after the desk's last rescue or
`fund_venue` on chain and after the last trace of its rescuers in the state directory. A first run counts the rescue
cap as used in full, freeing over its first hour, so Phoenix → Hyperliquid may wait up to that hour; the reserve
routes do not count against that cap. Bound: a restart over a usable state file with nothing in flight blocks
nothing; one without a usable file holds transfers for about 65 min, then the cap frees over an hour. A payment that
may really have run stays held until it is settled or the owner reconciles it. Reducing both legs reduce-only and
`panic_close` run all along. Accepted because a NEAR call can land long after the engine gave up on it, and the
contract keeps a quote payable for up to 65 min; nothing on chain shows such a call before it lands.

### No 1Click quotes out of HyperCore

1Click answers "Quoting for this pair is not available" for every quote out of HyperCore (first seen 2026-10-31), so
`hl_send_to_intents`, the one-hop route out of Hyperliquid, cannot run. Hyperliquid → Arbitrum goes through
`hl_withdraw` to the desk's own Arbitrum address, then `evm_usdc_to_intents` and 1Click from Arbitrum USDC. Bound: it
costs Hyperliquid's 1 USDC withdrawal fee, the 1Click fee and the relayer's Arbitrum gas; an operator withdrawal is
at least 10 USDC, and the route counts against the rescue cap twice. Every hop ends at a desk address, so it adds
cost and time, not a way out. The Hyperliquid → Phoenix rescue runs in replay only, and Hyperliquid → Orderly is not
built. Accepted because the gap is on 1Click's side; the contract keeps `hl_send_to_intents` for when quoting opens.

### Oversized Phoenix answers (zod < 4.6.6)

The Phoenix SDK validates every API answer with zod 4.4.3, which it pins exactly; `engine/package.json` pins the same
version to match it (the desk's MCP server, `engine/src/mcp/server.ts`, uses it too). A huge malformed array from
Phoenix's API could exhaust the engine's memory and stop it (no signing, funds or policy affected; rescues wait for the
restart). Fixed by `@ellipsis-labs/rise` ≥ 0.6.7 plus zod ≥ 4.6.6 in the engine, which we take after the hackathon
demo.

### Unpriced symbols

ZRO, ETHFI and AAVE trade on Hyperliquid and Orderly under `policy.unpriced` since 2026-11-05 (the owner's
`set_policy`). They have no oracle price, so their orders skip the price band; each order is bounded instead by the
symbol's `max_sz` and by `unpriced_max_notional_usd` (20 USD on the mainnet desk), and the hourly notional meter counts
it at no less than its share of that cap (docs/interfaces.md §1.2). Only the owner can add a symbol there. Accepted
because each order is capped in size and in USD, and the dashboard shows such symbols as "no price protection".

## Other bounded residuals

### Paused rescues

A paused desk still signs rescues; their Solana fees and the rent of each deposit owner's new token account are lost
to the desk: at most about 0.078 SOL per 65 min, about 0.01 SOL an hour after that.

### Urgent Solana fees

Urgent `cancel_all` and reduce-only `sol_sign` messages have no count limit, on running and paused desks: up to
0.000405 SOL each, bounded only by the operator key's NEAR allowance.

### Spot after a pause

Spot pairs take no reduce-only orders, so after `panic_close` a spot holding is sold only once the desk resumes.
Gimbal trades no spot today.

### 1Click key rotation

A second quote key needs the treasury's proposal, the owner's acceptance and a day, so a rotation pauses quoted
transfers for at least a day; the treasury should be a multisig. An owner can distrust 1Click's pinned key for a
desk, for good.

### Prices

The seven oracle ids are fixed and asked together; if one breaks, owners move symbols to `unpriced`. `refresh_prices`
costs the contract up to 29–58 NEAR a day if spammed, so its balance is watched.

### NEAR AI risk check

The engine asks the NEAR AI risk check before every enter and rotate, and it fails closed: only a readable pass lets
the act go ahead. No answer within 15 s (asked twice), NEAR AI unreachable, or no working key holds the act until the
next hourly check, journaled "the NEAR AI risk check did not answer ... held, not passed"; an unreadable reply is a
refusal. So a NEAR AI outage costs carry not taken, never an unchecked entry. Exits, stops, `POST /close`,
`panic_close` and rescues never ask it, and a close, a drawdown or time stop, or a shutdown cancels an entry still
waiting on its check, with nothing sent; an exit on the hourly counts can wait for a check in flight, about 35 s at
most (two 15 s attempts plus the 3 s fact reads).
The check gates the strategy loop only: the operator's MCP desk tools (`engine/src/mcp/server.ts`: `place_hl_order`,
`fund_venue`, `withdraw`) and the `pair-live` / `pair-mainnet` CLIs, which open and close pairs by hand, are gated by
the contract's policy alone, not by the NEAR AI risk check. The model never signs and nothing it returns reaches the
contract or a venue; the contract checks every order against the policy either way. In replay only (`npm run demo`), a prompt with no recorded reply passes, and the
journal says it would wait live.

### The owner token (public site's owner console)

With owner writes on (`GIMBAL_OWNER_TOKEN` on the engine, `GIMBAL_OWNER_WRITES=1` on the public host;
docs/deploy-railway.md, "Owner writes"), the owner token is a hot credential: anyone holding it, together with the
public site, can do what the owner's dashboard does through `POST /rotate`, `POST /close` and `PUT /strategy`. It
moves no money out and reaches no owner method: every order still goes through the contract, which checks it against
the policy (asset list, `max_notional_usd` per order, the price band, the hourly notional meter
`max_hourly_notional_usd`), so the worst case is bounded by those caps: on the mainnet desk 20 USD per order and
300 USD of opening orders per hour, each entry also behind the NEAR AI risk check and capped at 1 USD of maximum loss,
plus the fees and slippage of entering and closing. A held pair can be closed early, or the rules changed within the
engine's own limits (the leverage cap holds). Guessing is held off by the token's size (256 bits), constant-time
comparison and a 15-minute lockout after five wrong tries; the host never stores or logs it, and the page keeps it in
one tab's `sessionStorage`. If it may have leaked, rotate it: set a new `GIMBAL_OWNER_TOKEN` on the engine's service
(the old one stops working at the next deploy), or delete the variable to turn owner writes off.

### Frozen venues

A new Phoenix or Ember program id, PhUSD mint, onboarder or permission account needs a new contract.
