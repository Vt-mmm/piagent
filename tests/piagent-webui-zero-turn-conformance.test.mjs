import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { collectFileDiff } from "../packages/piagent-core/runtime/inspection/diff-projection.ts";
import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { buildWebUiInspectionProjection } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { buildActivityInspector } from "../packages/piagent-core/runtime/product/activity-inspector.ts";
import {
  digestZeroTurnFact,
  evaluateZeroTurn,
  providerVisibleToolSchemaDigest,
  runZeroTurnConformance
} from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";

const identity = { projectRef: "project_01", runtimeInstanceId: "runtime_01", sessionRef: "session_01", taskId: null, taskRunId: null,
  agentOperationId: null, toolCallId: null };
const generatedAt = "2026-08-13T05:00:00.000Z";

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-zero-turn-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "example.txt"), "before\n");
  execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  fs.writeFileSync(path.join(cwd, "example.txt"), "after\n");
  return cwd;
}

function observation(overrides = {}) {
  return {
    providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    continuationConsumed: 0, turnTriggers: 0, sessionRef: "session_01", leafMessageRef: "message_01",
    messageSetDigest: digestZeroTurnFact("messages", ["message_01"]), taskContractDigest: null, journalHead: null,
    promptDigest: digestZeroTurnFact("prompt", { system: "stable" }),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", description: "Read", parameters: { type: "object" } }]),
    latestCausalSequence: 0, causalEvents: [], ...overrides
  };
}

function options(action, overrides = {}) {
  return { action, commandId: `command-${action}`, concurrency: "quiescent", mutationClass: "view", ...overrides };
}

