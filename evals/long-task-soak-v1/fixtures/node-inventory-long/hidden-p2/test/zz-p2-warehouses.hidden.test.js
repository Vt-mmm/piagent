// Hidden acceptance checks for phase p2: warehouses, transfers, and the
// member's two answers (expired lots are never transferred: EXPIRED_LOT; no
// negative stock or backorder: commit refuses the whole order and keeps it reserved).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Inventory, InventoryError } from '../src/index.js';

const at = day => ({ clock: () => day });
const code = c => err => err instanceof InventoryError && err.code === c;
const byKey = rows => [...rows].sort((a, b) => `${a.warehouse}|${a.sku}`.localeCompare(`${b.warehouse}|${b.sku}`));

test('p2.1 receive per warehouse, MAIN by default, totals across warehouses', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: null });
  inv.receive('A', 3, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.receive('A', 2, { lot: 'OLD', expiresOn: '2026-03-01', warehouse: 'HN' });
  assert.equal(inv.onHand('A', 'MAIN'), 5);
  assert.equal(inv.onHand('A', 'HN'), 5);
  assert.equal(inv.onHand('A'), 10);
  assert.equal(inv.available('A', 'HN'), 3);
  assert.equal(inv.available('A'), 8);
  assert.equal(inv.available('A', 'DN'), 0);
  assert.throws(() => inv.receive('A', 1, { lot: 'L', expiresOn: null, warehouse: '' }), code('INVALID_INPUT'));
});

test('p2.2 reservations belong to one warehouse', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: null });
  inv.receive('A', 4, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.reserve('o1', 'A', 3, { warehouse: 'HN' });
  assert.equal(inv.available('A', 'HN'), 1);
  assert.equal(inv.available('A', 'MAIN'), 5);
  assert.throws(() => inv.reserve('o1', 'A', 1, { warehouse: 'MAIN' }), code('INVALID_INPUT'));
  assert.throws(() => inv.reserve('o2', 'A', 2, { warehouse: 'HN' }), code('INSUFFICIENT_STOCK'));
  assert.deepEqual(inv.commit('o1'), [{ sku: 'A', lot: 'L1', qty: 3 }]);
  assert.equal(inv.onHand('A', 'HN'), 1);
  assert.equal(inv.onHand('A', 'MAIN'), 5);
});

test('p2.3 transfer reserves at the source and moves lots FEFO on completion', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 2, { lot: 'X', expiresOn: '2026-04-01' });
  inv.receive('A', 2, { lot: 'Y', expiresOn: '2026-03-20' });
  inv.receive('A', 5, { lot: 'N', expiresOn: null });
  inv.transfer('t1', 'A', 5, { from: 'MAIN', to: 'HN' });
  assert.equal(inv.available('A', 'MAIN'), 4);
  assert.equal(inv.onHand('A', 'MAIN'), 9);
  assert.equal(inv.onHand('A', 'HN'), 0);
  assert.throws(() => inv.reserve('o1', 'A', 5), code('INSUFFICIENT_STOCK'));
  assert.deepEqual(inv.completeTransfer('t1'), [
    { sku: 'A', lot: 'Y', qty: 2, expiresOn: '2026-03-20' },
    { sku: 'A', lot: 'X', qty: 2, expiresOn: '2026-04-01' },
    { sku: 'A', lot: 'N', qty: 1, expiresOn: null },
  ]);
  assert.equal(inv.onHand('A', 'MAIN'), 4);
  assert.equal(inv.onHand('A', 'HN'), 5);
  assert.equal(inv.available('A', 'MAIN'), 4);
  assert.equal(inv.exportCsv({ warehouse: 'HN' }), 'sku,lot,qty,expiresOn\nA,N,1,\nA,X,2,2026-04-01\nA,Y,2,2026-03-20\n');
  assert.throws(() => inv.completeTransfer('t1'), code('UNKNOWN_TRANSFER'));
  assert.throws(() => inv.cancelTransfer('nope'), code('UNKNOWN_TRANSFER'));
});

test('p2.4 transfer of a named lot, cancel, and input validation', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 3, { lot: 'P', expiresOn: '2026-05-01' });
  inv.receive('A', 3, { lot: 'Q', expiresOn: '2026-04-01' });
  inv.transfer('t1', 'A', 2, { from: 'MAIN', to: 'DN', lot: 'P' });
  assert.deepEqual(inv.completeTransfer('t1'), [{ sku: 'A', lot: 'P', qty: 2, expiresOn: '2026-05-01' }]);
  inv.transfer('t2', 'A', 4, { from: 'MAIN', to: 'DN' });
  assert.equal(inv.available('A', 'MAIN'), 0);
  inv.cancelTransfer('t2');
  assert.equal(inv.available('A', 'MAIN'), 4);
  assert.throws(() => inv.transfer('t3', 'A', 1, { from: 'MAIN', to: 'MAIN' }), code('INVALID_INPUT'));
  assert.throws(() => inv.transfer('t3', 'A', 0, { from: 'MAIN', to: 'DN' }), code('INVALID_INPUT'));
  inv.transfer('t3', 'A', 1, { from: 'MAIN', to: 'DN' });
  assert.throws(() => inv.transfer('t3', 'A', 1, { from: 'MAIN', to: 'DN' }), code('INVALID_INPUT'));
  assert.throws(() => inv.transfer('t4', 'A', 9, { from: 'MAIN', to: 'DN' }), code('INSUFFICIENT_STOCK'));
});

