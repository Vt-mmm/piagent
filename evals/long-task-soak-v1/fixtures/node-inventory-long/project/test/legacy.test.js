import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpt_value_by_category_text, rpt_top_skus_csv } from '../src/legacy/report-engine.js';

const rows = [
  { sku: 'SP1', name: 'Sua tuoi 1L', category: 'Sua', warehouse: 'MAIN', supplier: 'Vinamilk', lot: 'L1', qty: 10, unitCost: 25000, unitPrice: 30000, receivedOn: '2025-03-01', expiresOn: '2025-09-01' },
  { sku: 'SP2', name: 'Mi tom', category: 'Kho', warehouse: 'HN', supplier: 'Acecook', lot: 'L9', qty: 100, unitCost: 3500, unitPrice: 5000, receivedOn: '2025-05-10', expiresOn: null },
];

test('legacy value-by-category report (smoke)', () => {
  const text = rpt_value_by_category_text(rows, {});
  assert.match(text, /^== GIA TRI TON THEO NHOM HANG ==/);
  assert.match(text, /\(2 dong\)\n$/);
});

test('legacy top SKUs CSV uses ; and CRLF', () => {
  assert.equal(rpt_top_skus_csv(rows, { n: 1 }), '#;SKU;Ten hang;So luong;Gia tri\r\n1;SP2;Mi tom;100;350000\r\n');
});
