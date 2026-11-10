// How an order gets signed, in five steps: the one thing about this desk that no other desk has. Shown on the Desk
// and on Safety, so both say it in the same words.
import './keys.css';

export const KEYS_HEAD = 'private keys exist for this desk.';
export const KEYS_LINE =
  'No private key exists for any exchange account: not ours, not the engine’s, not yours. A NEAR contract owns every account and asks the NEAR MPC network to sign, one order at a time, only after checking it against your policy.';
export const FLOW_FAIL = 'If step 3 fails, nothing is signed and the refusal goes in the Journal.';

/** The steps, in order; the third is the contract's check. */
export const flowSteps = (contract: string): readonly (readonly [string, string])[] => [
  ['You sign the policy', 'once; again for every change'],
  ['The engine proposes an order', 'it holds no exchange key'],
  [`${contract} checks it`, 'asset, size, price against the oracle, destination'],
  ['NEAR MPC signs it', 'usually 5 to 7 seconds'],
  ['The exchange fills it', 'Hyperliquid, Phoenix or Orderly'],
];

export function KeysFlow({ contract }: { contract: string }) {
  return (
    <>
      <div className="keys">
        <div className="keys-zero">
          <b>0</b>
          <span>{KEYS_HEAD}</span>
        </div>
        <p>{KEYS_LINE}</p>
      </div>
      <ol className="keys-flow">
        {flowSteps(contract).map(([what, how], i) => (
          <li key={what} className={i === 2 ? 'on' : undefined}>
            <b>{what}</b>
            <span>{how}</span>
          </li>
        ))}
      </ol>
      <p className="pn-foot">{FLOW_FAIL}</p>
    </>
  );
}
