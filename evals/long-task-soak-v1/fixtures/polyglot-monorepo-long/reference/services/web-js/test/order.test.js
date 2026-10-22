import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, toWire, ContractError } from '../src/index.js';
import { sample } from './helpers.js';

test('parseOrder reads the basic sample', () => {
  const order = parseOrder(sample('order-basic.json'));
  assert.equal(order.accountId, 'C-100');
  assert.equal(order.accountTier, 'standard');
  assert.deepEqual(order.items[0], { sku: 'TEA-01', qty: 2, unitPrice: 45000 });
});

test('toWire round-trips every sample', () => {
  for (const name of ['order-basic.json', 'order-vip.json', 'order-gold.json']) {
    const data = sample(name);
    assert.deepEqual(toWire(parseOrder(data)), data);
  }
});

test('parseOrder rejects unknown versions and bad items', () => {
  const bad = (patch, code) => assert.throws(() => parseOrder({ ...sample('order-basic.json'), ...patch }), e => e instanceof ContractError && e.code === code);
  bad({ contract_version: 7 }, 'UNSUPPORTED_VERSION');
  bad({ items: [] }, 'INVALID');
  bad({ items: [{ sku: 'A', qty: 1.5, unit_price: 1 }] }, 'INVALID');
  bad({ account_tier: 'platinum' }, 'INVALID');
});
