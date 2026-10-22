// Hidden acceptance (p6): account_id with leading/trailing whitespace is INVALID in every version.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const V2 = { contract_version: 2, order_id: 'O-1', account_id: 'A-1', account_tier: 'gold', currency: 'VND', items: [{ sku: 'S', qty: 1, unit_price: 100 }] };
const V3 = { contract_version: 3, order_id: 'O-3', account_id: 'A-3', account_tier: 'vip', currency: 'USD', settlement_currency: 'VND', fx_rate_ppm: 25000000, items: [{ sku: 'S', qty: 2, unit_price: 999 }] };
const V1 = { contract_version: 1, order_id: 'O-0', customer_id: 'C-0', customer_tier: 'standard', currency: 'USD', items: [{ sku: 'S', qty: 1, unit_price: 5 }] };

async function codeOf(data) {
  const { parseOrder, ContractError } = await import('../src/index.js');
  try { parseOrder(structuredClone(data)); } catch (e) { assert.ok(e instanceof ContractError, String(e)); return e.code; }
  return null;
}

test('padded account ids are INVALID (v1, v2, v3)', async () => {
  for (const bad of [' A-1', 'A-1 ', '  A-1  ', '\tA-1', 'A-1\n']) {
    assert.equal(await codeOf({ ...V2, account_id: bad }), 'INVALID', JSON.stringify(bad));
    assert.equal(await codeOf({ ...V3, account_id: bad }), 'INVALID', JSON.stringify(bad));
    assert.equal(await codeOf({ ...V1, customer_id: bad }), 'INVALID', JSON.stringify(bad));
  }
  for (const good of ['A-1', 'A 1', 'Đ-1']) assert.equal(await codeOf({ ...V2, account_id: good }), null, good);
  assert.equal(await codeOf({ ...V2, account_id: ' A-1', contract_version: 9 }), 'UNSUPPORTED_VERSION');
});
