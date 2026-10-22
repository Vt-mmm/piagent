// npm run db:reset — xoá sạch lược đồ public của DATABASE_URL rồi chạy lại migration.
import pg from 'pg';
import { migrate } from '../src/migrate.js';

if (process.env.NODE_ENV === 'production') { console.error('Từ chối db:reset khi NODE_ENV=production.'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const applied = await migrate(pool);
  console.log(`Đã xoá dữ liệu và chạy lại ${applied.length} migration.`);
} finally { await pool.end(); }
