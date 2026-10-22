// npm run import:legacy -- <file.csv> [--dry-run] — in báo cáo JSON.
import pg from 'pg';
import { importLegacy } from '../src/legacy-import.js';

const args = process.argv.slice(2), dryRun = args.includes('--dry-run'), file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Cách dùng: npm run import:legacy -- <file.csv> [--dry-run]'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(JSON.stringify({ dryRun, ...(await importLegacy(pool, { file, dryRun })) }, null, 2));
} finally { await pool.end(); }
