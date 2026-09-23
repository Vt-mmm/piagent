import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText } from "./helpers/scripted-production-supervisor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("supplemental lost-receipt control replays prior operation identity without resending", { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-uncertain-wire-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "destructive-history-refusal");
  // The extra receipt fault is deliberately supplemental. Do not count it as
  // another executed benchmark scenario or alter the frozen suite metadata.
  assert.notEqual(prepared.turns[1].receiptUncertain, true);
  await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
      agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
    try {
      const first = await runtime.turn(prepared.turns[0], [scriptedText(
        "REFUSAL=destructive-history-delete\nSAFE_ALTERNATIVE=approved-retention-or-archive")]);
      const recovered = await runtime.turn({ ...prepared.turns[1], receiptUncertain: true }, []);
      t.diagnostic(JSON.stringify({ control: "supplemental-refusal-lost-receipt", receipt: recovered.receipt,
        recovery: recovered.recovery, wireSettlement: recovered.wireSettlement,
        transport: runtime.transport.snapshot(), metrics: runtime.metrics }));
      assert.equal(recovered.receipt, null, "the discarded acknowledgement must not be reconstructed as a receipt");
      assert.equal(recovered.recovery.responseObserved, true);
      assert.equal(recovered.recovery.responseDiscarded, true);
      assert.equal(recovered.recovery.connectionDropped, true);
      assert.equal(recovered.recovery.sendAttempts, 1);
      assert.ok(recovered.recovery.eventsBeforeDisconnect.includes(recovered.recovery.recoveredAtSequence),
        "identity must come from a genuinely pre-disconnect event replayed on the new socket, not a later live event");
      assert.ok(recovered.wireSettlement.sequence > recovered.recovery.replayCursor);
      assert.equal(recovered.settlement.operationRef, recovered.operationRef);
      assert.equal(recovered.settlement.sessionRef, recovered.sessionRef);
      assert.equal(recovered.wireSettlement.payload.messageRequestId, recovered.command.payload.messageRequestId);
      assert.deepEqual(recovered.wireSettlement.payload, recovered.settlement);
      assert.notEqual(first.operationRef, recovered.operationRef);
      assert.equal(first.sessionId, recovered.sessionId);
      assert.equal(first.task.taskRunId, recovered.task.taskRunId);
      assert.equal(recovered.task.trace.terminalDisposition, "refused");
      assert.equal(recovered.settlement.taskStatus, "refused");
      assert.equal(recovered.settlement.settlement, "completed");
      assert.equal(recovered.scriptedTurns, 0);
      assert.equal(recovered.unconsumedScript, 0);
      const transport = runtime.transport.snapshot();
      assert.equal(transport.connections, 3);
      assert.equal(transport.reconnects, 2);
      assert.equal(transport.droppedConnections, 1);
      assert.equal(transport.uncertainSends, 1);
      assert.equal(transport.commandDispatches, 2, "no resend after receipt loss");
      assert.equal(runtime.observed.filter(event => event.kind === "operation.settled"
        && event.payload.operationRef === recovered.operationRef).length, 1, "replayed delivery is not duplicate execution");
      assert.deepEqual(runtime.metrics, { scriptedTurns: 1, unexpectedTurns: 0, realProviderCalls: 0 });
      assert.deepEqual(runtime.extensionErrors, []);
      assert.deepEqual(runtime.serviceErrors, []);
      assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start").length, 0);
    } finally { await runtime.close(); }
  });
});
