import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { hashEvidenceCommand } from "../packages/piagent-core/extensions/runtime-evidence.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureTaskBaselineManifest, taskBaselineManifestPath } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { validateVerifierFileSnapshot } from "../packages/piagent-core/runtime/inspection/verifier-snapshot-contract.ts";
import {
  captureVerifierFileSnapshot,
  findVerifierFileSnapshot,
  inspectVerifierStaleness,
  readVerifierFileSnapshots
} from "../packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts";

const taskId = "task-01", taskRunId = "task-01-run-01";
const observedAt = "2026-08-13T16:00:00.000Z", capturedAt = "2026-08-13T16:00:01.000Z";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-verifier-snapshot-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "a.txt"), "a0\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "b0\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

async function baseline(cwd) {
  return await captureTaskBaselineManifest({
    projectRoot: cwd, taskId, taskRunId, sessionId: "private-session", capturedAt,
    baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd))
  });
}

function capture(cwd, snapshot, overrides = {}) {
  return captureVerifierFileSnapshot({
    projectRoot: cwd, taskId, taskRunId, sessionId: "private-session", toolCallId: "private-tool-call",
    commandHash: hashEvidenceCommand("npm test"), observedAt, capturedAt, exitCode: 0,
    treeDigest: workingTreeEvidenceDigest(snapshot), snapshot, ...overrides
  });
}

describe("verifier per-file snapshots", () => {
  it("captures an immutable schema-valid digest map without raw identities or commands", async () => {
    const cwd = repository();
    const manifest = await baseline(cwd);
    fs.writeFileSync(path.join(cwd, "a.txt"), "task a\n");
    const snapshot = workingTreeSnapshot(cwd);
    const record = capture(cwd, snapshot);
    assert.doesNotThrow(() => validateVerifierFileSnapshot(record));
    const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/verifier-file-snapshot.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.equal(validate(record), true, JSON.stringify(validate.errors));
    assert.equal(JSON.stringify(record).includes("private-session"), false);
    assert.equal(JSON.stringify(record).includes("private-tool-call"), false);
    assert.equal(JSON.stringify(record).includes("npm test"), false);
    assert.equal(capture(cwd, snapshot).attemptId, record.attemptId, "same verifier result is idempotent");
    const stored = readVerifierFileSnapshots(cwd, taskRunId);
    assert.deepEqual(stored.corruptions, []);
    assert.equal(stored.records.length, 1);
    const directory = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "verifiers");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, `${record.attemptId}.json`)).mode & 0o777, 0o600);
  });

  it("calculates the exact files that invalidate a passing verifier", async () => {
    const cwd = repository();
    await baseline(cwd);
    fs.writeFileSync(path.join(cwd, "a.txt"), "task a\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
    const verified = workingTreeSnapshot(cwd);
    const record = capture(cwd, verified);
    assert.deepEqual(inspectVerifierStaleness(record, verified, [], new Date("2026-08-13T16:01:00.000Z")), {
      state: "current", attemptRef: record.attemptRef, invalidatedByFiles: [], invalidatedPathDigests: [],
      filesKnown: true, truncated: false, reasonCode: null
    });
    fs.writeFileSync(path.join(cwd, "a.txt"), "changed after verify\n");
    fs.rmSync(path.join(cwd, "new.txt"));
    fs.writeFileSync(path.join(cwd, "later.txt"), "later\n");
    const stale = inspectVerifierStaleness(record, workingTreeSnapshot(cwd), [], new Date("2026-08-13T16:01:00.000Z"));
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.invalidatedByFiles, ["a.txt", "later.txt", "new.txt"]);
    assert.equal(stale.invalidatedPathDigests.length, 3);
    assert.equal(stale.filesKnown, true);
  });

  it("redacts protected file names and reports partial knowledge", async () => {
    const cwd = repository();
    fs.writeFileSync(path.join(cwd, "secret.txt"), "secret at verify\n");
    await baseline(cwd);
    const verified = workingTreeSnapshot(cwd);
    const record = capture(cwd, verified, { protectedPaths: ["secret.txt"] });
    assert.equal(record.files.find((file) => file.state === "protected").repoPathBase64, null);
    fs.writeFileSync(path.join(cwd, "secret.txt"), "secret changed\n");
    const stale = inspectVerifierStaleness(record, workingTreeSnapshot(cwd), ["secret.txt"], new Date("2026-08-13T16:01:00.000Z"));
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.invalidatedByFiles, []);
    assert.equal(stale.invalidatedPathDigests.length, 1);
    assert.equal(stale.filesKnown, false);
    assert.equal(stale.reasonCode, "invalidated-files-partially-hidden");
  });

  it("matches exact attempt identity and fails closed for legacy or corrupt evidence", async () => {
    const cwd = repository();
    const manifest = await baseline(cwd);
    fs.writeFileSync(path.join(cwd, "a.txt"), "task a\n");
    const snapshot = workingTreeSnapshot(cwd);
    const record = capture(cwd, snapshot);
    const read = readVerifierFileSnapshots(cwd, taskRunId);
    assert.equal(findVerifierFileSnapshot(read.records, {
      commandDigest: record.commandDigest, observedAt: record.observedAt, treeDigest: record.treeDigest, exitCode: 0
    }).attemptId, record.attemptId);
    assert.equal(findVerifierFileSnapshot(read.records, {
      commandDigest: record.commandDigest, observedAt: record.observedAt, treeDigest: record.treeDigest, exitCode: 1
    }), undefined);
    assert.equal(inspectVerifierStaleness(undefined, snapshot).state, "unknown");
    assert.equal(inspectVerifierStaleness(record, snapshot, [], new Date("2026-10-01T00:00:00.000Z")).reasonCode, "verifier-file-snapshot-expired");
    const file = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "verifiers", `${record.attemptId}.json`);
    fs.appendFileSync(file, "tamper", { mode: 0o600 });
    const corrupt = readVerifierFileSnapshots(cwd, taskRunId);
    assert.equal(corrupt.records.length, 0);
    assert.equal(corrupt.corruptions.length, 1);
  });

  it("refuses unavailable snapshots and symlink escapes", async () => {
    const cwd = repository();
    const manifest = await baseline(cwd);
    const snapshot = workingTreeSnapshot(cwd);
    assert.equal(capture(cwd, { ...snapshot, "bad.txt": `wt-content-v2-unavailable:${"0".repeat(64)}` }), undefined);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-verifier-outside-"));
    const directory = path.join(path.dirname(taskBaselineManifestPath(cwd, manifest.taskRunId)), "verifiers");
    fs.symlinkSync(outside, directory);
    assert.throws(() => capture(cwd, snapshot), /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});
