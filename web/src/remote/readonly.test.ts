// Remote mode is read-only: which write controls the page leaves out, and that every component that holds one asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedReplayFlag, isHostedReplay, isReadOnly, setRemoteSettingsForTests, writeControls, writeControlsFor } from './readonly.ts';
import { hasOwnLine, type Problem } from './problem.ts';

test('remote mode hides every control that writes', () => {
  assert.deepEqual(writeControlsFor(true), { close: false, rotate: false, stress: false, owner: false, money: false, onboarding: false });
});

test('the local engine keeps all of them, as before', () => {
  assert.deepEqual(writeControlsFor(false), { close: true, rotate: true, stress: true, owner: true, money: true, onboarding: true });
  assert.deepEqual(writeControlsFor(false, false), writeControlsFor(false));
});

test('the hosted replay build keeps the stress test only; remote stays all off', () => {
  assert.deepEqual(writeControlsFor(false, true), { close: false, rotate: false, stress: true, owner: false, money: false, onboarding: false });
  assert.deepEqual(writeControlsFor(true, true), writeControlsFor(true));
});

test('only VITE_HOSTED_REPLAY=1 makes the hosted build; the normal build (no flag, or no Vite env) is unchanged', () => {
  assert.equal(hostedReplayFlag({ VITE_HOSTED_REPLAY: '1' }), true);
  for (const env of [undefined, {}, { VITE_HOSTED_REPLAY: '' }, { VITE_HOSTED_REPLAY: '0' }, { VITE_HOSTED_REPLAY: 'true' }]) assert.equal(hostedReplayFlag(env), false);
  assert.equal(isHostedReplay(), false);
  try {
    setRemoteSettingsForTests({ base: null, token: null });
    assert.deepEqual(writeControls(), writeControlsFor(false));
  } finally {
    setRemoteSettingsForTests(undefined);
  }
});

test('only Dockerfile.replay builds the page with VITE_HOSTED_REPLAY=1', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  assert.match(readFileSync(join(root, 'Dockerfile.replay'), 'utf8'), /VITE_HOSTED_REPLAY=1 npm run build -w web/);
  for (const file of ['Dockerfile', 'package.json', 'web/package.json', 'tools/demo.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /VITE_HOSTED_REPLAY/, file);
  }
  // The Vite config only reads it (to mark the hosted build's index.html), never sets it.
  const vite = readFileSync(join(root, 'web/vite.config.ts'), 'utf8');
  assert.doesNotMatch(vite, /VITE_HOSTED_REPLAY\s*(=|:)\s*['"]1/);
  assert.match(vite, /process\.env\.VITE_HOSTED_REPLAY === '1' \?/);
});

test('an address in the settings makes the page read-only; none leaves it local', () => {
  try {
    setRemoteSettingsForTests({ base: null, token: null });
    assert.equal(isReadOnly(), false);
    assert.equal(writeControls().close, true);
    setRemoteSettingsForTests({ base: 'https://engine.example', token: null });
    assert.equal(isReadOnly(), true, 'an address without a token is still the remote page, never a silent fall back to local');
    assert.equal(Object.values(writeControls()).some(Boolean), false);
    setRemoteSettingsForTests({ base: 'https://engine.example', token: 'x'.repeat(40) });
    assert.equal(isReadOnly(), true);
  } finally {
    setRemoteSettingsForTests(undefined);
  }
});

test('every component that draws a write control asks writeControls first', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const gated: [string, string][] = [
    ['shell/Header.tsx', 'money'],
    ['shell/StatusActions.tsx', 'owner'],
    ['desk/Decision.tsx', 'close'],
    ['windows/WindowList.tsx', 'rotate'],
    ['rescue/Stress.tsx', 'stress'],
    ['journal/States.tsx', 'money'],
    ['security/States.tsx', 'onboarding'],
    ['shell/Shell.tsx', 'onboarding'],
    ['desk/DeskScreen.tsx', 'owner'],
    ['windows/Detail.tsx', 'close'],
    ['windows/Detail.tsx', 'rotate'],
  ];
  for (const [file, control] of gated) {
    const code = readFileSync(join(src, file), 'utf8');
    assert.ok(code.includes(`writeControls().${control}`), `${file} does not check writeControls().${control}`);
  }
});

test('the remote bar leaves the generic outage wording to the connection bar', () => {
  const p = (kind: Problem['kind']): Problem => ({ kind, title: '', text: '' });
  assert.equal(hasOwnLine(null), false);
  assert.equal(hasOwnLine(p('status')), false);
  assert.equal(hasOwnLine(p('unreachable')), false);
  for (const kind of ['token', 'needs-token', 'origin', 'limited', 'streams'] as const) assert.equal(hasOwnLine(p(kind)), true, kind);
});
