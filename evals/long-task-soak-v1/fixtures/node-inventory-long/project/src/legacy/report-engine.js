/*
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

/* ============================== helpers ============================== */

function fmtMoney(n) {
  var s = String(Math.round(n));
  var neg = s.charAt(0) === '-';
  if (neg) s = s.substring(1);
  var out = '';
  while (s.length > 3) {
    out = '.' + s.substring(s.length - 3) + out;
    s = s.substring(0, s.length - 3);
  }
  return (neg ? '-' : '') + s + out;
}

function formatMoney2(n) {
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
}

function money_fmt(n) {
  var s = String(Math.round(n)), neg = s.charAt(0) === '-', out = '';
  if (neg) s = s.substring(1);
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s.charAt(i);
  }
  return (neg ? '-' : '') + out;
}

function padR(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s += ' ';
  return s;
}

function padRight(str, len) {
  str = '' + str;
  if (str.length > len) return str.substring(0, len - 1) + '~';
  return str + new Array(len - str.length + 1).join(' ');
}

function padL(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s = ' ' + s;
  return s;
}

function padLeft(str, len) {
  str = '' + str;
  if (str.length > len) return str.substring(0, len - 1) + '~';
  return new Array(len - str.length + 1).join(' ') + str;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function html_escape(s) {
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
}

function daysBetween(a, b) {
  return Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function diffDays(from, to) {
  var t1 = Date.parse(from + 'T00:00:00Z');
  var t2 = Date.parse(to + 'T00:00:00Z');
  return Math.floor((t2 - t1) / (24 * 60 * 60 * 1000));
}

function addDays(d, n) {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().substring(0, 10);
}

function fmtPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1) + '%';
}

function csvPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1).replace('.', ',');
}

