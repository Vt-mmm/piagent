import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';

test('events() and replay rebuild the same stock', () => {
  const inv = new Inventory({ clock: () => '2026-03-10' });
  inv.receive('A', 3, { lot: 'L', expiresOn: '2026-03-11' }); inv.reserve('o', 'A', 2); inv.commit('o');
  const copy = Inventory.replay(inv.events(), { clock: () => '2026-04-01' });
  assert.equal(copy.exportCsv(), inv.exportCsv());
  assert.deepEqual(inv.events().map(e => e.type), ['received', 'reserved', 'committed']);
});

test('Idempotency-Key answers a repeated write once', async () => {
  const inventory = new Inventory({ clock: () => '2026-03-10' });
  const server = createServer({ inventory });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/receive`, { method: 'POST', headers: { 'Idempotency-Key': 'k' }, body: JSON.stringify({ sku: 'A', qty: 1, lot: 'L' }) });
  try {
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    assert.equal(inventory.onHand('A'), 1);
  } finally { server.closeAllConnections(); server.close(); }
});

test('KHO_LOG keeps the state across a restart', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'kho-')), 'log.jsonl');
  const run = async fn => {
    const child = spawn(process.execPath, ['bin/server.js'], { env: { ...process.env, PORT: '0', KHO_LOG: log } });
    const port = await new Promise(r => child.stdout.on('data', d => { const m = String(d).match(/listening on (\d+)/); if (m) r(m[1]); }));
    try { await fn(`http://127.0.0.1:${port}`); } finally { const done = new Promise(r => child.on('exit', r)); child.kill('SIGTERM'); await done; }
  };
  await run(base => fetch(base + '/receive', { method: 'POST', body: JSON.stringify({ sku: 'A', qty: 2, lot: 'L' }) }).then(r => r.text()));
  await run(async base => assert.equal((await (await fetch(base + '/stock/A')).json()).onHand, 2));
});
