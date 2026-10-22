// npm run db:seed — dữ liệu mẫu: 5 phòng, đặt lịch trong 4 tuần tới (có một
// chuỗi định kỳ và một lịch đã huỷ), token cho admin và demo. Chạy lại thì
// thay dữ liệu mẫu cũ, không nhân đôi.
import pg from 'pg';
import { migrate, createRepository } from '../src/index.js';

if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ROOMS = [['Mẫu Sen', 8], ['Mẫu Mai', 6], ['Mẫu Lan', 12], ['Mẫu Cúc', 4], ['Mẫu Hội trường', 120]];
try {
  await migrate(pool);
  const repo = createRepository(pool);
  const existing = (await repo.listRooms()).filter(r => r.name.startsWith('Mẫu '));
  await pool.query('DELETE FROM rooms WHERE id = ANY($1)', [existing.map(r => r.id)]);
  await pool.query(`DELETE FROM api_tokens WHERE username IN ('admin', 'demo')`);
  const rooms = [];
  for (const [name, capacity] of ROOMS) rooms.push(await repo.createRoom({ name, capacity }));
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const at = (day, hour) => new Date(today.getTime() + day * 86_400_000 + hour * 3_600_000);
  let n = 0;
  for (let day = 1; day <= 26; day += 1) {
    const room = rooms[day % rooms.length];
    await repo.createBooking({ roomId: room.id, title: `Họp mẫu ${++n}`, organizer: day % 2 ? 'demo' : 'admin', startsAt: at(day, 2), endsAt: at(day, 3) });
    if (day % 3 === 0) await repo.createBooking({ roomId: room.id, title: `Họp mẫu ${++n}`, organizer: 'demo', startsAt: at(day, 6), endsAt: at(day, 7.5) });
  }
  await repo.createRecurringBooking({ roomId: rooms[2].id, title: 'Giao ban tuần', organizer: 'admin', startsAt: at(1, 1), endsAt: at(1, 1.5), recurrence: { freq: 'weekly', count: 4 } });
  const cancelled = await repo.createBooking({ roomId: rooms[4].id, title: 'Lịch đã huỷ', organizer: 'demo', startsAt: at(5, 8), endsAt: at(5, 9) });
  await repo.cancelBooking(cancelled.id);
  const admin = await repo.createApiToken({ username: 'admin', role: 'admin' });
  const demo = await repo.createApiToken({ username: 'demo', role: 'member' });
  console.log(`Đã tạo ${rooms.length} phòng và ${n + 5} đặt lịch mẫu.`);
  console.log(`Token admin: ${admin.token}`);
  console.log(`Token demo (member): ${demo.token}`);
} finally { await pool.end(); }
