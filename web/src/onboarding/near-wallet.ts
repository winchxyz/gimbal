// The real wallet: `@hot-labs/near-connect`, which opens the owner's own NEAR wallet (HOT, MyNearWallet, Meteor, Ledger…)
// in its own window. The page only ever asks it to connect and to sign one transaction; no key is read or stored here.
// Loaded on demand, so the connector's code is not in the first download of the Desk.
import type { NearConnector } from '@hot-labs/near-connect';
import { outcomeOf, panicOf, WalletError, type NearNetwork, type Wallet } from './wallet.ts';

/** What a wallet's own error says, whatever shape it threw. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return 'the wallet did not say why';
}

export function nearWallet(network: NearNetwork): Wallet {
  let connector: Promise<NearConnector> | null = null;
  let account: string | null = null;
  const signOutListeners = new Set<() => void>();

  const load = (): Promise<NearConnector> => {
    connector ??= import('@hot-labs/near-connect').then(async ({ NearConnector: Connector }) => {
      const c = new Connector({ network });
      c.on('wallet:signIn', ({ accounts }) => {
        account = accounts[0]?.accountId ?? account;
      });
      // The owner can remove the page's access in the wallet itself; the page must not go on as if signed in.
      c.on('wallet:signOut', () => {
        account = null;
        for (const listener of signOutListeners) listener();
      });
      await c.whenManifestLoaded;
      return c;
    });
    // A failed load (offline, blocked script) must not be remembered: the next try starts again.
    connector.catch(() => {
      connector = null;
    });
    return connector;
  };

  return {
    network,
    accountId: () => account,

    async restore() {
      try {
        const c = await load();
        const connected = await c.getConnectedWallet();
        account = connected.accounts[0]?.accountId ?? null;
      } catch {
        account = null;
      }
      return account;
    },

    async connect() {
      let c: NearConnector;
      try {
        c = await load();
      } catch (error) {
        throw new WalletError(`the wallet selector could not be loaded (${messageOf(error)})`);
      }
      try {
        const wallet = await c.connect();
        const accounts = await wallet.getAccounts({ network });
        const first = accounts[0]?.accountId;
        if (first === undefined) throw new Error('the wallet returned no account');
        account = first;
        return first;
      } catch (error) {
        throw new WalletError(`no NEAR wallet answered (${messageOf(error)})`);
      }
    },

    async signAndSend(tx) {
      if (account === null) throw new WalletError('no wallet is connected');
      try {
        const c = await load();
        const wallet = await c.wallet();
        const raw = await wallet.signAndSendTransaction({ network, signerId: account, receiverId: tx.receiverId, actions: tx.actions });
        return outcomeOf(raw);
      } catch (error) {
        const text = messageOf(error);
        // Some wallets throw when the contract panicked instead of returning a failed outcome; that is the contract's
        // refusal, not a wallet that did not sign.
        if (/panicked|E_[A-Z_]+/.test(text)) return { hash: null, value: null, failure: panicOf(text) };
        throw new WalletError(text);
      }
    },

    async disconnect() {
      const c = await load().catch(() => null);
      await c?.disconnect().catch(() => undefined);
      account = null;
    },

    onSignOut(listener) {
      signOutListeners.add(listener);
      return () => signOutListeners.delete(listener);
    },
  };
}
