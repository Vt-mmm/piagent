// Hidden acceptance checks (phase p4): weekly utilisation report from
// docs/backlog/04-bao-cao.md — exact numbers on hand-made data, the seed
// script (50,000 bookings, re-runnable), the report using bookings_report_idx
// and running under 2 s on the seeded data, and the admin-only HTTP route.
// Runs on a fresh database of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { createRepository, createServer, migrate, BookingError } from '../src/index.js';
import { freshDatabase, run, recordingPool } from './zz-fresh-db.hidden.js';

let url, pool, repo;
before(async () => {
  url = await freshDatabase('soak_p4');
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await migrate(pool);
  repo = createRepository(pool);
});
after(async () => { await pool?.end(); });

const invalid = err => err instanceof BookingError && err.code === 'INVALID_INPUT';
const iso = d => new Date(d).toISOString();
const row = r => [r.roomName, iso(r.weekStart), r.bookings, r.bookedMinutes, r.utilisation, r.rankInWeek, r.changeFromPreviousWeek];

test('p4.1 report numbers: Vietnam weeks, cancelled excluded, RANK and LAG semantics, roomId filter', async () => {
  const room = name => repo.createRoom({ name, capacity: 6 });
  const [alpha, beta, gamma, delta] = [await room('Alpha'), await room('beta'), await room('Gamma'), await room('Delta')];
  const book = (r, s, e) => repo.createBooking({ roomId: r.id, title: 'Báo cáo', organizer: 'p4', startsAt: s, endsAt: e });
  await book(alpha, '2032-12-31T23:30:00Z', '2033-01-01T01:00:00Z'); // starts before `from`
  await book(alpha, '2033-01-09T16:00:00Z', '2033-01-09T16:30:00Z'); // Sunday 23:00 in Vietnam: week of 2033-01-03
  await book(alpha, '2033-01-09T18:00:00Z', '2033-01-09T19:00:00Z'); // Monday 01:00 in Vietnam: week of 2033-01-10
  await book(alpha, '2033-01-11T02:00:00Z', '2033-01-11T04:00:00Z');
  await book(alpha, '2033-01-24T03:00:00Z', '2033-01-24T04:30:00Z');
  await book(beta, '2033-01-12T01:00:00Z', '2033-01-12T04:00:00Z');
  await book(beta, '2033-01-17T02:00:00Z', '2033-01-17T02:30:00Z');
  await book(gamma, '2033-01-12T03:00:00Z', '2033-01-12T04:10:00Z');
  const gone = await book(gamma, '2033-01-13T01:00:00Z', '2033-01-13T05:00:00Z');
  await repo.cancelBooking(gone.id);
  await book(delta, '2033-02-05T03:00:00Z', '2033-02-05T04:00:00Z'); // after `to`
  const rows = await repo.utilisationReport({ from: new Date('2033-01-01T00:00:00Z'), to: '2033-02-01T00:00:00Z' });
  assert.ok(rows.every(r => r.weekStart instanceof Date), 'weekStart is a Date');
  assert.ok(rows.every(r => typeof r.utilisation === 'number' && typeof r.bookedMinutes === 'number' && typeof r.rankInWeek === 'number'), 'numbers are numbers');
  assert.deepEqual(rows.map(row), [
    ['Alpha', '2033-01-02T17:00:00.000Z', 1, 30, 0.01, 1, null],
    ['Alpha', '2033-01-09T17:00:00.000Z', 2, 180, 0.06, 1, 150],
    ['beta', '2033-01-09T17:00:00.000Z', 1, 180, 0.06, 1, null],
    ['Gamma', '2033-01-09T17:00:00.000Z', 1, 70, 0.0233, 3, null],
    ['beta', '2033-01-16T17:00:00.000Z', 1, 30, 0.01, 1, -150],
    ['Alpha', '2033-01-23T17:00:00.000Z', 1, 90, 0.03, 1, -90],
  ]);
  assert.deepEqual(rows.map(r => r.roomId), [alpha.id, alpha.id, beta.id, gamma.id, beta.id, alpha.id]);
  const only = await repo.utilisationReport({ from: '2033-01-01T00:00:00Z', to: '2033-02-01T00:00:00Z', roomId: beta.id });
  assert.deepEqual(only.map(row), [
    ['beta', '2033-01-09T17:00:00.000Z', 1, 180, 0.06, 1, null],
    ['beta', '2033-01-16T17:00:00.000Z', 1, 30, 0.01, 1, -150],
  ]);
  assert.deepEqual(await repo.utilisationReport({ from: '2033-01-01T00:00:00Z', to: '2033-02-01T00:00:00Z', roomId: delta.id }), []);
  for (const bad of [{ from: '2033-02-01', to: '2033-01-01' }, { from: '2033-01-01', to: '2033-01-01' }, { from: '2033-01-01', to: '2034-01-03' },
    { from: 'garbage', to: '2033-02-01' }, { to: '2033-02-01' }, { from: '2033-01-01' }]) {
    await assert.rejects(repo.utilisationReport(bad), invalid, JSON.stringify(bad));
  }
});

