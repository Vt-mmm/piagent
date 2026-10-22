export class InventoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const today = () => new Date().toISOString().slice(0, 10);

export class Inventory {
  constructor({ clock = today } = {}) {
    this.clock = clock;
    this.lots = new Map(); // sku -> Map(lot -> { qty, expiresOn })
  }

  receive(sku, qty, { lot, expiresOn = null } = {}) {
    if (!this.lots.has(sku)) this.lots.set(sku, new Map());
    const lots = this.lots.get(sku), current = lots.get(lot);
    lots.set(lot, { qty: (current?.qty ?? 0) + qty, expiresOn });
  }

  onHand(sku) {
    let total = 0;
    for (const { qty } of this.lots.get(sku)?.values() ?? []) total += qty;
    return total;
  }
}
