// Reports over the sales table: sales, top products, stock alerts, calendar.
import { PRODUCTS, SALES } from '../data.js';
import { fail, respond, respondText } from '../http.js';
import { productBySku, provinceByCode } from '../lookup.js';
import { dateFromDayNumber, dayNumber, isDate, isoWeek, weekdayOf } from '../util/dates.js';
import { formatMoney } from '../util/money.js';
import { csvEscape, hasOwn } from '../util/text.js';
import { clamp, toInt } from '../util/url.js';
import { localName } from '../views.js';

const GROUPS = ['day', 'week', 'month', 'category', 'province', 'zone'];

function readRange(query) {
  const from = query.from || '2025-01-01';
  const to = query.to || '2025-12-31';
  if (!isDate(from)) fail(400, 'bad_date', from);
  if (!isDate(to)) fail(400, 'bad_date', to);
  if (from > to) fail(400, 'bad_range');
  return { from, to };
}

const inRange = (row, range) => row.date >= range.from && row.date <= range.to;

function salesKey(row, group) {
  switch (group) {
    case 'day': return row.date;
    case 'week': return isoWeek(row.date);
    case 'month': return row.date.substring(0, 7);
    case 'category': return productBySku(row.sku).category;
    case 'province': return row.province;
    case 'zone': return provinceByCode(row.province).zone;
    default: return null;
  }
}

function salesCsv(rows, totalQty, totalRevenue) {
  let csv = 'key;orders;qty;revenue;avg_order\n';
  for (const r of rows) csv += [csvEscape(r.key), r.orders, r.qty, r.revenue, r.avg_order].join(';') + '\n';
  const orders = rows.reduce((sum, r) => sum + r.orders, 0);
  return csv + 'TOTAL;' + orders + ';' + totalQty + ';' + totalRevenue + ';\n';
}

export function handleSalesReport(query) {
  const range = readRange(query);
  const group = query.group || 'month';
  if (GROUPS.indexOf(group) < 0) fail(400, 'bad_group', group);
  const format = query.format || 'json';
  if (format !== 'json' && format !== 'csv') fail(400, 'bad_format', format);
  const buckets = {};
  let totalQty = 0;
  let totalRevenue = 0;
  for (const row of SALES) {
    if (!inRange(row, range)) continue;
    if (query.category && productBySku(row.sku).category !== query.category) continue;
    const key = salesKey(row, group);
    if (!hasOwn(buckets, key)) buckets[key] = { key, orders: 0, qty: 0, revenue: 0 };
    const revenue = row.qty * row.unit_price;
    buckets[key].orders += 1;
    buckets[key].qty += row.qty;
    buckets[key].revenue += revenue;
    totalQty += row.qty;
    totalRevenue += revenue;
  }
  const rows = Object.keys(buckets).sort().map(key => {
    const b = buckets[key];
    b.avg_order = b.orders ? Math.round(b.revenue / b.orders) : 0;
    return b;
  });
  if (format === 'csv') return respondText(200, salesCsv(rows, totalQty, totalRevenue), 'text/csv; charset=utf-8');
  return respond(200, {
    from: range.from,
    to: range.to,
    group,
    rows,
    total_qty: totalQty,
    total_revenue: totalRevenue,
    total_revenue_display: formatMoney(totalRevenue, 'VND'),
  });
}

export function handleTopProducts(query, lang) {
  const n = toInt(query.n, 10);
  if (n < 1 || n > 50) fail(400, 'bad_n');
  const by = query.by === 'revenue' ? 'revenue' : 'qty';
  const range = readRange(query);
  const stats = new Map();
  for (const row of SALES) {
    if (!inRange(row, range)) continue;
    if (!stats.has(row.sku)) stats.set(row.sku, { sku: row.sku, qty: 0, revenue: 0 });
    const s = stats.get(row.sku);
    s.qty += row.qty;
    s.revenue += row.qty * row.unit_price;
  }
  const items = [...stats.values()]
    .sort((a, b) => (b[by] !== a[by] ? b[by] - a[by] : a.sku < b.sku ? -1 : 1))
    .slice(0, n)
    .map((item, j) => ({ ...item, rank: j + 1, name: localName(productBySku(item.sku), lang), revenue_display: formatMoney(item.revenue, 'VND') }));
  return respond(200, { by, from: range.from, to: range.to, items });
}

export function handleStockAlerts(query) {
  let threshold = 10;
  if (query.threshold !== undefined) {
    threshold = Number(query.threshold);
    if (isNaN(threshold) || threshold < 0 || Math.floor(threshold) !== threshold) fail(400, 'bad_threshold');
  }
  const items = PRODUCTS.filter(p => p.active && p.stock <= threshold)
    .map(p => ({ sku: p.sku, name: p.name, stock: p.stock, level: p.stock === 0 ? 'out' : p.stock <= threshold / 2 ? 'critical' : 'low' }))
    .sort((a, b) => (a.stock !== b.stock ? a.stock - b.stock : a.sku < b.sku ? -1 : 1));
  return respond(200, { threshold, count: items.length, items });
}

export function handleCalendar(query) {
  const from = query.from;
  if (!from || !isDate(from)) fail(400, 'bad_date', from === undefined ? '' : from);
  const days = clamp(toInt(query.days, 7), 1, 31);
  const start = dayNumber(from);
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = dateFromDayNumber(start + i);
    const weekday = weekdayOf(start + i);
    const orders = SALES.filter(row => row.date === date).length;
    out.push({ date, week: isoWeek(date), weekend: weekday === 0 || weekday === 6, orders });
  }
  return respond(200, { from: dateFromDayNumber(start), days: out });
}
