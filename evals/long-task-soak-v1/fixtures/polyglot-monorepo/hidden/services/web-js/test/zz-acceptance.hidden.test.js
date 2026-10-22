// Hidden acceptance checks for TODO.md (the soak oracle lays this over the agent's work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const lib = () => import('../src/index.js');
const root = new URL('../../../', import.meta.url);
const json = rel => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));

const V2 = { contract_version: 2, order_id: 'O-9', account_id: 'A-9', account_tier: 'gold', currency: 'VND', items: [{ sku: 'S1', qty: 3, unit_price: 1001 }] };
const V1 = { contract_version: 1, order_id: 'O-8', customer_id: 'C-8', customer_tier: 'vip', currency: 'USD', items: [{ sku: 'S1', qty: 2, unit_price: 1999 }] };
const KEYS = ['contract_version', 'order_id', 'account_id', 'account_tier', 'currency', 'items'];

async function codeOf(data) {
  const { parseOrder, ContractError } = await lib();
  try { parseOrder(structuredClone(data)); } catch (e) { assert.ok(e instanceof ContractError, `not a ContractError: ${e}`); return e.code; }
  return null;
}

test('account module replaces the customer module', async () => {
  const m = await lib();
  assert.deepEqual(m.normalizeAccount({ account_id: 'A-3', name: ' Leaf & Co ', tier: 'gold' }), { accountId: 'A-3', name: 'Leaf & Co', tier: 'gold' });
  assert.throws(() => m.normalizeAccount({ customer_id: 'C-1' }), TypeError);
  assert.equal(m.accountLabel({ accountId: 'A-1', name: '', tier: 'vip' }), 'A-1 (VIP)');
  for (const old of ['normalizeCustomer', 'customerLabel', 'CUSTOMER_TIERS']) assert.ok(!(old in m), `${old} is still exported`);
  assert.ok(existsSync(new URL('../src/account.js', import.meta.url)));
  assert.ok(!existsSync(new URL('../src/customer.js', import.meta.url)), 'src/customer.js still exists');
});

test('parseOrder reads v2 and legacy v1', async () => {
  const { parseOrder } = await lib();
  assert.deepEqual(parseOrder(structuredClone(V2)), { orderId: 'O-9', accountId: 'A-9', accountTier: 'gold', currency: 'VND', items: [{ sku: 'S1', qty: 3, unitPrice: 1001 }], sourceVersion: 2 });
  const legacy = parseOrder(structuredClone(V1));
  assert.equal(legacy.accountId, 'C-8'); assert.equal(legacy.accountTier, 'vip'); assert.equal(legacy.sourceVersion, 1);
  assert.ok(!('customerId' in legacy));
  const { contract_version, ...noVersion } = V1;
  assert.equal(parseOrder(noVersion).sourceVersion, 1);
});

test('toWire always writes v2 in schema key order', async () => {
  const { parseOrder, toWire } = await lib();
  const fromV1 = toWire(parseOrder(structuredClone(V1)));
  assert.deepEqual(Object.keys(fromV1), KEYS);
  assert.deepEqual(fromV1, { contract_version: 2, order_id: 'O-8', account_id: 'C-8', account_tier: 'vip', currency: 'USD', items: V1.items });
  assert.deepEqual(toWire(parseOrder(structuredClone(V2))), V2);
});

test('error codes', async () => {
  assert.equal(await codeOf({ ...V2, customer_id: 'C-1' }), 'MIXED_FIELDS');
  assert.equal(await codeOf({ ...V2, customer_tier: 'gold' }), 'MIXED_FIELDS');
  assert.equal(await codeOf({ ...V1, account_id: 'A-1' }), 'MIXED_FIELDS');
  for (const v of [0, 3, '2', '1', 2.5]) assert.equal(await codeOf({ ...V2, contract_version: v }), 'UNSUPPORTED_VERSION', `version ${JSON.stringify(v)}`);
  assert.equal(await codeOf({ ...V2, account_id: '' }), 'INVALID');
  assert.equal(await codeOf({ ...V2, account_tier: 'platinum' }), 'INVALID');
  assert.equal(await codeOf({ ...V1, items: [] }), 'INVALID');
});

test('upgradeV1 is a pure rename', async () => {
  const { upgradeV1 } = await lib();
  const shim = await import('../src/compat-v1.js');
  assert.equal(shim.upgradeV1, upgradeV1);
  const input = { ...structuredClone(V1), note: 'giữ nguyên' };
  const before = structuredClone(input);
  const out = upgradeV1(input);
  assert.deepEqual(input, before);
  assert.equal(out.contract_version, 2);
  assert.equal(out.account_id, 'C-8'); assert.equal(out.account_tier, 'vip'); assert.equal(out.note, 'giữ nguyên');
  assert.ok(!('customer_id' in out) && !('customer_tier' in out));
});

test('buildQuoteRequest uses ACCOUNT_API_URL and /accounts/', async () => {
  const { parseOrder, buildQuoteRequest } = await lib();
  const order = parseOrder(structuredClone(V2));
  const request = buildQuoteRequest(order, { ACCOUNT_API_URL: 'http://acc.internal.test/' });
  assert.equal(request.url, 'http://acc.internal.test/accounts/A-9/quotes');
  assert.deepEqual(request.body, V2);
  assert.throws(() => buildQuoteRequest(order, { CUSTOMER_API_URL: 'http://old.test' }), /ACCOUNT_API_URL/);
});

test('package version and own compat tests', () => {
  assert.equal(json('services/web-js/package.json').version, '2.0.0');
  const own = new URL('./compat-v1.test.js', import.meta.url);
  assert.ok(existsSync(own), 'test/compat-v1.test.js is missing');
  assert.match(readFileSync(own, 'utf8'), /upgradeV1/);
});

test('every contract sample parses as documented', async () => {
  const { parseOrder, toWire } = await lib();
  const dir = new URL('shared/contracts/fixtures/', root);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    const order = parseOrder(structuredClone(data));
    if (name.includes('compat')) assert.equal(order.sourceVersion, 1, name);
    else { assert.equal(order.sourceVersion, 2, name); assert.deepEqual(toWire(order), data, name); }
  }
});
