// Hidden acceptance checks for phase p3: the HTTP JSON API (node:http only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function start(day = '2026-03-10') {
  const inventory = new Inventory({ clock: () => day });
  const server = createServer({ inventory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, raw) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* checked by callers */ }
    return { status: res.status, json, type: res.headers.get('content-type') ?? '' };
  };
  return { inventory, server, call, stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const errorOf = (res, status, code) => { assert.equal(res.status, status, JSON.stringify(res.json)); assert.equal(res.json?.error?.code, code); assert.equal(typeof res.json.error.message, 'string'); };

test('p3.1 receive, reserve, stock, commit, release', async () => {
  const s = await start();
  try {
    let r = await s.call('POST', '/receive', { sku: 'A', qty: 5, lot: 'L1', expiresOn: '2026-04-01' });
    assert.equal(r.status, 201); assert.deepEqual(r.json, { ok: true }); assert.match(r.type, /application\/json/);
    r = await s.call('POST', '/receive', { sku: 'B x', qty: 2, lot: 'L1', warehouse: 'HN' });
    assert.equal(r.status, 201);
    r = await s.call('POST', '/orders/o1/reserve', { sku: 'A', qty: 2 });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    r = await s.call('GET', '/stock/A');
    assert.deepEqual(r.json, { sku: 'A', warehouse: null, onHand: 5, available: 3 });
    r = await s.call('GET', '/stock/B%20x?warehouse=HN');
    assert.deepEqual(r.json, { sku: 'B x', warehouse: 'HN', onHand: 2, available: 2 });
    r = await s.call('POST', '/orders/o1/commit');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { taken: [{ sku: 'A', lot: 'L1', qty: 2 }] });
    errorOf(await s.call('POST', '/orders/o1/commit'), 404, 'UNKNOWN_ORDER');
    r = await s.call('POST', '/orders/nobody/release');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    assert.equal(s.inventory.onHand('A'), 3);
  } finally { await s.stop(); }
});

test('p3.2 input validation and error mapping', async () => {
  const s = await start();
  try {
    await s.call('POST', '/receive', { sku: 'A', qty: 3, lot: 'L1', expiresOn: '2026-04-01' });
    await s.call('POST', '/receive', { sku: 'A', qty: 4, lot: 'OLD', expiresOn: '2026-03-01' });
    errorOf(await s.call('POST', '/receive', { sku: 'A', qty: '5', lot: 'L1' }), 400, 'INVALID_INPUT');
    errorOf(await s.call('POST', '/receive', { sku: 'A', qty: 5 }), 400, 'INVALID_INPUT');
    errorOf(await s.call('POST', '/receive', undefined, '{"sku": "A",'), 400, 'INVALID_JSON');
    errorOf(await s.call('POST', '/receive', undefined, '[1,2]'), 400, 'INVALID_INPUT');
    errorOf(await s.call('GET', '/receive'), 405, 'METHOD_NOT_ALLOWED');
    errorOf(await s.call('DELETE', '/reports/stock'), 405, 'METHOD_NOT_ALLOWED');
    errorOf(await s.call('GET', '/nope'), 404, 'NOT_FOUND');
    errorOf(await s.call('POST', '/orders/o2/reserve', { sku: 'A', qty: 99 }), 409, 'INSUFFICIENT_STOCK');
    errorOf(await s.call('POST', '/orders/o2/reserve', { sku: 'A', qty: -1 }), 400, 'INVALID_INPUT');
    errorOf(await s.call('POST', '/transfers', { id: 't0', sku: 'A', qty: 1, from: 'MAIN', to: 'HUY', lot: 'OLD' }), 422, 'EXPIRED_LOT');
    errorOf(await s.call('POST', '/transfers/zz/complete'), 404, 'UNKNOWN_TRANSFER');
    errorOf(await s.call('POST', '/transfers/zz/cancel'), 404, 'UNKNOWN_TRANSFER');
    errorOf(await s.call('GET', '/reports/low-stock?threshold=abc'), 400, 'INVALID_INPUT');
    errorOf(await s.call('GET', '/reports/low-stock'), 400, 'INVALID_INPUT');
    errorOf(await s.call('GET', '/reports/expiring?days=x'), 400, 'INVALID_INPUT');
    assert.equal(s.inventory.onHand('A'), 7);
  } finally { await s.stop(); }
});

