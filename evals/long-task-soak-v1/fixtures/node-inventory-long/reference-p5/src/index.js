export class InventoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day: 2025-02-30 is not one.
const isDay = v => { if (typeof v !== 'string' || !DAY.test(v)) return false; const t = Date.parse(`${v}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; };
const MAIN = 'MAIN';
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (code, message) => { throw new InventoryError(code, message); };
const isName = v => typeof v === 'string' && v !== '';
const isQty = v => Number.isInteger(v) && v > 0;

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
  constructor({ clock = today, onEvent = null } = {}) {
    this.clock = clock;
    this.onEvent = onEvent;
    this.lots = new Map();          // warehouse -> Map(sku -> Map(lot -> { qty, expiresOn }))
    this.reservations = new Map();  // orderId -> { warehouse, items: Map(sku -> qty) }
    this.transfers = new Map();     // transferId -> { sku, qty, from, to, lot }
    this.log = [];                  // append-only audit log
  }

  // ---- audit log: every change is an event; replay applies recorded outcomes
  #record(type, data) {
    const event = { seq: this.log.length + 1, type, ...data };
    this.#apply(event);
    this.log.push(structuredClone(event));
    this.onEvent?.(structuredClone(event));
    return event;
  }
  events() { return structuredClone(this.log); }
  static replay(events, { clock, onEvent = null } = {}) {
    const inv = new Inventory({ clock });
    for (const event of events) { inv.#apply(event); inv.log.push(structuredClone(event)); }
    inv.onEvent = onEvent;
    return inv;
  }
  #addLot(warehouse, sku, lot, qty, expiresOn) {
    const skus = this.#skus(warehouse);
    if (!skus.has(sku)) skus.set(sku, new Map());
    const lots = skus.get(sku), current = lots.get(lot);
    lots.set(lot, { qty: (current?.qty ?? 0) + qty, expiresOn });
  }
  #removeLot(warehouse, sku, lot, qty) {
    const lots = this.#lotsOf(warehouse, sku), l = lots.get(lot);
    l.qty -= qty; if (!l.qty) lots.delete(lot);
  }
  #apply(e) {
    switch (e.type) {
      case 'received': this.#addLot(e.warehouse, e.sku, e.lot, e.qty, e.expiresOn); break;
      case 'reserved': {
        if (!this.reservations.has(e.orderId)) this.reservations.set(e.orderId, { warehouse: e.warehouse, items: new Map() });
        const items = this.reservations.get(e.orderId).items;
        items.set(e.sku, (items.get(e.sku) ?? 0) + e.qty);
        break;
      }
      case 'released': this.reservations.delete(e.orderId); break;
      case 'committed': {
        const order = this.reservations.get(e.orderId);
        for (const t of e.taken) this.#removeLot(order.warehouse, t.sku, t.lot, t.qty);
        this.reservations.delete(e.orderId);
        break;
      }
      case 'transfer_created': this.transfers.set(e.transferId, { sku: e.sku, qty: e.qty, from: e.from, to: e.to, lot: e.lot }); break;
      case 'transfer_completed': {
        const t = this.transfers.get(e.transferId);
        for (const m of e.moved) { this.#removeLot(t.from, t.sku, m.lot, m.qty); this.#addLot(t.to, t.sku, m.lot, m.qty, m.expiresOn); }
        this.transfers.delete(e.transferId);
        break;
      }
      case 'transfer_cancelled': this.transfers.delete(e.transferId); break;
      default: throw new InventoryError('INVALID_INPUT', `unknown event ${e.type}`);
    }
  }

  #skus(warehouse) { if (!this.lots.has(warehouse)) this.lots.set(warehouse, new Map()); return this.lots.get(warehouse); }
  #lotsOf(warehouse, sku) { return this.lots.get(warehouse)?.get(sku) ?? new Map(); }
  #expired(l) { return l.expiresOn !== null && l.expiresOn < this.clock(); }
  #fefo(warehouse, sku) {
    return [...this.#lotsOf(warehouse, sku)].filter(([, l]) => !this.#expired(l))
      .sort(([a, x], [b, y]) => cmp(x.expiresOn ?? '9999', y.expiresOn ?? '9999') || cmp(a, b));
  }
  #usableQty(warehouse, sku) { return this.#fefo(warehouse, sku).reduce((s, [, l]) => s + l.qty, 0); }
  #expiredQty(warehouse, sku) { let t = 0; for (const l of this.#lotsOf(warehouse, sku).values()) if (this.#expired(l)) t += l.qty; return t; }
  #reserved(warehouse, sku) {
    let t = 0;
    for (const r of this.reservations.values()) if (r.warehouse === warehouse) t += r.items.get(sku) ?? 0;
    for (const tr of this.transfers.values()) if (tr.from === warehouse && tr.sku === sku) t += tr.qty;
    return t;
  }
  #warehouses() { return [...this.lots.keys()]; }

  receive(sku, qty, { lot, expiresOn = null, warehouse = MAIN } = {}) {
    if (!isName(sku) || !isQty(qty) || !isName(lot) || !isName(warehouse)
      || (expiresOn !== null && !isDay(expiresOn))) fail('INVALID_INPUT', 'invalid receive');
    this.#record('received', { sku, qty, lot, expiresOn, warehouse });
  }

  onHand(sku, warehouse) {
    let t = 0;
    for (const wh of warehouse ? [warehouse] : this.#warehouses()) for (const { qty } of this.#lotsOf(wh, sku).values()) t += qty;
    return t;
  }
  available(sku, warehouse) {
    if (warehouse) return Math.max(0, this.#usableQty(warehouse, sku) - this.#reserved(warehouse, sku));
    return this.#warehouses().reduce((s, wh) => s + this.available(sku, wh), 0);
  }

  reserve(orderId, sku, qty, { warehouse = MAIN } = {}) {
    if (!isName(orderId) || !isName(sku) || !isQty(qty) || !isName(warehouse)) fail('INVALID_INPUT', 'invalid reserve');
    const order = this.reservations.get(orderId);
    if (order && order.warehouse !== warehouse) fail('INVALID_INPUT', `order ${orderId} belongs to ${order.warehouse}`);
    if (this.available(sku, warehouse) < qty) fail('INSUFFICIENT_STOCK', `not enough ${sku} in ${warehouse}`);
    this.#record('reserved', { orderId, sku, qty, warehouse });
  }
  release(orderId) { if (this.reservations.has(orderId)) this.#record('released', { orderId }); }

  #plan(warehouse, sku, qty) {
    const taken = [];
    let left = qty;
    for (const [lot, l] of this.#fefo(warehouse, sku)) {
      if (!left) break;
      const n = Math.min(left, l.qty); left -= n; taken.push({ lot, qty: n, expiresOn: l.expiresOn });
    }
    return taken;
  }

  // No negative stock, no backorder: the whole order is refused and stays reserved.
  commit(orderId) {
    const order = this.reservations.get(orderId);
    if (!order) fail('UNKNOWN_ORDER', `unknown order ${orderId}`);
    for (const [sku, qty] of order.items) if (this.#usableQty(order.warehouse, sku) < qty) fail('INSUFFICIENT_STOCK', `not enough ${sku} to commit ${orderId}`);
    const taken = [];
    for (const [sku, qty] of order.items) for (const t of this.#plan(order.warehouse, sku, qty)) taken.push({ sku, lot: t.lot, qty: t.qty });
    this.#record('committed', { orderId, taken });
    return taken;
  }

  // Expired lots are never transferred (EXPIRED_LOT).
  transfer(transferId, sku, qty, { from, to, lot = null } = {}) {
    if (!isName(transferId) || this.transfers.has(transferId) || !isName(sku) || !isQty(qty) || !isName(from) || !isName(to) || from === to
      || (lot !== null && !isName(lot))) fail('INVALID_INPUT', 'invalid transfer');
    const usable = this.#usableQty(from, sku) - this.#reserved(from, sku);
    if (lot !== null) {
      const l = this.#lotsOf(from, sku).get(lot);
      if (!l) fail('INSUFFICIENT_STOCK', `no lot ${lot} of ${sku} in ${from}`);
      if (this.#expired(l)) fail('EXPIRED_LOT', `lot ${lot} of ${sku} has expired`);
      let pending = 0;
      for (const t of this.transfers.values()) if (t.from === from && t.sku === sku && t.lot === lot) pending += t.qty;
      if (l.qty - pending < qty || usable < qty) fail('INSUFFICIENT_STOCK', `not enough ${sku} in lot ${lot}`);
    } else if (usable < qty) {
      fail(usable + this.#expiredQty(from, sku) >= qty ? 'EXPIRED_LOT' : 'INSUFFICIENT_STOCK', `not enough unexpired ${sku} in ${from}`);
    }
    this.#record('transfer_created', { transferId, sku, qty, from, to, lot });
  }

  completeTransfer(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) fail('UNKNOWN_TRANSFER', `unknown transfer ${transferId}`);
    let moved;
    if (t.lot !== null) {
      const l = this.#lotsOf(t.from, t.sku).get(t.lot);
      if (!l || l.qty < t.qty) fail('INSUFFICIENT_STOCK', `lot ${t.lot} no longer holds ${t.qty}`);
      if (this.#expired(l)) fail('EXPIRED_LOT', `lot ${t.lot} has expired`);
      moved = [{ lot: t.lot, qty: t.qty, expiresOn: l.expiresOn }];
    } else {
      const usable = this.#usableQty(t.from, t.sku);
      if (usable < t.qty) fail(usable + this.#expiredQty(t.from, t.sku) >= t.qty ? 'EXPIRED_LOT' : 'INSUFFICIENT_STOCK', `not enough unexpired ${t.sku} in ${t.from}`);
      moved = this.#plan(t.from, t.sku, t.qty);
    }
    const sku = t.sku;
    this.#record('transfer_completed', { transferId, moved });
    return moved.map(m => ({ sku, lot: m.lot, qty: m.qty, expiresOn: m.expiresOn }));
  }

  cancelTransfer(transferId) {
    if (!this.transfers.has(transferId)) fail('UNKNOWN_TRANSFER', `unknown transfer ${transferId}`);
    this.#record('transfer_cancelled', { transferId });
  }

  importCsv(text, { warehouse = MAIN } = {}) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = parseCsv(text), header = rows.shift()?.cells.map(h => h.trim()) ?? [];
    const col = name => header.indexOf(name);
    let imported = 0; const errors = [];
    for (const { line, cells } of rows) {
      if (cells.length === 1 && cells[0].trim() === '') continue;
      if (cells.length !== header.length) { errors.push({ line, message: `expected ${header.length} columns, got ${cells.length}` }); continue; }
      const expires = cells[col('expiresOn')]?.trim(), wh = col('warehouse') >= 0 ? cells[col('warehouse')]?.trim() : '';
      try {
        if (!/^\d+$/.test(String(cells[col('qty')]).trim())) fail('INVALID_INPUT', 'qty must be a whole number');
        if (expires && !isDay(expires)) fail('INVALID_INPUT', `expiresOn ${expires} is not a date`);
        this.receive(cells[col('sku')], Number(cells[col('qty')]), { lot: cells[col('lot')], expiresOn: expires ? expires : null, warehouse: wh || warehouse });
        imported++;
      } catch (error) { errors.push({ line, message: error.message }); }
    }
    return { imported, errors };
  }

  exportCsv({ warehouse, all = false } = {}) {
    const rows = [];
    for (const wh of all ? this.#warehouses() : [warehouse ?? MAIN])
      for (const [sku, lots] of this.lots.get(wh) ?? []) for (const [lot, l] of lots) rows.push([wh, sku, lot, l.qty, l.expiresOn ?? '']);
    rows.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
    const lines = all ? ['warehouse,sku,lot,qty,expiresOn', ...rows.map(r => r.map(v => quote(String(v))).join(','))]
      : ['sku,lot,qty,expiresOn', ...rows.map(r => r.slice(1).map(v => quote(String(v))).join(','))];
    return lines.join('\n') + '\n';
  }

  lowStock(threshold, { warehouse } = {}) {
    const skus = new Set();
    for (const wh of warehouse ? [warehouse] : this.#warehouses()) for (const sku of this.lots.get(wh)?.keys() ?? []) skus.add(sku);
    return [...skus].map(sku => ({ sku, available: this.available(sku, warehouse) })).filter(x => x.available < threshold)
      .sort((a, b) => a.available - b.available || cmp(a.sku, b.sku));
  }

  expiringWithin(days, { warehouse } = {}) {
    const now = this.clock(), until = addDays(now, days), byLot = new Map();
    for (const wh of warehouse ? [warehouse] : this.#warehouses())
      for (const [sku, lots] of this.lots.get(wh) ?? []) for (const [lot, l] of lots) {
        if (!l.expiresOn || l.expiresOn < now || l.expiresOn > until) continue;
        const key = `${sku}\u0000${lot}\u0000${l.expiresOn}`;
        if (byLot.has(key)) byLot.get(key).qty += l.qty; else byLot.set(key, { sku, lot, qty: l.qty, expiresOn: l.expiresOn });
      }
    return [...byLot.values()].sort((a, b) => cmp(a.expiresOn, b.expiresOn) || cmp(a.sku, b.sku) || cmp(a.lot, b.lot));
  }

  stockReport({ warehouse } = {}) {
    const rows = [];
    for (const wh of warehouse ? [warehouse] : this.#warehouses())
      for (const [sku, lots] of this.lots.get(wh) ?? []) {
        if (!lots.size) continue;
        rows.push({ warehouse: wh, sku, onHand: this.onHand(sku, wh), reserved: this.#reserved(wh, sku), available: this.available(sku, wh) });
      }
    return rows.sort((a, b) => cmp(a.warehouse, b.warehouse) || cmp(a.sku, b.sku));
  }

  toJSON() {
    return {
      lots: [...this.lots].map(([wh, skus]) => [wh, [...skus].map(([sku, lots]) => [sku, [...lots].map(([lot, l]) => [lot, { ...l }])])]),
      reservations: [...this.reservations].map(([o, r]) => [o, { warehouse: r.warehouse, items: [...r.items] }]),
      transfers: [...this.transfers].map(([id, t]) => [id, { ...t }]),
    };
  }
  static fromJSON(data, options) {
    const inv = new Inventory(options);
    inv.lots = new Map(data.lots.map(([wh, skus]) => [wh, new Map(skus.map(([sku, lots]) => [sku, new Map(lots.map(([lot, l]) => [lot, { ...l }]))]))]));
    inv.reservations = new Map(data.reservations.map(([o, r]) => [o, { warehouse: r.warehouse, items: new Map(r.items) }]));
    inv.transfers = new Map((data.transfers ?? []).map(([id, t]) => [id, { ...t }]));
    return inv;
  }
}
