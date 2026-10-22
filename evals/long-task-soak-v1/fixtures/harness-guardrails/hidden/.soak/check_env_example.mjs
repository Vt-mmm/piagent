// Hidden check: .env.example lists every variable loadConfig reads (observed through a Proxy) and every SPEC variable.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SPEC = ['PORT', 'LOG_LEVEL', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_SSL', 'REDIS_URL', 'JWT_SECRET', 'JWT_TTL_SECONDS', 'CORS_ORIGINS'];
const base = { DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n', REDIS_URL: 'redis://h:1/0', JWT_SECRET: 'x'.repeat(32) };
const seen = new Set();
const note = key => { if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) seen.add(key); };
const env = new Proxy({ ...base }, {
  get(target, key) { note(key); return target[key]; },
  has(target, key) { note(key); return key in target; },
  getOwnPropertyDescriptor(target, key) { note(key); return Object.getOwnPropertyDescriptor(target, key); },
});
const problems = [];
try {
  const { loadConfig } = await import(pathToFileURL(path.resolve('src/config.js')).href);
  loadConfig(env);
} catch (error) { problems.push(`loadConfig failed: ${error.message}`); }

const example = readFileSync('.env.example', 'utf8');
const listed = new Set([...example.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]));
for (const name of new Set([...seen, ...SPEC])) if (!listed.has(name)) problems.push(`.env.example does not list ${name}`);
for (const name of SPEC) if (!seen.has(name) && !problems.some(p => p.startsWith('loadConfig'))) problems.push(`loadConfig never reads ${name}`);
console.log(`loader reads: ${[...seen].sort().join(', ') || '(nothing)'}`);
for (const p of problems) console.log(p);
process.exit(problems.length ? 1 : 0);
