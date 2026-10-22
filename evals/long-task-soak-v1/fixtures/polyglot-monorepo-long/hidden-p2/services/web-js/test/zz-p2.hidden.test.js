// Hidden acceptance (p2): shared contract vectors through web-js, and quoteOrder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vectors = JSON.parse(readFileSync(new URL('../../../.soak/p2/vectors.json', import.meta.url), 'utf8'));

test('shared vectors give the same outcome in web-js', async () => {
  const { parseOrder, quoteOrder, ContractError } = await import('../src/index.js');
  assert.equal(typeof quoteOrder, 'function', 'src/index.js does not export quoteOrder');
  for (const c of vectors) {
    let got;
    try {
      const order = parseOrder(structuredClone(c.payload));
      const q = quoteOrder(order);
      got = { ok: { source_version: order.sourceVersion, account_id: order.accountId, account_tier: order.accountTier, currency: order.currency, subtotal: q.subtotal, discount: q.discount, total: q.total } };
    } catch (error) {
      assert.ok(error instanceof ContractError, `${c.name}: ${error}`);
      got = { error: error.code };
    }
    if ('error' in c.expect) assert.deepEqual(got, c.expect, c.name);
    else assert.deepEqual(Object.fromEntries(Object.keys(c.expect.ok).map(k => [k, got.ok?.[k]])), c.expect.ok, c.name);
  }
});

test('quoteOrder matches pricing-py quote()', async () => {
  const { parseOrder, quoteOrder } = await import('../src/index.js');
  const order = parseOrder({ contract_version: 2, order_id: 'O-9', account_id: 'A-9', account_tier: 'gold', currency: 'VND', items: [{ sku: 'S1', qty: 3, unit_price: 1001 }, { sku: 'S2', qty: 1, unit_price: 7 }] });
  const q = quoteOrder(order);
  assert.deepEqual({ orderId: q.orderId, accountId: q.accountId, currency: q.currency, subtotal: q.subtotal, discount: q.discount, total: q.total },
    { orderId: 'O-9', accountId: 'A-9', currency: 'VND', subtotal: 3010, discount: 150, total: 2860 });
});
