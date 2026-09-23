import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");
// Finite public-request witnesses only. Neither generated hidden oracle nor
// registered measurement authority is delivered to the scripted model.
const paginationTests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { pageCount, clampPage } from '../src/frontend/pagination.js';
test('public pagination contract', () => {
  assert.equal(pageCount(0, 5), 0);
  assert.equal(pageCount(10, 5), 2);
  assert.equal(pageCount(11, 5), 3);
  assert.equal(pageCount(2 ** 53, 1), 2 ** 53);
  assert.equal(pageCount(1, 2 ** 53), 1);
  assert.equal(pageCount(2 ** 54, 3), 6004799503160661);
  assert.equal(pageCount(2 ** 55, 3), 12009599006321322);
  assert.equal(clampPage(2 ** 54, 2 ** 54, 3), 6004799503160661);
  assert.equal(clampPage(2 ** 55, 2 ** 55, 3), 12009599006321322);
  assert.equal(clampPage(-4, 0, 5), 0);
  assert.equal(clampPage(-4, 10, 5), 1);
  assert.equal(clampPage(0, 10, 5), 1);
  assert.equal(clampPage(1, 10, 5), 1);
  assert.equal(clampPage(2, 15, 5), 2);
  assert.equal(clampPage(2, 10, 5), 2);
  assert.equal(clampPage(3, 10, 5), 2);
  assert.equal(clampPage(9, 10, 5), 2);
  assert.equal(clampPage(2 ** 53, 10, 5), 2);
  assert.equal(clampPage(-(2 ** 53), 10, 5), 1);
  assert.throws(() => pageCount(-1, 5), TypeError);
  assert.throws(() => pageCount(1.5, 5), TypeError);
  assert.throws(() => pageCount('10', 5), TypeError);
  assert.throws(() => pageCount(10, 0), TypeError);
  assert.throws(() => pageCount(0, 0), TypeError);
  assert.throws(() => pageCount(10, -1), TypeError);
  assert.throws(() => pageCount(10, 1.5), TypeError);
  assert.throws(() => pageCount(10, '5'), TypeError);
  assert.throws(() => clampPage(1.2, 10, 5), TypeError);
  assert.throws(() => clampPage('1', 10, 5), TypeError);
  assert.throws(() => clampPage(1.2, 0, 5), TypeError);
  for (const value of [undefined, null, true, {}, [], NaN, Infinity, -Infinity]) {
    assert.throws(() => pageCount(value, 5), TypeError);
    assert.throws(() => pageCount(10, value), TypeError);
    assert.throws(() => clampPage(value, 10, 5), TypeError);
  }
});
`;

for (const variant of ["reference", "missing-lower-clamp"]) {
  test(`actual default source journey: pagination/${variant}`, { timeout: 120000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-default-source-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "pagination-boundary");
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const source = variant === "reference" ? reference : reference.replace("Math.max(1, Math.min(page, count))", "Math.min(page, count)");
    if (variant !== "reference") assert.notEqual(source, reference);
    const command = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands[0];
    assert.ok(command);
    assert.equal(prepared.scenario.profile, "web-frontend");
    assert.equal(prepared.turns.length, 1);
    assert.equal(prepared.scenario.lifecycle, "steady-state");
    const turn = prepared.turns[0], declared = prepared.scenario.userJourney.turns[0];
    assert.equal(turn.id, "request");
    assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
    assert.equal(turn.workflow, undefined); assert.equal(turn.reconnectBefore, false);
    assert.equal(turn.receiptUncertain, false); assert.equal(turn.abortAfterMs, undefined);
    const projectSettings = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/settings.json"), "utf8"));
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const script = [scriptedTool("read-source", "read", { path: sourcePath }),
          scriptedTool("write-source", "write", { path: sourcePath, content: source }),
          scriptedTool("write-public-tests", "write", { path: "test/pagination-public.test.js", content: paginationTests }),
          scriptedTool("verify", "bash", { command }),
          scriptedText(variant === "reference" ? "Implemented the requested pagination behavior and verified the project. The work is complete."
            : "The project verification failed. The requested work remains incomplete; no successful completion is claimed.")];
        const result = await runtime.turn(prepared.turns[0], script);
        const snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace), transport = runtime.transport.snapshot();
        const rejectionCriterion = result.task?.acceptanceReceipt?.criteria.find(item => item.obligation === "invalid-input-rejection");
        const criterionIndex = result.task?.acceptanceReceipt?.criteria.indexOf(rejectionCriterion);
        const rejectionProof = acceptanceInvalidInputEvidence({ taskText: result.task?.acceptanceCriteria?.[criterionIndex],
          sourceText: source, testText: paginationTests, namedTargets: ["pageCount"], provenanceTargets: [], includeDiagnostics: true,
          sourceEntries: [{ path: sourcePath, text: source }], testEntries: [{ path: "test/pagination-public.test.js", text: paginationTests }] });
        t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, turn: turn.id, profile: prepared.scenario.profile,
          lifecycle: prepared.scenario.lifecycle, declaredTurns: prepared.turns.length, observedTurns: 1,
          promptSha256: digest(turn.message), expectedSourceSha256: digest(source), expectedTestSha256: digest(paginationTests),
          sourceSha256: digest(fs.readFileSync(path.join(prepared.workspace, sourcePath))),
          testSha256: digest(fs.readFileSync(path.join(prepared.workspace, "test/pagination-public.test.js"))),
          projectResources: runtime.projectResources, receipt: result.receipt, recovery: result.recovery,
          sessionRef: result.sessionRef, operationRef: result.operationRef, settlement: result.settlement,
          wireSettlement: result.wireSettlement, transport,
          task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
            outcome: result.task.trace.outcome, acceptanceCriteria: result.task.acceptanceCriteria,
            verifyEvidence: result.task.verifyEvidence, criteria: result.task.acceptanceReceipt?.criteria },
          currentVerifier: result.task && allConfiguredVerifierEvidenceCurrent(result.task, snapshot.digest, snapshot.workspaceRevisionDigest),
          rejectionProof, scriptedTurns: result.scriptedTurns, unexpectedTurns: runtime.metrics.unexpectedTurns }));
        assert.deepEqual(runtime.extensionErrors, []);
        assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(transport.kind, "loopback-http-websocket"); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1); assert.equal(transport.commandDispatches, 1);
        assert.equal(transport.connections, 1); assert.equal(transport.reconnects, 0);
        assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        assert.ok(runtime.projectResources.length > 0);
        for (const resources of runtime.projectResources) {
          assert.deepEqual(resources.packages, projectSettings.packages);
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-core/extensions/piagent-guard.ts")));
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts")));
        }
        assert.equal(result.command.payload.message, turn.message); assert.equal(result.command.payload.workflow, turn.workflow);
        assert.equal(result.recovery, null); assert.equal(result.receipt.sessionRef, result.sessionRef);
        assert.equal(result.receipt.operationRef, result.operationRef);
        assert.equal(result.wireSettlement.kind, "operation.settled"); assert.deepEqual(result.wireSettlement.payload, result.settlement);
        assert.equal(result.settlement.sessionRef, result.sessionRef); assert.equal(result.settlement.operationRef, result.operationRef);
        assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
        assert.equal(result.task.sessionId, result.sessionId); assert.equal(result.task.operatorRequest, turn.message);
        assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(result.unconsumedScript, 0);
        assert.ok(runtime.metrics.unexpectedTurns <= 1, "a real failure still has only the existing bounded recovery opportunity");
        const verification = runtime.rawEvents.find(item => item.type === "tool_execution_end" && item.toolCallId === "verify");
        assert.ok(verification, "the configured verifier must really execute");
        const output = verification.result.content.map(item => item.text ?? "").join("\n");
        t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, verification: { command, isError: verification.isError, output } }));
        assert.doesNotMatch(output, /skipping running files|being called recursively|reused exact verifier evidence/);
        assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
        assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
        assert.ok(result.task);
        if (variant === "reference") {
          assert.equal(verification.isError, false, output);
          assert.ok(allConfiguredVerifierEvidenceCurrent(result.task, snapshot.digest, snapshot.workspaceRevisionDigest));
          assert.equal(rejectionProof.integerDomainProof?.rejectionEstablished, true, "the declared per-argument rejection is independently established");
          assert.equal(rejectionProof.testOk, true, "the configured verifier really executed isolated argument witnesses");
          assert.equal(runtime.metrics.unexpectedTurns, 0, "a completed verifier plus unestablished source proof does not warrant another model diagnosis");
          assert.equal(result.task.trace.outcome, "completed", "a sufficiently evidenced correct default task must complete");
          assert.equal(result.settlement.settlement, "completed");
          assert.ok(result.task.acceptanceReceipt.criteria.every(item => item.status === "satisfied"));
        } else {
          assert.equal(verification.isError, true, output);
          assert.match(output, /-4 !== 1|Expected values to be strictly equal/);
          assert.notEqual(result.task.trace.outcome, "completed");
          assert.equal(result.settlement.taskStatus, "pending");
          assert.equal(result.settlement.settlement, "completed",
            "an honest incomplete answer can finish its operation without completing the task");
        }
      } finally { await runtime.close(); }
    });
  });
}
