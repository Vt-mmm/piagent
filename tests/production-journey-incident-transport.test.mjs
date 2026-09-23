import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const projectStatus = cwd => execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"],
  { encoding: "utf8", timeout: 10000 });

// This test-owned script reads only the public incident file. Correlate the
// gateway's named worker with that worker's final root_cause event; neither
// private grader data nor an oracle supplies the answer or completion status.
function publicIncident(log) {
  const events = log.trim().split(/\r?\n/).map(line => Object.fromEntries(
    [...line.matchAll(/\b([a-z_]+)=([^\s]+)/g)].map(match => [match[1], match[2]])));
  const gateway = events.filter(event => event.service === "gateway" && event.worker).at(-1);
  assert.ok(gateway, "the public log must contain a gateway-to-worker correlation");
  const worker = events.filter(event => event.service === gateway.worker && event.root_cause).at(-1);
  assert.ok(worker, "the correlated worker must report its root cause in the public log");
  assert.match(worker.root_cause, /^[A-Z0-9_]+$/);
  return { worker: gateway.worker, status: gateway.status, code: worker.root_cause };
}

test("actual cold-start incident diagnosis completes and recovers through loopback HTTP/WebSocket", { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-incident-transport-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "incident-diagnosis");
  assert.equal(prepared.scenario.profile, "node-typescript");
  assert.equal(prepared.scenario.lifecycle, "cold-start");
  assert.equal(fs.existsSync(path.join(prepared.workspace, ".pi/piagent-state/project-onboarding.json")), false);
  assert.deepEqual(prepared.turns.map(turn => turn.id), ["request", "recover"]);
  assert.equal(prepared.turns[1].reconnectBefore, true);
  for (const [index, turn] of prepared.turns.entries()) {
    assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot,
      prepared.scenario.userJourney.turns[index].prompt), "utf8").trim());
    assert.equal(Object.hasOwn(turn, "workflow"), false, "the frozen plain ingress cannot acquire a workflow override");
  }

  const publicPath = path.join(prepared.workspace, "logs/incident.log");
  const publicLog = fs.readFileSync(publicPath, "utf8"), incident = publicIncident(publicLog);
  const marker = `ROOT_CAUSE=${incident.code}`;
  const answer = `The gateway returned ${incident.status} for worker ${incident.worker}. The correlated worker event identifies the final root cause; the database is healthy. No files were changed.\n${marker}`;
  const beforeStatus = projectStatus(prepared.workspace);
  await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
      agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
    try {
      const first = await runtime.turn(prepared.turns[0], [
        scriptedTool("incident-read-log", "read", { path: "logs/incident.log" }), scriptedText(answer)
      ]);
      const recovered = await runtime.turn(prepared.turns[1], []);
      const results = [first, recovered], transport = runtime.transport.snapshot();
      // Preserve the actual wire/task observations before desired completion
      // assertions. Unknown, missing, or pending outcomes remain honest reds.
      t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, profile: prepared.scenario.profile,
        lifecycle: prepared.scenario.lifecycle, publicLogSha256: createHash("sha256").update(publicLog).digest("hex"),
        observations: results.map((result, index) => ({ turn: result.turnId,
          promptSha256: createHash("sha256").update(prepared.turns[index].message).digest("hex"),
          settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
          taskRunId: result.task?.taskRunId, taskSessionId: result.task?.sessionId,
          outcome: result.task?.trace.outcome, mutationPolicy: result.task?.mutationPolicy,
          criteria: result.task?.acceptanceReceipt?.criteria.map(item => ({ id: item.id, status: item.status })),
          scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript })),
        transport, metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));

      assert.deepEqual(runtime.extensionErrors, []);
      assert.deepEqual(runtime.serviceErrors, []);
      assert.equal(runtime.metrics.realProviderCalls, 0);
      assert.equal(runtime.metrics.unexpectedTurns, 0, "recovery must not invent a second diagnosis or repair turn");
      assert.equal(first.scriptedTurns, 2);
      assert.equal(recovered.scriptedTurns, 0, "a completed read-only task recovers from its durable result");
      const starts = runtime.rawEvents.filter(event => event.type === "tool_execution_start");
      assert.deepEqual(starts.map(event => [event.toolName, event.args.path]), [["read", "logs/incident.log"]]);
      const read = runtime.rawEvents.find(event => event.type === "tool_execution_end" && event.toolCallId === "incident-read-log");
      assert.ok(read && read.isError !== true, "the intended public log read must actually succeed");
      assert.ok(textContent(read.result?.content).includes(publicLog.trim()), "the actual tool output must contain the correlated public events");
      const finalContext = runtime.contexts.filter(context => context.turnId === "request").at(-1);
      assert.ok(finalContext?.messages.some(message => message.role === "toolResult"
        && message.toolCallId === "incident-read-log" && textContent(message.content).includes(incident.code)),
      "the scripted answer follows an observed log tool result in the real model context");

      assert.equal(transport.kind, "loopback-http-websocket");
      assert.equal(transport.unauthenticatedCatalogStatus, 401);
      assert.equal(transport.bootstrapCount, 1);
      assert.equal(transport.connections, 2);
      assert.equal(transport.reconnects, 1);
      assert.equal(transport.commandDispatches, 2);
      assert.equal(first.transport.connections, 1);
      assert.equal(first.transport.reconnects, 0);
      assert.equal(recovered.transport.connections, 2);
      assert.equal(recovered.transport.reconnects, 1);
      assert.equal(first.sessionId, recovered.sessionId);
      assert.equal(first.task?.taskRunId, recovered.task?.taskRunId);
      assert.notEqual(first.receipt.operationRef, recovered.receipt.operationRef);
      assert.notEqual(first.command.payload.messageRequestId, recovered.command.payload.messageRequestId);
      for (const [index, result] of results.entries()) {
        assert.equal(result.unconsumedScript, 0);
        assert.equal(result.command.payload.message, prepared.turns[index].message);
        assert.equal(result.wireSettlement.kind, "operation.settled");
        assert.ok(Number.isSafeInteger(result.wireSettlement.sequence) && result.wireSettlement.sequence > 0);
        assert.deepEqual(result.wireSettlement.payload, result.settlement);
        assert.equal(result.settlement.sessionRef, result.receipt.sessionRef);
        assert.equal(result.settlement.operationRef, result.receipt.operationRef);
        assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
        assert.ok(result.task, "the original incident must retain a governed durable task");
        assert.equal(result.task.sessionId, result.sessionId);
        assert.equal(result.task.operatorRequest, prepared.turns[0].message);
        assert.equal(result.task.changeMode, "read-only");
        assert.equal(result.task.mutationPolicy, "forbidden");
        assert.deepEqual(result.task.observedChangedFiles, []);
        assert.deepEqual(result.task.changedFiles, []);
        assert.equal(result.task.trace.outcome, "completed", "correct public-evidence diagnosis must really complete");
        assert.equal(result.settlement.taskStatus, "completed");
        assert.equal(result.settlement.settlement, "completed");
        assert.equal(result.settlement.reasonCode, null);
        assert.ok(result.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
      }
      const answers = recovered.entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant")
        .map(entry => textContent(entry.message.content)).filter(text => text.includes(marker));
      assert.deepEqual(answers, [answer], "recovery must retain exactly one grounded terminal answer, not duplicate it");
      assert.equal(answers[0].trim().split("\n").at(-1), marker);
      assert.equal(fs.readFileSync(publicPath, "utf8"), publicLog);
      assert.equal(projectStatus(prepared.workspace), beforeStatus, "the read-only journey cannot change project files");
    } finally { await runtime.close(); }
  });
});
