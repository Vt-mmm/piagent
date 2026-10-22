import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, buildQuoteRequest } from '../src/index.js';
import { sample } from './helpers.js';

test('buildQuoteRequest targets the Account API', () => {
  const order = parseOrder(sample('order-vip.json'));
  const request = buildQuoteRequest(order, { ACCOUNT_API_URL: 'http://accounts.internal.test/' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'http://accounts.internal.test/accounts/C-200/quotes');
  assert.equal(request.body.account_id, 'C-200');
});

test('buildQuoteRequest needs ACCOUNT_API_URL', () => {
  const order = parseOrder(sample('order-vip.json'));
  assert.throws(() => buildQuoteRequest(order, {}), /ACCOUNT_API_URL/);
});
