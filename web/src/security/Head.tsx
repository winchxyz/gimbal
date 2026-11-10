import { KeysFlow } from '../ui/KeysFlow.tsx';

/**
 * The zero, and the five steps an order goes through, in the same words as on the Desk (ui/KeysFlow.tsx). The zero is a
 * fact of the design, not a reading: no private key exists for any exchange account, because the contract owns them and
 * asks the NEAR MPC network to sign. The contract's name is handed in by the screen; before it is known the step names
 * the contract in words.
 */
export function Head({ contract }: { contract: string | null }) {
  return <KeysFlow contract={contract ?? 'The contract'} />;
}
