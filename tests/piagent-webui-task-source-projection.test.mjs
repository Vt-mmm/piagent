import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { captureTaskBaselineManifest, taskBaselineManifestPath } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { collectGitStatus, projectGitPath } from "../packages/piagent-core/runtime/inspection/git-status-adapter.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { collectFileDiff } from "../packages/piagent-core/runtime/inspection/diff-projection.ts";
import { readTaskFileContents } from "../packages/piagent-core/runtime/inspection/task-source-projection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = {
  projectRef: "project_01",
  runtimeInstanceId: "runtime_01",
  sessionRef: "session_01",
  taskId: "task_01",
  taskRunId: "task_01_run_01",
  agentOperationId: null,
  toolCallId: null
};
const generatedAt = "2026-08-13T13:00:00.000Z";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-source-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "clean.txt"), "clean baseline\n");
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "clean before dirty\n");
  fs.writeFileSync(path.join(cwd, "deleted.txt"), "tracked deleted baseline\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

async function capture(cwd, overrides = {}) {
  return await captureTaskBaselineManifest({
    projectRoot: cwd,
    taskId: identity.taskId,
    taskRunId: identity.taskRunId,
    sessionId: "private-session-id",
    capturedAt: generatedAt,
    baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)),
    ...overrides
  });
}

