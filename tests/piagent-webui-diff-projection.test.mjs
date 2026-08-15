import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { collectFileDiff } from "../packages/piagent-core/runtime/inspection/diff-projection.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = {
  projectRef: "project_01",
  runtimeInstanceId: "runtime_01",
  sessionRef: "session_01",
  taskId: null,
  taskRunId: null,
  agentOperationId: null,
  toolCallId: null
};
const generatedAt = "2026-08-13T11:00:00.000Z";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-diff-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "example.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

function precondition(source, file) {
  return {
    expectedViewRevision: source.viewRevision,
    expectedFileRevision: file.fileRevision,
    expectedBaseDigest: file.baseDigest,
    expectedCurrentDigest: file.currentDigest
  };
}

function expectValid(document) {
  const result = validateFixture(registry, "diff-v1", document);
  assert.equal(result.valid, true, result.errors);
}

async function diffFor(cwd, source, file, overrides = {}) {
  return await collectFileDiff({
    cwd,
    identity,
    sourceView: source,
    fileRef: file.fileRef,
    precondition: precondition(source, file),
    generatedAt,
    ...overrides
  });
}

describe("Piagent WebUI bounded diff projection", () => {
  it("renders typed hunks, line numbers, and collapsed unchanged regions", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "example.txt"), "ONE\ntwo\nthree\nfour\nfive\nSIX\n");
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "example.txt");
    const document = await diffFor(cwd, source, file, { contextLines: 0 });
    expectValid(document);
    assert.equal(document.availability.state, "current");
    assert.equal(document.fallback.kind, "none");
    assert.equal(document.hunks.length, 2);
    assert.equal(document.hunks[0].lines[0].kind, "deleted");
    assert.equal(document.hunks[0].lines[0].oldLineNumber, 1);
    assert.equal(document.hunks[0].lines[0].newLineNumber, null);
    assert.equal(document.hunks[0].lines[1].kind, "added");
    assert.equal(document.hunks[0].lines[1].oldLineNumber, null);
    assert.equal(document.hunks[0].lines[1].newLineNumber, 1);
    assert.equal(document.unchangedRegions.some((region) => region.lineCount === 4), true);
  });

  it("keeps staged and working-tree patches independent for mixed content", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "example.txt"), "INDEX\ntwo\nthree\nfour\nfive\nsix\n");
    git(cwd, "add", "example.txt");
    fs.writeFileSync(path.join(cwd, "example.txt"), "WORKTREE\ntwo\nthree\nfour\nfive\nsix\n");
    const views = await collectSourceChangeViews({ cwd, identity, generatedAt });
    const workingFile = views.workingTree.files.find((entry) => entry.path === "example.txt");
    const stagedFile = views.staged.files.find((entry) => entry.path === "example.txt");
    const working = await diffFor(cwd, views.workingTree, workingFile);
    const staged = await diffFor(cwd, views.staged, stagedFile);
    expectValid(working);
    expectValid(staged);
    assert.equal(working.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text === "WORKTREE"), true);
    assert.equal(staged.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text === "INDEX"), true);
    assert.equal(staged.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text === "WORKTREE"), false);
  });

  it("returns stale-retry without hunks when file bytes change after the source snapshot", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "example.txt"), "first\n");
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "example.txt");
    fs.writeFileSync(path.join(cwd, "example.txt"), "second\n");
    const document = await diffFor(cwd, source, file);
    expectValid(document);
    assert.equal(document.availability.state, "stale");
    assert.equal(document.availability.reasonCode, "stale-retry");
    assert.equal(document.availability.retryable, true);
    assert.equal(document.fallback.kind, "stale");
    assert.deepEqual(document.hunks, []);
  });

  it("uses typed fallbacks for binary, symlink, protected, and oversized content", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    fs.symlinkSync("example.txt", path.join(cwd, "link.txt"));
    fs.writeFileSync(path.join(cwd, "protected.txt"), "secret\n");
    fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(8_192));
    const projectionOptions = {
      cwd,
      identity,
      generatedAt,
      isProtectedPath: (_root, repoPath) => repoPath === "protected.txt"
    };
    const source = (await collectSourceChangeViews(projectionOptions)).workingTree;
    for (const [name, fallback, state] of [
      ["binary.bin", "binary", "current"],
      ["link.txt", "symlink", "current"],
      ["protected.txt", "protected", "unavailable"]
    ]) {
      const file = source.files.find((entry) => entry.path === name);
      const document = await diffFor(cwd, source, file, { isProtectedPath: projectionOptions.isProtectedPath });
      expectValid(document);
      assert.equal(document.fallback.kind, fallback);
      assert.equal(document.availability.state, state);
      assert.deepEqual(document.hunks, []);
    }
    const large = source.files.find((entry) => entry.path === "large.txt");
    const oversized = await diffFor(cwd, source, large, { maxBytes: 1_024, isProtectedPath: projectionOptions.isProtectedPath });
    expectValid(oversized);
    assert.equal(oversized.fallback.kind, "oversized");
    assert.equal(oversized.availability.state, "unavailable");
  });

  it("truncates bounded line output and reports redaction explicitly", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "many.txt"), "one\ntwo\nthree\nfour\n");
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "many.txt");
    const document = await diffFor(cwd, source, file, {
      maxLines: 2,
      redactLine: (text) => text === "two" ? { text: "[redacted]", redacted: true } : { text, redacted: false }
    });
    expectValid(document);
    assert.equal(document.truncation.truncated, true);
    assert.equal(document.truncation.omittedLines > 0, true);
    assert.equal(document.redaction.applied, true);
    assert.equal(document.redaction.valuesRemoved, 1);
    assert.equal(document.hunks[0].lines.some((line) => line.text === "[redacted]"), true);
  });

  it("does not execute repository-configured external diff or textconv programs", async () => {
    const cwd = repository();
    const marker = path.join(cwd, "external-diff-ran");
    const helper = path.join(cwd, "external-diff.sh");
    fs.writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
    fs.chmodSync(helper, 0o755);
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt diff=owned\n");
    git(cwd, "add", ".gitattributes");
    git(cwd, "commit", "-qm", "add attributes");
    git(cwd, "config", "diff.owned.command", helper);
    git(cwd, "config", "diff.owned.textconv", helper);
    fs.writeFileSync(path.join(cwd, "example.txt"), "changed\n");

    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "example.txt");
    const document = await diffFor(cwd, source, file);
    expectValid(document);
    assert.equal(document.fallback.kind, "none");
    assert.equal(fs.existsSync(marker), false);
  });

  it("renders a rename with edits and protects the old path when policy requires it", async () => {
    const cwd = repository();
    git(cwd, "mv", "example.txt", "renamed.txt");
    fs.appendFileSync(path.join(cwd, "renamed.txt"), "seven\n");
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "renamed.txt");
    assert.equal(file.status, "R");
    assert.equal(file.oldPath, "example.txt");
    const document = await diffFor(cwd, source, file);
    expectValid(document);
    assert.equal(document.fallback.kind, "none");
    assert.equal(document.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text === "seven"), true);

    const isProtectedPath = (_root, repoPath) => repoPath === "example.txt";
    const protectedSource = (await collectSourceChangeViews({ cwd, identity, generatedAt, isProtectedPath })).workingTree;
    const protectedFile = protectedSource.files.find((entry) => entry.path === "renamed.txt");
    assert.equal(protectedFile.content.access, "protected");
    const protectedDiff = await diffFor(cwd, protectedSource, protectedFile, { isProtectedPath });
    expectValid(protectedDiff);
    assert.equal(protectedDiff.fallback.kind, "protected");
    assert.deepEqual(protectedDiff.hunks, []);
  });

  it("represents an empty untracked file without inventing an added line", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "empty.txt"), "");
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "empty.txt");
    const document = await diffFor(cwd, source, file);
    expectValid(document);
    assert.equal(document.fallback.kind, "none");
    assert.deepEqual(document.hunks, []);
    assert.deepEqual(file.stats, { state: "exact", additions: 0, deletions: 0, reasonCode: null });
  });
});
