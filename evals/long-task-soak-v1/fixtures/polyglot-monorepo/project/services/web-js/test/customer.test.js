import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCustomer, customerLabel } from '../src/index.js';

test('normalizeCustomer maps the API shape', () => {
  assert.deepEqual(normalizeCustomer({ customer_id: 'C-300', name: ' Leaf & Co ', tier: 'gold' }), { customerId: 'C-300', name: 'Leaf & Co', tier: 'gold' });
  assert.deepEqual(normalizeCustomer({ customer_id: 'C-1' }), { customerId: 'C-1', name: '', tier: 'standard' });
});

test('normalizeCustomer rejects bad input', () => {
  assert.throws(() => normalizeCustomer({ name: 'x' }), TypeError);
  assert.throws(() => normalizeCustomer({ customer_id: 'C-1', tier: 'platinum' }), TypeError);
});

test('customerLabel', () => {
  assert.equal(customerLabel({ customerId: 'C-300', name: 'Leaf & Co', tier: 'gold' }), 'Leaf & Co (GOLD)');
  assert.equal(customerLabel({ customerId: 'C-1', name: '', tier: 'standard' }), 'C-1 (STANDARD)');
});