describe("Piagent WebUI zero-model-turn conformance", () => {
  it("keeps Source Changes totals consistent when the bounded file list is truncated", async () => {
    const cwd = repository();
    for (let index = 0; index < 305; index += 1) fs.writeFileSync(path.join(cwd, `generated-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    const projection = await buildWebUiInspectionProjection({ cwd, sessionId: "session-private", generatedAt });
    const view = projection.sourceViews.workingTree;
    assert.equal(view.page.truncated, true);
    assert.equal(projection.snapshot.sourceChanges.workingTree.counts.files, view.page.total);
    assert.equal(projection.snapshot.sourceChanges.workingTree.health.state, "degraded");
    assert.equal(projection.snapshot.sourceChanges.workingTree.health.reasonCode, "source-view-truncated");
    assert.equal(projection.snapshot.sourceChanges.workingTree.counts.additions, null);
  });

  it("proves the real snapshot, source, diff, replay and Inspector view paths quiescent", async () => {
    const cwd = repository(), state = observation(), observe = () => structuredClone(state);
    const source = (await collectSourceChangeViews({ cwd, identity, generatedAt })).workingTree;
    const file = source.files.find((entry) => entry.path === "example.txt");
    const precondition = { expectedViewRevision: source.viewRevision, expectedFileRevision: file.fileRevision,
      expectedBaseDigest: file.baseDigest, expectedCurrentDigest: file.currentDigest };
    const events = new RuntimeEventStore({ projectRoot: cwd, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
      sessionRef: identity.sessionRef, maxEventsPerSegment: 10, maxSegments: 2 });
    const actions = [
      ["snapshot", () => buildWebUiInspectionProjection({ cwd, sessionId: "session-private", runtimeInstanceId: identity.runtimeInstanceId, generatedAt })],
      ["source", () => collectSourceChangeViews({ cwd, identity, generatedAt })],
      ["diff", () => collectFileDiff({ cwd, identity, sourceView: source, fileRef: file.fileRef, precondition, generatedAt })],
      ["replay", () => events.replay(null, 100)],
      ["inspector-equality", async () => {
        const input = { cwd, sessionId: "session-private", runtimeInstanceId: identity.runtimeInstanceId, generatedAt };
        const direct = await buildWebUiInspectionProjection(input), inspector = await buildActivityInspector(input);
        assert.deepEqual(inspector.snapshot, direct.snapshot);
        return inspector.snapshot.revision.runtimeRevision;
      }]
    ];
    for (const [name, action] of actions) {
      const report = await runZeroTurnConformance(options(name), observe, action);
      assert.equal(report.passed, true, `${name}: ${report.violations.join(", ")}`);
      assert.deepEqual(report.delta, { providerRequests: 0, userMessages: 0, assistantMessages: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, continuationConsumed: 0, turnTriggers: 0 });
    }
  });

  it("builds the canonical snapshot without reading protected workspace bytes", async () => {
    const cwd = repository();
    const protectedPath = path.join(cwd, "protected.txt");
    fs.writeFileSync(protectedPath, "DASHBOARD SECRET\n");
    const protectedStat = fs.statSync(protectedPath);
    const originalReadSync = fs.readSync;
    let protectedReads = 0;
    fs.readSync = function observedRead(descriptor, ...args) {
      try {
        const stat = fs.fstatSync(descriptor);
        if (stat.dev === protectedStat.dev && stat.ino === protectedStat.ino) protectedReads += 1;
      } catch {
        // Preserve the original behavior for non-file descriptors.
      }
      return originalReadSync.call(fs, descriptor, ...args);
    };
    try {
      const projection = await buildWebUiInspectionProjection({
        cwd,
        sessionId: "session-private",
        runtimeInstanceId: identity.runtimeInstanceId,
        generatedAt,
        protectedPaths: ["protected.txt"]
      });
      assert.equal(protectedReads, 0);
      assert.equal(JSON.stringify(projection).includes("DASHBOARD SECRET"), false);
    } finally {
      fs.readSync = originalReadSync;
    }
  });

  it("protects the canonical snapshot across both sides of a rename", async () => {
    for (const protectedName of ["old-secret.txt", "new-public.txt"]) {
      const cwd = repository();
      fs.writeFileSync(path.join(cwd, "old-secret.txt"), "RENAMED DASHBOARD SECRET\n");
      execFileSync("git", ["-C", cwd, "add", "."]);
      execFileSync("git", ["-C", cwd, "commit", "-qm", "rename baseline"]);
      execFileSync("git", ["-C", cwd, "mv", "old-secret.txt", "new-public.txt"]);
      const renamedStat = fs.statSync(path.join(cwd, "new-public.txt"));
      const originalReadSync = fs.readSync;
      let renamedReads = 0;
      fs.readSync = function observedRead(descriptor, ...args) {
        try {
          const stat = fs.fstatSync(descriptor);
          if (stat.dev === renamedStat.dev && stat.ino === renamedStat.ino) renamedReads += 1;
        } catch {
          // Preserve the original behavior for non-file descriptors.
        }
        return originalReadSync.call(fs, descriptor, ...args);
      };
      try {
        const projection = await buildWebUiInspectionProjection({
          cwd, sessionId: "session-private", runtimeInstanceId: identity.runtimeInstanceId,
          generatedAt, protectedPaths: [protectedName]
        });
        assert.equal(renamedReads, 0, `${protectedName} must protect both rename-side inodes in the canonical snapshot`);
        assert.equal(JSON.stringify(projection).includes("RENAMED DASHBOARD SECRET"), false);
      } finally {
        fs.readSync = originalReadSync;
      }
    }
  });

  it("allows an exactly reconciled unrelated operation to settle during a concurrent view", () => {
    const before = observation(), effects = { providerRequests: 1, assistantMessages: 1, inputTokens: 50, outputTokens: 10, costMicros: 20 };
    const after = observation({ providerRequests: 1, assistantMessages: 1,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 20 },
      leafMessageRef: "message_02", messageSetDigest: digestZeroTurnFact("messages", ["message_01", "message_02"]), latestCausalSequence: 1,
      causalEvents: [{ sequence: 1, correlationId: "operation-existing", attribution: "unrelated-operation", effects }] });
    const report = evaluateZeroTurn(options("refresh", { concurrency: "concurrent" }), before, after);
    assert.equal(report.passed, true, report.violations.join(", "));
  });

  it("rejects UI-attributed, unknown and unreconciled concurrent model work", () => {
    const before = observation(), changed = { providerRequests: 1, latestCausalSequence: 1 };
    const uiCausal = observation({ ...changed, causalEvents: [{ sequence: 1, correlationId: "command-refresh", attribution: "ui-command", effects: { providerRequests: 1 } }] });
    const uiReport = evaluateZeroTurn(options("refresh", { concurrency: "concurrent" }), before, uiCausal);
    assert.equal(uiReport.passed, false);
    assert.ok(uiReport.violations.includes("prohibited-causal-attribution:1"));
    const unknown = observation({ ...changed, causalEvents: [{ sequence: 1, correlationId: null, attribution: "unknown", effects: { providerRequests: 1 } }] });
    assert.equal(evaluateZeroTurn(options("refresh", { concurrency: "concurrent" }), before, unknown).passed, false);
    const unreconciled = observation(changed);
    assert.ok(evaluateZeroTurn(options("refresh", { concurrency: "concurrent" }), before, unreconciled).violations.includes("unreconciled-concurrent-delta:providerRequests"));
  });

  it("rejects transcript, continuation, prompt, tool-schema, task and journal mutation on views", () => {
    const before = observation();
    const after = observation({ userMessages: 1, continuationConsumed: 1, turnTriggers: 1,
      leafMessageRef: "message_02", messageSetDigest: digestZeroTurnFact("messages", ["message_01", "message_02"]),
      promptDigest: digestZeroTurnFact("prompt", { system: "mutated" }),
      toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "write", description: "Write", parameters: {} }]),
      taskContractDigest: digestZeroTurnFact("task", { revision: 2 }), journalHead: "journal-head-02" });
    const report = evaluateZeroTurn(options("open"), before, after);
    for (const violation of ["quiescent-counter-changed:userMessages", "quiescent-counter-changed:continuationConsumed", "quiescent-counter-changed:turnTriggers",
      "leaf-message-changed", "message-set-changed", "prompt-changed", "provider-tool-schema-changed", "task-contract-changed", "journal-head-changed"]) {
      assert.ok(report.violations.includes(violation), violation);
    }
    assert.equal(report.passed, false);
  });

  it("fails closed for unknown measurement, action errors and view mutation allowlists", async () => {
    const before = observation(), unknown = observation({ toolSchemaDigest: "unknown" });
    assert.equal(evaluateZeroTurn(options("status"), before, unknown).passed, false);
    const failed = await runZeroTurnConformance(options("diff"), () => observation(), () => { throw new TypeError("fixture"); });
    assert.equal(failed.passed, false); assert.ok(failed.violations.includes("action-failed:TypeError"));
    const allowed = evaluateZeroTurn(options("view", { allowedDigestChanges: ["journalHead"] }), before, observation({ journalHead: "journal-head-02" }));
    assert.ok(allowed.violations.includes("view-action-cannot-allow-authoritative-mutation"));
  });

  it("digests only canonical provider-visible tool fields", () => {
    const first = providerVisibleToolSchemaDigest([
      { name: "write", description: "Write", parameters: { required: ["path"], type: "object" }, sourceInfo: "ignored" },
      { name: "read", description: "Read", parameters: { type: "object" } }
    ]);
    const reordered = providerVisibleToolSchemaDigest([
      { name: "read", description: "Read", parameters: { type: "object" } },
      { name: "write", description: "Write", parameters: { type: "object", required: ["path"] }, internal: { authority: "ignored" } }
    ]);
    assert.equal(first, reordered);
    assert.throws(() => providerVisibleToolSchemaDigest([{ name: "read" }, { name: "read" }]), /unique/);
  });
});
