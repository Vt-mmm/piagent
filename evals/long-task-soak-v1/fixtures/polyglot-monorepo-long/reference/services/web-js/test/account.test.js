import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccount, accountLabel } from '../src/index.js';

test('normalizeAccount maps the API shape', () => {
  assert.deepEqual(normalizeAccount({ account_id: 'C-300', name: ' Leaf & Co ', tier: 'gold' }), { accountId: 'C-300', name: 'Leaf & Co', tier: 'gold' });
  assert.deepEqual(normalizeAccount({ account_id: 'C-1' }), { accountId: 'C-1', name: '', tier: 'standard' });
});

test('normalizeAccount rejects bad input', () => {
  assert.throws(() => normalizeAccount({ name: 'x' }), TypeError);
  assert.throws(() => normalizeAccount({ account_id: 'C-1', tier: 'platinum' }), TypeError);
});

test('accountLabel', () => {
  assert.equal(accountLabel({ accountId: 'C-300', name: 'Leaf & Co', tier: 'gold' }), 'Leaf & Co (GOLD)');
  assert.equal(accountLabel({ accountId: 'C-1', name: '', tier: 'standard' }), 'C-1 (STANDARD)');
});
