// Hidden acceptance checks (phase p3): the node:http JSON API from
// docs/backlog/03-http-api.md — tokens, roles, error mapping, members cancel
// only their own bookings — on a real server listening on port 0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { createRepository, createServer, migrate, BookingError } from '../src/index.js';

let pool, repo, server, base, admin, lan, minh;
before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
  await migrate(pool);
  repo = createRepository(pool);
  server = createServer({ pool });
  assert.equal(server.listening, false, 'createServer returns a server that is not listening yet');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await repo.createApiToken({ username: 'hidden-admin', role: 'admin' })).token;
  lan = (await repo.createApiToken({ username: 'lan-p3', role: 'member' })).token;
  minh = (await repo.createApiToken({ username: ' minh-p3 ', role: 'member' })).token;
});
after(async () => {
  if (server?.listening) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
  await pool?.end();
});

async function call(method, path, token, body, { raw } = {}) {
  const headers = {};
  if (token) headers.authorization = token.startsWith('Basic ') ? token : `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = { notJson: text.slice(0, 200) }; } }
  return { status: res.status, body: json, type: res.headers.get('content-type') ?? '' };
}
const expectError = (r, status, code) => {
  assert.equal(r.status, status, `expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error?.code, code, `error code: ${JSON.stringify(r.body)}`);
  assert.equal(typeof r.body.error.message, 'string');
};
const tag = () => Math.random().toString(36).slice(2, 9);
const at = (day, h) => new Date(Date.UTC(2036, 3, day, Math.floor(h), Math.round((h % 1) * 60))).toISOString();
const newRoom = async () => (await call('POST', '/rooms', admin, { name: `P3 ${tag()}`, capacity: 5 })).body;

test('p3.1 tokens: createApiToken validation and shape', async () => {
  const t = await repo.createApiToken({ username: '  thu  ', role: 'member' });
  assert.equal(t.username, 'thu');
  assert.equal(t.role, 'member');
  assert.ok(typeof t.token === 'string' && t.token.length >= 32, 'token is at least 32 characters');
  assert.notEqual(t.token, (await repo.createApiToken({ username: 'thu', role: 'member' })).token);
  for (const bad of [{ username: 'x', role: 'root' }, { username: '   ', role: 'admin' }, { role: 'admin' }, { username: 'x' }]) {
    await assert.rejects(repo.createApiToken(bad), err => err instanceof BookingError && err.code === 'INVALID_INPUT');
  }
});

test('p3.2 health, authentication, unknown routes, methods', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.match(health.type, /^application\/json/);
  expectError(await call('GET', '/rooms'), 401, 'UNAUTHORIZED');
  expectError(await call('GET', '/rooms', 'not-a-real-token-0123456789abcdef0123'), 401, 'UNAUTHORIZED');
  expectError(await call('GET', '/rooms', 'Basic YWRtaW46YWRtaW4='), 401, 'UNAUTHORIZED');
  expectError(await call('GET', '/bookings'), 401, 'UNAUTHORIZED');
  expectError(await call('GET', '/no-such-route', admin), 404, 'NOT_FOUND');
  expectError(await call('GET', '/rooms/abc', admin), 404, 'NOT_FOUND');
  expectError(await call('PUT', '/rooms', admin, {}), 405, 'METHOD_NOT_ALLOWED');
  expectError(await call('DELETE', '/bookings', admin), 405, 'METHOD_NOT_ALLOWED');
});

