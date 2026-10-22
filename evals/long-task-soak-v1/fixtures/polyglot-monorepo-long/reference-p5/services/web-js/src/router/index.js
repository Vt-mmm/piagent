// storefront-admin router: route(request) -> response, no I/O.
// request = { method, url, headers, body }; response = { status, headers, body }.
// Split out of the legacy router-old.js with identical behaviour (quirks included,
// see docs/specs/5-router-refactor.md).
import { LEGACY_VERSION } from './data.js';
import { LegacyError, respond } from './http.js';
import { pickLang } from './messages.js';
import { safeDecode } from './util/text.js';
import { parseUrl, readBody } from './util/url.js';
import { handleCatalog, handleCategories, handleHealth, handleProduct, handleRelated, handleSuggest } from './handlers/catalog.js';
import { handleCartPreview, handlePromoValidate } from './handlers/cart.js';
import { handleProvinces, handleShippingQuote } from './handlers/shipping.js';
import { handleAccountNote } from './handlers/accounts.js';
import { handleCalendar, handleSalesReport, handleStockAlerts, handleTopProducts } from './handlers/reports.js';

// First match wins: product_related must stay before product.
const ROUTES = [
  { name: 'health', pattern: /^\/health$/, methods: ['GET', 'HEAD'], handle: () => handleHealth() },
  { name: 'catalog', pattern: /^\/v1\/catalog$/, methods: ['GET'], handle: (p, q, b, lang) => handleCatalog(q, lang) },
  { name: 'categories', pattern: /^\/v1\/categories$/, methods: ['GET'], handle: (p, q, b, lang) => handleCategories(lang) },
  { name: 'product_related', pattern: /^\/v1\/catalog\/([A-Z0-9-]+)\/related$/, methods: ['GET'], handle: (p, q, b, lang) => handleRelated(p[0], q, lang) },
  { name: 'product', pattern: /^\/v1\/catalog\/([A-Za-z0-9-]+)$/, methods: ['GET'], handle: (p, q, b, lang) => handleProduct(p[0].toUpperCase(), q, lang) },
  { name: 'cart_preview', pattern: /^\/v1\/cart\/preview$/, methods: ['POST'], handle: (p, q, b, lang) => handleCartPreview(b, lang) },
  { name: 'shipping_quote', pattern: /^\/v1\/shipping\/quote$/, methods: ['GET'], handle: (p, q) => handleShippingQuote(q) },
  { name: 'provinces', pattern: /^\/v1\/shipping\/provinces$/, methods: ['GET'], handle: (p, q) => handleProvinces(q) },
  { name: 'promo_validate', pattern: /^\/v1\/promo\/validate$/, methods: ['POST'], handle: (p, q, b) => handlePromoValidate(b) },
  { name: 'suggest', pattern: /^\/v1\/search\/suggest$/, methods: ['GET'], handle: (p, q) => handleSuggest(q) },
  { name: 'account_note', pattern: /^\/v1\/accounts\/([^/]+)\/notes$/, methods: ['POST'], handle: (p, q, b) => handleAccountNote(safeDecode(p[0]), b) },
  { name: 'sales_report', pattern: /^\/v1\/reports\/sales$/, methods: ['GET'], handle: (p, q) => handleSalesReport(q) },
  { name: 'top_products', pattern: /^\/v1\/reports\/top-products$/, methods: ['GET'], handle: (p, q, b, lang) => handleTopProducts(q, lang) },
  { name: 'stock_alerts', pattern: /^\/v1\/reports\/stock-alerts$/, methods: ['GET'], handle: (p, q) => handleStockAlerts(q) },
  { name: 'calendar', pattern: /^\/v1\/reports\/calendar$/, methods: ['GET'], handle: (p, q) => handleCalendar(q) },
];

function run(r, params, method, parsed, request, lang) {
  try {
    const response = r.handle(params, parsed.query, readBody(request.body), lang);
    response.headers['x-legacy-route'] = r.name;
    if (method === 'HEAD') response.body = null;
    return response;
  } catch (e) {
    if (!(e instanceof LegacyError)) throw e;
    const response = respond(e.status, e.toBody(lang));
    response.headers['x-legacy-route'] = r.name;
    return response;
  }
}

/** @param {{method?: string, url?: string, headers?: object, body?: any}} request */
export function route(request) {
  request = request || {};
  const method = String(request.method || 'GET').toUpperCase();
  const parsed = parseUrl(request.url);
  const lang = pickLang(request.headers);
  let allowed = [];
  for (const r of ROUTES) {
    const m = r.pattern.exec(parsed.pathname);
    if (!m) continue;
    if (r.methods.indexOf(method) < 0) {
      allowed = allowed.concat(r.methods);
      continue;
    }
    return run(r, m.slice(1), method, parsed, request, lang);
  }
  if (allowed.length > 0) {
    return respond(405, new LegacyError(405, 'method_not_allowed', [method, parsed.pathname]).toBody(lang), { allow: allowed.join(', ') });
  }
  return respond(404, new LegacyError(404, 'not_found', [parsed.pathname]).toBody(lang));
}

export { LEGACY_VERSION };
export default route;
