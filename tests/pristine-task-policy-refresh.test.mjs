import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { refreshPristineRuntimeTaskVerification } from "../packages/piagent-core/runtime/recovery/pristine-task-policy-refresh.ts";

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-pristine-refresh-"));
  fs.mkdirSync(path.join(cwd, "v-nexus-frontend", "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "v-nexus-frontend", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(cwd, "v-nexus-frontend", "src", "app.ts"), "export const app = true;\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["-c", "user.name=Piagent", "-c", "user.email=piagent@example.invalid", "commit", "-qm", "fixture"], { cwd });
  return cwd;
}

function task(cwd) {
  const createdAt = "2026-08-24T00:00:00.000Z";
  const acceptanceCriteria = ["The configured verification command passes after the final mutation."];
  const scope = ["v-nexus-frontend/src/**"];
  const verifyCommands = ["if test -f frontend/package.json; then cd frontend; else exit 2; fi; npm test"];
  return {
    taskId: "legacy-auto-task",
    taskRunId: "legacy-auto-task-run",
    sessionId: "session-1",
    intakeMode: "runtime",
    changeMode: "source-change",
    mutationPolicy: "required",
    createdAt,
    updatedAt: createdAt,
    trace: { outcome: "pending" },
    acceptanceCriteria,
    scope,
    verifyCommands,
    changedFiles: [],
    observedChangedFiles: [],
    verifyEvidence: [],
    baselineFileDigests: workingTreeSnapshot(cwd),
    criterionGraph: compileCriterionGraph({ acceptanceCriteria, scope, verifyCommands, changeMode: "source-change", mode: "criterion-graph", createdAt })
  };
}

const profile = {
  verifyCommands: {
    frontendSource: ["cd v-nexus-frontend && npm test"],
    frontendRuntime: ["cd v-nexus-frontend && npm run test:e2e"],
    backendSource: ["cd v-nexus-backend && ./mvnw test"]
  }
};

test("refreshes a profile-derived verifier only while an automatic task is pristine", () => {
  const cwd = project();
  const current = task(cwd);
  const original = structuredClone(current);
  const refreshed = refreshPristineRuntimeTaskVerification(cwd, current, profile, "2026-08-24T01:00:00.000Z");

  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.verifyGroup, "frontendSource");
  assert.equal(refreshed.task.verifyGroup, "frontendSource");
  assert.deepEqual(refreshed.nextCommands, ["cd v-nexus-frontend && npm test"]);
  assert.deepEqual(refreshed.task.verifyCommands, refreshed.nextCommands);
  assert.notEqual(refreshed.task.criterionGraph.graphDigest, current.criterionGraph.graphDigest);
  assert.deepEqual(current, original, "refresh construction must not mutate persisted input before the caller writes it");

  fs.writeFileSync(path.join(cwd, "v-nexus-frontend", "src", "app.ts"), "export const app = false;\n");
  const afterMutation = refreshPristineRuntimeTaskVerification(cwd, current, profile);
  assert.equal(afterMutation.refreshed, false);
  assert.equal(afterMutation.reason, "working-tree-not-pristine");
});

test("preserves an existing valid verifier group and persists it with refreshed commands", () => {
  const cwd = project();
  const current = task(cwd);
  current.verifyGroup = "frontendRuntime";
  current.verifyCommands = ["cd frontend && npm run test:e2e"];
  current.criterionGraph = compileCriterionGraph({
    acceptanceCriteria: current.acceptanceCriteria,
    scope: current.scope,
    verifyCommands: current.verifyCommands,
    changeMode: current.changeMode,
    mode: current.criterionGraph.mode,
    createdAt: current.criterionGraph.createdAt
  });

  const refreshed = refreshPristineRuntimeTaskVerification(cwd, current, profile);

  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.verifyGroup, "frontendRuntime");
  assert.equal(refreshed.task.verifyGroup, "frontendRuntime");
  assert.deepEqual(refreshed.task.verifyCommands, ["cd v-nexus-frontend && npm run test:e2e"]);
});

test("persists an inferred group even when its commands were already current", () => {
  const cwd = project();
  const current = task(cwd);
  current.verifyCommands = ["cd v-nexus-frontend && npm test"];
  current.criterionGraph = compileCriterionGraph({
    acceptanceCriteria: current.acceptanceCriteria,
    scope: current.scope,
    verifyCommands: current.verifyCommands,
    changeMode: current.changeMode,
    mode: current.criterionGraph.mode,
    createdAt: current.criterionGraph.createdAt
  });

  const refreshed = refreshPristineRuntimeTaskVerification(cwd, current, profile);

  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.task.verifyGroup, "frontendSource");
  assert.deepEqual(refreshed.task.verifyCommands, current.verifyCommands);
});

test("does not replace verifier policy after task evidence exists", () => {
  const cwd = project();
  const current = task(cwd);
  current.observedChangedFiles = ["v-nexus-frontend/src/app.ts"];
  const result = refreshPristineRuntimeTaskVerification(cwd, current, profile);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, "task-has-runtime-evidence");
});
