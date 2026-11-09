// serve's read-only view: the settings from the environment, the redactor over the whole environment, the listener
// on 0.0.0.0, and its one start line. Off, or a port it cannot listen on, never stops serve: the engine guards the
// pair either way.

import { isLoopback } from '../server.ts';
import { errorMessage } from '../venues/recorder.ts';
import { ownerTokenFromEnv, viewConfigFromEnv } from './view-config.ts';
import { viewRedactor } from './view-redact.ts';
import { ViewServer } from './view-server.ts';
import type { OwnerCall, ViewSource } from './view-server.ts';

export interface StartViewInput {
  /** serve's envVar: empty counts as unset. */
  env: (name: string) => string | undefined;
  /** Every variable the process has: the redactor cuts the secret ones out of what the view serves. */
  processEnv: Readonly<Record<string, string | undefined>>;
  enginePort: number;
  /** The address the control API listens on (GIMBAL_HOST): the view starts only when it is loopback. */
  engineHost: string;
  source: ViewSource;
  log: (line: string) => void;
  /**
   * The engine's own server on loopback (serve-control.ts loopbackCall): what owner writes are sent to, when
   * GIMBAL_OWNER_TOKEN is set. Absent: owner writes stay off whatever the environment says.
   */
  ownerCall?: OwnerCall;
  /** Tests: the address to bind; default every interface. */
  host?: string;
}

export async function startView(input: StartViewInput): Promise<ViewServer | null> {
  const cfg = viewConfigFromEnv(input.env, input.enginePort);
  if ('off' in cfg) {
    input.log(cfg.off === null ? 'view: off' : `view: off: ${cfg.off}`);
    return null;
  }
  // The view is only safe next to a control API no one else reaches: with the engine on 0.0.0.0, port 8790 answers on
  // the platform's private network, where a request with Host: localhost passes its checks.
  if (!isLoopback(input.engineHost)) {
    input.log('view: off: the control API is not on loopback');
    return null;
  }
  const { token, port, origins } = cfg.config;
  // Owner writes: unset says nothing (the start line is as before); a value that cannot be used says why, never what.
  const owner = ownerTokenFromEnv(input.env, token);
  const ownerOn = 'token' in owner && input.ownerCall !== undefined ? { token: owner.token, call: input.ownerCall } : undefined;
  const ownerNote = ownerOn !== undefined
    ? '; owner writes on: POST /rotate, POST /close and PUT /strategy with the view token and GIMBAL_OWNER_TOKEN, sent to the engine\'s own routes'
    : 'off' in owner && owner.off !== null ? `; owner writes off: ${owner.off}` : '';
  const view = new ViewServer({ source: input.source, token, origins, redact: viewRedactor(input.processEnv), log: input.log, ...(ownerOn === undefined ? {} : { owner: ownerOn }) });
  try {
    const listening = await view.start(port, input.host ?? '0.0.0.0');
    input.log(`view: ${ownerOn === undefined ? 'read-only' : 'reads'} on :${listening} for origins ${origins.length === 0 ? '(none: no browser page may call it)' : origins.join(', ')}${ownerNote}`);
    return view;
  } catch (err) {
    input.log(`view: off: cannot listen on :${port} (${errorMessage(err)})`);
    return null;
  }
}
