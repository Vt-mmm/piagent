import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { gitEvidenceRootDetails, workingTreeHasChanges } from "../packages/piagent-core/extensions/workspace-evidence-roots.js";
import { workingTreeSnapshotOffThread } from "../packages/piagent-core/runtime/inspection/working-tree-off-thread.ts";

const cleanup = new Set();
afterEach(() => {
  for (const item of cleanup) fs.rmSync(item, { recursive: true, force: true });
  cleanup.clear();
});

function folder() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-tree-")));
  cleanup.add(root);
  return root;
}

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "init");
  return dir;
}

const dirtyBySnapshot = (cwd) => Object.keys(workingTreeSnapshot(cwd)).length > 0;

describe("working tree checks that run on every prompt", () => {
  it("answers whether the tree changed as the full snapshot does, without hashing it", () => {
    const cwd = repo(folder());
    assert.equal(workingTreeHasChanges(cwd), false);
    assert.equal(workingTreeHasChanges(cwd), dirtyBySnapshot(cwd));

    fs.mkdirSync(path.join(cwd, ".pi", "piagent-state"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "piagent-state", "x.json"), "{}");
    assert.equal(workingTreeHasChanges(cwd), dirtyBySnapshot(cwd), "Piagent's own state is not a change");

    fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
    assert.equal(workingTreeHasChanges(cwd), true);
    assert.equal(dirtyBySnapshot(cwd), true);
  });

  it("covers a parent folder of repositories and its loose files", () => {
    const parent = folder();
    repo(path.join(parent, "one"));
    repo(path.join(parent, "two"));
    const details = gitEvidenceRootDetails(parent);
    assert.deepEqual(details.roots.map((root) => root.prefix), ["one", "two"]);
    assert.equal(details.complete, true);
    assert.equal(workingTreeHasChanges(parent), false);

    fs.writeFileSync(path.join(parent, "two", "new.txt"), "x");
    assert.equal(workingTreeHasChanges(parent), true);
    fs.rmSync(path.join(parent, "two", "new.txt"));

    fs.writeFileSync(path.join(parent, "plan.md"), "loose");
    assert.equal(workingTreeHasChanges(parent), true);
    assert.equal(dirtyBySnapshot(parent), true);
  });

  it("produces the same snapshot off the main thread", async () => {
    const cwd = repo(folder());
    fs.writeFileSync(path.join(cwd, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(cwd, ".env"), "TOKEN=1");
    const protectedPaths = [".env"];
    const expected = workingTreeSnapshot(cwd, { gitTimeoutMs: 8_000, isProtectedProjectPath: (file) => file === ".env" });
    const [first, overlapping] = await Promise.all([
      workingTreeSnapshotOffThread(cwd, { gitTimeoutMs: 8_000, protectedPaths }),
      workingTreeSnapshotOffThread(cwd, { gitTimeoutMs: 8_000, protectedPaths })
    ]);
    assert.deepEqual(first, expected);
    assert.equal(overlapping, first, "overlapping refreshes share one scan");
  });
});
