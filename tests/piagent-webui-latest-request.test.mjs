import assert from "node:assert/strict";
import test from "node:test";

import { WebUiRequestError } from "../packages/piagent-webui/client/src/api.ts";
import { LatestRequestWins, SingleFlightRequest } from "../packages/piagent-webui/client/src/latest-request.ts";
import { acceptedInspectionEventCursor, inspectionSnapshotFailureDisposition, inspectionSnapshotRetryDelay,
  recoverInitialInspectionSnapshot, validatedInspectionSnapshot } from "../packages/piagent-webui/client/src/use-inspection.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test("latest request wins state while each caller retains its own read result", async () => {
  const requests = new LatestRequestWins(), firstRead = deferred(), secondRead = deferred(), accepted = [];
  const first = requests.run(() => firstRead.promise, (value) => accepted.push(value), () => accepted.push("first-error"));
  const second = requests.run(() => secondRead.promise, (value) => accepted.push(value), () => accepted.push("second-error"));
  firstRead.resolve("old");
  assert.equal(await first, "old", "a recovery caller may still use its own successful cursor");
  secondRead.resolve("new");
  assert.equal(await second, "new");
  assert.deepEqual(accepted, ["new"]);
});

test("a newer failure cannot erase an older caller's successful recovery result", async () => {
  const requests = new LatestRequestWins(), firstRead = deferred(), secondRead = deferred(), accepted = [], rejected = [];
  const first = requests.run(() => firstRead.promise, (value) => accepted.push(value), () => rejected.push("first"));
  const second = requests.run(() => secondRead.promise, (value) => accepted.push(value), () => rejected.push("second"));
  firstRead.resolve("old"); secondRead.reject(new Error("latest failed"));
  assert.equal(await second, undefined); assert.equal(await first, "old");
  assert.deepEqual(accepted, []); assert.deepEqual(rejected, ["second"]);
});

test("invalidate prevents an abandoned request from committing", async () => {
  const requests = new LatestRequestWins(), read = deferred(), accepted = [], rejected = [];
  const pending = requests.run(() => read.promise, (value) => accepted.push(value), () => rejected.push("error"));
  requests.invalidate(); read.resolve("abandoned");
  assert.equal(await pending, "abandoned"); assert.deepEqual(accepted, []); assert.deepEqual(rejected, []);
});

test("single-flight requests serialize one dirty follow-up and commit before resolving each caller", async () => {
  const firstRead = deferred(), secondRead = deferred(), commits = [];
  let reads = 0, active = 0, maximumActive = 0;
  const coordinator = new SingleFlightRequest({
    read: async () => {
      const target = reads++ === 0 ? firstRead : secondRead;
      active += 1; maximumActive = Math.max(maximumActive, active);
      try { return await target.promise; } finally { active -= 1; }
    },
    commit: (value) => commits.push(value),
    classify: () => "terminal"
  });
  const first = coordinator.request();
  const second = coordinator.request();
  assert.equal(reads, 1, "a request arriving during a read only marks one dirty follow-up");
  firstRead.resolve("snapshot-before-dirty-request");
  const firstOutcome = await first;
  assert.equal(firstOutcome.state, "committed"); assert.equal(firstOutcome.value, "snapshot-before-dirty-request");
  assert.deepEqual(commits, ["snapshot-before-dirty-request"], "the snapshot is committed before its caller resumes");
  assert.equal(reads, 2);
  secondRead.resolve("snapshot-after-dirty-request");
  const secondOutcome = await second;
  assert.equal(secondOutcome.state, "committed"); assert.equal(secondOutcome.value, "snapshot-after-dirty-request");
  assert.deepEqual(commits, ["snapshot-before-dirty-request", "snapshot-after-dirty-request"]);
  assert.equal(maximumActive, 1, "snapshot reads never overlap");
});

test("single-flight invalidation cancels waiters and withholds an abandoned commit", async () => {
  const read = deferred(), commits = [];
  const coordinator = new SingleFlightRequest({ read: () => read.promise, commit: (value) => commits.push(value),
    classify: () => "retryable" });
  const pending = coordinator.request(); coordinator.invalidate(); read.resolve("late");
  assert.equal((await pending).state, "cancelled");
  assert.equal((await coordinator.request()).state, "cancelled");
  assert.deepEqual(commits, []);
});