test('p3.3 rooms over HTTP: admin only for writes, error mapping', async () => {
  const name = `P3 room ${tag()}`;
  expectError(await call('POST', '/rooms', lan, { name, capacity: 4 }), 403, 'FORBIDDEN');
  const created = await call('POST', '/rooms', admin, { name, capacity: 4 });
  assert.equal(created.status, 201);
  assert.match(created.type, /^application\/json/);
  assert.equal(created.body.name, name);
  assert.equal(typeof created.body.id, 'number');
  assert.ok(!Number.isNaN(Date.parse(created.body.createdAt)), 'createdAt is an ISO string');
  expectError(await call('POST', '/rooms', admin, { name: name.toUpperCase(), capacity: 4 }), 409, 'ROOM_NAME_TAKEN');
  expectError(await call('POST', '/rooms', admin, { name: `x ${tag()}`, capacity: 0 }), 400, 'INVALID_INPUT');
  expectError(await call('POST', '/rooms', admin, undefined, { raw: '{"name": ' }), 400, 'INVALID_INPUT');
  const listed = await call('GET', '/rooms', lan);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.items.some(r => r.id === created.body.id));
  expectError(await call('PATCH', `/rooms/${created.body.id}`, lan, { capacity: 9 }), 403, 'FORBIDDEN');
  const patched = await call('PATCH', `/rooms/${created.body.id}`, admin, { capacity: 9 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.capacity, 9);
  assert.equal(patched.body.name, name);
  expectError(await call('PATCH', '/rooms/2000000000', admin, { capacity: 9 }), 404, 'NOT_FOUND');
  const b = await call('POST', '/bookings', lan, { roomId: created.body.id, title: 'Chặn xoá', startsAt: at(1, 9), endsAt: at(1, 10) });
  expectError(await call('DELETE', `/rooms/${created.body.id}`, admin), 409, 'ROOM_IN_USE');
  await call('POST', `/bookings/${b.body.id}/cancel`, lan);
  expectError(await call('DELETE', `/rooms/${created.body.id}`, lan), 403, 'FORBIDDEN');
  const del = await call('DELETE', `/rooms/${created.body.id}`, admin);
  assert.equal(del.status, 204);
  assert.equal(del.body, null, '204 has no body');
  expectError(await call('DELETE', `/rooms/${created.body.id}`, admin), 404, 'NOT_FOUND');
});

test('p3.4 bookings over HTTP: organizer from the token, validation, conflicts', async () => {
  const room = await newRoom();
  const mine = await call('POST', '/bookings', lan, { roomId: room.id, title: ' Họp nhóm ', startsAt: at(2, 9), endsAt: at(2, 10) });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.organizer, 'lan-p3');
  assert.equal(mine.body.title, 'Họp nhóm');
  assert.equal(mine.body.startsAt, at(2, 9));
  assert.equal(mine.body.roomId, room.id);
  const self = await call('POST', '/bookings', minh, { roomId: room.id, title: 'Tự đặt', organizer: 'minh-p3', startsAt: at(2, 11), endsAt: at(2, 12) });
  assert.equal(self.status, 201, 'a member may name themself as organizer');
  assert.equal(self.body.organizer, 'minh-p3');
  expectError(await call('POST', '/bookings', lan, { roomId: room.id, title: 'Đặt hộ', organizer: 'minh-p3', startsAt: at(2, 13), endsAt: at(2, 14) }), 403, 'FORBIDDEN');
  const forOther = await call('POST', '/bookings', admin, { roomId: room.id, title: 'Đặt hộ', organizer: 'khach', startsAt: at(2, 13), endsAt: at(2, 14) });
  assert.equal(forOther.status, 201);
  assert.equal(forOther.body.organizer, 'khach');
  const own = await call('POST', '/bookings', admin, { roomId: room.id, title: 'Admin', startsAt: at(2, 15), endsAt: at(2, 16) });
  assert.equal(own.body.organizer, 'hidden-admin');
  expectError(await call('POST', '/bookings', lan, { roomId: room.id, title: 'Trùng', startsAt: at(2, 9.5), endsAt: at(2, 10.5) }), 409, 'BOOKING_CONFLICT');
  expectError(await call('POST', '/bookings', lan, { roomId: room.id, title: 'Ngược', startsAt: at(2, 18), endsAt: at(2, 17) }), 400, 'INVALID_INPUT');
  expectError(await call('POST', '/bookings', lan, { roomId: room.id, title: '  ', startsAt: at(2, 18), endsAt: at(2, 19) }), 400, 'INVALID_INPUT');
  expectError(await call('POST', '/bookings', lan, { roomId: 2_000_000_000, title: 'x', startsAt: at(2, 18), endsAt: at(2, 19) }), 404, 'NOT_FOUND');
  expectError(await call('POST', '/bookings', lan, undefined, { raw: 'not json' }), 400, 'INVALID_INPUT');
  const got = await call('GET', `/bookings/${mine.body.id}`, minh);
  assert.equal(got.status, 200);
  assert.equal(got.body.id, mine.body.id);
  expectError(await call('GET', '/bookings/2000000000', lan), 404, 'NOT_FOUND');
  expectError(await call('GET', '/bookings/abc', lan), 404, 'NOT_FOUND');
});

