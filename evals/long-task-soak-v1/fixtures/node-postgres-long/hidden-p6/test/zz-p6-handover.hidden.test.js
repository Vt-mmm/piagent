// Hidden acceptance checks (phase p6): docs/backlog/06-ban-giao.md (db:reset,
// db:seed, README "Vận hành", npm scripts) and the rule the member added
// mid-session: every booking listing orders by start, then room name A→Z
// ignoring case, then id, with cursor pagination following that order.
// Every earlier phase's hidden checks run alongside (final regression).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createRepository, createServer, migrate } from '../src/index.js';
import { freshDatabase, run } from './zz-fresh-db.hidden.js';

let pool, repo;
before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  await migrate(pool);
  repo = createRepository(pool);
});
after(async () => { await pool?.end(); });

const tag = () => Math.random().toString(36).slice(2, 9);

async function orderingFixture() {
  const t = `Order ${tag()}`;
  const rooms = {};
  for (const n of ['gamma', 'Alpha', 'beta']) rooms[n] = await repo.createRoom({ name: `${t} ${n}`, capacity: 4 }); // ids: gamma < Alpha < beta
  const s = new Date(Date.UTC(2035, 4, 7, 2, 7)), H = 3_600_000;
  const book = (room, start, mins = 60) => repo.createBooking({ roomId: room.id, title: 'Thứ tự', organizer: 'p6', startsAt: start, endsAt: new Date(start.getTime() + mins * 60_000) });
  const ids = {};
  ids.gammaLate = (await book(rooms.gamma, new Date(s.getTime() + H))).id;
  ids.gamma = (await book(rooms.gamma, s)).id;
  const cancelled = await book(rooms.Alpha, s, 30);
  await repo.cancelBooking(cancelled.id);
  ids.alphaCancelled = cancelled.id;
  ids.alpha = (await book(rooms.Alpha, s)).id;
  ids.beta = (await book(rooms.beta, s)).id;
  ids.alphaEarly = (await book(rooms.Alpha, new Date(s.getTime() - H))).id;
  const ours = new Set(Object.values(rooms).map(r => r.id));
  const window = { from: new Date(s.getTime() - H), to: new Date(s.getTime() + 2 * H) };
  return { rooms, ids, ours, window,
    expected: [ids.alphaEarly, ids.alpha, ids.beta, ids.gamma, ids.gammaLate],
    expectedWithCancelled: [ids.alphaEarly, ids.alphaCancelled, ids.alpha, ids.beta, ids.gamma, ids.gammaLate] };
}

async function walk(list, limit) {
  const seen = []; let cursor, pages = 0;
  do {
    const page = await list(cursor, limit);
    seen.push(...page.items);
    cursor = page.nextCursor;
    assert.ok(++pages < 500, 'pagination does not end');
  } while (cursor);
  return seen;
}

test('p6.1 member rule: listBookings orders by start, room name (case-insensitive), id; cursors follow it', async () => {
  const f = await orderingFixture();
  const mine = items => items.filter(b => f.ours.has(b.roomId)).map(b => b.id);
  const one = await repo.listBookings({ ...f.window, limit: 100 });
  assert.deepEqual(mine(one.items), f.expected, 'same start: Alpha, beta, gamma (not by id, not by case-sensitive name)');
  assert.deepEqual(mine((await repo.listBookings({ ...f.window, limit: 100, includeCancelled: true })).items), f.expectedWithCancelled, 'same start and same room: by id');
  for (const limit of [1, 2, 3]) {
    const all = await walk((cursor, l) => repo.listBookings({ ...f.window, limit: l, cursor }), limit);
    assert.equal(new Set(all.map(b => b.id)).size, all.length, `limit ${limit}: no booking repeated across pages`);
    assert.deepEqual(mine(all), f.expected, `limit ${limit}: pages follow the order without gaps`);
  }
  const withCancelled = await walk((cursor, l) => repo.listBookings({ ...f.window, includeCancelled: true, limit: l, cursor }), 1);
  assert.deepEqual(mine(withCancelled), f.expectedWithCancelled);
});

