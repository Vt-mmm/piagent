import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
// Every witness follows the public migration request. No seeded oracle, private
// grader, registered recipe or synthetic acceptance authority enters the task.
const publicTests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateSettings } from '../src/data/migration.js';
test('v1 fields preserve falsey values and use only nullish defaults', () => {
  assert.deepEqual(migrateSettings({ version: 1, enabled: false, retries: 0, name: '' }),
    { version: 2, enabled: false, retryLimit: 0, label: '' });
  assert.deepEqual(migrateSettings({ version: 1, enabled: true, retries: 4, name: 'saved' }),
    { version: 2, enabled: true, retryLimit: 4, label: 'saved' });
  assert.deepEqual(migrateSettings({}), { version: 2, enabled: true, retryLimit: 3, label: 'default' });
  assert.deepEqual(migrateSettings(), { version: 2, enabled: true, retryLimit: 3, label: 'default' });
  assert.deepEqual(migrateSettings({ enabled: null, retries: null, name: null }),
    { version: 2, enabled: true, retryLimit: 3, label: 'default' });
  assert.deepEqual(migrateSettings({ enabled: undefined, retries: undefined, name: undefined }),
    { version: 2, enabled: true, retryLimit: 3, label: 'default' });
  assert.deepEqual(migrateSettings({ enabled: false, retries: null, name: '' }),
    { version: 2, enabled: false, retryLimit: 3, label: '' });
  assert.deepEqual(migrateSettings({ enabled: null, retries: 0, name: 'saved' }),
    { version: 2, enabled: true, retryLimit: 0, label: 'saved' });
});
test('v1 migration does not mutate its input', () => {
  const input = { version: 1, enabled: false, retries: 0, name: '' };
  const before = { ...input };
  const result = migrateSettings(input);
  assert.deepEqual(input, before);
  assert.notStrictEqual(result, input);
  assert.deepEqual(result, { version: 2, enabled: false, retryLimit: 0, label: '' });
});
test('v2 migration returns an independent copy without changing the original', () => {
  const input = { version: 2, enabled: false, retryLimit: 0, label: '', custom: 'kept' };
  const before = { ...input };
  const result = migrateSettings(input);
  assert.deepEqual(result, before);
  assert.notStrictEqual(result, input);
  result.label = 'changed copy';
  assert.deepEqual(input, before);
  assert.equal(input.label, '');
});
`;

for (const variant of ["reference", "falsey-default-mutant"]) {
  test(`actual schema migration source journey through loopback HTTP/WebSocket: ${variant}`, { timeout: 120000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-schema-transport-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "schema-migration");
    assert.equal(prepared.scenario.profile, "node-typescript");
    assert.equal(prepared.scenario.lifecycle, "steady-state");
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["request"]);
    const turn = prepared.turns[0];
    assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot,
      prepared.scenario.userJourney.turns[0].prompt), "utf8").trim());
    assert.equal(Object.hasOwn(turn, "workflow"), false);
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const source = variant === "reference" ? reference : reference.replace("input.enabled ?? true", "input.enabled || true");
    if (variant !== "reference") assert.notEqual(source, reference);
    const testPath = "test/migration-public.test.js";
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
        agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const script = [scriptedTool("schema-read-source", "read", { path: sourcePath }),
          scriptedTool("schema-write-source", "write", { path: sourcePath, content: source }),
          scriptedTool("schema-write-tests", "write", { path: testPath, content: publicTests }),
          ...commands.map((command, index) => scriptedTool(`schema-verify-${index}`, "bash", { command })),
          scriptedText(variant === "reference"
            ? "Implemented the requested settings migration, preserved falsey values and independent copies, and verified the project. The work is complete."
            : "The configured project verification failed on falsey-value preservation. The requested migration is incomplete; no successful completion is claimed.")];
        const result = await runtime.turn(turn, script);
        const snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^schema-verify-/.test(event.toolCallId));
        const currentVerification = Boolean(result.task && allConfiguredVerifierEvidenceCurrent(result.task, snapshot.digest, snapshot.workspaceRevisionDigest));
        t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant,
          promptSha256: createHash("sha256").update(turn.message).digest("hex"),
          sourceSha256: createHash("sha256").update(source).digest("hex"),
          testSha256: createHash("sha256").update(publicTests).digest("hex"),
          settlement: result.settlement, wireSettlement: result.wireSettlement, transport: runtime.transport.snapshot(),
          task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId,
            outcome: result.task.trace.outcome, changeMode: result.task.changeMode, verifyCommands: result.task.verifyCommands,
            verifyEvidence: result.task.verifyEvidence, acceptanceCriteria: result.task.acceptanceCriteria,
            criteria: result.task.acceptanceReceipt?.criteria }, currentVerification,
          verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: textContent(event.result?.content) })),
          scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript, metrics: runtime.metrics,
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));

        assert.deepEqual(runtime.extensionErrors, []);
        assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(result.unconsumedScript, 0);
        assert.ok(runtime.metrics.unexpectedTurns <= 1, "no unbounded model loop may replace the real verifier outcome");
        const transport = runtime.transport.snapshot();
        assert.equal(transport.kind, "loopback-http-websocket");
        assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1);
        assert.equal(transport.connections, 1);
        assert.equal(transport.reconnects, 0);
        assert.equal(transport.commandDispatches, 1);
        assert.equal(result.wireSettlement.kind, "operation.settled");
        assert.deepEqual(result.wireSettlement.payload, result.settlement);
        assert.equal(result.settlement.sessionRef, result.receipt.sessionRef);
        assert.equal(result.settlement.operationRef, result.receipt.operationRef);
        assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
        assert.equal(result.command.payload.message, turn.message);
        assert.ok(result.task, "a source journey must create a durable governed task");
        assert.equal(result.task.sessionId, result.sessionId);
        assert.equal(result.task.operatorRequest, turn.message);
        assert.equal(result.task.changeMode, "source-change");
        assert.deepEqual(verifications.map(event => event.toolCallId), commands.map((_, index) => `schema-verify-${index}`));
        for (const event of verifications) {
          const output = textContent(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively|reused exact verifier evidence/);
          assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
          assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), publicTests);
        if (variant === "reference") {
          assert.ok(verifications.every(event => event.isError === false), "the actual configured verifier must pass");
          assert.equal(currentVerification, true, "every configured verification result must remain bound to the final tree and revision");
          assert.equal(result.task.trace.outcome, "completed", "a sufficiently evidenced correct default source task must complete");
          assert.equal(result.settlement.taskStatus, "completed");
          assert.equal(result.settlement.settlement, "completed");
          assert.equal(result.settlement.reasonCode, null);
          assert.ok(result.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
          assert.equal(runtime.metrics.unexpectedTurns, 0);
        } else {
          const failed = verifications.filter(event => event.isError === true);
          assert.ok(failed.length > 0, "the mutant must be rejected by an actually failed verifier");
          const failureOutput = failed.map(event => textContent(event.result?.content)).join("\n");
          assert.match(failureOutput, /ERR_ASSERTION|Expected values to be strictly deep-equal/);
          assert.match(failureOutput, /enabled: true/);
          assert.match(failureOutput, /enabled: false/);
          assert.equal(currentVerification, false);
          assert.notEqual(result.task.trace.outcome, "completed");
          assert.notEqual(result.settlement.taskStatus, "completed");
          assert.equal(result.settlement.settlement, "completed", "an honest incomplete answer may settle its operation without completing the task");
        }
      } finally { await runtime.close(); }
    });
  });
}
