// Shared contract conformance: every case in shared/contracts/conformance/*.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseOrder, quoteOrder, settlementTotal, ContractError } from '../src/index.js';

const dir = new URL('../../../shared/contracts/conformance/', import.meta.url);

function outcome(payload) {
  let order;
  try {
    order = parseOrder(structuredClone(payload));
  } catch (error) {
    if (error instanceof ContractError) return { error: error.code };
    throw error;
  }
  const q = quoteOrder(order);
  return { ok: { source_version: order.sourceVersion, account_id: order.accountId, account_tier: order.accountTier, currency: order.currency, subtotal: q.subtotal, discount: q.discount, total: q.total,
    settlement_currency: order.settlementCurrency, fx_rate_ppm: order.fxRatePpm, settlement_total: settlementTotal(order) } };
}

for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
  test(`conformance ${file}`, () => {
    for (const c of JSON.parse(readFileSync(new URL(file, dir), 'utf8'))) {
      const got = outcome(c.payload);
      if ('error' in c.expect) assert.deepEqual(got, c.expect, c.name);
      else {
        assert.ok(got.ok, `${c.name}: ${JSON.stringify(got)}`);
        assert.deepEqual(Object.fromEntries(Object.keys(c.expect.ok).map(k => [k, got.ok[k]])), c.expect.ok, c.name);
      }
    }
  });
}
