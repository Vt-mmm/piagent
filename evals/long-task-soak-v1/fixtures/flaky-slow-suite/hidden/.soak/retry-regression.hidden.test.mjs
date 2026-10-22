// Hidden deterministic checks for ISSUE.md / docs/retry.md. Every random value
// comes from a seeded PRNG, every clock and sleep is fake: on the original code
// these fail on every run, not by luck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, RetriesExhaustedError, RetryDeadlineError } from '../src/retry.js';
import { relay } from '../src/relay.js';

function rng(seed) { // mulberry32, independent of the project's copy
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLANS = [
  { retries: 50, baseMs: 200, capMs: 1600, deadlineMs: 3000 },
  { retries: 8, baseMs: 50, capMs: 5000, deadlineMs: 20_000 },
  { retries: 50, baseMs: 1000, capMs: 1000, deadlineMs: 2500 },
  { retries: 4, baseMs: 300, capMs: 900, deadlineMs: 1800 },
];
const COST = 7; // fake ms every failing attempt takes

// docs/retry.md, step by step.
function model(random, { retries, baseMs, capMs, deadlineMs }) {
  let t = 0;
  const slept = [];
  for (let n = 1; ; n++) {
    t += COST;
    if (n > retries) return { name: 'RetriesExhaustedError', attempts: n, slept };
    const delay = Math.floor(random() * Math.min(capMs, baseMs * 2 ** (n - 1)));
    if (t + delay > deadlineMs) return { name: 'RetryDeadlineError', attempts: n, slept };
    slept.push(delay);
    t += delay;
  }
}

async function run(plan, extra = {}) {
  let t = 0;
  const slept = [];
  let crossed = null;
  const options = {
    ...plan, ...extra,
    now: () => t,
    sleep: async ms => { slept.push(ms); t += ms; if (t > plan.deadlineMs) crossed ??= t; },
  };
  try {
    await withRetry(async () => { t += COST; throw new Error('down'); }, options);
    return { name: 'resolved', slept, crossed };
  } catch (error) {
    return { name: error?.name, attempts: error?.attempts, isDeadline: error instanceof RetryDeadlineError, isExhausted: error instanceof RetriesExhaustedError, cause: error?.cause?.message, slept, crossed, message: String(error?.message) };
  }
}

async function withMathRandom(replacement, fn) {
  const original = Math.random;
  Math.random = replacement;
  try { return await fn(); } finally { Math.random = original; }
}
const poisoned = () => { throw new Error('Math.random was called although a random option was given'); };

function compare(got, want, label) {
  assert.equal(got.name, want.name, `${label}: ${got.message ?? got.name}`);
  assert.equal(got.attempts, want.attempts, `${label}: attempts`);
  assert.deepEqual(got.slept, want.slept, `${label}: sleeps`);
  assert.equal(got.cause, 'down', `${label}: cause`);
  assert.ok(want.name === 'RetryDeadlineError' ? got.isDeadline : got.isExhausted, `${label}: error class`);
  assert.equal(got.crossed, null, `${label}: slept past the deadline (until ${got.crossed}ms)`);
}

test('withRetry uses the injected random source, one draw per retry, never past the deadline', async () => {
  for (const [p, plan] of PLANS.entries()) {
    for (let seed = 1; seed <= 300; seed++) {
      const got = await withMathRandom(poisoned, () => run(plan, { random: rng(seed) }));
      compare(got, model(rng(seed), plan), `plan ${p} seed ${seed}`);
    }
  }
});

test('with the default random source: one draw per retry, never past the deadline', async () => {
  for (const [p, plan] of PLANS.entries()) {
    for (let seed = 1; seed <= 300; seed++) {
      const got = await withMathRandom(rng(seed), () => run(plan));
      compare(got, model(rng(seed), plan), `plan ${p} seed ${seed} (Math.random)`);
    }
  }
});

test('a draw that does not fit the deadline gives up without sleeping', async () => {
  const plan = { retries: 10, baseMs: 1000, capMs: 1000, deadlineMs: 500 };
  const draws = [0.2, 0.9, 0.9, 0.9, 0.9];
  const got = await withMathRandom(poisoned, () => run(plan, { random: () => draws.shift() }));
  // attempt 1: t=7, delay 200 fits → sleep; attempt 2: t=214, delay 900 → give up.
  assert.deepEqual(got.slept, [200]);
  assert.equal(got.name, 'RetryDeadlineError');
  assert.equal(got.attempts, 2);
});

test('relay passes retry.random through to withRetry', async () => {
  let t = 0;
  const seen = new Set();
  const sink = { async send(key) { if (!seen.has(key)) { seen.add(key); throw new Error('transient'); } } };
  const records = Array.from({ length: 6 }, (_, i) => ({ id: i }));
  const stats = await withMathRandom(poisoned, () => relay(records, {
    sink, batchSize: 2,
    retry: { random: rng(7), now: () => t, sleep: async ms => { t += ms; }, baseMs: 10, capMs: 10 },
  }));
  assert.deepEqual(stats, { batches: 3, delivered: 6, retries: 3 });
});
