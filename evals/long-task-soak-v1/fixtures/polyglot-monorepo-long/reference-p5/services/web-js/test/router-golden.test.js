// Golden recorded from the legacy router-old.js before the split: the new
// src/router/ must answer every request exactly the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { route } from '../src/router/index.js';
import { adminRoute } from '../src/index.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/router-golden.json', import.meta.url), 'utf8'));
const wire = value => JSON.parse(JSON.stringify(value));

test('adminRoute is the split router', () => assert.equal(adminRoute, route));

for (const { request, response } of golden) {
  test(`${request.method ?? 'GET'} ${request.url}`, () => {
    assert.deepStrictEqual(wire(route(structuredClone(request))), response);
  });
}