test("single-flight treats an uncommittable value as terminal even when TypeError normally means network failure", async () => {
  let reads = 0;
  const coordinator = new SingleFlightRequest({ read: async () => { reads += 1; return {}; },
    commit: (value) => { value.revision.eventCursor; }, classify: () => "retryable" });
  const first = coordinator.request(), dirty = coordinator.request();
  const outcome = await first;
  assert.equal(outcome.state, "terminal-error"); assert.equal(outcome.readSequence, 1);
  assert.equal((await dirty).state, "cancelled"); assert.equal(reads, 1, "terminal failure suppresses the dirty follow-up read");
});

test("inspection snapshot errors distinguish retryable transport failures from terminal authority and parse failures", () => {
  for (const status of [408, 409, 423, 425, 429, 500, 503]) {
    assert.equal(inspectionSnapshotFailureDisposition(new WebUiRequestError(status)), "retryable");
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(inspectionSnapshotFailureDisposition(new WebUiRequestError(status)), "terminal");
  }
  assert.equal(inspectionSnapshotFailureDisposition(new TypeError("network offline")), "retryable");
  assert.equal(inspectionSnapshotFailureDisposition(new SyntaxError("invalid json")), "terminal");
  assert.equal(inspectionSnapshotFailureDisposition(new DOMException("aborted", "AbortError")), "terminal");
});

test("inspection cursor advances only to a valid client-accepted SSE or snapshot cursor", () => {
  assert.equal(acceptedInspectionEventCursor("cursor.old", "cursor.new", "cursor.fallback"), "cursor.new");
  assert.equal(acceptedInspectionEventCursor("cursor.old", "contains space", ""), "cursor.old");
  assert.equal(acceptedInspectionEventCursor(null, undefined, "event-cursor.current"), "event-cursor.current");
});

test("inspection rejects wrong-shape JSON and an invalid canonical cursor before committing it", () => {
  assert.throws(() => validatedInspectionSnapshot({}), /invalid-inspection-snapshot/);
  const minimal = { schemaVersion: 1, version: "piagent-webui-snapshot-v1", generatedAt: new Date().toISOString(),
    identity: {}, revision: { eventCursor: "event cursor with spaces" }, capabilities: {}, session: {}, sourceChanges: {},
    activity: {}, approvals: {}, verification: {}, usage: {}, continuation: {}, health: {} };
  assert.throws(() => validatedInspectionSnapshot(minimal), /invalid-inspection-snapshot-cursor/);
  minimal.revision.eventCursor = "event-cursor.valid";
  assert.equal(validatedInspectionSnapshot(minimal), minimal);
});

test("initial inspection recovery continues past transient failures with a capped backoff", async () => {
  const values = Array.from({ length: 8 }, (_, readSequence) => ({ state: "retryable-error", error: new TypeError("offline"), readSequence }));
  values.push({ state: "committed", value: "snapshot-current", readSequence: 9 });
  const delays = [];
  const outcome = await recoverInitialInspectionSnapshot({
    read: async () => values.shift(),
    wait: async (delayMs) => { delays.push(delayMs); },
    stopped: () => false
  });
  assert.equal(outcome.state, "committed"); assert.equal(outcome.value, "snapshot-current");
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000]);
  assert.equal(inspectionSnapshotRetryDelay(100), 4_000);
});

test("initial inspection recovery stops cleanly while waiting to retry", async () => {
  let stopped = false, reads = 0;
  const outcome = await recoverInitialInspectionSnapshot({
    read: async () => { reads += 1; return { state: "retryable-error", error: new TypeError("offline"), readSequence: reads }; },
    wait: async () => { stopped = true; },
    stopped: () => stopped
  });
  assert.equal(outcome.state, "cancelled"); assert.equal(reads, 1);
});

test("initial inspection recovery stops immediately on a terminal snapshot failure", async () => {
  let waits = 0;
  const outcome = await recoverInitialInspectionSnapshot({
    read: async () => ({ state: "terminal-error", error: new WebUiRequestError(401), readSequence: 1 }),
    wait: async () => { waits += 1; }, stopped: () => false
  });
  assert.equal(outcome.state, "terminal-error"); assert.equal(waits, 0);
});
