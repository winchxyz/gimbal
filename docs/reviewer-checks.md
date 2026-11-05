# Reviewer checks

Each command from the repo root of a fresh clone, and what it prints when it works (the reproducible run, rule
Q-012). None needs a key, an account or a chain; only the last row needs Docker.

| Command | Prints |
| --- | --- |
| `npm ci` | installs the four workspaces (`engine`, `web`, `shared`, `tools`) from the lockfile, no errors; npm audit's "2 high" are one advisory, zod 4.4.3 ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)), pinned exactly by the Phoenix SDK 0.6.2 and, to match it, by `engine/package.json` (`npm audit fix` without `--force` changes nothing). The fix is rise ≥ 0.6.7 plus zod ≥ 4.6.6 in the engine, deferred until after the hackathon demo; until then an oversized Phoenix answer could stop the engine, never sign or move funds (the engine's own MCP server reads only its local stdio client) ([security.md](security.md#oversized-phoenix-answers-zod--466)) |
| `npm run ci -- --only npm` | `ci: green - npm ci, build, test, typecheck (node tests N + N + N) in N s`, the engine, web and tools test counts (1426 + 504 + 233 at this commit) |
| `npm run demo` | `demo: ready. Open http://localhost:5190`, then the steps in the README's [Demo](../README.md#demo-npm-run-demo) table (`-- --web-port <n>` if 5190 is taken) |
| `cd contract && cargo test -p gimbal-core` | `test result: ok.` for the 126 unit tests and for each vector file (decimal, EIP-3009, Hyperliquid, 1Click, Orderly, Solana, Solana fuzz): 190 passed, 0 failed |
| `npm run ci -- --only contract` | `ci: green - cargo fmt, clippy, cargo test, wasm (cargo tests 439; wasm 674,490 bytes) in N s` |
| `cd contract && cargo near build non-reproducible-wasm --no-abi` | writes `contract/target/near/gimbal.wasm`, sha256 `da4bff79edb36baec4a4c5a636a267abe9c0505fa30790a2771584a14b2e30fa`, the code on the testnet deploy |
| `git checkout eed9a99`, then `cd contract && cargo near build reproducible-wasm` (needs Docker) | sha256 `6e7cb556b86ab64414196d76243bce6e04bd9a5da0ce49b7093a0d279cc15482`, the code on `gimbal_dex.near` |

On Windows the full contract tests need the MSVC Rust toolchain (`npm run ci -- --only contract` picks it);
`cargo test -p gimbal-core` runs on the default one.
