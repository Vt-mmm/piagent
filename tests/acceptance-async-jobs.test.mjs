import assert from "node:assert/strict";
import test from "node:test";
import { createJobDrainer, MAX_ASYNC_JOBS } from "../packages/piagent-core/extensions/acceptance-executor/jobs.mjs";

test("guest job limits are inclusive and shared across drains within one case", () => {
  for (const count of [MAX_ASYNC_JOBS, MAX_ASYNC_JOBS + 1]) {
    let remaining = count, executed = 0;
    const runtime = { hasPendingJob: () => remaining > 0, executePendingJobs: maximum => {
      assert.equal(maximum, 1); remaining--; executed++; return { value: 1 };
    } };
    const jobs = createJobDrainer({ runtime, context: {}, interrupted: () => false, keep() {} });
    const result = jobs.drain();
    assert.equal(executed, MAX_ASYNC_JOBS);
    assert.deepEqual(result, count === MAX_ASYNC_JOBS ? null : { reason: "async-job-limit", outcome: "error" });
    assert.deepEqual(jobs.drain(), result, "another drain does not renew exhausted job capacity");
  }
});

test("interrupted, stalled and failed jobs cannot be treated as successful settlement", () => {
  for (const [interruption, result, reason] of [[true, { value: 1 }, "async-job-interrupted"],
    [false, { value: 0 }, "async-job-stalled"], [false, { error: { failed: true } }, "async-job-failed"]]) {
    const kept = []; let executed = 0;
    const jobs = createJobDrainer({ runtime: { hasPendingJob: () => true, executePendingJobs: () => { executed++; return result; } },
      context: {}, interrupted: () => interruption, keep: value => kept.push(value) });
    assert.deepEqual(jobs.drain(), { reason, outcome: "error" });
    assert.equal(executed, interruption ? 0 : 1);
    assert.deepEqual(kept, result.error ? [result.error] : []);
  }
});

test("intrinsic promise state retains only owned result handles, never the original non-Promise twice", () => {
  const original = { original: true }, returned = { returned: true }, error = { error: true }, retained = [];
  let state;
  const jobs = createJobDrainer({ runtime: {}, context: { getPromiseState: value => { assert.equal(value, original); return state; } },
    interrupted: () => false, keep: value => { retained.push(value); return value; } });
  state = { type: "fulfilled", notAPromise: true, value: original };
  assert.deepEqual(jobs.state(original), { value: original }); assert.deepEqual(retained, []);
  state = { type: "fulfilled", value: returned }; assert.deepEqual(jobs.state(original), { value: returned });
  state = { type: "rejected", error }; assert.deepEqual(jobs.state(original), { error });
  state = { type: "pending" }; assert.deepEqual(jobs.state(original), { reason: "async-promise-unsettled", outcome: "unsupported" });
  assert.deepEqual(retained, [returned, error]);
});

test("a final job that reports success cannot hide an interrupt delivered through Promise rejection", () => {
  let pending = true, stopped = false;
  const jobs = createJobDrainer({ runtime: { hasPendingJob: () => pending,
    executePendingJobs: () => { pending = false; stopped = true; return { value: 1 }; } },
    context: {}, interrupted: () => stopped, keep() {} });
  assert.deepEqual(jobs.drain(), { reason: "async-job-interrupted", outcome: "error" });
});
