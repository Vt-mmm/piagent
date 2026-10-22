import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';

test('API: receive, transfers and /reports/stock', async () => {
  const server = createServer({ inventory: new Inventory({ clock: () => '2026-03-10' }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', body: JSON.stringify(b) });
  try {
    assert.equal((await post('/receive', { sku: 'A', qty: 2, lot: 'L' })).status, 201);
    assert.equal((await post('/transfers', { id: 't', sku: 'A', qty: 1, from: 'MAIN', to: 'HN' })).status, 201);
    assert.equal((await post('/transfers/t/complete', {})).status, 200);
    const rows = await (await fetch(base + '/reports/stock')).json();
    assert.equal(rows.length, 2);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
});
