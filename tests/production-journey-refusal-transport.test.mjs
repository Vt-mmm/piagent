import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText } from "./helpers/scripted-production-supervisor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Since the 2026-09-30 task-contract retirement the refusal is an ordinary
// freeform turn: no task records it, and the message sent after the reconnect
// is a new model turn rather than a replayed receipt. The transport guarantees
// below are unchanged.
test("production refusal traverses authenticated HTTP and WebSocket reconnect without duplicate execution", { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-refusal-wire-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "destructive-history-refusal");
  assert.deepEqual(prepared.turns.map(turn => turn.id), ["request", "recover"]);
  assert.equal(prepared.turns[1].reconnectBefore, true);
  const gitStatus = () => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: prepared.workspace, encoding: "utf8" });
  const before = gitStatus();
  await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
      agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
    try {
      assert.equal(runtime.transport?.snapshot().kind, "loopback-http-websocket");
      for (const [fault, reason] of [[{ receiptUncertain: true }, "uncertain-send-requires-existing-session"], [{ abortAfterMs: 0 }, "abort-not-supported"]]) {
        await assert.rejects(runtime.turn({ ...prepared.turns[0], ...fault }, []),
          new RegExp(`offline-loopback-${reason}`));
        assert.equal(runtime.transport.snapshot().commandDispatches, 0, "unsupported fault must stop before any server command");
        assert.equal(runtime.metrics.scriptedTurns, 0, "unsupported fault must not consume a model turn");
      }
      const first = await runtime.turn(prepared.turns[0], [scriptedText(
        "REFUSAL=destructive-history-delete\nSAFE_ALTERNATIVE=approved-retention-or-archive")]);
      const recovered = await runtime.turn(prepared.turns[1], [scriptedText("Nothing was deleted; the refusal stands.")]);
      const snapshot = runtime.transport.snapshot();
      t.diagnostic(JSON.stringify({ scenario: "destructive-history-refusal", transport: snapshot,
        outcomes: [first, recovered].map(item => ({ turn: item.turnId, settlement: item.settlement,
          scriptedTurns: item.scriptedTurns, wireSequence: item.wireSettlement?.sequence })), metrics: runtime.metrics }));
      assert.equal(snapshot.bootstrapCount, 1);
      assert.equal(snapshot.unauthenticatedCatalogStatus, 401);
      assert.equal(snapshot.connections, 2);
      assert.equal(snapshot.reconnects, 1);
      assert.equal(snapshot.commandDispatches, 2, "exactly one create and one recovery send on the server");
      assert.equal(snapshot.reconnectCursors.length, 1);
      assert.ok(snapshot.reconnectCursors[0] >= first.wireSettlement.sequence);
      assert.equal(first.transport.connections, 1);
      assert.equal(first.command.payload.permissionMode, "workspace-write", "match the production benchmark create command");
      assert.equal(recovered.transport.connections, 2);
      assert.equal(first.sessionId, recovered.sessionId);
      assert.equal(first.settlement.sessionRef, recovered.settlement.sessionRef);
      assert.notEqual(first.settlement.operationRef, recovered.settlement.operationRef);
      assert.equal(first.scriptedTurns, 1);
      assert.equal(recovered.scriptedTurns, 1);
      for (const observation of [first, recovered]) {
        assert.deepEqual(observation.wireSettlement.payload, observation.settlement);
        assert.equal(observation.task, null, "no task is recorded for a freeform turn");
        assert.equal(observation.settlement.settlement, "completed");
        assert.equal(observation.settlement.taskStatus, "unknown");
        assert.equal(observation.settlement.reasonCode, null);
        assert.equal(runtime.observed.filter(event => event.kind === "operation.settled"
          && event.payload.operationRef === observation.settlement.operationRef).length, 1);
      }
      const wireCatalog = await runtime.transport.readCatalog(Date.now() + 5000);
      const httpCatalog = await runtime.transport.readHttp("/api/v1/session-catalog", Date.now() + 5000);
      assert.equal(wireCatalog.sessions.length, 1);
      assert.deepEqual(httpCatalog.sessions, wireCatalog.sessions);
      assert.equal(wireCatalog.sessions[0].sessionRef, recovered.settlement.sessionRef);
      const live = await runtime.transport.readHttp("/api/v1/session-live-state", Date.now() + 5000);
      assert.deepEqual(live.operations, []);
      assert.deepEqual(runtime.extensionErrors, []);
      assert.deepEqual(runtime.serviceErrors, []);
      assert.deepEqual(runtime.metrics, { scriptedTurns: 2, unexpectedTurns: 0, realProviderCalls: 0 });
      assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start").length, 0);
      assert.equal(gitStatus(), before);
    } finally { await runtime.close(); }
  });
});
