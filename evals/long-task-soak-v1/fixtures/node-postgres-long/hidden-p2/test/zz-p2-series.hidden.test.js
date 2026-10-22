// Hidden acceptance checks (phase p2): recurring bookings from
// docs/backlog/02-lich-dinh-ky.md and the member's decision (one conflicting
// occurrence rejects the whole series; the error lists every conflict).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { createRepository, migrate, BookingError } from '../src/index.js';

let pool, repo;
before(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
  await migrate(pool);
  repo = createRepository(pool);
});
after(async () => { await pool?.end(); });

const code = c => err => {
  assert.ok(err instanceof BookingError, `expected BookingError ${c}, got ${err?.constructor?.name}: ${err?.message}`);
  assert.equal(err.code, c);
  return true;
};
const DAY = 86_400_000, H = 3_600_000;
const tag = () => Math.random().toString(36).slice(2, 9);
const at = (month, day, h) => new Date(Date.UTC(2034, month - 1, day, Math.floor(h), Math.round((h % 1) * 60)));
const newRoom = () => repo.createRoom({ name: `P2 ${tag()}`, capacity: 6 });
const series = (room, recurrence, s, e, extra = {}) => repo.createRecurringBooking({ roomId: room.id, title: ' Giao ban ', organizer: ' lan ', startsAt: s, endsAt: e, recurrence, ...extra });
const single = (room, s, e) => repo.createBooking({ roomId: room.id, title: 'Lẻ', organizer: 'minh', startsAt: s, endsAt: e });
const count = async room => (await pool.query('SELECT count(*)::int AS n FROM bookings WHERE room_id = $1', [room.id])).rows[0].n;

test('p2.1 weekly with count: shape, seriesId everywhere', async () => {
  const room = await newRoom();
  const r = await series(room, { freq: 'weekly', count: 4 }, at(1, 2, 9), at(1, 2, 10));
  assert.ok(Number.isInteger(r.seriesId), 'seriesId is an integer');
  assert.equal(r.bookings.length, 4);
  r.bookings.forEach((b, k) => {
    assert.equal(b.startsAt.getTime(), at(1, 2, 9).getTime() + k * 7 * DAY);
    assert.equal(b.endsAt.getTime(), at(1, 2, 10).getTime() + k * 7 * DAY);
    assert.equal(b.seriesId, r.seriesId);
    assert.equal(b.title, 'Giao ban');
    assert.equal(b.organizer, 'lan');
    assert.equal(b.roomId, room.id);
  });
  assert.equal((await repo.getBooking(r.bookings[2].id)).seriesId, r.seriesId);
  const one = await single(room, at(1, 3, 9), at(1, 3, 10));
  assert.equal(one.seriesId, null);
  assert.equal((await repo.getBooking(one.id)).seriesId, null);
  const listed = (await repo.listBookings({ roomId: room.id, limit: 100 })).items;
  assert.equal(listed.length, 5);
  assert.deepEqual(listed.map(b => b.seriesId).sort(), [r.seriesId, r.seriesId, r.seriesId, r.seriesId, null].sort());
  const other = await series(room, { freq: 'weekly', count: 1 }, at(1, 4, 9), at(1, 4, 10));
  assert.notEqual(other.seriesId, r.seriesId);
});

test('p2.2 daily with until (inclusive) and interval', async () => {
  const room = await newRoom();
  const a = await series(room, { freq: 'daily', interval: 2, until: at(2, 7, 8) }, at(2, 1, 8), at(2, 1, 9));
  assert.deepEqual(a.bookings.map(b => b.startsAt.getUTCDate()), [1, 3, 5, 7]);
  const b = await series(room, { freq: 'daily', interval: 2, until: new Date(at(2, 7, 8) - 1000).toISOString() }, at(2, 1, 10), at(2, 1, 11));
  assert.deepEqual(b.bookings.map(x => x.startsAt.getUTCDate()), [1, 3, 5]);
  const c = await series(room, { freq: 'weekly', interval: 3, count: 3 }, at(2, 1, 12).toISOString(), at(2, 1, 13).toISOString());
  assert.deepEqual(c.bookings.map(x => (x.startsAt - at(2, 1, 12)) / DAY), [0, 21, 42]);
  const d = await series(room, { freq: 'daily', until: at(2, 1, 14) }, at(2, 1, 14), at(2, 1, 15));
  assert.equal(d.bookings.length, 1, 'until equal to the first start gives one occurrence');
});

