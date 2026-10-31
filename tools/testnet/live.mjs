#!/usr/bin/env node
// Live checks of a testnet deployment's signing: each step asks the contract for one signature
// (one MPC call at a time, 300 TGas, from the owner account), checks it here without trusting the
// contract, and sends it to the venue's testnet.
//
//   node tools/testnet/live.mjs <contract> <desk_id> <step> [--owner <account>]
//
// Steps:
//   hl         hl_order (unpriced BTC, GTC far under the mid): the signature must recover to the
//              desk's EVM address; then POST /exchange, whose answer names the address it recovered
//   register   GET /v1/registration_nonce, orderly_register, POST /v1/register_account
//   add-key    orderly_add_key (30 days), POST /v1/orderly_key
//   faucet     POST the operator's testnet USDC faucet for the desk (no signature)
//   order      orderly_request order (LIMIT buy, PERP_BTC_USDC, 3% under the mark), POST /v1/order;
//              --take: IOC buy 0.5% over the mark; --close: reduce-only IOC sell; --qty <base units>
//   replay     POSTs one signed order twice, unchanged: is a signed order good again? Default: a
//              resting LIMIT (replayed while open, then after its cancel); --ioc: an IOC buy that
//              fills, replayed after the fill, then the position read and closed (reduce-only IOC)
//   read <kind> orderly_request of a kind without fields (receiver_address, settle_nonce,
//              positions, holding, ...)
//   cancel <order_id>  orderly_request cancel of one PERP_BTC_USDC order
//   cancel-all orderly_request cancel_all PERP_BTC_USDC
//   ws         orderly_ws_auth, log in to the private stream, subscribe to position and balance and
//              print what arrives within 15 s or --listen <s> (does a subscribe push a snapshot?)
//   funding    orderly_request funding_fee_history for the last 7 days
//   funding-check  after a funding time with a position open: a resting order and its cancel make
//              Orderly push the position (accruedFundingFee), then the day's funding history
//   settle     settle_nonce, orderly_settle_pnl, settle_pnl
//   withdraw   withdraw_nonce, orderly_withdraw 1 USDC, withdraw_request (needs a balance)
//
// No key value is printed: signatures and public addresses only. Testnet only: every account id
// must end in .testnet, the RPC must serve chain "testnet" and the contract's network be Testnet.

import { actions, keccak256, loadKey, panicOf, send, sleep, testnetId, view } from './near.mjs';
import { hlL1Digest, hlSignature, recoverAddress } from './evm.mjs';

const HL_API = 'https://api.hyperliquid-testnet.xyz';
const ORDERLY_API = 'https://testnet-api.orderly.org';
const ORDERLY_PRIVATE_WS = 'wss://testnet-ws-private-evm.orderly.org/v2/ws/private/stream/';
const ORDERLY_FAUCET = 'https://testnet-operator-evm.orderly.org/v1/faucet/usdc';
const DAY_MS = 86_400_000;

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [contract, deskId, step] = positional;
const owner = args.includes('--owner') ? args[args.indexOf('--owner') + 1] : 'gimbal-owner-fcf135.testnet';
if (!contract || !deskId || !step) {
  console.error('usage: node tools/testnet/live.mjs <contract> <desk_id> <step> [--owner <account>]');
  process.exit(2);
}

testnetId(contract, 'contract');
testnetId(owner, 'owner');
const { orderly, network } = await view(contract, 'config');
if (network !== 'Testnet') throw new Error(`${contract} is configured for ${network}: refusing`);
const desk = await view(contract, 'get_desk', { desk_id: deskId });
if (!desk) throw new Error(`no desk ${deskId} on ${contract}`);
const orderlyKey = `ed25519:${desk.solana.authority}`;
const key = loadKey(owner);
const show = (label, x) => console.log(label, typeof x === 'string' ? x : JSON.stringify(x));

/** Calls an action method and returns its SignedAction, or throws with the refusal. */
async function signed(method, callArgs) {
  const out = await send(key, contract, [actions.call(method, callArgs, 300n, 0n)]);
  if (out.failure) throw new Error(`${method} ${out.hash}: ${panicOf(out.failure)}`);
  console.log(`${method}: tx ${out.hash} (${out.burntTgas} TGas)`);
  for (const log of out.logs) console.log('   ', log);
  return out.value;
}

