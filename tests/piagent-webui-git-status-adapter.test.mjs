import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  GitInspectionError,
  collectGitStatus,
  parsePorcelainV2,
  runReadOnlyGit
} from "../packages/piagent-core/runtime/inspection/git-status-adapter.ts";
import {
  listGitChangesAgainstTree,
  listGitPathsAgainstTree,
  readGitTreeEntry
} from "../packages/piagent-core/runtime/inspection/git-tree-adapter.ts";

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-git-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "baseline\n");
  fs.writeFileSync(path.join(cwd, "delete.txt"), "delete\n");
  fs.writeFileSync(path.join(cwd, "rename.txt"), "rename\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  return cwd;
}

describe("Piagent WebUI porcelain-v2 adapter", () => {
  it("preserves status axes and safe display paths for spaces, Unicode, and newlines", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "changed\n");
    fs.rmSync(path.join(cwd, "delete.txt"));
    execFileSync("git", ["-C", cwd, "mv", "rename.txt", "renamed file.txt"]);
    fs.writeFileSync(path.join(cwd, "xin chào.txt"), "unicode\n");
    fs.writeFileSync(path.join(cwd, "line\nbreak.txt"), "newline\n");

    const snapshot = await collectGitStatus(cwd);
    assert.equal(snapshot.headState, "head");
    assert.match(snapshot.headOid, /^[a-f0-9]{40,64}$/);
    assert.equal(snapshot.repoRoot, fs.realpathSync.native(cwd));

    const byValue = new Map(snapshot.records.map((record) => [record.path.value, record]));
    assert.equal(byValue.get("tracked.txt").worktreeStatus, "M");
    assert.equal(byValue.get("delete.txt").worktreeStatus, "D");
    assert.equal(byValue.get("renamed file.txt").kind, "renamed");
    assert.equal(byValue.get("renamed file.txt").oldPath.value, "rename.txt");
    assert.equal(byValue.get("xin chào.txt").path.displayMode, "exact-safe");
    assert.equal(byValue.get("line\nbreak.txt").path.display, "line%0Abreak.txt");
    assert.equal(byValue.get("line\nbreak.txt").path.displayMode, "escaped");
  });

  it("parses unmerged records as two raw Git axes without inventing E status", () => {
    const cwd = repository();
    const oid = "0".repeat(40);
    const raw = Buffer.from(`# branch.oid (initial)\0u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt\0`);
    const snapshot = parsePorcelainV2(raw, cwd);
    assert.equal(snapshot.headState, "unborn");
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].kind, "unmerged");
    assert.equal(snapshot.records[0].indexStatus, "U");
    assert.equal(snapshot.records[0].worktreeStatus, "U");
  });

  it("fails closed outside Git and when bounded output is exceeded", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-no-git-"));
    await assert.rejects(collectGitStatus(outside), (error) => error instanceof GitInspectionError && error.code === "not-git");

    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(8_192));
    execFileSync("git", ["-C", cwd, "add", "large.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "large"]);
    await assert.rejects(
      runReadOnlyGit(cwd, ["show", "HEAD:large.txt"], { maxBytes: 1_024 }),
      (error) => error instanceof GitInspectionError && error.code === "output-limit"
    );
  });

  it("disables repository-configured fsmonitor hooks during collection", async () => {
    const cwd = repository();
    const marker = path.join(cwd, "fsmonitor-ran");
    const hook = path.join(cwd, "fsmonitor-hook.sh");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '{}\\n'\n`);
    fs.chmodSync(hook, 0o755);
    execFileSync("git", ["-C", cwd, "config", "core.fsmonitor", hook]);

    await collectGitStatus(cwd);
    assert.equal(fs.existsSync(marker), false);
  });

  it("rejects mutating subcommands and leaves the Git index untouched", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n");
    const index = path.join(cwd, ".git", "index");
    const before = fs.statSync(index);
    await assert.rejects(
      runReadOnlyGit(cwd, ["add", "--", "untracked.txt"]),
      (error) => error instanceof GitInspectionError && error.code === "invalid-output"
    );
    for (const args of [
      ["diff", "--no-index", "--", "untracked.txt", "/etc/passwd"],
      ["show", "--textconv", "HEAD:tracked.txt"],
      ["hash-object", "-w", "untracked.txt"]
    ]) {
      await assert.rejects(
        runReadOnlyGit(cwd, args),
        (error) => error instanceof GitInspectionError && error.code === "invalid-output"
      );
    }
    await collectGitStatus(cwd);
    const after = fs.statSync(index);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(gitStatus(cwd).includes("untracked.txt"), true);
  });

  it("reads exact recorded-tree entries and lists changes against that immutable tree", async () => {
    const cwd = repository();
    const baseline = await collectGitStatus(cwd);
    const entry = await readGitTreeEntry(cwd, baseline.headOid, "tracked.txt");
    assert.equal(entry.mode, "100644");
    assert.equal(entry.type, "blob");
    assert.match(entry.objectId, /^[a-f0-9]{40,64}$/);
    assert.equal(await readGitTreeEntry(cwd, baseline.headOid, "missing.txt"), null);

    fs.writeFileSync(path.join(cwd, "tracked.txt"), "committed later\n");
    execFileSync("git", ["-C", cwd, "mv", "rename.txt", "renamed.txt"]);
    execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "later"]);
    assert.deepEqual((await listGitPathsAgainstTree(cwd, baseline.headOid)).sort(), ["rename.txt", "renamed.txt", "tracked.txt"]);
    assert.deepEqual(await listGitChangesAgainstTree(cwd, baseline.headOid), [
      { status: "R", path: "renamed.txt", oldPath: "rename.txt" },
      { status: "M", path: "tracked.txt", oldPath: null }
    ]);
    assert.equal((await readGitTreeEntry(cwd, baseline.headOid, "tracked.txt")).objectId, entry.objectId,
      "tree reads must remain bound to the task-start commit");

    await assert.rejects(
      runReadOnlyGit(cwd, ["ls-tree", "-z", "HEAD", "--", "tracked.txt"]),
      (error) => error instanceof GitInspectionError && error.code === "invalid-output"
    );
  });
});

function gitStatus(cwd) {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
}
