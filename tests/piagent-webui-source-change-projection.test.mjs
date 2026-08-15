import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { collectGitStatus } from "../packages/piagent-core/runtime/inspection/git-status-adapter.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { sourceInspectionPlan } from "../packages/piagent-core/runtime/inspection/source-inspection-plan.ts";
import { collectWorkspaceSourceChangeViews } from "../packages/piagent-core/runtime/inspection/workspace-source-projection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = {
  projectRef: "project_01",
  runtimeInstanceId: "runtime_01",
  sessionRef: "session_01",
  taskId: "task_01",
  taskRunId: "task_run_01",
  agentOperationId: null,
  toolCallId: null
};

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-source-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "modified.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(cwd, "deleted.txt"), "delete\n");
  fs.writeFileSync(path.join(cwd, "rename.txt"), "rename\n");
  fs.writeFileSync(path.join(cwd, "mixed.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

function expectValid(document) {
  const result = validateFixture(registry, "source-change-v1", document);
  assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI source change projections", () => {
  it("builds independent schema-valid working-tree and staged views", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "modified.txt"), "one\nchanged\nthree\n");
    fs.rmSync(path.join(cwd, "deleted.txt"));
    git(cwd, "mv", "rename.txt", "renamed file.txt");
    fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n");
    fs.writeFileSync(path.join(cwd, "mixed.txt"), "index\n");
    git(cwd, "add", "staged.txt", "mixed.txt");
    fs.writeFileSync(path.join(cwd, "mixed.txt"), "worktree\nextra\n");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(cwd, "xin chào.txt"), "unicode\n");
    fs.writeFileSync(path.join(cwd, "line\nbreak.txt"), "newline\n");
    fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    fs.symlinkSync("modified.txt", path.join(cwd, "link.txt"));

    const views = await collectSourceChangeViews({
      cwd,
      identity,
      taskRevision: "task_rev_01",
      generatedAt: "2026-08-13T10:00:00.000Z"
    });
    expectValid(views.workingTree);
    expectValid(views.staged);
    expectValid(views.task);
    assert.notEqual(views.workingTree.viewRevision, views.staged.viewRevision);

    const working = new Map(views.workingTree.files.map((file) => [file.path, file]));
    const staged = new Map(views.staged.files.map((file) => [file.path, file]));
    assert.equal(working.get("modified.txt").status, "M");
    assert.match(working.get("modified.txt").baseDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(working.get("modified.txt").currentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(working.get("modified.txt").baseDigest, working.get("modified.txt").currentDigest);
    assert.equal(working.get("deleted.txt").status, "D");
    assert.match(working.get("deleted.txt").baseDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(working.get("deleted.txt").currentDigest, null);
    assert.equal(working.get("renamed file.txt").status, "R");
    assert.equal(working.get("renamed file.txt").oldPath, "rename.txt");
    assert.equal(working.get("untracked.txt").status, "U");
    assert.deepEqual(working.get("untracked.txt").stats, { state: "exact", additions: 2, deletions: 0, reasonCode: null });
    assert.equal(working.get("binary.bin").content.kind, "binary");
    assert.equal(working.get("binary.bin").stats.state, "unavailable");
    assert.equal(working.get("link.txt").content.kind, "symlink");
    assert.equal(working.get("link.txt").stats.state, "unavailable");
    assert.equal(working.get("xin chào.txt").pathDisplay, "exact-safe");
    assert.equal(working.get("line%0Abreak.txt").pathDisplay, "escaped");

    assert.deepEqual([...staged.keys()].sort(), ["mixed.txt", "renamed file.txt", "staged.txt"]);
    assert.equal(staged.get("staged.txt").status, "A");
    assert.equal(staged.get("staged.txt").baseDigest, null);
    assert.match(staged.get("staged.txt").currentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(staged.get("mixed.txt").baseDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(staged.get("mixed.txt").currentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(staged.has("modified.txt"), false);
    assert.equal(staged.has("untracked.txt"), false);
    assert.equal(views.task.availability.state, "unavailable");
    assert.equal(views.task.files.length, 0);
  });

  it("projects conflicts as C and keeps errors out of the Git status column", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "conflict.txt"), "base\n");
    git(cwd, "add", "conflict.txt");
    git(cwd, "commit", "-qm", "conflict base");
    const mainBranch = git(cwd, "branch", "--show-current").trim();
    git(cwd, "checkout", "-qb", "side");
    fs.writeFileSync(path.join(cwd, "conflict.txt"), "side\n");
    git(cwd, "commit", "-qam", "side");
    git(cwd, "checkout", "-q", mainBranch);
    fs.writeFileSync(path.join(cwd, "conflict.txt"), "main\n");
    git(cwd, "commit", "-qam", "main");
    assert.throws(() => git(cwd, "merge", "side"));

    const views = await collectSourceChangeViews({ cwd, identity, generatedAt: "2026-08-13T10:01:00.000Z" });
    expectValid(views.workingTree);
    expectValid(views.staged);
    const workingConflict = views.workingTree.files.find((file) => file.path === "conflict.txt");
    const stagedConflict = views.staged.files.find((file) => file.path === "conflict.txt");
    assert.equal(workingConflict.status, "C");
    assert.equal(stagedConflict.status, "C");
    assert.equal(workingConflict.git.conflict, true);
    assert.equal(workingConflict.stats.state, "unavailable");
    assert.equal(views.workingTree.files.some((file) => file.status === "E"), false);
  });

  it("keeps protected content out of digests and line statistics", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "modified.txt"), "secret\n");
    const views = await collectSourceChangeViews({
      cwd,
      identity,
      generatedAt: "2026-08-13T10:02:00.000Z",
      isProtectedPath: (_root, repoPath) => repoPath === "modified.txt"
    });
    expectValid(views.workingTree);
    const file = views.workingTree.files.find((entry) => entry.path === "modified.txt");
    assert.deepEqual(file.content, { kind: "unknown", access: "protected", reasonCode: "protected-path" });
    assert.equal(file.currentDigest, null);
    assert.equal(file.stats.state, "unavailable");
    assert.equal(file.health.state, "degraded");
  });

  it("excludes protected tracked and staged paths from Git content inspection", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "modified.txt"), "protected index\n");
    git(cwd, "add", "modified.txt");
    fs.writeFileSync(path.join(cwd, "modified.txt"), "protected worktree\n");
    fs.writeFileSync(path.join(cwd, "mixed.txt"), "safe worktree\n");
    const snapshot = await collectGitStatus(cwd);
    const protectedRecord = snapshot.records.find((record) => record.path.value === "modified.txt");
    const safeRecord = snapshot.records.find((record) => record.path.value === "mixed.txt");
    assert.ok(protectedRecord);
    assert.ok(safeRecord);
    const plan = sourceInspectionPlan(snapshot, (_root, repoPath) => repoPath === "modified.txt");
    assert.equal(plan.workingTreePaths.includes("modified.txt"), false);
    assert.equal(plan.stagedPaths.includes("modified.txt"), false);
    assert.equal(plan.workingTreePaths.includes("mixed.txt"), true);
    for (const objectId of [protectedRecord.headObject, protectedRecord.indexObject].filter(Boolean)) {
      assert.equal(plan.objectIds.includes(objectId), false);
    }
    assert.equal(plan.objectIds.includes(safeRecord.headObject), true);
  });

  it("excludes both rename sides when the historical path is internal state", async () => {
    const cwd = repository();
    fs.mkdirSync(path.join(cwd, ".pi", "piagent-state"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "piagent-state", "private.txt"), "internal\n");
    git(cwd, "add", "-f", ".pi/piagent-state/private.txt");
    git(cwd, "commit", "-qm", "tracked internal fixture");
    git(cwd, "mv", ".pi/piagent-state/private.txt", "public-name.txt");
    const snapshot = await collectGitStatus(cwd);
    const record = snapshot.records.find((entry) => entry.path.value === "public-name.txt");
    assert.ok(record);
    assert.equal(record.oldPath.value, ".pi/piagent-state/private.txt");
    const plan = sourceInspectionPlan(snapshot);
    assert.equal(plan.workingTreePaths.includes("public-name.txt"), false);
    assert.equal(plan.stagedPaths.includes("public-name.txt"), false);
    for (const objectId of [record.headObject, record.indexObject].filter(Boolean)) {
      assert.equal(plan.objectIds.includes(objectId), false);
    }
  });

  it("does not invalidate canonical source revisions when owner-only Pi state changes", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "modified.txt"), "visible change\n");
    const before = await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_01" });
    fs.mkdirSync(path.join(cwd, ".pi", "piagent-state", "source-evidence"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "piagent-state", "source-evidence", "review.json"), "owner-only evidence\n");
    const after = await collectSourceChangeViews({ cwd, identity, taskRevision: "task_rev_01" });
    assert.equal(after.workingTree.viewRevision, before.workingTree.viewRevision);
    assert.equal(after.staged.viewRevision, before.staged.viewRevision);
    assert.deepEqual(after.workingTree.files.map((file) => file.fileRevision), before.workingTree.files.map((file) => file.fileRevision));
  });

  it("supports unborn repositories and paginates without conflating views", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-unborn-"));
    execFileSync("git", ["init", "-q", cwd]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
    git(cwd, "add", "a.txt");
    const views = await collectSourceChangeViews({ cwd, identity, pageLimit: 1, generatedAt: "2026-08-13T10:03:00.000Z" });
    expectValid(views.workingTree);
    expectValid(views.staged);
    assert.equal(views.workingTree.bases[0].headState, "unborn");
    assert.equal(views.staged.bases[0].headState, "unborn");
    assert.equal(views.workingTree.page.truncated, true);
    assert.equal(views.workingTree.page.returned, 1);
    assert.equal(views.staged.files.length, 1);
    assert.equal(views.staged.files[0].path, "a.txt");
  });

  it("returns schema-valid unavailable views outside Git instead of throwing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-no-git-view-"));
    const views = await collectSourceChangeViews({ cwd, identity, generatedAt: "2026-08-13T10:04:00.000Z" });
    expectValid(views.workingTree);
    expectValid(views.staged);
    expectValid(views.task);
    assert.equal(views.workingTree.availability.state, "unavailable");
    assert.equal(views.workingTree.availability.reasonCode, "not-git");
    assert.equal(views.workingTree.availability.message.includes(cwd), false);
    assert.equal(views.workingTree.files.length, 0);
    assert.equal(views.staged.files.length, 0);
  });

  it("selects the exact nested repository and supports detached HEAD", async () => {
    const outer = repository();
    const nested = path.join(outer, "nested-repo");
    fs.mkdirSync(nested);
    execFileSync("git", ["init", "-q", nested]);
    git(nested, "config", "user.email", "test@example.com");
    git(nested, "config", "user.name", "Piagent Test");
    fs.writeFileSync(path.join(nested, "nested.txt"), "base\n");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "nested baseline");
    git(nested, "checkout", "--detach", "-q", "HEAD");
    fs.writeFileSync(path.join(nested, "nested.txt"), "changed\n");
    fs.writeFileSync(path.join(outer, "outer-only.txt"), "outer\n");

    const views = await collectSourceChangeViews({ cwd: nested, identity, generatedAt: "2026-08-13T10:05:00.000Z" });
    expectValid(views.workingTree);
    assert.equal(views.workingTree.bases[0].headState, "head");
    assert.deepEqual(views.workingTree.files.map((file) => file.path), ["nested.txt"]);
    assert.equal(views.workingTree.files.some((file) => file.path === "outer-only.txt"), false);
  });

  it("represents a changed submodule as a typed non-text source", async () => {
    const parent = repository();
    const origin = repository();
    const modulePath = path.join(parent, "modules", "child");
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "modules/child");
    git(parent, "commit", "-qam", "add submodule");
    fs.writeFileSync(path.join(modulePath, "modified.txt"), "submodule changed\n");
    git(modulePath, "config", "user.email", "test@example.com");
    git(modulePath, "config", "user.name", "Piagent Test");
    git(modulePath, "commit", "-qam", "advance submodule");

    const views = await collectSourceChangeViews({ cwd: parent, identity, generatedAt: "2026-08-13T10:06:00.000Z" });
    expectValid(views.workingTree);
    const module = views.workingTree.files.find((file) => file.path === "modules/child");
    assert.equal(module.status, "M");
    assert.equal(module.content.kind, "submodule");
    assert.equal(module.stats.state, "unavailable");
  });

  it("combines independent bases for a multi-repository workspace and fails closed on a partial root", async () => {
    const first = repository();
    const second = repository();
    fs.writeFileSync(path.join(first, "modified.txt"), "first\n");
    fs.writeFileSync(path.join(second, "modified.txt"), "second\n");
    fs.writeFileSync(path.join(first, "staged-only.txt"), "staged\n");
    git(first, "add", "staged-only.txt");
    const views = await collectWorkspaceSourceChangeViews({
      roots: [first, second],
      identity,
      generatedAt: "2026-08-13T10:07:00.000Z"
    });
    expectValid(views.workingTree);
    expectValid(views.staged);
    assert.equal(views.workingTree.bases.length, 2);
    assert.equal(new Set(views.workingTree.files.map((file) => file.repoRef)).size, 2);
    assert.equal(views.workingTree.files.filter((file) => file.path === "modified.txt").length, 2);
    assert.equal(views.staged.files.length, 1);

    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-partial-root-"));
    const partial = await collectWorkspaceSourceChangeViews({
      roots: [first, missing],
      identity,
      generatedAt: "2026-08-13T10:08:00.000Z"
    });
    expectValid(partial.workingTree);
    assert.equal(partial.workingTree.availability.state, "unavailable");
    assert.deepEqual(partial.workingTree.files, []);
  });
});
