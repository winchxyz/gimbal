// The public live view's build: read-only with no Settings step, every write control left out, the engine's masked
// ids, the Owner link, and the host's not-configured state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_CONFIGURED_TEXT, parseHostedHealth, parseOwnerWrites } from './hosted.ts';
import {
  hostedLiveFlag, isHostedLive, isReadOnly, isRemote, remoteSettings, setHostedLiveForTests, setRemoteSettingsForTests, writeControls,
  writeControlsFor,
} from './readonly.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('only VITE_HOSTED_LIVE=1 makes the hosted-live build; no flag (or no Vite env) leaves every other build as it was', () => {
  assert.equal(hostedLiveFlag({ VITE_HOSTED_LIVE: '1' }), true);
  for (const env of [undefined, {}, { VITE_HOSTED_LIVE: '' }, { VITE_HOSTED_LIVE: '0' }, { VITE_HOSTED_LIVE: 'true' }, { VITE_HOSTED_REPLAY: '1' }]) {
    assert.equal(hostedLiveFlag(env), false);
  }
  assert.equal(isHostedLive(), false);
});

test('the hosted-live build is read-only from the start: no Settings step, a saved address ignored, every write control left out', () => {
  try {
    setHostedLiveForTests(true);
    setRemoteSettingsForTests(undefined);
    // Whatever a visitor once saved in Settings, the page reads its own origin.
    assert.deepEqual(remoteSettings(), { base: null, token: null });
    assert.equal(isRemote(), false);
    assert.equal(isReadOnly(), true, 'read-only, so the Security screen masks the owner\'s and the operator\'s ids');
    assert.deepEqual(writeControls(), { close: false, rotate: false, enter: false, stress: false, owner: false, money: false, onboarding: false });
    assert.deepEqual(writeControls(), writeControlsFor(true));
  } finally {
    setHostedLiveForTests(undefined);
    setRemoteSettingsForTests(undefined);
  }
});

test('owner writes: the host says so in /healthz, and only then (or unlocked) does the header draw the Owner link', () => {
  // The header line's wording (live never called a replay, a replay never live) is tested in shell/headline.test.ts.
  // The host says owner writes are on only with `owner: true` in /healthz; anything else is off.
  assert.equal(parseOwnerWrites({ ok: true, live: 'connected', visitors: 1, owner: true }), true);
  for (const body of [null, {}, { ok: true, live: 'connected', visitors: 1 }, { owner: 'true' }, { owner: 1 }]) assert.equal(parseOwnerWrites(body), false);
  // The Owner link is drawn only when the host says so, or this tab is unlocked (to Lock).
  const header = readFileSync(join(root, 'web', 'src', 'shell', 'Header.tsx'), 'utf8');
  assert.match(header, /\{isHostedLive\(\) && \(ownerWrites \|\| unlocked\) \? <a className="quiet" href=\{OWNER_HREF\}>Owner<\/a> : null\}/);
});

test('the host\'s /healthz: its live state, anything else unknown', () => {
  for (const live of ['connected', 'connecting', 'down', 'not-configured'] as const) assert.equal(parseHostedHealth({ ok: true, live }), live);
  for (const body of [null, {}, { live: 'up' }, 'connected', { live: 3 }]) assert.equal(parseHostedHealth(body), 'unknown');
  assert.match(NOT_CONFIGURED_TEXT, /no desk to show/);
});

test('only the live host builds the page with VITE_HOSTED_LIVE=1; the Vite config only reads it', () => {
  assert.match(readFileSync(join(root, 'engine/src/cli/live-host.ts'), 'utf8'), /VITE_HOSTED_LIVE: '1'/);
  for (const file of ['Dockerfile', 'Dockerfile.replay', 'package.json', 'web/package.json', 'tools/demo.mjs', 'engine/src/cli/replay-host.ts']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /VITE_HOSTED_LIVE/, file);
  }
  const vite = readFileSync(join(root, 'web/vite.config.ts'), 'utf8');
  assert.doesNotMatch(vite, /VITE_HOSTED_LIVE\s*(=|:)\s*['"]1/);
  assert.match(vite, /process\.env\.VITE_HOSTED_LIVE === '1'/);
  assert.match(vite, /content="hosted-live"/);
});

test('the hosted-live page leaves out the engine settings and uses read-only API calls', () => {
  const src = join(root, 'web', 'src');
  assert.match(readFileSync(join(src, 'shell/Shell.tsx'), 'utf8'), /useConnectRoute\(\) && !isHostedLive\(\)/);
  // Locked (no owner token in the tab), every write is refused in the page; unlocked, only rotate and close carry the owner header.
  assert.match(readFileSync(join(src, 'stream/start.ts'), 'utf8'), /owner === null \? readOnlyApi\(httpApi\(\)\) : ownerApi\(httpApi\('', \{ \[OWNER_HEADER\]: owner \}\)\)/);
});