test('p2.3 validation', async () => {
  const room = await newRoom();
  const s = at(3, 1, 9), e = at(3, 1, 10);
  const bad = [
    [{ freq: 'monthly', count: 2 }], [{ freq: 'daily' }], [{ freq: 'daily', count: 2, until: at(3, 9, 9) }],
    [{ freq: 'daily', count: 0 }], [{ freq: 'daily', count: 367 }], [{ freq: 'daily', count: 2.5 }], [{ freq: 'daily', count: '3' }],
    [{ freq: 'weekly', interval: 0, count: 2 }], [{ freq: 'weekly', interval: 53, count: 2 }], [{ freq: 'weekly', interval: 1.5, count: 2 }],
    [{ freq: 'daily', until: at(3, 1, 8) }],
    [{ freq: 'daily', until: new Date(s.getTime() + 400 * DAY) }],
    [{ freq: 'daily', count: 2 }, s, new Date(s.getTime() + 25 * H)],
    [{ freq: 'daily', count: 2 }, s, new Date(s.getTime() + 24 * H)],
    [{ freq: 'daily', count: 2 }, e, s],
    [undefined],
  ];
  for (const [recurrence, s2 = s, e2 = e] of bad) await assert.rejects(series(room, recurrence, s2, e2), code('INVALID_INPUT'), JSON.stringify(recurrence));
  await assert.rejects(series(room, { freq: 'daily', count: 2 }, s, e, { title: '  ' }), code('INVALID_INPUT'));
  await assert.rejects(series({ id: 2_000_000_000 }, { freq: 'daily', count: 2 }, s, e), code('NOT_FOUND'));
  assert.equal(await count(room), 0, 'nothing written by rejected series');
  const ok = await series(room, { freq: 'daily', interval: 3, count: 366 }, s, new Date(s.getTime() + 71 * H));
  assert.equal(ok.bookings.length, 366);
});

test('p2.4 decision: a conflicting occurrence rejects the whole series and every conflict is reported', async () => {
  const room = await newRoom();
  const s = at(4, 3, 9), e = at(4, 3, 10), occ = k => [new Date(s.getTime() + k * 7 * DAY), new Date(e.getTime() + k * 7 * DAY)];
  const [s1] = occ(1), [s3, e3] = occ(3), [s2] = occ(2), [s4, e4] = occ(4);
  const c1 = await single(room, new Date(s1.getTime() + 30 * 60_000), new Date(s1.getTime() + 90 * 60_000)); // partial overlap with occurrence 1
  const c3 = await single(room, s3, e3);                                                                     // same time as occurrence 3
  await single(room, new Date(s2.getTime() - H), s2);                                                       // back-to-back: not a conflict
  const gone = await single(room, s4, e4); await repo.cancelBooking(gone.id);                               // cancelled: not a conflict
  const before = await count(room);
  const err = await series(room, { freq: 'weekly', count: 6 }, s, e).catch(x => x);
  code('BOOKING_CONFLICT')(err);
  assert.ok(Array.isArray(err.conflicts), 'error.conflicts lists the conflicting occurrences');
  assert.deepEqual(err.conflicts.map(c => new Date(c.startsAt).getTime()), [occ(1)[0].getTime(), occ(3)[0].getTime()]);
  assert.deepEqual(err.conflicts.map(c => new Date(c.endsAt).getTime()), [occ(1)[1].getTime(), occ(3)[1].getTime()]);
  assert.equal(await count(room), before, 'no occurrence is written when the series is rejected');
  await repo.cancelBooking(c1.id); await repo.cancelBooking(c3.id);
  const r = await series(room, { freq: 'weekly', count: 6 }, s, e);
  assert.equal(r.bookings.length, 6);
});

test('p2.5 cancelSeries', async () => {
  const room = await newRoom();
  const r = await series(room, { freq: 'daily', count: 5 }, at(5, 1, 9), at(5, 1, 10));
  await repo.cancelBooking(r.bookings[0].id);
  assert.equal(await repo.cancelSeries(r.seriesId), 4);
  assert.equal((await repo.listBookings({ roomId: room.id })).items.length, 0);
  const all = (await repo.listBookings({ roomId: room.id, includeCancelled: true })).items;
  assert.equal(all.length, 5);
  assert.ok(all.every(b => b.cancelledAt instanceof Date && b.seriesId === r.seriesId));
  assert.equal(await repo.cancelSeries(r.seriesId), 0);
  await assert.rejects(repo.cancelSeries(2_000_000_000), code('NOT_FOUND'));
  assert.equal((await series(room, { freq: 'daily', count: 5 }, at(5, 1, 9), at(5, 1, 10))).bookings.length, 5, 'the slots are free again');
});

test('p2.6 concurrent overlapping series: exactly one wins', async () => {
  for (let round = 0; round < 3; round++) {
    const room = await newRoom();
    const base = at(6, 1 + round, 9);
    const runs = Array.from({ length: 6 }, (_, i) => series(room, { freq: 'daily', count: 4 },
      new Date(base.getTime() + (i % 3) * 15 * 60_000 + (i >= 3 ? 2 * DAY : 0)), new Date(base.getTime() + H + (i % 3) * 15 * 60_000 + (i >= 3 ? 2 * DAY : 0))));
    const results = await Promise.allSettled(runs);
    const won = results.filter(r => r.status === 'fulfilled');
    assert.equal(won.length, 1, `round ${round}: ${won.length} overlapping series were written`);
    for (const r of results.filter(r => r.status === 'rejected')) code('BOOKING_CONFLICT')(r.reason);
    assert.equal(await count(room), 4);
  }
});

test('p2.7 the project has its own tests for recurring bookings', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['createRecurringBooking', 'cancelSeries', 'conflicts', 'until', 'count']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
