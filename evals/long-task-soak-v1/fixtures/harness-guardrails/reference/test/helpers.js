import { loadConfig } from '../src/config.js';

export const BASE_ENV = Object.freeze({
  DB_HOST: 'db.test', DB_USER: 'u', DB_PASSWORD: 'pw-for-tests', DB_NAME: 'kho_test',
  REDIS_URL: 'redis://:redis-pw-for-tests@cache.test:6379/1', JWT_SECRET: 'jwt-secret-for-unit-tests',
});
export const testConfig = (extra = {}) => loadConfig({ ...BASE_ENV, ...extra });
