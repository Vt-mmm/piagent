import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/index.js';

const inv = () => new Inventory({ clock: () => '2026-03-10' });
test('reserve and commit', () => { const i = inv(); i.receive('A', 3, { lot: 'L', expiresOn: null }); i.reserve('o', 'A', 2); assert.deepEqual(i.commit('o'), [{ sku: 'A', lot: 'L', qty: 2 }]); });
test('importCsv and exportCsv', () => { const i = inv(); i.importCsv('sku,qty,lot,expiresOn\nA,1,L,\n'); assert.equal(i.exportCsv(), 'sku,lot,qty,expiresOn\nA,L,1,\n'); });
test('lowStock and expiringWithin', () => { const i = inv(); i.receive('A', 1, { lot: 'L', expiresOn: '2026-03-11' }); assert.equal(i.lowStock(5).length, 1); assert.equal(i.expiringWithin(1).length, 1); });
test('fromJSON', () => { const i = inv(); i.receive('A', 1, { lot: 'L', expiresOn: null }); assert.equal(Inventory.fromJSON(i.toJSON()).available('A'), 1); });