test('p4.2 bookings_report_idx: partial index on starts_at for active bookings', async () => {
  const { rows } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'bookings' AND indexname = 'bookings_report_idx'`);
  assert.equal(rows.length, 1, 'index bookings_report_idx exists on bookings');
  assert.match(rows[0].indexdef, /\(starts_at[,)\s]/, rows[0].indexdef);
  assert.match(rows[0].indexdef, /WHERE\s+\(?cancelled_at IS NULL\)?/i, rows[0].indexdef);
});

const seedCount = async () => (await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE b.cancelled_at IS NOT NULL)::int AS cancelled,
  min(b.starts_at) AS first, max(b.starts_at) AS last, count(DISTINCT r.id)::int AS rooms
  FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE r.name ~ '^Seed [0-9]{2}$'`)).rows[0];

test('p4.3 seed: exactly 50,000 bookings in 2029, re-runnable, under a minute', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts?.['seed:report'], 'package.json has a seed:report script');
  for (const round of [1, 2]) {
    const r = await run('npm', ['run', '--silent', 'seed:report'], { databaseUrl: url, timeoutMs: 180_000 });
    assert.equal(r.code, 0, `seed run ${round} failed: ${r.stderr.slice(-1500)}`);
    assert.ok(r.ms < 60_000, `seed run ${round} took ${r.ms} ms`);
    const c = await seedCount();
    assert.equal(c.n, 50_000, `after run ${round}: ${c.n} seed bookings`);
    assert.equal(c.rooms, 25);
    assert.ok(c.cancelled >= 2_500 && c.cancelled <= 7_500, `cancelled seed bookings: ${c.cancelled}`);
    assert.ok(c.first >= new Date('2028-12-31T17:00:00Z') && c.last < new Date('2030-01-01T00:00:00Z'), `seed range ${iso(c.first)} – ${iso(c.last)}`);
  }
  const names = (await pool.query(`SELECT name FROM rooms WHERE name ~ '^Seed [0-9]{2}$' ORDER BY name`)).rows.map(r => r.name);
  assert.equal(names[0], 'Seed 01');
  assert.equal(names.at(-1), 'Seed 25');
});

function indexNames(plan, out = []) {
  if (Array.isArray(plan)) { plan.forEach(p => indexNames(p, out)); return out; }
  if (plan && typeof plan === 'object') {
    if (plan['Index Name']) out.push(`${plan['Node Type']}:${plan['Index Name']}`);
    for (const v of Object.values(plan)) if (v && typeof v === 'object') indexNames(v, out);
  }
  return out;
}

