import { Figure, type Reading } from './Sk.tsx';

/**
 * The zero, and the five steps an order goes through (design/screens/desktop/security.html). The zero is a fact of the
 * design, not a reading: no private key exists for any exchange account, because the contract owns them and asks the
 * NEAR MPC network to sign. The names in the steps are the contract's own (`config().mpc`, the desk's owner).
 */
export function Head({ r }: { r: Reading }) {
  return (
    <div className="s-zero-col" aria-label="Keys that exist">
      <div>
        <div className="s-zero" aria-hidden="true">0</div>
        <h2 className="s-zero-text">
          <span className="s-sr">0 </span>private keys exist for this desk.
        </h2>
        <p>
          No private key exists for any exchange account: not ours, not the engine’s, not yours. A NEAR contract owns every account and asks the NEAR
          MPC network to sign, one order at a time, only after checking it against your policy.
        </p>
      </div>
      <div className="s-flow">
        <h3>How an order gets signed</h3>
        <ol>
          <li>
            <b>You sign the policy</b>
            <span>
              <Figure r={r} w={150} h={13} replay="your wallet">
                {(d) => d.desk.owner}
              </Figure>
              , once; again for every change
            </span>
          </li>
          <li>
            <b>The operator proposes an order</b>
            <span>the desk engine; it holds no exchange key</span>
          </li>
          <li className="on">
            <b>The gimbal contract checks it</b>
            <span>asset, size, price against the oracle, destination</span>
          </li>
          <li>
            <b>NEAR MPC signs it</b>
            <span>
              <Figure r={r} w={110} h={13} replay="the NEAR MPC contract">
                {(d) => d.config.mpc}
              </Figure>
              , usually 5 to 7 seconds
            </span>
          </li>
          <li>
            <b>The exchange fills it</b>
            <span>Hyperliquid, Phoenix or Orderly</span>
          </li>
        </ol>
        <p>If step 3 fails, nothing is signed and the refusal goes in the Journal.</p>
      </div>
    </div>
  );
}
