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
const preamble = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";

// Public request witnesses only: no private grader, registered recipe or
// independent approval is imported. These finite checks are not whole-AC authority.
const cases = [
  { id: "chunked-record-boundary", lifecycle: "cold-start", turns: ["request", "recover"],
    tests: preamble + String.raw`import { parseNdjsonChunks } from '../src/data/ndjson-stream.js';
const encode = value => new TextEncoder().encode(value);
test('incremental UTF-8 preserves records across every split and a final record without newline', () => {
  const bytes = encode('{"text":"Việt 😀"}\r\n\n{"n":2}');
  for (let cut = 0; cut <= bytes.length; cut++) {
    assert.deepEqual(parseNdjsonChunks([bytes.slice(0, cut), bytes.slice(cut)]), [{ text: 'Việt 😀' }, { n: 2 }]);
  }
  assert.deepEqual(parseNdjsonChunks(Array.from(bytes, byte => new Uint8Array([byte]))), [{ text: 'Việt 😀' }, { n: 2 }]);
});
test('LF and CRLF empty physical lines are ignored and record order is retained', () => {
  assert.deepEqual(parseNdjsonChunks([encode('\n\r\n{"n":1}\n\n{"n":2}\r\n')]), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(parseNdjsonChunks([]), []);
});
test('non-byte chunks throw TypeError while invalid UTF-8 and invalid JSON throw', () => {
  for (const chunk of ['{}', null, {}, [123, 125], new ArrayBuffer(2)]) {
    assert.throws(() => parseNdjsonChunks([chunk]), TypeError);
  }
  assert.throws(() => parseNdjsonChunks([new Uint8Array([0xff])]));
  assert.throws(() => parseNdjsonChunks([new Uint8Array([0xe2, 0x82])]));
  assert.throws(() => parseNdjsonChunks([encode('{bad}\n')]));
});
test('the chunk array, byte views and backing buffers are not mutated', () => {
  const backing = encode('x{"n":1}\ny'), first = backing.subarray(1, backing.length - 1);
  const second = encode('{"n":2}'), chunks = [first, second];
  const before = [Array.from(backing), Array.from(second)];
  const beforeChunks = [...chunks];
  assert.deepEqual(parseNdjsonChunks(chunks), [{ n: 1 }, { n: 2 }]);
  assert.equal(chunks.length, beforeChunks.length);
  assert.deepEqual(chunks, beforeChunks);
  assert.strictEqual(chunks[0], first); assert.strictEqual(chunks[1], second);
  assert.deepEqual([Array.from(backing), Array.from(second)], before);
});
` },
  { id: "idempotent-replay-conflict", lifecycle: "steady-state", turns: ["request", "recover"],
    tests: preamble + String.raw`import { replayVersionedEvents } from '../src/data/versioned-replay.js';
const state = () => ({ entities: {}, appliedEventIds: [] });
const event = (overrides = {}) => ({ eventId: 'first', entityId: 'entity', expectedVersion: 0, nextValue: { count: 1 }, ...overrides });
test('missing entities start at zero, accepted events advance once and applied order is retained', () => {
  const input = state(), events = [event(), event({ eventId: 'second', expectedVersion: 1, nextValue: { count: 2 } })];
  const before = structuredClone([input, events]);
  const result = replayVersionedEvents(input, events);
  assert.deepEqual(result, { entities: { entity: { version: 2, value: { count: 2 } } }, appliedEventIds: ['first', 'second'] });
  assert.notStrictEqual(result, input); assert.deepEqual([input, events], before);
  result.entities.entity.value.count = 9; assert.deepEqual([input, events], before);
});
test('duplicates in a replay and previously applied event ids are idempotent no-ops', () => {
  let once;
  assert.doesNotThrow(() => { once = replayVersionedEvents(state(), [event(), event()]); });
  assert.deepEqual(once, { entities: { entity: { version: 1, value: { count: 1 } } }, appliedEventIds: ['first'] });
  let twice;
  assert.doesNotThrow(() => { twice = replayVersionedEvents(once, [event()]); });
  assert.deepEqual(twice, once); assert.notStrictEqual(twice, once);
});
test('nonduplicate version conflicts contain version conflict without partially mutating input', () => {
  const input = state(), events = [event(), event({ eventId: 'conflicting', expectedVersion: 0 })];
  const before = structuredClone([input, events]);
  assert.throws(() => replayVersionedEvents(input, events), /version conflict/);
  assert.deepEqual([input, events], before);
});
test('malformed state or event shapes and empty IDs throw TypeError', () => {
  for (const input of [null, [], {}, { entities: null, appliedEventIds: [] }, { entities: {}, appliedEventIds: '' },
    { entities: {}, appliedEventIds: [''] }]) assert.throws(() => replayVersionedEvents(input, []), TypeError);
  for (const bad of [null, [], {}, event({ eventId: '' }), event({ eventId: 1 }), event({ entityId: '' }),
    event({ entityId: null }), event({ expectedVersion: 0.5 }), event({ expectedVersion: '0' })]) {
    assert.throws(() => replayVersionedEvents(state(), [bad]), TypeError);
  }
});
` },
  { id: "bounded-retry", lifecycle: "steady-state", turns: ["request"],
    tests: preamble + String.raw`import { retry } from '../src/reliability/retry.js';
test('success returns the actual value without sleeping or making another attempt', async () => {
  let calls = 0; const result = { ok: true }, delays = [];
  assert.strictEqual(await retry(() => { calls++; return result; }, { maxAttempts: 3, baseDelayMs: 4, sleep: async ms => delays.push(ms) }), result);
  assert.equal(calls, 1); assert.deepEqual(delays, []);
});
test('sleep is awaited between failures and exponential delays precede the next attempt', async () => {
  let calls = 0, pendingSleep = false; const delays = [], order = [];
  const result = await retry(async () => {
    assert.equal(pendingSleep, false); calls++; order.push('attempt-' + calls);
    if (calls < 3) throw new Error('temporary'); return 'done';
  }, { maxAttempts: 4, baseDelayMs: 5, sleep: async ms => {
    pendingSleep = true; delays.push(ms); order.push('sleep-' + ms); await Promise.resolve(); pendingSleep = false;
  } });
  assert.equal(result, 'done'); assert.equal(calls, 3); assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(order, ['attempt-1', 'sleep-5', 'attempt-2', 'sleep-10', 'attempt-3']);
});
test('the final error is rethrown unchanged and no sleep follows the last failed attempt', async () => {
  let calls = 0; const errors = [new Error('first'), new Error('last')], delays = [];
  await assert.rejects(retry(() => { throw errors[calls++]; }, { maxAttempts: 2, baseDelayMs: 3, sleep: async ms => delays.push(ms) }), error => error === errors[1]);
  assert.equal(calls, 2); assert.deepEqual(delays, [3]);
});
test('invalid positive-integer attempt limits throw TypeError before operation or sleep', async () => {
  for (const maxAttempts of [0, -1, 1.5, NaN, Infinity, '2']) {
    let calls = 0, sleeps = 0;
    await assert.rejects(retry(() => { calls++; }, { maxAttempts, baseDelayMs: 1, sleep: async () => { sleeps++; } }), TypeError);
    assert.equal(calls, 0); assert.equal(sleeps, 0);
  }
});
test('invalid delay and sleep options reject before the operation runs', async () => {
  for (const baseDelayMs of [-1, NaN, Infinity, '1']) {
    let calls = 0, sleeps = 0;
    await assert.rejects(retry(() => { calls++; }, { maxAttempts: 2, baseDelayMs, sleep: async () => { sleeps++; } }), TypeError);
    assert.equal(calls, 0); assert.equal(sleeps, 0);
  }
  for (const sleep of [false, 0, {}, 'sleep']) {
    let calls = 0;
    await assert.rejects(retry(() => { calls++; }, { maxAttempts: 2, baseDelayMs: 1, sleep }), TypeError);
    assert.equal(calls, 0);
  }
});
test('a representable positive integer beyond the safe-integer range permits immediate success', async () => {
  let calls = 0;
  assert.equal(await retry(() => { calls++; return 'done'; }, { maxAttempts: 2 ** 54, baseDelayMs: 1, sleep: async () => assert.fail('unexpected sleep') }), 'done');
  assert.equal(calls, 1);
});
` }
];