test('p4.4 on the seeded data the report uses bookings_report_idx, runs under 2 s and matches the bookings', async () => {
  assert.equal((await seedCount()).n, 50_000, 'p4.3 seeded the database');
  await pool.query('VACUUM ANALYZE');
  const log = [];
  const spied = createRepository(recordingPool(pool, log));
  const range = { from: '2029-03-04T17:00:00Z', to: '2029-03-18T17:00:00Z' };
  let best = Infinity, rows;
  for (let i = 0; i < 3; i++) {
    const started = process.hrtime.bigint();
    rows = await spied.utilisationReport(range);
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  assert.ok(best < 2000, `report took ${best.toFixed(0)} ms`);
  assert.equal(rows.length, 50, `25 seed rooms × 2 weeks, got ${rows.length} rows`);

  const queries = log.filter(q => /\bbookings\b/i.test(q.text) && /^\s*(\(|select|with)/i.test(q.text));
  assert.ok(queries.length, 'the report queries bookings through the pool it was given');
  const usesReportIdx = list => list.some(u => /^(Index Scan|Index Only Scan|Bitmap Index Scan):bookings_report_idx$/.test(u));
  const explain = async client => {
    const used = [];
    for (const q of queries) used.push(...indexNames((await client.query(`EXPLAIN (FORMAT JSON) ${q.text}`, q.values)).rows[0]['QUERY PLAN']));
    return used;
  };
  let used = await explain(pool);
  if (!usesReportIdx(used)) {
    // Another plain index on starts_at (e.g. one kept for listings) may look
    // as cheap to the planner; what matters is that the report's query can
    // use bookings_report_idx. Drop the other plain indexes inside a
    // transaction (rolled back) and ask again.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: others } = await client.query(`
        SELECT i.indexrelid::regclass::text AS name FROM pg_index i
         WHERE i.indrelid = 'bookings'::regclass AND NOT i.indisprimary AND NOT i.indisunique
           AND i.indexrelid::regclass::text <> 'bookings_report_idx'
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)`);
      for (const o of others) await client.query(`DROP INDEX ${o.name}`);
      used = [...used, '|', ...await explain(client)];
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  }
  assert.ok(usesReportIdx(used), `the report's plan does not use bookings_report_idx (index nodes: ${used.join(', ') || 'none'})`);

  const { rows: truth } = await pool.query(`
    SELECT room_id, (date_trunc('week', starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_start,
           count(*)::int AS n, (sum(extract(epoch FROM ends_at - starts_at)) / 60)::int AS minutes
      FROM bookings WHERE cancelled_at IS NULL AND starts_at >= $1 AND starts_at < $2 GROUP BY 1, 2`, [range.from, range.to]);
  const key = (room, week, n, minutes) => `${room}|${iso(week)}|${n}|${minutes}`;
  assert.deepEqual(rows.map(r => key(r.roomId, r.weekStart, r.bookings, r.bookedMinutes)).sort(), truth.map(t => key(t.room_id, t.week_start, t.n, t.minutes)).sort());
  for (const r of rows) {
    const same = rows.filter(x => iso(x.weekStart) === iso(r.weekStart));
    assert.equal(r.rankInWeek, 1 + same.filter(x => x.bookedMinutes > r.bookedMinutes).length, 'rankInWeek is RANK() by bookedMinutes desc');
    assert.equal(r.utilisation, Math.round(r.bookedMinutes / 3000 * 10_000) / 10_000);
    const prev = rows.filter(x => x.roomId === r.roomId && x.weekStart < r.weekStart).at(-1);
    assert.equal(r.changeFromPreviousWeek, prev ? r.bookedMinutes - prev.bookedMinutes : null);
  }
  const order = rows.map(r => [r.weekStart.getTime(), r.rankInWeek]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]), 'ordered by weekStart, then rankInWeek');
});

test('p4.5 GET /reports/utilisation: admins only', async () => {
  const server = createServer({ pool });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const admin = (await repo.createApiToken({ username: 'p4-admin', role: 'admin' })).token;
    const member = (await repo.createApiToken({ username: 'p4-member', role: 'member' })).token;
    const get = (q, token) => fetch(`${base}/reports/utilisation?${q}`, { headers: { authorization: `Bearer ${token}` } }).then(async r => ({ status: r.status, body: await r.json() }));
    const q = 'from=2033-01-01T00:00:00Z&to=2033-02-01T00:00:00Z';
    const denied = await get(q, member);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
    const ok = await get(q, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.items.length, 6);
    assert.equal(ok.body.items[1].weekStart, '2033-01-09T17:00:00.000Z');
    assert.equal(ok.body.items[1].bookedMinutes, 180);
    const beta = ok.body.items[2].roomId;
    assert.equal((await get(`${q}&roomId=${beta}`, admin)).body.items.length, 2);
    const bad = await get('to=2033-02-01T00:00:00Z', admin);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_INPUT');
  } finally { server.closeAllConnections?.(); await new Promise(r => server.close(r)); }
});

test('p4.6 the project has its own report tests', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['utilisationReport', 'rankInWeek', 'changeFromPreviousWeek']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
