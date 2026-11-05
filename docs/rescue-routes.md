# Rescue routes: live on mainnet or replay only

How a rescue picks its route: README, [How it works](../README.md#how-it-works) ("Rescue").

On mainnet `serve` moves real money only with `GIMBAL_RESCUE=1`, and only on the routes marked live; it prints the
list at start. Steps and checks: [tools/mainnet/README.md](../tools/mainnet/README.md), "The live rescue".

| route | on mainnet | how |
|---|---|---|
| reserve (the desk's idle USDC on NEAR) → Hyperliquid | live | `fund_venue` into HyperCore USDC |
| reserve → Phoenix | live | `fund_venue` into the desk's Solana USDC, then a deposit into Phoenix |
| Phoenix → Hyperliquid | live | one Solana transaction (`sol_sign_rescue`) to the 1Click deposit address |
| Hyperliquid → Phoenix | replay only | wired (`hl_withdraw`, `evm_usdc_to_intents`, the deposit), not yet dry-run on mainnet |
| reserve or Phoenix → Orderly | replay only | an Orderly landing needs Orderly's private API, which the rescuer does not read yet (the owner's one-off `fund_venue` to Orderly is in [onchain-evidence.md](onchain-evidence.md#mainnet-desk-carry)) |
| Hyperliquid → Orderly | not built | Arbitrum USDC into Arbitrum USDC, which 1Click does not quote |

The Phoenix routes also need a Solana RPC that serves transaction history; without one `serve` refuses them and
says why. A leg without a live rescue route is opened at 1.5x leverage at most (`engine/src/trade/carry-plan.ts`).
