// The contract's refusals (docs/interfaces.md §1.5): each code with the one line an owner reads, and the link to the
// tests that assert it. The codes and their order are the contract's (`contract/core/src/errors.rs`, `ALL`); a test
// reads both and fails when one of them changes without this table.
//
// The links are not written here. `scan.ts` finds the lines of the contract's tests that name each code, and the build
// puts the result into the page (`virtual:refusal-tests`, vite.config.ts), so a link cannot point at a line that moved.

export interface Refusal {
  code: string;
  /** What was asked that the contract will not do, in the owner's words. */
  meaning: string;
}

export const REFUSALS: readonly Refusal[] = [
  { code: 'E_NOT_ALLOWED', meaning: 'The caller is not you or the operator, or the operator tried something only you may do.' },
  { code: 'E_PAUSED', meaning: 'The desk is paused: only actions that reduce risk go through.' },
  { code: 'E_NO_DESK', meaning: 'There is no desk with that id.' },
  { code: 'E_DESK_EXISTS', meaning: 'A desk with that id exists already.' },
  { code: 'E_ARGS', meaning: 'A malformed request: a bad address or number, a setting changed twice, or too little gas.' },
  { code: 'E_DEPOSIT', meaning: 'The NEAR attached does not cover the storage the change needs.' },
  { code: 'E_ASSET', meaning: 'The asset, symbol or market is not in your policy.' },
  { code: 'E_SIZE', meaning: 'The order is worth more than your limit per leg, or is zero.' },
  { code: 'E_DECIMAL', meaning: 'A price or size written loosely: the contract takes only plain canonical decimals.' },
  { code: 'E_PRICE_BAND', meaning: 'The price is too far from the oracle price.' },
  { code: 'E_ORACLE_STALE', meaning: 'There is no oracle price recent enough to check the order against.' },
  { code: 'E_QUOTE_SIGNATURE', meaning: 'A NEAR Intents quote whose signature does not verify.' },
  { code: 'E_QUOTE_FIELDS', meaning: 'A quote with a swapped address, a cost over your bound, or a deposit address already paid.' },
  { code: 'E_RESCUE_CAP', meaning: 'Margin moves would pass your hourly cap, or its hourly cost budget.' },
  { code: 'E_SOL_MESSAGE', meaning: 'A Solana transaction in a format the contract does not sign.' },
  { code: 'E_SOL_PROGRAM', meaning: 'A Solana instruction for a program outside the allowlist.' },
  { code: 'E_SOL_ACCOUNT', meaning: 'A Solana instruction that touches an account that is not the desk’s.' },
  { code: 'E_MPC', meaning: 'The NEAR MPC network returned no signature, so nothing was signed.' },
];

export const REFUSAL_CODES: readonly string[] = REFUSALS.map((r) => r.code);

/** One line of a contract test that names a code, as the repository's default branch shows it. */
export interface TestLink {
  path: string;
  line: number;
}

export const REPO_BLOB = 'https://github.com/winchxyz/gimbal/blob/main/';

export const testUrl = (t: TestLink): string => `${REPO_BLOB}${t.path}#L${t.line}`;

/**
 * `tests.rs:777`: the file's name and the line, which is what the owner sees on the link. Two folders share file names
 * with the contract's modules (`hl.rs` is in `src/`, in `src/tests/` and in `core/`), so those two say where they are:
 * `tests/hl.rs:12`, `core/hl.rs:12`.
 */
export function testLabel(t: TestLink): string {
  const name = t.path.slice(t.path.lastIndexOf('/') + 1);
  const where = t.path.startsWith('contract/core/') ? 'core/' : t.path.startsWith('contract/src/tests/') ? 'tests/' : '';
  return `${where}${name}:${t.line}`;
}
