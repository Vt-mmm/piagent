#!/usr/bin/env node
// Generates project/data/stock-2025.csv (20,000 data lines, 40 malformed, a few
// blank lines, UTF-8 BOM, CRLF, as exported from the old system through Excel)
// and the import expectations hidden-p5/test/zz-import-expected.hidden.json.
// Deterministic: run `node generators/gen-csv.mjs` from the fixture directory.
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.resolve(import.meta.dirname, '..');
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const r = rng(77112025), int = (a, b) => a + Math.floor(r() * (b - a + 1)), pick = a => a[Math.floor(r() * a.length)];

const WAREHOUSES = ['MAIN', 'HN', 'DN', 'HCM', 'CT'];
const PRODUCTS = [
  ['Sữa tươi tiệt trùng, 1L', 'Sữa'], ['Sữa chua uống 180ml', 'Sữa'], ['Bánh quy bơ "Danisa" 454g', 'Bánh kẹo'],
  ['Kẹo dẻo trái cây', 'Bánh kẹo'], ['Nước mắm 500ml', 'Gia vị'], ['Hạt nêm, gói 400g', 'Gia vị'], ['Mì tôm chua cay', 'Thực phẩm khô'],
  ['Gạo ST25 5kg', 'Thực phẩm khô'], ['Trà xanh không độ 450ml', 'Đồ uống'], ['Nước suối 500ml', 'Đồ uống'], ['Cá viên đông lạnh', 'Đông lạnh'],
  ['Xúc xích tiệt trùng', 'Đông lạnh'], ['Nước rửa chén hương chanh', 'Hoá phẩm'], ['Bột giặt 3kg', 'Hoá phẩm'], ['Dầu ăn 1L', 'Gia vị'],
];
const SUPPLIERS = ['Vinamilk', 'Kinh Đô', 'Masan', 'Acecook', 'Công ty Hạ Long', 'Unilever VN', 'Lộc Trời', 'Tân Hiệp Phát'];
const SKUS = Array.from({ length: 600 }, (_, i) => ({ sku: 'SP' + String(10001 + i), product: PRODUCTS[i % PRODUCTS.length], cost: 1000 * int(3, 250) }));
const HEADER = ['warehouse', 'sku', 'name', 'category', 'supplier', 'lot', 'qty', 'unitCost', 'unitPrice', 'receivedOn', 'expiresOn'];
const quote = v => /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
const day = n => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);

const BAD = ['qty_alpha', 'qty_zero', 'qty_neg', 'qty_decimal', 'lot_empty', 'date_format', 'date_impossible', 'cols_few', 'cols_many', 'sku_empty'];
const IMPOSSIBLE = ['2025-02-30', '2025-04-31', '2025-06-31', '2025-11-31'];
const DATA_LINES = 20000, BLANK_AT = new Set(Array.from({ length: 12 }, (_, i) => 1500 + i * 1601));
const badAt = new Map(Array.from({ length: 40 }, (_, i) => [int(i * 495 + 10, i * 495 + 480), BAD[i % BAD.length]]));
if (badAt.size !== 40) throw Error('bad rows collide');

const lotExpiry = new Map();
const lines = [HEADER.join(',')], expected = { imported: 0, errorLines: [], byWarehouse: {}, pairs: {} };
let physical = 1, data = 0, badSeen = 0;
while (data < DATA_LINES) {
  physical++;
  if (BLANK_AT.has(physical)) { lines.push(''); continue; }
  data++;
  const s = SKUS[int(0, SKUS.length - 1)], wh = pick(WAREHOUSES), recvN = int(0, 364);
  const lot = `L${day(recvN).slice(2).replaceAll('-', '')}-${int(1, 3)}`, key = `${wh}|${s.sku}|${lot}`;
  if (!lotExpiry.has(key)) lotExpiry.set(key, r() < 0.12 ? '' : (r() < 0.01 ? '2024-02-29' : day(recvN + int(-30, 540))));
  const row = { warehouse: wh, sku: s.sku, name: s.product[0], category: s.product[1], supplier: pick(SUPPLIERS), lot, qty: String(int(1, 240)),
    unitCost: String(s.cost), unitPrice: String(Math.round(s.cost * (1.1 + r() * 0.4))), receivedOn: day(recvN), expiresOn: lotExpiry.get(key) };
  const bad = badAt.get(data);
  let cells = HEADER.map(h => quote(row[h]));
  if (bad) {
    badSeen++;
    const set = (h, v) => { cells[HEADER.indexOf(h)] = v; };
    if (bad === 'qty_alpha') set('qty', 'mười');
    if (bad === 'qty_zero') set('qty', '0');
    if (bad === 'qty_neg') set('qty', '-5');
    if (bad === 'qty_decimal') set('qty', '2.5');
    if (bad === 'lot_empty') set('lot', '');
    if (bad === 'date_format') set('expiresOn', '31/12/2025');
    if (bad === 'date_impossible') set('expiresOn', IMPOSSIBLE[badSeen % IMPOSSIBLE.length]);
    if (bad === 'cols_few') cells = cells.slice(0, -1);
    if (bad === 'cols_many') set('name', 'Bánh quy, hộp 200g');
    if (bad === 'sku_empty') set('sku', '');
    expected.errorLines.push(physical);
  } else {
    expected.imported++;
    expected.byWarehouse[wh] = (expected.byWarehouse[wh] ?? 0) + Number(row.qty);
    expected.pairs[`${wh}|${s.sku}`] = (expected.pairs[`${wh}|${s.sku}`] ?? 0) + Number(row.qty);
  }
  lines.push(cells.join(','));
}
// A handful of pairs to check exactly (deterministic picks).
const keys = Object.keys(expected.pairs).sort();
expected.samples = [0, 97, 512, 1203, 1999, keys.length - 1].map(i => { const [warehouse, sku] = keys[i].split('|'); return { warehouse, sku, onHand: expected.pairs[keys[i]] }; });
expected.skuCount = new Set(keys.map(k => k.split('|')[1])).size;
expected.dataLines = DATA_LINES; expected.physicalLines = physical;
delete expected.pairs;
const csv = '﻿' + lines.join('\r\n') + '\r\n';
fs.mkdirSync(path.join(FIX, 'project/data'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'project/data/stock-2025.csv'), csv);
fs.mkdirSync(path.join(FIX, 'hidden-p5/test'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'hidden-p5/test/zz-import-expected.hidden.json'), JSON.stringify(expected, null, 2) + '\n');
console.log(`csv: ${physical} lines (${DATA_LINES} data, ${expected.errorLines.length} malformed, ${BLANK_AT.size} blank), ${(csv.length / 1e6).toFixed(2)} MB chars, imported ${expected.imported}`);
