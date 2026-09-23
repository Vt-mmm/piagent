import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText } from "./helpers/scripted-production-supervisor.mjs";
import { acceptedJourneyTaskStatuses } from "../scripts/benchmark-journey-outcome.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("native refusal and durable recovery preserve task truth through actual production operations", { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-native-refusal-recovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "destructive-history-refusal");
  assert.deepEqual(prepared.turns.map(turn => turn.id), ["request", "recover"]);
  assert.equal(prepared.turns[1].reconnectBefore, true);
  // This fixture covers native operation/recovery and classification, not a
  // WebSocket disconnect. The transport reconnect qualification stays separate.
  const results = await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot });
    try {
      const first = await runtime.turn(prepared.turns[0], [scriptedText(
        "REFUSAL=destructive-history-delete\nSAFE_ALTERNATIVE=approved-retention-or-archive")]);
      const recovered = await runtime.turn(prepared.turns[1], []);
      const observations = [first, recovered];
      t.diagnostic(JSON.stringify({ observations: observations.map(item => ({ turn: item.turnId,
        settlement: item.settlement, taskRunId: item.task?.taskRunId, outcome: item.task?.trace.outcome,
        disposition: item.task?.trace.terminalDisposition, scriptedTurns: item.scriptedTurns })),
        metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
      assert.deepEqual(runtime.extensionErrors, []);
      assert.deepEqual(runtime.serviceErrors, []);
      assert.equal(runtime.metrics.realProviderCalls, 0);
      assert.equal(runtime.metrics.unexpectedTurns, 0);
      assert.equal(runtime.rawEvents.filter(item => item.type === "tool_execution_start").length, 0);
      assert.equal(first.scriptedTurns, 1);
      assert.equal(recovered.scriptedTurns, 0, "durable refusal recovery must not open another model turn");
      assert.equal(first.task.taskRunId, recovered.task.taskRunId, "recovery must preserve the original task");
      assert.equal(first.sessionId, recovered.sessionId);
      for (const observation of observations) {
        assert.equal(observation.task.trace.outcome, "blocked");
        assert.equal(observation.task.trace.terminalDisposition, "refused");
        assert.equal(observation.settlement.taskStatus, "refused");
      }
      return observations;
    } finally { await runtime.close(); }
  });
  await t.test("a refusal journey accepts correct refusal at its first request, without requiring an initial non-refusal", () => {
    const accepted = acceptedJourneyTaskStatuses({ expectedSettlement: "completed", expectedTerminalSettlement: "refused",
      turnIndex: 1, turnCount: 2 });
    assert.ok(accepted.includes(results[0].settlement.taskStatus));
  });
  await t.test("delivery of the native durable refusal receipt completes only the operation, never the refused task", () => {
    assert.equal(results[1].settlement.settlement, "completed");
    assert.equal(results[1].settlement.reasonCode, null);
  });
});
