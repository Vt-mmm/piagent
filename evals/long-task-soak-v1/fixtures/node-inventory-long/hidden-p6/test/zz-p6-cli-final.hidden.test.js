// Hidden acceptance checks for phase p6: the CLI, the Vietnamese README, and
// the rule the member added mid-session (stockReport order: available
// descending, then warehouse, then SKU) everywhere the report is served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const expectedImport = JSON.parse(readFileSync(new URL('./zz-import-expected.hidden.json', import.meta.url), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'kho-p6-'));

function seeded() {
  const inv = new Inventory({ clock: () => '2026-03-10' });
  inv.receive('A', 5, { lot: 'L1', expiresOn: null });
  inv.receive('B', 5, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.receive('C', 2, { lot: 'L1', expiresOn: null, warehouse: 'DN' });
  inv.receive('B', 9, { lot: 'L2', expiresOn: '2026-03-01' });
  inv.receive('A', 7, { lot: 'L3', expiresOn: null, warehouse: 'DN' });
  inv.receive('D', 5, { lot: 'L1', expiresOn: null, warehouse: 'DN' });
  inv.receive('E', 5, { lot: 'L1', expiresOn: null, warehouse: 'HN' });
  inv.reserve('o1', 'A', 2);
  return inv;
}
const ORDER = [['DN', 'A', 7], ['DN', 'D', 5], ['HN', 'B', 5], ['HN', 'E', 5], ['MAIN', 'A', 3], ['DN', 'C', 2], ['MAIN', 'B', 0]];
const shape = rows => rows.map(r => [r.warehouse, r.sku, r.available]);

test('p6.1 member rule: stockReport is sorted by available desc, then warehouse, then SKU', () => {
  const inv = seeded();
  assert.deepEqual(shape(inv.stockReport()), ORDER);
  assert.deepEqual(inv.stockReport()[4], { warehouse: 'MAIN', sku: 'A', onHand: 5, reserved: 2, available: 3 });
  assert.deepEqual(shape(inv.stockReport({ warehouse: 'DN' })), [['DN', 'A', 7], ['DN', 'D', 5], ['DN', 'C', 2]]);
});

test('p6.2 member rule also holds on GET /reports/stock', async () => {
  const server = createServer({ inventory: seeded() });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const rows = await (await fetch(`http://127.0.0.1:${server.address().port}/reports/stock`)).json();
    assert.deepEqual(shape(rows), ORDER);
  } finally { server.closeAllConnections?.(); server.close(); }
});

