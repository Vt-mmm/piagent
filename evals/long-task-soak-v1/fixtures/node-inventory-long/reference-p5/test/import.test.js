import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/index.js';
import { importFile } from '../src/import.js';
import * as engine from '../src/legacy/report-engine.js';

test('importFile reads data/stock-2025.csv with line numbers for bad rows', async () => {
  const inv = new Inventory({ clock: () => '2026-01-15' });
  const result = await importFile(inv, new URL('../data/stock-2025.csv', import.meta.url));
  assert.equal(result.errors.length, 40);
  assert.ok(result.errors.every(e => e.line > 1 && e.message));
});
test('legacy report-engine exports keep working', () => {
  assert.match(engine.rpt_value_by_category_text([{ sku: 'A', category: 'X', qty: 1, unitCost: 1000 }], {}), /GIA TRI TON/);
});