function expectValid(document) {
  const result = validateFixture(registry, "source-change-v1", document);
  assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI exact task source projection", () => {
  it("excludes unchanged pre-existing dirt and includes only post-baseline deltas", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty before task\n");
    fs.writeFileSync(path.join(cwd, "untracked-before.txt"), "untracked before task\n");
    fs.rmSync(path.join(cwd, "deleted.txt"));
    await capture(cwd);

    fs.writeFileSync(path.join(cwd, "clean.txt"), "clean changed by task\n");
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty changed again\n");
    fs.writeFileSync(path.join(cwd, "deleted.txt"), "tracked deleted baseline\n");
    fs.writeFileSync(path.join(cwd, "new-after.txt"), "new after task\n");
    const views = await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_01", generatedAt });
    expectValid(views.task);
    assert.equal(views.task.availability.state, "current");
    const task = new Map(views.task.files.map((file) => [file.path, file]));
    assert.deepEqual([...task.keys()].sort(), ["clean.txt", "deleted.txt", "dirty.txt", "new-after.txt"]);
    assert.equal(task.has("untracked-before.txt"), false);
    assert.equal(task.get("clean.txt").status, "M");
    assert.equal(task.get("dirty.txt").status, "M");
    assert.equal(task.get("deleted.txt").status, "A");
    assert.equal(task.get("new-after.txt").status, "U");
    assert.match(task.get("dirty.txt").baseDigest, /^sha256:/);
    assert.match(task.get("dirty.txt").currentDigest, /^sha256:/);
    assert.notEqual(task.get("dirty.txt").baseDigest, task.get("dirty.txt").currentDigest);
    assert.equal(views.workingTree.files.some((file) => file.path.startsWith(".pi/piagent-state")), false);
  });

  it("keeps restoration and deletion relative to the task baseline", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty before task\n");
    fs.writeFileSync(path.join(cwd, "untracked-before.txt"), "untracked before task\n");
    await capture(cwd);
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "clean before dirty\n");
    fs.rmSync(path.join(cwd, "untracked-before.txt"));

    const task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_02", generatedAt })).task;
    expectValid(task);
    const byPath = new Map(task.files.map((file) => [file.path, file]));
    assert.deepEqual([...byPath.keys()].sort(), ["dirty.txt", "untracked-before.txt"]);
    assert.equal(byPath.get("dirty.txt").status, "M");
    assert.equal(byPath.get("untracked-before.txt").status, "D");
  });

  it("fails the task view closed when any baseline content is protected", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "protected.txt"), "secret dirty baseline\n");
    await capture(cwd, { isProtectedProjectPath: (projectPath) => projectPath === "protected.txt" });
    fs.writeFileSync(path.join(cwd, "protected.txt"), "secret changed\n");
    const task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_03", generatedAt })).task;
    expectValid(task);
    assert.equal(task.availability.state, "unavailable");
    assert.equal(task.files.length, 0);
    assert.equal(task.redaction.applied, true);
  });

  it("applies the current protected policy before projecting or diffing a post-baseline file", async () => {
    const cwd = repository();
    await capture(cwd);
    const secretPath = path.join(cwd, "secret.txt");
    fs.writeFileSync(secretPath, "TOP SECRET\n");
    const secretStat = fs.statSync(secretPath);
    const originalReadSync = fs.readSync;
    let protectedReads = 0;
    fs.readSync = function observedRead(descriptor, ...args) {
      try {
        const stat = fs.fstatSync(descriptor);
        if (stat.dev === secretStat.dev && stat.ino === secretStat.ino) protectedReads += 1;
      } catch {
        // Preserve the original read behavior for descriptors that cannot be inspected.
      }
      return originalReadSync.call(fs, descriptor, ...args);
    };
    const isProtectedPath = (_root, repoPath) => repoPath === "secret.txt";
    try {
      const task = (await collectSourceChangeViews({
        cwd, identity, taskRevision: "task_rev_protected_new", generatedAt, isProtectedPath
      })).task;
      expectValid(task);
      const file = task.files.find((entry) => entry.path === "secret.txt");
      assert.ok(file);
      assert.equal(file.content.access, "protected");
      assert.equal(file.baseDigest, null);
      assert.equal(file.currentDigest, null);
      assert.deepEqual(file.stats, { state: "unavailable", additions: null, deletions: null, reasonCode: "protected-path" });
      assert.equal(task.redaction.applied, true);
      assert.equal(task.health.state, "degraded");
      assert.equal(JSON.stringify(task).includes("TOP SECRET"), false);

      const document = await collectFileDiff({
        cwd, identity, sourceView: task, fileRef: file.fileRef,
        precondition: {
          expectedViewRevision: task.viewRevision,
          expectedFileRevision: file.fileRevision,
          expectedBaseDigest: null,
          expectedCurrentDigest: null
        },
        taskRevision: "task_rev_protected_new", generatedAt, isProtectedPath
      });
      const result = validateFixture(registry, "diff-v1", document);
      assert.equal(result.valid, true, result.errors);
      assert.equal(document.fallback.kind, "protected");
      assert.equal(document.availability.state, "unavailable");
      assert.deepEqual(document.hunks, []);
      assert.equal(JSON.stringify(document).includes("TOP SECRET"), false);
      assert.equal(protectedReads, 0, "source recollection and task diff must not read protected workspace bytes");
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("applies current protection to both sides of a rename", async () => {
    for (const committed of [false, true]) for (const protectedName of ["clean.txt", "renamed.txt"]) {
      const cwd = repository();
      await capture(cwd);
      git(cwd, "mv", "clean.txt", "renamed.txt");
      if (committed) git(cwd, "commit", "-qm", "committed protected rename");
      const renamedStat = fs.statSync(path.join(cwd, "renamed.txt"));
      const originalReadSync = fs.readSync;
      let renamedReads = 0;
      fs.readSync = function observedRead(descriptor, ...args) {
        try {
          const stat = fs.fstatSync(descriptor);
          if (stat.dev === renamedStat.dev && stat.ino === renamedStat.ino) renamedReads += 1;
        } catch {
          // Preserve the original behavior for descriptors that cannot be inspected.
        }
        return originalReadSync.call(fs, descriptor, ...args);
      };
      const isProtectedPath = (_root, repoPath) => repoPath === protectedName;
      try {
        const task = (await collectSourceChangeViews({
          cwd, identity, taskRevision: "task_rev_protected_rename", generatedAt, isProtectedPath
        })).task;
        expectValid(task);
        const renameFiles = task.files.filter((entry) => ["clean.txt", "renamed.txt"].includes(entry.path));
        assert.ok(renameFiles.length > 0);
        for (const file of renameFiles) {
          assert.equal(file.content.access, "protected");
          assert.equal(file.baseDigest, null);
          assert.equal(file.currentDigest, null);
          assert.equal(file.stats.state, "unavailable");
          assert.equal(file.stats.reasonCode, "protected-path");
        }
        const file = renameFiles[0];
        const document = await collectFileDiff({
          cwd, identity, sourceView: task, fileRef: file.fileRef,
          precondition: { expectedViewRevision: task.viewRevision, expectedFileRevision: file.fileRevision,
            expectedBaseDigest: null, expectedCurrentDigest: null },
          taskRevision: "task_rev_protected_rename", generatedAt, isProtectedPath
        });
        assert.equal(document.fallback.kind, "protected");
        assert.deepEqual(document.hunks, []);
        assert.equal(renamedReads, 0, `${committed ? "committed" : "staged"} ${protectedName} must protect both rename-side inodes during source and diff collection`);
      } finally {
        fs.readSync = originalReadSync;
      }
    }
  });

  it("excludes an internal-state rename from Task Changes and task content lookup", async () => {
    const cwd = repository();
    const oldName = ".pi/piagent-state/private.txt", newName = "public-name.txt";
    fs.mkdirSync(path.dirname(path.join(cwd, oldName)), { recursive: true });
    fs.writeFileSync(path.join(cwd, oldName), "INTERNAL STATE RAW SECRET\n");
    git(cwd, "add", "-f", oldName);
    git(cwd, "commit", "-qm", "tracked internal fixture");
    await capture(cwd);
    git(cwd, "mv", oldName, newName);
    git(cwd, "commit", "-qm", "committed internal rename");
    const renamedStat = fs.statSync(path.join(cwd, newName));
    const originalReadSync = fs.readSync;
    let renamedReads = 0;
    fs.readSync = function observedRead(descriptor, ...args) {
      try {
        const stat = fs.fstatSync(descriptor);
        if (stat.dev === renamedStat.dev && stat.ino === renamedStat.ino) renamedReads += 1;
      } catch {
        // Preserve the original behavior for descriptors that cannot be inspected.
      }
      return originalReadSync.call(fs, descriptor, ...args);
    };
    try {
      const options = { cwd, identity, taskRevision: "task_rev_internal_rename", generatedAt };
      const views = await collectSourceChangeViews(options);
      expectValid(views.task);
      assert.equal(views.task.files.some((file) => [oldName, newName].includes(file.path)), false);
      assert.equal(JSON.stringify(views).includes("INTERNAL STATE RAW SECRET"), false);
      const snapshot = await collectGitStatus(cwd);
      const display = projectGitPath(newName);
      const fileRef = `file.${createHash("sha256").update(`${snapshot.repoDigest}\0${display.digest}`).digest("hex")}`;
      assert.equal(await readTaskFileContents(options, fileRef), null);
      await assert.rejects(() => collectFileDiff({
        ...options, sourceView: views.task, fileRef,
        precondition: { expectedViewRevision: views.task.viewRevision, expectedFileRevision: "file-rev.unavailable",
          expectedBaseDigest: null, expectedCurrentDigest: null }
      }), /fileRef is not present/);
      assert.equal(renamedReads, 0, "internal historical paths must block task projection and diff content reads");
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("fails the task view closed when current policy overlaps stored dirty-baseline content", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty secret at task start\n");
    await capture(cwd);
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "changed secret\n");
    const task = (await collectSourceChangeViews({
      cwd,
      identity,
      taskRevision: "task_rev_protected_overlap",
      generatedAt,
      isProtectedPath: (_root, repoPath) => repoPath === "dirty.txt"
    })).task;
    expectValid(task);
    assert.equal(task.availability.state, "unavailable");
    assert.equal(task.availability.reasonCode, "protected-baseline-overlap");
    assert.equal(task.redaction.applied, true);
    assert.deepEqual(task.files, []);
    assert.equal(JSON.stringify(task).includes("dirty secret at task start"), false);
    assert.equal(JSON.stringify(task).includes("changed secret"), false);
  });

  it("renders a task-only patch against dirty baseline bytes, not HEAD", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty before task\nkept\n");
    await capture(cwd);
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty after task\nkept\nadded\n");
    const task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_04", generatedAt })).task;
    const file = task.files.find((entry) => entry.path === "dirty.txt");
    const document = await collectFileDiff({
      cwd,
      identity,
      sourceView: task,
      fileRef: file.fileRef,
      precondition: {
        expectedViewRevision: task.viewRevision,
        expectedFileRevision: file.fileRevision,
        expectedBaseDigest: file.baseDigest,
        expectedCurrentDigest: file.currentDigest
      },
      taskRevision: "task_rev_04",
      generatedAt
    });
    const result = validateFixture(registry, "diff-v1", document);
    assert.equal(result.valid, true, result.errors);
    const lines = document.hunks.flatMap((hunk) => hunk.lines);
    assert.equal(lines.some((line) => line.kind === "deleted" && line.text === "dirty before task"), true);
    assert.equal(lines.some((line) => line.kind === "added" && line.text === "dirty after task"), true);
    assert.equal(lines.some((line) => line.kind === "added" && line.text === "added"), true);
    assert.equal(lines.some((line) => line.text === "clean before dirty"), false, "HEAD-only content must not leak into the task patch");
  });

  it("keeps the recorded task-start HEAD after commits advance the repository", async () => {
    const cwd = repository();
    await capture(cwd);
    fs.writeFileSync(path.join(cwd, "clean.txt"), "committed during task\n");
    git(cwd, "add", "clean.txt");
    git(cwd, "commit", "-qm", "task commit");

    const task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_05", generatedAt })).task;
    expectValid(task);
    const file = task.files.find((entry) => entry.path === "clean.txt");
    assert.ok(file, "a committed task delta must remain visible even when the current working tree is clean");
    assert.equal(file.status, "M");
    const document = await collectFileDiff({
      cwd, identity, sourceView: task, fileRef: file.fileRef,
      precondition: {
        expectedViewRevision: task.viewRevision,
        expectedFileRevision: file.fileRevision,
        expectedBaseDigest: file.baseDigest,
        expectedCurrentDigest: file.currentDigest
      },
      taskRevision: "task_rev_05", generatedAt
    });
    const lines = document.hunks.flatMap((hunk) => hunk.lines);
    assert.equal(lines.some((line) => line.kind === "deleted" && line.text === "clean baseline"), true);
    assert.equal(lines.some((line) => line.kind === "added" && line.text === "committed during task"), true);
  });

  it("isolates corrupt task evidence from the working-tree and staged views", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty at capture\n");
    const manifest = await capture(cwd);
    fs.appendFileSync(path.join(cwd, "clean.txt"), "working change\n");
    const actualManifestPath = taskBaselineManifestPath(cwd, manifest.taskRunId);
    fs.writeFileSync(actualManifestPath, "{corrupt", { mode: 0o600 });

    const views = await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_06", generatedAt });
    expectValid(views.task);
    expectValid(views.workingTree);
    expectValid(views.staged);
    assert.equal(views.task.availability.state, "unavailable");
    assert.equal(views.workingTree.availability.state, "current");
    assert.equal(views.workingTree.files.some((file) => file.path === "clean.txt"), true);
  });

  it("fails an expired task view closed without silently deleting private evidence", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty at capture\n");
    const manifest = await capture(cwd, { retentionMs: 60_000 });
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "changed after capture\n");
    const task = (await collectSourceChangeViews({
      cwd, identity, taskRevision: "task_rev_07", generatedAt: "2026-08-13T13:02:00.000Z"
    })).task;
    expectValid(task);
    assert.equal(task.availability.state, "unavailable");
    assert.equal(task.availability.reasonCode, "task-baseline-retention-expired");
    assert.equal(fs.existsSync(taskBaselineManifestPath(cwd, manifest.taskRunId)), true, "expiry must never trigger silent deletion");
  });
});
