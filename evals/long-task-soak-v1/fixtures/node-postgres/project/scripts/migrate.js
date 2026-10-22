// npm run migrate — chạy các migration còn thiếu trên DATABASE_URL.
import pg from 'pg';
import { migrate } from '../src/migrate.js';

if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL (chạy: eval "$(bash scripts/db-up.sh)")'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Đã chạy: ${applied.join(', ')}` : 'Không có migration mới.');
} finally {
  await pool.end();
}
