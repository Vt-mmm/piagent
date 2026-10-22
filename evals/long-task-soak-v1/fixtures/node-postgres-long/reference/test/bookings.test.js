import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, migrate, BookingError } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); });
after(async () => { await pool?.end(); });

const code = c => e => e instanceof BookingError && e.code === c;
const at = h => new Date(Date.UTC(2031, 0, 5, Math.floor(h), (h % 1) * 60));
const room = () => repo.createRoom({ name: unique('Phòng'), capacity: 8 });
const book = (r, s, e, title = 'Họp') => repo.createBooking({ roomId: r.id, title, organizer: 'an', startsAt: at(s), endsAt: at(e) });

test('migrate chạy lại không lỗi', { skip }, async () => { assert.deepEqual(await migrate(pool), []); });

test('rooms: validate, case-insensitive name, update, list, delete', { skip }, async () => {
  const name = unique('Phòng Lớn');
  const r = await repo.createRoom({ name, capacity: 10 });
  await assert.rejects(repo.createRoom({ name: ` ${name.toLowerCase()} `, capacity: 2 }), code('ROOM_NAME_TAKEN'));
  await assert.rejects(repo.createRoom({ name: ' ', capacity: 2 }), code('INVALID_INPUT'));
  await assert.rejects(repo.createRoom({ name: unique('x'), capacity: 501 }), code('INVALID_INPUT'));
  assert.equal((await repo.updateRoom(r.id, { capacity: 12 })).capacity, 12);
  await assert.rejects(repo.updateRoom(-1, { capacity: 2 }), code('NOT_FOUND'));
  assert.ok((await repo.listRooms()).some(x => x.id === r.id));
  await repo.deleteRoom(r.id);
  assert.equal(await repo.getRoom(r.id), null);
  await assert.rejects(repo.deleteRoom(r.id), code('NOT_FOUND'));
});

test('createBooking: validation, overlap, back-to-back allowed', { skip }, async () => {
  const r = await room();
  await assert.rejects(repo.createBooking({ roomId: r.id, title: 'x', organizer: 'a', startsAt: at(10), endsAt: at(9) }), code('INVALID_INPUT'));
  await assert.rejects(repo.createBooking({ roomId: -1, title: 'x', organizer: 'a', startsAt: at(9), endsAt: at(10) }), code('NOT_FOUND'));
  await book(r, 9, 10);
  await book(r, 10, 11);
  await assert.rejects(book(r, 9.5, 10.5), code('BOOKING_CONFLICT'));
  await assert.rejects(repo.deleteRoom(r.id), code('ROOM_IN_USE'));
});

test('BOOKING_CONFLICT khi đồng thời: chỉ một lệnh thắng', { skip }, async () => {
  const r = await room();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => book(r, 14 + (i % 4) * 0.25, 15 + (i % 4) * 0.25)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => code('BOOKING_CONFLICT')(x.reason)));
});

test('cancelBooking là xoá mềm, includeCancelled', { skip }, async () => {
  const r = await room();
  const b = await book(r, 9, 10);
  const cancelled = await repo.cancelBooking(b.id);
  assert.ok(cancelled.cancelledAt instanceof Date);
  await assert.rejects(repo.cancelBooking(b.id), code('ALREADY_CANCELLED'));
  await book(r, 9, 10);
  assert.equal((await repo.listBookings({ roomId: r.id })).items.length, 1);
  assert.equal((await repo.listBookings({ roomId: r.id, includeCancelled: true })).items.length, 2);
});

test('listBookings phân trang theo con trỏ', { skip }, async () => {
  const r = await room();
  for (const h of [8, 9, 10, 11, 12]) await book(r, h, h + 1);
  const p1 = await repo.listBookings({ roomId: r.id, limit: 2 });
  await book(r, 6, 7);
  const p2 = await repo.listBookings({ roomId: r.id, limit: 2, cursor: p1.nextCursor });
  const p3 = await repo.listBookings({ roomId: r.id, limit: 2, cursor: p2.nextCursor });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map(b => b.startsAt.getUTCHours()), [8, 9, 10, 11, 12]);
  assert.equal(p3.nextCursor, null);
  await assert.rejects(repo.listBookings({ limit: 0 }), code('INVALID_INPUT'));
});
