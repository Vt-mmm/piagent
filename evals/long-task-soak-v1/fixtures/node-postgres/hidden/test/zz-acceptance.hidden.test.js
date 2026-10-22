// Hidden acceptance checks for SPEC.md and the member's decisions (soft-delete
// cancellation with cancelled_at; back-to-back bookings do not conflict).
// The soak oracle lays this over the agent's work and runs it against a
// throwaway PostgreSQL (hidden/scripts/oracle.sh).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { createRepository, migrate, BookingError } from '../src/index.js';

let pool, repo;
before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
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
const tag = () => Math.random().toString(36).slice(2, 9);
const at = (h, day = 12) => new Date(Date.UTC(2032, 2, day, Math.floor(h), Math.round((h % 1) * 60)));
const newRoom = (capacity = 6) => repo.createRoom({ name: `Hidden ${tag()}`, capacity });
const book = (room, s, e, extra = {}) => repo.createBooking({ roomId: room.id, title: 'Sprint review', organizer: 'linh', startsAt: at(s), endsAt: at(e), ...extra });
const hours = page => page.items.map(b => b.startsAt.getUTCHours() + b.startsAt.getUTCMinutes() / 60);

test('1 migrations: idempotent, new file only, bookings table present', async () => {
  await migrate(pool);
  await migrate(pool);
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2 && files[0] === '001_rooms.sql', `migrations: ${files}`);
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'`)).rows.map(r => r.column_name);
  for (const c of ['id', 'room_id', 'title', 'organizer', 'starts_at', 'ends_at', 'created_at']) assert.ok(cols.includes(c), `bookings.${c} missing`);
});