test('p2.5 member answer: expired lots are never transferred (EXPIRED_LOT)', () => {
  let day = '2026-03-10';
  const inv = new Inventory({ clock: () => day });
  inv.receive('A', 4, { lot: 'OLD', expiresOn: '2026-03-01' });
  inv.receive('A', 3, { lot: 'NEW', expiresOn: '2026-04-01' });
  assert.throws(() => inv.transfer('t1', 'A', 1, { from: 'MAIN', to: 'HUY', lot: 'OLD' }), code('EXPIRED_LOT'));
  assert.throws(() => inv.transfer('t2', 'A', 5, { from: 'MAIN', to: 'HUY' }), code('EXPIRED_LOT'));
  assert.throws(() => inv.transfer('t3', 'A', 8, { from: 'MAIN', to: 'HUY' }), code('INSUFFICIENT_STOCK'));
  assert.equal(inv.available('A', 'MAIN'), 3);
  assert.equal(inv.onHand('A', 'HUY'), 0);
  inv.transfer('t4', 'A', 2, { from: 'MAIN', to: 'HN' });
  day = '2026-04-02';
  assert.throws(() => inv.completeTransfer('t4'), code('EXPIRED_LOT'));
  assert.equal(inv.onHand('A', 'MAIN'), 7);
  assert.equal(inv.onHand('A', 'HN'), 0);
  inv.cancelTransfer('t4');
});

test('p2.6 member answer: no negative stock or backorder, the order stays reserved', () => {
  let day = '2026-03-10';
  const inv = new Inventory({ clock: () => day });
  inv.receive('A', 2, { lot: 'S', expiresOn: '2026-03-12' });
  inv.receive('B', 5, { lot: 'L', expiresOn: null });
  inv.reserve('o1', 'A', 2);
  inv.reserve('o1', 'B', 1);
  day = '2026-03-13';
  assert.throws(() => inv.commit('o1'), code('INSUFFICIENT_STOCK'));
  assert.equal(inv.onHand('A'), 2);
  assert.equal(inv.onHand('B'), 5);
  assert.equal(inv.available('B'), 4, 'the order keeps its reservation');
  inv.receive('A', 2, { lot: 'T', expiresOn: '2026-04-01' });
  assert.deepEqual(inv.commit('o1'), [{ sku: 'A', lot: 'T', qty: 2 }, { sku: 'B', lot: 'L', qty: 1 }]);
  assert.equal(inv.onHand('A'), 2);
  assert.equal(inv.available('B'), 4);
});

test('p2.7 stockReport rows per warehouse and SKU', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: null });
  inv.receive('A', 4, { lot: 'X', expiresOn: '2026-03-01' });
  inv.receive('B', 2, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.receive('A', 3, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.reserve('o1', 'A', 1);
  inv.transfer('t1', 'A', 2, { from: 'MAIN', to: 'HN' });
  assert.deepEqual(byKey(inv.stockReport()), [
    { warehouse: 'HN', sku: 'A', onHand: 3, reserved: 0, available: 3 },
    { warehouse: 'HN', sku: 'B', onHand: 2, reserved: 0, available: 2 },
    { warehouse: 'MAIN', sku: 'A', onHand: 9, reserved: 3, available: 2 },
  ]);
  assert.deepEqual(byKey(inv.stockReport({ warehouse: 'HN' })).map(r => r.sku), ['A', 'B']);
});

test('p2.8 CSV with warehouses, aggregated reports per warehouse', () => {
  const inv = new Inventory(at('2026-03-10'));
  const result = inv.importCsv('sku,qty,lot,expiresOn,warehouse\nA,3,L,2026-03-15,MAIN\nA,2,L,2026-03-15,HN\nB,1,M,,\nC,x,M,,HN\n', { warehouse: 'DN' });
  assert.equal(result.imported, 3);
  assert.deepEqual(result.errors.map(e => e.line), [5]);
  assert.equal(inv.onHand('B', 'DN'), 1);
  assert.equal(inv.exportCsv({ all: true }), 'warehouse,sku,lot,qty,expiresOn\nDN,B,M,1,\nHN,A,L,2,2026-03-15\nMAIN,A,L,3,2026-03-15\n');
  assert.equal(inv.exportCsv(), 'sku,lot,qty,expiresOn\nA,L,3,2026-03-15\n');
  assert.deepEqual(inv.expiringWithin(10), [{ sku: 'A', lot: 'L', qty: 5, expiresOn: '2026-03-15' }]);
  assert.deepEqual(inv.expiringWithin(10, { warehouse: 'HN' }), [{ sku: 'A', lot: 'L', qty: 2, expiresOn: '2026-03-15' }]);
  assert.deepEqual(inv.lowStock(3), [{ sku: 'B', available: 1 }]);
  assert.deepEqual(inv.lowStock(3, { warehouse: 'HN' }), [{ sku: 'A', available: 2 }]);
});

test('p2.9 toJSON / fromJSON keeps warehouses, reservations and pending transfers', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.reserve('o1', 'A', 1, { warehouse: 'HN' });
  inv.transfer('t1', 'A', 2, { from: 'HN', to: 'MAIN' });
  const copy = Inventory.fromJSON(JSON.parse(JSON.stringify(inv.toJSON())), at('2026-03-10'));
  assert.equal(copy.available('A', 'HN'), 2);
  assert.deepEqual(copy.completeTransfer('t1'), [{ sku: 'A', lot: 'L1', qty: 2, expiresOn: null }]);
  assert.deepEqual(copy.commit('o1'), [{ sku: 'A', lot: 'L1', qty: 1 }]);
  assert.equal(copy.onHand('A', 'MAIN'), 2);
});

test('p2.10 the project has its own tests for warehouses and transfers', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['transfer', 'completeTransfer', 'EXPIRED_LOT', 'stockReport', 'warehouse']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
