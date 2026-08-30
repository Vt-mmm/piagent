import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureExecutionSnapshot, runSnapshotBoundContract } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const authorizeSourceRead = () => true;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

function fixture(context, commit = true) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-execution-snapshot-"));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  git(projectRoot, "init", "-q");
  git(projectRoot, "config", "user.name", "Piagent Test");
  git(projectRoot, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(projectRoot, "source.mjs"), "export const run = (a, b) => a + b;\n");
  if (commit) { git(projectRoot, "add", "source.mjs"); git(projectRoot, "commit", "-qm", "snapshot fixture"); }
  return { projectRoot, sourcePath: "source.mjs", authorizeSourceRead };
}

test("snapshots bind source bytes and HEAD beyond the legacy dirty-tree digest", (context) => {
  const request = fixture(context);
  const before = captureExecutionSnapshot(request);
  assert.equal(before.source, "export const run = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(request.projectRoot, "source.mjs"), "export const run = (a, b) => a - b;\n");
  git(request.projectRoot, "add", "source.mjs"); git(request.projectRoot, "commit", "-qm", "changed clean baseline");
  const after = captureExecutionSnapshot(request);
  assert.equal(before.binding.workingTreeDigest, after.binding.workingTreeDigest);
  assert.notEqual(before.binding.head, after.binding.head);
  assert.notEqual(before.binding.sourceDigest, after.binding.sourceDigest);
  assert.notEqual(before.snapshotDigest, after.snapshotDigest);
  assert.equal(captureExecutionSnapshot(request).snapshotDigest, after.snapshotDigest);
});

test("snapshot admission rejects unapproved reads, escapes, symlinks, directories, and invalid bytes", (context) => {
  const request = fixture(context);
  for (const sourcePath of ["../source.mjs", "/etc/passwd", ".git/config", "./source.mjs", "a/../source.mjs", "a\\b", ".pi/auth.json"]) {
    assert.throws(() => captureExecutionSnapshot({ ...request, sourcePath }));
  }
  assert.throws(() => captureExecutionSnapshot({ ...request, authorizeSourceRead: undefined }));
  assert.throws(() => captureExecutionSnapshot({ ...request, authorizeSourceRead: () => false }), /not authorized/);
  fs.symlinkSync("source.mjs", path.join(request.projectRoot, "linked.mjs"));
  assert.throws(() => captureExecutionSnapshot({ ...request, sourcePath: "linked.mjs" }), /symbolic link/);
  fs.linkSync(path.join(request.projectRoot, "source.mjs"), path.join(request.projectRoot, "hardlinked.mjs"));
  assert.throws(() => captureExecutionSnapshot({ ...request, sourcePath: "hardlinked.mjs" }), /linked/);
  fs.unlinkSync(path.join(request.projectRoot, "hardlinked.mjs"));
  fs.mkdirSync(path.join(request.projectRoot, "directory"));
  assert.throws(() => captureExecutionSnapshot({ ...request, sourcePath: "directory" }), /regular file/);
  fs.writeFileSync(path.join(request.projectRoot, "source.mjs"), Buffer.from([0xff, 0xfe]));
  assert.throws(() => captureExecutionSnapshot(request));
});

test("workspace digest collection also respects read authorization", (context) => {
  const request = fixture(context);
  fs.writeFileSync(path.join(request.projectRoot, "private.txt"), "not-authorized-for-verification");
  const requested = [];
  assert.throws(() => captureExecutionSnapshot({ ...request, authorizeSourceRead: ({ sourcePath }) => {
    requested.push(sourcePath);
    return sourcePath === request.sourcePath;
  } }), /snapshot is incomplete/);
  assert.ok(requested.includes("private.txt"));
});

test("unborn repositories and ignored target bytes still have explicit identities", (context) => {
  const request = fixture(context, false);
  assert.match(captureExecutionSnapshot(request).binding.head, /^unborn:refs\/heads\//);
  fs.writeFileSync(path.join(request.projectRoot, ".gitignore"), "source.mjs\n");
  git(request.projectRoot, "add", ".gitignore"); git(request.projectRoot, "commit", "-qm", "ignored source");
  const before = captureExecutionSnapshot(request);
  fs.writeFileSync(path.join(request.projectRoot, "source.mjs"), "export const run = () => 0;\n");
  const after = captureExecutionSnapshot(request);
  assert.equal(before.binding.workingTreeDigest, after.binding.workingTreeDigest);
  assert.notEqual(before.snapshotDigest, after.snapshotDigest);
});

test("real contract execution uses captured bytes and rejects post-run source or revision drift", integration, async (context) => {
  const request = fixture(context);
  const options = { ...request, imageId, dockerSocket, exportName: "run", checks: [{ id: "sum", cases: [{ id: "one",
    args: [{ type: "number", value: 2 }, { type: "number", value: 3 }], expected: { outcome: "return", value: { type: "number", value: 5 } } }] }] };
  const good = await runSnapshotBoundContract(options);
  assert.equal(good.verdict, "pass", JSON.stringify(good));
  assert.equal(good.binding.sourceDigest, good.result.execution.sourceDigest);
  let reads = 0;
  const changed = await runSnapshotBoundContract({ ...options, authorizeSourceRead: () => {
    if (++reads === 2) {
      fs.writeFileSync(path.join(request.projectRoot, "source.mjs"), "export const run = () => 99;\n");
      git(request.projectRoot, "add", "source.mjs"); git(request.projectRoot, "commit", "-qm", "concurrent source revision");
    }
    return true;
  } });
  assert.equal(changed.result.verdict, "pass");
  assert.equal(changed.verdict, "unknown");
  assert.equal(changed.reason, "execution-snapshot-drift");
});
