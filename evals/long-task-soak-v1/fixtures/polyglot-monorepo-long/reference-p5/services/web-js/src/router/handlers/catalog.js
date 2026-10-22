// Catalogue: health, product list/detail/related, categories, search suggestions.
import { CATEGORIES, DEFAULT_PER_PAGE, LEGACY_VERSION, MAX_PER_PAGE, PRODUCTS, PROVINCES } from '../data.js';
import { fail, respond } from '../http.js';
import { categoryExists, compareBy, paginate, productBySku, taxRate } from '../lookup.js';
import { readCurrency } from '../util/money.js';
import { slugify } from '../util/text.js';
import { clamp, toInt } from '../util/url.js';
import { productDetailView, productView } from '../views.js';

export function handleHealth() {
  return respond(200, { ok: true, version: LEGACY_VERSION, products: PRODUCTS.length, provinces: PROVINCES.length });
}

const SORTS = { sku: ['sku', 'asc'], name: ['name', 'asc'], price: ['price', 'asc'], '-price': ['price', 'desc'], stock: ['stock', 'desc'] };

export function handleCatalog(query, lang) {
  const page = toInt(query.page, 1);
  if (page < 1) fail(400, 'bad_page');
  let perPage = toInt(query.per_page, DEFAULT_PER_PAGE);
  if (!perPage) perPage = DEFAULT_PER_PAGE; // quirk: per_page=0 is the default
  perPage = clamp(perPage, 1, MAX_PER_PAGE);
  const currency = readCurrency(query.currency);
  const category = query.category;
  if (category && !categoryExists(category)) fail(400, 'bad_category', category);
  const sort = query.sort || 'sku';
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) fail(400, 'bad_sort', sort);
  const needle = query.q ? slugify(query.q) : '';
  const includeInactive = query.include_inactive === '1' || query.include_inactive === 'true';
  const list = PRODUCTS.filter(p => {
    if (!includeInactive && !p.active) return false;
    if (category && p.category !== category) return false;
    if (needle && slugify(p.name).indexOf(needle) < 0 && p.sku.toLowerCase().indexOf(needle) < 0) return false;
    if (query.tag && p.tags.indexOf(query.tag) < 0) return false;
    return true;
  });
  list.sort(compareBy(...SORTS[sort]));
  const result = paginate(list, page, perPage);
  result.items = result.items.map(p => productView(p, lang, currency));
  result.sort = sort;
  return respond(200, result);
}

export function handleProduct(sku, query, lang) {
  const p = productBySku(sku);
  if (!p) fail(404, 'product_not_found', sku);
  return respond(200, productDetailView(p, lang, readCurrency(query.currency)));
}

export function handleRelated(sku, query, lang) {
  const p = productBySku(sku);
  if (!p) fail(404, 'product_not_found', sku);
  const currency = readCurrency(query.currency);
  const limit = clamp(toInt(query.limit, 5), 1, 20);
  const scored = [];
  for (const other of PRODUCTS) {
    if (other.sku === p.sku || !other.active) continue;
    let shared = other.tags.filter(tag => p.tags.indexOf(tag) >= 0).length;
    if (other.category === p.category) shared += 0.5;
    if (shared > 0) scored.push({ score: shared, product: other });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.product.sku < b.product.sku ? -1 : 1));
  const items = scored.slice(0, limit).map(({ score, product }) => ({ ...productView(product, lang, currency), score }));
  return respond(200, { sku: p.sku, items });
}

export function handleCategories(lang) {
  const counts = {};
  for (const p of PRODUCTS) {
    const c = (counts[p.category] ??= { active: 0, inactive: 0, stock: 0 });
    if (p.active) c.active++;
    else c.inactive++;
    c.stock += p.stock;
  }
  const categories = CATEGORIES.map(c => {
    const n = counts[c.id] || { active: 0, inactive: 0, stock: 0 };
    return { id: c.id, name: lang === 'en' ? c.name_en : c.name, tax_rate: taxRate(c.id), active: n.active, inactive: n.inactive, stock: n.stock };
  });
  return respond(200, { categories });
}

export function handleSuggest(query) {
  const q = query.q ? slugify(query.q) : '';
  if (q.length < 2) fail(400, 'query_too_short');
  const limit = clamp(toInt(query.limit, 8), 1, 20);
  const prefix = [];
  const inner = [];
  for (const p of PRODUCTS) {
    if (!p.active) continue;
    const slug = slugify(p.name);
    const at = slug.indexOf(q);
    if (at === 0) prefix.push({ sku: p.sku, name: p.name, slug });
    else if (at > 0) inner.push({ sku: p.sku, name: p.name, slug });
  }
  const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  prefix.sort(bySlug);
  inner.sort(bySlug);
  return respond(200, { q, suggestions: prefix.concat(inner).slice(0, limit) });
}
