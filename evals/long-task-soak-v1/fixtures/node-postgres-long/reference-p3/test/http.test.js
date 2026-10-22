import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, createServer } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo, server, base, admin, an, binh;
before(async () => {
  if (skip) return;
  pool = await setupPool(); repo = createRepository(pool);
  server = createServer({ pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await repo.createApiToken({ username: 'admin', role: 'admin' })).token;
  an = (await repo.createApiToken({ username: 'an', role: 'member' })).token;
  binh = (await repo.createApiToken({ username: 'binh', role: 'member' })).token;
});
after(async () => { await new Promise(r => server ? server.close(r) : r()); await pool?.end(); });

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const at = h => new Date(Date.UTC(2031, 8, 1, h)).toISOString();

test('health, 401, 403 cho phòng', { skip }, async () => {
  assert.deepEqual((await call('GET', '/health')).body, { ok: true });
  assert.equal((await call('GET', '/rooms')).status, 401);
  assert.equal((await call('GET', '/rooms', 'sai-token')).body.error.code, 'UNAUTHORIZED');
  assert.equal((await call('POST', '/rooms', an, { name: unique('x'), capacity: 3 })).status, 403);
  const created = await call('POST', '/rooms', admin, { name: unique('Phòng API'), capacity: 3 });
  assert.equal(created.status, 201);
  assert.equal((await call('DELETE', `/rooms/${created.body.id}`, admin)).status, 204);
  assert.equal((await call('PUT', '/rooms', admin)).status, 405);
  assert.equal((await call('GET', '/khong-co', admin)).status, 404);
});

test('member chỉ huỷ được lịch của mình', { skip }, async () => {
  const room = (await call('POST', '/rooms', admin, { name: unique('Phòng API'), capacity: 3 })).body;
  const mine = await call('POST', '/bookings', an, { roomId: room.id, title: 'Họp', startsAt: at(9), endsAt: at(10) });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.organizer, 'an');
  assert.equal((await call('POST', '/bookings', an, { roomId: room.id, title: 'Họp', organizer: 'binh', startsAt: at(11), endsAt: at(12) })).status, 403);
  assert.equal((await call('POST', '/bookings', an, { roomId: room.id, title: 'Trùng', startsAt: at(9), endsAt: at(10) })).status, 409);
  assert.equal((await call('POST', `/bookings/${mine.body.id}/cancel`, binh)).status, 403);
  const cancelled = await call('POST', `/bookings/${mine.body.id}/cancel`, an);
  assert.equal(cancelled.status, 200);
  assert.ok(cancelled.body.cancelledAt);
  assert.equal((await call('POST', `/bookings/${mine.body.id}/cancel`, admin)).body.error.code, 'ALREADY_CANCELLED');
  const list = await call('GET', `/bookings?roomId=${room.id}&includeCancelled=true`, binh);
  assert.equal(list.body.items.length, 1);
});
