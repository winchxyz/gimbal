// The two-leg live check on testnet: a pair on Hyperliquid (ETH) and Orderly (PERP_ETH_USDC) opened and closed
// through the pair trader, every order signed by the contract. Prints each order's ids and the final positions read
// from both venues.
//   node src/cli/pair-live.ts [--size 0.005] [--long hyperliquid|orderly] [--hold 5]
//                             [--fail hyperliquid|orderly]   force that leg's opening orders to fail before signing:
//                                                            the guard must unwind the other leg and end flat
//                             [--replay-copy]                after the open, send the signed Orderly order again
//                                                            (as anyone reading the chain could): the copy fills
//                                                            and the reconcile must close the excess
//                             [--orderly-start 0]            a contract without the positions read kind (round 1)
//                                                            and an idle account leave the Orderly start unknown:
//                                                            assert it (signed ETH; checked against later pushes)
//                             [--close-only]                 skip the open: close what the desk holds
// ETH priced in the policy takes its oracle price from the contract's prices() (refresh a mock price first).
// Reads the repo's .env (values are never printed); testnet only. One engine process at a time (nonces).

import { parseArgs } from 'node:util';
import type { OrderlyRequest } from '../venues/orderly-signer.ts';
import type { OrderlyRestAction } from '../venues/orderly-signer.ts';
import { Relayer } from '../relayer/relayer.ts';
import { HyperliquidSubmitter } from '../relayer/hyperliquid.ts';
import { sendOrderlyRest } from '../relayer/orderly.ts';
import { HyperliquidReader, hlTradeFetch } from '../venues/hyperliquid.ts';
import { OrderlyReader } from '../venues/orderly.ts';
import { ORDERLY_ENDPOINTS } from '../venues/orderly-http.ts';
import { OrderlyAccountStream } from '../venues/orderly-stream.ts';
import type { LegOutcome, LegSide, TradeLeg } from '../trade/legs.ts';
import { HlLeg, LegCheckError, OrderlyLeg } from '../trade/legs.ts';
import { lotQty, qtyString, signedQtyString, toQty } from '../trade/lots.ts';
import type { PairResult } from '../trade/pair.ts';
import { PairTrader } from '../trade/pair.ts';
import { legCaps, unpricedEntry } from '../contract/unpriced.ts';
import { liveTestnet, log as logAs, refs, reportFailure } from './live.ts';

const TAG = 'pair-live';
const { values } = parseArgs({
  options: {
    size: { type: 'string', default: '0.005' },
    long: { type: 'string', default: 'hyperliquid' },
    hold: { type: 'string', default: '5' },
    fail: { type: 'string' },
    'replay-copy': { type: 'boolean', default: false },
    'orderly-start': { type: 'string' },
    'close-only': { type: 'boolean', default: false },
  },
});
const log = (line: string) => logAs(TAG, line);
const HL_COIN = 'ETH';
/** Stops reopening the Orderly session; finish() calls it before it closes the session. */
let stopKeepUp = (): void => {};
const ORDERLY_SYMBOL = 'PERP_ETH_USDC';

try {
  await run();
} catch (err) {
  reportFailure(TAG, err);
}
// The private session and the public book socket would keep the process alive.
setTimeout(() => process.exit(), 500).unref();

