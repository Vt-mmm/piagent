import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/index.js';

const inv = () => new Inventory({ clock: () => '2026-03-10' });
test('transfer and completeTransfer move lots between warehouses', () => {
  const i = inv(); i.receive('A', 3, { lot: 'L', expiresOn: null });
  i.transfer('t', 'A', 2, { from: 'MAIN', to: 'HN' });
  assert.deepEqual(i.completeTransfer('t'), [{ sku: 'A', lot: 'L', qty: 2, expiresOn: null }]);
  assert.equal(i.onHand('A', 'HN'), 2);
});
test('expired lots are refused with EXPIRED_LOT', () => {
  const i = inv(); i.receive('A', 3, { lot: 'L', expiresOn: '2026-03-01' });
  assert.throws(() => i.transfer('t', 'A', 1, { from: 'MAIN', to: 'HN', lot: 'L' }), { code: 'EXPIRED_LOT' });
});
test('stockReport has one row per warehouse and SKU', () => {
  const i = inv(); i.receive('A', 3, { lot: 'L', expiresOn: null, warehouse: 'HN' });
  assert.deepEqual(i.stockReport(), [{ warehouse: 'HN', sku: 'A', onHand: 3, reserved: 0, available: 3 }]);
});
