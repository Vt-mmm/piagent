import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { taskDeltaFilesFromSnapshot } from "../packages/piagent-core/extensions/task-contract-view.js";
import { recordTaskCheckpoint } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { refreshLegacyHiddenWorkspaceEvidenceCoverage } from "../packages/piagent-core/runtime/recovery/task-evidence-coverage-refresh.ts";

function childGitRepo(cwd, files) {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "piagent@example.invalid"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent"]);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
}

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-coverage-refresh-"));
  childGitRepo(path.join(cwd, "frontend"), { "src/app.ts": "export const app = 'base';\n" });
  childGitRepo(path.join(cwd, "backend"), { "src/api.ts": "export const api = 'base';\n" });
  fs.mkdirSync(path.join(cwd, ".claude", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "notes", ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "scripts", "unchanged.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(cwd, ".claude", "scripts", "observed.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(cwd, ".claude", "scripts", "journal.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(cwd, "notes", ".cursor", "rules.md"), "project rules\n");
  return cwd;
}

function legacyTask(cwd) {
  const current = workingTreeSnapshot(cwd);
  const baselineFileDigests = Object.fromEntries(Object.entries(current)
    .filter(([file]) => !file.startsWith(".claude/") && !file.includes("/.cursor/")));
  return {
    taskId: "coverage-refresh",
    taskRunId: "coverage-refresh-run",
    sessionId: "coverage-session",
    changeMode: "source-change",
    trace: { outcome: "pending" },
    // The fixture files were created before this synthetic legacy task. The
    // future offset avoids filesystem timestamp-resolution assumptions.
    createdAt: new Date(Date.now() + 10_000).toISOString(),
    baselineChangedFiles: Object.keys(baselineFileDigests).sort(),
    baselineFileDigests,
    observedChangedFiles: [".claude/scripts/observed.sh"],
    changedFiles: []
  };
}

test("expands legacy hidden workspace coverage without swallowing an existing dirty-task delta", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = legacyTask(cwd);
  const original = structuredClone(task);
  recordTaskCheckpoint(cwd, {
    taskRunId: task.taskRunId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    checkpointId: "execute",
    idempotencyKey: "coverage-execute",
    phase: "execute",
    status: "in-progress",
    attempt: 1,
    evidence: { files: [".claude/scripts/journal.sh"] }
  });
  fs.writeFileSync(path.join(cwd, "frontend", "src", "app.ts"), "export const app = 'changed';\n");

  const refreshed = refreshLegacyHiddenWorkspaceEvidenceCoverage(cwd, task);
  const current = workingTreeSnapshot(cwd);

  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.reason, "legacy-hidden-workspace-coverage-expanded");
  assert.deepEqual(refreshed.addedPaths, [
    ".claude/scripts/unchanged.sh",
    "notes/.cursor/rules.md"
  ]);
  assert.deepEqual(refreshed.retainedMutationPaths, [
    ".claude/scripts/journal.sh",
    ".claude/scripts/observed.sh"
  ]);
  assert.deepEqual(refreshed.ambiguousPaths, []);
  assert.deepEqual(task, original, "refresh construction must not mutate the durable input object");
  assert.deepEqual(taskDeltaFilesFromSnapshot(refreshed.task, current), [
    ".claude/scripts/journal.sh",
    ".claude/scripts/observed.sh",
    "frontend/src/app.ts"
  ]);
  assert.equal(
    refreshed.task.baselineFileDigests["frontend/src/app.ts"],
    task.baselineFileDigests["frontend/src/app.ts"],
    "existing baseline evidence must remain byte-for-byte unchanged"
  );

  const repeated = refreshLegacyHiddenWorkspaceEvidenceCoverage(cwd, refreshed.task);
  assert.equal(repeated.refreshed, false);
  assert.equal(repeated.reason, "coverage-candidates-have-mutation-evidence");
});

test("keeps an unrecorded hidden mutation as a task delta across the crash window", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const baselineFileDigests = workingTreeSnapshot(cwd);
  const createdAt = new Date().toISOString();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const crashWindowPath = ".claude/scripts/new-after-task-start.sh";
  fs.writeFileSync(path.join(cwd, crashWindowPath), "#!/usr/bin/env bash\n# mutation completed before tool_result\n");
  const task = {
    taskId: "coverage-crash-window",
    taskRunId: "coverage-crash-window-run",
    sessionId: "coverage-session",
    changeMode: "source-change",
    trace: { outcome: "pending" },
    createdAt,
    baselineChangedFiles: Object.keys(baselineFileDigests).sort(),
    baselineFileDigests,
    observedChangedFiles: [],
    changedFiles: []
  };
  const current = workingTreeSnapshot(cwd);
  assert.deepEqual(taskDeltaFilesFromSnapshot(task, current), [crashWindowPath]);

  const refreshed = refreshLegacyHiddenWorkspaceEvidenceCoverage(cwd, task);

  assert.equal(refreshed.refreshed, false);
  assert.equal(refreshed.reason, "coverage-candidates-ambiguous");
  assert.deepEqual(refreshed.addedPaths, []);
  assert.deepEqual(refreshed.ambiguousPaths, [crashWindowPath]);
  assert.deepEqual(taskDeltaFilesFromSnapshot(refreshed.task, current), [crashWindowPath]);
});