test('p6.2 member rule over HTTP: GET /bookings uses the same order', async () => {
  const f = await orderingFixture();
  const server = createServer({ pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (await repo.createApiToken({ username: 'p6-reader', role: 'member' })).token;
    const list = async (cursor, limit) => {
      const q = new URLSearchParams({ from: f.window.from.toISOString(), to: f.window.to.toISOString(), limit: String(limit), ...(cursor ? { cursor } : {}) });
      const res = await fetch(`${base}/bookings?${q}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      return res.json();
    };
    const all = await walk(list, 2);
    assert.deepEqual(all.filter(b => f.ours.has(b.roomId)).map(b => b.id), f.expected);
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

test('p6.3 package.json scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const s of ['migrate', 'test', 'db:up', 'db:down', 'db:reset', 'db:seed', 'seed:report', 'import:legacy']) assert.ok(pkg.scripts?.[s], `missing npm script ${s}`);
});

test('p6.4 db:reset wipes and re-migrates; refuses in production', async () => {
  const url = await freshDatabase('soak_p6r');
  const p = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const first = await run('npm', ['run', '--silent', 'db:reset'], { databaseUrl: url });
    assert.equal(first.code, 0, first.stderr.slice(-1500));
    const files = (await import('node:fs')).readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+_.+\.sql$/.test(f));
    assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, files.length, 'every migration applied');
    await p.query(`INSERT INTO rooms (name, capacity) VALUES ('Marker room', 3)`);
    const refused = await run('npm', ['run', '--silent', 'db:reset'], { databaseUrl: url, env: { NODE_ENV: 'production' } });
    assert.notEqual(refused.code, 0, 'db:reset must refuse when NODE_ENV=production');
    assert.equal((await p.query(`SELECT count(*)::int AS n FROM rooms WHERE name = 'Marker room'`)).rows[0].n, 1, 'a refused reset leaves the data alone');
    const second = await run('npm', ['run', '--silent', 'db:reset'], { databaseUrl: url });
    assert.equal(second.code, 0, second.stderr.slice(-1500));
    assert.equal((await p.query('SELECT count(*)::int AS n FROM rooms')).rows[0].n, 0, 'db:reset removes the data');
    assert.equal((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, files.length);
  } finally { await p.end(); }
});

test('p6.5 db:seed: demo data in the next four weeks, working tokens, re-runnable', async () => {
  const url = await freshDatabase('soak_p6s');
  const p = new pg.Pool({ connectionString: url, max: 6 });
  let server;
  try {
    assert.equal((await run('npm', ['run', '--silent', 'db:reset'], { databaseUrl: url })).code, 0);
    const now = Date.now();
    const seeded = createRepository(p);
    const snapshot = async () => {
      const counts = (await p.query(`SELECT (SELECT count(*)::int FROM rooms) AS rooms, (SELECT count(*)::int FROM bookings) AS bookings`)).rows[0];
      const items = await walk((cursor, limit) => seeded.listBookings({ from: new Date(now - 3_600_000), to: new Date(now + 29 * 86_400_000), includeCancelled: true, limit, cursor }), 100);
      const upcoming = items.filter(b => b.startsAt.getTime() >= now - 3_600_000);
      // SPEC: "at least 30 bookings in the next 4 weeks (with a series and a cancelled one)": the cancelled one counts.
      return { ...counts, upcoming: upcoming.length, series: upcoming.filter(b => b.seriesId != null).length, cancelled: upcoming.filter(b => b.cancelledAt).length };
    };
    const one = await run('npm', ['run', '--silent', 'db:seed'], { databaseUrl: url });
    assert.equal(one.code, 0, one.stderr.slice(-1500));
    const s1 = await snapshot();
    assert.ok(s1.rooms >= 5, `rooms: ${s1.rooms}`);
    assert.ok(s1.upcoming >= 30, `bookings in the next 4 weeks: ${s1.upcoming}`);
    assert.ok(s1.series >= 2, 'a recurring series');
    assert.ok(s1.cancelled >= 1, 'a cancelled booking');
    const two = await run('npm', ['run', '--silent', 'db:seed'], { databaseUrl: url });
    assert.equal(two.code, 0, two.stderr.slice(-1500));
    const s2 = await snapshot();
    assert.deepEqual({ rooms: s2.rooms, bookings: s2.bookings }, { rooms: s1.rooms, bookings: s1.bookings }, 'running db:seed again does not duplicate demo data');

    server = createServer({ pool: p });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const candidates = [...new Set(two.stdout.match(/[A-Za-z0-9_\-.~+/=]{32,}/g) ?? [])];
    const roles = {};
    for (const token of candidates) {
      const headers = { authorization: `Bearer ${token}` };
      if ((await fetch(`${base}/rooms`, { headers })).status !== 200) continue;
      const report = await fetch(`${base}/reports/utilisation?from=${encodeURIComponent(new Date(now).toISOString())}&to=${encodeURIComponent(new Date(now + 28 * 86_400_000).toISOString())}`, { headers });
      roles[report.status === 200 ? 'admin' : report.status === 403 ? 'member' : 'other'] = token;
    }
    assert.ok(roles.admin, `db:seed prints a working admin token (stdout: ${two.stdout.slice(0, 400)})`);
    assert.ok(roles.member, 'db:seed prints a working member token');
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
    await p.end();
  }
});

test('p6.6 README has a Vietnamese operations section', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const at = readme.search(/^##\s+Vận hành\s*$/m);
  assert.ok(at >= 0, 'README has a "## Vận hành" section');
  const section = readme.slice(at);
  for (const word of ['db:reset', 'db:seed', 'Authorization', 'Bearer', '/bookings', '/reports/utilisation', 'import:legacy', '--dry-run']) assert.ok(section.includes(word), `the section does not mention ${word}`);
  assert.ok((section.match(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi) ?? []).length >= 40, 'the section is written in Vietnamese');
});
