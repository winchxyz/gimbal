// `node --import ./no-egress-preload.ts serve.ts`: the hosted replay's engine, with every outbound connection refused
// (no-egress.ts). Loaded before serve's first import, so nothing it starts can connect out first.

import { refuseEgress } from './no-egress.ts';

refuseEgress((line) => console.log(`[engine ${new Date().toISOString()}] ${line}`));
console.log(`[engine ${new Date().toISOString()}] hosted replay: outbound connections refused in this process (loopback only)`);