test('p3.3 transfers and reports', async () => {
  const s = await start();
  try {
    await s.call('POST', '/receive', { sku: 'A', qty: 5, lot: 'L1', expiresOn: '2026-03-15' });
    await s.call('POST', '/receive', { sku: 'B', qty: 1, lot: 'L1', expiresOn: null, warehouse: 'HN' });
    let r = await s.call('POST', '/transfers', { id: 't1', sku: 'A', qty: 2, from: 'MAIN', to: 'HN' });
    assert.equal(r.status, 201); assert.deepEqual(r.json, { ok: true });
    r = await s.call('POST', '/transfers/t1/complete');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { moved: [{ sku: 'A', lot: 'L1', qty: 2, expiresOn: '2026-03-15' }] });
    r = await s.call('POST', '/transfers', { id: 't2', sku: 'A', qty: 1, from: 'MAIN', to: 'DN' });
    r = await s.call('POST', '/transfers/t2/cancel');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    r = await s.call('GET', '/reports/low-stock?threshold=2');
    assert.equal(r.status, 200); assert.deepEqual(r.json, [{ sku: 'B', available: 1 }]);
    r = await s.call('GET', '/reports/expiring?days=10');
    assert.deepEqual(r.json, [{ sku: 'A', lot: 'L1', qty: 5, expiresOn: '2026-03-15' }]);
    r = await s.call('GET', '/reports/stock');
    assert.deepEqual([...r.json].sort((a, b) => `${a.warehouse}${a.sku}`.localeCompare(`${b.warehouse}${b.sku}`)), [
      { warehouse: 'HN', sku: 'A', onHand: 2, reserved: 0, available: 2 },
      { warehouse: 'HN', sku: 'B', onHand: 1, reserved: 0, available: 1 },
      { warehouse: 'MAIN', sku: 'A', onHand: 3, reserved: 0, available: 3 },
    ]);
    r = await s.call('GET', '/reports/stock?warehouse=MAIN');
    assert.deepEqual(r.json, [{ warehouse: 'MAIN', sku: 'A', onHand: 3, reserved: 0, available: 3 }]);
  } finally { await s.stop(); }
});

test('p3.4 a body over 1 MB gets 413 PAYLOAD_TOO_LARGE as JSON', async () => {
  const s = await start();
  try {
    const big = JSON.stringify({ sku: 'A', qty: 1, lot: 'L', note: 'x'.repeat(1_200_000) });
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.server.address().port, path: '/receive', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) } }, res => {
        let text = ''; res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject);
      req.end(big);
    });
    assert.equal(status, 413);
    assert.equal(JSON.parse(body).error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(s.inventory.onHand('A'), 0);
  } finally { await s.stop(); }
});

test('p3.5 bin/server.js prints its port and exits cleanly on SIGTERM', async () => {
  const child = spawn(process.execPath, ['bin/server.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', KHO_TODAY: '2026-03-10' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no "listening on <port>" line: ${out}`)), 5000);
      child.stdout.on('data', d => { out += d; const m = out.match(/listening on (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.on('exit', code => reject(new Error(`exited early with ${code}: ${out}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'A', qty: 1, lot: 'L', expiresOn: null }) });
    assert.equal(res.status, 201); await res.text();
    const stock = await (await fetch(`http://127.0.0.1:${port}/stock/A`)).json();
    assert.equal(stock.onHand, 1);
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const result = await Promise.race([exited, new Promise(r => setTimeout(() => r({ timeout: true }), 4000))]);
    assert.deepEqual(result, { code: 0, signal: null }, 'SIGTERM must close the server and exit 0 promptly');
    assert.ok(Date.now() - t0 < 4000);
  } finally { child.kill('SIGKILL'); }
});

test('p3.6 the project has its own HTTP tests', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['createServer', '/reports/', '/transfers', 'listen(']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
