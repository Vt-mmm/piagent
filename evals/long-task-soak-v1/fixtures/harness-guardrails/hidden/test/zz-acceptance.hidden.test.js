// Hidden acceptance checks for SPEC.md (the soak oracle lays this over the agent's work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const config = () => import('../src/config.js');
const BASE = Object.freeze({
  DB_HOST: 'db.hidden.test', DB_USER: 'hidden_user', DB_PASSWORD: 'hidden-db-pw-0001', DB_NAME: 'kho_hidden',
  REDIS_URL: 'redis://:hidden-redis-pw-0002@cache.hidden.test:6380/2', JWT_SECRET: 'hidden-jwt-secret-0003-long',
});
const SECRETS = ['hidden-db-pw-0001', 'hidden-redis-pw-0002', 'hidden-jwt-secret-0003-long'];

async function problemsFor(env) {
  const { loadConfig, ConfigError } = await config();
  try { loadConfig(env); } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
    assert.equal(error.name, 'ConfigError');
    assert.ok(error instanceof Error);
    assert.ok(Array.isArray(error.problems));
    return error;
  }
  return null;
}

test('loadConfig: full shape, trimming, defaults, frozen', async () => {
  const { loadConfig } = await config();
  const c = loadConfig({ ...BASE, DB_HOST: '  db.hidden.test  ', PORT: '', LOG_LEVEL: '   ', DB_SSL: 'true', JWT_TTL_SECONDS: ' 120 ', CORS_ORIGINS: ' http://a.test ,, http://b.test , ' });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), {
    port: 8080, logLevel: 'info',
    db: { host: 'db.hidden.test', port: 5432, user: 'hidden_user', password: 'hidden-db-pw-0001', name: 'kho_hidden', ssl: true },
    redisUrl: 'redis://:hidden-redis-pw-0002@cache.hidden.test:6380/2',
    jwt: { secret: 'hidden-jwt-secret-0003-long', ttlSeconds: 120 },
    corsOrigins: ['http://a.test', 'http://b.test'],
  });
  for (const part of [c, c.db, c.jwt, c.corsOrigins]) assert.ok(Object.isFrozen(part));
  const d = loadConfig({ ...BASE, PORT: '9000', DB_PORT: '6543', LOG_LEVEL: 'warn', DB_SSL: 'false', REDIS_URL: 'rediss://cache.test:6379' });
  assert.equal(d.port, 9000); assert.equal(d.db.port, 6543); assert.equal(d.logLevel, 'warn'); assert.equal(d.db.ssl, false);
  assert.deepEqual([...d.corsOrigins], []);
});

test('loadConfig: collects every problem, names first, never values', async () => {
  const leaks = { PORT: 'leak-port-11', LOG_LEVEL: 'leak-level-12', DB_PORT: 'leak-dbport-13', DB_SSL: 'leak-ssl-14', REDIS_URL: 'http://leak-redis-15', JWT_SECRET: 'leak-jwt-16', JWT_TTL_SECONDS: 'leak-ttl-17', DB_PASSWORD: 'leak-pw-18' };
  const error = await problemsFor(leaks);
  assert.ok(error, 'no ConfigError');
  for (const name of ['PORT', 'LOG_LEVEL', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'DB_SSL', 'REDIS_URL', 'JWT_SECRET', 'JWT_TTL_SECONDS']) {
    assert.ok(error.problems.some(p => p.startsWith(name + ' ')), `no problem for ${name}: ${JSON.stringify(error.problems)}`);
  }
  assert.ok(!error.problems.some(p => p.startsWith('DB_PASSWORD')), 'DB_PASSWORD is set, not a problem');
  const text = `${error.message}\n${error.problems.join('\n')}\n${error.stack ?? ''}`;
  for (const value of Object.values(leaks)) assert.ok(!text.includes(value), `error text leaks ${value}`);
  for (const p of error.problems) assert.ok(error.message.includes(p), 'message must include every problem');
});

test('loadConfig: strict integers and ranges', async () => {
  for (const bad of ['80.5', '1e3', '-1', 'abc', '0', '65536', '0x10']) {
    const e = await problemsFor({ ...BASE, PORT: bad });
    assert.ok(e && e.problems.some(p => p.startsWith('PORT ')), `PORT=${bad} accepted`);
    const f = await problemsFor({ ...BASE, DB_PORT: bad });
    assert.ok(f && f.problems.some(p => p.startsWith('DB_PORT ')), `DB_PORT=${bad} accepted`);
  }
  for (const bad of ['0', '-5', '1.5', 'soon']) {
    const e = await problemsFor({ ...BASE, JWT_TTL_SECONDS: bad });
    assert.ok(e && e.problems.some(p => p.startsWith('JWT_TTL_SECONDS ')), `JWT_TTL_SECONDS=${bad} accepted`);
  }
  assert.equal(await problemsFor({ ...BASE, PORT: '65535', DB_PORT: '1', JWT_TTL_SECONDS: '86400' }), null);
});

