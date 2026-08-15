import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { collectFileDiff } from "../packages/piagent-core/runtime/inspection/diff-projection.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { collectSourceRevertPreview } from "../packages/piagent-core/runtime/inspection/source-revert-projection.ts";
import { PiSourceMutationGuard } from "../packages/piagent-core/runtime/policy/source-mutation-guard.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { createSourceRevertCommand } from "../packages/piagent-webui/client/src/source-revert-command.ts";
import { SourceRevertController } from "../packages/piagent-webui/extension/source-revert-controller.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.revert", runtimeInstanceId: "runtime.revert", sessionRef: "session.revert",
  taskId: "task-revert", taskRunId: "task-revert-run", agentOperationId: null, toolCallId: null };
const revisions = { runtimeRevision: "runtime-revision.revert", taskRevision: "task-revision.revert", controlRevision: "control-revision.revert",
  workspaceRevision: "workspace-revision.revert", indexRevision: "index-revision.revert", approvalRevision: null,
  sessionOptionRevision: null, queueRevision: null };

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-revert-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  const lines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
  fs.writeFileSync(path.join(cwd, "a.txt"), `${lines.join("\n")}\n`);
  execFileSync("git", ["-C", cwd, "add", "a.txt"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  return { cwd, lines };
}

function bindGuard(t, cwd) {
  const guard = new PiSourceMutationGuard(), rawSessionId = "raw-revert-session";
  const unbind = guard.bind({ cwd, rawSessionId, guardInstanceId: "guard.revert", facts: () => ({ taskId: identity.taskId,
    taskRunId: identity.taskRunId, taskRevision: revisions.taskRevision, controlRevision: revisions.controlRevision,
    taskState: "active", idle: true, isProtectedPath: () => false }) });
  t.after(unbind);
  return { execute: (authority) => guard.executeRevert({ cwd, rawSessionId, identity: { projectRef: identity.projectRef,
    runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId },
    action: "source.revert", expectedTaskRevision: revisions.taskRevision, expectedControlRevision: revisions.controlRevision,
    expectedIndexPreimage: authority.target.indexPreimage, expectedWorkspacePreimage: authority.target.workspacePreimage,
    previewRef: authority.target.previewRef, confirmedPreviewDigest: authority.target.confirmedPreviewDigest, authority }) };
}

async function preview(cwd, selectedHunkRefs = [], provenance = "runtime-observed-agent", options = {}) {
  const generatedAt = new Date().toISOString();
  const views = await collectSourceChangeViews({ cwd, identity, taskRevision: revisions.taskRevision, generatedAt });
  const file = views.workingTree.files.find((candidate) => candidate.path === "a.txt"); assert.ok(file);
  const diff = await collectFileDiff({ cwd, identity, sourceView: views.workingTree, fileRef: file.fileRef,
    precondition: { expectedViewRevision: views.workingTree.viewRevision, expectedFileRevision: file.fileRevision,
      expectedBaseDigest: file.baseDigest, expectedCurrentDigest: file.currentDigest }, taskRevision: revisions.taskRevision,
    revalidationMode: "selected-file", selectedRepoPaths: ["a.txt"], redactLine: options.redactLine });
  const taskView = structuredClone(views.workingTree), taskFile = taskView.files.find((candidate) => candidate.fileRef === file.fileRef);
  taskFile.provenance = { classification: provenance, evidence: provenance === "runtime-observed-agent" ? "exact" : "unavailable",
    mutationEvidenceRefs: provenance === "runtime-observed-agent" ? ["mutation-evidence.revert"] : [], firstObservedAt: generatedAt,
    lastObservedAt: generatedAt, reasonCode: provenance === "runtime-observed-agent" ? null : "provenance-unavailable" };
  return collectSourceRevertPreview({ cwd, identity, sourceView: views.workingTree, taskView, diff,
    taskRevision: revisions.taskRevision, workspaceRevision: views.workingTree.viewRevision, indexRevision: views.staged.viewRevision,
    selectedHunkRefs, generatedAt, confirmationKey: options.confirmationKey ?? Buffer.alloc(32, 7), guardAvailable: true,
    isProtectedPath: options.isProtectedPath });
}

test("confirmed whole-file revert restores the index image and preserves staged content", async (t) => {
  const { cwd, lines } = repository(t), guard = bindGuard(t, cwd), staged = [...lines];
  staged[1] = "line 2 staged"; fs.writeFileSync(path.join(cwd, "a.txt"), `${staged.join("\n")}\n`); execFileSync("git", ["-C", cwd, "add", "a.txt"]);
  const worktree = [...staged]; worktree[20] = "line 21 unstaged"; fs.writeFileSync(path.join(cwd, "a.txt"), `${worktree.join("\n")}\n`);
  const indexBefore = execFileSync("git", ["-C", cwd, "show", ":a.txt"]), selected = await preview(cwd);
  assert.equal(selected.projection.state, "ready", selected.projection.reasonCode); assert.ok(selected.authority);
  assert.equal(validateFixture(registry, "source-revert-v1", selected.projection).valid, true);
  const previewText = selected.projection.preview.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.marker}${line.text}`)).join("\n");
  assert.match(previewText, /\+line 21 unstaged/); assert.doesNotMatch(previewText, /line 2 staged/,
    "the confirmation preview must show only index-to-worktree content, not staged content");
  const effect = await guard.execute(selected.authority);
  assert.equal(effect.state, "settled", effect.reasonCode);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":a.txt"]), indexBefore);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), indexBefore);
});

test("selected-hunk revert leaves the other unstaged hunk and index untouched", async (t) => {
  const { cwd, lines } = repository(t), guard = bindGuard(t, cwd), changed = [...lines];
  changed[1] = "line 2 changed"; changed[20] = "line 21 changed"; fs.writeFileSync(path.join(cwd, "a.txt"), `${changed.join("\n")}\n`);
  const whole = await preview(cwd); assert.ok(whole.authority); assert.equal(whole.authority.patchAuthority.hunks.length, 2);
  const firstRef = whole.authority.patchAuthority.hunks[0].hunkRef, selected = await preview(cwd, [firstRef]); assert.ok(selected.authority);
  const indexBefore = execFileSync("git", ["-C", cwd, "show", ":a.txt"]), effect = await guard.execute(selected.authority);
  assert.equal(effect.state, "settled", effect.reasonCode); assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":a.txt"]), indexBefore);
  const remaining = fs.readFileSync(path.join(cwd, "a.txt"), "utf8");
  assert.equal(remaining.includes("line 2 changed"), false); assert.equal(remaining.includes("line 21 changed"), true);
});

test("stale preview and non-exact provenance fail before source mutation", async (t) => {
  const { cwd, lines } = repository(t), guard = bindGuard(t, cwd), changed = [...lines]; changed[1] = "line 2 changed";
  fs.writeFileSync(path.join(cwd, "a.txt"), `${changed.join("\n")}\n`);
  const mixed = await preview(cwd, [], "mixed"); assert.equal(mixed.projection.state, "unavailable");
  assert.equal(mixed.projection.reasonCode, "revert-provenance-unavailable");
  const ready = await preview(cwd); assert.ok(ready.authority); fs.appendFileSync(path.join(cwd, "a.txt"), "concurrent edit\n");
  const effect = await guard.execute(ready.authority); assert.equal(effect.state, "rejected"); assert.equal(effect.reasonCode, "mutation-preimage-stale");
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8").endsWith("concurrent edit\n"), true);
});

test("protected, redacted, and control-character previews fail closed", async (t) => {
  const { cwd } = repository(t); fs.writeFileSync(path.join(cwd, "a.txt"), "token sk-proj-abcdefghijklmnopqrstuvwxyz\n");
  const protectedResult = await preview(cwd, [], "runtime-observed-agent", { isProtectedPath: (_root, repoPath) => repoPath === "a.txt" });
  assert.equal(protectedResult.projection.state, "unavailable"); assert.equal(protectedResult.projection.reasonCode, "protected-path");
  const redacted = await preview(cwd, [], "runtime-observed-agent", { redactLine: (text) => text.includes("sk-proj-")
    ? { text: "token [REDACTED_SECRET]", redacted: true } : { text, redacted: false } });
  assert.equal(redacted.projection.state, "unavailable"); assert.equal(redacted.projection.reasonCode, "revert-preview-incomplete");
  fs.writeFileSync(path.join(cwd, "a.txt"), "unsafe \u001b[31m source\n");
  const controls = await preview(cwd); assert.equal(controls.projection.state, "unavailable");
  assert.equal(controls.projection.reasonCode, "revert-preview-incomplete");
});

test("confirmation commitments are stable for one runtime and unforgeable across runtime keys", async (t) => {
  const { cwd, lines } = repository(t), changed = [...lines]; changed[1] = "line 2 changed";
  fs.writeFileSync(path.join(cwd, "a.txt"), `${changed.join("\n")}\n`);
  const first = await preview(cwd, [], "runtime-observed-agent", { confirmationKey: Buffer.alloc(32, 7) });
  const revalidated = await preview(cwd, [], "runtime-observed-agent", { confirmationKey: Buffer.alloc(32, 7) });
  const replacementRuntime = await preview(cwd, [], "runtime-observed-agent", { confirmationKey: Buffer.alloc(32, 8) });
  assert.equal(first.projection.target.confirmedPreviewDigest, revalidated.projection.target.confirmedPreviewDigest);
  assert.notEqual(first.projection.target.confirmedPreviewDigest, replacementRuntime.projection.target.confirmedPreviewDigest);
});

test("whole-file revert restores executable mode without invoking repository filters", async (t) => {
  const { cwd } = repository(t), guard = bindGuard(t, cwd);
  fs.chmodSync(path.join(cwd, "a.txt"), 0o755); fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt filter=hostile\n");
  execFileSync("git", ["-C", cwd, "add", "a.txt", ".gitattributes"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "executable filtered baseline"]);
  const sentinel = path.join(cwd, "filter-ran"), script = path.join(os.tmpdir(), `piagent-revert-filter-${process.pid}-${Date.now()}.cjs`);
  t.after(() => fs.rmSync(script, { force: true }));
  fs.writeFileSync(script, "const fs=require('node:fs');fs.writeFileSync('filter-ran','ran');process.stdin.pipe(process.stdout);\n");
  execFileSync("git", ["-C", cwd, "config", "filter.hostile.clean", `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "changed executable content\n"); fs.chmodSync(path.join(cwd, "a.txt"), 0o644);
  fs.rmSync(sentinel, { force: true }); const selected = await preview(cwd); assert.ok(selected.authority); assert.equal(fs.existsSync(sentinel), false);
  const effect = await guard.execute(selected.authority); assert.equal(effect.state, "settled", effect.reasonCode);
  assert.equal(fs.existsSync(sentinel), false); assert.notEqual(fs.statSync(path.join(cwd, "a.txt")).mode & 0o111, 0);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), execFileSync("git", ["-C", cwd, "show", ":a.txt"]));
});

