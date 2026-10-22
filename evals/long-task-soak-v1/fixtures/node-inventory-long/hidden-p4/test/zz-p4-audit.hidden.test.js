// Hidden acceptance checks for phase p4: append-only audit log, replay from
// events, idempotency keys on API writes (also across a server restart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inventory, InventoryError } from '../src/index.js';
import { createServer } from '../src/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = day => ({ clock: () => day });
const code = c => err => err instanceof InventoryError && err.code === c;

function history() {
  const seen = [];
  const inv = new Inventory({ clock: () => '2026-03-10', onEvent: e => seen.push(e) });
  inv.receive('A', 5, { lot: 'X', expiresOn: '2026-03-12' });
  inv.receive('A', 5, { lot: 'Y', expiresOn: '2026-04-01' });
  inv.receive('A', 2, { lot: 'Z', expiresOn: null, warehouse: 'HN' });
  inv.reserve('o1', 'A', 3);
  assert.throws(() => inv.reserve('o2', 'A', 100), code('INSUFFICIENT_STOCK'));
  assert.throws(() => inv.receive('A', 0, { lot: 'X' }), code('INVALID_INPUT'));
  assert.deepEqual(inv.commit('o1'), [{ sku: 'A', lot: 'X', qty: 3 }]);
  inv.transfer('t1', 'A', 4, { from: 'MAIN', to: 'HN' });
  inv.completeTransfer('t1');
  inv.transfer('t2', 'A', 1, { from: 'MAIN', to: 'HN' });
  inv.cancelTransfer('t2');
  inv.release('nobody');
  inv.reserve('o3', 'A', 1); inv.release('o3');
  inv.reserve('o4', 'A', 1);
  return { inv, seen };
}
const TYPES = ['received', 'received', 'received', 'reserved', 'committed', 'transfer_created', 'transfer_completed',
  'transfer_created', 'transfer_cancelled', 'reserved', 'released', 'reserved'];

test('p4.1 every change is one event with an increasing seq; failed calls add none', () => {
  const { inv, seen } = history();
  const events = inv.events();
  assert.deepEqual(events.map(e => e.type), TYPES);
  assert.deepEqual(events.map(e => e.seq), TYPES.map((_, i) => i + 1));
  assert.deepEqual(seen.map(e => e.seq), events.map(e => e.seq), 'onEvent sees each event once, in order');
});

test('p4.2 events() is a copy: the log cannot be changed from outside', () => {
  const { inv } = history();
  const copy = inv.events();
  copy.push({ seq: 99, type: 'received' });
  copy[0].type = 'tampered';
  copy[0].qty = 1000;
  const again = inv.events();
  assert.equal(again.length, TYPES.length);
  assert.equal(again[0].type, 'received');
  assert.notEqual(again[0].qty, 1000);
});

test('p4.3 replay rebuilds the same state from recorded outcomes, whatever the clock', () => {
  const { inv } = history();
  const events = JSON.parse(JSON.stringify(inv.events()));
  // On 2026-03-20 lot X has expired: re-running FEFO would pick other lots.
  const copy = Inventory.replay(events, at('2026-03-20'));
  assert.equal(copy.exportCsv({ all: true }), inv.exportCsv({ all: true }));
  assert.equal(copy.exportCsv({ all: true }), 'warehouse,sku,lot,qty,expiresOn\nHN,A,X,2,2026-03-12\nHN,A,Y,2,2026-04-01\nHN,A,Z,2,\nMAIN,A,Y,3,2026-04-01\n');
  assert.equal(copy.available('A', 'MAIN'), 2, 'the pending reservation o4 is rebuilt');
  assert.deepEqual(copy.commit('o4'), [{ sku: 'A', lot: 'Y', qty: 1 }]);
  assert.throws(() => copy.completeTransfer('t2'), code('UNKNOWN_TRANSFER'));
});

test('p4.4 a replayed inventory keeps its log and continues the sequence', () => {
  const { inv } = history();
  const seen = [];
  const copy = Inventory.replay(inv.events(), { clock: () => '2026-03-10', onEvent: e => seen.push(e) });
  assert.equal(seen.length, 0, 'replay does not re-announce old events');
  assert.equal(copy.events().length, TYPES.length);
  copy.receive('B', 1, { lot: 'L', expiresOn: null });
  assert.equal(copy.events().at(-1).seq, TYPES.length + 1);
  assert.equal(copy.events().at(-1).type, 'received');
  assert.deepEqual(seen.map(e => e.seq), [TYPES.length + 1]);
});

