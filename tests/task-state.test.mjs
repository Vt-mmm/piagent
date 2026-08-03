import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeSessionTask,
  bindSessionTask,
  createTaskRunId,
  listTaskContracts,
  migrateTaskState,
  normalizeTaskContract,
  resolveTaskContract,
  safeTaskId,
  taskContractValidationErrors,
  taskStateMigrationStatus,
  workPlanDependencyError,
  workingTreeSnapshot,
  writeTaskContract
} from "../packages/piagent-core/extensions/task-state.js";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-state-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function contract(overrides = {}) {
  const now = "2026-07-31T01:02:03.000Z";
  return {
    schemaVersion: 2,
    taskRunId: "task-20260731010203-0123456789",
    taskId: "task",
    sessionId: "session-a",
    sessionName: "TASK-1",
    changeMode: "source-change",
    attempt: 1,
    maxAttempts: 3,
    previousAttempts: [],
    summary: "Implement the bounded fixture task",
    riskLane: "normal",
    expectedOutput: "The fixture contract is persisted safely.",
    acceptanceCriteria: ["Contract can be resolved"],
    scope: ["tracked.txt"],
    outOfScope: [],
    protectedPaths: [],
    requiredContext: [],
    contextManifest: [],
    memoryCitations: [],
    mcpCapabilities: [],
    verifyGroup: "source",
    verifyCommands: ["npm test"],
    workPlan: [],
    reviewLenses: [],
    baselineChangedFiles: [],
    baselineFileDigests: {},
    observedChangedFiles: [],
    finalWorkingTreeFiles: [],
    finalFileDigests: {},
    changedFiles: [],
    verifyEvidence: [],
    trace: { outcome: "pending" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("task run IDs preserve collision entropy for long task names", () => {
  const first = createTaskRunId("x".repeat(200), "session-a", "2026-07-31T01:02:03.000Z");
  const second = createTaskRunId("x".repeat(200), "session-a", "2026-07-31T01:02:03.000Z");
  assert.notEqual(first, second);
  assert.match(first, /^x{48}-20260731010203-[a-f0-9]{10}$/);
});

test("resolves identical task IDs only inside their bound sessions", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = writeTaskContract(cwd, contract());
  const second = writeTaskContract(cwd, contract({
    taskRunId: "task-20260731010303-abcdef0123",
    sessionId: "session-b",
    sessionName: "TASK-1 second window"
  }));
  bindSessionTask(cwd, "session-a", first.sessionName, first);
  bindSessionTask(cwd, "session-b", second.sessionName, second);

  assert.equal(activeSessionTask(cwd, "session-a").taskRunId, first.taskRunId);
  assert.equal(activeSessionTask(cwd, "session-b").taskRunId, second.taskRunId);
  assert.equal(resolveTaskContract(cwd, "task", "session-a").taskRunId, first.taskRunId);
  assert.equal(resolveTaskContract(cwd, second.taskRunId, "session-a"), undefined);
  assert.throws(() => bindSessionTask(cwd, "session-b", "wrong", first), /Cannot bind task/);
});

test("migrates v1 contracts without assigning unrelated history to the resumed session", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  for (const taskId of ["TASK-1", "TASK-2"]) {
    const legacy = contract({
      schemaVersion: 1,
      taskRunId: undefined,
      taskId,
      sessionId: undefined,
      baselineFileDigests: undefined,
      finalFileDigests: undefined
    });
    fs.writeFileSync(path.join(tasks, `${taskId.toLowerCase()}.json`), `${JSON.stringify(legacy)}\n`);
  }

  assert.equal(taskStateMigrationStatus(cwd).legacy, 2);
  const result = migrateTaskState(cwd, { taskId: "TASK-1", sessionId: "session-resumed", sessionName: "TASK-1" });
  assert.equal(result.migrated, 2);
  const migrated = listTaskContracts(cwd);
  assert.equal(migrated.find((item) => item.taskId === "task-1").sessionId, "session-resumed");
  assert.equal(migrated.find((item) => item.taskId === "task-2").sessionId, "legacy");
  assert.equal(taskStateMigrationStatus(cwd).legacy, 0);
  assert.equal(fs.readdirSync(path.join(tasks, "legacy-v1")).length, 2);
});

test("migrates a long v1 task without truncating away legacy run entropy", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const taskId = `investigate-${"long-task-name-".repeat(8)}`;
  const sourceName = safeTaskId(taskId);
  const legacy = contract({
    schemaVersion: 1,
    taskRunId: undefined,
    taskId,
    sessionId: undefined,
    baselineFileDigests: undefined,
    finalFileDigests: undefined
  });
  fs.writeFileSync(path.join(tasks, `${sourceName}.json`), `${JSON.stringify(legacy)}\n`);

  const result = migrateTaskState(cwd);
  const [migrated] = listTaskContracts(cwd);
  assert.deepEqual(result, { migrated: 1, current: 0, warnings: [] });
  assert.equal(migrated.taskId, sourceName);
  assert.notEqual(migrated.taskRunId, sourceName);
  assert.match(migrated.taskRunId, /-legacy-[a-f0-9]{12}$/);
  assert.equal(migrated.taskRunId.length, 80);
  assert.equal(taskStateMigrationStatus(cwd).current, 1);
  const archived = JSON.parse(fs.readFileSync(path.join(tasks, "legacy-v1", `${sourceName}.json`), "utf8"));
  assert.equal(archived.schemaVersion, 1);
});

