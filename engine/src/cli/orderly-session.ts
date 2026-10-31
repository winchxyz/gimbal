// The Orderly read-only live check: one private WebSocket session for the desk on Orderly testnet. The contract signs
// the login (orderly_ws_auth), the session subscribes, seeds positions and holding through the signed reads
// (orderly_request kinds `positions` and `holding`), and stays up for --seconds while Orderly pings. Nothing is
// traded. It passes when the login is accepted, both seed reads answer, and the session is still confirmed by the
// server at the end. A contract that does not have the read kinds refuses them (E_ARGS): the check then reports
// the refusal and whatever the pushes made known, and fails.
//   node src/cli/orderly-session.ts [--seconds 60] [--desk <id>]
// Reads the repo's .env (values are never printed); testnet only.

import { parseArgs } from 'node:util';
import { ORDERLY_ENDPOINTS } from '../venues/orderly-http.ts';
import type { OrderlyAccountSnapshot } from '../venues/orderly-stream.ts';
import { OrderlyAccountStream } from '../venues/orderly-stream.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { WebSocketFactory } from '../venues/ws.ts';
import { nativeWebSocket } from '../venues/ws.ts';
import { liveTestnet, log as logAs, reportFailure } from './live.ts';

const TAG = 'orderly-session';
const { values } = parseArgs({ options: { seconds: { type: 'string', default: '60' }, desk: { type: 'string' } } });
const seconds = Number(values.seconds);
if (!(seconds >= 5 && seconds <= 600)) throw new Error('--seconds must be between 5 and 600');
const log = (line: string) => logAs(TAG, line);

try {
  await run();
} catch (err) {
  reportFailure(TAG, err);
}

async function run(): Promise<void> {
  const live = await liveTestnet(TAG, values.desk);
  const frames: Record<string, number> = {};
  // Counts what the server sends, next to the stream's own listener, so the report shows pings and pushes.
  const webSocket: WebSocketFactory = (url) => {
    const ws = nativeWebSocket(url);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        const key = typeof msg.topic === 'string' ? `push ${msg.topic}` : `${String(msg.event ?? 'other')}${msg.success === false ? ' (refused)' : ''}`;
        frames[key] = (frames[key] ?? 0) + 1;
      } catch {
        frames['not JSON'] = (frames['not JSON'] ?? 0) + 1;
      }
    });
    return ws;
  };
  const readsSigned: string[] = [];
  const stream = new OrderlyAccountStream({
    deskId: live.cfg.deskId, accountId: live.orderly.accountId, orderlyKey: live.orderly.orderlyKey, signer: live.client,
    url: ORDERLY_ENDPOINTS.testnet.privateWs, webSocket,
    reads: {
      positions: () => { readsSigned.push('positions'); return live.orderly.positions('orderly-session: seed the private session'); },
      holding: () => { readsSigned.push('holding'); return live.orderly.holding('orderly-session: seed the private session'); },
    },
    onPositions: (positions, from) => log(`positions (${from}): ${positions.length === 0 ? 'flat' : positions.map((p) => `${p.symbol} ${p.positionQty}`).join(', ')}`),
  });

  const t0 = Date.now();
  log(`orderly_ws_auth: asking the contract to sign the login (MPC usually takes 5-6 s), account ${live.orderly.accountId}`);
  await stream.start();
  log(`login accepted in ${((Date.now() - t0) / 1000).toFixed(1)} s; subscribed to executionreport, position, balance`);

  let seed: OrderlyAccountSnapshot | null = null;
  let seedError: string | null = null;
  try {
    seed = await stream.state();
    log(`seeded: positions from ${seed.positionsFrom}, holding from ${seed.balancesFrom}: ${describe(seed)}`);
  } catch (err) {
    seedError = errorMessage(err);
    log(`seed: ${seedError}`);
  }

  const until = t0 + seconds * 1000;
  let lastConfirmed: number | null = null;
  let deadError: string | null = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(10_000, until - Date.now())));
    try {
      const snap = await stream.state();
      lastConfirmed = snap.confirmedAt;
      log(`up ${Math.round((Date.now() - t0) / 1000)} s; server last heard ${Date.now() - snap.confirmedAt} ms ago; ${describe(snap)}`);
    } catch (err) {
      const text = errorMessage(err);
      if (/closed|no frame from the server|error/.test(text) && !/seeds the session/.test(text)) {
        deadError = text;
        log(`session ended: ${text}`);
        break;
      }
      log(`up ${Math.round((Date.now() - t0) / 1000)} s; state not known: ${text}`);
    }
  }
  const upS = Math.round((Date.now() - t0) / 1000);
  stream.close();

  log(`frames from the server: ${Object.entries(frames).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log(`signatures: ${stream.signatures} ws auth, ${readsSigned.length} seed read(s) (${readsSigned.join(', ')})`);
  const pinged = (frames.ping ?? 0) > 0;
  const passed = deadError === null && seed !== null && seedError === null;
  log(`result: login ok; session up ${upS} s${deadError === null ? '' : ` then ended (${deadError})`}; pings ${pinged ? 'answered' : 'none seen'}; `
    + `seed ${seedError === null ? 'ok' : `FAILED (${seedError})`}${lastConfirmed === null ? '' : `; last confirmed ${new Date(lastConfirmed).toISOString()}`}`);
  if (!passed || !pinged) process.exitCode = 1;
}

function describe(s: OrderlyAccountSnapshot): string {
  const positions = s.positions.filter((p) => p.positionQty !== 0);
  const usdc = s.balances.USDC;
  return `${positions.length === 0 ? 'flat' : positions.map((p) => `${p.symbol} ${p.positionQty}`).join(', ')}; USDC ${usdc === undefined ? 'unknown' : `${usdc.holding} (frozen ${usdc.frozen})`}`;
}
