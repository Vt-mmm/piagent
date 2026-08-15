import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectDeterministicCommitSummary } from "../packages/piagent-core/runtime/inspection/commit-summary-projection.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.summary", runtimeInstanceId: "runtime.summary", sessionRef: "session.summary",
  taskId: "task-summary", taskRunId: "task-summary-run", agentOperationId: null, toolCallId: null };

function sourceView(files, total = files.length) {
  return { schemaVersion: 1, version: "piagent-webui-source-change-v1", view: "staged", viewRevision: "index-revision.summary",
    availability: { state: "current", reasonCode: null, message: null }, files, page: { total, returned: files.length, truncated: total > files.length } };
}

function file(overrides = {}) {
  return { fileRef: "file.summary", fileRevision: "file-revision.summary", path: "src/app.ts", pathDisplay: "exact-safe", status: "M",
    baseDigest: `sha256:${"a".repeat(64)}`, currentDigest: `sha256:${"b".repeat(64)}`,
    content: { access: "available", kind: "text", reasonCode: null }, stats: { state: "exact", additions: 2, deletions: 1, reasonCode: null }, ...overrides };
}

test("deterministic summary is stable, bounded, redacts secret names, and aggregates protected files", async () => {
  const staged = sourceView([file({ path: "src/sk-proj-abcdefghijklmnopqrstuvwxyz.ts" }), file({ fileRef: "file.protected",
    fileRevision: "file-revision.protected", path: "private/raw-secret.txt", content: { access: "protected", kind: "unknown", reasonCode: "protected-path" },
    stats: { state: "unavailable", additions: null, deletions: null, reasonCode: "protected-path" } })]);
  const first = projectDeterministicCommitSummary({ identity, sourceView: staged, taskRevision: "task-revision.summary",
    indexRevision: "index-revision.summary", generatedAt: "2026-08-14T09:00:00.000Z" });
  const second = projectDeterministicCommitSummary({ identity, sourceView: staged, taskRevision: "task-revision.summary",
    indexRevision: "index-revision.summary", generatedAt: "2026-08-14T09:01:00.000Z" });
  assert.equal(first.state, "ready"); assert.equal(validateFixture(registry, "commit-summary-v1", first).valid, true);
  assert.equal(first.summary.summaryRef, second.summary.summaryRef); assert.equal(first.summary.protectedFileCount, 1);
  assert.equal(first.summary.redacted, true); assert.equal(first.summary.additions, null); assert.equal(first.summary.deletions, null);
  const serialized = JSON.stringify(first); assert.doesNotMatch(serialized, /sk-proj-/); assert.doesNotMatch(serialized, /private\/raw-secret/);
  assert.match(serialized, /redacted staged file/); assert.match(serialized, /protected staged file/);
  assert.equal(serialized.includes("source text"), false);
});

test("summary reads only the staged projection and excludes worktree-only content", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-summary-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]); execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "staged.txt"), "BASE STAGED\n"); fs.writeFileSync(path.join(cwd, "unstaged.txt"), "BASE UNSTAGED\n");
  execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  fs.writeFileSync(path.join(cwd, "staged.txt"), "STAGED CONTENT MUST NOT ENTER SUMMARY\n"); execFileSync("git", ["-C", cwd, "add", "staged.txt"]);
  fs.writeFileSync(path.join(cwd, "unstaged.txt"), "WORKTREE ONLY SECRET MUST NOT ENTER SUMMARY\n");
  const views = await collectSourceChangeViews({ cwd, identity, taskRevision: "task-revision.summary" });
  const result = projectDeterministicCommitSummary({ identity, sourceView: views.staged, taskRevision: "task-revision.summary",
    indexRevision: views.staged.viewRevision });
  const serialized = JSON.stringify(result); assert.match(serialized, /staged\.txt/); assert.doesNotMatch(serialized, /unstaged\.txt/);
  assert.doesNotMatch(serialized, /STAGED CONTENT/); assert.doesNotMatch(serialized, /WORKTREE ONLY SECRET/);
  assert.equal(validateFixture(registry, "commit-summary-v1", result).valid, true);
});

test("deterministic generation consumes zero model turns and empty index is unavailable", async () => {
  const empty = projectDeterministicCommitSummary({ identity, sourceView: sourceView([]), taskRevision: "task-revision.summary",
    indexRevision: "index-revision.summary" });
  assert.equal(empty.state, "unavailable"); assert.equal(empty.reasonCode, "no-staged-changes");
  assert.equal(validateFixture(registry, "commit-summary-v1", empty).valid, true);
  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.summary", messageSetDigest: digestZeroTurnFact("messages", ["message.summary"]),
    taskContractDigest: digestZeroTurnFact("task", identity.taskRunId), journalHead: "journal.summary", promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const result = await runZeroTurnConformance({ action: "commit-summary.deterministic", commandId: "summary.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before), () => projectDeterministicCommitSummary({ identity,
      sourceView: sourceView([file()]), taskRevision: "task-revision.summary", indexRevision: "index-revision.summary" }));
  assert.equal(result.passed, true, result.violations.join(", "));
});
