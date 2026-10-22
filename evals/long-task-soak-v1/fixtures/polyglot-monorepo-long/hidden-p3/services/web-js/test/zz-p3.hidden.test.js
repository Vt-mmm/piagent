// Hidden acceptance (p3): contract v3 in web-js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../src/index.js');
const V3 = { contract_version: 3, order_id: 'O-31', account_id: 'A-31', account_tier: 'vip', currency: 'USD', settlement_currency: 'VND', fx_rate_ppm: 25350000, items: [{ sku: 'S1', qty: 3, unit_price: 1999 }] };
const V2 = { contract_version: 2, order_id: 'O-21', account_id: 'A-21', account_tier: 'gold', currency: 'EUR', items: [{ sku: 'S1', qty: 1, unit_price: 10001 }] };

async function codeOf(data) {
  const { parseOrder, ContractError } = await lib();
  try { parseOrder(structuredClone(data)); } catch (e) { assert.ok(e instanceof ContractError, String(e)); return e.code; }
  return null;
}

test('reads v3 and defaults v1/v2 settlement', async () => {
  const { parseOrder, quoteOrder, settlementTotal } = await lib();
  const order = parseOrder(structuredClone(V3));
  assert.equal(order.sourceVersion, 3); assert.equal(order.settlementCurrency, 'VND'); assert.equal(order.fxRatePpm, 25350000);
  assert.equal(quoteOrder(order).total, 5398);
  assert.equal(settlementTotal(order), Math.floor(5398 * 25350000 / 1e6));
  const v2 = parseOrder(structuredClone(V2));
  assert.deepEqual([v2.settlementCurrency, v2.fxRatePpm, v2.sourceVersion], ['EUR', 1000000, 2]);
});

test('toWire writes the lowest version, schema key order', async () => {
  const { parseOrder, toWire } = await lib();
  assert.deepEqual(Object.keys(toWire(parseOrder(structuredClone(V3)))), ['contract_version', 'order_id', 'account_id', 'account_tier', 'currency', 'settlement_currency', 'fx_rate_ppm', 'items']);
  assert.deepEqual(toWire(parseOrder(structuredClone(V3))), V3);
  const { settlement_currency, fx_rate_ppm, ...rest } = V3;
  assert.deepEqual(toWire(parseOrder({ ...V3, settlement_currency: 'USD', fx_rate_ppm: 1000000 })), { ...rest, contract_version: 2 });
  assert.deepEqual(Object.keys(toWire(parseOrder(structuredClone(V2)))), Object.keys(V2));
});

test('v3 error codes', async () => {
  assert.equal(await codeOf({ ...V2, fx_rate_ppm: 1000000 }), 'MIXED_FIELDS');
  assert.equal(await codeOf({ ...V3, customer_id: 'C-1' }), 'MIXED_FIELDS');
  assert.equal(await codeOf({ ...V3, contract_version: '3' }), 'UNSUPPORTED_VERSION');
  for (const bad of [{ fx_rate_ppm: 0 }, { fx_rate_ppm: 1000000001 }, { fx_rate_ppm: '25350000' }, { fx_rate_ppm: 2.5 }, { settlement_currency: 'vnd' }, { settlement_currency: 'USD' }]) {
    assert.equal(await codeOf({ ...V3, ...bad }), 'INVALID', JSON.stringify(bad));
  }
});

test('settlementTotal is exact above 2^53', async () => {
  const { parseOrder, settlementTotal } = await lib();
  const big = { ...V3, account_tier: 'standard', fx_rate_ppm: 796870377, items: [{ sku: 'B', qty: 1, unit_price: 424946923 }] };
  assert.equal(settlementTotal(parseOrder(big)), 338627614735);
});
