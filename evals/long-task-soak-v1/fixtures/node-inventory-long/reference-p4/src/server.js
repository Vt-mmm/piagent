// HTTP JSON API over an Inventory (node:http only).
import http from 'node:http';
import { InventoryError } from './index.js';

const STATUS = { IDEMPOTENCY_KEY_REUSED: 422, INVALID_INPUT: 400, INVALID_JSON: 400, UNKNOWN_ORDER: 404, UNKNOWN_TRANSFER: 404, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, INSUFFICIENT_STOCK: 409, EXPIRED_LOT: 422, PAYLOAD_TOO_LARGE: 413 };
const LIMIT = 1024 * 1024;

class HttpError extends Error { constructor(code, message) { super(message); this.code = code; } }
const bad = message => { throw new HttpError('INVALID_INPUT', message); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const intParam = (value, name) => { if (value == null || !/^-?\d+$/.test(value)) bad(`${name} must be an integer`); return Number(value); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, tooLarge = false;
    req.on('data', chunk => { size += chunk.length; if (size > LIMIT) tooLarge = true; else chunks.push(chunk); });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError('PAYLOAD_TOO_LARGE', 'body over 1 MB'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let body;
      try { body = JSON.parse(text); } catch { return reject(new HttpError('INVALID_JSON', 'body is not JSON')); }
      if (!isObject(body)) return reject(new HttpError('INVALID_INPUT', 'body must be a JSON object'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

// [method, pattern, handler(inventory, params, body, query)] → [status, body]
const ROUTES = [
  ['POST', /^\/receive$/, (inv, p, b) => { inv.receive(b.sku, b.qty, { lot: b.lot, expiresOn: b.expiresOn ?? null, warehouse: b.warehouse ?? 'MAIN' }); return [201, { ok: true }]; }],
  ['POST', /^\/orders\/([^/]+)\/reserve$/, (inv, [id], b) => { inv.reserve(id, b.sku, b.qty, { warehouse: b.warehouse ?? 'MAIN' }); return [200, { ok: true }]; }],
  ['POST', /^\/orders\/([^/]+)\/release$/, (inv, [id]) => { inv.release(id); return [200, { ok: true }]; }],
  ['POST', /^\/orders\/([^/]+)\/commit$/, (inv, [id]) => [200, { taken: inv.commit(id) }]],
  ['POST', /^\/transfers$/, (inv, p, b) => { inv.transfer(b.id, b.sku, b.qty, { from: b.from, to: b.to, lot: b.lot ?? null }); return [201, { ok: true }]; }],
  ['POST', /^\/transfers\/([^/]+)\/complete$/, (inv, [id]) => [200, { moved: inv.completeTransfer(id) }]],
  ['POST', /^\/transfers\/([^/]+)\/cancel$/, (inv, [id]) => { inv.cancelTransfer(id); return [200, { ok: true }]; }],
  ['GET', /^\/stock\/([^/]+)$/, (inv, [sku], b, q) => {
    const warehouse = q.get('warehouse');
    return [200, { sku, warehouse: warehouse ?? null, onHand: inv.onHand(sku, warehouse ?? undefined), available: inv.available(sku, warehouse ?? undefined) }];
  }],
  ['GET', /^\/reports\/low-stock$/, (inv, p, b, q) => [200, inv.lowStock(intParam(q.get('threshold'), 'threshold'), { warehouse: q.get('warehouse') ?? undefined })]],
  ['GET', /^\/reports\/expiring$/, (inv, p, b, q) => [200, inv.expiringWithin(intParam(q.get('days'), 'days'), { warehouse: q.get('warehouse') ?? undefined })]],
  ['GET', /^\/reports\/stock$/, (inv, p, b, q) => [200, inv.stockReport({ warehouse: q.get('warehouse') ?? undefined })]],
];

// Same JSON whatever the key order or spacing.
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);

// idempotency: { get(key), set(key, { fingerprint, status, body }) }; in memory by default.
export function createServer({ inventory, idempotency = new Map() }) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
      res.end(text);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const matches = ROUTES.filter(([, re]) => re.test(url.pathname));
      if (!matches.length) throw new HttpError('NOT_FOUND', `no route ${url.pathname}`);
      const route = matches.find(([method]) => method === req.method);
      if (!route) { req.resume(); throw new HttpError('METHOD_NOT_ALLOWED', `${req.method} not allowed on ${url.pathname}`); }
      const params = url.pathname.match(route[1]).slice(1).map(decodeURIComponent);
      const body = req.method === 'POST' ? await readBody(req) : {};
      const key = req.method === 'POST' ? req.headers['idempotency-key'] : undefined;
      if (key) {
        const fingerprint = `${req.method} ${url.pathname} ${stable(body)}`, seen = idempotency.get(key);
        if (seen && seen.fingerprint !== fingerprint) throw new HttpError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key already used for another request');
        if (seen) return send(seen.status, seen.body, { 'idempotent-replayed': 'true' });
        const [status, payload] = route[2](inventory, params, body, url.searchParams);
        if (status >= 200 && status < 300) idempotency.set(key, { fingerprint, status, body: payload });
        return send(status, payload);
      }
      const [status, payload] = route[2](inventory, params, body, url.searchParams);
      send(status, payload);
    } catch (error) {
      if (error instanceof InventoryError || error instanceof HttpError) send(STATUS[error.code] ?? 400, { error: { code: error.code, message: error.message } });
      else send(500, { error: { code: 'INTERNAL', message: 'internal error' } });
    }
  });
  return server;
}
