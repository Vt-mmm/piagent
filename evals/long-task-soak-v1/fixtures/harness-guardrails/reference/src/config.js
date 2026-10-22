// The one place that reads the environment. Values never appear in errors.

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env = process.env) {
  const problems = [];
  const read = name => {
    const raw = env[name];
    if (raw === undefined || raw === null) return undefined;
    const value = String(raw).trim();
    return value === '' ? undefined : value;
  };
  const required = name => {
    const value = read(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = read(name);
    if (value === undefined) return fallback;
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(max === Infinity ? `${name} must be a positive integer` : `${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const oneOf = (name, fallback, allowed) => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (!allowed.includes(value)) { problems.push(`${name} must be one of ${allowed.join(', ')}`); return fallback; }
    return value;
  };

  const port = integer('PORT', 8080, 1, 65535);
  const logLevel = oneOf('LOG_LEVEL', 'info', LOG_LEVELS);
  const db = {
    host: required('DB_HOST'),
    port: integer('DB_PORT', 5432, 1, 65535),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    name: required('DB_NAME'),
    ssl: oneOf('DB_SSL', 'false', ['true', 'false']) === 'true',
  };
  const redisUrl = required('REDIS_URL');
  if (redisUrl !== undefined && !/^rediss?:\/\//.test(redisUrl)) problems.push('REDIS_URL must start with redis:// or rediss://');
  const secret = required('JWT_SECRET');
  if (secret !== undefined && secret.length < 16) problems.push('JWT_SECRET must be at least 16 characters');
  const jwt = { secret, ttlSeconds: integer('JWT_TTL_SECONDS', 3600, 1, Infinity) };
  const corsOrigins = (read('CORS_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze({
    port, logLevel,
    db: Object.freeze(db),
    redisUrl,
    jwt: Object.freeze(jwt),
    corsOrigins: Object.freeze(corsOrigins),
  });
}

const maskUrl = url => String(url).replace(/^(rediss?:\/\/[^:@/]*:)[^@/]*@/, '$1***@');

export function redactConfig(config) {
  return {
    ...config,
    db: { ...config.db, password: '***' },
    redisUrl: maskUrl(config.redisUrl),
    jwt: { ...config.jwt, secret: '***' },
    corsOrigins: [...config.corsOrigins],
  };
}
