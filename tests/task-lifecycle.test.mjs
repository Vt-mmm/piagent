import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRuntimeLifecycleObservation,
  runtimeLifecycleMode,
  workingTreeEvidenceDigest
} from "../packages/piagent-core/extensions/task-lifecycle.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

function tinyTask() {
  return {
    changeMode: "source-change",
    riskLane: "tiny",
    workPlan: [
      { id: "implement", role: "parent", mode: "single-writer", status: "in-progress" },
      { id: "verify", role: "parent", mode: "review", status: "pending", dependsOn: ["implement"] }
    ]
  };
}

function normalTask() {
  return {
    changeMode: "source-change",
    riskLane: "normal",
    workPlan: [
      { id: "plan", role: "parent", mode: "read-only", status: "in-progress" },
      { id: "implement", role: "parent", mode: "single-writer", status: "pending", dependsOn: ["plan"] },
      { id: "review", role: "piagent-reviewer", mode: "review", status: "pending", dependsOn: ["implement"] }
    ]
  };
}

function readOnlyTask(riskLane = "normal") {
  return {
    changeMode: "read-only",
    riskLane,
    workPlan: riskLane === "tiny"
      ? [{ id: "scout", role: "parent", mode: "read-only", status: "in-progress" }]
      : [
          { id: "scout", role: "parent", mode: "read-only", status: "in-progress" },
          { id: "review", role: "piagent-reviewer", mode: "review", status: "pending", dependsOn: ["scout"] }
        ]
  };
}

test("working-tree evidence digest is ordered and changes with content", () => {
  const one = versionWorkingTreeHash("1".repeat(64)), two = versionWorkingTreeHash("2".repeat(64)), different = versionWorkingTreeHash("3".repeat(64));
  const left = workingTreeEvidenceDigest({ "b.ts": two, "a.ts": one });
  const reordered = workingTreeEvidenceDigest({ "a.ts": one, "b.ts": two });
  const changed = workingTreeEvidenceDigest({ "a.ts": different, "b.ts": two });
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
  assert.match(left, /^wt-content-v2:[a-f0-9]{64}$/);
  assert.match(workingTreeEvidenceDigest({ "a.ts": "malformed" }), /^legacy-untrusted:/);
});

test("tiny default plan is automatic and reopens after a later mutation", () => {
  const task = tinyTask();
  assert.equal(runtimeLifecycleMode(task), "automatic");
  applyRuntimeLifecycleObservation(task, "verification-complete", "2026-08-01T00:00:00.000Z");
  assert.deepEqual(task.workPlan.map((step) => step.status), ["done", "done"]);

  applyRuntimeLifecycleObservation(task, "mutation", "2026-08-01T00:01:00.000Z");
  assert.deepEqual(task.workPlan.map((step) => step.status), ["in-progress", "pending"]);
});

test("normal default plan automates objective phases but preserves explicit review", () => {
  const task = normalTask();
  assert.equal(runtimeLifecycleMode(task), "assisted");
  applyRuntimeLifecycleObservation(task, "mutation", "2026-08-01T00:00:00.000Z");
  assert.deepEqual(task.workPlan.map((step) => step.status), ["done", "in-progress", "pending"]);

  applyRuntimeLifecycleObservation(task, "verification-complete", "2026-08-01T00:01:00.000Z");
  assert.deepEqual(task.workPlan.map((step) => step.status), ["done", "done", "in-progress"]);
});

test("read-only default plans advance from observed context without an implementation phase", () => {
  const tiny = readOnlyTask("tiny");
  assert.equal(runtimeLifecycleMode(tiny), "automatic-readonly");
  applyRuntimeLifecycleObservation(tiny, "context-complete", "2026-08-01T00:00:00.000Z");
  assert.deepEqual(tiny.workPlan.map((step) => step.status), ["done"]);

  const normal = readOnlyTask();
  assert.equal(runtimeLifecycleMode(normal), "assisted-readonly");
  applyRuntimeLifecycleObservation(normal, "context-complete", "2026-08-01T00:00:00.000Z");
  assert.deepEqual(normal.workPlan.map((step) => step.status), ["done", "in-progress"]);
});

test("custom and high-risk plans remain manual", () => {
  const task = tinyTask();
  task.workPlan[1].role = "piagent-reviewer";
  assert.equal(runtimeLifecycleMode(task), "manual");
  assert.equal(applyRuntimeLifecycleObservation(task, "verification-complete").changed, false);

  const highRisk = normalTask();
  highRisk.riskLane = "high-risk";
  assert.equal(runtimeLifecycleMode(highRisk), "manual");
});
