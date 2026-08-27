import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";

const root = path.resolve(import.meta.dirname, "..");
const taskFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));

async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provider-cache-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "BASE\n");
  execFileSync("git", ["-C", cwd, "add", "a.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  const baseline = workingTreeSnapshot(cwd), createdAt = "2026-08-27T01:00:00.000Z";
  let taskState = { ...structuredClone(taskFixture), taskId: "provider-cache-task", taskRunId: "provider-cache-task-run",
    sessionId: "provider-cache-session", sessionName: "Provider cache", summary: "Provider cache authority",
    baselineChangedFiles: [], baselineFileDigests: baseline, trace: { outcome: "pending" }, createdAt, updatedAt: createdAt };
  taskState.authoritySnapshot = createBoundTaskAuthority(taskState);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: taskState.taskId, taskRunId: taskState.taskRunId,
    sessionId: taskState.sessionId, capturedAt: createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  fs.writeFileSync(path.join(cwd, "a.txt"), "AFTER\n");
  let replayState = "current", onTaskRead = () => undefined;
  const eventStore = {
    retention: () => ({ eventRetentionCount: 100, eventRetentionSeconds: 3600 }),
    currentCursor: () => "cursor.provider-cache", resyncRequired: () => false,
    replay: () => ({ state: replayState, events: [], nextCursor: "cursor.provider-cache", latestCursor: "cursor.provider-cache",
      reasonCode: replayState === "current" ? null : "cursor-truncated" })
  };
  const provider = new CoreInspectionProvider({ cwd, sessionId: taskState.sessionId, runtimeInstanceId: "runtime.provider-cache",
    eventStore, task: () => { onTaskRead(); return taskState; }, sessionEntries: () => [] });
  return { cwd, provider, setReplayState(value) { replayState = value; }, setTaskRead(value) { onTaskRead = value; },
    updateTask() { taskState = { ...taskState, updatedAt: "2026-08-27T01:00:01.000Z" }; },
    replaceTask() { taskState = { ...taskState, taskId: "provider-cache-task-next", taskRunId: "provider-cache-task-run-next",
      updatedAt: "2026-08-27T01:00:02.000Z" }; taskState.authoritySnapshot = createBoundTaskAuthority(taskState); } };
}

test("diff cache entries are bound to the current source projection and selected file revision", async (t) => {
  let clock = 1_000;
  t.mock.method(Date, "now", () => clock);
  const current = await fixture(t), snapshot = await current.provider.snapshot();
  const source = await current.provider.sourceChanges("working-tree"), fileRef = source.files[0].fileRef;
  clock = 1_100;
  const before = await current.provider.diff("working-tree", fileRef);
  fs.writeFileSync(path.join(current.cwd, "a.txt"), "CHANGED\n");
  clock = 1_201;
  const after = await current.provider.diff("working-tree", fileRef);
  assert.equal(after.availability.state, "current");
  assert.notEqual(after.observed.fileRevision, before.observed.fileRevision);
  assert.notEqual((await current.provider.snapshot()).sourceChanges.projectionRevision, snapshot.sourceChanges.projectionRevision);
});

test("an invalidated in-flight diff cannot repopulate the cache", async (t) => {
  const current = await fixture(t), source = await current.provider.sourceChanges("working-tree"), fileRef = source.files[0].fileRef;
  const pending = current.provider.diff("working-tree", fileRef);
  fs.writeFileSync(path.join(current.cwd, "a.txt"), "CHANGED DURING READ\n");
  current.provider.invalidate();
  const stale = await pending;
  assert.notEqual(stale.availability.state, "current");
  fs.writeFileSync(path.join(current.cwd, "a.txt"), "AFTER\n");
  const recovered = await current.provider.diff("working-tree", fileRef);
  assert.equal(recovered.availability.state, "current");
  assert.equal(recovered.observed.fileRevision, source.files[0].fileRevision);
});

test("diff cache entries cannot cross a task identity transition with identical source bytes", async (t) => {
  let clock = 1_000;
  t.mock.method(Date, "now", () => clock);
  const current = await fixture(t), snapshot = await current.provider.snapshot();
  const source = await current.provider.sourceChanges("working-tree"), fileRef = source.files[0].fileRef;
  clock = 1_100;
  const before = await current.provider.diff("working-tree", fileRef);
  current.replaceTask(); clock = 1_201;
  const after = await current.provider.diff("working-tree", fileRef);
  assert.equal(before.identity.taskRunId, snapshot.identity.taskRunId);
  assert.equal(after.identity.taskRunId, "provider-cache-task-run-next");
});

test("a non-current replay generation-fences an in-flight projection", async (t) => {
  const current = await fixture(t);
  await current.provider.snapshot();
  current.provider.invalidate();
  let capturedResolve;
  const captured = new Promise((resolve) => { capturedResolve = resolve; });
  current.setTaskRead(() => capturedResolve());
  const pending = current.provider.snapshot();
  await captured;
  current.updateTask(); current.setReplayState("truncated");
  assert.equal(current.provider.replay(null, 10).state, "truncated");
  const preReplayProjection = await pending;
  current.setReplayState("current"); current.setTaskRead(() => undefined);
  const postReplayProjection = await current.provider.snapshot();
  assert.notEqual(postReplayProjection.revision.taskRevision, preReplayProjection.revision.taskRevision);
});
