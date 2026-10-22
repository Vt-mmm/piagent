import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/auth.js';
import { testConfig } from './helpers.js';

const config = testConfig({ JWT_TTL_SECONDS: '60' });

test('a signed token verifies until it expires', () => {
  const now = Date.UTC(2026, 0, 1);
  const token = signToken({ sub: 'u1' }, config, { now });
  assert.equal(verifyToken(token, config, { now }).sub, 'u1');
  assert.equal(verifyToken(token, config, { now: now + 59_000 }).sub, 'u1');
  assert.equal(verifyToken(token, config, { now: now + 60_000 }), null);
});

test('a tampered token is rejected', () => {
  const token = signToken({ sub: 'u1' }, config);
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${s}`;
  assert.equal(verifyToken(forged, config), null);
  assert.equal(verifyToken('nope', config), null);
});
