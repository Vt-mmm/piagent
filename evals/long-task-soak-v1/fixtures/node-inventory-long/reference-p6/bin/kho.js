#!/usr/bin/env node
// kho — command line for the kho-hang inventory. State lives in an
// append-only event log (--log, or KHO_LOG, default ./kho.log.jsonl).
import { parseArgs } from 'node:util';
import { Inventory, InventoryError } from '../src/index.js';
import { createServer } from '../src/server.js';
import { openLog } from '../src/log.js';
import { importFile } from '../src/import.js';

const USAGE = `Cách dùng: node bin/kho.js <lệnh> [tham số] [--log <file>] [--today YYYY-MM-DD] [--json]

  receive <sku> <qty> --lot <lô> [--expires YYYY-MM-DD] [--warehouse <kho>]
  reserve <đơn> <sku> <qty> [--warehouse <kho>]
  release <đơn>
  commit <đơn>
  transfer <mã> <sku> <qty> --from <kho> --to <kho> [--lot <lô>]
  transfer-complete <mã>
  transfer-cancel <mã>
  import <file.csv> [--warehouse <kho>]
  stock <sku> [--warehouse <kho>]
  report low-stock --threshold <n> [--warehouse <kho>]
  report expiring --days <n> [--warehouse <kho>]
  report stock [--warehouse <kho>]
  serve [--port <n>]

Mã thoát: 0 thành công, 1 lỗi nghiệp vụ (stderr "MÃ_LỖI: ..."), 2 sai cú pháp, 3 import có dòng lỗi.
`;

class UsageError extends Error {}
const usage = message => { throw new UsageError(message); };
const OPTIONS = {
  log: { type: 'string' }, today: { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  lot: { type: 'string' }, expires: { type: 'string' }, warehouse: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  threshold: { type: 'string' }, days: { type: 'string' }, port: { type: 'string' },
};
const int = (value, name) => { if (value == null || !/^\d+$/.test(value)) usage(`${name} phải là số nguyên không âm`); return Number(value); };
const need = (value, name) => { if (value == null || value === '') usage(`thiếu ${name}`); return value; };

function table(rows, columns) {
  if (!rows.length) return '(không có dòng nào)';
  const widths = columns.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = cells => cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns), line(widths.map(w => '-'.repeat(w))), ...rows.map(r => line(columns.map(c => r[c])))].join('\n');
}

async function main(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); } catch (error) { usage(error.message); }
  const { values: o, positionals: [command, ...args] } = parsed;
  if (o.help || command === 'help') { process.stdout.write(USAGE); return 0; }
  if (!command) usage('thiếu lệnh');
  if (o.today != null && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) usage('--today phải có dạng YYYY-MM-DD');
  const clock = o.today ? () => o.today : undefined;
  const log = openLog(o.log ?? process.env.KHO_LOG ?? 'kho.log.jsonl');
  const inv = Inventory.replay(log.events, { clock, onEvent: log.appendEvent });
  const print = (data, text) => process.stdout.write((o.json ? JSON.stringify(data, null, 2) : text ?? 'OK') + '\n');
  const wh = o.warehouse ? { warehouse: o.warehouse } : {};

  switch (command) {
    case 'receive':
      inv.receive(need(args[0], 'sku'), int(args[1], 'qty'), { lot: need(o.lot, '--lot'), expiresOn: o.expires ?? null, ...wh });
      print({ ok: true }); return 0;
    case 'reserve':
      inv.reserve(need(args[0], 'mã đơn'), need(args[1], 'sku'), int(args[2], 'qty'), wh);
      print({ ok: true }); return 0;
    case 'release': inv.release(need(args[0], 'mã đơn')); print({ ok: true }); return 0;
    case 'commit': {
      const taken = inv.commit(need(args[0], 'mã đơn'));
      print(taken, taken.map(t => `${t.sku}  ${t.lot}  ${t.qty}`).join('\n')); return 0;
    }
    case 'transfer':
      inv.transfer(need(args[0], 'mã phiếu'), need(args[1], 'sku'), int(args[2], 'qty'), { from: need(o.from, '--from'), to: need(o.to, '--to'), lot: o.lot ?? null });
      print({ ok: true }); return 0;
    case 'transfer-complete': {
      const moved = inv.completeTransfer(need(args[0], 'mã phiếu'));
      print(moved, moved.map(m => `${m.sku}  ${m.lot}  ${m.qty}  ${m.expiresOn ?? '-'}`).join('\n')); return 0;
    }
    case 'transfer-cancel': inv.cancelTransfer(need(args[0], 'mã phiếu')); print({ ok: true }); return 0;
    case 'import': {
      const result = await importFile(inv, need(args[0], 'file CSV'), wh);
      process.stdout.write(`imported ${result.imported}\n`);
      for (const e of result.errors) process.stderr.write(`line ${e.line}: ${e.message}\n`);
      return result.errors.length ? 3 : 0;
    }
    case 'stock': {
      const sku = need(args[0], 'sku');
      const data = { sku, onHand: inv.onHand(sku, o.warehouse), available: inv.available(sku, o.warehouse) };
      print(data, `${sku}: tồn ${data.onHand}, khả dụng ${data.available}`); return 0;
    }
    case 'report': {
      const kind = need(args[0], 'loại báo cáo');
      if (kind === 'low-stock') { const rows = inv.lowStock(int(o.threshold, '--threshold'), wh); print(rows, table(rows, ['sku', 'available'])); return 0; }
      if (kind === 'expiring') { const rows = inv.expiringWithin(int(o.days, '--days'), wh); print(rows, table(rows, ['sku', 'lot', 'qty', 'expiresOn'])); return 0; }
      if (kind === 'stock') { const rows = inv.stockReport(wh); print(rows, table(rows, ['warehouse', 'sku', 'onHand', 'reserved', 'available'])); return 0; }
      usage(`không có báo cáo ${kind}`);
      break;
    }
    case 'serve': {
      const server = createServer({ inventory: inv, idempotency: log.idempotency });
      await new Promise(r => server.listen(o.port == null ? 3000 : int(o.port, '--port'), r));
      process.stdout.write(`listening on ${server.address().port}\n`);
      const stop = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); setTimeout(() => process.exit(1), 5000).unref(); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      return null;
    }
    default: usage(`không có lệnh ${command}`);
  }
}

main(process.argv.slice(2)).then(code => { if (code != null) process.exitCode = code; }, error => {
  if (error instanceof UsageError) { process.stderr.write(`Lỗi: ${error.message}\n\n${USAGE}`); process.exitCode = 2; }
  else if (error instanceof InventoryError) { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1; }
  else { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
});
