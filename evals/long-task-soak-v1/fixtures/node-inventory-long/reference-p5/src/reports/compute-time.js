// Report computations: rows + opts -> { title, cols, out, footer, asOf }.
// variant is the output format, for the two places where legacy formats differ.
import { fmtMoney, padR, padL, escHtml, daysBetween, addDays, fmtPct, csvPct, csvCell, mdCell, rep, cmpStr, CURRENCY } from './format.js';

// Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180).
export function aging(rows, opts, variant) {
  var asOf = opts.asOf || '2025-12-31';
  var title = 'Tuoi ton kho den ngay ' + asOf;
  var labels = ['0-30', '31-60', '61-90', '91-180', '>180'];
  var buckets = [];
  for (var b = 0; b < labels.length; b++) buckets.push({ bucket: labels[b], lots: 0, qty: 0, value: 0 });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var age = daysBetween(r.receivedOn, asOf);
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
  var footer = 'Hang ton tren 90 ngay: ' + fmtMoney(old) + ' ' + CURRENCY;
  return { title, cols, out, footer, asOf };
}

// Lich het han trong N ngay toi (mac dinh 30).
export function expiryCalendar(rows, opts, variant) {
  var asOf = opts.asOf || '2025-12-31';
  var days = opts.days == null ? 30 : opts.days;
  var until = addDays(asOf, days);
  var title = 'Lich het han ' + asOf + ' -> ' + until;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.expiresOn) continue;
    if (r.expiresOn < asOf || r.expiresOn > until) continue;
    out.push({ expiresOn: r.expiresOn, sku: r.sku, lot: r.lot, warehouse: r.warehouse, qty: r.qty, daysLeft: daysBetween(asOf, r.expiresOn) });
  }
  out.sort(function (a, b) {
    return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
  });
  var cols = [['expiresOn', 'Het han', 10, 'L', 'd'], ['sku', 'SKU', 10, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['daysLeft', 'Con', 4, 'R', 'i']];
  var footer = 'Tong so lo: ' + out.length;
  return { title, cols, out, footer, asOf };
}

// Danh sach lo da het han (expiresOn < asOf) va gia tri.
export function expired(rows, opts, variant) {
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
  var footer = 'Tong gia tri het han: ' + fmtMoney(total) + ' ' + CURRENCY;
  return { title, cols, out, footer, asOf };
}

// SKU khong nhap them trong N ngay (mac dinh 90).
export function deadStock(rows, opts, variant) {
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
    var age = daysBetween(x.lastReceived, asOf);
    if ((variant === 'csv' ? age > days : age >= days)) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
  return { title, cols, out, footer, asOf };
}

// Goi y dat hang lai khi ton < minQty, lam tron theo packSize.
export function reorder(rows, opts, variant) {
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
  var footer = 'Can dat ' + out.length + ' SKU';
  return { title, cols, out, footer, asOf };
}

// Truy vet cac lo cua mot SKU (opts.sku).
export function lotTrace(rows, opts, variant) {
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
  var footer = 'SKU ' + sku + ': ' + out.length + ' lo, ' + fmtMoney(q) + ' sp';
  return { title, cols, out, footer, asOf };
}