test('p3.5 cancelling: members only their own, admins any', async () => {
  const room = await newRoom();
  const a = (await call('POST', '/bookings', lan, { roomId: room.id, title: 'Của Lan', startsAt: at(3, 9), endsAt: at(3, 10) })).body;
  const b = (await call('POST', '/bookings', minh, { roomId: room.id, title: 'Của Minh', startsAt: at(3, 10), endsAt: at(3, 11) })).body;
  expectError(await call('POST', `/bookings/${b.id}/cancel`, lan), 403, 'FORBIDDEN');
  assert.equal((await repo.getBooking(b.id)).cancelledAt ?? null, null, 'a refused cancel changes nothing');
  const ok = await call('POST', `/bookings/${a.id}/cancel`, lan);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, a.id);
  assert.ok(!Number.isNaN(Date.parse(ok.body.cancelledAt)));
  expectError(await call('POST', `/bookings/${a.id}/cancel`, lan), 409, 'ALREADY_CANCELLED');
  const byAdmin = await call('POST', `/bookings/${b.id}/cancel`, admin);
  assert.equal(byAdmin.status, 200);
  expectError(await call('POST', '/bookings/2000000000/cancel', admin), 404, 'NOT_FOUND');
  expectError(await call('GET', `/bookings/${a.id}/cancel`, admin), 405, 'METHOD_NOT_ALLOWED');
});

test('p3.6 listing over HTTP: filters, limits, cursor, includeCancelled', async () => {
  const room = await newRoom();
  const ids = [];
  for (const h of [8, 9, 10, 11, 12]) ids.push((await call('POST', '/bookings', lan, { roomId: room.id, title: `B${h}`, startsAt: at(4, h), endsAt: at(4, h + 0.5) })).body.id);
  await call('POST', `/bookings/${ids[4]}/cancel`, lan);
  const p1 = await call('GET', `/bookings?roomId=${room.id}&limit=2`, minh);
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.items.map(b => b.id), ids.slice(0, 2));
  assert.equal(typeof p1.body.nextCursor, 'string');
  const p2 = await call('GET', `/bookings?roomId=${room.id}&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, minh);
  assert.deepEqual(p2.body.items.map(b => b.id), ids.slice(2, 4));
  assert.equal(p2.body.nextCursor, null);
  const all = await call('GET', `/bookings?roomId=${room.id}&includeCancelled=true&limit=10`, minh);
  assert.deepEqual(all.body.items.map(b => b.id), ids);
  const window = await call('GET', `/bookings?roomId=${room.id}&from=${encodeURIComponent(at(4, 9.25))}&to=${encodeURIComponent(at(4, 11))}`, minh);
  assert.deepEqual(window.body.items.map(b => b.id), ids.slice(1, 3));
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=garbage', 'from=yesterday']) expectError(await call('GET', `/bookings?roomId=${room.id}&${q}`, minh), 400, 'INVALID_INPUT');
});

test('p3.7 recurring bookings over HTTP, conflicts listed in the error', async () => {
  const room = await newRoom();
  const r = await call('POST', '/bookings', lan, { roomId: room.id, title: 'Standup', startsAt: at(6, 2), endsAt: at(6, 2.25), recurrence: { freq: 'daily', count: 5 } });
  assert.equal(r.status, 201);
  assert.ok(Number.isInteger(r.body.seriesId));
  assert.equal(r.body.bookings.length, 5);
  assert.ok(r.body.bookings.every(b => b.organizer === 'lan-p3'));
  const clash = await call('POST', '/bookings', minh, { roomId: room.id, title: 'Clash', startsAt: at(5, 2), endsAt: at(5, 2.5), recurrence: { freq: 'daily', count: 4 } });
  expectError(clash, 409, 'BOOKING_CONFLICT');
  assert.ok(Array.isArray(clash.body.error.conflicts), 'error.conflicts present');
  assert.deepEqual(clash.body.error.conflicts.map(c => c.startsAt), [at(6, 2), at(7, 2), at(8, 2)]);
  expectError(await call('POST', '/bookings', lan, { roomId: room.id, title: 'x', startsAt: at(20, 2), endsAt: at(20, 3), recurrence: { freq: 'yearly', count: 2 } }), 400, 'INVALID_INPUT');
});

test('p3.8 no web framework; the project tests the API on port 0', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const banned of ['express', 'fastify', 'koa', '@hapi/hapi', 'hapi', 'restify', 'polka', '@nestjs/core', 'hono']) assert.ok(!deps.includes(banned), `framework dependency ${banned}`);
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  assert.ok(/listen\(\s*0\b/.test(text), 'no own test listens on port 0');
  for (const word of ['createServer', 'Bearer', '403', '401', 'cancel']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
