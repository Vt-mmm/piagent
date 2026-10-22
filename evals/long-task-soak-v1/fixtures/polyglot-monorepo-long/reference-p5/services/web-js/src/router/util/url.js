import { safeDecode } from './text.js';

/**
 * "/v1/catalog?page=2&q=tra+xanh" -> { pathname: '/v1/catalog', query: { page: '2', q: 'tra xanh' } }
 * Repeated keys: the last one wins. A key without "=" is "". One trailing slash is dropped.
 */
export function parseUrl(url) {
  let text = String(url || '/');
  const hashAt = text.indexOf('#');
  if (hashAt >= 0) text = text.substring(0, hashAt);
  const qAt = text.indexOf('?');
  let pathname = qAt >= 0 ? text.substring(0, qAt) : text;
  const search = qAt >= 0 ? text.substring(qAt + 1) : '';
  const query = {};
  for (const pair of search.length > 0 ? search.split('&') : []) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.substring(0, eq);
    const value = eq < 0 ? '' : pair.substring(eq + 1);
    query[safeDecode(key.replace(/\+/g, ' '))] = safeDecode(value.replace(/\+/g, ' '));
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.substring(0, pathname.length - 1);
  return { pathname, query };
}

// parseInt semantics on purpose: "2abc" is 2.
export function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

export const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

// A string body is JSON (unparseable → null, empty → undefined); objects are copied.
export function readBody(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw.length === 0) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return JSON.parse(JSON.stringify(raw));
}