test('2 rooms: validation, case-insensitive unique name, list, update, delete', async () => {
  const base = `Phòng Xanh ${tag()}`;
  const room = await repo.createRoom({ name: `  ${base}  `, capacity: 4 });
  assert.equal(typeof room.id, 'number');
  assert.equal(room.name, base);
  assert.ok(room.createdAt instanceof Date);
  await assert.rejects(repo.createRoom({ name: base.toUpperCase(), capacity: 4 }), code('ROOM_NAME_TAKEN'));
  for (const bad of [{ name: '   ', capacity: 4 }, { name: `x ${tag()}`, capacity: 0 }, { name: `x ${tag()}`, capacity: 2.5 }, { name: `x ${tag()}`, capacity: 501 }]) {
    await assert.rejects(repo.createRoom(bad), code('INVALID_INPUT'));
  }
  assert.equal((await repo.createRoom({ name: `y ${tag()}`, capacity: 500 })).capacity, 500);
  assert.deepEqual(await repo.getRoom(room.id), room);
  assert.equal(await repo.getRoom(2_000_000_000), null);

  const other = await newRoom();
  await assert.rejects(repo.updateRoom(other.id, { name: ` ${base.toLowerCase()} ` }), code('ROOM_NAME_TAKEN'));
  await assert.rejects(repo.updateRoom(other.id, { capacity: -3 }), code('INVALID_INPUT'));
  const updated = await repo.updateRoom(room.id, { capacity: 9 });
  assert.equal(updated.capacity, 9);
  assert.equal(updated.name, base);
  assert.equal((await repo.updateRoom(room.id, { name: `${base} B` })).capacity, 9);
  await assert.rejects(repo.updateRoom(2_000_000_000, { capacity: 3 }), code('NOT_FOUND'));

  const names = (await repo.listRooms()).map(r => r.name);
  assert.ok(names.includes(`${base} B`) && names.includes(other.name));
  const ours = names.filter(n => n === `${base} B` || n === other.name);
  assert.deepEqual(ours, [...ours].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

  await repo.deleteRoom(other.id);
  assert.equal(await repo.getRoom(other.id), null);
  await assert.rejects(repo.deleteRoom(other.id), code('NOT_FOUND'));
});

test('3 createBooking: shape, validation, overlap per room', async () => {
  const room = await newRoom(), second = await newRoom();
  const b = await repo.createBooking({ roomId: room.id, title: '  Kế hoạch Q3 ', organizer: ' mai ', startsAt: at(9).toISOString(), endsAt: at(10.5) });
  assert.equal(typeof b.id, 'number');
  assert.equal(b.roomId, room.id);
  assert.equal(b.title, 'Kế hoạch Q3');
  assert.equal(b.organizer, 'mai');
  assert.ok(b.startsAt instanceof Date && b.endsAt instanceof Date && b.createdAt instanceof Date);
  assert.equal(b.startsAt.getTime(), at(9).getTime());
  assert.ok(!b.cancelledAt, 'an active booking is not cancelled');
  assert.deepEqual(await repo.getBooking(b.id), b);
  assert.equal(await repo.getBooking(2_000_000_000), null);

  const bad = [
    { startsAt: at(11), endsAt: at(11) }, { startsAt: at(12), endsAt: at(11) },
    { startsAt: 'not a date', endsAt: at(11) }, { startsAt: at(11), endsAt: new Date(NaN) },
    { title: '   ' }, { organizer: '' },
  ];
  for (const patch of bad) await assert.rejects(book(room, 11, 12, patch), code('INVALID_INPUT'));
  await assert.rejects(book({ id: 2_000_000_000 }, 11, 12), code('NOT_FOUND'));

  for (const [s, e] of [[9, 10.5], [8, 9.5], [10, 11], [9.25, 9.75], [8, 12]]) await assert.rejects(book(room, s, e), code('BOOKING_CONFLICT'));
  await book(second, 9, 10.5);
});

test('4 decision: back-to-back bookings do not conflict', async () => {
  const room = await newRoom();
  await book(room, 9, 10);
  await book(room, 10, 11);
  await book(room, 8, 9);
  await assert.rejects(book(room, 9.5, 10.5), code('BOOKING_CONFLICT'));
});

test('4 concurrency: only one of many overlapping bookings wins', async () => {
  for (let round = 0; round < 3; round++) {
    const room = await newRoom();
    const slots = Array.from({ length: 10 }, (_, i) => [13 + (i % 3) * 0.25, 14 + (i % 3) * 0.25]);
    const results = await Promise.allSettled(slots.map(([s, e]) => book(room, s, e)));
    const won = results.filter(r => r.status === 'fulfilled');
    assert.equal(won.length, 1, `round ${round}: ${won.length} overlapping bookings were accepted`);
    for (const r of results.filter(r => r.status === 'rejected')) code('BOOKING_CONFLICT')(r.reason);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM bookings WHERE room_id = $1', [room.id]);
    assert.equal(rows[0].n, 1);
  }
});

test('5 decision: cancelling is a soft delete with cancelled_at', async () => {
  const room = await newRoom();
  const b = await book(room, 15, 16);
  const cancelled = await repo.cancelBooking(b.id);
  assert.equal(cancelled.id, b.id);
  assert.ok(cancelled.cancelledAt instanceof Date, 'cancelBooking returns cancelledAt');
  const row = (await pool.query('SELECT cancelled_at FROM bookings WHERE id = $1', [b.id])).rows[0];
  assert.ok(row && row.cancelled_at instanceof Date, 'the row is kept with cancelled_at set');
  const again = await repo.getBooking(b.id);
  assert.ok(again && again.cancelledAt instanceof Date, 'getBooking still returns a cancelled booking');
  await assert.rejects(repo.cancelBooking(b.id), code('ALREADY_CANCELLED'));
  await assert.rejects(repo.cancelBooking(2_000_000_000), code('NOT_FOUND'));

  const replacement = await book(room, 15, 16);
  assert.equal((await repo.listBookings({ roomId: room.id })).items.map(x => x.id).join(), String(replacement.id));
  const all = await repo.listBookings({ roomId: room.id, includeCancelled: true });
  assert.deepEqual(all.items.map(x => x.id), [b.id, replacement.id]);
  assert.ok(all.items[0].cancelledAt instanceof Date);

  await assert.rejects(repo.deleteRoom(room.id), code('ROOM_IN_USE'));
  await repo.cancelBooking(replacement.id);
  await repo.deleteRoom(room.id);
  assert.equal(await repo.getRoom(room.id), null);
});

test('6 listBookings: filters, order, limits', async () => {
  const room = await newRoom(), other = await newRoom();
  const ids = [];
  for (const h of [12, 9, 10, 15]) ids.push((await book(room, h, h + 1)).id);
  await book(other, 9, 10);
  assert.deepEqual(hours(await repo.listBookings({ roomId: room.id })), [9, 10, 12, 15]);
  assert.deepEqual(hours(await repo.listBookings({ roomId: room.id, from: at(10), to: at(15) })), [10, 12]);
  assert.deepEqual(hours(await repo.listBookings({ roomId: room.id, from: at(10.5).toISOString(), to: at(15.5).toISOString() })), [10, 12, 15]);
  const day = await repo.listBookings({ from: at(9), to: at(10), limit: 100 });
  assert.ok(day.items.some(b => b.roomId === other.id) && day.items.some(b => b.roomId === room.id));
  const keys = day.items.map(b => [b.startsAt.getTime(), b.id]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  for (const limit of [0, 101, 2.5, '5']) await assert.rejects(repo.listBookings({ roomId: room.id, limit }), code('INVALID_INPUT'));
  assert.equal((await repo.listBookings({ roomId: room.id, limit: 100 })).items.length, 4);
});

test('6 listBookings: keyset cursor pagination', async () => {
  const room = await newRoom();
  for (const h of [8, 9, 10, 11, 12, 13]) await book(room, h, h + 0.5, { title: `B${h}` });
  const p1 = await repo.listBookings({ roomId: room.id, limit: 2 });
  assert.deepEqual(hours(p1), [8, 9]);
  assert.equal(typeof p1.nextCursor, 'string');
  await book(room, 6, 7);
  await book(room, 7, 7.5);
  const p2 = await repo.listBookings({ roomId: room.id, limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(hours(p2), [10, 11]);
  const p3 = await repo.listBookings({ roomId: room.id, limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(hours(p3), [12, 13]);
  assert.equal(p3.nextCursor, null, 'no next cursor when nothing follows, even on a full page');
  const whole = await repo.listBookings({ roomId: room.id, limit: 8 });
  assert.equal(whole.items.length, 8);
  assert.equal(whole.nextCursor, null);
  const partial = await repo.listBookings({ roomId: room.id, limit: 7 });
  assert.equal(typeof partial.nextCursor, 'string');
  await assert.rejects(repo.listBookings({ roomId: room.id, cursor: 'definitely-not-a-cursor' }), code('INVALID_INPUT'));

  // Same start time: ties broken by id.
  const tie = await newRoom(), tie2 = await newRoom();
  const x = await book(tie, 9, 10), y = await book(tie2, 9, 10);
  const tied = await repo.listBookings({ from: at(9), to: at(9.01), limit: 100 });
  const pos = id => tied.items.findIndex(b => b.id === id);
  assert.ok(pos(x.id) >= 0 && pos(x.id) < pos(y.id));
});

test('7 the project has its own integration tests for the new behaviour', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['DATABASE_URL', 'updateRoom', 'deleteRoom', 'createBooking', 'BOOKING_CONFLICT', 'cancelBooking', 'listBookings', 'includeCancelled', 'cursor']) {
    assert.ok(text.includes(word), `no own test mentions ${word}`);
  }
  assert.ok(/Promise\.all(Settled)?\(/.test(text), 'no own test exercises concurrent bookings');
});
