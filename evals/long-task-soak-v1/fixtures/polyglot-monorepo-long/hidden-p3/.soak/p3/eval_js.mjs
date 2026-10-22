// Hidden evaluator: web-js on .soak/p3/cases.jsonl → JSON lines on stdout.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const m = await import(path.resolve('services/web-js/src/index.js'));
const out = [];
for (const line of readFileSync('.soak/p3/cases.jsonl', 'utf8').split('\n').filter(Boolean)) {
  const data = JSON.parse(line);
  try {
    const order = m.parseOrder(data);
    const q = m.quoteOrder(order);
    out.push({ ok: { source_version: order.sourceVersion, account_id: order.accountId, account_tier: order.accountTier, currency: order.currency,
      settlement_currency: order.settlementCurrency, fx_rate_ppm: order.fxRatePpm, subtotal: q.subtotal, discount: q.discount, total: q.total,
      settlement_total: m.settlementTotal(order), wire: m.toWire(order) } });
  } catch (error) {
    out.push(error instanceof m.ContractError ? { error: error.code } : { crash: String(error) });
  }
}
process.stdout.write(out.map(o => JSON.stringify(o)).join('\n') + '\n');
