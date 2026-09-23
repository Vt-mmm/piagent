import { assertJourneyAcceptance } from "./helpers/production-journey-acceptance-mode.mjs";
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
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { buildWorkflowFollowUp } from "../packages/piagent-core/runtime/workflows/workflow-follow-up.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const digest = text => createHash("sha256").update(text).digest("hex");

// These witnesses follow only the unchanged public request. They do not import
// the private grader or registered recipes, whose stronger tie-breaking rules
// are not authority for this task. Each group covers the named public clauses.
const publicTests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { projectChatEvents } from '../src/frontend/chat-events.js';
const message = (overrides = {}) => ({ eventId: 'event-1', sequence: 1,
  kind: 'message', messageId: 'message-1', role: 'user', text: 'hello', confirmed: false, ...overrides });
const projected = (overrides = {}) => ({ messageId: 'message-1', role: 'user',
  text: 'hello', sequence: 1, confirmed: false, ...overrides });
test('malformed event fields throw TypeError before producing a projection', () => {
  for (const events of [undefined, null, {}, 'events']) assert.throws(() => projectChatEvents(events), TypeError);
  for (const event of [null, undefined, 1, 'event', {},
    message({ eventId: '' }), message({ eventId: 1 }),
    message({ sequence: -1 }), message({ sequence: 0.5 }), message({ sequence: NaN }),
    message({ sequence: Infinity }), message({ sequence: '1' }),
    message({ kind: 'other' }), message({ messageId: '' }), message({ messageId: null }),
    message({ role: 'system' }), message({ text: 1 }), message({ confirmed: 1 }),
    message({ replyTo: '' }), message({ replyTo: null }),
    { eventId: 'life', sequence: 0, kind: 'lifecycle', state: 'other' }]) {
    assert.throws(() => projectChatEvents([event]), TypeError);
  }
  assert.throws(() => projectChatEvents([message(), message({ eventId: 'bad', sequence: -1 })]), TypeError);
  assert.deepEqual(projectChatEvents([message({ sequence: 0, text: '' })]),
    { messages: [projected({ sequence: 0, text: '' })], processing: false });
});
test('identical event and confirmed message copies are projected only once', () => {
  const event = message();
  assert.deepEqual(projectChatEvents([event, { ...event }]), { messages: [projected()], processing: false });
  assert.deepEqual(projectChatEvents([
    message({ eventId: 'one', confirmed: true }), message({ eventId: 'two', confirmed: true })
  ]), { messages: [projected({ confirmed: true })], processing: false });
});
test('confirmed copies replace pending copies regardless of arrival order', () => {
  const pending = message({ eventId: 'pending', sequence: 8, text: 'pending' });
  const confirmed = message({ eventId: 'confirmed', sequence: 2, text: 'confirmed', confirmed: true });
  for (const events of [[pending, confirmed], [confirmed, pending]]) {
    assert.deepEqual(projectChatEvents(events),
      { messages: [projected({ sequence: 2, text: 'confirmed', confirmed: true })], processing: false });
  }
});
test('conflicting confirmed content is rejected with a conflict error', () => {
  const first = message({ eventId: 'confirmed-one', confirmed: true });
  for (const changes of [{ text: 'different' }, { role: 'assistant' }, { replyTo: 'other-message' }]) {
    const second = message({ eventId: 'confirmed-two', confirmed: true, ...changes });
    assert.throws(() => projectChatEvents([first, second]), /conflict/i);
    assert.throws(() => projectChatEvents([second, first]), /conflict/i);
  }
});
test('confirmed and pending messages sort by sequence with user before its reply', () => {
  assert.deepEqual(projectChatEvents([
    message({ eventId: 'later', messageId: 'later', sequence: 9 }),
    message({ eventId: 'early', messageId: 'early', sequence: 2, confirmed: true })
  ]), { messages: [projected({ messageId: 'early', sequence: 2, confirmed: true }),
    projected({ messageId: 'later', sequence: 9 })], processing: false });
  assert.deepEqual(projectChatEvents([
    message({ eventId: 'reply-event', messageId: 'reply', sequence: 4, role: 'assistant',
      text: 'answer', confirmed: true, replyTo: 'question' }),
    message({ eventId: 'question-event', messageId: 'question', sequence: 4, text: 'question', confirmed: true })
  ]), { messages: [projected({ messageId: 'question', sequence: 4, text: 'question', confirmed: true }),
    projected({ messageId: 'reply', sequence: 4, role: 'assistant', text: 'answer', confirmed: true, replyTo: 'question' })], processing: false });
});
test('latest lifecycle sequence decides processing and an old start cannot revive settlement', () => {
  assert.deepEqual(projectChatEvents([]), { messages: [], processing: false });
  const start = { eventId: 'start', sequence: 1, kind: 'lifecycle', state: 'started' };
  const settled = { eventId: 'settled', sequence: 4, kind: 'lifecycle', state: 'settled' };
  const newerStart = { eventId: 'new-start', sequence: 5, kind: 'lifecycle', state: 'started' };
  assert.deepEqual(projectChatEvents([start]), { messages: [], processing: true });
  assert.deepEqual(projectChatEvents([settled, start]), { messages: [], processing: false });
  assert.deepEqual(projectChatEvents([newerStart, settled, start]), { messages: [], processing: true });
});
test('projection omits transport fields and leaves the input events unchanged', () => {
  const events = [message({ eventId: 'later', sequence: 2, messageId: 'later', extra: 'not projected' }),
    message({ eventId: 'early', sequence: 1, messageId: 'early', confirmed: true })];
  const before = structuredClone(events);
  const result = projectChatEvents(events);
  assert.deepEqual(result, { messages: [projected({ messageId: 'early', confirmed: true }),
    projected({ messageId: 'later', sequence: 2 })], processing: false });
  assert.deepEqual(events, before);
  assert.notStrictEqual(result.messages, events);
  assert.notStrictEqual(result.messages[0], events[1]);
  result.messages[0].text = 'changed projection';
  assert.deepEqual(events, before);
});
`;

for (const variant of ["reference", "confirmed-conflict-mutant"]) {
  test(`actual chat workflow and uncertain-send recovery through loopback HTTP/WebSocket: ${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-chat-transport-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "reconnect-chat-event-order");
    assert.equal(prepared.scenario.profile, "web-frontend");
    assert.equal(prepared.scenario.lifecycle, "steady-state");
    assert.deepEqual(prepared.turns.map(turn => [turn.id, turn.workflow]), [["request", "task"], ["recover", "review"]]);
    assert.equal(prepared.turns[1].reconnectBefore, true);
    assert.equal(prepared.turns[1].receiptUncertain, true);
    for (const [index, turn] of prepared.turns.entries()) assert.equal(turn.message,
      fs.readFileSync(path.join(prepared.suiteRoot, prepared.scenario.userJourney.turns[index].prompt), "utf8").trim());
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const source = variant === "reference" ? reference : reference.replace('throw new Error("confirmed message conflict")', "void 0");
    if (variant !== "reference") assert.notEqual(source, reference);
    const testPath = "test/chat-events-public.test.js";
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const scripts = [
      [scriptedTool("chat-read-source", "read", { path: sourcePath }),
        scriptedTool("chat-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("chat-write-tests", "write", { path: testPath, content: publicTests }),
        ...commands.map((command, index) => scriptedTool(`chat-implement-verify-${index}`, "bash", { command })),
        scriptedText(variant === "reference"
          ? "Implemented the requested chat event projection and ran configured verification. The source and public tests are ready for review."
          : "Configured verification found a conflicting confirmed-content error. The task remains incomplete; no successful completion is claimed.")],
      [scriptedTool("chat-review-source", "read", { path: sourcePath }),
        scriptedTool("chat-review-tests", "read", { path: testPath }),
        ...commands.map((command, index) => scriptedTool(`chat-review-verify-${index}`, "bash", { command })),
        scriptedText(variant === "reference"
          ? "Reviewed the original chat projection obligations, current source and public assertions. Configured verification passed, no changes or messages were duplicated, and the implementation is complete."
          : "Review confirms the configured verifier rejects the conflicting confirmed-message behavior. The implementation is incomplete; no further changes were made.")]
    ];
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
        agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const durableReplay = index > 0 && results[0].task?.trace.outcome === "completed";
          const result = await runtime.turn(turn, durableReplay ? [] : scripts[index]);
          result.durableReplay = durableReplay;
          result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          results.push(result);
          t.diagnostic(JSON.stringify({ scenario: prepared.scenario.id, variant, turn: turn.id,
            promptSha256: digest(turn.message), sourceSha256: digest(source), testSha256: digest(publicTests),
            receipt: result.receipt, recovery: result.recovery, sessionRef: result.sessionRef, operationRef: result.operationRef,
            settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId,
              outcome: result.task.trace.outcome, diagnosticNotes: result.task.trace.notes, changeMode: result.task.changeMode, verifyCommands: result.task.verifyCommands,
              verifyEvidence: result.task.verifyEvidence, acceptanceCriteria: result.task.acceptanceCriteria,
              criteria: result.task.acceptanceReceipt?.criteria }, scriptedTurns: result.scriptedTurns,
            unconsumedScript: result.unconsumedScript, durableReplay, metrics: runtime.metrics }));
        }
        const [first, recovered] = results, snapshot = runtime.transport.snapshot();
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^chat-(?:implement|review)-verify-/.test(event.toolCallId));
        t.diagnostic(JSON.stringify({ variant, transport: snapshot, metrics: runtime.metrics,
          verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: textContent(event.result?.content) })),
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []);
        assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(recovered.scriptedTurns, recovered.durableReplay ? 0 : scripts[1].length,
          "lost acknowledgement and review must not add an unscripted model turn");
        assert.equal(snapshot.kind, "loopback-http-websocket");
        assert.equal(snapshot.unauthenticatedCatalogStatus, 401);
        assert.equal(snapshot.bootstrapCount, 1);
        assert.equal(snapshot.connections, 3);
        assert.equal(snapshot.reconnects, 2);
        assert.equal(snapshot.commandDispatches, 2, "lost acknowledgement cannot resend the actual server command");
        assert.equal(snapshot.uncertainSends, 1);
        assert.equal(snapshot.droppedConnections, 1);
        assert.equal(snapshot.reconnectCursors.length, 2);
        assert.equal(first.sessionId, recovered.sessionId);
        assert.equal(first.task?.taskRunId, recovered.task?.taskRunId, "recovery must retain the original implementation task");
        assert.equal(first.sessionRef, recovered.sessionRef);
        assert.notEqual(first.operationRef, recovered.operationRef);
        assert.ok(first.receipt);
        assert.equal(recovered.receipt, null, "an intentionally lost acknowledgement must never be synthesized");
        assert.ok(recovered.recovery, "the uncertain operation identity must come from real recovery");
        assert.equal(recovered.recovery.responseDiscarded, true);
        assert.equal(recovered.recovery.connectionDropped, true);
        assert.equal(recovered.recovery.sendAttempts, 1);
        assert.equal(recovered.recovery.correlatedByMessageRequestId, true);
        assert.equal(recovered.recovery.operationRef, recovered.operationRef);
        if (recovered.durableReplay) {
          assert.equal(recovered.scriptedTurns, 0, "completed durable recovery must not repeat review or verification tools");
          assert.deepEqual(recovered.task.verifyEvidence, first.task.verifyEvidence);
          assert.equal(recovered.verificationSnapshot.digest, first.verificationSnapshot.digest);
          assert.equal(recovered.verificationSnapshot.workspaceRevisionDigest, first.verificationSnapshot.workspaceRevisionDigest);
        }
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, prepared.turns[index].workflow);
          assert.equal(result.wireSettlement.kind, "operation.settled");
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.sessionRef);
          assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.ok(result.task);
          assert.equal(result.task.sessionId, result.sessionId);
          // The outer /workflow command dispatches its exact /task follow-up;
          // the durable task stores that inner command, not the outer ingress.
          assert.equal(result.task.operatorRequest, buildWorkflowFollowUp("task", prepared.turns[0].message));
          assert.equal(result.task.changeMode, "source-change");
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled"
            && event.payload.operationRef === result.operationRef).length, 1);
        }
        assert.deepEqual(verifications.map(event => event.toolCallId), [
          ...commands.map((_, index) => `chat-implement-verify-${index}`),
          ...(recovered.durableReplay ? [] : commands.map((_, index) => `chat-review-verify-${index}`))]);
        for (const event of verifications) {
          const output = textContent(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.match(event.toolCallId, /^chat-review-/);
            const state = recovered.verificationSnapshot;
            assert.equal(state.digest, first.verificationSnapshot.digest);
            assert.equal(state.workspaceRevisionDigest, first.verificationSnapshot.workspaceRevisionDigest);
            assert.ok(first.task.verifyEvidence.some(item => verificationEvidenceProvesStableTree(item, state.digest, state.workspaceRevisionDigest)));
            assert.deepEqual(recovered.task.verifyEvidence, first.task.verifyEvidence, "reuse must retain original observed evidence");
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
            assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), publicTests);
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2,
          "review and acknowledgement recovery must not duplicate the two implementation writes");
        const current = allConfiguredVerifierEvidenceCurrent(recovered.task,
          recovered.verificationSnapshot.digest, recovered.verificationSnapshot.workspaceRevisionDigest);
        if (variant === "reference") {
          assert.equal(runtime.metrics.unexpectedTurns, 0, "missing proof cannot trigger a model repair loop");
          assert.ok(verifications.every(event => event.isError === false), "the configured verifier must pass");
          assert.equal(current, true);
          assert.equal(recovered.task.trace.outcome, "completed", "correct public-evidence chat task must really complete after review and reconnect");
          assert.equal(recovered.settlement.taskStatus, "completed");
          assert.equal(recovered.settlement.settlement, "completed");
          assert.equal(recovered.settlement.reasonCode, null);
          assertJourneyAcceptance(repositoryRoot, recovered.task, recovered.task);
        } else {
          const failed = verifications.filter(event => event.isError === true);
          assert.ok(failed.length > 0, "wrong content-conflict behavior must fail a real public verifier assertion");
          assert.match(failed.map(event => textContent(event.result?.content)).join("\n"), /ERR_ASSERTION/);
          assert.match(failed.map(event => textContent(event.result?.content)).join("\n"), /Missing expected exception/);
          // A real assertion failure may trigger one existing bounded diagnosis;
          // it is not zero-model recovery or permission for repeated repairs.
          assert.ok(runtime.metrics.unexpectedTurns <= 1);
          assert.equal(first.scriptedTurns - scripts[0].length, runtime.metrics.unexpectedTurns,
            "only the first observed verifier failure may request the bounded diagnosis");
          assert.equal(current, false);
          assert.notEqual(recovered.task.trace.outcome, "completed");
          assert.notEqual(recovered.settlement.taskStatus, "completed");
        }
      } finally { await runtime.close(); }
    });
  });
}
