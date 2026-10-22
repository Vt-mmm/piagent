// Helpers for the hidden checks that need a database of their own (seeding,
// importing, resetting): a new, empty database on the oracle's server, so
// whatever the project's own tests left behind cannot change the numbers.
import pg from 'pg';
import { execFile } from 'node:child_process';
import path from 'node:path';

export async function freshDatabase(prefix) {
  const url = new URL(process.env.DATABASE_URL);
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  url.pathname = `/${name}`;
  return url.toString();
}

// Runs a command in the project root with DATABASE_URL set; resolves with
// { code, stdout, stderr, ms }.
export function run(command, args, { databaseUrl, env = {}, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const childEnv = { ...process.env, DATABASE_URL: databaseUrl, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.PATH = `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`; // npm next to this node
  return new Promise(resolve => {
    execFile(command, args, { cwd: new URL('..', import.meta.url).pathname, timeout: timeoutMs, maxBuffer: 64 << 20, env: childEnv },
    (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, ms: Date.now() - started }));
  });
}

// Wraps a pg.Pool so every query issued through it (directly or through a
// checked-out client) is recorded as { text, values }.
export function recordingPool(pool, log) {
  const record = args => {
    const [first, second] = args;
    if (typeof first === 'string') log.push({ text: first, values: Array.isArray(second) ? second : [] });
    else if (first && typeof first.text === 'string') log.push({ text: first.text, values: first.values ?? (Array.isArray(second) ? second : []) });
  };
  const wrapClient = client => new Proxy(client, { get(target, prop) {
    if (prop === 'query') return (...args) => { record(args); return target.query(...args); };
    const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
  } });
  return new Proxy(pool, { get(target, prop) {
    if (prop === 'query') return (...args) => { record(args); return target.query(...args); };
    if (prop === 'connect') return async (...args) => {
      if (typeof args[0] === 'function') throw new Error('callback connect is not supported by the recording pool');
      return wrapClient(await target.connect());
    };
    const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
  } });
}