/** EIP-55 form of a lowercase address. */
function checksum(addr) {
  const hex = addr.slice(2).toLowerCase();
  const hash = keccak256(Buffer.from(hex)).toString('hex');
  return '0x' + [...hex].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

const evmSigHex = (sig) => {
  const { r, s, v } = hlSignature(sig);
  return r + s.slice(2) + v.toString(16);
};

async function http(method, url, { body, headers = {}, quiet = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  show(`${method} ${url.replace(/^https:\/\/[^/]+/, '')} -> HTTP ${res.status}`, quiet ? `${text.length} bytes` : json);
  return json;
}

/** Sends a signed orderly_request with Orderly's headers. */
async function sendRest(action) {
  const p = action.payload;
  if (action.signature.scheme !== 'Ed25519') throw new Error('an Orderly request must be Ed25519-signed');
  const method = p.method.toUpperCase();
  const bodyless = method === 'GET' || method === 'DELETE';
  return http(method, ORDERLY_API + p.path, {
    ...(bodyless ? {} : { body: p.body }),
    headers: {
      'orderly-timestamp': String(p.timestamp),
      'orderly-account-id': desk.orderly_account_id,
      'orderly-key': orderlyKey,
      'orderly-signature': Buffer.from(action.signature.signature).toString('base64url'),
      'content-type': bodyless ? 'application/x-www-form-urlencoded' : 'application/json',
    },
  });
}

/**
 * Logs in to the private stream with one orderly_ws_auth signature and subscribes to the account
 * topics; prints every frame and keeps the position lists it pushes. Resolves once subscribed.
 */
async function privateStream() {
  const timestamp = Date.now();
  const action = await signed('orderly_ws_auth', { desk_id: deskId, timestamp });
  show('SignedAction', { ...action, signature: { scheme: action.signature.scheme } });
  const ws = new WebSocket(ORDERLY_PRIVATE_WS + desk.orderly_account_id);
  const started = Date.now();
  const positions = [];
  await new Promise((resolve, reject) => {
    let subscribed = 0;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 'auth-1',
        event: 'auth',
        params: { orderly_key: orderlyKey, sign: Buffer.from(action.signature.signature).toString('base64url'), timestamp },
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', ts: msg.ts }));
        return;
      }
      console.log(`ws +${Date.now() - started} ms`, JSON.stringify(msg).slice(0, 1500));
      if (msg.topic === 'position') positions.push(msg.data.positions);
      if (msg.event === 'auth' && msg.success) {
        for (const topic of ['executionreport', 'position', 'balance']) ws.send(JSON.stringify({ id: `sub-${topic}`, event: 'subscribe', topic }));
      }
      if (msg.event === 'auth' && !msg.success) reject(new Error(`ws login refused: ${msg.errorMsg}`));
      if (msg.event === 'subscribe' && ++subscribed === 3) resolve();
    });
    ws.addEventListener('error', (e) => reject(new Error(`ws error ${e.message ?? ''}`)));
  });
  return { positions, close: () => ws.close() };
}

const request = (req, reason) =>
  signed('orderly_request', { desk_id: deskId, req: { reduce_only: false, ...req, timestamp_ms: Date.now() }, reason });

/** POSTs an EIP-712 action, lowercase userAddress first; the checksummed one if Orderly refuses that. */
async function postEip712(path, action) {
  const lower = { message: action.payload.message, signature: evmSigHex(action.signature), userAddress: desk.evm_address };
  const first = await http('POST', ORDERLY_API + path, { body: lower });
  if (first?.success) return { answer: first, lowercase: 'accepted' };
  const second = await http('POST', ORDERLY_API + path, { body: { ...lower, userAddress: checksum(desk.evm_address) } });
  return { answer: second, lowercase: `refused (${first?.code}: ${first?.message})` };
}