async function start() {
  const inventory = new Inventory(at('2026-03-10'));
  const server = createServer({ inventory });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, key, raw) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: raw ?? JSON.stringify(body) });
    return { status: res.status, json: await res.json(), replayed: res.headers.get('idempotent-replayed') };
  };
  return { inventory, post, stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test('p4.5 Idempotency-Key: same request is answered once, a reused key is refused, errors are not stored', async () => {
  const s = await start();
  try {
    const first = await s.post('/receive', { sku: 'A', qty: 5, lot: 'L1', expiresOn: null }, 'k1');
    assert.equal(first.status, 201);
    const again = await s.post('/receive', null, 'k1', '{ "lot": "L1", "expiresOn": null, "qty": 5, "sku": "A" }');
    assert.equal(again.status, 201);
    assert.deepEqual(again.json, first.json);
    assert.equal(again.replayed, 'true');
    assert.equal(s.inventory.onHand('A'), 5, 'the replayed request did not run again');
    const other = await s.post('/receive', { sku: 'A', qty: 6, lot: 'L1', expiresOn: null }, 'k1');
    assert.equal(other.status, 422); assert.equal(other.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const elsewhere = await s.post('/orders/o1/reserve', { sku: 'A', qty: 5, lot: 'L1', expiresOn: null }, 'k1');
    assert.equal(elsewhere.status, 422); assert.equal(elsewhere.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const short = await s.post('/orders/o1/reserve', { sku: 'A', qty: 8 }, 'k2');
    assert.equal(short.status, 409);
    await s.post('/receive', { sku: 'A', qty: 5, lot: 'L2', expiresOn: null });
    const retry = await s.post('/orders/o1/reserve', { sku: 'A', qty: 8 }, 'k2');
    assert.equal(retry.status, 200, 'a failed request may be retried with the same key');
    assert.equal(retry.replayed, null);
    const committed = await s.post('/orders/o1/commit', {}, 'k3');
    const committedAgain = await s.post('/orders/o1/commit', {}, 'k3');
    assert.equal(committedAgain.status, 200);
    assert.deepEqual(committedAgain.json, committed.json);
    assert.equal(s.inventory.onHand('A'), 2);
    assert.equal((await s.post('/receive', { sku: 'B', qty: 1, lot: 'L' })).status, 201, 'no key: a normal write');
  } finally { await s.stop(); }
});

function server(env) {
  const child = spawn(process.execPath, ['bin/server.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', KHO_TODAY: '2026-03-10', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no "listening on <port>" line: ${out}`)), 8000);
    child.stdout.on('data', d => { out += d; const m = out.match(/listening on (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
    child.stderr.on('data', d => { out += d; });
  });
  const stop = async () => {
    const exited = new Promise(r => child.on('exit', code => r(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 5000))]);
    child.kill('SIGKILL');
    return code;
  };
  return { port, stop };
}

test('p4.6 KHO_LOG: state and idempotency keys survive a restart; the file is only appended to', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'kho-p4-')), 'kho.jsonl');
  const call = async (port, method, path, body, key) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let s = server({ KHO_LOG: log });
  let port = await s.port;
  assert.equal((await call(port, 'POST', '/receive', { sku: 'A', qty: 5, lot: 'L1', expiresOn: '2026-03-12' }, 'r1')).status, 201);
  assert.equal((await call(port, 'POST', '/receive', { sku: 'A', qty: 4, lot: 'L2', expiresOn: '2026-04-01' })).status, 201);
  assert.equal((await call(port, 'POST', '/orders/o1/reserve', { sku: 'A', qty: 6 })).status, 200);
  assert.equal(await s.stop(), 0);
  assert.ok(existsSync(log));
  const before = readFileSync(log, 'utf8');
  for (const line of before.split('\n').filter(Boolean)) JSON.parse(line);

  // Restarted on a later day: the lot that expired since must not change history.
  s = server({ KHO_LOG: log, KHO_TODAY: '2026-03-13' });
  port = await s.port;
  try {
    // SPEC §2: available = unexpired lots − reservations; it does not say
    // whether a shortfall shows as 0 or negative, so both are accepted.
    const stock = (await call(port, 'GET', '/stock/A')).json;
    assert.deepEqual({ ...stock, available: Math.max(0, stock.available) }, { sku: 'A', warehouse: null, onHand: 9, available: 0 });
    assert.ok([0, -2].includes(stock.available), `available ${stock.available}`);
    const again = await call(port, 'POST', '/receive', { sku: 'A', qty: 5, lot: 'L1', expiresOn: '2026-03-12' }, 'r1');
    assert.equal(again.status, 201);
    assert.equal((await call(port, 'GET', '/stock/A')).json.onHand, 9, 'the key was remembered across the restart');
    assert.equal((await call(port, 'POST', '/orders/o1/commit')).json.error?.code, 'INSUFFICIENT_STOCK');
    assert.equal((await call(port, 'POST', '/receive', { sku: 'A', qty: 2, lot: 'L3', expiresOn: null })).status, 201);
    assert.deepEqual((await call(port, 'POST', '/orders/o1/commit')).json, { taken: [{ sku: 'A', lot: 'L2', qty: 4 }, { sku: 'A', lot: 'L3', qty: 2 }] });
  } finally { assert.equal(await s.stop(), 0); }
  const after = readFileSync(log, 'utf8');
  assert.ok(after.startsWith(before) && after.length > before.length, 'the log is append-only');
});

test('p4.7 the project has its own tests for the audit log and idempotency', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['events(', 'replay', 'Idempotency-Key', 'KHO_LOG']) assert.ok(text.toLowerCase().includes(word.toLowerCase()), `no own test mentions ${word}`);
});