test("archives a colliding v1 source before writing its v2 contract", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const legacy = contract({
    schemaVersion: 1,
    taskRunId: "task",
    sessionId: undefined,
    baselineFileDigests: undefined,
    finalFileDigests: undefined
  });
  fs.writeFileSync(path.join(tasks, "task.json"), `${JSON.stringify(legacy)}\n`);

  const result = migrateTaskState(cwd);
  const current = JSON.parse(fs.readFileSync(path.join(tasks, "task.json"), "utf8"));
  const archived = JSON.parse(fs.readFileSync(path.join(tasks, "legacy-v1", "task.json"), "utf8"));
  assert.deepEqual(result, { migrated: 1, current: 0, warnings: [] });
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.taskRunId, "task");
  assert.equal(archived.schemaVersion, 1);
  assert.equal(taskStateMigrationStatus(cwd).current, 1);
});

test("working-tree snapshots distinguish a file already dirty before the task from a later edit", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty before\n");
  const before = workingTreeSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "changed during task\n");
  const after = workingTreeSnapshot(cwd);
  assert.notEqual(before["tracked.txt"], after["tracked.txt"]);
});

test("working-tree snapshots remain truthful before the repository has its first commit", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-unborn-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  fs.writeFileSync(path.join(cwd, "first.txt"), "before\n");
  execFileSync("git", ["-C", cwd, "add", "first.txt"]);
  const before = workingTreeSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "first.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  const after = workingTreeSnapshot(cwd);

  assert.ok(before["first.txt"]);
  assert.notEqual(before["first.txt"], after["first.txt"]);
  assert.ok(after["new.txt"]);
});

test("working-tree snapshots retain both ends of a staged rename", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.renameSync(path.join(cwd, "tracked.txt"), path.join(cwd, "renamed.txt"));
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  const snapshot = workingTreeSnapshot(cwd);
  assert.deepEqual(Object.keys(snapshot).sort(), ["renamed.txt", "tracked.txt"]);
  assert.notEqual(snapshot["tracked.txt"], snapshot["renamed.txt"]);
});

test("rejects corrupted v2 contracts instead of silently normalizing them", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const invalid = contract({ sessionId: "", maxAttempts: 0 });
  assert.deepEqual(taskContractValidationErrors(invalid).filter((item) => /sessionId|maxAttempts/.test(item)), [
    "sessionId is required",
    "maxAttempts must be between 1 and 10",
    "attempt exceeds maxAttempts"
  ]);
  assert.equal(normalizeTaskContract(invalid), undefined);
  assert.throws(() => writeTaskContract(cwd, invalid), /Task contract is invalid/);
});

test("rejects malformed nested work-plan state and a v2 filename that lies about its run ID", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const invalidPlan = contract({
    workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "invented" }]
  });
  assert.match(taskContractValidationErrors(invalidPlan).join("; "), /workPlan entries are invalid/);

  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "different-run.json"), `${JSON.stringify(contract())}\n`);
  assert.equal(listTaskContracts(cwd).length, 0);
  assert.deepEqual(taskStateMigrationStatus(cwd).unreadable, ["different-run.json"]);
  assert.match(migrateTaskState(cwd).warnings.join("; "), /taskRunId does not match filename/);
});

test("keeps runtime validation aligned with closed nested schema objects", () => {
  const variants = [
    contract({ contextManifest: [{ path: "README.md", reason: "Task context", hidden: true }] }),
    contract({ previousAttempts: [{ taskRunId: "prior", attempt: 1, outcome: "failed", recordedAt: "2026-07-31T00:00:00.000Z", injected: "x" }] }),
    contract({ workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "pending", internal: true }] }),
    contract({ verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "passed", recordedAt: "2026-07-31T00:00:00.000Z", observedAt: "not-a-date" }] }),
    contract({ trace: { outcome: "pending", internal: true } }),
    contract({ orchestration: { mode: "solo-first", subagents: "not-used", reason: "Bounded task", modelRoles: { planner: "strong", unknown: "x" } } })
  ];
  for (const variant of variants) {
    assert.ok(taskContractValidationErrors(variant).length > 0);
    assert.equal(normalizeTaskContract(variant), undefined);
  }
});

test("legacy migration whitelists nested evidence instead of carrying unknown fields into v2", () => {
  const migrated = normalizeTaskContract(contract({
    schemaVersion: 1,
    taskRunId: undefined,
    sessionId: undefined,
    contextManifest: [{ path: "README.md", reason: "Task context", hidden: true }],
    workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "pending", internal: true }],
    orchestration: {
      mode: "solo-first",
      subagents: "not-used",
      reason: "Bounded task",
      internal: true,
      modelRoles: { planner: "strong", unknown: "x" }
    }
  }), { sourceName: "legacy" });

  assert.deepEqual(migrated.contextManifest, [{ path: "README.md", reason: "Task context" }]);
  assert.equal("internal" in migrated.workPlan[0], false);
  assert.equal("internal" in migrated.orchestration, false);
  assert.deepEqual(migrated.orchestration.modelRoles, { planner: "strong" });
  assert.deepEqual(taskContractValidationErrors(migrated), []);
});

test("rejects self-references and dependency cycles in persisted work plans", () => {
  const self = [{ id: "edit", dependsOn: ["edit"] }];
  const cycle = [
    { id: "plan", dependsOn: ["edit"] },
    { id: "edit", dependsOn: ["plan"] }
  ];
  assert.match(workPlanDependencyError(self), /depends on itself/);
  assert.match(workPlanDependencyError(cycle), /cycle/);
  assert.match(taskContractValidationErrors(contract({
    workPlan: cycle.map((step) => ({
      ...step,
      title: step.id,
      role: "parent",
      mode: "single-writer",
      status: "pending"
    }))
  })).join("; "), /cycle/);
});
