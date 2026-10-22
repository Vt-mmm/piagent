// Report computations: rows + opts -> { title, cols, out, footer, asOf }.
// variant is the output format, for the two places where legacy formats differ.
import { fmtMoney, padR, padL, escHtml, daysBetween, addDays, fmtPct, csvPct, csvCell, mdCell, rep, cmpStr, CURRENCY } from './format.js';

// Gia tri ton kho theo nhom hang (theo gia von).
export function valueByCategory(rows, opts, variant) {
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
  var footer = 'Tong: ' + fmtMoney(tq) + ' sp, ' + fmtMoney(tv) + ' ' + CURRENCY;
  return { title, cols, out, footer, asOf };
}

// Gia tri ton theo kho, kem ty trong.
export function valueByWarehouse(rows, opts, variant) {
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
  var footer = 'Tong gia tri: ' + fmtMoney(tv) + ' ' + CURRENCY;
  return { title, cols, out, footer, asOf };
}

// Tong hop theo nha cung cap.
export function supplierSummary(rows, opts, variant) {
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
  var footer = 'So nha cung cap: ' + out.length;
  return { title, cols, out, footer, asOf };
}

// Top SKU theo gia tri ton (mac dinh 10).
export function topSkus(rows, opts, variant) {
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? (variant === 'md' ? 5 : 10) : opts.n;
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
  var footer = 'Tong so SKU: ' + list.length;
  return { title, cols, out, footer, asOf };
}

// Bien loi nhuan du kien theo nhom (gia ban - gia von).
export function marginByCategory(rows, opts, variant) {
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
  var footer = 'Bien chung: ' + fmtPct(tr ? (tr - tc) / tr : 0);
  return { title, cols, out, footer, asOf };
}

// Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%).
export function abcClass(rows, opts, variant) {
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
  var footer = 'A: ' + counts.A + ', B: ' + counts.B + ', C: ' + counts.C;
  return { title, cols, out, footer, asOf };
}

// Bang can doi ton: SKU x kho.
export function warehouseBalance(rows, opts, variant) {
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
  var footer = whList.length + ' kho, ' + skuList.length + ' SKU';
  return { title, cols, out, footer, asOf };
}
