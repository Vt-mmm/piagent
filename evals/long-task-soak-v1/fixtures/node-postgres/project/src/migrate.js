// Chạy các file migrations/NNN_*.sql theo thứ tự tên, mỗi file trong một
// transaction, ghi lại vào schema_migrations. Gọi nhiều lần (kể cả song song
// từ nhiều tiến trình) vẫn an toàn nhờ advisory lock.
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', 'migrations');
const LOCK = 7_204_311;

export async function migrate(pool, { dir = DIR } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const files = (await fs.readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error(`migration ${file} failed: ${error.message}`), { cause: error });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}
