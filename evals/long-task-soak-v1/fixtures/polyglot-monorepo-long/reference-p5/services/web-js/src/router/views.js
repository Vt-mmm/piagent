import { formatMoney, vndToCurrency } from './util/money.js';
import { slugify } from './util/text.js';
import { taxRate } from './lookup.js';

export const localName = (p, lang) => (lang === 'en' && p.name_en ? p.name_en : p.name);

export function productView(p, lang, currency) {
  const price = vndToCurrency(p.price, currency);
  return {
    sku: p.sku,
    name: localName(p, lang),
    slug: slugify(p.name),
    category: p.category,
    price,
    price_display: formatMoney(price, currency),
    currency,
    in_stock: p.active && p.stock > 0,
    tags: p.tags.slice(0),
  };
}

export function productDetailView(p, lang, currency) {
  const view = productView(p, lang, currency);
  const rate = taxRate(p.category);
  const taxVnd = Math.round((p.price * rate) / 100);
  view.stock = p.stock;
  view.active = p.active;
  view.weight_grams = p.weight;
  view.tax_rate = rate;
  view.tax = vndToCurrency(taxVnd, currency);
  view.price_with_tax = vndToCurrency(p.price + taxVnd, currency);
  view.price_with_tax_display = formatMoney(view.price_with_tax, currency);
  return view;
}
