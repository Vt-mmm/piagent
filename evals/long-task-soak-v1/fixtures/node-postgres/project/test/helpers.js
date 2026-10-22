import pg from 'pg';
import { migrate } from '../src/index.js';

export const DATABASE_URL = process.env.DATABASE_URL;
export const skip = DATABASE_URL ? false : 'cần DATABASE_URL (eval "$(bash scripts/db-up.sh)")';

// Pool đã chạy migration; nhớ gọi pool.end() trong after().
export async function setupPool() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 12 });
  await migrate(pool);
  return pool;
}

export const unique = prefix => `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
