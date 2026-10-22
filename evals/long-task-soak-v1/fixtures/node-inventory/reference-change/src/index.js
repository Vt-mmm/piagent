export class InventoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') line++; field += c; }
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push({ line: rowLine, cells: row }); row = []; field = ''; line++; rowLine = line;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows;
}
const quote = v => /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;

export class Inventory {
  constructor({ clock = today } = {}) {
    this.clock = clock;
    this.lots = new Map();          // sku -> Map(lot -> { qty, expiresOn })
    this.reservations = new Map();  // orderId -> Map(sku -> qty)
  }

  receive(sku, qty, { lot, expiresOn = null } = {}) {
    if (typeof sku !== 'string' || !sku || !Number.isInteger(qty) || qty <= 0 || typeof lot !== 'string' || !lot
      || (expiresOn !== null && !DAY.test(String(expiresOn)))) throw new InventoryError('INVALID_INPUT', 'invalid receive');
    if (!this.lots.has(sku)) this.lots.set(sku, new Map());
    const lots = this.lots.get(sku), current = lots.get(lot);
    lots.set(lot, { qty: (current?.qty ?? 0) + qty, expiresOn });
  }

  onHand(sku) { let t = 0; for (const { qty } of this.lots.get(sku)?.values() ?? []) t += qty; return t; }
  #usable(sku) {
    const now = this.clock();
    return [...(this.lots.get(sku) ?? new Map())].filter(([, l]) => l.expiresOn === null || l.expiresOn >= now)
      .sort(([a, x], [b, y]) => (x.expiresOn ?? '9999') < (y.expiresOn ?? '9999') ? -1 : (x.expiresOn ?? '9999') > (y.expiresOn ?? '9999') ? 1 : a < b ? -1 : a > b ? 1 : 0);
  }
  #reserved(sku) { let t = 0; for (const r of this.reservations.values()) t += r.get(sku) ?? 0; return t; }
  available(sku) { return Math.max(0, this.#usable(sku).reduce((s, [, l]) => s + l.qty, 0) - this.#reserved(sku)); }

  reserve(orderId, sku, qty) {
    if (!Number.isInteger(qty) || qty <= 0) throw new InventoryError('INVALID_INPUT', 'invalid qty');
    if (this.available(sku) < qty) throw new InventoryError('INSUFFICIENT_STOCK', `not enough ${sku}`);
    if (!this.reservations.has(orderId)) this.reservations.set(orderId, new Map());
    const r = this.reservations.get(orderId); r.set(sku, (r.get(sku) ?? 0) + qty);
  }
  release(orderId) { this.reservations.delete(orderId); }

  commit(orderId) {
    const r = this.reservations.get(orderId);
    if (!r) throw new InventoryError('UNKNOWN_ORDER', `unknown order ${orderId}`);
    const taken = [];
    for (const [sku, qty] of r) {
      let left = qty;
      for (const [lot, l] of this.#usable(sku)) {
        if (!left) break;
        const n = Math.min(left, l.qty); l.qty -= n; left -= n; taken.push({ sku, lot, qty: n });
        if (!l.qty) this.lots.get(sku).delete(lot);
      }
    }
    this.reservations.delete(orderId);
    return taken;
  }

  importCsv(text) {
    const rows = parseCsv(text), header = rows.shift()?.cells.map(h => h.trim()) ?? [];
    const col = name => header.indexOf(name);
    let imported = 0; const errors = [];
    for (const { line, cells } of rows) {
      if (cells.length === 1 && cells[0].trim() === '') continue;
      const qty = Number(cells[col('qty')]), expires = cells[col('expiresOn')]?.trim();
      try {
        if (!/^\d+$/.test(String(cells[col('qty')]).trim())) throw new InventoryError('INVALID_INPUT', 'qty must be a whole number');
        this.receive(cells[col('sku')], qty, { lot: cells[col('lot')], expiresOn: expires ? expires : null });
        imported++;
      } catch (error) { errors.push({ line, message: error.message }); }
    }
    return { imported, errors };
  }

  exportCsv() {
    const rows = [];
    for (const [sku, lots] of this.lots) for (const [lot, l] of lots) rows.push([sku, lot, l.qty, l.expiresOn ?? '']);
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    return ['sku,lot,qty,expiresOn', ...rows.map(r => r.map(v => quote(String(v))).join(','))].join('\n') + '\n';
  }

  lowStock(threshold) {
    return [...this.lots.keys()].map(sku => ({ sku, available: this.available(sku) })).filter(x => x.available <= threshold)
      .sort((a, b) => a.available - b.available || (a.sku < b.sku ? -1 : 1));
  }

  expiringWithin(days) {
    const now = this.clock(), until = addDays(now, days), out = [];
    for (const [sku, lots] of this.lots) for (const [lot, l] of lots) if (l.expiresOn && l.expiresOn >= now && l.expiresOn <= until) out.push({ sku, lot, qty: l.qty, expiresOn: l.expiresOn });
    return out.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.sku.localeCompare(b.sku) || a.lot.localeCompare(b.lot));
  }

  toJSON() {
    return { lots: [...this.lots].map(([sku, lots]) => [sku, [...lots].map(([lot, l]) => [lot, { ...l }])]),
      reservations: [...this.reservations].map(([o, r]) => [o, [...r]]) };
  }
  static fromJSON(data, options) {
    const inv = new Inventory(options);
    inv.lots = new Map(data.lots.map(([sku, lots]) => [sku, new Map(lots.map(([lot, l]) => [lot, { ...l }]))]));
    inv.reservations = new Map(data.reservations.map(([o, r]) => [o, new Map(r)]));
    return inv;
  }
}