switch (step) {
  case 'hl': {
    const mids = await http('POST', `${HL_API}/info`, { body: { type: 'allMids' }, quiet: true });
    const mid = Number(mids.BTC);
    // 5 significant figures and at most 1 decimal for BTC (szDecimals 5): whole dollars, 80% of the mid.
    const px = String(Math.floor(mid * 0.8));
    const sz = (Math.ceil((12 / Number(px)) * 1e5) / 1e5).toFixed(5).replace(/0+$/, '');
    show('order', { mid, px, sz });
    const action = await signed('hl_order', {
      desk_id: deskId,
      order: { asset: 3, is_buy: true, px, sz, reduce_only: false, tif: 'Gtc', cloid: null },
      reason: 'C5 live check: testnet hl_order',
    });
    show('SignedAction', action);
    const digest = hlL1Digest(action.payload);
    const { r, s, v } = hlSignature(action.signature);
    const got = recoverAddress(digest, Buffer.from(r.slice(2), 'hex'), Buffer.from(s.slice(2), 'hex'), v - 27);
    show('recomputed digest', '0x' + digest.toString('hex'));
    show('recovers to', `${got} (${got === desk.evm_address ? 'the desk EVM address' : 'NOT ' + desk.evm_address})`);
    await http('POST', `${HL_API}/exchange`, { body: { ...action.payload, signature: { r, s, v } } });
    break;
  }
  case 'register': {
    const nonce = await http('GET', `${ORDERLY_API}/v1/registration_nonce`);
    const registrationNonce = String(nonce.data.registration_nonce);
    const action = await signed('orderly_register', { desk_id: deskId, registration_nonce: registrationNonce });
    show('SignedAction', action);
    const out = await postEip712('/v1/register_account', action);
    show('lowercase userAddress', out.lowercase);
    show('account id', `${out.answer?.data?.account_id} (desk: ${desk.orderly_account_id})`);
    break;
  }
  case 'add-key': {
    const action = await signed('orderly_add_key', { desk_id: deskId, expiration_ms: Date.now() + 30 * DAY_MS });
    show('SignedAction', action);
    const out = await postEip712('/v1/orderly_key', action);
    show('lowercase userAddress', out.lowercase);
    break;
  }
  case 'faucet': {
    const chain = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : String(orderly.chain_id);
    await http('POST', ORDERLY_FAUCET, { body: { chain_id: chain, user_address: desk.evm_address, broker_id: orderly.broker_id } });
    break;
  }
  case 'order': {
    const fut = await http('GET', `${ORDERLY_API}/v1/public/futures/PERP_BTC_USDC`);
    const mark = Number(fut.data.mark_price);
    // --take buys at once (IOC 0.5% over the mark); --close sells the same size back, reduce-only.
    const take = args.includes('--take') || args.includes('--close');
    const close = args.includes('--close');
    const price = String(close ? Math.floor(mark * 0.995) : take ? Math.ceil(mark * 1.005) : Math.floor(mark * 0.97));
    const quantity = args.includes('--qty') ? args[args.indexOf('--qty') + 1] : (Math.ceil((12 / Number(price)) * 1e5) / 1e5).toFixed(5).replace(/0+$/, '');
    show('order', { mark, price, quantity, take, close });
    const action = await request(
      {
        kind: 'order',
        symbol: 'PERP_BTC_USDC',
        side: close ? 'SELL' : 'BUY',
        order_type: take ? 'IOC' : 'LIMIT',
        price,
        quantity,
        reduce_only: close,
      },
      'C5 live check: testnet Orderly order',
    );
    show('SignedAction', action);
    await sendRest(action);
    break;
  }
  case 'replay': {
    // Anyone who reads the chain holds the signed request, so this POSTs the very same request
    // (headers, timestamp, body) again and records what Orderly answers.
    const ioc = args.includes('--ioc');
    const fut = await http('GET', `${ORDERLY_API}/v1/public/futures/PERP_BTC_USDC`, { quiet: true });
    const mark = Number(fut.data.mark_price);
    const price = String(ioc ? Math.ceil(mark * 1.005) : Math.floor(mark * 0.97));
    const quantity = (Math.ceil((12 / Number(price)) * 1e5) / 1e5).toFixed(5).replace(/0+$/, '');
    show('order', { mark, price, quantity, type: ioc ? 'IOC' : 'LIMIT' });
    const order = await request(
      { kind: 'order', symbol: 'PERP_BTC_USDC', side: 'BUY', order_type: ioc ? 'IOC' : 'LIMIT', price, quantity },
      `C5 live check: replay of a signed ${ioc ? 'IOC' : 'LIMIT'}`,
    );
    show('client_order_id', JSON.parse(order.payload.body).client_order_id);
    const position = async () => {
      const out = await sendRest(await request({ kind: 'positions' }, 'C5 live check: positions'));
      return Number(out?.data?.rows?.find((r) => r.symbol === 'PERP_BTC_USDC')?.position_qty ?? 0);
    };
    const cancel = async (orderId) =>
      sendRest(await request({ kind: 'cancel', symbol: 'PERP_BTC_USDC', order_id: orderId }, 'C5 live check: cancel'));
    const before = ioc ? await position() : 0;
    const first = await sendRest(order);
    show('first POST', first?.success ? `accepted, order ${first.data?.order_id}` : `refused (${first?.code}: ${first?.message})`);
    await sleep(3000);
    const again = await sendRest(order);
    const verdict = (r) => (r?.success ? `ACCEPTED, order ${r.data?.order_id}` : `refused (${r?.code}: ${r?.message})`);
    show(ioc ? 'replay after the fill' : 'replay while open', verdict(again));
    if (ioc) {
      const after = await position();
      show('PERP_BTC_USDC position', { before, after, filled_per_order: quantity });
      if (after > 0) {
        const close = await request(
          { kind: 'order', symbol: 'PERP_BTC_USDC', side: 'SELL', order_type: 'IOC', price: String(Math.floor(mark * 0.99)), quantity: String(after), reduce_only: true },
          'C5 live check: close after the replay',
        );
        await sendRest(close);
      }
    } else {
      if (first?.data?.order_id) await cancel(first.data.order_id);
      if (again?.data?.order_id) await cancel(again.data.order_id);
      await sleep(3000);
      const late = await sendRest(order);
      show('replay after the cancel', verdict(late));
      if (late?.data?.order_id) await cancel(late.data.order_id);
    }
    show('signed at', `${order.payload.timestamp}; last POST ${Date.now() - order.payload.timestamp} ms later`);
    break;
  }
  case 'read': {
    const kind = positional[3];
    const action = await request({ kind }, `C5 live check: ${kind}`);
    show('signed', `${action.payload.method} ${action.payload.path}`);
    await sendRest(action);
    break;
  }
  case 'cancel': {
    const orderId = Number(positional[3]);
    const action = await request({ kind: 'cancel', symbol: 'PERP_BTC_USDC', order_id: orderId }, 'C5 live check: cancel');
    show('signed', `${action.payload.method} ${action.payload.path}`);
    await sendRest(action);
    break;
  }
  case 'cancel-all': {
    const action = await request({ kind: 'cancel_all', symbol: 'PERP_BTC_USDC' }, 'C5 live check: cancel all');
    await sendRest(action);
    break;
  }
  case 'ws': {
    const stream = await privateStream();
    await sleep(1000 * Number(args.includes('--listen') ? args[args.indexOf('--listen') + 1] : 15));
    stream.close();
    break;
  }
  case 'funding-check': {
    // Position pushes come only on a change, so a resting order (placed, then cancelled) makes
    // Orderly push the position with its accruedFundingFee; then the funding history of the day.
    const stream = await privateStream();
    const fut = await http('GET', `${ORDERLY_API}/v1/public/futures/PERP_BTC_USDC`, { quiet: true });
    show('PERP_BTC_USDC', { last_funding_rate: fut.data.last_funding_rate, sum_unitary_funding: fut.data.sum_unitary_funding });
    const price = String(Math.floor(Number(fut.data.mark_price) * 0.97));
    const order = await request(
      { kind: 'order', symbol: 'PERP_BTC_USDC', side: 'BUY', order_type: 'LIMIT', price, quantity: '0.00017' },
      'C5 live check: a resting order to make Orderly push the position',
    );
    const placed = await sendRest(order);
    for (let i = 0; i < 20 && !stream.positions.length; i++) await sleep(500);
    for (const p of stream.positions.at(-1) ?? []) {
      show('position', { symbol: p.symbol, positionQty: p.positionQty, lastSumUnitaryFunding: p.lastSumUnitaryFunding, accruedFundingFee: p.accruedFundingFee, unsettledPnl: p.unsettledPnl });
    }
    if (placed?.data?.order_id) await sendRest(await request({ kind: 'cancel', symbol: 'PERP_BTC_USDC', order_id: placed.data.order_id }, 'C5 live check: cancel'));
    stream.close();
    const end = Date.now();
    await sendRest(await request({ kind: 'funding_fee_history', start_t: end - DAY_MS, end_t: end, page: 1, size: 60 }, 'C5 live check: funding history'));
    break;
  }
  case 'funding': {
    const end = Date.now();
    const action = await request({ kind: 'funding_fee_history', symbol: null, start_t: end - 7 * DAY_MS, end_t: end, page: 1, size: 60 }, 'C5 live check: funding history');
    await sendRest(action);
    break;
  }
  case 'settle': {
    const nonceAction = await request({ kind: 'settle_nonce' }, 'C5 live check: settle nonce');
    const nonce = await sendRest(nonceAction);
    const settleNonce = Number(nonce.data.settle_nonce);
    const action = await signed('orderly_settle_pnl', { desk_id: deskId, settle_nonce: settleNonce });
    show('SignedAction', action);
    const settle = await request(
      { kind: 'settle_pnl', nonce: settleNonce, signed_at_ms: Number(action.payload.message.timestamp), eip712_signature: evmSigHex(action.signature) },
      'C5 live check: settle pnl',
    );
    show('settle_pnl body', settle.payload.body);
    await sendRest(settle);
    break;
  }
  case 'withdraw': {
    const amount = args.includes('--amount') ? args[args.indexOf('--amount') + 1] : '1';
    const nonceAction = await request({ kind: 'withdraw_nonce' }, 'C5 live check: withdraw nonce');
    const nonce = await sendRest(nonceAction);
    const withdrawNonce = Number(nonce.data.withdraw_nonce);
    const action = await signed('orderly_withdraw', { desk_id: deskId, amount, withdraw_nonce: withdrawNonce });
    show('SignedAction', action);
    const req = await request(
      { kind: 'withdraw_request', amount, nonce: withdrawNonce, signed_at_ms: Number(action.payload.message.timestamp), eip712_signature: evmSigHex(action.signature) },
      'C5 live check: withdraw',
    );
    show('withdraw_request body', req.payload.body);
    await sendRest(req);
    break;
  }
  default:
    console.error(`unknown step ${step}`);
    process.exit(2);
}
