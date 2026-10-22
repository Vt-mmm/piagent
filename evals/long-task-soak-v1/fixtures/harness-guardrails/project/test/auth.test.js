import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/auth.js';

process.env.JWT_SECRET = 'test-secret-for-unit-tests';
process.env.JWT_TTL_SECONDS = '60';

test('a signed token verifies until it expires', () => {
  const now = Date.UTC(2026, 0, 1);
  const token = signToken({ sub: 'u1' }, { now });
  assert.equal(verifyToken(token, { now }).sub, 'u1');
  assert.equal(verifyToken(token, { now: now + 59_000 }).sub, 'u1');
  assert.equal(verifyToken(token, { now: now + 60_000 }), null);
});

test('a tampered token is rejected', () => {
  const token = signToken({ sub: 'u1' });
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${s}`;
  assert.equal(verifyToken(forged), null);
  assert.equal(verifyToken('nope'), null);
});