function cli(log, ...args) {
  const r = spawnSync(process.execPath, ['bin/kho.js', ...args, '--log', log], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const ok = r => { assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`); return r; };
const json = r => JSON.parse(ok(r).out);

test('p6.3 CLI: every command works on a persistent log', () => {
  const log = join(tmp(), 'kho.jsonl');
  const day = ['--today', '2026-03-10'];
  ok(cli(log, 'receive', 'A', '5', '--lot', 'L1', '--expires', '2026-03-20', ...day));
  ok(cli(log, 'receive', 'A', '3', '--lot', 'L2', '--expires', '2026-03-15', '--warehouse', 'HN', ...day));
  ok(cli(log, 'receive', 'B', '1', '--lot', 'L1', ...day));
  ok(cli(log, 'receive', 'A', '2', '--lot', 'X', '--expires', '2026-03-01', ...day));
  ok(cli(log, 'reserve', 'o1', 'A', '2', ...day));
  assert.deepEqual(json(cli(log, 'commit', 'o1', '--json', ...day)), [{ sku: 'A', lot: 'L1', qty: 2 }]);
  let r = cli(log, 'reserve', 'o2', 'A', '100', ...day);
  assert.equal(r.code, 1); assert.match(r.err, /^INSUFFICIENT_STOCK/m);
  ok(cli(log, 'transfer', 't1', 'A', '1', '--from', 'HN', '--to', 'MAIN', ...day));
  assert.deepEqual(json(cli(log, 'transfer-complete', 't1', '--json', ...day)), [{ sku: 'A', lot: 'L2', qty: 1, expiresOn: '2026-03-15' }]);
  r = cli(log, 'transfer', 't2', 'A', '1', '--from', 'MAIN', '--to', 'HN', '--lot', 'X', ...day);
  assert.equal(r.code, 1); assert.match(r.err, /^EXPIRED_LOT/m);
  r = cli(log, 'transfer-complete', 'nope', ...day);
  assert.equal(r.code, 1); assert.match(r.err, /^UNKNOWN_TRANSFER/m);
  const stock = json(cli(log, 'stock', 'A', '--json', ...day));
  assert.equal(stock.sku, 'A'); assert.equal(stock.onHand, 8); assert.equal(stock.available, 6);
  const hn = json(cli(log, 'stock', 'A', '--warehouse', 'HN', '--json', ...day));
  assert.equal(hn.onHand, 2); assert.equal(hn.available, 2);
  assert.deepEqual(json(cli(log, 'report', 'expiring', '--days', '5', '--json', ...day)), [{ sku: 'A', lot: 'L2', qty: 3, expiresOn: '2026-03-15' }]);
  assert.deepEqual(json(cli(log, 'report', 'low-stock', '--threshold', '2', '--json', ...day)), [{ sku: 'B', available: 1 }]);
  assert.deepEqual(json(cli(log, 'report', 'stock', '--json', ...day)), [
    { warehouse: 'MAIN', sku: 'A', onHand: 6, reserved: 0, available: 4 },
    { warehouse: 'HN', sku: 'A', onHand: 2, reserved: 0, available: 2 },
    { warehouse: 'MAIN', sku: 'B', onHand: 1, reserved: 0, available: 1 },
  ]);
  assert.ok(ok(cli(log, 'report', 'stock', ...day)).out.includes('MAIN'), 'a readable table without --json');
  assert.equal(json(cli(log, 'stock', 'A', '--json', '--today', '2026-03-16')).available, 3, '--today changes which lots have expired');
  ok(cli(log, 'reserve', 'o3', 'B', '1', ...day));
  ok(cli(log, 'release', 'o3', ...day));
  ok(cli(log, 'transfer', 't3', 'B', '1', '--from', 'MAIN', '--to', 'HN', ...day));
  ok(cli(log, 'transfer-cancel', 't3', ...day));
  assert.equal(json(cli(log, 'stock', 'B', '--json', ...day)).available, 1);
});

test('p6.4 CLI: usage errors exit 2, --help lists every command', () => {
  const log = join(tmp(), 'kho.jsonl');
  assert.equal(cli(log, 'frobnicate').code, 2);
  assert.equal(cli(log, 'receive', 'A').code, 2);
  assert.equal(cli(log, 'report', 'nope').code, 2);
  const help = ok(cli(log, '--help'));
  for (const command of ['receive', 'reserve', 'release', 'commit', 'transfer', 'transfer-complete', 'transfer-cancel', 'import', 'stock', 'report', 'serve'])
    assert.ok(help.out.includes(command), `--help mentions ${command}`);
});

test('p6.5 CLI: import data/stock-2025.csv reports bad lines and exits 3', () => {
  const log = join(tmp(), 'kho.jsonl');
  const r = cli(log, 'import', 'data/stock-2025.csv', '--today', '2026-01-15');
  assert.equal(r.code, 3, r.err.slice(0, 500));
  assert.match(r.out, new RegExp(`imported ${expectedImport.imported}\\b`));
  const lines = [...r.err.matchAll(/^line (\d+): \S/gm)].map(m => Number(m[1]));
  assert.deepEqual(lines, expectedImport.errorLines);
  const report = json(cli(log, 'report', 'stock', '--json', '--today', '2026-01-15'));
  const total = report.reduce((s, row) => s + row.onHand, 0);
  assert.equal(total, Object.values(expectedImport.byWarehouse).reduce((a, b) => a + b, 0));
  for (let i = 1; i < report.length; i++) assert.ok(report[i - 1].available >= report[i].available, 'stock report order');
});

test('p6.6 CLI: serve runs the API on the same log and stops on SIGTERM', async () => {
  const log = join(tmp(), 'kho.jsonl');
  ok(cli(log, 'receive', 'A', '1', '--lot', 'L1', '--today', '2026-03-10'));
  ok(cli(log, 'receive', 'B', '4', '--lot', 'L1', '--warehouse', 'HN', '--today', '2026-03-10'));
  const child = spawn(process.execPath, ['bin/kho.js', 'serve', '--port', '0', '--log', log, '--today', '2026-03-10'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no "listening on <port>": ${out}`)), 8000);
      child.stdout.on('data', d => { out += d; const m = out.match(/listening on (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.stderr.on('data', d => { out += d; });
    });
    const rows = await (await fetch(`http://127.0.0.1:${port}/reports/stock`)).json();
    assert.deepEqual(shape(rows), [['HN', 'B', 4], ['MAIN', 'A', 1]]);
    const exited = new Promise(r => child.on('exit', code => r(code)));
    child.kill('SIGTERM');
    assert.equal(await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 5000))]), 0);
  } finally { child.kill('SIGKILL'); }
});

test('p6.7 README documents the whole tool in Vietnamese', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.length >= 1500, `README is ${readme.length} characters`);
  assert.ok((readme.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length >= 100, 'written in Vietnamese');
  for (const word of ['bin/kho.js', 'transfer-complete', 'transfer-cancel', 'import', 'report', 'serve', '/reports/stock', '/transfers', 'Idempotency-Key', 'EXPIRED_LOT', 'KHO_LOG', 'report-engine'])
    assert.ok(readme.includes(word), `README mentions ${word}`);
});

test('p6.8 the project has its own CLI tests', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  assert.ok(text.includes('kho.js'), 'no own test runs bin/kho.js');
});