test("controller binds the confirmed digest, persists evidence, and deduplicates", async (t) => {
  const { cwd, lines } = repository(t), guard = bindGuard(t, cwd), changed = [...lines]; changed[1] = "line 2 changed";
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-baseline-session", capturedAt: new Date().toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "a.txt"), `${changed.join("\n")}\n`);
  const resolved = await preview(cwd); assert.ok(resolved.authority);
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions, taskState: "active", liveness: "idle" }) };
  const controller = new SourceRevertController({ bridge, projectRoot: cwd, resolve: async () => resolved,
    revisions: async () => revisions, mutate: async (input) => guard.execute(input.authority) });
  const snapshot = { identity, revision: { ...revisions, eventCursor: null } };
  const command = await createSourceRevertCommand(snapshot, resolved.projection);
  assert.equal(validateFixture(registry, "control-command-v1", command).valid, true);
  const missingIndexAuthority = structuredClone(command); missingIndexAuthority.expectedRevisions.indexRevision = null;
  assert.equal(validateFixture(registry, "control-command-v1", missingIndexAuthority).valid, false);
  const multiHunk = structuredClone(command); multiHunk.payload.hunkRefs = ["hunk.one", "hunk.two"];
  assert.equal(validateFixture(registry, "control-command-v1", multiHunk).valid, false);
  const zeroTurnState = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    continuationConsumed: 0, turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.revert",
    messageSetDigest: digestZeroTurnFact("messages", ["message.revert"]), taskContractDigest: digestZeroTurnFact("task", identity.taskRunId),
    journalHead: "journal.revert", promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "source.revert", commandId: command.commandId,
    concurrency: "quiescent", mutationClass: "control" }, () => structuredClone(zeroTurnState), () => controller.execute(command));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
  const receipt = zeroTurn.result; assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "reverted");
  assert.equal(validateFixture(registry, "control-command-v1", receipt).valid, true);
  const replay = await controller.execute(command); assert.equal(replay.deduplicated, true); assert.equal(replay.resultCode, "reverted");
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), execFileSync("git", ["-C", cwd, "show", ":a.txt"]));

  const tampered = structuredClone(command); tampered.commandId = "source-revert.tampered"; tampered.idempotencyKey = "b".repeat(36);
  tampered.payload.confirmedPreviewDigest = `sha256:${"f".repeat(64)}`;
  const denied = await controller.execute(tampered); assert.equal(denied.phase, "rejected"); assert.equal(denied.resultCode, "invalid-command");
  assert.equal(validateFixture(registry, "control-command-v1", denied).valid, true);
});
