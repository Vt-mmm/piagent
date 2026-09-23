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
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const contentText = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
// Executable finite witnesses from the public request and existing reducer API.
// These are not an independent approval or a claim of universal proof.
const publicTests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { initialSearchState, searchReducer } from '../src/frontend/search-state.js';
test('stale success and failure return the exact existing state unchanged', () => {
  for (const loading of [true, false]) for (const type of ['search/success', 'search/failure']) {
    const state = Object.freeze({ requestId: 'new', loading, results: Object.freeze(['prior']) });
    const action = Object.freeze({ type, requestId: 'old', results: Object.freeze(['stale']) });
    const before = structuredClone([state, action]);
    assert.strictEqual(searchReducer(state, action), state);
    assert.deepEqual([state, action], before);
  }
});
test('two overlapping requests retain current state when older work settles', () => {
  const first = searchReducer(initialSearchState, { type: 'search/start', requestId: 'first' });
  const second = searchReducer(first, { type: 'search/start', requestId: 'second' });
  assert.strictEqual(searchReducer(second, { type: 'search/success', requestId: 'first', results: ['old'] }), second);
  assert.strictEqual(searchReducer(second, { type: 'search/failure', requestId: 'first' }), second);
  const completed = searchReducer(second, { type: 'search/success', requestId: 'second', results: ['current'] });
  assert.deepEqual(completed, { requestId: 'second', loading: false, results: ['current'] });
  assert.strictEqual(searchReducer(completed, { type: 'search/failure', requestId: 'first' }), completed);
  assert.strictEqual(searchReducer(completed, { type: 'search/success', requestId: 'first', results: ['old'] }), completed);
});
test('matching failure clears loading but retains the previous results', () => {
  const results = Object.freeze(['previous']), state = Object.freeze({ requestId: 'active', loading: true, results });
  const action = Object.freeze({ type: 'search/failure', requestId: 'active' });
  const actual = searchReducer(state, action);
  assert.deepEqual(actual, { requestId: 'active', loading: false, results: ['previous'] });
  assert.strictEqual(actual.results, results);
  assert.equal(state.loading, true); assert.deepEqual(action, { type: 'search/failure', requestId: 'active' });
});
test('matching success settles the request without mutating state or action', () => {
  const state = Object.freeze({ requestId: 'active', loading: true, results: Object.freeze(['prior']) });
  const action = Object.freeze({ type: 'search/success', requestId: 'active', results: Object.freeze(['fresh']) });
  const before = structuredClone([state, action]);
  assert.deepEqual(searchReducer(state, action), { requestId: 'active', loading: false, results: ['fresh'] });
  assert.deepEqual([state, action], before);
});
test('baseline reducer exports, default state and start behavior remain available', () => {
  assert.deepEqual(initialSearchState, { requestId: null, loading: false, results: [] });
  const started = searchReducer(undefined, { type: 'search/start', requestId: 'first' });
  assert.deepEqual(started, { requestId: 'first', loading: true, results: [] });
  assert.strictEqual(searchReducer(started, { type: 'unrecognized-baseline-action' }), started);
});
`;

for (const variant of ["reference", "public-mutant"]) {
  test(`generated-package stale search full journey through HTTP/WebSocket: ${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-stale-search-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "stale-search-response");
    assert.equal(prepared.scenario.profile, "web-frontend"); assert.equal(prepared.scenario.lifecycle, "steady-state");
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["scout", "implement", "verify"]);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.workflow, undefined); assert.equal(turn.workflow, declared.workflow);
      assert.equal(turn.reconnectBefore, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain, declared.receiptUncertain === true); assert.equal(turn.abortAfterMs, undefined);
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const [mutantPath, mutant] = productionV3PlausibleMutant(prepared.scenario.id);
    assert.equal(mutantPath, sourcePath); assert.notEqual(mutant, reference);
    const source = variant === "reference" ? reference : mutant, testPath = "test/stale-search-public.test.js";
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const projectSettings = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/settings.json"), "utf8"));
    const initial = captureWorkspaceVerificationSnapshot(prepared.workspace);
    const initialSource = digest(fs.readFileSync(path.join(prepared.workspace, sourcePath)));
    const scripts = prepared.turns.map((turn, index) => index === 0 ? [
      scriptedTool("stale-0-source", "read", { path: sourcePath }),
      scriptedTool("stale-0-package", "read", { path: "package.json" }),
      scriptedText("Start first, then start second: the current state belongs to second, but the existing success and failure branches never compare requestId. An old success replaces current results and an old failure clears current loading. Add a matching-id guard to both completions, preserve the state object for stale events and the old results for matching failure. Verify overlapping success/failure orders, object identity, API preservation and project checks. No files changed.")
    ] : [
      scriptedTool(`stale-${index}-source`, "read", { path: sourcePath }),
      ...(index === 1 ? [scriptedTool("stale-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("stale-write-tests", "write", { path: testPath, content: publicTests })]
        : [scriptedTool("stale-2-tests", "read", { path: testPath }),
          scriptedTool("stale-2-focused", "bash", { command: `node --test ${testPath}` })]),
      ...commands.map((command, number) => scriptedTool(`stale-${index}-verify-${number}`, "bash", { command })),
      scriptedTool(`stale-${index}-diff`, "bash", { command: "git diff -- src test" }),
      scriptedText(variant === "reference"
        ? "The requested implementation and public witnesses were reviewed. Report the observed configured verification result and any remaining original obligations honestly. The scoped diff was inspected."
        : "The public verifier detects stale results replacing the active state. The task remains incomplete; no additional edits or successful completion are claimed.")
    ]);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const result = await runtime.turn(turn, scripts[index]);
          result.snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          result.sourceSha256 = digest(fs.readFileSync(path.join(prepared.workspace, sourcePath)));
          results.push(result);
          const checks = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
            && new RegExp(`^stale-${index}-(?:verify-|focused$)`).test(event.toolCallId));
          t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, turn: turn.id, profile: prepared.scenario.profile,
            lifecycle: prepared.scenario.lifecycle, promptSha256: digest(turn.message), sourceSha256: result.sourceSha256,
            expectedSourceSha256: digest(source), expectedTestSha256: digest(publicTests),
            testSha256: fs.existsSync(path.join(prepared.workspace, testPath)) ? digest(fs.readFileSync(path.join(prepared.workspace, testPath))) : null,
            projectResources: runtime.projectResources, receipt: result.receipt, recovery: result.recovery,
            sessionRef: result.sessionRef, operationRef: result.operationRef, settlement: result.settlement,
            wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
              outcome: result.task.trace.outcome, changeMode: result.task.changeMode, mutationPolicy: result.task.mutationPolicy,
              observedChangedFiles: result.task.observedChangedFiles, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerifier: result.task && allConfiguredVerifierEvidenceCurrent(result.task, result.snapshot.digest, result.snapshot.workspaceRevisionDigest),
            checks: checks.map(event => ({ id: event.toolCallId, isError: event.isError, output: contentText(event.result?.content) })),
            scriptedTurns: result.scriptedTurns, plannedScriptedTurns: scripts[index].length,
            unconsumedScript: result.unconsumedScript, metrics: runtime.metrics }));
        }
        const first = results[0], implemented = results[1], last = results[2], transport = runtime.transport.snapshot();
        const checks = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^stale-\d+-(?:verify-|focused$)/.test(event.toolCallId));
        t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, declaredTurns: prepared.turns.length, observedTurns: results.length,
          projectResources: runtime.projectResources, transport, metrics: runtime.metrics,
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0); assert.ok(runtime.metrics.unexpectedTurns <= 1);
        assert.ok(runtime.projectResources.length > 0);
        for (const resources of runtime.projectResources) {
          assert.deepEqual(resources.packages, projectSettings.packages);
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-core/extensions/piagent-guard.ts")));
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts")));
        }
        assert.equal(transport.kind, "loopback-http-websocket"); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1); assert.equal(transport.connections, 1); assert.equal(transport.reconnects, 0);
        assert.equal(transport.commandDispatches, 3); assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        assert.equal(new Set(results.map(result => result.operationRef)).size, 3);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message); assert.equal(result.command.payload.workflow, undefined);
          assert.equal(result.sessionId, first.sessionId); assert.equal(result.sessionRef, first.sessionRef);
          assert.equal(result.recovery, null); assert.equal(result.receipt.sessionRef, result.sessionRef);
          assert.equal(result.receipt.operationRef, result.operationRef);
          assert.equal(result.wireSettlement.kind, "operation.settled"); assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.sessionRef); assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(result.task.sessionId, result.sessionId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
        }
        assert.equal(first.task.changeMode, "read-only"); assert.equal(first.task.mutationPolicy, "forbidden");
        assert.equal(first.task.trace.outcome, "completed"); assert.deepEqual(first.task.observedChangedFiles, []);
        assert.equal(first.snapshot.digest, initial.digest); assert.equal(first.sourceSha256, initialSource);
        assert.notEqual(first.task.taskRunId, implemented.task.taskRunId);
        assert.equal(implemented.task.operatorRequest, prepared.turns[1].message); assert.equal(implemented.task.changeMode, "source-change");
        assert.equal(last.snapshot.digest, implemented.snapshot.digest); assert.equal(last.snapshot.workspaceRevisionDigest, implemented.snapshot.workspaceRevisionDigest);
        assert.equal(last.scriptedTurns, scripts[2].length, "review must not add another diagnostic or repeat writes");
        if (implemented.task.trace.outcome !== "completed") assert.equal(last.task.taskRunId, implemented.task.taskRunId,
          "a pending implementation must retain its original task through verification");
        assert.deepEqual(checks.map(event => event.toolCallId), [
          ...commands.map((_, number) => `stale-1-verify-${number}`), "stale-2-focused", ...commands.map((_, number) => `stale-2-verify-${number}`)
        ]);
        for (const event of checks) {
          const output = contentText(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.ok(implemented.task.verifyEvidence.some(evidence => verificationEvidenceProvesStableTree(evidence,
              last.snapshot.digest, last.snapshot.workspaceRevisionDigest)));
          } else { assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/); assert.match(output, /(?:#|ℹ)\s+skipped 0\b/); }
        }
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), publicTests);
        if (variant === "reference") {
          assert.ok(checks.every(event => event.isError === false));
          assert.ok(allConfiguredVerifierEvidenceCurrent(last.task, last.snapshot.digest, last.snapshot.workspaceRevisionDigest));
          assert.equal(last.task.trace.outcome, "completed", "the reference must complete after all declared turns");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          assert.ok(last.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        } else {
          const failed = checks.filter(event => event.toolCallId.includes("-verify-") && event.isError === true);
          assert.ok(failed.length > 0, "the public near-miss must fail the actual configured verifier");
          const output = failed.map(event => contentText(event.result?.content)).join("\n");
          assert.match(output, /ERR_ASSERTION/);
          assert.match(output, /(?:✖ |not ok \d+ - )stale success and failure return the exact existing state unchanged/);
          assert.ok(results.slice(1).every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        }
      } finally { await runtime.close(); }
    });
  });
}
