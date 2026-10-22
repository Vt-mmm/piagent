import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, ContractError } from '../src/index.js';
import { LEGACY_FIELDS } from '../src/compat-v1.js';
import { sample } from './helpers.js';

const legacyId = Object.keys(LEGACY_FIELDS).find(old => LEGACY_FIELDS[old] === 'account_id');
const invalid = data => assert.throws(() => parseOrder(data), e => e instanceof ContractError && e.code === 'INVALID');

test('account_id with leading/trailing whitespace is INVALID in v1, v2 and v3', () => {
  for (const bad of [' C-100', 'C-100 ', '\tC-100', 'C-100\n']) {
    invalid({ ...sample('order-basic.json'), account_id: bad });
    invalid({ ...sample('v3/order-fx-usd-vnd.json'), account_id: bad });
    invalid({ ...sample('order-compat-v1.json'), [legacyId]: bad });
  }
  assert.equal(parseOrder({ ...sample('order-basic.json'), account_id: 'C 100' }).accountId, 'C 100');
});
