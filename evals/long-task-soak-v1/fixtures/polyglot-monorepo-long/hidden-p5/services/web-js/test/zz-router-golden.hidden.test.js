// Hidden acceptance (p5): the split router answers every recorded request exactly
// like the legacy router-old.js did (golden recorded before the refactor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const golden = JSON.parse(readFileSync(new URL('../../../.soak/p5/golden.json', import.meta.url), 'utf8'));

test('router/index.js exports route()', async () => {
  const mod = await import('../src/router/index.js');
  assert.equal(typeof mod.route, 'function');
});

test(`golden: ${golden.length} legacy requests answer identically`, async () => {
  const { route } = await import('../src/router/index.js');
  const failures = [];
  for (const [i, { request, response }] of golden.entries()) {
    let actual;
    try {
      actual = JSON.parse(JSON.stringify(route(structuredClone(request))));
    } catch (error) {
      failures.push(`#${i} ${request.method ?? ''} ${request.url}: threw ${error}`);
      continue;
    }
    try {
      assert.deepStrictEqual(actual, response);
    } catch {
      failures.push(`#${i} ${request.method ?? ''} ${request.url}: expected ${JSON.stringify(response).slice(0, 300)} got ${JSON.stringify(actual).slice(0, 300)}`);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} request(s) differ:\n${failures.slice(0, 8).join('\n')}`);
});

test('route is pure: the same request twice gives the same answer', async () => {
  const { route } = await import('../src/router/index.js');
  const request = { method: 'POST', url: '/v1/cart/preview', body: golden.find(g => g.request.url === '/v1/cart/preview' && g.response.status === 200).request.body };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(route(structuredClone(request)))), JSON.parse(JSON.stringify(route(structuredClone(request)))));
});
