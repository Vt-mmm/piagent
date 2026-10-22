import { ContractError } from './errors.js';
import { ACCOUNT_TIERS } from './account.js';
import { LEGACY_FIELDS, isV1, upgradeV1 } from './compat-v1.js';

export const CONTRACT_VERSION = 2;
const NEW_FIELDS = Object.values(LEGACY_FIELDS);

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

// Wire payload (v2, or legacy v1) → { orderId, accountId, accountTier, currency, items, sourceVersion }.
export function parseOrder(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ContractError('INVALID', 'order must be an object');
  let sourceVersion = CONTRACT_VERSION;
  if (isV1(data)) {
    if (NEW_FIELDS.some(key => key in data)) throw new ContractError('MIXED_FIELDS', 'a v1 payload cannot carry v2 fields');
    data = upgradeV1(data);
    sourceVersion = 1;
  } else {
    if (data.contract_version !== CONTRACT_VERSION) throw new ContractError('UNSUPPORTED_VERSION', `unsupported contract_version: ${JSON.stringify(data.contract_version)}`);
    if (Object.keys(LEGACY_FIELDS).some(key => key in data)) throw new ContractError('MIXED_FIELDS', 'a v2 payload cannot carry v1 fields');
  }
  if (!ACCOUNT_TIERS.includes(data.account_tier)) throw new ContractError('INVALID', `account_tier must be one of ${ACCOUNT_TIERS.join(', ')}`);
  const currency = text(data, 'currency');
  if (!/^[A-Z]{3}$/.test(currency)) throw new ContractError('INVALID', 'currency must be a 3-letter code');
  return {
    orderId: text(data, 'order_id'),
    accountId: text(data, 'account_id'),
    accountTier: data.account_tier,
    currency,
    items: items(data.items),
    sourceVersion,
  };
}

// Order → wire payload (always v2, snake_case, same key order as the schema).
export function toWire(order) {
  return {
    contract_version: CONTRACT_VERSION,
    order_id: order.orderId,
    account_id: order.accountId,
    account_tier: order.accountTier,
    currency: order.currency,
    items: order.items.map(i => ({ sku: i.sku, qty: i.qty, unit_price: i.unitPrice })),
  };
}