function csvCell(v) {
  v = v == null ? '' : String(v);
  if (v.indexOf(';') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function rep(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ============================== VALUE_BY_CATEGORY ============================== */

/**
 * Gia tri ton kho theo nhom hang (theo gia von). Dinh dang: text.
 * Lich su: 2019-04 anh Tuan - tach tu bao cao in cu.
 */
function rpt_value_by_category_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_category_text', rows.length);
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
  var footer = 'Tong: ' + money_fmt(tq) + ' sp, ' + money_fmt(tv) + ' ' + CURRENCY;
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Gia tri ton kho theo nhom hang (theo gia von). Dinh dang: csv.
 * Lich su: 2019-11 chi Lan - tach tu bao cao csv cu.
 */
function rpt_value_by_category_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_category_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Gia tri ton kho theo nhom hang (theo gia von). Dinh dang: html.
 * Lich su: 2020-06 Hoang - tach tu bao cao html cu.
 */
function rpt_value_by_category_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_category_html', rows.length);
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
  var footer = 'Tong: ' + formatMoney2(tq) + ' sp, ' + formatMoney2(tv) + ' ' + CURRENCY;
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Gia tri ton kho theo nhom hang (theo gia von). Dinh dang: json.
 * Lich su: 2021-02 Minh (outsource) - tach tu bao cao json cu.
 */
function rpt_value_by_category_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_category_json', rows.length);
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
  var footer = 'Tong: ' + money_fmt(tq) + ' sp, ' + money_fmt(tv) + ' ' + CURRENCY;
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Gia tri ton kho theo nhom hang (theo gia von). Dinh dang: md.
 * Lich su: 2021-09 Phuong - tach tu bao cao md cu.
 */
function rpt_value_by_category_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_category_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== VALUE_BY_WAREHOUSE ============================== */

/**
 * Gia tri ton theo kho, kem ty trong. Dinh dang: text.
 * Lich su: 2022-05 team kho HN - tach tu bao cao in cu.
 */
function rpt_value_by_warehouse_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_warehouse_text', rows.length);
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
  var footer = 'Tong gia tri: ' + formatMoney2(tv) + ' ' + CURRENCY;
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Gia tri ton theo kho, kem ty trong. Dinh dang: csv.
 * Lich su: 2023-01 anh Tuan - tach tu bao cao csv cu.
 */
function rpt_value_by_warehouse_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_warehouse_csv', rows.length);
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
  var footer = 'Tong gia tri: ' + money_fmt(tv) + ' ' + CURRENCY;
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Gia tri ton theo kho, kem ty trong. Dinh dang: html.
 * Lich su: 2023-08 chi Lan - tach tu bao cao html cu.
 */
function rpt_value_by_warehouse_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_warehouse_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Gia tri ton theo kho, kem ty trong. Dinh dang: json.
 * Lich su: 2024-03 Hoang - tach tu bao cao json cu.
 */
function rpt_value_by_warehouse_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_warehouse_json', rows.length);
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
  var footer = 'Tong gia tri: ' + formatMoney2(tv) + ' ' + CURRENCY;
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Gia tri ton theo kho, kem ty trong. Dinh dang: md.
 * Lich su: 2019-04 Minh (outsource) - tach tu bao cao md cu.
 */
function rpt_value_by_warehouse_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_value_by_warehouse_md', rows.length);
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
  var footer = 'Tong gia tri: ' + money_fmt(tv) + ' ' + CURRENCY;
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
      else if (kind === 'm' || kind === 'i') cells.push(money_fmt(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== AGING ============================== */

/**
 * Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180). Dinh dang: text.
 * Lich su: 2019-11 Phuong - tach tu bao cao in cu.
 */
function rpt_aging_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_aging_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180). Dinh dang: csv.
 * Lich su: 2020-06 team kho HN - tach tu bao cao csv cu.
 */
function rpt_aging_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_aging_csv', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var title = 'Tuoi ton kho den ngay ' + asOf;
  var labels = ['0-30', '31-60', '61-90', '91-180', '>180'];
  var buckets = [];
  for (var b = 0; b < labels.length; b++) buckets.push({ bucket: labels[b], lots: 0, qty: 0, value: 0 });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var age = diffDays(r.receivedOn, asOf);
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
  var footer = 'Hang ton tren 90 ngay: ' + formatMoney2(old) + ' ' + CURRENCY;
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180). Dinh dang: html.
 * Lich su: 2021-02 anh Tuan - tach tu bao cao html cu.
 */
function rpt_aging_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_aging_html', rows.length);
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
  var footer = 'Hang ton tren 90 ngay: ' + money_fmt(old) + ' ' + CURRENCY;
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180). Dinh dang: json.
 * Lich su: 2021-09 chi Lan - tach tu bao cao json cu.
 */
function rpt_aging_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_aging_json', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var title = 'Tuoi ton kho den ngay ' + asOf;
  var labels = ['0-30', '31-60', '61-90', '91-180', '>180'];
  var buckets = [];
  for (var b = 0; b < labels.length; b++) buckets.push({ bucket: labels[b], lots: 0, qty: 0, value: 0 });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var age = diffDays(r.receivedOn, asOf);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Tuoi ton kho theo ngay nhap (0-30, 31-60, 61-90, 91-180, >180). Dinh dang: md.
 * Lich su: 2022-05 Hoang - tach tu bao cao md cu.
 */
function rpt_aging_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_aging_md', rows.length);
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
  var footer = 'Hang ton tren 90 ngay: ' + formatMoney2(old) + ' ' + CURRENCY;
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
      else if (kind === 'm' || kind === 'i') cells.push(formatMoney2(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== EXPIRY_CALENDAR ============================== */

/**
 * Lich het han trong N ngay toi (mac dinh 30). Dinh dang: text.
 * Lich su: 2023-01 Minh (outsource) - tach tu bao cao in cu.
 */
function rpt_expiry_calendar_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_expiry_calendar_text', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var days = opts.days == null ? 30 : opts.days;
  var until = addDays(asOf, days);
  var title = 'Lich het han ' + asOf + ' -> ' + until;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.expiresOn) continue;
    if (r.expiresOn < asOf || r.expiresOn > until) continue;
    out.push({ expiresOn: r.expiresOn, sku: r.sku, lot: r.lot, warehouse: r.warehouse, qty: r.qty, daysLeft: diffDays(asOf, r.expiresOn) });
  }
  out.sort(function (a, b) {
    return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
  });
  var cols = [['expiresOn', 'Het han', 10, 'L', 'd'], ['sku', 'SKU', 10, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['daysLeft', 'Con', 4, 'R', 'i']];
  var footer = 'Tong so lo: ' + out.length;
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Lich het han trong N ngay toi (mac dinh 30). Dinh dang: csv.
 * Lich su: 2023-08 Phuong - tach tu bao cao csv cu.
 */
function rpt_expiry_calendar_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_expiry_calendar_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Lich het han trong N ngay toi (mac dinh 30). Dinh dang: html.
 * Lich su: 2024-03 team kho HN - tach tu bao cao html cu.
 */
function rpt_expiry_calendar_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_expiry_calendar_html', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var days = opts.days == null ? 30 : opts.days;
  var until = addDays(asOf, days);
  var title = 'Lich het han ' + asOf + ' -> ' + until;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.expiresOn) continue;
    if (r.expiresOn < asOf || r.expiresOn > until) continue;
    out.push({ expiresOn: r.expiresOn, sku: r.sku, lot: r.lot, warehouse: r.warehouse, qty: r.qty, daysLeft: diffDays(asOf, r.expiresOn) });
  }
  out.sort(function (a, b) {
    return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
  });
  var cols = [['expiresOn', 'Het han', 10, 'L', 'd'], ['sku', 'SKU', 10, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['daysLeft', 'Con', 4, 'R', 'i']];
  var footer = 'Tong so lo: ' + out.length;
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Lich het han trong N ngay toi (mac dinh 30). Dinh dang: json.
 * Lich su: 2019-04 anh Tuan - tach tu bao cao json cu.
 */
function rpt_expiry_calendar_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_expiry_calendar_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Lich het han trong N ngay toi (mac dinh 30). Dinh dang: md.
 * Lich su: 2019-11 chi Lan - tach tu bao cao md cu.
 */
function rpt_expiry_calendar_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_expiry_calendar_md', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var days = opts.days == null ? 30 : opts.days;
  var until = addDays(asOf, days);
  var title = 'Lich het han ' + asOf + ' -> ' + until;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.expiresOn) continue;
    if (r.expiresOn < asOf || r.expiresOn > until) continue;
    out.push({ expiresOn: r.expiresOn, sku: r.sku, lot: r.lot, warehouse: r.warehouse, qty: r.qty, daysLeft: diffDays(asOf, r.expiresOn) });
  }
  out.sort(function (a, b) {
    return cmpStr(a.expiresOn, b.expiresOn) || cmpStr(a.sku, b.sku) || cmpStr(a.lot, b.lot) || cmpStr(a.warehouse, b.warehouse);
  });
  var cols = [['expiresOn', 'Het han', 10, 'L', 'd'], ['sku', 'SKU', 10, 'L', 's'], ['lot', 'Lo', 10, 'L', 's'], ['warehouse', 'Kho', 6, 'L', 's'], ['qty', 'SL', 7, 'R', 'i'], ['daysLeft', 'Con', 4, 'R', 'i']];
  var footer = 'Tong so lo: ' + out.length;
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
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== EXPIRED ============================== */

