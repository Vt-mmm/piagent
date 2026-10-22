// Shipping fees by province, weight and subtotal.
import { FREE_SHIPPING_THRESHOLD_VND, PROVINCES, REMOTE_SURCHARGE_VND, WEIGHT_STEP_GRAMS, ZONES } from '../data.js';
import { fail, respond } from '../http.js';
import { provinceByCode } from '../lookup.js';
import { formatMoney, readCurrency, vndToCurrency } from '../util/money.js';
import { slugify } from '../util/text.js';

// subtotalVnd null: no free-shipping check (plain quote).
export function shippingFor(provinceCode, weightGrams, subtotalVnd) {
  const province = provinceByCode(provinceCode);
  if (!province) fail(400, 'bad_province', provinceCode);
  const zone = ZONES[province.zone];
  const weight = weightGrams || WEIGHT_STEP_GRAMS; // quirk: 0 is billed as 500 g
  let fee = zone.base + (Math.ceil(weight / WEIGHT_STEP_GRAMS) - 1) * zone.step;
  if (province.remote) fee += REMOTE_SURCHARGE_VND;
  const free = subtotalVnd !== null && subtotalVnd >= FREE_SHIPPING_THRESHOLD_VND && !province.remote;
  return {
    province: province.code,
    province_name: province.name,
    zone: province.zone,
    remote: province.remote,
    weight_grams: weight,
    fee: free ? 0 : fee,
    days: zone.days + (province.remote ? 2 : 0),
    free_shipping: free,
  };
}

export function handleShippingQuote(query) {
  const code = query.province;
  if (!code) fail(400, 'bad_province', '');
  let weight = 0;
  if (query.weight !== undefined && query.weight !== '') {
    weight = Number(query.weight);
    if (isNaN(weight) || weight < 0 || weight > 30000) fail(400, 'bad_weight', query.weight);
  }
  const currency = readCurrency(query.currency);
  const quote = shippingFor(String(code).toUpperCase(), weight, null);
  quote.fee = vndToCurrency(quote.fee, currency);
  quote.fee_display = formatMoney(quote.fee, currency);
  quote.currency = currency;
  return respond(200, quote);
}

export function handleProvinces(query) {
  const zone = query.zone ? String(query.zone).toUpperCase() : '';
  const provinces = PROVINCES.filter(p => (!zone || p.zone === zone) && (query.remote !== '1' || p.remote))
    .map(p => ({ code: p.code, name: p.name, slug: slugify(p.name), zone: p.zone, remote: p.remote }));
  if (query.sort === 'name') provinces.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return respond(200, { total: provinces.length, provinces });
}
