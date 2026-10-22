#!/usr/bin/env node
// Generates, from one set of templates (so both behave identically):
//  - project/src/legacy/report-engine.js   the ~3,500-line legacy module the member hands over
//  - reference-p5/src/reports/*.js + reference-p5/src/legacy/report-engine.js   a split version
//  - hidden-p5/test/zz-legacy-golden.hidden.json   golden outputs of every export
// Deterministic: run `node generators/gen-legacy.mjs` from the fixture directory.
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.resolve(import.meta.dirname, '..');
const out = (rel, text) => { const f = path.join(FIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

// ---------------------------------------------------------------- helpers
// Each helper exists in the legacy file under several names (copy-paste over
// the years); all variants behave the same.
const HELPERS = {
  money: [
    ['fmtMoney', `function fmtMoney(n) {
  var s = String(Math.round(n));
  var neg = s.charAt(0) === '-';
  if (neg) s = s.substring(1);
  var out = '';
  while (s.length > 3) {
    out = '.' + s.substring(s.length - 3) + out;
    s = s.substring(0, s.length - 3);
  }
  return (neg ? '-' : '') + s + out;
}`],
    ['formatMoney2', `function formatMoney2(n) {
  // ban sao cua fmtMoney (2020) - dung cho bao cao kho moi
  var s = String(Math.round(n));
  var neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.substring(1); }
  var parts = [];
  while (s.length > 3) {
    parts.unshift(s.substring(s.length - 3));
    s = s.substring(0, s.length - 3);
  }
  parts.unshift(s);
  return (neg ? '-' : '') + parts.join('.');
}`],
    ['money_fmt', `function money_fmt(n) {
  var s = String(Math.round(n)), neg = s.charAt(0) === '-', out = '';
  if (neg) s = s.substring(1);
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s.charAt(i);
  }
  return (neg ? '-' : '') + out;
}`],
  ],
  padR: [
    ['padR', `function padR(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s += ' ';
  return s;
}`],
    ['padRight', `function padRight(str, len) {
  str = '' + str;
  if (str.length > len) return str.substring(0, len - 1) + '~';
  return str + new Array(len - str.length + 1).join(' ');
}`],
  ],
  padL: [
    ['padL', `function padL(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s = ' ' + s;
  return s;
}`],
    ['padLeft', `function padLeft(str, len) {
  str = '' + str;
  if (str.length > len) return str.substring(0, len - 1) + '~';
  return new Array(len - str.length + 1).join(' ') + str;
}`],
  ],
  esc: [
    ['escHtml', `function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}`],
    ['html_escape', `function html_escape(s) {
  s = String(s);
  var r = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '&') r += '&amp;';
    else if (c === '<') r += '&lt;';
    else if (c === '>') r += '&gt;';
    else if (c === '"') r += '&quot;';
    else r += c;
  }
  return r;
}`],
  ],
  days: [
    ['daysBetween', `function daysBetween(a, b) {
  return Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}`],
    ['diffDays', `function diffDays(from, to) {
  var t1 = Date.parse(from + 'T00:00:00Z');
  var t2 = Date.parse(to + 'T00:00:00Z');
  return Math.floor((t2 - t1) / (24 * 60 * 60 * 1000));
}`],
  ],
};
const COMMON = [
  `function addDays(d, n) {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().substring(0, 10);
}`,
  `function fmtPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1) + '%';
}`,
  `function csvPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1).replace('.', ',');
}`,
  `function csvCell(v) {
  v = v == null ? '' : String(v);
  if (v.indexOf(';') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\\n') >= 0) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}`,
  `function mdCell(s) {
  return String(s).replace(/\\|/g, '\\\\|');
}`,
  `function rep(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}`,
  `function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}`,
];

// ---------------------------------------------------------------- reports
// Each compute body reads rows/opts and leaves title, cols, out, footer, asOf.
// cols: [key, label, width, 'L'|'R', kind] — kind s=text i=integer m=money p=percent d=date.
const REPORTS = [
  { base: 'value_by_category', ref: 'valueByCategory', group: 'stock', note: 'Gia tri ton kho theo nhom hang (theo gia von).', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Gia tri ton theo nhom hang';
var map = {};
var keys = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var k = r.category || '(khac)';
  if (!map[k]) {
    map[k] = { category: k, skus: {}, nSku: 0, qty: 0, value: 0 };
    keys.push(k);
  }
  var g = map[k];
  if (!g.skus[r.sku]) {
    g.skus[r.sku] = 1;
    g.nSku++;
  }
  g.qty += r.qty;
  g.value += r.qty * r.unitCost;
}
var out = [];
var tq = 0, tv = 0;
for (var j = 0; j < keys.length; j++) {
  var g2 = map[keys[j]];
  out.push({ category: g2.category, nSku: g2.nSku, qty: g2.qty, value: g2.value });
  tq += g2.qty;
  tv += g2.value;
}
out.sort(function (a, b) {
  if (b.value !== a.value) return b.value - a.value;
  return cmpStr(a.category, b.category);
});
var cols = [['category', 'Nhom', 16, 'L', 's'], ['nSku', 'So SKU', 7, 'R', 'i'], ['qty', 'So luong', 10, 'R', 'i'], ['value', 'Gia tri', 14, 'R', 'm']];
var footer = 'Tong: ' + $money(tq) + ' sp, ' + $money(tv) + ' ' + CURRENCY;` },

  { base: 'value_by_warehouse', ref: 'valueByWarehouse', group: 'stock', note: 'Gia tri ton theo kho, kem ty trong.', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Gia tri ton theo kho';
var byWh = {};
var whs = [];
var tv = 0;
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var w = r.warehouse || 'MAIN';
  if (byWh[w] === undefined) {
    byWh[w] = { warehouse: w, lots: 0, qty: 0, value: 0 };
    whs.push(w);
  }
  byWh[w].lots += 1;
  byWh[w].qty += r.qty;
  byWh[w].value += r.qty * r.unitCost;
  tv += r.qty * r.unitCost;
}
var out = [];
for (var j = 0; j < whs.length; j++) {
  var x = byWh[whs[j]];
  out.push({ warehouse: x.warehouse, lots: x.lots, qty: x.qty, value: x.value, share: tv ? x.value / tv : 0 });
}
out.sort(function (a, b) {
  return cmpStr(a.warehouse, b.warehouse);
});
var cols = [['warehouse', 'Kho', 8, 'L', 's'], ['lots', 'So lo', 6, 'R', 'i'], ['qty', 'So luong', 10, 'R', 'i'], ['value', 'Gia tri', 14, 'R', 'm'], ['share', 'Ty trong', 8, 'R', 'p']];
var footer = 'Tong gia tri: ' + $money(tv) + ' ' + CURRENCY;` },

  { base: 'aging', ref: 'aging', group: 'time', note: 'Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180).', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Tuoi ton kho den ngay ' + asOf;
var labels = ['0-30', '31-60', '61-90', '91-180', '>180'];
var buckets = [];
for (var b = 0; b < labels.length; b++) buckets.push({ bucket: labels[b], lots: 0, qty: 0, value: 0 });
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var age = $days(r.receivedOn, asOf);
  var idx;
  if (age <= 30) idx = 0;
  else if (age <= 60) idx = 1;
  else if (age <= 90) idx = 2;
  else if (age <= 180) idx = 3;
  else idx = 4;
  buckets[idx].lots++;
  buckets[idx].qty += r.qty;
  buckets[idx].value += r.qty * r.unitCost;
}
var out = buckets;
var old = buckets[3].value + buckets[4].value;
var cols = [['bucket', 'Tuoi (ngay)', 12, 'L', 's'], ['lots', 'So lo', 6, 'R', 'i'], ['qty', 'So luong', 10, 'R', 'i'], ['value', 'Gia tri', 14, 'R', 'm']];
var footer = 'Hang ton tren 90 ngay: ' + $money(old) + ' ' + CURRENCY;` },

  { base: 'expiry_calendar', ref: 'expiryCalendar', group: 'time', note: 'Lich het han trong N ngay toi (mac dinh 30).', body: `
var asOf = opts.asOf || '2025-12-31';
var days = opts.days == null ? 30 : opts.days;
var until = addDays(asOf, days);
var title = 'Lich het han ' + asOf + ' -> ' + until;
var out = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (!r.expiresOn) continue;
  if (r.expiresOn < asOf || r.expiresOn > until) continue;
  out.push({ expiresOn: r.expiresOn, sku: r.sku, lot: r.lot, warehouse: r.warehouse, qty: r.qty, daysLeft: $days(asOf, r.expiresOn) });
}
out.sort(function (a, b) {
  return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
});
var cols = [['expiresOn', 'Het han', 10, 'L', 'd'], ['sku', 'SKU', 10, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['daysLeft', 'Con', 4, 'R', 'i']];
var footer = 'Tong so lo: ' + out.length;` },

  { base: 'expired', ref: 'expired', group: 'time', note: 'Danh sach lo da het han (expiresOn < asOf) va gia tri.', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Hang da het han tinh den ' + asOf;
var out = [];
var total = 0;
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (r.expiresOn && r.expiresOn < asOf) {
    var v = r.qty * r.unitCost;
    out.push({ sku: r.sku, name: r.name, lot: r.lot, warehouse: r.warehouse, qty: r.qty, expiresOn: r.expiresOn, value: v });
    total += v;
  }
}
out.sort(function (a, b) {
  return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot);
});
var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['expiresOn', 'Het han', 10, 'L', 'd'], ['value', 'Gia tri', 12, 'R', 'm']];
var footer = 'Tong gia tri het han: ' + $money(total) + ' ' + CURRENCY;` },

  { base: 'supplier_summary', ref: 'supplierSummary', group: 'stock', note: 'Tong hop theo nha cung cap.', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Tong hop nha cung cap';
var sup = {};
var names = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var s = r.supplier || '(chua ro)';
  if (!sup[s]) {
    sup[s] = { supplier: s, skuSet: {}, nSku: 0, nLot: 0, qty: 0, value: 0 };
    names.push(s);
  }
  var e = sup[s];
  if (!e.skuSet[r.sku]) {
    e.skuSet[r.sku] = true;
    e.nSku += 1;
  }
  e.nLot += 1;
  e.qty += r.qty;
  e.value += r.qty * r.unitCost;
}
names.sort(cmpStr);
var out = [];
for (var j = 0; j < names.length; j++) {
  var e2 = sup[names[j]];
  out.push({ supplier: e2.supplier, nSku: e2.nSku, nLot: e2.nLot, qty: e2.qty, value: e2.value });
}
var cols = [['supplier', 'Nha cung cap', 20, 'L', 's'], ['nSku', 'SKU', 5, 'R', 'i'], ['nLot', 'Lo', 5, 'R', 'i'], ['qty', 'So luong', 10, 'R', 'i'], ['value', 'Gia tri', 14, 'R', 'm']];
var footer = 'So nha cung cap: ' + out.length;` },

  { base: 'top_skus', ref: 'topSkus', group: 'stock', note: 'Top SKU theo gia tri ton (mac dinh 10).', body: `
var asOf = opts.asOf || '2025-12-31';
var n = opts.n == null ? $TOP_N : opts.n;
var title = 'Top ' + n + ' SKU theo gia tri';
var agg = {};
var list = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (!agg[r.sku]) {
    agg[r.sku] = { sku: r.sku, name: r.name, qty: 0, value: 0 };
    list.push(agg[r.sku]);
  }
  agg[r.sku].qty += r.qty;
  agg[r.sku].value += r.qty * r.unitCost;
}
list.sort(function (a, b) {
  if (a.value !== b.value) return b.value - a.value;
  return cmpStr(a.sku, b.sku);
});
var out = [];
for (var j = 0; j < list.length && j < n; j++) {
  out.push({ rank: j + 1, sku: list[j].sku, name: list[j].name, qty: list[j].qty, value: list[j].value });
}
var cols = [['rank', '#', 3, 'R', 'i'], ['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['qty', 'So luong', 9, 'R', 'i'], ['value', 'Gia tri', 14, 'R', 'm']];
var footer = 'Tong so SKU: ' + list.length;` },

  { base: 'margin_by_category', ref: 'marginByCategory', group: 'stock', note: 'Bien loi nhuan du kien theo nhom (gia ban - gia von).', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Bien loi nhuan theo nhom';
var cat = {};
var keys = [];
var tc = 0, tr = 0;
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var k = r.category || '(khac)';
  if (!cat[k]) {
    cat[k] = { category: k, cost: 0, revenue: 0 };
    keys.push(k);
  }
  cat[k].cost += r.qty * r.unitCost;
  cat[k].revenue += r.qty * r.unitPrice;
  tc += r.qty * r.unitCost;
  tr += r.qty * r.unitPrice;
}
var out = [];
for (var j = 0; j < keys.length; j++) {
  var c = cat[keys[j]];
  var m = c.revenue - c.cost;
  out.push({ category: c.category, cost: c.cost, revenue: c.revenue, margin: m, marginPct: c.revenue ? m / c.revenue : 0 });
}
out.sort(function (a, b) {
  if (a.marginPct !== b.marginPct) return b.marginPct - a.marginPct;
  return cmpStr(a.category, b.category);
});
var cols = [['category', 'Nhom', 16, 'L', 's'], ['cost', 'Gia von', 14, 'R', 'm'], ['revenue', 'Doanh thu', 14, 'R', 'm'], ['margin', 'Loi nhuan', 14, 'R', 'm'], ['marginPct', 'Bien', 7, 'R', 'p']];
var footer = 'Bien chung: ' + fmtPct(tr ? (tr - tc) / tr : 0);` },

  { base: 'dead_stock', ref: 'deadStock', group: 'time', note: 'SKU khong nhap them trong N ngay (mac dinh 90).', body: `
var asOf = opts.asOf || '2025-12-31';
var days = opts.days == null ? 90 : opts.days;
var title = 'Hang cham luan chuyen (>= ' + days + ' ngay)';
var last = {};
var order = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (!last[r.sku]) {
    last[r.sku] = { sku: r.sku, name: r.name, lastReceived: r.receivedOn, qty: 0, value: 0 };
    order.push(r.sku);
  }
  var l = last[r.sku];
  if (r.receivedOn > l.lastReceived) l.lastReceived = r.receivedOn;
  l.qty += r.qty;
  l.value += r.qty * r.unitCost;
}
var out = [];
for (var j = 0; j < order.length; j++) {
  var x = last[order[j]];
  var age = $days(x.lastReceived, asOf);
  if ($DEAD_COND) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
}
out.sort(function (a, b) {
  if (a.age !== b.age) return b.age - a.age;
  return cmpStr(a.sku, b.sku);
});
var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
var footer = 'So SKU cham: ' + out.length;` },

  { base: 'reorder', ref: 'reorder', group: 'time', note: 'Goi y dat hang lai khi ton < minQty, lam tron theo packSize.', body: `
var asOf = opts.asOf || '2025-12-31';
var minQty = opts.minQty == null ? 50 : opts.minQty;
var pack = opts.packSize == null ? 12 : opts.packSize;
var title = 'Goi y dat hang (min ' + minQty + ', thung ' + pack + ')';
var tot = {};
var skus = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (tot[r.sku] === undefined) {
    tot[r.sku] = { name: r.name, qty: 0 };
    skus.push(r.sku);
  }
  tot[r.sku].qty += r.qty;
}
skus.sort(cmpStr);
var out = [];
for (var j = 0; j < skus.length; j++) {
  var t = tot[skus[j]];
  if (t.qty < minQty) {
    var need = Math.ceil((minQty * 2 - t.qty) / pack) * pack;
    out.push({ sku: skus[j], name: t.name, qty: t.qty, minQty: minQty, suggest: need });
  }
}
var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['qty', 'Ton', 7, 'R', 'i'], ['minQty', 'Min', 5, 'R', 'i'], ['suggest', 'Dat', 6, 'R', 'i']];
var footer = 'Can dat ' + out.length + ' SKU';` },

  { base: 'abc_class', ref: 'abcClass', group: 'stock', note: 'Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%).', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Phan loai ABC';
var val = {};
var arr = [];
var total = 0;
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (val[r.sku] === undefined) {
    val[r.sku] = { sku: r.sku, value: 0 };
    arr.push(val[r.sku]);
  }
  val[r.sku].value += r.qty * r.unitCost;
  total += r.qty * r.unitCost;
}
arr.sort(function (a, b) {
  return b.value - a.value || cmpStr(a.sku, b.sku);
});
var out = [];
var cum = 0;
var counts = { A: 0, B: 0, C: 0 };
for (var j = 0; j < arr.length; j++) {
  var before = total ? cum / total : 0;
  var cls = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
  cum += arr[j].value;
  counts[cls]++;
  out.push({ rank: j + 1, sku: arr[j].sku, value: arr[j].value, cumPct: total ? cum / total : 0, cls: cls });
}
var cols = [['rank', '#', 4, 'R', 'i'], ['sku', 'SKU', 10, 'L', 's'], ['value', 'Gia tri', 14, 'R', 'm'], ['cumPct', 'Luy ke', 7, 'R', 'p'], ['cls', 'Lop', 3, 'L', 's']];
var footer = 'A: ' + counts.A + ', B: ' + counts.B + ', C: ' + counts.C;` },

  { base: 'lot_trace', ref: 'lotTrace', group: 'time', note: 'Truy vet cac lo cua mot SKU (opts.sku).', body: `
var asOf = opts.asOf || '2025-12-31';
var sku = opts.sku || (rows.length ? rows[0].sku : '');
var title = 'Truy vet lo SKU ' + sku;
var out = [];
var q = 0;
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  if (r.sku !== sku) continue;
  out.push({ receivedOn: r.receivedOn, lot: r.lot, warehouse: r.warehouse, supplier: r.supplier, qty: r.qty, expiresOn: r.expiresOn || null });
  q += r.qty;
}
out.sort(function (a, b) {
  return cmpStr(a.receivedOn, b.receivedOn) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
});
var cols = [['receivedOn', 'Ngay nhap', 10, 'L', 'd'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['supplier', 'NCC', 16, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['expiresOn', 'Het han', 10, 'L', 'd']];
var footer = 'SKU ' + sku + ': ' + out.length + ' lo, ' + $money(q) + ' sp';` },

  { base: 'warehouse_balance', ref: 'warehouseBalance', group: 'stock', note: 'Bang can doi ton: SKU x kho.', body: `
var asOf = opts.asOf || '2025-12-31';
var title = 'Can doi ton theo kho';
var whSet = {};
var whList = [];
var bal = {};
var skuList = [];
for (var i = 0; i < rows.length; i++) {
  var r = rows[i];
  var w = r.warehouse || 'MAIN';
  if (!whSet[w]) {
    whSet[w] = 1;
    whList.push(w);
  }
  if (!bal[r.sku]) {
    bal[r.sku] = {};
    skuList.push(r.sku);
  }
  bal[r.sku][w] = (bal[r.sku][w] || 0) + r.qty;
}
whList.sort(cmpStr);
skuList.sort(cmpStr);
var out = [];
for (var j = 0; j < skuList.length; j++) {
  var row = { sku: skuList[j] };
  var sum = 0;
  for (var k = 0; k < whList.length; k++) {
    row[whList[k]] = bal[skuList[j]][whList[k]] || 0;
    sum += row[whList[k]];
  }
  row.total = sum;
  out.push(row);
}
var cols = [['sku', 'SKU', 10, 'L', 's']];
for (var c = 0; c < whList.length; c++) cols.push([whList[c], whList[c], 7, 'R', 'i']);
cols.push(['total', 'Tong', 8, 'R', 'i']);
var footer = whList.length + ' kho, ' + skuList.length + ' SKU';` },
];

// ---------------------------------------------------------------- renderers
const RENDERERS = {
  text: { suffix: 'text', body: `
var lines = [];
lines.push('== ' + title.toUpperCase() + ' ==');
var head = [];
for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? $padL(cols[c][1], cols[c][2]) : $padR(cols[c][1], cols[c][2]));
lines.push(head.join(' | '));
var width = 0;
for (var c2 = 0; c2 < cols.length; c2++) width += cols[c2][2];
width += (cols.length - 1) * 3;
lines.push(rep('-', width));
for (var ri = 0; ri < out.length; ri++) {
  var cells = [];
  for (var ci = 0; ci < cols.length; ci++) {
    var v = out[ri][cols[ci][0]];
    var kind = cols[ci][4];
    var t;
    if (v == null) t = '-';
    else if (kind === 'm' || kind === 'i') t = $money(v);
    else if (kind === 'p') t = fmtPct(v);
    else t = String(v);
    cells.push(cols[ci][3] === 'R' ? $padL(t, cols[ci][2]) : $padR(t, cols[ci][2]));
  }
  lines.push(cells.join(' | '));
}
lines.push(rep('-', width));
if (footer) lines.push(footer);
lines.push('(' + out.length + ' dong)');
return lines.join('\\n') + '\\n';` },
  csv: { suffix: 'csv', body: `
var csv = [];
var hdr = [];
for (var c = 0; c < cols.length; c++) hdr.push(csvCell(cols[c][1]));
csv.push(hdr.join(';'));
for (var ri = 0; ri < out.length; ri++) {
  var cells = [];
  for (var ci = 0; ci < cols.length; ci++) {
    var v = out[ri][cols[ci][0]];
    var kind = cols[ci][4];
    if (v == null) cells.push('');
    else if (kind === 'm') cells.push(String(Math.round(v)));
    else if (kind === 'p') cells.push(csvPct(v));
    else cells.push(csvCell(v));
  }
  csv.push(cells.join(';'));
}
return csv.join('\\r\\n') + '\\r\\n';` },
  html: { suffix: 'html', body: `
var h = '<table class="rpt">\\n';
h += '  <caption>' + $esc(title) + '</caption>\\n';
h += '  <thead><tr>';
for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + $esc(cols[c][1]) + '</th>';
h += '</tr></thead>\\n';
h += '  <tbody>\\n';
for (var ri = 0; ri < out.length; ri++) {
  h += '    <tr>';
  for (var ci = 0; ci < cols.length; ci++) {
    var v = out[ri][cols[ci][0]];
    var kind = cols[ci][4];
    var t;
    if (v == null) t = '&nbsp;';
    else if (kind === 'm' || kind === 'i') t = $money(v);
    else if (kind === 'p') t = fmtPct(v);
    else t = $esc(v);
    h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
  }
  h += '</tr>\\n';
}
h += '  </tbody>\\n';
if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + $esc(footer) + '</td></tr></tfoot>\\n';
h += '</table>\\n';
return h;` },
  json: { suffix: 'json', body: `
var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
return JSON.stringify(payload, null, 2);` },
  md: { suffix: 'md', body: `
var md = [];
md.push('### ' + title);
md.push('');
var hd = [];
var al = [];
for (var c = 0; c < cols.length; c++) {
  hd.push(mdCell(cols[c][1]));
  al.push(cols[c][3] === 'R' ? '---:' : ':---');
}
md.push('| ' + hd.join(' | ') + ' |');
md.push('| ' + al.join(' | ') + ' |');
for (var ri = 0; ri < out.length; ri++) {
  var cells = [];
  for (var ci = 0; ci < cols.length; ci++) {
    var v = out[ri][cols[ci][0]];
    var kind = cols[ci][4];
    if (v == null) cells.push('');
    else if (kind === 'm' || kind === 'i') cells.push($money(v));
    else if (kind === 'p') cells.push(fmtPct(v));
    else cells.push(mdCell(v));
  }
  md.push('| ' + cells.join(' | ') + ' |');
}
if (footer) {
  md.push('');
  md.push('_' + footer + '_');
}
return md.join('\\n') + '\\n';` },
};
const FORMATS = Object.keys(RENDERERS);
const legacyName = (rep, fmt) => `rpt_${rep.base}_${RENDERERS[fmt].suffix}`;

// ---------------------------------------------------------------- legacy file
const indent = (text, n = 2) => text.trim().split('\n').map(l => l ? ' '.repeat(n) + l : l).join('\n');
const AUTHORS = ['anh Tuan', 'chi Lan', 'Hoang', 'Minh (outsource)', 'Phuong', 'team kho HN'];
const YEARS = ['2019-04', '2019-11', '2020-06', '2021-02', '2021-09', '2022-05', '2023-01', '2023-08', '2024-03'];

function legacyFile() {
  const parts = [];
  parts.push(`/*
 * report-engine.js - BAO CAO KHO (legacy)
 *
 * Module bao cao cu cua he thong kho, viet tu 2019, nhieu nguoi sua.
 * Moi bao cao co 5 dinh dang: text, csv (dau ; cho Excel VN), html, json, md.
 * Cac ham deu nhan (rows, opts):
 *   rows: [{ sku, name, category, warehouse, supplier, lot, qty, unitCost,
 *            unitPrice, receivedOn, expiresOn }]
 *   opts: { asOf, days, n, minQty, packSize, sku } tuy bao cao
 *
 * KHONG doi output: phong ke toan va 2 cua hang dang parse cac file nay.
 * Ham trung lap la do copy-paste qua nhieu nam, chua ai dam gop.
 */

var VERSION = '3.7.2';
var CURRENCY = 'VND';
var LEGACY_FLAGS = { strictDates: false, useCache: false, debug: false };

function _debug() {
  if (!LEGACY_FLAGS.debug) return;
  // eslint-disable-next-line no-console
  console.log.apply(console, ['[report-engine]'].concat([].slice.call(arguments)));
}
`);
  parts.push('/* ============================== helpers ============================== */\n');
  for (const group of Object.values(HELPERS)) for (const [, code] of group) parts.push(code + '\n');
  for (const code of COMMON) parts.push(code + '\n');
  let k = 0;
  for (const rep of REPORTS) {
    parts.push(`/* ============================== ${rep.base.toUpperCase()} ============================== */\n`);
    for (const fmt of FORMATS) {
      const pick = name => HELPERS[name][(k + name.length) % HELPERS[name].length][0];
      const sub = s => s.replaceAll('$money', pick('money')).replaceAll('$padR', pick('padR')).replaceAll('$padL', pick('padL'))
        .replaceAll('$esc', pick('esc')).replaceAll('$days', pick('days'))
        .replaceAll('$DEAD_COND', fmt === 'csv' ? 'age > days' : 'age >= days')
        .replaceAll('$TOP_N', fmt === 'md' ? '5' : '10');
      const name = legacyName(rep, fmt);
      parts.push(`/**
 * ${rep.note} Dinh dang: ${fmt}.
 * Lich su: ${YEARS[k % YEARS.length]} ${AUTHORS[k % AUTHORS.length]} - tach tu bao cao ${fmt === 'text' ? 'in' : fmt} cu.
 */
function ${name}(rows, opts) {
  opts = opts || {};
  _debug('${name}', rows.length);
${indent(sub(rep.body))}
${indent(sub(RENDERERS[fmt].body))}
}
`);
      k++;
    }
  }
  const names = REPORTS.flatMap(rep => FORMATS.map(fmt => legacyName(rep, fmt)));
  parts.push(`/* ============================== exports ============================== */\n\nexport {\n  VERSION,\n${names.map(n => `  ${n}`).join(',\n')}\n};\n`);
  return parts.join('\n');
}

// ---------------------------------------------------------------- reference split
function referenceFiles() {
  const files = {};
  const canonical = s => s.replaceAll('$money', 'fmtMoney').replaceAll('$padR', 'padR').replaceAll('$padL', 'padL')
    .replaceAll('$esc', 'escHtml').replaceAll('$days', 'daysBetween')
    .replaceAll('$DEAD_COND', "(variant === 'csv' ? age > days : age >= days)")
    .replaceAll('$TOP_N', "(variant === 'md' ? 5 : 10)");
  const helperNames = ['fmtMoney', 'padR', 'padL', 'escHtml', 'daysBetween', 'addDays', 'fmtPct', 'csvPct', 'csvCell', 'mdCell', 'rep', 'cmpStr'];
  files['src/reports/format.js'] = `// Shared formatting helpers of the report engine (one copy of each).
export const CURRENCY = 'VND';

${[HELPERS.money[0][1], HELPERS.padR[0][1], HELPERS.padL[0][1], HELPERS.esc[0][1], HELPERS.days[0][1], ...COMMON].map(c => 'export ' + c).join('\n\n')}
`;
  for (const group of ['stock', 'time']) {
    const reps = REPORTS.filter(r => r.group === group);
    files[`src/reports/compute-${group}.js`] = `// Report computations: rows + opts -> { title, cols, out, footer, asOf }.
// variant is the output format, for the two places where legacy formats differ.
import { ${helperNames.join(', ')}, CURRENCY } from './format.js';

${reps.map(rep => `// ${rep.note}
export function ${rep.ref}(rows, opts, variant) {
${indent(canonical(rep.body))}
  return { title, cols, out, footer, asOf };
}`).join('\n\n')}
`;
  }
  files['src/reports/render.js'] = `// Output formats of the report engine.
import { ${helperNames.join(', ')} } from './format.js';

${FORMATS.map(fmt => `export function render_${fmt}({ title, cols, out, footer, asOf }) {
${indent(canonical(RENDERERS[fmt].body))}
}`).join('\n\n')}
`;
  files['src/reports/index.js'] = `// Builds a legacy report function from a computation and an output format.
import * as stock from './compute-stock.js';
import * as time from './compute-time.js';
import * as render from './render.js';

const COMPUTE = { ...stock, ...time };

export function report(name, format) {
  const compute = COMPUTE[name], draw = render['render_' + format];
  return function (rows, opts) { return draw(compute(rows || [], opts || {}, format)); };
}
`;
  const lines = REPORTS.flatMap(rep => FORMATS.map(fmt => `export const ${legacyName(rep, fmt)} = report('${rep.ref}', '${fmt}');`));
  files['src/legacy/report-engine.js'] = `// Legacy report engine: same exports and output as before the split.
// The work lives in src/reports/.
import { report } from '../reports/index.js';

export const VERSION = '3.7.2';

${lines.join('\n')}
`;
  return files;
}

// ---------------------------------------------------------------- golden data
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export function goldenRows() {
  const r = rng(20250417), pick = a => a[Math.floor(r() * a.length)];
  const cats = ['Sua', 'Banh keo', 'Do uong', 'Gia vi', 'Dong lanh', 'Hoa pham'];
  const sups = ['Vinamilk', 'Kinh Do', 'Masan', 'Acecook', 'Cong ty "Ha Long"', 'NCC; Tan Phu'];
  const names = ['Sua tuoi 1L', 'Banh quy bo <hop>', 'Nuoc mam 500ml', 'Mi tom chua cay', 'Ca vien | dong lanh', 'Nuoc rua chen & chanh', 'Tra xanh khong do 450ml', 'Keo deo trai cay'];
  const rows = [];
  for (let i = 0; i < 140; i++) {
    const sku = 'SKU-' + String(1 + Math.floor(r() * 40)).padStart(3, '0');
    const recv = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 360) * 86400000).toISOString().slice(0, 10);
    const exp = r() < 0.2 ? null : new Date(Date.parse(recv) + Math.floor(r() * 400) * 86400000).toISOString().slice(0, 10);
    const cost = 1000 * (1 + Math.floor(r() * 300)) + (r() < 0.2 ? 500 : 0);
    rows.push({ sku, name: names[parseInt(sku.slice(4), 10) % names.length], category: cats[parseInt(sku.slice(4), 10) % cats.length],
      warehouse: pick(['MAIN', 'HN', 'DN', 'HCM']), supplier: pick(sups), lot: 'L' + String(Math.floor(r() * 900) + 100), qty: 1 + Math.floor(r() * 120),
      unitCost: cost, unitPrice: Math.round(cost * (1.05 + r() * 0.5)), receivedOn: recv, expiresOn: exp });
  }
  return rows;
}
const CASES = {
  value_by_category: [{}, { asOf: '2025-06-30' }],
  value_by_warehouse: [{}, { asOf: '2025-03-01' }],
  aging: [{ asOf: '2025-12-31' }, { asOf: '2025-08-15' }],
  expiry_calendar: [{ asOf: '2025-10-01' }, { asOf: '2025-12-31', days: 90 }],
  expired: [{ asOf: '2025-09-30' }, {}],
  supplier_summary: [{}, { asOf: '2025-01-31' }],
  top_skus: [{}, { n: 3 }],
  margin_by_category: [{}, { asOf: '2025-12-31' }],
  dead_stock: [{ asOf: '2025-12-31', days: 60 }, { asOf: '2026-02-01' }],
  reorder: [{}, { minQty: 120, packSize: 24 }],
  abc_class: [{}, { asOf: '2025-12-31' }],
  lot_trace: [{ sku: 'SKU-007' }, { sku: 'SKU-021' }],
  warehouse_balance: [{}, { asOf: '2025-12-31' }],
};

// ---------------------------------------------------------------- write
const legacy = legacyFile();
out('project/src/legacy/report-engine.js', legacy);
for (const [rel, text] of Object.entries(referenceFiles())) out(`reference-p5/${rel}`, text);
const engine = await import(path.join(FIX, 'project/src/legacy/report-engine.js') + `?t=${Date.now()}`);
const rows = goldenRows(), golden = { originalLines: legacy.split('\n').length, rows, cases: [] };
for (const rep of REPORTS) for (const fmt of FORMATS) for (const opts of CASES[rep.base]) {
  const name = legacyName(rep, fmt);
  golden.cases.push({ name, opts, output: engine[name](JSON.parse(JSON.stringify(rows)), { ...opts }) });
}
golden.cases.push({ name: 'rpt_value_by_category_text', opts: {}, rows: [], output: engine.rpt_value_by_category_text([], {}) });
out('hidden-p5/test/zz-legacy-golden.hidden.json', JSON.stringify(golden) + '\n');
// Check the split reproduces every output.
const split = await import(path.join(FIX, 'reference-p5/src/legacy/report-engine.js') + `?t=${Date.now()}`);
let bad = 0;
for (const c of golden.cases) if (split[c.name](JSON.parse(JSON.stringify(c.rows ?? rows)), { ...c.opts }) !== c.output) { bad++; console.error('mismatch', c.name, c.opts); }
console.log(`legacy: ${golden.originalLines} lines, ${golden.cases.length} golden cases, reference mismatches: ${bad}`);
if (bad) process.exit(1);