for (const spec of cases) for (const variant of spec.id === "bounded-retry"
  ? ["reference", "public-contract-implementation", "public-mutant"] : ["reference", "public-mutant"]) {
  test(`actual Node production journey through HTTP/WebSocket: ${spec.id}/${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-node-journey-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, spec.id);
    assert.equal(prepared.scenario.profile, "node-typescript");
    assert.equal(prepared.scenario.lifecycle, spec.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => turn.id), spec.turns);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.workflow, undefined);
      assert.equal(turn.reconnectBefore, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain, declared.receiptUncertain === true);
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(spec.id);
    const [mutantPath, mutant] = productionV3PlausibleMutant(spec.id);
    assert.equal(mutantPath, sourcePath); assert.notEqual(mutant, reference);
    // Both retained positive variant labels now use the corrected reference.
    // The negative variant still changes only the required exponential backoff.
    const publicCandidate = reference;
    const wrongCandidate = mutant;
    const source = variant === "reference" ? reference : variant === "public-mutant" ? wrongCandidate : publicCandidate;
    const testPath = `test/${spec.id}-public.test.js`;
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const packageHash = digest(fs.readFileSync(path.join(prepared.workspace, "package.json")));
    const scripts = prepared.turns.map((turn, index) => [
      scriptedTool(`node-${index}-read-source`, "read", { path: sourcePath }),
      ...(index === 0 ? [scriptedTool("node-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("node-write-tests", "write", { path: testPath, content: spec.tests })]
        : [scriptedTool(`node-${index}-read-tests`, "read", { path: testPath })]),
      ...commands.map((command, commandIndex) => scriptedTool(`node-${index}-verify-${commandIndex}`, "bash", { command })),
      scriptedText(variant !== "public-mutant"
        ? "The requested implementation and public tests are present. Configured verification was run; report its observed result and retain any unmet original obligations."
        : "Configured verification exposes the incorrect implementation. The task remains incomplete; no further changes are made.")
    ]);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir,
        repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const durableReplay = index > 0 && results[0].task?.trace.outcome === "completed";
          const result = await runtime.turn(turn, durableReplay ? [] : scripts[index]);
          result.durableReplay = durableReplay;
          result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          results.push(result);
          const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && new RegExp(`^node-${index}-verify-`).test(event.toolCallId));
          t.diagnostic(JSON.stringify({ scenario: spec.id, variant, turn: turn.id, lifecycle: spec.lifecycle,
            promptSha256: digest(turn.message), expectedSourceSha256: digest(source), expectedTestSha256: digest(spec.tests),
            sourceSha256: digest(fs.readFileSync(path.join(prepared.workspace, sourcePath))),
            testSha256: fs.existsSync(path.join(prepared.workspace, testPath)) ? digest(fs.readFileSync(path.join(prepared.workspace, testPath))) : null,
            receipt: result.receipt, recovery: result.recovery, sessionRef: result.sessionRef, operationRef: result.operationRef,
            settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
              outcome: result.task.trace.outcome, changeMode: result.task.changeMode, verifyCommands: result.task.verifyCommands,
              verifyEvidence: result.task.verifyEvidence, acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerifier: result.task && allConfiguredVerifierEvidenceCurrent(result.task, result.verificationSnapshot.digest,
              result.verificationSnapshot.workspaceRevisionDigest), verifications: verifications.map(event => ({ id: event.toolCallId,
              isError: event.isError, output: contentText(event.result?.content) })), scriptedTurns: result.scriptedTurns,
            unconsumedScript: result.unconsumedScript, durableReplay, metrics: runtime.metrics }));
        }
        const first = results[0], last = results.at(-1), transport = runtime.transport.snapshot();
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^node-\d+-verify-/.test(event.toolCallId));
        t.diagnostic(JSON.stringify({ scenario: spec.id, variant, declaredTurns: prepared.turns.length, observedTurns: results.length,
          transport, metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(transport.kind, "loopback-http-websocket"); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1); assert.equal(transport.connections, prepared.turns.length);
        assert.equal(transport.reconnects, prepared.turns.length - 1);
        assert.equal(transport.commandDispatches, prepared.turns.length);
        assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, undefined);
          assert.ok(result.receipt); assert.equal(result.recovery, null);
          assert.equal(result.wireSettlement.kind, "operation.settled");
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.sessionRef);
          assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.ok(result.task); assert.equal(result.task.sessionId, result.sessionId);
          assert.equal(result.sessionId, first.sessionId); assert.equal(result.sessionRef, first.sessionRef);
          assert.equal(result.task.taskRunId, first.task.taskRunId, "recovery must retain the original task");
          assert.equal(result.task.operatorRequest, first.task.operatorRequest);
          assert.equal(result.task.changeMode, "source-change");
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
          if (index > 0) {
            assert.notEqual(result.operationRef, first.operationRef);
            assert.equal(result.scriptedTurns, result.durableReplay ? 0 : scripts[index].length,
              "recovery may review but must not add unplanned model attempts");
            assert.equal(result.verificationSnapshot.digest, first.verificationSnapshot.digest);
            assert.equal(result.verificationSnapshot.workspaceRevisionDigest, first.verificationSnapshot.workspaceRevisionDigest);
          }
        }
        assert.deepEqual(verifications.map(event => event.toolCallId), results.flatMap((result, index) => result.durableReplay ? []
          : commands.map((_, commandIndex) => `node-${index}-verify-${commandIndex}`)));
        for (const event of verifications) {
          const output = contentText(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.match(event.toolCallId, /^node-1-/);
            assert.ok(first.task.verifyEvidence.some(evidence => verificationEvidenceProvesStableTree(evidence,
              last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest)));
            assert.deepEqual(last.task.verifyEvidence, first.task.verifyEvidence);
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/); assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), spec.tests);
        assert.equal(digest(fs.readFileSync(path.join(prepared.workspace, "package.json"))), packageHash, "no dependency changes are scripted");
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2,
          "recovery must neither repeat writes nor repair the source");
        // These are atomic proof gaps or actual verifier failures. The current
        // policy permits one initial diagnosis, unlike the earlier compound
        // no-authority handoff. Record it without asserting zero or hiding it.
        assert.ok(runtime.metrics.unexpectedTurns <= 1, "only one existing initial diagnosis is permitted");
        assert.equal(first.scriptedTurns - scripts[0].length, runtime.metrics.unexpectedTurns);
        const current = allConfiguredVerifierEvidenceCurrent(last.task, last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest);
        if (variant !== "public-mutant") {
          assert.ok(verifications.every(event => event.isError === false), "reference must pass actual configured public verification");
          assert.equal(current, true);
          assert.equal(last.task.trace.outcome, "completed", "correct reference must complete after every declared turn");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          assert.equal(last.settlement.reasonCode, null);
          assert.ok(last.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        } else {
          const failed = verifications.filter(event => event.isError === true);
          assert.ok(failed.length > 0, "public mutant must fail an actual configured verifier");
          assert.match(failed.map(event => contentText(event.result?.content)).join("\n"), /ERR_ASSERTION/);
          assert.equal(current, false);
          assert.ok(results.every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        }
      } finally { await runtime.close(); }
    });
  });
}
