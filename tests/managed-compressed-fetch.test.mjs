import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { compressedFetch, GZIP_MIN_BYTES } from '../packages/piagent-core/managed/compressed-fetch.mjs';

// Large model-call bodies go to Studio gzip-compressed once Studio says it
// accepts them; small ones, other hosts and a Studio that never said so stay plain.
test('a large body to Studio is gzipped only after Studio advertises gzip', async () => {
  const seen = [];
  const base = async (input, init) => { seen.push({ input, init }); return new Response('{}', { headers: { 'X-Studio-Accept-Encoding': 'gzip' } }); };
  const owner = { origin: 'https://studio.test' };
  const fetch = compressedFetch(owner, base);
  const big = JSON.stringify({ input: 'x'.repeat(GZIP_MIN_BYTES) });
  await fetch('https://studio.test/v1/responses', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
  assert.equal(seen[0].init.body, big, 'first call: Studio has not said so yet');
  assert.equal(owner.studioGzip, true);
  await fetch('https://studio.test/v1/responses', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
  assert.equal(new Headers(seen[1].init.headers).get('content-encoding'), 'gzip');
  assert.equal(new Headers(seen[1].init.headers).get('content-type'), 'application/json');
  assert.equal(gunzipSync(seen[1].init.body).toString(), big);
  await fetch('https://studio.test/v1/responses', { method: 'POST', body: '{"small":true}' });
  assert.equal(seen[2].init.body, '{"small":true}');
  await fetch('https://elsewhere.test/v1/responses', { method: 'POST', body: big });
  assert.equal(seen[3].init.body, big, 'only Studio gets compressed bodies');
});

test('a Studio without gzip support keeps getting plain bodies', async () => {
  const seen = [];
  const owner = { origin: 'https://studio.test' };
  const fetch = compressedFetch(owner, async (input, init) => { seen.push(init); return new Response('{}'); });
  const big = 'x'.repeat(GZIP_MIN_BYTES * 2);
  await fetch('https://studio.test/v1/responses', { body: big }); await fetch('https://studio.test/v1/responses', { body: big });
  assert.equal(owner.studioGzip, undefined);
  assert.equal(seen[1].body, big);
});