/**
 * Danh sach lo da het han (expiresOn < asOf) va gia tri. Dinh dang: text.
 * Lich su: 2020-06 Hoang - tach tu bao cao in cu.
 */
function rpt_expired_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_expired_text', rows.length);
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
  var footer = 'Tong gia tri het han: ' + formatMoney2(total) + ' ' + CURRENCY;
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Danh sach lo da het han (expiresOn < asOf) va gia tri. Dinh dang: csv.
 * Lich su: 2021-02 Minh (outsource) - tach tu bao cao csv cu.
 */
function rpt_expired_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_expired_csv', rows.length);
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
  var footer = 'Tong gia tri het han: ' + money_fmt(total) + ' ' + CURRENCY;
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Danh sach lo da het han (expiresOn < asOf) va gia tri. Dinh dang: html.
 * Lich su: 2021-09 Phuong - tach tu bao cao html cu.
 */
function rpt_expired_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_expired_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Danh sach lo da het han (expiresOn < asOf) va gia tri. Dinh dang: json.
 * Lich su: 2022-05 team kho HN - tach tu bao cao json cu.
 */
function rpt_expired_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_expired_json', rows.length);
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
  var footer = 'Tong gia tri het han: ' + formatMoney2(total) + ' ' + CURRENCY;
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Danh sach lo da het han (expiresOn < asOf) va gia tri. Dinh dang: md.
 * Lich su: 2023-01 anh Tuan - tach tu bao cao md cu.
 */
