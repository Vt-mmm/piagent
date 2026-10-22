// Property-style tests: seeded random v1/v2/v3 payloads (mulberry32, reproducible: SEED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, toWire, quoteOrder, settlementTotal, ContractError } from '../src/index.js';
import { LEGACY_FIELDS } from '../src/compat-v1.js';

const LEGACY_NAME = Object.fromEntries(Object.entries(LEGACY_FIELDS).map(([old, now]) => [now, old]));

const SEED = 20251021;
const CURRENCIES = ['VND', 'USD', 'EUR', 'JPY', 'SGD'];
const TIERS = ['standard', 'gold', 'vip'];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPayload(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  const version = pick([1, 2, 3]);
  const currency = pick(CURRENCIES);
  const name = key => (version === 1 ? LEGACY_NAME[key] : key);
  const data = { contract_version: version, order_id: `O-${int(0, 999999)}`, [name('account_id')]: `A-${int(0, 99999)}`, [name('account_tier')]: pick(TIERS), currency };
  if (version === 3) {
    data.settlement_currency = pick(CURRENCIES);
    data.fx_rate_ppm = data.settlement_currency === currency ? 1_000_000 : int(1, 1_000_000_000);
  }
  data.items = Array.from({ length: int(1, 4) }, (_, i) => ({ sku: `S${i}`, qty: int(1, 50), unit_price: int(0, 5_000_000) }));
  if (version === 1 && rand() < 0.5) delete data.contract_version;
  return data;
}

test('valid random payloads keep the invariants', () => {
  const rand = mulberry32(SEED);
  for (let n = 0; n < 500; n++) {
    const data = randomPayload(rand);
    const order = parseOrder(structuredClone(data));
    const q = quoteOrder(order);
    assert.equal(order.sourceVersion, data.contract_version ?? 1);
    assert.ok(q.discount >= 0 && q.discount <= q.subtotal);
    assert.equal(q.total, q.subtotal - q.discount);
    assert.equal(BigInt(settlementTotal(order)), (BigInt(q.total) * BigInt(order.fxRatePpm)) / 1_000_000n);
    const wire = toWire(order);
    assert.equal(wire.contract_version, order.settlementCurrency !== order.currency ? 3 : 2);
    const again = parseOrder(wire);
    assert.deepEqual([again.accountId, again.items, again.settlementCurrency, again.fxRatePpm], [order.accountId, order.items, order.settlementCurrency, order.fxRatePpm]);
  }
});

test('mutated payloads fail with the right code', () => {
  const rand = mulberry32(SEED + 1);
  for (let n = 0; n < 300; n++) {
    const data = randomPayload(rand);
    const version = data.contract_version ?? 1;
    const mutated = structuredClone(data);
    let code = 'INVALID';
    const choice = Math.floor(rand() * 4);
    const pick = list => list[Math.floor(rand() * list.length)];
    if (choice === 0) { mutated.contract_version = pick([0, 4, '3', 2.5, null]); code = 'UNSUPPORTED_VERSION'; }
    else if (choice === 1 && version !== 3) { mutated.fx_rate_ppm = 1_000_000; code = 'MIXED_FIELDS'; }
    else if (choice === 2) mutated.items[0].qty = pick([0, -1, '1', 1.5, true]);
    else mutated.currency = pick(['usd', 'US1', 'EURO', '']);
    assert.throws(() => parseOrder(mutated), e => e instanceof ContractError && e.code === code, JSON.stringify(mutated));
  }
});
