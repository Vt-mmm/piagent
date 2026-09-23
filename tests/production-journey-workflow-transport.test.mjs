import { assertJourneyAcceptance } from "./helpers/production-journey-acceptance-mode.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution, productionV3PlausibleMutant } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { buildWorkflowFollowUp } from "../packages/piagent-core/runtime/workflows/workflow-follow-up.ts";
import { selectVerificationPlan, allConfiguredVerifierEvidenceCurrent, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const contentText = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
// Public, finite executable witnesses; no oracle, registered recipe or
// independently signed verification plan enters this scripted journey.
const publicTests = String.raw`import assert from 'node:assert/strict';
import test from 'node:test';
import { initialWorkflowSession, reduceWorkflowSession as reduce } from '../src/platform/workflow-session.js';
const select = workflow => ({ type: 'workflow/select', workflow });
const message = (id, text, fields = {}) => ({ type: 'message/accepted', id, text, ...fields });
test('undefined state uses the exported initial state and workflow selection can change repeatedly', () => {
  assert.deepEqual(initialWorkflowSession, { currentWorkflow: null, messages: [] });
  const first = reduce(undefined, select('task'));
  assert.deepEqual(first, { currentWorkflow: 'task', messages: [] });
  const withMessage = reduce(first, message('one', 'first task'));
  const switched = reduce(withMessage, select('review'));
  assert.equal(switched.currentWorkflow, 'review'); assert.strictEqual(switched.messages, withMessage.messages);
  assert.equal(reduce(switched, select('scout')).currentWorkflow, 'scout');
  assert.equal(withMessage.currentWorkflow, 'task');
});
test('accepted messages retain order and the workflow active for each message', () => {
  let state = reduce(undefined, select('task'));
  state = reduce(state, message('one', 'task work'));
  state = reduce(state, select('review'));
  state = reduce(state, message('two', 'review work'));
  assert.deepEqual(state, { currentWorkflow: 'review', messages: [
    { id: 'one', text: 'task work', workflow: 'task' }, { id: 'two', text: 'review work', workflow: 'review' }
  ] });
});
test('valid own workflow override selects the workflow for this and future messages', () => {
  const first = reduce({ currentWorkflow: null, messages: [] }, message('one', 'override work', { workflow: 'scout' }));
  const next = reduce(first, message('two', 'followup'));
  assert.deepEqual(next, { currentWorkflow: 'scout', messages: [
    { id: 'one', text: 'override work', workflow: 'scout' }, { id: 'two', text: 'followup', workflow: 'scout' }
  ] });
});
test('duplicate id is an exact no-op after required fields and supplied override validate', () => {
  const state = reduce(reduce(undefined, select('task')), message('one', 'original'));
  assert.strictEqual(reduce(state, message('one', 'different valid text', { workflow: 'review' })), state);
  const noActive = { ...state, currentWorkflow: null };
  assert.strictEqual(reduce(noActive, message('one', 'still a duplicate')), noActive);
  for (const fields of [{ id: '' }, { text: '' }, { workflow: undefined }, { workflow: null }]) {
    assert.throws(() => reduce(state, { ...message('one', 'duplicate'), ...fields }), TypeError);
  }
});
test('own undefined null and other malformed overrides throw before duplicate handling', () => {
  const state = reduce(reduce(undefined, select('task')), message('one', 'original'));
  for (const workflow of [undefined, null, '', 0, false, {}, []]) for (const id of ['one', 'new']) {
    assert.throws(() => reduce(state, message(id, 'valid text', { workflow })), TypeError);
  }
});
test('inherited workflow is not supplied and absent override requires an active workflow only for new ids', () => {
  const state = { currentWorkflow: 'task', messages: [] };
  const inherited = Object.assign(Object.create({ workflow: 'review' }), message('one', 'inherited override is absent'));
  assert.equal(reduce(state, inherited).messages[0].workflow, 'task');
  for (const currentWorkflow of [null, undefined, '', 0, false, {}, []]) {
    assert.throws(() => reduce({ currentWorkflow, messages: [] }, message('new', 'valid text')), TypeError);
  }
});
test('every malformed required field on both named event variants throws TypeError', () => {
  const state = { currentWorkflow: 'task', messages: [] };
  for (const invalid of [undefined, null, '', 0, false, {}, []]) {
    assert.throws(() => reduce(state, select(invalid)), TypeError);
    assert.throws(() => reduce(state, message(invalid, 'valid')), TypeError);
    assert.throws(() => reduce(state, message('valid', invalid)), TypeError);
  }
});
test('selection and append do not mutate state messages or events', () => {
  const first = Object.freeze({ id: 'one', text: 'first', workflow: 'task' });
  const state = Object.freeze({ currentWorkflow: 'task', messages: Object.freeze([first]) });
  const event = Object.freeze(message('two', 'second', { workflow: 'review' }));
  const before = structuredClone([state, event]);
  const selected = reduce(state, Object.freeze(select('scout'))), appended = reduce(state, event);
  assert.deepEqual([state, event], before); assert.strictEqual(selected.messages, state.messages);
  assert.notStrictEqual(appended.messages, state.messages); assert.equal(appended.messages.length, 2);
  assert.deepEqual(appended.messages[1], { id: 'two', text: 'second', workflow: 'review' });
});
`;

for (const variant of ["reference", "own-override-mutant"]) {
  test(`actual fullstack workflow switch through generated-package HTTP/WebSocket: ${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-workflow-wire-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "workflow-switch-same-session");
    assert.equal(prepared.scenario.profile, "fullstack"); assert.equal(prepared.scenario.lifecycle, "steady-state");
    assert.deepEqual(prepared.turns.map(turn => [turn.id, turn.workflow]), [["scout", "scout"], ["implement", "platform-improve"], ["verify", "review"]]);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.reconnectBefore, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain, declared.receiptUncertain === true);
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const [mutantPath, mutant] = productionV3PlausibleMutant(prepared.scenario.id);
    assert.equal(mutantPath, sourcePath); assert.notEqual(mutant, reference);
    const source = variant === "reference" ? reference : mutant, testPath = "test/workflow-contract-public.test.js";
    const initial = captureWorkspaceVerificationSnapshot(prepared.workspace);
    const packageHash = sha(fs.readFileSync(path.join(prepared.workspace, "package.json")));
    const settings = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/settings.json"), "utf8"));
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const response = variant === "reference" ? "Implemented the public workflow contract and ran the checks. Preserve any original obligation still lacking sufficient evidence; no independent approval is claimed."
      : "The public verifier detects malformed supplied-override handling. The implementation remains wrong and incomplete; no repair or successful completion is claimed.";
    const scripts = [
      [scriptedTool("workflow-scout-source", "read", { path: sourcePath }), scriptedTool("workflow-scout-package", "read", { path: "package.json" }),
        scriptedText("The reducer must preserve prior messages across workflow changes and attribute each accepted message to its active or explicitly overridden workflow. Validate required fields and every own override before duplicate handling; duplicates must return the exact state, while new messages need a valid workflow. Add focused ordering, validation, ownership and immutability witnesses, then run configured checks. No files were changed.")],
      [scriptedTool("workflow-implement-source", "read", { path: sourcePath }),
        scriptedTool("workflow-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("workflow-write-tests", "write", { path: testPath, content: publicTests }),
        ...commands.map((command, index) => scriptedTool(`workflow-implement-verify-${index}`, "bash", { command })), scriptedText(response)],
      [scriptedTool("workflow-review-source", "read", { path: sourcePath }), scriptedTool("workflow-review-tests", "read", { path: testPath }),
        scriptedTool("workflow-review-focused", "bash", { command: `node --test ${testPath}` }),
        ...commands.map((command, index) => scriptedTool(`workflow-review-verify-${index}`, "bash", { command })),
        scriptedTool("workflow-review-diff", "bash", { command: `git diff -- ${sourcePath} ${testPath}` }), scriptedText(response)]
    ];
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const result = await runtime.turn(turn, scripts[index]);
          result.snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace); results.push(result);
          const checks = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
            && new RegExp(`^workflow-${index === 1 ? "implement" : index === 2 ? "review" : "scout"}-(?:verify-|focused$)`).test(event.toolCallId));
          t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, turn: turn.id, workflow: turn.workflow,
            promptSha256: sha(turn.message), expectedSourceSha256: sha(source), expectedTestSha256: sha(publicTests),
            sourceSha256: sha(fs.readFileSync(path.join(prepared.workspace, sourcePath))),
            receipt: result.receipt, settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
              outcome: result.task.trace.outcome, diagnosticNotes: result.task.trace.notes, changeMode: result.task.changeMode, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerifier: result.task && allConfiguredVerifierEvidenceCurrent(result.task, result.snapshot.digest, result.snapshot.workspaceRevisionDigest),
            scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript,
            verifications: checks.map(event => ({ id: event.toolCallId, isError: event.isError, output: contentText(event.result?.content) })),
            metrics: runtime.metrics, projectResources: runtime.projectResources }));
        }
        const [scout, implementation, last] = results, transport = runtime.transport.snapshot();
        const checks = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^workflow-(?:implement|review)-(?:verify-|focused$)/.test(event.toolCallId));
        t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, declaredTurns: 3, observedTurns: results.length,
          transport, metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0); assert.ok(runtime.metrics.unexpectedTurns <= 1);
        assert.equal(transport.commandDispatches, 3); assert.equal(transport.connections, 1); assert.equal(transport.reconnects, 0);
        assert.equal(transport.unauthenticatedCatalogStatus, 401); assert.equal(transport.uncertainSends, 0);
        assert.ok(runtime.projectResources.length > 0);
        for (const resources of runtime.projectResources) {
          assert.deepEqual(resources.packages, settings.packages);
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts")));
        }
        assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
        assert.equal(new Set(results.map(result => result.operationRef)).size, 3);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0); assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, prepared.turns[index].workflow);
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
        }
        assert.equal(scout.task.changeMode, "read-only"); assert.equal(scout.task.trace.outcome, "completed");
        assert.equal(scout.snapshot.digest, initial.digest); assert.notEqual(scout.task.taskRunId, implementation.task.taskRunId);
        assert.equal(implementation.task.operatorRequest, buildWorkflowFollowUp("platform-improve", prepared.turns[1].message));
        if (implementation.task.trace.outcome !== "completed") assert.equal(last.task.taskRunId, implementation.task.taskRunId);
        assert.equal(last.snapshot.digest, implementation.snapshot.digest);
        assert.equal(last.snapshot.workspaceRevisionDigest, implementation.snapshot.workspaceRevisionDigest);
        assert.equal(last.scriptedTurns, scripts[2].length, "review cannot add another diagnostic or duplicate source work");
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), publicTests);
        assert.equal(sha(fs.readFileSync(path.join(prepared.workspace, "package.json"))), packageHash);
        assert.deepEqual(checks.map(event => event.toolCallId), [...commands.map((_, index) => `workflow-implement-verify-${index}`),
          "workflow-review-focused", ...commands.map((_, index) => `workflow-review-verify-${index}`)]);
        for (const event of checks) {
          const output = contentText(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.match(event.toolCallId, /^workflow-review-verify-/);
            assert.ok(implementation.task.verifyEvidence.some(evidence => verificationEvidenceProvesStableTree(evidence,
              last.snapshot.digest, last.snapshot.workspaceRevisionDigest)));
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/); assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        if (variant === "reference") {
          assert.ok(checks.every(event => event.isError === false));
          assert.ok(allConfiguredVerifierEvidenceCurrent(last.task, last.snapshot.digest, last.snapshot.workspaceRevisionDigest));
          assert.equal(last.task.trace.outcome, "completed", "the correct workflow implementation must complete after its declared verify turn");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          assertJourneyAcceptance(repositoryRoot, last.task, implementation.task);
        } else {
          const failures = checks.filter(event => event.isError === true);
          assert.ok(failures.length > 0); assert.match(failures.map(event => contentText(event.result?.content)).join("\n"), /ERR_ASSERTION/);
          assert.ok(results.slice(1).every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        }
      } finally { await runtime.close(); }
    });
  });
}