function rpt_expired_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_expired_md', rows.length);
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
  var footer = 'Tong gia tri het han: ' + money_fmt(total) + ' ' + CURRENCY;
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
      else if (kind === 'm' || kind === 'i') cells.push(money_fmt(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== SUPPLIER_SUMMARY ============================== */

/**
 * Tong hop theo nha cung cap. Dinh dang: text.
 * Lich su: 2023-08 chi Lan - tach tu bao cao in cu.
 */
function rpt_supplier_summary_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_supplier_summary_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Tong hop theo nha cung cap. Dinh dang: csv.
 * Lich su: 2024-03 Hoang - tach tu bao cao csv cu.
 */
function rpt_supplier_summary_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_supplier_summary_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Tong hop theo nha cung cap. Dinh dang: html.
 * Lich su: 2019-04 Minh (outsource) - tach tu bao cao html cu.
 */
function rpt_supplier_summary_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_supplier_summary_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Tong hop theo nha cung cap. Dinh dang: json.
 * Lich su: 2019-11 Phuong - tach tu bao cao json cu.
 */
function rpt_supplier_summary_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_supplier_summary_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Tong hop theo nha cung cap. Dinh dang: md.
 * Lich su: 2020-06 team kho HN - tach tu bao cao md cu.
 */
function rpt_supplier_summary_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_supplier_summary_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(formatMoney2(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== TOP_SKUS ============================== */

/**
 * Top SKU theo gia tri ton (mac dinh 10). Dinh dang: text.
 * Lich su: 2021-02 anh Tuan - tach tu bao cao in cu.
 */
function rpt_top_skus_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_top_skus_text', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? 10 : opts.n;
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Top SKU theo gia tri ton (mac dinh 10). Dinh dang: csv.
 * Lich su: 2021-09 chi Lan - tach tu bao cao csv cu.
 */
function rpt_top_skus_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_top_skus_csv', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? 10 : opts.n;
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Top SKU theo gia tri ton (mac dinh 10). Dinh dang: html.
 * Lich su: 2022-05 Hoang - tach tu bao cao html cu.
 */
function rpt_top_skus_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_top_skus_html', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? 10 : opts.n;
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Top SKU theo gia tri ton (mac dinh 10). Dinh dang: json.
 * Lich su: 2023-01 Minh (outsource) - tach tu bao cao json cu.
 */
function rpt_top_skus_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_top_skus_json', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? 10 : opts.n;
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Top SKU theo gia tri ton (mac dinh 10). Dinh dang: md.
 * Lich su: 2023-08 Phuong - tach tu bao cao md cu.
 */
function rpt_top_skus_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_top_skus_md', rows.length);
  var asOf = opts.asOf || '2025-12-31';
  var n = opts.n == null ? 5 : opts.n;
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
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== MARGIN_BY_CATEGORY ============================== */

/**
 * Bien loi nhuan du kien theo nhom (gia ban - gia von). Dinh dang: text.
 * Lich su: 2024-03 team kho HN - tach tu bao cao in cu.
 */
function rpt_margin_by_category_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_margin_by_category_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Bien loi nhuan du kien theo nhom (gia ban - gia von). Dinh dang: csv.
 * Lich su: 2019-04 anh Tuan - tach tu bao cao csv cu.
 */
function rpt_margin_by_category_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_margin_by_category_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Bien loi nhuan du kien theo nhom (gia ban - gia von). Dinh dang: html.
 * Lich su: 2019-11 chi Lan - tach tu bao cao html cu.
 */
function rpt_margin_by_category_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_margin_by_category_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Bien loi nhuan du kien theo nhom (gia ban - gia von). Dinh dang: json.
 * Lich su: 2020-06 Hoang - tach tu bao cao json cu.
 */
function rpt_margin_by_category_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_margin_by_category_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Bien loi nhuan du kien theo nhom (gia ban - gia von). Dinh dang: md.
 * Lich su: 2021-02 Minh (outsource) - tach tu bao cao md cu.
 */
function rpt_margin_by_category_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_margin_by_category_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(money_fmt(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== DEAD_STOCK ============================== */

/**
 * SKU khong nhap them trong N ngay (mac dinh 90). Dinh dang: text.
 * Lich su: 2021-09 Phuong - tach tu bao cao in cu.
 */
function rpt_dead_stock_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_dead_stock_text', rows.length);
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
    if (age >= days) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * SKU khong nhap them trong N ngay (mac dinh 90). Dinh dang: csv.
 * Lich su: 2022-05 team kho HN - tach tu bao cao csv cu.
 */
function rpt_dead_stock_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_dead_stock_csv', rows.length);
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
    var age = diffDays(x.lastReceived, asOf);
    if (age > days) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * SKU khong nhap them trong N ngay (mac dinh 90). Dinh dang: html.
 * Lich su: 2023-01 anh Tuan - tach tu bao cao html cu.
 */
function rpt_dead_stock_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_dead_stock_html', rows.length);
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
    if (age >= days) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * SKU khong nhap them trong N ngay (mac dinh 90). Dinh dang: json.
 * Lich su: 2023-08 chi Lan - tach tu bao cao json cu.
 */
function rpt_dead_stock_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_dead_stock_json', rows.length);
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
    var age = diffDays(x.lastReceived, asOf);
    if (age >= days) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * SKU khong nhap them trong N ngay (mac dinh 90). Dinh dang: md.
 * Lich su: 2024-03 Hoang - tach tu bao cao md cu.
 */
function rpt_dead_stock_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_dead_stock_md', rows.length);
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
    if (age >= days) out.push({ sku: x.sku, name: x.name, lastReceived: x.lastReceived, age: age, qty: x.qty, value: x.value });
  }
  out.sort(function (a, b) {
    if (a.age !== b.age) return b.age - a.age;
    return cmpStr(a.sku, b.sku);
  });
  var cols = [['sku', 'SKU', 10, 'L', 's'], ['name', 'Ten hang', 18, 'L', 's'], ['lastReceived', 'Nhap cuoi', 10, 'L', 'd'], ['age', 'Ngay', 5, 'R', 'i'], ['qty', 'SL', 7, 'R', 'i'], ['value', 'Gia tri', 12, 'R', 'm']];
  var footer = 'So SKU cham: ' + out.length;
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
      else if (kind === 'm' || kind === 'i') cells.push(formatMoney2(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== REORDER ============================== */

/**
 * Goi y dat hang lai khi ton < minQty, lam tron theo packSize. Dinh dang: text.
 * Lich su: 2019-04 Minh (outsource) - tach tu bao cao in cu.
 */
function rpt_reorder_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_reorder_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Goi y dat hang lai khi ton < minQty, lam tron theo packSize. Dinh dang: csv.
 * Lich su: 2019-11 Phuong - tach tu bao cao csv cu.
 */
function rpt_reorder_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_reorder_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Goi y dat hang lai khi ton < minQty, lam tron theo packSize. Dinh dang: html.
 * Lich su: 2020-06 team kho HN - tach tu bao cao html cu.
 */
function rpt_reorder_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_reorder_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Goi y dat hang lai khi ton < minQty, lam tron theo packSize. Dinh dang: json.
 * Lich su: 2021-02 anh Tuan - tach tu bao cao json cu.
 */
function rpt_reorder_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_reorder_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Goi y dat hang lai khi ton < minQty, lam tron theo packSize. Dinh dang: md.
 * Lich su: 2021-09 chi Lan - tach tu bao cao md cu.
 */
function rpt_reorder_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_reorder_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== ABC_CLASS ============================== */

/**
 * Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%). Dinh dang: text.
 * Lich su: 2022-05 Hoang - tach tu bao cao in cu.
 */
function rpt_abc_class_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_abc_class_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%). Dinh dang: csv.
 * Lich su: 2023-01 Minh (outsource) - tach tu bao cao csv cu.
 */
function rpt_abc_class_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_abc_class_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%). Dinh dang: html.
 * Lich su: 2023-08 Phuong - tach tu bao cao html cu.
 */
function rpt_abc_class_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_abc_class_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%). Dinh dang: json.
 * Lich su: 2024-03 team kho HN - tach tu bao cao json cu.
 */
function rpt_abc_class_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_abc_class_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Phan loai ABC theo gia tri ton (A 80%, B 15%, C 5%). Dinh dang: md.
 * Lich su: 2019-04 anh Tuan - tach tu bao cao md cu.
 */
function rpt_abc_class_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_abc_class_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(money_fmt(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== LOT_TRACE ============================== */

/**
 * Truy vet cac lo cua mot SKU (opts.sku). Dinh dang: text.
 * Lich su: 2019-11 chi Lan - tach tu bao cao in cu.
 */
function rpt_lot_trace_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_lot_trace_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padLeft(cols[c][1], cols[c][2]) : padRight(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padLeft(t, cols[ci][2]) : padRight(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Truy vet cac lo cua mot SKU (opts.sku). Dinh dang: csv.
 * Lich su: 2020-06 Hoang - tach tu bao cao csv cu.
 */
function rpt_lot_trace_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_lot_trace_csv', rows.length);
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
  var footer = 'SKU ' + sku + ': ' + out.length + ' lo, ' + formatMoney2(q) + ' sp';
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Truy vet cac lo cua mot SKU (opts.sku). Dinh dang: html.
 * Lich su: 2021-02 Minh (outsource) - tach tu bao cao html cu.
 */
function rpt_lot_trace_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_lot_trace_html', rows.length);
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
  var footer = 'SKU ' + sku + ': ' + out.length + ' lo, ' + money_fmt(q) + ' sp';
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Truy vet cac lo cua mot SKU (opts.sku). Dinh dang: json.
 * Lich su: 2021-09 Phuong - tach tu bao cao json cu.
 */
function rpt_lot_trace_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_lot_trace_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Truy vet cac lo cua mot SKU (opts.sku). Dinh dang: md.
 * Lich su: 2022-05 team kho HN - tach tu bao cao md cu.
 */
function rpt_lot_trace_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_lot_trace_md', rows.length);
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
  var footer = 'SKU ' + sku + ': ' + out.length + ' lo, ' + formatMoney2(q) + ' sp';
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
      else if (kind === 'm' || kind === 'i') cells.push(formatMoney2(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== WAREHOUSE_BALANCE ============================== */

/**
 * Bang can doi ton: SKU x kho. Dinh dang: text.
 * Lich su: 2023-01 anh Tuan - tach tu bao cao in cu.
 */
function rpt_warehouse_balance_text(rows, opts) {
  opts = opts || {};
  _debug('rpt_warehouse_balance_text', rows.length);
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
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
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
      else if (kind === 'm' || kind === 'i') t = money_fmt(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

/**
 * Bang can doi ton: SKU x kho. Dinh dang: csv.
 * Lich su: 2023-08 chi Lan - tach tu bao cao csv cu.
 */
function rpt_warehouse_balance_csv(rows, opts) {
  opts = opts || {};
  _debug('rpt_warehouse_balance_csv', rows.length);
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
  return csv.join('\r\n') + '\r\n';
}

/**
 * Bang can doi ton: SKU x kho. Dinh dang: html.
 * Lich su: 2024-03 Hoang - tach tu bao cao html cu.
 */
function rpt_warehouse_balance_html(rows, opts) {
  opts = opts || {};
  _debug('rpt_warehouse_balance_html', rows.length);
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
  var h = '<table class="rpt">\n';
  h += '  <caption>' + html_escape(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + html_escape(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = formatMoney2(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = html_escape(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + html_escape(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

/**
 * Bang can doi ton: SKU x kho. Dinh dang: json.
 * Lich su: 2019-04 Minh (outsource) - tach tu bao cao json cu.
 */
function rpt_warehouse_balance_json(rows, opts) {
  opts = opts || {};
  _debug('rpt_warehouse_balance_json', rows.length);
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
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

/**
 * Bang can doi ton: SKU x kho. Dinh dang: md.
 * Lich su: 2019-11 Phuong - tach tu bao cao md cu.
 */
function rpt_warehouse_balance_md(rows, opts) {
  opts = opts || {};
  _debug('rpt_warehouse_balance_md', rows.length);
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
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

/* ============================== exports ============================== */

export {
  VERSION,
  rpt_value_by_category_text,
  rpt_value_by_category_csv,
  rpt_value_by_category_html,
  rpt_value_by_category_json,
  rpt_value_by_category_md,
  rpt_value_by_warehouse_text,
  rpt_value_by_warehouse_csv,
  rpt_value_by_warehouse_html,
  rpt_value_by_warehouse_json,
  rpt_value_by_warehouse_md,
  rpt_aging_text,
  rpt_aging_csv,
  rpt_aging_html,
  rpt_aging_json,
  rpt_aging_md,
  rpt_expiry_calendar_text,
  rpt_expiry_calendar_csv,
  rpt_expiry_calendar_html,
  rpt_expiry_calendar_json,
  rpt_expiry_calendar_md,
  rpt_expired_text,
  rpt_expired_csv,
  rpt_expired_html,
  rpt_expired_json,
  rpt_expired_md,
  rpt_supplier_summary_text,
  rpt_supplier_summary_csv,
  rpt_supplier_summary_html,
  rpt_supplier_summary_json,
  rpt_supplier_summary_md,
  rpt_top_skus_text,
  rpt_top_skus_csv,
  rpt_top_skus_html,
  rpt_top_skus_json,
  rpt_top_skus_md,
  rpt_margin_by_category_text,
  rpt_margin_by_category_csv,
  rpt_margin_by_category_html,
  rpt_margin_by_category_json,
  rpt_margin_by_category_md,
  rpt_dead_stock_text,
  rpt_dead_stock_csv,
  rpt_dead_stock_html,
  rpt_dead_stock_json,
  rpt_dead_stock_md,
  rpt_reorder_text,
  rpt_reorder_csv,
  rpt_reorder_html,
  rpt_reorder_json,
  rpt_reorder_md,
  rpt_abc_class_text,
  rpt_abc_class_csv,
  rpt_abc_class_html,
  rpt_abc_class_json,
  rpt_abc_class_md,
  rpt_lot_trace_text,
  rpt_lot_trace_csv,
  rpt_lot_trace_html,
  rpt_lot_trace_json,
  rpt_lot_trace_md,
  rpt_warehouse_balance_text,
  rpt_warehouse_balance_csv,
  rpt_warehouse_balance_html,
  rpt_warehouse_balance_json,
  rpt_warehouse_balance_md
};