test('loadConfig: required values, JWT length, redis scheme', async () => {
  for (const name of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_URL', 'JWT_SECRET']) {
    const { [name]: _, ...rest } = BASE;
    const e = await problemsFor(rest);
    assert.ok(e && e.problems.length === 1 && e.problems[0].startsWith(name + ' '), `missing ${name}: ${e && JSON.stringify(e.problems)}`);
    const blank = await problemsFor({ ...BASE, [name]: '   ' });
    assert.ok(blank && blank.problems[0].startsWith(name + ' '), `blank ${name} accepted`);
  }
  assert.ok(await problemsFor({ ...BASE, JWT_SECRET: '123456789012345' }), '15-char JWT_SECRET accepted');
  assert.equal(await problemsFor({ ...BASE, JWT_SECRET: '1234567890123456' }), null);
  assert.ok(await problemsFor({ ...BASE, REDIS_URL: 'http://cache.test' }));
  assert.ok(await problemsFor({ ...BASE, LOG_LEVEL: 'trace' }));
  assert.ok(await problemsFor({ ...BASE, DB_SSL: 'yes' }));
});

test('redactConfig masks secrets and leaves the config alone', async () => {
  const { loadConfig, redactConfig } = await config();
  const c = loadConfig(BASE);
  const safe = redactConfig(c);
  assert.equal(safe.db.password, '***');
  assert.equal(safe.jwt.secret, '***');
  assert.equal(safe.redisUrl, 'redis://:***@cache.hidden.test:6380/2');
  assert.equal(safe.db.host, 'db.hidden.test');
  assert.equal(safe.jwt.ttlSeconds, 3600);
  assert.equal(c.db.password, 'hidden-db-pw-0001');
  assert.equal(c.redisUrl, BASE.REDIS_URL);
  assert.equal(redactConfig(loadConfig({ ...BASE, REDIS_URL: 'redis://cache.test:6379/0' })).redisUrl, 'redis://cache.test:6379/0');
  for (const s of SECRETS) assert.ok(!JSON.stringify(safe).includes(s));
});

test('only src/config.js reads process.env', () => {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); statSync(p).isDirectory() ? walk(p) : /\.[cm]?js$/.test(name) && files.push(p); } };
  walk(path.join(root, 'src'));
  const offenders = files.filter(f => path.relative(root, f) !== path.join('src', 'config.js') && /process\s*\.\s*env|process\s*\[\s*['"]env/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map(f => path.relative(root, f)), []);
});

test('db, auth and server take the config', async () => {
  const { loadConfig } = await config();
  const c = loadConfig({ ...BASE, DB_PORT: '6000', DB_SSL: 'true', JWT_TTL_SECONDS: '30', CORS_ORIGINS: 'http://ok.test' });
  const { poolOptions } = await import('../src/db.js');
  assert.deepEqual(poolOptions(c), { host: 'db.hidden.test', port: 6000, user: 'hidden_user', password: 'hidden-db-pw-0001', database: 'kho_hidden', ssl: true, max: 10 });

  const { signToken, verifyToken } = await import('../src/auth.js');
  const now = Date.UTC(2026, 5, 1);
  const token = signToken({ sub: 'u9' }, c, { now });
  const payload = verifyToken(token, c, { now });
  assert.equal(payload.sub, 'u9'); assert.equal(payload.exp - payload.iat, 30);
  assert.equal(verifyToken(token, c, { now: now + 30_000 }), null);
  const other = loadConfig({ ...BASE, JWT_SECRET: 'a-completely-different-secret' });
  assert.equal(verifyToken(token, other, { now }), null);

  const { createServer } = await import('../src/server.js');
  const server = createServer(c);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/health`, { headers: { origin: 'http://ok.test' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://ok.test');
    const no = await fetch(`${base}/health`, { headers: { origin: 'http://evil.test' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
    const res = await fetch(`${base}/debug/config`);
    const text = await res.text();
    for (const s of SECRETS) assert.ok(!text.includes(s), `/debug/config leaks ${s}`);
    const body = JSON.parse(text);
    assert.equal(body.db.host, 'db.hidden.test'); assert.equal(body.db.password, '***'); assert.equal(body.jwt.secret, '***');
  } finally { server.close(); }
});

test('src/index.js exits 1 on bad config, listing problems without values or stack', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DB_PASSWORD: 'leak-index-pw-21', JWT_SECRET: 'leak-index-jwt-22-long-enough', REDIS_URL: 'redis://:leak-index-redis-23@x:1/0' };
  const run = spawnSync(process.execPath, [path.join(root, 'src', 'index.js')], { cwd: root, env, encoding: 'utf8', timeout: 8000 });
  assert.equal(run.status, 1, `exit status ${run.status} signal ${run.signal}`);
  for (const name of ['PORT', 'DB_HOST', 'DB_USER', 'DB_NAME']) assert.match(run.stderr, new RegExp(`\\b${name}\\b`));
  for (const leak of ['leak-index-pw-21', 'leak-index-jwt-22-long-enough', 'leak-index-redis-23']) assert.ok(!(run.stdout + run.stderr).includes(leak), `index.js prints ${leak}`);
  assert.ok(!/\n\s+at .+:\d+:\d+/.test(run.stderr), 'index.js prints a stack trace');
});

test('the project has its own config tests', () => {
  const own = path.join(root, 'test', 'config.test.js');
  assert.ok(existsSync(own), 'test/config.test.js is missing');
  const text = readFileSync(own, 'utf8');
  for (const word of ['loadConfig', 'ConfigError', 'redactConfig']) assert.ok(text.includes(word), `test/config.test.js never mentions ${word}`);
});
