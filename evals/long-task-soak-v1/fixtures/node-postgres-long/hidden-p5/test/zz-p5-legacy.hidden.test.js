// Hidden acceptance checks (phase p5): importing data/legacy-bookings.csv per
// docs/backlog/05-chuyen-du-lieu-cu.md and the rules of legacy/import-old.js,
// plus the member's decision (legacy rows overlapping existing bookings are
// imported cancelled with cancelled_reason 'legacy-conflict'). Ground truth in
// legacy-expected.json comes from the fixture generator's own model of every
// row (fixtures/node-postgres-long/generate/). Runs on a fresh database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRepository, migrate, importLegacy } from '../src/index.js';
import { freshDatabase, run } from './zz-fresh-db.hidden.js';

const expected = JSON.parse(readFileSync(new URL('./legacy-expected.json', import.meta.url), 'utf8'));
const FILE = fileURLToPath(new URL('../data/legacy-bookings.csv', import.meta.url));
let url, pool, repo;
const existingIds = [];
before(async () => {
  url = await freshDatabase('soak_p5');
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await migrate(pool);
  repo = createRepository(pool);
  // Bookings members made in the new system before the migration.
  const rooms = new Map();
  for (const e of expected.existing) {
    if (!rooms.has(e.room)) rooms.set(e.room, await repo.createRoom({ name: e.room, capacity: 20 }));
    existingIds.push((await repo.createBooking({ roomId: rooms.get(e.room).id, title: 'Đặt trên hệ thống mới', organizer: 'nguoi-moi', startsAt: e.startsAt, endsAt: e.endsAt })).id);
  }
});
after(async () => { await pool?.end(); });

