import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("the actual fullstack workflow journey retains ordinary command, task and settlement boundaries offline", { timeout: 180000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-journey-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "workflow-switch-same-session");
  assert.equal(prepared.scenario.profile, "fullstack");
  const profile = resolveProjectProfileDocument(repositoryRoot,
    JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
  assert.deepEqual(prepared.turns.map(({ id, workflow }) => [id, workflow]),
    [["scout", "scout"], ["implement", "platform-improve"], ["verify", "review"]]);
  const [sourcePath, source] = productionV3ReferenceSolution(prepared.scenario.id);
  const testPath = "test/workflow-public.test.js";
  const command = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands[0];
  assert.ok(command);
  const testSource = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n"
    + "import { initialWorkflowSession, reduceWorkflowSession } from '../src/platform/workflow-session.js';\n"
    + "test('public workflow smoke', () => {\n"
    + "assert.deepEqual(initialWorkflowSession, { currentWorkflow: null, messages: [] });\n"
    + "assert.deepEqual(reduceWorkflowSession(undefined, { type: 'workflow/select', workflow: 'task' }), { currentWorkflow: 'task', messages: [] });\n});\n";
  const scripts = [
    [scriptedTool("scout-read-source", "read", { path: sourcePath }), scriptedTool("scout-read-package", "read", { path: "package.json" }),
      scriptedText("Inspected src/platform/workflow-session.js and package.json. The reducer needs validation before duplicate handling and immutable workflow switching. The configured project verification should be rerun after the scoped change. No files were changed.")],
    [scriptedTool("implement-read-source", "read", { path: sourcePath }),
      scriptedTool("implement-write-source", "write", { path: sourcePath, content: source }),
      scriptedTool("implement-write-test", "write", { path: testPath, content: testSource }),
      scriptedTool("implement-verify", "bash", { command }),
      scriptedText("Implemented the requested reducer and ran configured verification successfully. The implementation work is complete.")],
    [scriptedTool("review-read-source", "read", { path: sourcePath }), scriptedTool("review-read-test", "read", { path: testPath }),
      scriptedTool("review-verify", "bash", { command }),
      scriptedText("Reviewed the current reducer and verification results. No additional file changes were made. Any missing independent acceptance proof remains unverified.")]
  ];
  const results = await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot });
    try {
      const turns = [];
      for (const [index, turn] of prepared.turns.entries()) {
        const result = await runtime.turn(turn, scripts[index]);
        result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
        turns.push(result);
        t.diagnostic(JSON.stringify({ turn: turn.id, settlement: result.settlement, task: result.task && {
          id: result.task.taskRunId, outcome: result.task.trace.outcome, changeMode: result.task.changeMode,
          criteria: result.task.acceptanceReceipt?.criteria.map(item => ({ id: item.id, status: item.status })) },
          scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript }));
      }
      assert.deepEqual(runtime.extensionErrors, []);
      assert.equal(runtime.metrics.realProviderCalls, 0);
      assert.equal(runtime.metrics.unexpectedTurns, 0, "missing proof cannot trigger another model turn");
      const verifications = runtime.rawEvents.filter(item => item.type === "tool_execution_end" && /verify$/.test(item.toolCallId));
      assert.deepEqual(verifications.map(item => item.toolCallId), ["implement-verify", "review-verify"]);
      for (const event of verifications) {
        const output = event.result?.content?.map(item => item.text ?? "").join("\n") ?? "";
        assert.doesNotMatch(output, /skipping running files|being called recursively/);
        assert.equal(event.isError, false, output);
        if (event.toolCallId === "implement-verify") {
          assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/, "the first configured verifier must really execute tests");
          assert.match(output, /(?:#|ℹ)\s+skipped 0\b/, "the actual project tests must not be skipped");
        } else {
          const implementation = turns[1], review = turns[2], snapshot = review.verificationSnapshot;
          assert.equal(snapshot.proofCapable, true);
          assert.equal(snapshot.digest, implementation.verificationSnapshot.digest);
          assert.equal(snapshot.workspaceRevisionDigest, implementation.verificationSnapshot.workspaceRevisionDigest);
          const original = implementation.task.verifyEvidence.filter(item => item.command === command);
          assert.ok(original.length > 0);
          assert.ok(original.some(item => verificationEvidenceProvesStableTree(item, snapshot.digest, snapshot.workspaceRevisionDigest)));
          const reviewed = review.task.verifyEvidence.filter(item => item.command === command);
          const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
          if (policy.finalGate.acceptanceProofMode === "diagnostic") {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/, "diagnostic review must run current project verification");
            assert.ok(reviewed.some(item => verificationEvidenceProvesStableTree(item, snapshot.digest, snapshot.workspaceRevisionDigest)));
          } else {
            assert.match(output, /reused exact verifier evidence for the unchanged working tree/);
            assert.deepEqual(reviewed, original,
              "reuse must retain the actual prior observation, not manufacture another verifier run");
          }
        }
      }
      return turns;
    } finally { await runtime.close(); }
  });
  assert.equal(new Set(results.map(item => item.sessionId)).size, 1, "one persisted session, not three fresh tasks in different sessions");
  assert.equal(new Set(results.map(item => item.receipt.operationRef)).size, 3);
  assert.ok(results.every(item => item.settlement.settlement !== "unknown"), "the real catalog must support known settlements");
  assert.ok(results.every((item, index) => item.unconsumedScript === 0 && item.scriptedTurns === scripts[index].length));
  assert.equal(results[0].task?.changeMode, "read-only");
  assert.equal(results[0].task?.trace.outcome, "completed", "scout must really finish before the source operation");
  assert.equal(results[1].task?.changeMode, "source-change");
  assert.notEqual(results[1].task?.taskRunId, results[0].task?.taskRunId);
  // The source's incomplete proof stays pending even when diagnostic policy
  // permits an operational completion and a separate review task follows.
  assert.ok(results[1].task?.acceptanceReceipt.criteria.some(item => item.status === "pending"));
  const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
  if (policy.finalGate.acceptanceProofMode === "diagnostic") {
    assert.equal(results[1].task?.trace.outcome, "completed");
    assert.notEqual(results[2].task?.taskRunId, results[1].task?.taskRunId);
    assert.equal(results[2].task?.trace.outcome, "completed");
    assert.deepEqual(results.slice(1).map(item => item.settlement.reasonCode), [null, null]);
  } else {
    assert.equal(results[1].task?.trace.outcome, "pending");
    assert.equal(results[2].task?.taskRunId, results[1].task?.taskRunId, "review cannot silently replace an unresolved implementation task");
    assert.equal(results[2].task?.trace.outcome, "pending");
    assert.deepEqual(results.slice(1).map(item => item.settlement.reasonCode), ["completion-gate-not-approved", "completion-gate-not-approved"]);
  }
  assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
});
