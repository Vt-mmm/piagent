import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, buildQuoteRequest } from '../src/index.js';
import { sample } from './helpers.js';

test('buildQuoteRequest targets the Customer API', () => {
  const order = parseOrder(sample('order-vip.json'));
  const request = buildQuoteRequest(order, { CUSTOMER_API_URL: 'http://customers.internal.test/' });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'http://customers.internal.test/customers/C-200/quotes');
  assert.equal(request.body.customer_id, 'C-200');
});

test('buildQuoteRequest needs CUSTOMER_API_URL', () => {
  const order = parseOrder(sample('order-vip.json'));
  assert.throws(() => buildQuoteRequest(order, {}), /CUSTOMER_API_URL/);
});
