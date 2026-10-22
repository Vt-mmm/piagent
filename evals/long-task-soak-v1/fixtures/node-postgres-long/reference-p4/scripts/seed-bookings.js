// npm run seed:report — 25 phòng "Seed 01".."Seed 25" và đúng 50.000 đặt lịch
// cố định trong năm 2029 (~10% đã huỷ). Chạy lại thì thay dữ liệu seed cũ.
import pg from 'pg';
import { migrate } from '../src/migrate.js';

if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const started = Date.now();
try {
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO rooms (name, capacity) SELECT format('Seed %s', lpad(i::text, 2, '0')), 4 + i % 12 FROM generate_series(1, 25) i ON CONFLICT DO NOTHING`);
    const rooms = (await client.query(`SELECT id FROM rooms WHERE name ~ '^Seed [0-9]{2}$' ORDER BY name`)).rows.map(r => r.id);
    await client.query('DELETE FROM bookings WHERE room_id = ANY($1)', [rooms]);
    // Phòng r, lịch k (0..1999): ngày k/6 của 2029, khung (k%6)*90 phút từ 01:00 UTC, dài 30–75 phút.
    await client.query(`
      INSERT INTO bookings (room_id, title, organizer, starts_at, ends_at, cancelled_at)
      SELECT ($1::int[])[r + 1], 'Seed ' || k, 'seed',
             s, s + make_interval(mins => 30 + ((k * 7 + r) % 4) * 15),
             CASE WHEN (k * 13 + r) % 10 = 0 THEN s - interval '1 day' END
        FROM generate_series(0, 24) r, generate_series(0, 1999) k,
             LATERAL (SELECT timestamptz '2029-01-01 01:00Z' + make_interval(days => k / 6, mins => (k % 6) * 90) AS s) x`, [rooms]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  await pool.query('ANALYZE bookings');
  console.log(`Đã tạo 50000 đặt lịch seed trong ${Date.now() - started} ms`);
} finally {
  await pool.end();
}
