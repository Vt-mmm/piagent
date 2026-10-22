import { ContractError } from './errors.js';
import { CUSTOMER_TIERS } from './customer.js';

export const CONTRACT_VERSION = 1;

const isInt = v => Number.isInteger(v);
function text(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value) throw new ContractError('INVALID', `${key} must be a non-empty string`);
  return value;
}
function items(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContractError('INVALID', 'items must be a non-empty list');
  return raw.map((row, i) => {
    if (!row || typeof row !== 'object') throw new ContractError('INVALID', `items[${i}] must be an object`);
    const sku = text(row, 'sku');
    if (!isInt(row.qty) || row.qty < 1) throw new ContractError('INVALID', `items[${i}].qty must be a positive integer`);
    if (!isInt(row.unit_price) || row.unit_price < 0) throw new ContractError('INVALID', `items[${i}].unit_price must be a non-negative integer`);
    return { sku, qty: row.qty, unitPrice: row.unit_price };
  });
}

// Wire payload → { orderId, customerId, customerTier, currency, items }.
export function parseOrder(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ContractError('INVALID', 'order must be an object');
  const version = data.contract_version ?? CONTRACT_VERSION;
  if (version !== CONTRACT_VERSION) throw new ContractError('UNSUPPORTED_VERSION', `unsupported contract_version: ${JSON.stringify(version)}`);
  if (!CUSTOMER_TIERS.includes(data.customer_tier)) throw new ContractError('INVALID', `customer_tier must be one of ${CUSTOMER_TIERS.join(', ')}`);
  const currency = text(data, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new ContractError('INVALID', 'currency must be a 3-letter code');
  return {
    orderId: text(data, 'order_id'),
    customerId: text(data, 'customer_id'),
    customerTier: data.customer_tier,
    currency,
    items: items(data.items),
  };
}

// Order → wire payload (snake_case, same key order as the schema).
export function toWire(order) {
  return {
    contract_version: CONTRACT_VERSION,
    order_id: order.orderId,
    customer_id: order.customerId,
    customer_tier: order.customerTier,
    currency: order.currency,
    items: order.items.map(i => ({ sku: i.sku, qty: i.qty, unit_price: i.unitPrice })),
  };
}
