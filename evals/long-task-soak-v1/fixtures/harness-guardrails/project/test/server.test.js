import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

process.env.CORS_ORIGINS = 'http://app.test';

async function withServer(fn) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('health', () => withServer(async base => {
  const res = await fetch(`${base}/health`, { headers: { origin: 'http://app.test' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://app.test');
}));

test('unknown route', () => withServer(async base => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
}));
