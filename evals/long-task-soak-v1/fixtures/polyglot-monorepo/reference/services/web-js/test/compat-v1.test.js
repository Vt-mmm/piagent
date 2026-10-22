import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, toWire, upgradeV1, ContractError } from '../src/index.js';
import { sample } from './helpers.js';

test('upgradeV1 renames the legacy fields and leaves the input alone', () => {
  const legacy = sample('order-compat-v1.json');
  const before = structuredClone(legacy);
  const upgraded = upgradeV1(legacy);
  assert.deepEqual(legacy, before);
  assert.equal(upgraded.contract_version, 2);
  assert.equal(upgraded.account_id, before.customer_id);
  assert.equal(upgraded.account_tier, before.customer_tier);
  assert.ok(!('customer_id' in upgraded));
});

test('parseOrder reads v1 payloads as v2', () => {
  const order = parseOrder(sample('order-compat-v1.json'));
  assert.equal(order.sourceVersion, 1);
  assert.deepEqual(toWire(order), sample('order-basic.json'));
  const { contract_version, ...noVersion } = sample('order-compat-v1.json');
  assert.equal(parseOrder(noVersion).sourceVersion, 1);
});

test('parseOrder rejects mixed v1/v2 fields', () => {
  const mixed = data => assert.throws(() => parseOrder(data), e => e instanceof ContractError && e.code === 'MIXED_FIELDS');
  mixed({ ...sample('order-basic.json'), customer_id: 'C-1' });
  mixed({ ...sample('order-compat-v1.json'), account_tier: 'gold' });
});
