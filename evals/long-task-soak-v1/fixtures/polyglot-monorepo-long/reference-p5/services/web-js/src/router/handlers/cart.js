// Promo codes and the cart preview.
import { FREE_SHIPPING_THRESHOLD_USD, MAX_CART_LINES, MAX_QTY_PER_LINE } from '../data.js';
import { fail, LegacyError, respond } from '../http.js';
import { msg } from '../messages.js';
import { productBySku, promoByCode, taxRate } from '../lookup.js';
import { formatMoney, readCurrency, vndToCurrency } from '../util/money.js';
import { localName } from '../views.js';
import { shippingFor } from './shipping.js';

const isObject = body => body && typeof body === 'object' && !Array.isArray(body);

/** A promo on a VND subtotal; categories: those present in the cart. */
export function applyPromo(rawCode, subtotalVnd, categories) {
  const promo = promoByCode(rawCode);
  if (!promo) fail(422, 'promo_unknown');
  if (promo.expired) fail(422, 'promo_expired');
  if (subtotalVnd < promo.min_subtotal) fail(422, 'promo_min', formatMoney(promo.min_subtotal, 'VND'));
  if (promo.category && categories.indexOf(promo.category) < 0) fail(422, 'promo_category', promo.category);
  let discount = 0;
  let freeShipping = false;
  if (promo.kind === 'percent') {
    discount = Math.floor((subtotalVnd * promo.value) / 100);
    if (promo.max_discount && discount > promo.max_discount) discount = promo.max_discount;
  } else if (promo.kind === 'fixed') {
    discount = Math.min(promo.value, subtotalVnd);
  } else if (promo.kind === 'freeship') {
    freeShipping = true;
  }
  return { code: promo.code, kind: promo.kind, discount, free_shipping: freeShipping };
}

export function handlePromoValidate(body) {
  if (!isObject(body)) fail(400, 'bad_body');
  let subtotal = Number(body.subtotal);
  if (isNaN(subtotal) || subtotal < 0) subtotal = 0;
  const categories = [];
  if (body.category) categories.push(String(body.category));
  if (Array.isArray(body.categories)) categories.push(...body.categories.map(String));
  const result = applyPromo(body.code === undefined ? '' : body.code, subtotal, categories);
  result.valid = true;
  result.discount_display = formatMoney(result.discount, 'VND');
  return respond(200, result);
}

function readLines(lines) {
  const merged = new Map();
  lines.forEach((raw, i) => {
    const line = raw || {};
    let qty = line.qty;
    if (typeof qty === 'string') qty = parseInt(qty, 10);
    if (qty === 0 || typeof qty !== 'number' || isNaN(qty) || qty < 0 || Math.floor(qty) !== qty || qty > MAX_QTY_PER_LINE) fail(400, 'bad_qty', i + 1);
    const p = productBySku(line.sku);
    if (!p) fail(404, 'product_not_found', line.sku);
    if (!p.active) fail(409, 'inactive_product', p.sku);
    merged.set(p.sku, (merged.get(p.sku) ?? 0) + qty);
  });
  return merged;
}

export function handleCartPreview(body, lang) {
  if (!isObject(body)) fail(400, 'bad_body');
  const lines = body.items;
  if (!Array.isArray(lines) || lines.length === 0) fail(400, 'empty_cart');
  if (lines.length > MAX_CART_LINES) fail(400, 'too_many_lines', MAX_CART_LINES);
  const currency = readCurrency(body.currency);
  const outLines = [];
  const categories = [];
  let subtotal = 0;
  let tax = 0;
  let weight = 0;
  for (const [sku, count] of readLines(lines)) {
    const product = productBySku(sku);
    if (count > product.stock) fail(409, 'out_of_stock', product.sku, product.stock);
    const lineTotal = product.price * count;
    const lineTax = Math.round((lineTotal * taxRate(product.category)) / 100);
    subtotal += lineTotal;
    tax += lineTax;
    weight += product.weight * count;
    if (categories.indexOf(product.category) < 0) categories.push(product.category);
    outLines.push({
      sku: product.sku,
      name: localName(product, lang),
      qty: count,
      unit_price: vndToCurrency(product.price, currency),
      line_total: vndToCurrency(lineTotal, currency),
      tax: vndToCurrency(lineTax, currency),
    });
  }
  let promo = null;
  let discount = 0;
  let promoError = null;
  if (body.promo !== undefined && body.promo !== null && body.promo !== '') {
    try {
      promo = applyPromo(body.promo, subtotal, categories);
      discount = promo.discount;
    } catch (e) {
      if (!(e instanceof LegacyError)) throw e;
      promoError = { code: e.key.toUpperCase(), message: msg(lang, e.key, e.args) };
    }
  }
  let shipping = null;
  if (body.province) {
    shipping = shippingFor(String(body.province).toUpperCase(), weight, subtotal - discount);
    if (promo && promo.free_shipping && !shipping.remote) {
      shipping.fee = 0;
      shipping.free_shipping = true;
    }
  }
  const shippingFee = shipping ? shipping.fee : 0;
  const total = vndToCurrency(subtotal - discount + tax + shippingFee, currency);
  const result = {
    currency,
    lines: outLines,
    weight_grams: weight,
    subtotal: vndToCurrency(subtotal, currency),
    discount: vndToCurrency(discount, currency),
    tax: vndToCurrency(tax, currency),
    shipping: shipping ? vndToCurrency(shippingFee, currency) : null,
    total,
    total_display: formatMoney(total, currency),
    promo: promo ? promo.code : null,
  };
  if (promoError) result.promo_error = promoError;
  if (shipping) {
    result.delivery_days = shipping.days;
    result.zone = shipping.zone;
  }
  if (currency === 'USD' && vndToCurrency(subtotal, currency) >= FREE_SHIPPING_THRESHOLD_USD * 100) result.note = 'large_order';
  return respond(200, result);
}

