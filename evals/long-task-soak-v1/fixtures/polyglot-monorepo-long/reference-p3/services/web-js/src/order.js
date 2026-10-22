import { ContractError } from './errors.js';
import { ACCOUNT_TIERS } from './account.js';
import { LEGACY_FIELDS, isV1, upgradeV1 } from './compat-v1.js';

export const CONTRACT_VERSION = 2; // what toWire writes when no conversion is needed
export const LATEST_VERSION = 3;
export const PPM = 1_000_000;
export const MAX_FX_RATE_PPM = 1_000_000_000;
const NEW_FIELDS = Object.values(LEGACY_FIELDS);
const SETTLEMENT_FIELDS = ['settlement_currency', 'fx_rate_ppm'];

const isInt = v => Number.isInteger(v);
function text(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value) throw new ContractError('INVALID', `${key} must be a non-empty string`);
  return value;
}
function currencyCode(data, key) {
  const value = text(data, key);
  if (!/^[A-Z]{3}$/.test(value)) throw new ContractError('INVALID', `${key} must be a 3-letter code`);
  return value;
}
function items(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContractError('INVALID', 'items must be a non-empty list');
  return raw.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ContractError('INVALID', `items[${i}] must be an object`);
    const sku = text(row, 'sku');
    if (!isInt(row.qty) || row.qty < 1) throw new ContractError('INVALID', `items[${i}].qty must be a positive integer`);
    if (!isInt(row.unit_price) || row.unit_price < 0) throw new ContractError('INVALID', `items[${i}].unit_price must be a non-negative integer`);
    return { sku, qty: row.qty, unitPrice: row.unit_price };
  });
}
function settlement(data, currency) {
  const settlementCurrency = currencyCode(data, 'settlement_currency');
  const rate = data.fx_rate_ppm;
  if (!isInt(rate) || rate < 1 || rate > MAX_FX_RATE_PPM) throw new ContractError('INVALID', `fx_rate_ppm must be an integer from 1 to ${MAX_FX_RATE_PPM}`);
  if (settlementCurrency === currency && rate !== PPM) throw new ContractError('INVALID', `fx_rate_ppm must be ${PPM} when settlement_currency equals currency`);
  return { settlementCurrency, fxRatePpm: rate };
}

// Wire payload (v3, v2, or legacy v1) →
// { orderId, accountId, accountTier, currency, items, sourceVersion, settlementCurrency, fxRatePpm }.
export function parseOrder(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ContractError('INVALID', 'order must be an object');
  let sourceVersion;
  if (isV1(data)) {
    if ([...NEW_FIELDS, ...SETTLEMENT_FIELDS].some(key => key in data)) throw new ContractError('MIXED_FIELDS', 'a v1 payload cannot carry v2/v3 fields');
    data = upgradeV1(data);
    sourceVersion = 1;
  } else {
    sourceVersion = data.contract_version;
    if (sourceVersion !== 2 && sourceVersion !== 3) throw new ContractError('UNSUPPORTED_VERSION', `unsupported contract_version: ${JSON.stringify(sourceVersion)}`);
    if (Object.keys(LEGACY_FIELDS).some(key => key in data)) throw new ContractError('MIXED_FIELDS', `a v${sourceVersion} payload cannot carry v1 fields`);
    if (sourceVersion === 2 && SETTLEMENT_FIELDS.some(key => key in data)) throw new ContractError('MIXED_FIELDS', 'a v2 payload cannot carry v3 fields');
  }
  if (!ACCOUNT_TIERS.includes(data.account_tier)) throw new ContractError('INVALID', `account_tier must be one of ${ACCOUNT_TIERS.join(', ')}`);
  const currency = currencyCode(data, 'currency');
  const order = {
    orderId: text(data, 'order_id'),
    accountId: text(data, 'account_id'),
    accountTier: data.account_tier,
    currency,
    items: items(data.items),
    sourceVersion,
  };
  return { ...order, ...(sourceVersion === 3 ? settlement(data, currency) : { settlementCurrency: currency, fxRatePpm: PPM }) };
}

const converts = order => (order.settlementCurrency ?? order.currency) !== order.currency || (order.fxRatePpm ?? PPM) !== PPM;

// Order → wire payload: v2 when nothing converts, else v3; snake_case, schema key order.
export function toWire(order) {
  const wire = {
    contract_version: converts(order) ? LATEST_VERSION : CONTRACT_VERSION,
    order_id: order.orderId,
    account_id: order.accountId,
    account_tier: order.accountTier,
    currency: order.currency,
  };
  if (converts(order)) {
    wire.settlement_currency = order.settlementCurrency;
    wire.fx_rate_ppm = order.fxRatePpm;
  }
  wire.items = order.items.map(i => ({ sku: i.sku, qty: i.qty, unit_price: i.unitPrice }));
  return wire;
}
