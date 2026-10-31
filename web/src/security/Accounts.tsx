import { arbiscanUrl, hyperliquidUrl, nearUrl, netOf, shortAddress, solscanUrl, type Net } from './explorer.ts';
import { ExtLink } from './ExtLink.tsx';
import type { SecurityData } from './load.ts';
import { ReplayNote, Sk, type Reading } from './Sk.tsx';

interface Row {
  key: string;
  exchange: string;
  /** Chain and signature scheme. */
  chain: string;
  /** The address as text (the Orderly account id is not an address on any chain, so it has no link). */
  address: string;
  /** How the address comes from the contract. */
  path: string;
  /** The explorer's name and link; null when the address is not one an explorer opens. */
  explorer: { label: string; href: string } | null;
  /** A row under another exchange, drawn quieter. */
  sub?: boolean;
}

/** The desk's accounts, from `get_desk`: each address the contract derived, and where it opens. */
export function accountRows(data: SecurityData): Row[] {
  const { desk, target } = data;
  const net: Net = netOf(target.mode);
  const id = target.deskId;
  const link = (label: string, href: string | null): Row['explorer'] => (href === null ? null : { label, href });
  const rows: Row[] = [
    { key: 'hl', exchange: 'Hyperliquid', chain: 'EVM · secp256k1', address: desk.evm_address, path: `gimbal/${id}/evm`, explorer: link('Hyperliquid', hyperliquidUrl(desk.evm_address, net)) },
    { key: 'phoenix', exchange: 'Phoenix', chain: 'Solana · Ed25519', address: desk.solana.authority, path: `gimbal/${id}/sol`, explorer: link('Solscan', solscanUrl(desk.solana.authority, net)) },
    { key: 'trader', exchange: 'Phoenix trader', chain: 'Solana · program account', address: desk.solana.phoenix_trader, path: 'derived from the Phoenix address', explorer: link('Solscan', solscanUrl(desk.solana.phoenix_trader, net)), sub: true },
    { key: 'usdc', exchange: 'USDC on Solana', chain: 'Solana · token account', address: desk.solana.usdc_ata, path: 'derived from the Phoenix address', explorer: link('Solscan', solscanUrl(desk.solana.usdc_ata, net)), sub: true },
    { key: 'phusd', exchange: 'PhUSD on Solana', chain: 'Solana · token account', address: desk.solana.phusd_ata, path: 'derived from the Phoenix address', explorer: link('Solscan', solscanUrl(desk.solana.phusd_ata, net)), sub: true },
    { key: 'orderly', exchange: 'Orderly', chain: 'EVM · secp256k1 + Ed25519', address: desk.orderly_account_id, path: 'account id from the Hyperliquid address; its key is the Phoenix key', explorer: null },
  ];
  if (desk.orderly_receiver !== null) {
    rows.push({ key: 'receiver', exchange: 'Orderly deposit address', chain: 'Arbitrum · you pinned it', address: desk.orderly_receiver, path: 'Orderly’s receiver for this account', explorer: link('Arbiscan', arbiscanUrl(desk.orderly_receiver, net)), sub: true });
  }
  rows.push(
    { key: 'arbitrum', exchange: 'Arbitrum', chain: 'EVM · secp256k1', address: desk.evm_address, path: 'same as Hyperliquid', explorer: link('Arbiscan', arbiscanUrl(desk.evm_address, net)) },
    { key: 'near', exchange: 'NEAR', chain: 'the contract’s account', address: target.contractId, path: 'holds the desk’s idle USDC on NEAR', explorer: link('Nearblocks', nearUrl(target.contractId, net)) },
  );
  return rows;
}

/** A phone row shortens hex and base58 addresses; a NEAR account name is short enough to read, so it stays whole. */
const shortOf = (row: Row): string => (row.key === 'near' ? row.address : shortAddress(row.address));

function Placeholder() {
  return (
    <>
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="s-arow" aria-hidden="true">
          <span>{['Hyperliquid', 'Phoenix', 'Orderly', 'Arbitrum'][n]}</span>
          <span>
            <Sk w={[127, 127, 211, 127][n]!} h={16} />
          </span>
          <span>
            <Sk w={[218, 203, 218, 203][n]!} h={14} />
          </span>
          <span>
            <Sk w={[140, 148, 178, 140][n]!} h={16} />
          </span>
          <span className="s-arow-go g">{['Explorer', 'Solscan', 'Explorer', 'Arbiscan'][n]} ↗</span>
        </div>
      ))}
    </>
  );
}

/** The accounts the contract controls, with the path each was derived on and an explorer link (design: the accounts table). */
export function Accounts({ r }: { r: Reading }) {
  return (
    <section className="s-addrs" aria-label="Accounts the contract controls">
      <h2>Accounts the contract controls</h2>
      {r.kind === 'replay' ? null : (
        <div className="s-arow hd">
          <span>Exchange</span>
          <span>Chain · signature</span>
          <span>Address, derived from the contract</span>
          <span>Derivation path</span>
          <span />
        </div>
      )}
      {r.kind === 'ready' ? (
        accountRows(r.data).map((row) => (
          <div key={row.key} className={row.sub ? 's-arow sub' : 's-arow'}>
            <span>{row.exchange}</span>
            <span className="g">{row.chain}</span>
            <span className="mono">
              <span className="s-full">{row.address}</span>
              <span className="s-short">
                {row.explorer === null ? (
                  shortOf(row)
                ) : (
                  <ExtLink href={row.explorer.href} arrow>
                    {shortOf(row)}
                  </ExtLink>
                )}
              </span>
            </span>
            <span className="g s-path">{row.path}</span>
            <span className="s-arow-go">
              {row.explorer === null ? null : (
                <ExtLink href={row.explorer.href} className="g" arrow>
                  {row.explorer.label}
                </ExtLink>
              )}
            </span>
          </div>
        ))
      ) : r.kind === 'replay' ? (
        <ReplayNote what="account" />
      ) : (
        <div aria-busy="true" aria-label="Reading the accounts">
          <Placeholder />
        </div>
      )}
    </section>
  );
}
