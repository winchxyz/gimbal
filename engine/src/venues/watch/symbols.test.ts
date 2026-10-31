import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseFields, normalizeBase, splitQuote } from './symbols.ts';

test('size prefixes and suffixes become a multiplier', () => {
  assert.deepEqual(normalizeBase('kPEPE'), { base: 'PEPE', multiplier: 1000 });            // Hyperliquid, Pacifica
  assert.deepEqual(normalizeBase('1000PEPE'), { base: 'PEPE', multiplier: 1000 });         // Binance-style
  assert.deepEqual(normalizeBase('10000SATS'), { base: 'SATS', multiplier: 10_000 });
  assert.deepEqual(normalizeBase('1000000MOG'), { base: 'MOG', multiplier: 1_000_000 });
  assert.deepEqual(normalizeBase('1MBABYDOGE'), { base: 'BABYDOGE', multiplier: 1_000_000 });
  assert.deepEqual(normalizeBase('SHIB1000'), { base: 'SHIB', multiplier: 1000 });         // Bybit-style
});

test('names that only look like a prefix are left alone', () => {
  assert.deepEqual(normalizeBase('1INCH'), { base: '1INCH', multiplier: 1 });
  assert.deepEqual(normalizeBase('KAITO'), { base: 'KAITO', multiplier: 1 });
  assert.deepEqual(normalizeBase('ME'), { base: 'ME', multiplier: 1 });
  assert.deepEqual(normalizeBase('2Z'), { base: '2Z', multiplier: 1 });
});

test('equity suffixes are dropped and aliases applied', () => {
  assert.equal(normalizeBase('NVDA.US').base, 'NVDA');          // Backpack
  const stocks = { stockSuffix: true };                         // MEXC, Bitget
  assert.equal(normalizeBase('TSLASTOCK', stocks).base, 'TSLA');
  assert.equal(normalizeBase('CSTOCK', stocks).base, 'C');      // Citigroup: a one-letter ticker
  assert.equal(normalizeBase('TSTOCK', stocks).base, 'T');      // AT&T
  assert.equal(normalizeBase('VSTOCK', stocks).base, 'V');      // Visa
  assert.equal(normalizeBase('4STOCK', stocks).base, '4STOCK'); // MEXC's coin called 4STOCK
  assert.equal(normalizeBase('STOCK', stocks).base, 'STOCK');
  assert.deepEqual(baseFields('CSTOCK', stocks), { base: 'C' });
  // A venue that does not mark its stocks so keeps the name: Aster's GSTOCKUSDT is a coin, not stock G.
  assert.equal(normalizeBase('GSTOCK').base, 'GSTOCK');
  assert.equal(normalizeBase('TSLASTOCK').base, 'TSLASTOCK');
  assert.equal(normalizeBase('XAU_24_5').base, 'XAU');          // Extended
  assert.equal(normalizeBase('XBT').base, 'BTC');               // Kraken, KuCoin
  assert.equal(normalizeBase('GOLD').base, 'XAU');
  assert.equal(normalizeBase('US500').base, 'SPX500');
  assert.equal(normalizeBase('SP500').base, 'SPX500');
  assert.equal(normalizeBase('USOIL').base, 'WTI');
  assert.equal(normalizeBase('SPX6900').base, 'SPX');
  assert.equal(normalizeBase('btc').base, 'BTC');
});

test('baseFields sets multiplier only when it is not 1; splitQuote takes the first quote that fits', () => {
  assert.deepEqual(baseFields('BTC'), { base: 'BTC' });
  assert.deepEqual(baseFields('kBONK'), { base: 'BONK', multiplier: 1000 });
  assert.deepEqual(splitQuote('BTCUSDT'), { base: 'BTC', quote: 'USDT' });
  assert.deepEqual(splitQuote('ETHUSD1'), { base: 'ETH', quote: 'USD1' });
  assert.deepEqual(splitQuote('BTCUSDT', ['USDT']), { base: 'BTC', quote: 'USDT' });
  assert.equal(splitQuote('USDT', ['USDT']), null);
  assert.equal(splitQuote('BTCEUR'), null);
});
