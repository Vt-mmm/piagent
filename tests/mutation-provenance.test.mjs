import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { validateMutationProvenanceRecord } from "../packages/piagent-core/runtime/inspection/mutation-provenance-contract.ts";
import { appendMutationProvenance, readMutationProvenance } from "../packages/piagent-core/runtime/inspection/mutation-provenance-store.ts";
import { captureTaskBaselineManifest, taskBaselineManifestPath } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = {
  projectRef: "project_01", runtimeInstanceId: "runtime_01", sessionRef: "session_01",
  taskId: "task-01", taskRunId: "task-01-run-01", agentOperationId: null, toolCallId: null
};
const capturedAt = "2026-08-13T15:00:00.000Z";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provenance-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "clean.txt"), "baseline\n");
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "head baseline\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

async function capture(cwd) {
  return await captureTaskBaselineManifest({
    projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "private-session", capturedAt,
    baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd))
  });
}

function contentDigest(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function appendExact(cwd, before, after, file, content, overrides = {}) {
  return appendMutationProvenance({
    projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "private-session", toolCallId: "private-tool-call", toolName: "write",
    recordedAt: "2026-08-13T15:01:00.000Z", beforeSnapshot: before, afterSnapshot: after,
    changedPaths: [file], recordedDigests: { [file]: after[file] },
    recordedContentDigests: { [file]: contentDigest(content) }, proofModes: { [file]: "full-content" },
    ...overrides
  });
}

describe("mutation provenance evidence", () => {
  it("persists an immutable, schema-valid exact record without raw private identities", async () => {
    const cwd = repository();
    const manifest = await capture(cwd);
    const before = workingTreeSnapshot(cwd);
    const content = "runtime authored\n";
    fs.writeFileSync(path.join(cwd, "clean.txt"), content);
    const after = workingTreeSnapshot(cwd);
    const record = appendExact(cwd, before, after, "clean.txt", content);
    assert.doesNotThrow(() => validateMutationProvenanceRecord(record));
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/mutation-provenance-record.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.equal(validate(record), true, JSON.stringify(validate.errors));
    assert.equal(JSON.stringify(record).includes("private-session"), false);
    assert.equal(JSON.stringify(record).includes("private-tool-call"), false);
    assert.equal(appendExact(cwd, before, after, "clean.txt", content).recordId, record.recordId, "same observed tool result is idempotent");

    const stored = readMutationProvenance(cwd, identity.taskRunId);
    assert.deepEqual(stored.corruptions, []);
    assert.equal(stored.records.length, 1);
    const mutationDir = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "mutations");
    assert.equal(fs.statSync(mutationDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(mutationDir, `${record.recordId}.json`)).mode & 0o777, 0o600);
  });

  it("projects exact agent provenance and mixed provenance relative to task-start dirt", async () => {
    const cleanCwd = repository();
    await capture(cleanCwd);
    const cleanBefore = workingTreeSnapshot(cleanCwd);
    const cleanContent = "agent clean change\n";
    fs.writeFileSync(path.join(cleanCwd, "clean.txt"), cleanContent);
    const cleanAfter = workingTreeSnapshot(cleanCwd);
    appendExact(cleanCwd, cleanBefore, cleanAfter, "clean.txt", cleanContent);
    const secondContent = "agent clean change twice\n";
    fs.writeFileSync(path.join(cleanCwd, "clean.txt"), secondContent);
    const secondAfter = workingTreeSnapshot(cleanCwd);
    appendExact(cleanCwd, cleanAfter, secondAfter, "clean.txt", secondContent, {
      toolCallId: "private-tool-call-2", recordedAt: "2026-08-13T15:01:30.000Z"
    });
    const cleanTask = (await collectSourceChangeViews({ cwd: cleanCwd, identity, taskRevision: "rev-1", generatedAt: "2026-08-13T15:02:00.000Z" })).task;
    assert.equal(validateFixture(registry, "source-change-v1", cleanTask).valid, true);
    const cleanFile = cleanTask.files.find((file) => file.path === "clean.txt");
    assert.equal(cleanFile.provenance.classification, "runtime-observed-agent");
    assert.equal(cleanFile.provenance.evidence, "exact");
    assert.equal(cleanFile.provenance.mutationEvidenceRefs.length, 2);
    fs.writeFileSync(path.join(cleanCwd, "clean.txt"), "out-of-band bytes\n");
    const changedAgain = (await collectSourceChangeViews({ cwd: cleanCwd, identity, taskRevision: "rev-1b", generatedAt: "2026-08-13T15:03:00.000Z" })).task;
    assert.equal(changedAgain.files.find((file) => file.path === "clean.txt").provenance.classification, "post-baseline-unattributed",
      "persisted exact evidence must not survive a current-content mismatch");

    const dirtyCwd = repository();
    fs.writeFileSync(path.join(dirtyCwd, "dirty.txt"), "user dirt\n");
    await capture(dirtyCwd);
    const dirtyBefore = workingTreeSnapshot(dirtyCwd);
    const dirtyContent = "agent changed user dirt\n";
    fs.writeFileSync(path.join(dirtyCwd, "dirty.txt"), dirtyContent);
    const dirtyAfter = workingTreeSnapshot(dirtyCwd);
    appendExact(dirtyCwd, dirtyBefore, dirtyAfter, "dirty.txt", dirtyContent);
    const dirtyTask = (await collectSourceChangeViews({ cwd: dirtyCwd, identity, taskRevision: "rev-2", generatedAt: "2026-08-13T15:02:00.000Z" })).task;
    const dirtyFile = dirtyTask.files.find((file) => file.path === "dirty.txt");
    assert.equal(dirtyFile.provenance.classification, "mixed");
    assert.match(dirtyFile.provenance.baselineEvidenceRef, /^baseline\./);
  });

  it("keeps carrier-only shell transitions but invalidates exact provenance after unknown content changes", async () => {
    const cwd = repository();
    await capture(cwd);
    const before = workingTreeSnapshot(cwd);
    const exactContent = "exact then committed\n";
    fs.writeFileSync(path.join(cwd, "clean.txt"), exactContent);
    const exactAfter = workingTreeSnapshot(cwd);
    appendExact(cwd, before, exactAfter, "clean.txt", exactContent);

    git(cwd, "add", "clean.txt");
    git(cwd, "commit", "-qm", "task commit");
    const committed = workingTreeSnapshot(cwd);
    const preserved = appendMutationProvenance({
      projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
      sessionId: "private-session", toolCallId: "commit-call", toolName: "shell",
      recordedAt: "2026-08-13T15:02:00.000Z", beforeSnapshot: exactAfter, afterSnapshot: committed,
      changedPaths: ["clean.txt"], recordedDigests: {},
      recordedContentDigests: { "clean.txt": contentDigest(exactContent) }, proofModes: {}
    });
    assert.equal(preserved.changes[0].effect, "content-preserved");
    let task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "rev-3", generatedAt: "2026-08-13T15:03:00.000Z" })).task;
    assert.equal(task.files.find((file) => file.path === "clean.txt").provenance.classification, "runtime-observed-agent");

    const unknownBefore = workingTreeSnapshot(cwd);
    const unknownContent = "unknown shell content\n";
    fs.writeFileSync(path.join(cwd, "clean.txt"), unknownContent);
    const unknownAfter = workingTreeSnapshot(cwd);
    const observed = appendMutationProvenance({
      projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
      sessionId: "private-session", toolCallId: "unknown-call", toolName: "shell",
      recordedAt: "2026-08-13T15:04:00.000Z", beforeSnapshot: unknownBefore, afterSnapshot: unknownAfter,
      changedPaths: ["clean.txt"], recordedDigests: {},
      recordedContentDigests: { "clean.txt": contentDigest(unknownContent) }, proofModes: {}
    });
    assert.equal(observed.changes[0].effect, "content-changed");
    task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "rev-4", generatedAt: "2026-08-13T15:05:00.000Z" })).task;
    assert.equal(task.files.find((file) => file.path === "clean.txt").provenance.classification, "post-baseline-unattributed");
  });

  it("fails provenance closed on protected paths and record tampering", async () => {
    const cwd = repository();
    const manifest = await capture(cwd);
    const before = workingTreeSnapshot(cwd);
    const content = "protected change\n";
    fs.writeFileSync(path.join(cwd, "clean.txt"), content);
    const after = workingTreeSnapshot(cwd);
    assert.equal(appendExact(cwd, before, after, "clean.txt", content, { protectedPaths: ["clean.txt"] }), undefined);
    const record = appendExact(cwd, before, after, "clean.txt", content);
    const file = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "mutations", `${record.recordId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.changes[0].afterContentDigest = `sha256:${"0".repeat(64)}`;
    fs.writeFileSync(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    const read = readMutationProvenance(cwd, identity.taskRunId);
    assert.equal(read.records.length, 0);
    assert.equal(read.corruptions.length, 1);
    const task = (await collectSourceChangeViews({ cwd, identity, taskRevision: "rev-5", generatedAt: "2026-08-13T15:02:00.000Z" })).task;
    assert.equal(task.files.find((entry) => entry.path === "clean.txt").provenance.reasonCode, "provenance-ledger-corrupt");
  });

  it("refuses a symlinked mutation directory without writing outside private state", async () => {
    const cwd = repository();
    const manifest = await capture(cwd);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provenance-outside-"));
    const mutationDir = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "mutations");
    fs.symlinkSync(outside, mutationDir);
    const before = workingTreeSnapshot(cwd);
    const content = "must stay inside\n";
    fs.writeFileSync(path.join(cwd, "clean.txt"), content);
    const after = workingTreeSnapshot(cwd);
    assert.throws(() => appendExact(cwd, before, after, "clean.txt", content), /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});
