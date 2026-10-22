import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, BookingError } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); });
after(async () => { await pool?.end(); });

// 2031-03-03 là thứ Hai; tuần giờ Việt Nam bắt đầu 2031-03-02T17:00Z.
test('utilisationReport: tuần theo giờ Việt Nam, bỏ lịch đã huỷ, rank, change', { skip }, async () => {
  const a = await repo.createRoom({ name: unique('Báo cáo A'), capacity: 5 });
  const book = (s, e) => repo.createBooking({ roomId: a.id, title: 'x', organizer: 'y', startsAt: s, endsAt: e });
  await book('2031-03-02T18:00Z', '2031-03-02T19:00Z');   // thứ Hai 01:00 giờ VN
  await book('2031-03-02T16:00Z', '2031-03-02T16:30Z');   // Chủ nhật 23:00 giờ VN: tuần trước
  const gone = await book('2031-03-04T02:00Z', '2031-03-04T06:00Z'); await repo.cancelBooking(gone.id);
  const rows = await repo.utilisationReport({ from: '2031-02-20T00:00Z', to: '2031-03-20T00:00Z', roomId: a.id });
  assert.deepEqual(rows.map(r => [r.weekStart.toISOString(), r.bookedMinutes, r.rankInWeek, r.changeFromPreviousWeek]),
    [['2031-02-23T17:00:00.000Z', 30, 1, null], ['2031-03-02T17:00:00.000Z', 60, 1, 30]]);
  assert.equal(rows[1].utilisation, 0.02);
  await assert.rejects(repo.utilisationReport({ from: '2031-03-02', to: '2031-03-01' }), e => e instanceof BookingError && e.code === 'INVALID_INPUT');
});
