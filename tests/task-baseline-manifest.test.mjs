import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  taskBaselineManifestDigest,
  validateTaskBaselineManifest
} from "../packages/piagent-core/runtime/inspection/source-evidence-contract.ts";
import {
  captureTaskBaselineManifest,
  decodeBaselineRepoPath,
  readTaskBaselineBlob,
  readTaskBaselineManifest,
  taskBaselineManifestPath
} from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-baseline-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "clean\n");
  fs.writeFileSync(path.join(cwd, "deleted.txt"), "deleted baseline\n");
  fs.writeFileSync(path.join(cwd, "clean.txt"), "clean tracked\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

async function capture(cwd, overrides = {}) {
  return await captureTaskBaselineManifest({
    projectRoot: cwd,
    taskId: "task-01",
    taskRunId: "task-01-run-01",
    sessionId: "private-session-value",
    capturedAt: "2026-08-13T12:00:00.000Z",
    baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)),
    ...overrides
  });
}

describe("Task Baseline Manifest", () => {
  it("captures only dirty carriers and keeps clean tracked bytes in Git", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty before task\n");
    fs.rmSync(path.join(cwd, "deleted.txt"));
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked before task\n");
    fs.symlinkSync("dirty.txt", path.join(cwd, "link.txt"));
    const gitObjectCountBefore = git(cwd, "count-objects", "-v");

    const manifest = await capture(cwd);
    assert.equal(manifest.captureState, "current");
    assert.equal(manifest.integrityDigest, taskBaselineManifestDigest(manifest));
    assert.equal(manifest.sessionIdentityHash.includes("private-session-value"), false);
    assert.equal(manifest.roots.length, 1);
    const entries = new Map(manifest.roots[0].entries.map((entry) => [decodeBaselineRepoPath(entry), entry]));
    assert.deepEqual([...entries.keys()].sort(), ["deleted.txt", "dirty.txt", "link.txt", "untracked.txt"]);
    assert.equal(entries.has("clean.txt"), false);
    assert.equal(entries.get("deleted.txt").state, "absent");
    assert.equal(entries.get("link.txt").state, "symlink");
    assert.equal(readTaskBaselineBlob(cwd, manifest.taskRunId, entries.get("dirty.txt").contentRef).toString("utf8"), "dirty before task\n");
    assert.equal(readTaskBaselineBlob(cwd, manifest.taskRunId, entries.get("link.txt").contentRef).toString("utf8"), "dirty.txt");
    assert.equal(git(cwd, "count-objects", "-v"), gitObjectCountBefore, "baseline capture must not write the Git object store");

    const rootStat = fs.statSync(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)));
    const manifestStat = fs.statSync(taskBaselineManifestPath(cwd, manifest.taskRunId));
    assert.equal(rootStat.mode & 0o777, 0o700);
    assert.equal(manifestStat.mode & 0o777, 0o600);
    assert.equal(readTaskBaselineManifest(cwd, manifest.taskRunId).integrityDigest, manifest.integrityDigest);
  });

  it("records protected and oversized evidence without persisting raw bytes", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "protected.txt"), "secret baseline\n");
    fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(4096));
    const manifest = await capture(cwd, {
      maxFileBytes: 1024,
      isProtectedProjectPath: (projectPath) => projectPath === "protected.txt"
    });
    assert.equal(manifest.captureState, "unavailable");
    const entries = new Map(manifest.roots[0].entries.map((entry) => [decodeBaselineRepoPath(entry), entry]));
    assert.deepEqual(entries.get("protected.txt"), { ...entries.get("protected.txt"), state: "protected", reasonCode: "protected-path", contentRef: null });
    assert.equal(entries.get("large.txt").state, "oversized");
    assert.equal(entries.get("large.txt").contentRef, null);
    assert.equal(manifest.limits.capturedBytes, 0);
  });

  it("is idempotent and fails closed on manifest or blob tampering", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty\n");
    const first = await capture(cwd);
    const second = await capture(cwd);
    assert.equal(second.integrityDigest, first.integrityDigest);
    const entry = first.roots[0].entries.find((item) => decodeBaselineRepoPath(item) === "dirty.txt");
    const blob = path.join(path.dirname(taskBaselineManifestPath(cwd, first.taskRunId)), "blobs", entry.contentRef.slice(7));
    fs.writeFileSync(blob, "tampered", { mode: 0o600 });
    assert.throws(() => readTaskBaselineBlob(cwd, first.taskRunId, entry.contentRef), /integrity mismatch/);

    const manifestPath = taskBaselineManifestPath(cwd, first.taskRunId);
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    raw.captureState = "unavailable";
    fs.writeFileSync(manifestPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    assert.throws(() => readTaskBaselineManifest(cwd, first.taskRunId), /Invalid task baseline manifest/);
  });

  it("validates the closed manifest contract", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-baseline-manifest.valid.json"), "utf8"));
    assert.doesNotThrow(() => validateTaskBaselineManifest(fixture));
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/task-baseline-manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    fixture.roots[0].entries[0].repoPathBase64 = "../escape";
    assert.throws(() => validateTaskBaselineManifest(fixture));
    assert.equal(validate(fixture), false);
    const invalidRetention = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-baseline-manifest.valid.json"), "utf8"));
    invalidRetention.retentionUntil = invalidRetention.capturedAt;
    invalidRetention.integrityDigest = taskBaselineManifestDigest(invalidRetention);
    assert.throws(() => validateTaskBaselineManifest(invalidRetention), /timestamps/);
  });

  it("does not publish a manifest if workspace content changes during capture", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty baseline\n");
    let changed = false;
    await assert.rejects(capture(cwd, {
      isProtectedProjectPath: () => {
        if (!changed) {
          changed = true;
          fs.writeFileSync(path.join(cwd, "dirty.txt"), "concurrent edit\n");
        }
        return false;
      }
    }), /Workspace changed during/);
    assert.equal(fs.existsSync(taskBaselineManifestPath(cwd, "task-01-run-01")), false);
  });

  it("refuses a symlinked source-evidence root", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty baseline\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-baseline-outside-"));
    fs.mkdirSync(path.join(cwd, ".pi", "piagent-state"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, ".pi", "piagent-state", "source-evidence"));
    await assert.rejects(capture(cwd), /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("marks entry and byte quota exhaustion explicitly without exceeding the cap", async () => {
    const entryCwd = repository();
    fs.writeFileSync(path.join(entryCwd, "dirty.txt"), "dirty\n");
    fs.writeFileSync(path.join(entryCwd, "extra.txt"), "extra\n");
    const entryManifest = await capture(entryCwd, { maxEntries: 1 });
    assert.equal(entryManifest.captureState, "unavailable");
    assert.equal(entryManifest.reasonCode, "entry-limit");
    assert.equal(entryManifest.roots[0].entries.length, 1);

    const byteCwd = repository();
    fs.writeFileSync(path.join(byteCwd, "one.bin"), Buffer.alloc(700_000, 1));
    fs.writeFileSync(path.join(byteCwd, "two.bin"), Buffer.alloc(700_000, 2));
    const byteManifest = await capture(byteCwd, { taskRunId: "task-byte-run", maxTotalBytes: 1024 * 1024 });
    assert.equal(byteManifest.captureState, "unavailable");
    assert.equal(byteManifest.reasonCode, "task-byte-quota");
    assert.ok(byteManifest.limits.capturedBytes <= 1024 * 1024);
    assert.equal(byteManifest.roots[0].entries.some((entry) => entry.reasonCode === "task-byte-quota"), true);
  });
});