const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM bookings) AS bookings, (SELECT count(*)::int FROM rooms) AS rooms`)).rows[0];
const problemsOf = report => (report.problems ?? []).map(p => ({ line: p.line, legacyId: p.legacyId, reason: p.reason }));
const legacyRow = async id => (await pool.query(`SELECT b.*, r.name AS room_name, r.capacity FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.legacy_id = $1`, [id])).rows[0];
const iso = d => d && new Date(d).toISOString();

test('p5.1 dry run: the full report, nothing written', async () => {
  const before = await counts();
  const report = await importLegacy(pool, { file: FILE, dryRun: true });
  assert.equal(report.total, expected.total, 'total data rows');
  assert.equal(report.skipped, expected.skipped, 'skipped');
  assert.deepEqual(problemsOf(report), expected.problems, 'problems: line, legacyId and reason of every skipped row, in line order');
  assert.equal(report.imported, expected.imported, 'rows that would be imported');
  assert.equal(report.alreadyImported, 0);
  assert.equal(report.conflicts, expected.conflicts, 'active legacy rows overlapping bookings already in the new system');
  assert.deepEqual(await counts(), before, 'a dry run writes nothing, rooms included');
});

test('p5.2 import: same report, rooms, every row, under a minute', async () => {
  const before = await counts();
  const started = Date.now();
  const report = await importLegacy(pool, { file: FILE });
  const ms = Date.now() - started;
  assert.ok(ms < 60_000, `import took ${ms} ms`);
  assert.equal(report.total, expected.total);
  assert.equal(report.imported, expected.imported);
  assert.equal(report.alreadyImported, 0);
  assert.equal(report.conflicts, expected.conflicts);
  assert.deepEqual(problemsOf(report), expected.problems);
  const after = await counts();
  assert.equal(after.bookings, before.bookings + expected.imported, 'bookings written');
  const { rows } = await pool.query(`SELECT r.name, r.capacity, count(b.legacy_id)::int AS n FROM rooms r LEFT JOIN bookings b ON b.room_id = r.id AND b.legacy_id IS NOT NULL GROUP BY r.id`);
  assert.equal(rows.length, Object.keys(expected.rooms).length, `rooms: ${rows.map(r => r.name).join(', ')}`);
  const preCreated = new Set(expected.existing.map(e => e.room));
  for (const [name, want] of Object.entries(expected.rooms)) {
    const got = rows.find(r => r.name === name);
    assert.ok(got, `room ${name} exists`);
    assert.equal(got.n, want.bookings, `legacy bookings in ${name}`);
    if (!preCreated.has(name)) assert.equal(got.capacity, want.capacity, `capacity of ${name} from the old catalogue`);
  }
  const { rows: [c] } = await pool.query(`SELECT count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled FROM bookings WHERE legacy_id IS NOT NULL`);
  assert.equal(c.cancelled, expected.cancelledInFile + expected.conflicts, 'cancelled legacy rows = cancelled in the file + conflicts');
  const skippedIds = expected.problems.map(p => p.legacyId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE legacy_id = ANY($1)', [skippedIds])).rows[0].n, 0, 'skipped rows are not imported');
});

test('p5.3 rows are read exactly like the old system read them', async () => {
  const wrong = [];
  for (const [quirk, want] of Object.entries(expected.samples)) {
    if (expected.conflictIds.includes(want.legacyId)) continue;
    const got = await legacyRow(want.legacyId);
    if (!got) { wrong.push(`${quirk}: ${want.legacyId} not imported`); continue; }
    const have = { room: got.room_name, startsAt: iso(got.starts_at), endsAt: iso(got.ends_at), title: got.title, organizer: got.organizer,
      cancelled: got.cancelled_at !== null, cancelledAt: iso(got.cancelled_at) ?? null };
    const need = { room: want.room, startsAt: want.startsAt, endsAt: want.endsAt, title: want.title, organizer: want.organizer, cancelled: want.cancelled, cancelledAt: want.cancelledAt };
    for (const k of Object.keys(need)) if (have[k] !== need[k]) wrong.push(`${quirk} (${want.legacyId}) ${k}: got ${JSON.stringify(have[k])}, want ${JSON.stringify(need[k])}`);
  }
  assert.deepEqual(wrong, []);
});

test('p5.4 decision: legacy rows overlapping existing bookings are imported cancelled as legacy-conflict', async () => {
  for (const id of expected.conflictIds) {
    const got = await legacyRow(id);
    assert.ok(got, `${id} is imported, not skipped`);
    assert.ok(got.cancelled_at instanceof Date, `${id} is cancelled`);
    assert.equal(got.cancelled_reason, 'legacy-conflict', `${id} cancelled_reason`);
    const want = expected.samples[`fixture row ${id}`];
    assert.equal(iso(got.starts_at), want.startsAt);
    assert.equal(got.title, want.title);
  }
  for (const id of expected.notConflicts) assert.notEqual((await legacyRow(id))?.cancelled_reason, 'legacy-conflict', `${id} is not a conflict`);
  for (const [i, bookingId] of existingIds.entries()) {
    const b = await repo.getBooking(bookingId);
    assert.ok(b, 'existing booking kept');
    assert.ok(!b.cancelledAt, 'existing booking stays active');
    assert.equal(iso(b.startsAt), expected.existing[i].startsAt);
    assert.equal(b.organizer, 'nguoi-moi');
  }
});

test('p5.5 re-running imports nothing twice; the CLI reports the same', async () => {
  const before = await counts();
  const again = await importLegacy(pool, { file: FILE });
  assert.equal(again.imported, 0);
  assert.equal(again.alreadyImported, expected.imported);
  assert.equal(again.conflicts, 0);
  assert.equal(again.skipped, expected.skipped);
  assert.deepEqual(await counts(), before);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts?.['import:legacy'], 'package.json has an import:legacy script');
  const cli = await run('npm', ['run', '--silent', 'import:legacy', '--', 'data/legacy-bookings.csv', '--dry-run'], { databaseUrl: url, timeoutMs: 120_000 });
  assert.equal(cli.code, 0, cli.stderr.slice(-1500));
  const text = cli.stdout;
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  assert.equal(json.total, expected.total);
  assert.equal(json.alreadyImported, expected.imported);
  assert.equal(json.skipped, expected.skipped);
  assert.deepEqual(await counts(), before, 'the CLI dry run writes nothing');
});

test('p5.6 the project has its own importer tests', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['importLegacy', 'dryRun', 'legacy-conflict', 'alreadyImported']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
