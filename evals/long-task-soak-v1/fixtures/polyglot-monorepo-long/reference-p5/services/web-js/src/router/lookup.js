// Lookups over the tables, plus sorting and paging helpers.
import { CATEGORIES, PRODUCTS, PROMOS, PROVINCES, TAX_RATES } from './data.js';
import { hasOwn } from './util/text.js';

const PRODUCT_INDEX = new Map(PRODUCTS.map(p => [p.sku, p]));

export const productBySku = sku => PRODUCT_INDEX.get(sku) ?? null;
export const provinceByCode = code => PROVINCES.find(p => p.code === code) ?? null;
// Case-insensitive, not trimmed (legacy quirk).
export const promoByCode = code => PROMOS.find(p => p.code === String(code).toUpperCase()) ?? null;
export const categoryExists = name => CATEGORIES.some(c => c.id === name);
export const taxRate = category => (hasOwn(TAX_RATES, category) ? TAX_RATES[category] : 10);

// Plain < / > comparison (so names sort case-sensitively), ties broken by sku.
export function compareBy(field, direction) {
  const sign = direction === 'desc' ? -1 : 1;
  return (a, b) => {
    if (a[field] < b[field]) return -1 * sign;
    if (a[field] > b[field]) return 1 * sign;
    if (a.sku < b.sku) return -1;
    if (a.sku > b.sku) return 1;
    return 0;
  };
}

export function paginate(list, page, perPage) {
  const total = list.length;
  const start = (page - 1) * perPage;
  return { items: list.slice(start, start + perPage), page, per_page: perPage, total, pages: total === 0 ? 0 : Math.ceil(total / perPage) };
}
