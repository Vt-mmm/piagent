import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, redactConfig } from '../src/config.js';
import { BASE_ENV } from './helpers.js';

test('loadConfig applies defaults', () => {
  const config = loadConfig({ ...BASE_ENV, PORT: ' ', CORS_ORIGINS: 'a, ,b' });
  assert.equal(config.port, 8080);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.db.port, 5432);
  assert.equal(config.db.ssl, false);
  assert.equal(config.jwt.ttlSeconds, 3600);
  assert.deepEqual(config.corsOrigins, ['a', 'b']);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.db));
});

test('loadConfig reports every problem without values', () => {
  try {
    loadConfig({ DB_PORT: '1e3', JWT_SECRET: 'short-secret', REDIS_URL: 'http://x:leak@y' });
    assert.fail('no error');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    for (const name of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT', 'JWT_SECRET', 'REDIS_URL']) assert.ok(error.problems.some(p => p.startsWith(name)), name);
    assert.ok(!error.message.includes('short-secret') && !error.message.includes('leak'));
  }
});

test('redactConfig masks secrets', () => {
  const config = loadConfig(BASE_ENV);
  const safe = redactConfig(config);
  assert.equal(safe.db.password, '***');
  assert.equal(safe.jwt.secret, '***');
  assert.equal(safe.redisUrl, 'redis://:***@cache.test:6379/1');
  assert.equal(config.db.password, 'pw-for-tests');
});
