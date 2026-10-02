import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// Reads one public https page for the company session, from the runtime
// process (tools in the sandbox have no network). GET only, no cookies or
// credentials, public addresses only (checked per redirect and pinned for the
// connection so DNS cannot rebind to a private address), bounded size/time.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-yaml|yaml|ld\+json|rss\+xml|atom\+xml))/i;

function v4Private(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
export function privateAddress(address) {
  if (net.isIPv4(address)) return v4Private(address);
  if (!net.isIPv6(address)) return true;
  const value = address.toLowerCase();
  const mapped = value.match(/^(?:0*:)*:ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? value.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return value === '::' || value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value) || value.startsWith('2001:db8');
}

async function publicTarget(url, resolve) {
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('web-fetch-url-not-allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('web-fetch-private-address');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('web-fetch-private-address');
  return addresses[0];
}

export function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const body = html.replace(/<(script|style|noscript|svg|template|iframe|title)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n').replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|table|ul|ol)>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, level) => '\n' + '#'.repeat(Number(level)) + ' ').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' ');
  const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (entity, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)) || 32);
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[lower] ?? entity;
  });
  const text = decode(body).split('\n').map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title: decode(title).replace(/\s+/g, ' ').trim(), text };
}

// Connect only to the checked address. Node (autoSelectFamily, default since
// Node 20) asks for every address at once ({all: true}) and rejects a single
// address with "Invalid IP address", so answer in the shape requested.
export function pinnedLookup(target) {
  return (_host, options, callback) => options?.all
    ? callback(null, [{ address: target.address, family: target.family }])
    : callback(null, target.address, target.family);
}

function request(url, target, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', signal, servername: net.isIP(url.hostname) ? undefined : url.hostname,
      lookup: pinnedLookup(target),
      headers: { 'User-Agent': 'Piagent-company-web-fetch/1', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br' } }, resolve);
    req.once('error', reject); req.end();
  });
}

async function body(response) {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  const stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : encoding === 'deflate' ? response.pipe(zlib.createInflate())
    : encoding === 'br' ? response.pipe(zlib.createBrotliDecompress()) : response;
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES) { response.destroy(); throw new Error('web-fetch-too-large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// `requestForTest` replaces only the connection; address checks still apply.
export async function fetchPublicPage(input, { maxChars = 30_000, signal, resolve = (host) => dns.lookup(host, { all: true, verbatim: true }), requestForTest } = {}) {
  let url;
  try { url = new URL(String(input)); } catch { throw new Error('web-fetch-url-invalid'); }
  const limit = Math.max(1_000, Math.min(100_000, Number(maxChars) || 30_000));
  const timeout = AbortSignal.timeout(20_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; ; hop += 1) {
    const target = await publicTarget(url, resolve);
    const response = requestForTest ? await requestForTest(url) : await request(url, target, combined);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop >= MAX_REDIRECTS) throw new Error('web-fetch-too-many-redirects');
      url = new URL(response.headers.location, url); continue;
    }
    const type = String(response.headers['content-type'] ?? '');
    if (type && !TEXT.test(type)) { response.destroy(); return { url: url.href, status, text: `Unsupported content type: ${type.split(';')[0]}` }; }
    const raw = await body(response);
    const page = /html/i.test(type) || /^\s*<(!doctype html|html)/i.test(raw) ? htmlToText(raw) : { title: '', text: raw };
    const truncated = page.text.length > limit;
    return { url: url.href, status, title: page.title, text: truncated ? page.text.slice(0, limit) + `\n[Truncated at ${limit} characters.]` : page.text };
  }
}
