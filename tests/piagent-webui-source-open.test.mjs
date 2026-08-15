import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { appendSourceHandoffEvidence } from "../packages/piagent-core/runtime/inspection/source-handoff-store.ts";
import { resolveSourceOpenTarget } from "../packages/piagent-core/runtime/inspection/source-open-target.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { createSourceOpenCommand } from "../packages/piagent-webui/client/src/source-open-command.ts";
import { SourceOpenController } from "../packages/piagent-webui/extension/source-open-controller.ts";
import { VSCodeHandoff } from "../packages/piagent-webui/extension/vscode-handoff.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.open", runtimeInstanceId: "runtime.open", sessionRef: "session.open",
  taskId: "task-open", taskRunId: "task-open-run", agentOperationId: null, toolCallId: null };
const revisions = { runtimeRevision: "runtime-revision.open", taskRevision: "task-revision.open", controlRevision: "control-revision.open",
  workspaceRevision: "workspace-revision.open", indexRevision: "index-revision.open", approvalRevision: null,
  sessionOptionRevision: null, queueRevision: null };

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-open-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "safe.txt"), "SAFE BASE\n");
  fs.writeFileSync(path.join(cwd, "protected.txt"), "PROTECTED BASE\n");
  execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  return cwd;
}

async function authority(cwd, filename = "safe.txt", protectedName = null) {
  const views = await collectSourceChangeViews({ cwd, identity, taskRevision: revisions.taskRevision,
    isProtectedPath: (_root, repoPath) => repoPath === protectedName });
  const file = views.workingTree.files.find((candidate) => candidate.path === filename); assert.ok(file);
  return { file, result: await resolveSourceOpenTarget({ cwd, identity, sourceView: views.workingTree, fileRef: file.fileRef,
    taskRevision: revisions.taskRevision, workspaceRevision: views.workingTree.viewRevision,
    isProtectedPath: (_root, repoPath) => repoPath === protectedName }) };
}

test("opaque source target resolves only an exact safe ordinary working-tree file", async (t) => {
  const cwd = repository(t); fs.writeFileSync(path.join(cwd, "safe.txt"), "SAFE CURRENT\n");
  const safe = await authority(cwd); assert.ok(safe.result); assert.equal(safe.result.repoPath, "safe.txt");
  assert.equal(safe.result.absolutePath, fs.realpathSync.native(path.join(cwd, "safe.txt")));
  fs.writeFileSync(path.join(cwd, "protected.txt"), "PROTECTED CURRENT\n");
  const denied = await authority(cwd, "protected.txt", "protected.txt"); assert.equal(denied.result, null);
  fs.unlinkSync(path.join(cwd, "safe.txt"));
  const deleted = await authority(cwd); assert.equal(deleted.result, null);
  fs.symlinkSync("protected.txt", path.join(cwd, "safe.txt"));
  const symlink = await authority(cwd); assert.equal(symlink.result, null);
  assert.equal(await resolveSourceOpenTarget({ cwd, identity, sourceView: { view: "working-tree", availability: { state: "current" }, files: [], viewRevision: "x" },
    fileRef: "../../etc/passwd", taskRevision: revisions.taskRevision, workspaceRevision: revisions.workspaceRevision }), null);
});

