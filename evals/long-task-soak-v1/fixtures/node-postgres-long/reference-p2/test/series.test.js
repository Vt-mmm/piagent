import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, BookingError } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); });
after(async () => { await pool?.end(); });

const code = c => e => e instanceof BookingError && e.code === c;
const at = (d, h) => new Date(Date.UTC(2031, 5, d, h));
const room = () => repo.createRoom({ name: unique('Phòng chuỗi'), capacity: 8 });
const series = (r, recurrence, s = at(2, 9), e = at(2, 10)) => repo.createRecurringBooking({ roomId: r.id, title: 'Giao ban', organizer: 'an', startsAt: s, endsAt: e, recurrence });

test('createRecurringBooking: weekly count, daily until', { skip }, async () => {
  const r = await room();
  const w = await series(r, { freq: 'weekly', count: 3 });
  assert.equal(w.bookings.length, 3);
  assert.ok(w.bookings.every(b => b.seriesId === w.seriesId));
  assert.equal(w.bookings[2].startsAt - w.bookings[0].startsAt, 14 * 86_400_000);
  const d = await series(r, { freq: 'daily', interval: 2, until: at(9, 11) }, at(3, 11), at(3, 12));
  assert.deepEqual(d.bookings.map(b => b.startsAt.getUTCDate()), [3, 5, 7, 9]);
  for (const bad of [{ freq: 'monthly', count: 2 }, { freq: 'daily' }, { freq: 'daily', count: 2, until: at(9, 9) }, { freq: 'daily', count: 400 }]) {
    await assert.rejects(series(r, bad, at(20, 9), at(20, 10)), code('INVALID_INPUT'));
  }
});

test('một buổi trùng thì từ chối cả chuỗi, báo mọi buổi trùng', { skip }, async () => {
  const r = await room();
  await repo.createBooking({ roomId: r.id, title: 'x', organizer: 'b', startsAt: at(9, 9), endsAt: at(9, 10) });
  await repo.createBooking({ roomId: r.id, title: 'x', organizer: 'b', startsAt: at(23, 9), endsAt: new Date(at(23, 9).getTime() + 1_800_000) });
  const err = await series(r, { freq: 'weekly', count: 4 }).catch(e => e);
  assert.ok(code('BOOKING_CONFLICT')(err));
  assert.deepEqual(err.conflicts.map(c => c.startsAt.getUTCDate()), [9, 23]);
  assert.equal((await repo.listBookings({ roomId: r.id })).items.length, 2);
});

test('cancelSeries và hai chuỗi đồng thời', { skip }, async () => {
  const r = await room();
  const results = await Promise.allSettled([0, 1, 2].map(i => series(r, { freq: 'daily', count: 3 }, new Date(at(2, 9).getTime() + i * 900_000), new Date(at(2, 10).getTime() + i * 900_000))));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const won = results.find(x => x.status === 'fulfilled').value;
  assert.equal(await repo.cancelSeries(won.seriesId), 3);
  await assert.rejects(repo.cancelSeries(2_000_000_000), code('NOT_FOUND'));
});
