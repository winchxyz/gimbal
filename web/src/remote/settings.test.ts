// The remote settings: where each value is kept (the token in sessionStorage only), what is accepted, and that nothing
// reads or writes the page address, the history, a cookie or a log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_KEY,
  TOKEN_KEY,
  forgetToken,
  parseBase,
  parseToken,
  readSettings,
  saveSettings,
  switchToLocal,
  type KeyStore,
  type Stores,
} from './settings.ts';

class MemoryStore implements KeyStore {
  readonly data = new Map<string, string>();
  getItem = (key: string): string | null => this.data.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.data.set(key, value);
  removeItem = (key: string): void => void this.data.delete(key);
}

const stores = (): { local: MemoryStore; session: MemoryStore; both: Stores } => {
  const local = new MemoryStore();
  const session = new MemoryStore();
  return { local, session, both: { local, session } };
};

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

test('the token is stored in sessionStorage only; the address goes to localStorage', () => {
  const { local, session, both } = stores();
  saveSettings(both, 'https://engine.example', TOKEN);
  assert.equal(session.getItem(TOKEN_KEY), TOKEN);
  assert.equal(local.getItem(BASE_KEY), 'https://engine.example');
  assert.equal(local.getItem(TOKEN_KEY), null, 'not in localStorage');
  for (const value of local.data.values()) assert.ok(!value.includes(TOKEN), 'the token is nowhere in localStorage');
  assert.equal(session.getItem(BASE_KEY), null);
  assert.deepEqual(readSettings(both), { base: 'https://engine.example', token: TOKEN });
});

test('the token key is the one the engine side documents', () => {
  assert.equal(TOKEN_KEY, 'gimbal.view.token');
});

test('Forget clears the token and keeps the address; going local clears both', () => {
  const { local, session, both } = stores();
  saveSettings(both, 'https://engine.example', TOKEN);
  forgetToken(both);
  assert.equal(session.getItem(TOKEN_KEY), null);
  assert.deepEqual(readSettings(both), { base: 'https://engine.example', token: null });
  saveSettings(both, 'https://engine.example', TOKEN);
  switchToLocal(both);
  assert.equal(local.getItem(BASE_KEY), null);
  assert.deepEqual(readSettings(both), { base: null, token: null });
});

test('with nothing saved the app is local, exactly as before', () => {
  assert.deepEqual(readSettings(stores().both), { base: null, token: null });
  assert.deepEqual(readSettings({ local: null, session: null }), { base: null, token: null });
});

test('a storage that throws is the same as an empty one', () => {
  const broken: KeyStore = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const both: Stores = { local: broken, session: broken };
  assert.deepEqual(readSettings(both), { base: null, token: null });
  assert.doesNotThrow(() => saveSettings(both, 'https://engine.example', TOKEN));
  assert.doesNotThrow(() => forgetToken(both));
});

test('a stored address or token that is not valid is ignored', () => {
  const { local, session, both } = stores();
  local.setItem(BASE_KEY, 'https://engine.example/state?x=1');
  session.setItem(TOKEN_KEY, 'has a space');
  assert.deepEqual(readSettings(both), { base: null, token: null });
});

test('the address is reduced to its origin; a path, a query, a fragment or a login is refused', () => {
  assert.deepEqual(parseBase(' https://engine.example/ '), { ok: true, value: 'https://engine.example' });
  assert.deepEqual(parseBase('https://engine.example:8443'), { ok: true, value: 'https://engine.example:8443' });
  assert.deepEqual(parseBase('http://localhost:8791'), { ok: true, value: 'http://localhost:8791' });
  assert.deepEqual(parseBase('http://127.0.0.1:8791/'), { ok: true, value: 'http://127.0.0.1:8791' });
  for (const bad of ['', 'engine.example', 'ftp://engine.example', 'https://engine.example/state', 'https://engine.example?token=abc', 'https://engine.example#token=abc', 'https://user:pw@engine.example']) {
    assert.equal(parseBase(bad).ok, false, bad);
  }
  assert.equal(parseBase('http://engine.example').ok, false, 'plain http is for this machine only');
});

test('the token is checked for what a header can carry, and the refusal never repeats it', () => {
  assert.deepEqual(parseToken(`  ${TOKEN}\n`), { ok: true, value: TOKEN });
  for (const bad of ['', '   ', 'two words', 'tab\tinside', 'naïve', 'x'.repeat(513)]) {
    const result = parseToken(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.ok(!result.reason.includes(bad.trim()) || bad.trim() === '');
  }
});

test('nothing in the remote code puts a token in the address, the history, a cookie or a log, or reads one from the address', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
  assert.ok(files.length >= 6);
  const banned = [/document\.cookie/, /\bpushState\b/, /\breplaceState\b/, /\bconsole\./, /location\.search/, /URLSearchParams/, /\.localStorage\.setItem|localStorage\[/];
  for (const file of files) {
    // Comments may talk about all of these; only code is checked.
    const code = readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const pattern of banned) assert.ok(!pattern.test(code), `${file} must not use ${pattern}`);
    // The only address the code reads is the hash route, and the token key is never used beside it.
    if (/window\.location\.hash|location\.hash/.test(code)) assert.ok(!/TOKEN_KEY|token/i.test(code.split('\n').filter((l) => /location\.hash/.test(l)).join('\n')), file);
  }
});
