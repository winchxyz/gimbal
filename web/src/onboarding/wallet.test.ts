import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, panicOf, refusalCode, refusalText } from './wallet.ts';

const b64 = (value: unknown): string => btoa(JSON.stringify(value));

test('a successful outcome gives its hash and the JSON the call returned', () => {
  const raw = { transaction: { hash: 'H1' }, status: { SuccessValue: b64({ ok: true }) } };
  assert.deepEqual(outcomeOf(raw), { hash: 'H1', value: { ok: true }, failure: null });
});

test('an empty success value is no value; garbage is no value either', () => {
  assert.deepEqual(outcomeOf({ transaction: { hash: 'H' }, status: { SuccessValue: '' } }), { hash: 'H', value: null, failure: null });
  assert.deepEqual(outcomeOf({ transaction: { hash: 'H' }, status: { SuccessValue: btoa('not json') } }), { hash: 'H', value: null, failure: null });
});

test('a failure gives the contract’s panic, starting at its code', () => {
  const raw = {
    transaction: { hash: 'H2' },
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_DESK_EXISTS: a desk with this id exists already' } } } } },
  };
  assert.deepEqual(outcomeOf(raw), { hash: 'H2', value: null, failure: 'E_DESK_EXISTS: a desk with this id exists already' });
});

test('a failure with no code keeps the panic text', () => {
  const raw = { transaction: { hash: 'H' }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account doesn’t have enough balance' } } } } } };
  assert.equal(outcomeOf(raw).failure, 'The account doesn’t have enough balance');
});

test('a refusal that came back as a value is a failure too', () => {
  const raw = { transaction: { hash: 'H' }, status: { SuccessValue: b64('E_DEPOSIT: attach NEAR') } };
  assert.deepEqual(outcomeOf(raw), { hash: 'H', value: null, failure: 'E_DEPOSIT: attach NEAR' });
});

test('something that is not an outcome is read as nothing', () => {
  assert.deepEqual(outcomeOf(null), { hash: null, value: null, failure: null });
  assert.deepEqual(outcomeOf('x'), { hash: null, value: null, failure: null });
  assert.deepEqual(outcomeOf({}), { hash: null, value: null, failure: null });
});

test('panicOf and refusalCode', () => {
  assert.equal(panicOf('Smart contract panicked: E_NOT_ALLOWED: nope'), 'E_NOT_ALLOWED: nope');
  assert.equal(refusalCode('E_ARGS: x'), 'E_ARGS');
  assert.equal(refusalCode('plain'), null);
});

test('a known code is said in words with the contract’s text after it; an unknown one is left as it came', () => {
  assert.equal(refusalText('E_DESK_EXISTS: a desk'), 'A desk with this id exists already (E_DESK_EXISTS: a desk).');
  assert.match(refusalText('E_DEPOSIT: attach NEAR'), /^The attached NEAR did not cover the storage/);
  assert.equal(refusalText('E_SOMETHING_NEW: x'), 'E_SOMETHING_NEW: x');
  assert.equal(refusalText('out of gas'), 'out of gas');
});
