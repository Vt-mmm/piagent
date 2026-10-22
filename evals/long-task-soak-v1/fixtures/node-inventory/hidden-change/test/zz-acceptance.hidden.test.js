// Hidden acceptance checks for SPEC.md (the soak oracle lays this over the agent's work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Inventory, InventoryError } from '../src/index.js';

const at = day => ({ clock: () => day });
const code = c => err => err instanceof InventoryError && err.code === c;

test('1 receive validates input', () => {
  const inv = new Inventory(at('2026-03-01'));
  assert.throws(() => inv.receive('A', 0, { lot: 'L' }), code('INVALID_INPUT'));
  assert.throws(() => inv.receive('A', 1.5, { lot: 'L' }), code('INVALID_INPUT'));
  assert.throws(() => inv.receive('A', 2, {}), code('INVALID_INPUT'));
  inv.receive('A', 2, { lot: 'L', expiresOn: null });
  assert.equal(inv.available('A'), 2);
});

test('2 available excludes expired lots and reservations', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'OLD', expiresOn: '2026-03-09' });
  inv.receive('A', 4, { lot: 'TODAY', expiresOn: '2026-03-10' });
  inv.receive('A', 3, { lot: 'NONE', expiresOn: null });
  assert.equal(inv.available('A'), 7);
  inv.reserve('o1', 'A', 2);
  assert.equal(inv.available('A'), 5);
  assert.equal(inv.available('ZZZ'), 0);
});

test('3 reserve is all-or-nothing and release frees it', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 3, { lot: 'L1', expiresOn: null });
  inv.reserve('o1', 'A', 2); inv.reserve('o1', 'A', 1);
  assert.throws(() => inv.reserve('o2', 'A', 1), code('INSUFFICIENT_STOCK'));
  assert.equal(inv.available('A'), 0);
  inv.release('o1'); inv.release('nope');
  assert.equal(inv.available('A'), 3);
});

test('4 commit takes FEFO, skips expired, null expiry last, removes empty lots', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 2, { lot: 'B', expiresOn: '2026-04-01' });
  inv.receive('A', 2, { lot: 'A', expiresOn: '2026-04-01' });
  inv.receive('A', 5, { lot: 'N', expiresOn: null });
  inv.receive('A', 9, { lot: 'X', expiresOn: '2026-03-01' });
  inv.receive('A', 1, { lot: 'S', expiresOn: '2026-03-20' });
  inv.reserve('o1', 'A', 6);
  assert.deepEqual(inv.commit('o1'), [{ sku: 'A', lot: 'S', qty: 1 }, { sku: 'A', lot: 'A', qty: 2 }, { sku: 'A', lot: 'B', qty: 2 }, { sku: 'A', lot: 'N', qty: 1 }]);
  assert.equal(inv.available('A'), 4);
  assert.throws(() => inv.commit('o1'), code('UNKNOWN_ORDER'));
  assert.ok(!inv.exportCsv().includes(',S,'));
});

test('5 importCsv handles reordered headers, quotes, blank lines and bad rows', () => {
  const inv = new Inventory(at('2026-03-10'));
  const result = inv.importCsv('lot,sku,expiresOn,qty\n"L,1",A,2026-05-01,3\n\nL2,"B ""x""",,4\nL3,C,2026-05-01,abc\n');
  assert.equal(result.imported, 2);
  assert.deepEqual(result.errors.map(e => e.line), [5]);
  assert.equal(inv.available('A'), 3);
  assert.equal(inv.available('B "x"'), 4);
});

test('6 exportCsv sorts and quotes', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('B', 1, { lot: 'L2', expiresOn: null });
  inv.receive('A', 2, { lot: 'L,9', expiresOn: '2026-05-01' });
  inv.receive('A', 3, { lot: 'L1', expiresOn: '2026-05-02' });
  assert.equal(inv.exportCsv(), 'sku,lot,qty,expiresOn\nA,"L,9",2,2026-05-01\nA,L1,3,2026-05-02\nB,L2,1,\n');
});

test('7 lowStock and expiringWithin', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: '2026-03-12' });
  inv.receive('B', 1, { lot: 'L1', expiresOn: '2026-03-30' });
  inv.receive('C', 1, { lot: 'L1', expiresOn: '2026-03-01' });
  inv.receive('D', 1, { lot: 'L2', expiresOn: '2026-03-11' });
  // Changed by the member mid-task: the threshold itself counts as low (<=).
  assert.deepEqual(inv.lowStock(1), [{ sku: 'C', available: 0 }, { sku: 'B', available: 1 }, { sku: 'D', available: 1 }]);
  assert.deepEqual(inv.lowStock(0), [{ sku: 'C', available: 0 }]);
  assert.deepEqual(inv.expiringWithin(2), [{ sku: 'D', lot: 'L2', qty: 1, expiresOn: '2026-03-11' }, { sku: 'A', lot: 'L1', qty: 5, expiresOn: '2026-03-12' }]);
});

test('8 toJSON / fromJSON round trip keeps reservations', () => {
  const inv = new Inventory(at('2026-03-10'));
  inv.receive('A', 5, { lot: 'L1', expiresOn: null });
  inv.reserve('o1', 'A', 2);
  const copy = Inventory.fromJSON(JSON.parse(JSON.stringify(inv.toJSON())), at('2026-03-10'));
  assert.equal(copy.available('A'), 3);
  assert.deepEqual(copy.commit('o1'), [{ sku: 'A', lot: 'L1', qty: 2 }]);
});

test('9 the project has its own tests for the new behaviour', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['reserve', 'commit', 'importCsv', 'exportCsv', 'lowStock', 'expiringWithin', 'fromJSON']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
