import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); });
after(async () => { await pool?.end(); });

test('listBookings: cùng giờ bắt đầu thì theo tên phòng (không phân biệt hoa thường), phân trang đúng', { skip }, async () => {
  const t = unique('thu-tu');
  const rooms = [];
  for (const n of ['charlie', 'Alpha', 'bravo']) rooms.push(await repo.createRoom({ name: `${t} ${n}`, capacity: 3 }));
  const s = new Date(Date.UTC(2031, 10, 3, 4, 13)), e = new Date(s.getTime() + 3_600_000);
  for (const r of rooms) await repo.createBooking({ roomId: r.id, title: 'x', organizer: 'y', startsAt: s, endsAt: e });
  const ours = new Set(rooms.map(r => r.id));
  const seen = [];
  let cursor;
  do {
    const page = await repo.listBookings({ from: s, to: new Date(s.getTime() + 1), limit: 1, cursor });
    seen.push(...page.items.filter(b => ours.has(b.roomId)).map(b => rooms.find(r => r.id === b.roomId).name.split(' ').at(-1)));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['Alpha', 'bravo', 'charlie']);
});