async function run(): Promise<void> {
  if (values.long !== 'hyperliquid' && values.long !== 'orderly') throw new Error('--long must be hyperliquid or orderly');
  if (values.fail !== undefined && values.fail !== 'hyperliquid' && values.fail !== 'orderly') throw new Error('--fail must be hyperliquid or orderly');
  const live = await liveTestnet(TAG);
  const { desk, client } = live;
  const user = desk.evm_address.toLowerCase();

  // Every Orderly signed request goes through here, so --replay-copy can send the open order's exact bytes again.
  const signedOrders: OrderlyRestAction[] = [];
  const spied = new Proxy(client, {
    get(target, prop) {
      if (prop === 'orderlyRequest') {
        return async (deskId: string, req: OrderlyRequest, reason: string) => {
          const signed = await target.orderlyRequest(deskId, req, reason);
          if (req.kind === 'order') signedOrders.push(signed);
          return signed;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const orderlyTarget = { apiUrl: live.orderlyUrl, accountId: live.orderly.accountId, orderlyKey: live.orderly.orderlyKey };
  const relayer = new Relayer({
    contract: spied, deskId: live.cfg.deskId, hyperliquid: new HyperliquidSubmitter({ network: 'testnet', apiUrl: live.hlUrl }), orderly: orderlyTarget,
  });

  // ---- Hyperliquid leg ----
  const asset = desk.policy.hl_assets.find((a) => a.symbol === HL_COIN);
  if (asset === undefined) throw new Error(`${HL_COIN} is not in the desk's policy.hl_assets`);
  // Priced: the contract checks the band and values the cap at max(limit, its stored price); unpriced: max_sz instead.
  const unpriced = unpricedEntry(desk.policy, 'hyperliquid', HL_COIN);
  const storedPx = async (): Promise<number> => {
    const row = (await client.prices()).find((p) => p.asset === HL_COIN);
    if (row === undefined) throw new Error(`the contract has no stored ${HL_COIN} price (set_mock_price or refresh_prices first)`);
    const ageS = (Date.now() - row.at_ms) / 1000;
    if (ageS > desk.policy.oracle_max_age_s) throw new Error(`the contract's ${HL_COIN} price is ${Math.round(ageS)} s old, over oracle_max_age_s ${desk.policy.oracle_max_age_s}: refresh it first`);
    return Number(row.price_e8) / 1e8;
  };
  // Each leg by its own venue's policy symbol (contract/unpriced.ts): ETH on Hyperliquid, base_of(PERP_ETH_USDC) = ETH.
  const oraclePxOf = (venue: 'hyperliquid' | 'orderly', symbol: string) => (unpricedEntry(desk.policy, venue, symbol) !== undefined ? async () => null : storedPx);
  if (unpriced === undefined) log(`${HL_COIN} is priced: oracle ${await storedPx()} USD from the contract's prices()`);
  const hlReader = new HyperliquidReader({ network: 'testnet', url: `${live.hlUrl}/info` });
  const info = async (body: Record<string, unknown>): Promise<unknown> => {
    const res = await hlTradeFetch(live.hlUrl)(`${live.hlUrl}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`hyperliquid /info ${String(body.type)}: HTTP ${res.status}`);
    return res.json();
  };
  const hl = new HlLeg({
    relayer, info, user, coin: HL_COIN, asset: asset.index, szDecimals: asset.sz_decimals, oraclePx: oraclePxOf('hyperliquid', HL_COIN),
    bandBps: desk.policy.price_band_bps, ...legCaps(desk.policy, 'hyperliquid', HL_COIN),
    bestPx: async (side) => {
      const book = await hlReader.book(HL_COIN, 5);
      const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
      if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Hyperliquid testnet ${HL_COIN}`);
      return px;
    },
  });

  // ---- Orderly leg ----
  const market = await (await fetch(`${live.orderlyUrl}/v1/public/info/${ORDERLY_SYMBOL}`)).json() as { data?: { base_tick: number; base_min: number; quote_tick: number; min_notional: number } };
  if (market.data === undefined) throw new Error(`Orderly testnet has no ${ORDERLY_SYMBOL} info`);
  const orderlyReader = new OrderlyReader({ network: 'testnet', apiUrl: live.orderlyUrl, streamAccountId: live.orderly.accountId });
  let trader: PairTrader | null = null;
  let orderly: OrderlyLeg | null = null;
  const stream = new OrderlyAccountStream({
    deskId: live.cfg.deskId, accountId: live.orderly.accountId, orderlyKey: live.orderly.orderlyKey, signer: client, url: ORDERLY_ENDPOINTS.testnet.privateWs,
    reads: { positions: () => live.orderly.positions('pair-live: seed the session'), holding: () => live.orderly.holding('pair-live: seed the session') },
    onExecutionReport: (r) => {
      log(`executionreport ${String(r.symbol)} order ${String(r.orderId)} ${String(r.side)} ${String(r.status)} executed ${String(r.executedQuantity)} (total ${String(r.totalExecutedQuantity)} at ${String(r.avgPrice)})${r.clientOrderId ? ` client ${String(r.clientOrderId)}` : ''}`);
      orderly?.onExecutionReport(r);
    },
    onPositions: (positions, from) => {
      const qty = positions.filter((p) => p.symbol === ORDERLY_SYMBOL).reduce((s, p) => s + toQty(p.positionQty), 0n);
      log(`orderly positions (${from}): ${ORDERLY_SYMBOL} ${signedQtyString(qty)}`);
      // A session's seed read counts too: a copy that landed while the session was down shows up there first.
      if (trader !== null && orderly !== null) void trader.positionPushed(orderly, qty);
    },
  });
  orderly = new OrderlyLeg({
    relayer, readPositions: () => live.orderly.positions('pair-live: reconcile'), stream, symbol: ORDERLY_SYMBOL,
    lot: lotQty(String(market.data.base_tick)), baseMin: lotQty(String(market.data.base_min)), quoteTick: market.data.quote_tick,
    minNotional: market.data.min_notional, oraclePx: oraclePxOf('orderly', ORDERLY_SYMBOL), ...legCaps(desk.policy, 'orderly', ORDERLY_SYMBOL),
    bestPx: async (side) => {
      const book = await orderlyReader.book(ORDERLY_SYMBOL, 5);
      const px = side === 'BUY' ? book.asks[0]?.px : book.bids[0]?.px;
      if (px === undefined) throw new Error(`no ${side === 'BUY' ? 'asks' : 'bids'} on Orderly testnet ${ORDERLY_SYMBOL}`);
      return px;
    },
    ...(values['orderly-start'] === undefined ? {} : { assumedStart: toQty(values['orderly-start']) }),
    log,
  });

  log(`orderly_ws_auth: opening the desk's private session (one signature)`);
  await stream.start();
  try {
    await stream.state();
  } catch (err) {
    log(`orderly session: ${(err as Error).message}`);
  }

  const legs: [TradeLeg, TradeLeg] = [
    values.fail === 'hyperliquid' ? failing(hl) : hl,
    values.fail === 'orderly' ? failing(orderly) : orderly,
  ];
  // panic_close: a desk that get_desk shows closing takes no open, only the reduce-only close (read again before the open).
  const closingNote = (d: { closing?: boolean } | null) => (d?.closing === true ? 'the desk is closing (panic_close): only reduce-only closes go out' : null);
  let closing = closingNote(desk);
  trader = new PairTrader({
    legs, log, priceBandBps: desk.policy.price_band_bps, openBlocked: () => closing,
    // An alert the watch raises, or raises again (an order with no answer whose window ended), reaches the operator.
    onWatch: (w) => {
      if (w.status === 'unhedged') alert(`watch: ${w.notes.join('; ')}`);
    },
  });
  // A session that dies while Orderly orders can still be replayed is opened again (one more signature); its seed
  // read goes through positionPushed like a push, so a copy that landed while it was down is still checked.
  const watchedTrader = trader;
  const orderlyLeg = orderly;
  const keepUp = setInterval(() => {
    const down = stream.down;
    if (down === null || !watchedTrader.watching(orderlyLeg)) return;
    log(`orderly session down (${down.message}) inside the replay window: opening it again`);
    stream.start().catch((err: Error) => log(`orderly session: ${err.message}`));
  }, 5_000);
  keepUp.unref();
  stopKeepUp = () => clearInterval(keepUp);
  const longIndex = values.long === 'hyperliquid' ? 0 : 1;

  if (values['close-only']) {
    print('close', await trader.close({ reason: 'pair-live: close' }));
    await finish(hl, stream, watchedTrader);
    return;
  }
  closing = closingNote(await client.getDesk(live.cfg.deskId));
  log(`open ${values.size} ETH: long ${values.long}${values.fail === undefined ? '' : `, ${values.fail} forced to fail`}`);
  const opened = await trader.open({ size: values.size!, longIndex, reason: `pair-live: open ${values.size} ETH, long ${values.long}` });
  print('open', opened);

  if (values['replay-copy'] && opened.status === 'open') {
    const original = signedOrders[0]!;
    log(`replay: sending the signed open order again (request ${original.request_id}, the same bytes anyone can read from the chain)`);
    try {
      const copy = await sendOrderlyRest<{ order_id?: unknown }>(original, 'order', { ...orderlyTarget, deskId: live.cfg.deskId });
      log(`replay: Orderly took the copy as order ${String(copy.order_id)}`);
    } catch (err) {
      log(`replay: Orderly refused the copy: ${(err as Error).message}`);
    }
    // The copy's position push starts the check (positionPushed): a REST positions read, then the excess close (one
    // more signature, up to 120 s).
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      if (trader.lastWatch !== null) break;
    }
    const watch = trader.lastWatch;
    if (watch === null) log('replay: no reconcile ran (no push over the target arrived)');
    else {
      log(`replay: watch ${watch.status}${watch.notes.length === 0 ? '' : ` (${watch.notes.join('; ')})`}`);
      for (const leg of watch.legs) {
        log(`  ${leg.venue} ${leg.start} -> ${leg.final ?? 'unknown'} (intent ${leg.target}) with ${leg.orders.map((o) => `${o.purpose} ${o.ref.side} ${o.ref.size} ${o.outcome} (${o.ref.orderId})`).join(', ')}`);
      }
    }
  }

  if (opened.status === 'open') {
    await sleep(Number(values.hold) * 1000);
    const closed = await trader.close({ reason: 'pair-live: close' });
    print('close', closed);
  }

  await finish(hl, stream, watchedTrader);
}

/**
 * Both venues' final positions from their own state: Hyperliquid's clearinghouse, Orderly's last push or read. The
 * trader's watch ends with this process: an alert that stands, or an order that may still run, is said once more.
 */
async function finish(hl: HlLeg, stream: OrderlyAccountStream, trader: PairTrader): Promise<void> {
  await sleep(2000);
  const [hlFinal, orderlyFinal] = await Promise.all([
    hl.position(),
    stream.positionsState()
      .then((s) => `${signedQtyString(s.positions.filter((p) => p.symbol === ORDERLY_SYMBOL).reduce((acc, p) => acc + toQty(p.positionQty), 0n))} (${s.positionsFrom} at ${new Date(s.positionsAt).toISOString()})`)
      .catch((err: Error) => `unknown (${err.message})`),
  ]);
  log(`final positions: Hyperliquid ${HL_COIN} ${signedQtyString(hlFinal)}; Orderly ${ORDERLY_SYMBOL} ${orderlyFinal}`);
  stopKeepUp();
  stream.close();
  trader.stop();
  if (trader.unhedged !== null) alert(trader.unhedged);
  for (const leg of trader.legs) {
    const u = trader.unsettled(leg);
    if (u === null) continue;
    const orders = u.refs.map((ref) => `${ref.side} ${ref.size}${ref.reduceOnly ? ' reduce-only' : ''} (${ref.clientId ?? ref.orderId ?? 'no id'})`).join(' and ');
    alert(`${leg.venue} ${orders}: no answer, may still run until ${new Date(u.until).toISOString()}; the watch ends with this process: check ${leg.venue} ${leg.symbol} by hand until then`);
  }
  if (hlFinal !== 0n || !orderlyFinal.startsWith('0 ')) process.exitCode = 1;
}

/** The owner must act: on stderr, and the run fails. */
function alert(line: string): void {
  console.error(`[${TAG} ${new Date().toISOString()}] ALERT ${line}`);
  process.exitCode = 1;
}

/** The leg with its opening orders refused before signing (reduce-only closes still go out). */
function failing(leg: TradeLeg): TradeLeg {
  return {
    venue: leg.venue, symbol: leg.symbol, lot: leg.lot, replayable: leg.replayable,
    check: (size, reduceOnly) => leg.check(size, reduceOnly),
    maxSize: (side, reduceOnly) => leg.maxSize(side, reduceOnly),
    position: (after) => leg.position(after),
    order: async (side: LegSide, size: bigint, reduceOnly: boolean, reason: string): Promise<LegOutcome> => {
      if (reduceOnly) return leg.order(side, size, reduceOnly, reason);
      return {
        kind: 'failed', error: new LegCheckError(`${leg.venue}: forced failure (--fail), nothing signed`),
        ref: { venue: leg.venue, side, size: qtyString(size), reduceOnly, orderId: null, clientId: null, tx: [], sentAt: Date.now() },
      };
    },
  };
}

function print(what: string, r: PairResult): void {
  log(`${what}: ${r.status}, size ${r.size}${r.notes.length === 0 ? '' : ` (${r.notes.join('; ')})`}`);
  for (const leg of r.legs) {
    log(`  ${leg.venue} ${leg.symbol}: ${leg.start} -> target ${leg.target}, final ${leg.final ?? 'unknown'}`);
    for (const o of leg.orders) {
      log(`    ${o.purpose} ${o.ref.side} ${o.ref.size}${o.ref.reduceOnly ? ' reduce-only' : ''}: ${o.outcome}${o.filled === null ? '' : ` ${o.filled} at ${o.avgPx}`}`
        + ` order ${o.ref.orderId ?? '-'} client ${o.ref.clientId ?? '-'}${o.ref.expiresAfter === undefined ? '' : ` expiresAfter ${o.ref.expiresAfter} (${new Date(o.ref.expiresAfter).toISOString()})`}`
        + `${o.error === null ? '' : ` (${o.error})`}${o.ref.tx.length === 0 ? '' : ` ${refs(o.ref.tx)}`}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
