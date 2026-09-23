import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { loadProductionPublicWitnesses } from "./helpers/production-schedule-witnesses.mjs";
import { workspaceCoveredContracts } from "./helpers/workspace-public-coverage.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { benchmarkVerificationReceiptForTurn } from "../scripts/benchmark-independent-verification.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { writeHostContractApproval, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";

import { readHandoffProjection, taskAcceptanceDisposition, handoffProjectionValidationErrors } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { terminalUncertainSendReceipt } from "../packages/piagent-core/runtime/session/uncertain-send-continuation.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { timeout: 240000, skip: !imageId || !dockerSocket
  ? "requires pinned local worker; skipped execution is not configured-treatment qualification" : false };

for (const variant of ["correct", "same-class-wrong-message", "wrong-dependency-order", "unsupported-import"]) {
  test(`configured workspace request and durable recovery preserve product truth: ${variant}`, integration, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-configured-workspace-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "workspace-order");
    assert.equal(prepared.scenario.profile, "fullstack");
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["request", "recover"]);
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json")))).profile;
    const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
    const preview = benchmarkVerificationReceiptForTurn(prepared.turns[0], { profile, policy });
    const contracts = workspaceCoveredContracts(preview.criteria), backend = { imageId, dockerSocket, timeoutMs: 10000, profile: expectedNodeProfile() };
    const authority = path.join(root, "private-test-authority"); fs.mkdirSync(authority, { mode: 0o700 });
    const approval = writeHostContractApproval({ directory: path.join(authority, "chat"), projectRoot: prepared.workspace,
      installedRoot: repositoryRoot, approved: true, operatorRequestDigest: operatorRequestDigest(preview.query), backend, contracts });
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const source = variant === "same-class-wrong-message"
      ? reference.replace('new Error("dependency cycle")', 'new Error("invalid input")')
      : variant === "wrong-dependency-order" ? reference.replace("if (byName.has(dependency)) visit(dependency);", "if (byName.has(dependency)) continue;")
      : variant === "unsupported-import" ? 'import "node:fs";\n' + reference : reference;
    if (variant !== "correct") assert.notEqual(source, reference);
    const publicTests = ["same-class-wrong-message", "wrong-dependency-order"].includes(variant)
      ? "import assert from 'node:assert/strict';import test from 'node:test';import {workspaceOrder} from '../src/platform/workspace.js';test('public smoke',()=>assert.deepEqual(workspaceOrder([]),[]));\n"
      : loadProductionPublicWitnesses(repositoryRoot).get(prepared.scenario.id).tests;
    const testPath = "test/configured-workspace-public.test.js";
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length);
    const scripts = [
      [scriptedTool("workspace-configured-read", "read", { path: sourcePath }),
        scriptedTool("workspace-configured-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("workspace-configured-write-tests", "write", { path: testPath, content: publicTests }),
        ...commands.map((command, index) => scriptedTool(`workspace-configured-verify-${index}`, "bash", { command })),
        scriptedText("Implemented the requested workspace ordering and ran the configured checks. The requested work is complete.")],
      [scriptedTool("workspace-configured-review", "read", { path: sourcePath }),
        ...commands.map((command, index) => scriptedTool(`workspace-configured-review-verify-${index}`, "bash", { command })),
        scriptedTool("workspace-configured-diff", "bash", { command: `git diff --no-ext-diff -- ${sourcePath}` }),
        scriptedText("Rechecked the original request and current project verification. The requested work is complete.")]
    ];
    await withJourneyEnvironment({ ...prepared.environment, PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: approval.configPath }, async () => {
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir,
        repositoryRoot, transport: "loopback" });
      try {
        const first = await runtime.turn(prepared.turns[0], scripts[0], 180000);
        const replay = first.task?.trace.outcome === "completed";
        const handoffBefore = readHandoffProjection(prepared.workspace, first.task.taskRunId);
        t.diagnostic(JSON.stringify({ variant, stage: "before-recovery", terminalReceiptAvailable: Boolean(terminalUncertainSendReceipt(prepared.workspace, first.task)),
          handoffState: handoffBefore?.state, handoffAcceptance: handoffBefore?.acceptance, currentAcceptance: taskAcceptanceDisposition(first.task),
          handoffErrors: handoffBefore ? handoffProjectionValidationErrors(handoffBefore) : ["handoff-unavailable"] }));
        const recovered = await runtime.turn(prepared.turns[1], replay ? [] : scripts[1], 180000);
        t.diagnostic(JSON.stringify({ variant, treatment: "configured-host-verification-a-v2", first: first.task.trace.outcome,
          recovered: recovered.task.trace.outcome, replay, modelMessages: [first.scriptedTurns, recovered.scriptedTurns],
          transport: runtime.transport.snapshot(), criteria: recovered.task.acceptanceReceipt.criteria.map(x => [x.id, x.status]) }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0); assert.ok(runtime.metrics.unexpectedTurns <= 1);
        assert.equal(first.task.taskRunId, recovered.task.taskRunId); assert.equal(first.sessionId, recovered.sessionId);
        assert.equal(first.task.operatorRequestDigest, operatorRequestDigest(preview.query));
        assert.equal(recovered.receipt.phase, "settled"); assert.equal(recovered.recovery, null);
        const transport = runtime.transport.snapshot(); assert.equal(transport.commandDispatches, 2);
        assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0); assert.equal(transport.reconnects, 1);
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
          && /^workspace-configured-(?:review-)?verify-/.test(event.toolCallId));
        assert.equal(verifications.length, commands.length * (replay ? 1 : 2));
        assert.ok(verifications.every(event => event.isError === false), "wrong-message smoke checks remain green");
        const configuration = openHostContractConfiguration({ configPath: approval.configPath,
          projectRoot: prepared.workspace, installedRoot: repositoryRoot });
        try {
          assert.equal(configuration.isCurrent(), true);
          const observations = contracts.map(contract => {
            const event = configuration.store.latest({ taskRunId: first.task.taskRunId, criterionId: contract.criterionId });
            assert.equal(event?.phase, "settled"); assert.equal(event.binding.criterionHash, contract.criterionHash);
            const evidence = JSON.parse(event.evidenceText), execution = evidence.observed.result.execution;
            const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 2, profile: backend.profile,
              source, exportName: contract.exportName, checks: contract.checks }));
            assert.equal(compiled.planDigest, event.binding.planDigest); assert.equal(execution.cleanupConfirmed, true);
            const compared = compareIndependentExecution(compiled, execution); assert.equal(compared.verdict, evidence.verdict);
            return { criterion: contract.criterionId, verdict: compared.verdict,
              counterexamples: compared.counterexamples.map(x => ({ id: x.evidence.input.id, errorClass: x.evidence.observed.errorClass,
                errorMessage: x.evidence.observed.errorMessage })) };
          });
          t.diagnostic(JSON.stringify({ variant, actualWorkerObservations: observations,
            imageId, profile: backend.profile, verifierDigest: approval.verifierDigest, productionAuthority: false }));
          if (variant === "correct") {
            assert.ok(observations.every(x => x.verdict === "pass"));
            assert.equal(first.task.trace.outcome, "completed"); assert.equal(recovered.task.trace.outcome, "completed");
            assert.equal(recovered.scriptedTurns, 0); assert.equal(recovered.settlement.settlement, "completed");
            assert.deepEqual(recovered.task.verifyEvidence, first.task.verifyEvidence);
          } else {
            assert.notEqual(first.task.trace.outcome, "completed"); assert.notEqual(recovered.task.trace.outcome, "completed");
            const handoff = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-state/handoffs", `${recovered.task.taskRunId}.json`)));
            assert.equal(handoff.state.completionApproved, false); assert.equal(handoff.nextSafeAction.action, "handoff");
            if (variant === "same-class-wrong-message") assert.ok(observations.some(x => x.verdict === "fail"
              && x.counterexamples.some(c => c.id.endsWith("cycle") && c.errorClass === "Error" && c.errorMessage === "invalid input")));
            else if (variant === "wrong-dependency-order") assert.ok(observations.some(x => x.verdict === "fail"));
            else assert.ok(observations.every(x => x.verdict !== "pass"));
          }
        } finally { configuration.close(); }
      } finally { await runtime.close(); }
    });
  });
}