test("VS Code handoff uses fixed argv with no shell and has no editor fallback", async (t) => {
  const cwd = repository(t), capture = path.join(cwd, "argv.json"), cli = path.join(cwd, "fake-code.cjs"), sentinel = path.join(cwd, "shell-ran");
  fs.writeFileSync(cli, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(cli, 0o755);
  const target = path.join(cwd, `unsafe;touch ${path.basename(sentinel)}.txt`), handoff = new VSCodeHandoff({ cli, timeoutMs: 2_000 });
  const result = await handoff.open(target, 12, 4); assert.deepEqual(result, { state: "settled", reasonCode: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["--reuse-window", "--goto", `${target}:12:4`]);
  assert.equal(fs.existsSync(sentinel), false); assert.equal(new VSCodeHandoff({ cli: null }).available(), false);
  assert.deepEqual(await new VSCodeHandoff({ cli: null }).open(target, null, null),
    { state: "rejected", reasonCode: "vscode-cli-unavailable" });
});

test("controller binds current revisions, persists path-free evidence, deduplicates, and consumes zero model turns", async (t) => {
  const cwd = repository(t);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-open-session", capturedAt: new Date().toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "safe.txt"), "TOP SECRET SOURCE THAT MUST NOT ENTER EVIDENCE\n");
  const selected = await authority(cwd); assert.ok(selected.result);
  const currentRevisions = { ...revisions, workspaceRevision: selected.result.target.workspaceRevision };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions: currentRevisions, taskState: "active", liveness: "idle" }) };
  let opens = 0;
  const controller = new SourceOpenController({ bridge, projectRoot: cwd, resolve: async (fileRef) => fileRef === selected.file.fileRef ? selected.result : null,
    open: async (absolutePath, line, column) => { opens += 1; assert.equal(absolutePath, selected.result.absolutePath);
      assert.equal(line, null); assert.equal(column, null); return { state: "settled", reasonCode: null }; } });
  const snapshot = { identity, revision: { ...currentRevisions, eventCursor: null } }, command = await createSourceOpenCommand(snapshot, selected.file.fileRef);
  assert.equal(validateFixture(registry, "control-command-v1", command).valid, true);
  const missingWorkspace = structuredClone(command); missingWorkspace.expectedRevisions.workspaceRevision = null;
  assert.equal(validateFixture(registry, "control-command-v1", missingWorkspace).valid, false);
  const columnWithoutLine = structuredClone(command); columnWithoutLine.payload.column = 2;
  assert.equal(validateFixture(registry, "control-command-v1", columnWithoutLine).valid, false);
  const zeroTurnState = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.open", messageSetDigest: digestZeroTurnFact("messages", ["message.open"]),
    taskContractDigest: digestZeroTurnFact("task", identity.taskRunId), journalHead: "journal.open", promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "source.open-in-vscode", commandId: command.commandId,
    concurrency: "quiescent", mutationClass: "control" }, () => structuredClone(zeroTurnState), () => controller.execute(command));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
  assert.equal(zeroTurn.result.phase, "settled"); assert.equal(zeroTurn.result.resultCode, "opened");
  assert.equal(validateFixture(registry, "control-command-v1", zeroTurn.result).valid, true); assert.equal(opens, 1);
  const replay = await controller.execute(command); assert.equal(replay.deduplicated, true); assert.equal(opens, 1);
  const evidence = fs.readdirSync(path.join(cwd, ".pi", "piagent-state", "source-evidence"), { recursive: true })
    .filter((entry) => String(entry).endsWith(".json")).map((entry) => fs.readFileSync(path.join(cwd, ".pi", "piagent-state", "source-evidence", String(entry)), "utf8")).join("\n");
  assert.equal(evidence.includes(cwd), false); assert.equal(evidence.includes("safe.txt"), false);
  assert.equal(evidence.includes("TOP SECRET SOURCE"), false); assert.equal(evidence.includes("--goto"), false);
});

test("a crash after requested evidence becomes durable effect-unknown and never reopens", async (t) => {
  const cwd = repository(t);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-open-orphan", capturedAt: new Date().toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "safe.txt"), "CURRENT\n"); const selected = await authority(cwd); assert.ok(selected.result);
  const currentRevisions = { ...revisions, workspaceRevision: selected.result.target.workspaceRevision }, snapshot = { identity, revision: { ...currentRevisions, eventCursor: null } };
  const command = await createSourceOpenCommand(snapshot, selected.file.fileRef), keyDigest = `sha256:${(await import("node:crypto")).createHash("sha256").update(command.idempotencyKey).digest("hex")}`;
  appendSourceHandoffEvidence({ projectRoot: cwd, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
    sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId, commandId: command.commandId,
    idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, fileRef: selected.result.target.fileRef, line: null, column: null,
    taskRevision: selected.result.target.taskRevision, workspaceRevision: selected.result.target.workspaceRevision,
    contentDigest: selected.result.target.contentDigest, phase: "requested", resultCode: "handoff-requested", failureCode: null,
    requestedAt: command.requestedAt, recordedAt: new Date().toISOString() });
  let opens = 0; const bridge = { snapshot: () => ({ state: "ready", identity, revisions: currentRevisions, taskState: "active", liveness: "idle" }) };
  const controller = new SourceOpenController({ bridge, projectRoot: cwd, resolve: async () => selected.result,
    open: async () => { opens += 1; return { state: "settled", reasonCode: null }; } });
  const receipt = await controller.execute(command); assert.equal(receipt.phase, "uncertain"); assert.equal(receipt.resultCode, "effect-unknown");
  assert.equal(validateFixture(registry, "control-command-v1", receipt).valid, true); assert.equal(opens, 0);
  const replay = await controller.execute(command); assert.equal(replay.phase, "uncertain"); assert.equal(replay.deduplicated, true); assert.equal(opens, 0);
});
