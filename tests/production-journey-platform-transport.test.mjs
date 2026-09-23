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
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const contentText = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const preamble = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";
// Finite public-contract witnesses only. No hidden grader or independent
// approval is supplied to the model. A verifier PASS is not universal proof.
const cases = [
  { id: "abort-reconnect-supersession", profile: "web-frontend", lifecycle: "steady-state", turns: ["request", "recover"],
    tests: preamble + String.raw`import { initialRequestState, requestLifecycleReducer as reduce } from '../src/frontend/request-lifecycle.js';
test('request start records id and epoch and clears the previous error', () => {
  const state = Object.freeze({ ...initialRequestState, error: 'old' });
  const action = Object.freeze({ type: 'request/start', requestId: 'new', epoch: 2 });
  assert.deepEqual(reduce(state, action), { activeRequestId: 'new', connectionEpoch: 2, loading: true, results: [], error: null });
  assert.equal(state.error, 'old'); assert.equal(action.requestId, 'new');
});
test('newer reconnect cancels active work and preserves prior results without mutating state', () => {
  const results = Object.freeze(['prior']);
  const state = Object.freeze({ activeRequestId: 'old', connectionEpoch: 2, loading: true, results, error: 'old error' });
  const actual = reduce(state, Object.freeze({ type: 'connection/reconnect', epoch: 3 }));
  assert.deepEqual(actual, { activeRequestId: null, connectionEpoch: 3, loading: false, results: ['prior'], error: null });
  assert.strictEqual(actual.results, results);
  for (const epoch of [1, 2]) assert.strictEqual(reduce(state, { type: 'connection/reconnect', epoch }), state);
});
test('success and failure require both active id and epoch and ignore duplicate settlement', () => {
  const state = Object.freeze({ activeRequestId: 'current', connectionEpoch: 4, loading: true, results: Object.freeze(['prior']), error: null });
  for (const type of ['request/success', 'request/failure']) {
    for (const [requestId, epoch] of [['stale', 4], ['current', 3], ['current', 5]]) {
      assert.strictEqual(reduce(state, Object.freeze({ type, requestId, epoch, results: ['wrong'], error: 'wrong' })), state);
    }
    const action = Object.freeze({ type, requestId: 'current', epoch: 4, results: Object.freeze(['new']), error: 'failed' });
    const result = reduce(state, action);
    assert.equal(result.activeRequestId, null); assert.equal(result.loading, false);
    assert.equal(result.error, type === 'request/failure' ? 'failed' : null);
    assert.deepEqual(result.results, type === 'request/success' ? ['new'] : ['prior']);
    if (type === 'request/success') assert.notStrictEqual(result.results, action.results);
    assert.strictEqual(reduce(result, action), result);
    assert.deepEqual(state.results, ['prior']); assert.deepEqual(action.results, ['new']);
  }
});
test('superseded starts are ignored and existing unknown-action behavior is preserved', () => {
  const state = reduce(initialRequestState, { type: 'request/start', requestId: 'first', epoch: 2 });
  const newer = reduce(state, { type: 'request/start', requestId: 'second', epoch: 2 });
  assert.strictEqual(reduce(newer, { type: 'request/success', requestId: 'first', epoch: 2, results: [] }), newer);
  assert.strictEqual(reduce(newer, { type: 'request/start', requestId: 'old', epoch: 1 }), newer);
  assert.strictEqual(reduce(newer, { type: 'unknown' }), newer);
});
` },
  { id: "config-precedence", profile: "fullstack", lifecycle: "steady-state", turns: ["scout", "implement", "verify"],
    tests: preamble + String.raw`import { resolveConfig } from '../src/platform/config.js';
test('each key independently follows CLI then environment then file then defaults', () => {
  assert.deepEqual(resolveConfig({ port: 1 }, { port: 2, debug: false }, { port: 3, debug: true, label: 'file' },
    { port: 4, debug: true, label: 'default' }), { port: 1, debug: false, label: 'file' });
  assert.deepEqual(resolveConfig(), { port: undefined, debug: undefined, label: undefined });
});
test('only undefined is absent at every precedence tier', () => {
  for (const key of ['port', 'debug', 'label']) for (const value of [false, 0, '', null]) {
    for (let chosen = 0; chosen < 4; chosen++) {
      const inputs = Array.from({ length: 4 }, (_, index) => Object.freeze({ [key]: index < chosen ? undefined : index === chosen ? value : 'fallback' }));
      const before = structuredClone(inputs), actual = resolveConfig(...inputs);
      assert.strictEqual(actual[key], value); assert.deepEqual(inputs, before);
    }
  }
});
test('resolution returns a fresh object and leaves all input objects unchanged', () => {
  const inputs = [{ port: 0 }, { debug: false }, { label: '' }, { port: 9, label: 'default' }], before = structuredClone(inputs);
  const actual = resolveConfig(...inputs); actual.port = 999;
  assert.deepEqual(inputs, before); for (const input of inputs) assert.notStrictEqual(actual, input);
});
` },
  { id: "workspace-order", profile: "fullstack", lifecycle: "cold-start", turns: ["request", "recover"],
    tests: preamble + String.raw`import { workspaceOrder } from '../src/platform/workspace.js';
test('in-repository dependencies precede dependents exactly once even when shared or repeated', () => {
  const input = [{ name: 'app', dependencies: ['ui', 'core', 'core'] }, { name: 'ui', dependencies: ['core'] }, { name: 'core' }];
  assert.deepEqual(workspaceOrder(input), ['core', 'ui', 'app']);
  const result = workspaceOrder([{ name: 'first', dependencies: ['shared'] }, { name: 'second', dependencies: ['shared'] }, { name: 'shared' }]);
  assert.deepEqual(result, ['shared', 'first', 'second']); assert.equal(new Set(result).size, 3);
});
test('external dependencies are ignored and independent packages preserve input order', () => {
  assert.deepEqual(workspaceOrder([{ name: 'z', dependencies: ['external'] }, { name: 'a' }, { name: 'm', dependencies: [] }]), ['z', 'a', 'm']);
  assert.deepEqual(workspaceOrder([]), []);
});
test('direct and indirect in-repository cycles throw an Error containing cycle', () => {
  for (const input of [[{ name: 'self', dependencies: ['self'] }],
    [{ name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['c'] }, { name: 'c', dependencies: ['a'] }]]) {
    const before = structuredClone(input);
    assert.throws(() => workspaceOrder(input), error => error instanceof Error && error.message.includes('cycle'));
    assert.deepEqual(input, before);
  }
});
test('ordering does not mutate packages or their dependency arrays', () => {
  const input = Object.freeze([Object.freeze({ name: 'app', dependencies: Object.freeze(['lib']) }), Object.freeze({ name: 'lib' })]);
  const before = structuredClone(input); assert.deepEqual(workspaceOrder(input), ['lib', 'app']); assert.deepEqual(input, before);
});
` },
  { id: "backend-frontend-contract-sync", profile: "fullstack", lifecycle: "cold-start", turns: ["request"],
    tests: preamble + String.raw`import { compareSubscriptionContracts as compare } from '../src/fullstack/contract-sync.js';
const backend = () => ({ version: 2, statuses: ['active', 'paused'], requiredFields: ['id', 'status'] });
const frontend = () => ({ version: 2, statuses: ['paused', 'active'], fields: ['status', 'id', 'extra-ui-field'] });
test('equal positive versions and sets are compatible regardless of input ordering', () => {
  assert.deepEqual(compare(backend(), frontend()), { compatible: true, missingStatuses: [], extraStatuses: [], missingFields: [], versionMismatch: false });
  assert.deepEqual(compare({ version: 1, statuses: [], requiredFields: [] }, { version: 1, statuses: [], fields: [] }),
    { compatible: true, missingStatuses: [], extraStatuses: [], missingFields: [], versionMismatch: false });
});
test('missing and extra outputs have correct direction and UTF-8 byte ordering', () => {
  const result = compare({ version: 1, statuses: ['𐀀', '', 'z'], requiredFields: ['𐀀', '', 'a'] },
    { version: 2, statuses: ['𐀁', '', 'b'], fields: ['not-required'] });
  assert.deepEqual(result, { compatible: false, missingStatuses: ['z', '', '𐀀'], extraStatuses: ['b', '', '𐀁'],
    missingFields: ['a', '', '𐀀'], versionMismatch: true });
});
test('each mismatch alone makes contracts incompatible', () => {
  for (const change of [{ version: 3 }, { statuses: ['active'] }, { statuses: ['active', 'paused', 'extra'] }, { fields: ['id'] }]) {
    assert.equal(compare(backend(), { ...frontend(), ...change }).compatible, false);
  }
});
test('malformed contracts and nonpositive or noninteger versions throw TypeError', () => {
  for (const bad of [null, undefined, 'bad', 7, {}]) {
    assert.throws(() => compare(bad, frontend()), TypeError); assert.throws(() => compare(backend(), bad), TypeError);
  }
  for (const version of [0, -1, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => compare({ ...backend(), version }, frontend()), TypeError);
    assert.throws(() => compare(backend(), { ...frontend(), version }), TypeError);
  }
});
test('all four declaration arrays require unique non-empty strings', () => {
  for (const bad of [undefined, null, 'active', [1], [''], ['same', 'same']]) {
    for (const key of ['statuses', 'requiredFields']) assert.throws(() => compare({ ...backend(), [key]: bad }, frontend()), TypeError);
    for (const key of ['statuses', 'fields']) assert.throws(() => compare(backend(), { ...frontend(), [key]: bad }), TypeError);
  }
});
test('comparison returns fresh output and never mutates inputs', () => {
  const left = backend(), right = frontend(), before = structuredClone([left, right]);
  Object.freeze(left.statuses); Object.freeze(left.requiredFields); Object.freeze(left);
  Object.freeze(right.statuses); Object.freeze(right.fields); Object.freeze(right);
  const result = compare(left, right), again = compare(left, right);
  assert.notStrictEqual(result, again); assert.notStrictEqual(result.missingStatuses, again.missingStatuses);
  result.missingStatuses.push('changed-output'); assert.deepEqual([left, right], before);
});
` }
];

for (const spec of cases) for (const variant of ["reference", "public-mutant"]) {
  test(`generated-package platform journey through HTTP/WebSocket: ${spec.id}/${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-platform-journey-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, spec.id);
    assert.equal(prepared.scenario.profile, spec.profile); assert.equal(prepared.scenario.lifecycle, spec.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => turn.id), spec.turns);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.workflow, declared.workflow);
      assert.equal(turn.reconnectBefore, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain, declared.receiptUncertain === true);
      assert.equal(turn.abortAfterMs, undefined, "the reducer scenario does not declare a Pi session abort");
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(spec.id), [mutantPath, mutant] = productionV3PlausibleMutant(spec.id);
    assert.equal(mutantPath, sourcePath); assert.notEqual(mutant, reference);
    const source = variant === "reference" ? reference : mutant, testPath = `test/${spec.id}-public.test.js`;
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const packageHash = digest(fs.readFileSync(path.join(prepared.workspace, "package.json")));
    const initial = captureWorkspaceVerificationSnapshot(prepared.workspace);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const results = [], implementationIndex = prepared.turns[0].id === "scout" ? 1 : 0;
        for (const [index, turn] of prepared.turns.entries()) {
          const scout = turn.id === "scout", implement = index === implementationIndex;
          const durableReplay = turn.id === "recover" && results.at(-1)?.task?.trace.outcome === "completed";
          const script = [scriptedTool(`platform-${index}-read-source`, "read", { path: sourcePath }),
            ...(implement ? [scriptedTool("platform-write-source", "write", { path: sourcePath, content: source }),
              scriptedTool("platform-write-tests", "write", { path: testPath, content: spec.tests })] : []),
            ...(!scout ? [scriptedTool(`platform-${index}-read-tests`, "read", { path: testPath }),
              ...(turn.id === "verify" ? [scriptedTool(`platform-${index}-focused`, "bash", { command: `node --test ${testPath}` })] : []),
              ...commands.map((command, number) => scriptedTool(`platform-${index}-verify-${number}`, "bash", { command })),
              scriptedTool(`platform-${index}-diff`, "bash", { command: "git diff -- src test" })] : []),
            scriptedText(scout ? "The current resolution falls through falsey values. Resolve each key by the first value that is not undefined across CLI, environment, file and defaults. Add focused witnesses for all tiers and falsey values, then run the configured verification. No file was changed."
              : variant === "reference" ? "The requested implementation and public tests are present. Verification and the scoped diff were inspected; retain any unmet original obligations."
                : "The public verifier exposes the wrong implementation. It remains incomplete, with no repair or successful completion claimed.")];
          const result = await runtime.turn(turn, durableReplay ? [] : script);
          result.snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          result.durableReplay = durableReplay; result.plannedScriptedTurns = durableReplay ? 0 : script.length;
          results.push(result);
          const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
            && (event.toolCallId.startsWith(`platform-${index}-verify-`) || event.toolCallId === `platform-${index}-focused`));
          t.diagnostic(JSON.stringify({ scenario: spec.id, variant, turn: turn.id, profile: spec.profile, lifecycle: spec.lifecycle,
            promptSha256: digest(turn.message), sourceSha256: digest(fs.readFileSync(path.join(prepared.workspace, sourcePath))),
            expectedSourceSha256: digest(source), expectedTestSha256: digest(spec.tests), projectResources: runtime.projectResources,
            receipt: result.receipt, recovery: result.recovery, settlement: result.settlement, wireSettlement: result.wireSettlement,
            transport: result.transport, sessionRef: result.sessionRef, operationRef: result.operationRef,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
              outcome: result.task.trace.outcome, changeMode: result.task.changeMode, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerifier: result.task && allConfiguredVerifierEvidenceCurrent(result.task, result.snapshot.digest, result.snapshot.workspaceRevisionDigest),
            verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: contentText(event.result?.content) })),
            scriptedTurns: result.scriptedTurns, plannedScriptedTurns: result.plannedScriptedTurns, unconsumedScript: result.unconsumedScript,
            durableReplay, metrics: runtime.metrics }));
        }
        const last = results.at(-1), first = results[0], implemented = results[implementationIndex], transport = runtime.transport.snapshot();
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^platform-\d+-(?:verify-|focused$)/.test(event.toolCallId));
        t.diagnostic(JSON.stringify({ scenario: spec.id, variant, declaredTurns: prepared.turns.length, observedTurns: results.length,
          projectResources: runtime.projectResources, transport, metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(transport.commandDispatches, prepared.turns.length); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.connections, 1 + prepared.turns.filter(turn => turn.reconnectBefore).length);
        assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        assert.ok(runtime.projectResources.length > 0);
        assert.ok(runtime.projectResources.every(resources => resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts"))));
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, prepared.turns[index].workflow);
          assert.equal(result.sessionId, first.sessionId); assert.equal(result.sessionRef, first.sessionRef);
          assert.equal(result.wireSettlement.kind, "operation.settled"); assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
          if (prepared.turns[index].id === "scout") {
            assert.equal(result.snapshot.digest, initial.digest, "scouting must not mutate the project");
            assert.equal(result.task.changeMode, "read-only");
            assert.equal(result.task.trace.outcome, "completed", "the declared scout must complete before implementation");
          } else if (index > implementationIndex) {
            assert.equal(result.snapshot.digest, implemented.snapshot.digest, "review/recovery must not repeat or repair writes");
            assert.equal(result.snapshot.workspaceRevisionDigest, implemented.snapshot.workspaceRevisionDigest);
            if (prepared.turns[index].id === "recover") assert.equal(result.task.taskRunId, implemented.task.taskRunId);
            if (implemented.task.trace.outcome !== "completed") assert.equal(result.task.taskRunId, implemented.task.taskRunId,
              "an unresolved implementation cannot be replaced with an unrelated completed review task");
          }
        }
        assert.ok(verifications.length >= commands.length, "the implementation must execute its configured verifiers");
        assert.deepEqual(verifications.filter(event => event.toolCallId.endsWith("-focused")).map(event => event.toolCallId),
          prepared.turns.flatMap((turn, index) => turn.id === "verify" ? [`platform-${index}-focused`] : []));
        for (const event of verifications) {
          const output = contentText(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (!output.includes("reused exact verifier evidence")) {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/); assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), spec.tests);
        assert.equal(digest(fs.readFileSync(path.join(prepared.workspace, "package.json"))), packageHash);
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2);
        assert.ok(runtime.metrics.unexpectedTurns <= 1, "only one existing diagnosis, not an open repair loop, is allowed");
        if (variant === "reference") {
          assert.ok(verifications.every(event => event.isError === false), "the public reference must pass the actual public verifier");
          assert.ok(allConfiguredVerifierEvidenceCurrent(last.task, last.snapshot.digest, last.snapshot.workspaceRevisionDigest));
          assert.equal(last.task.trace.outcome, "completed", "the correct implementation must complete after all declared turns");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          assert.ok(last.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        } else {
          assert.ok(verifications.some(event => event.isError === true && /ERR_ASSERTION|AssertionError/.test(contentText(event.result?.content))),
            "the near-miss must fail an actual executable assertion, not setup or syntax");
          assert.ok(results.slice(implementationIndex).every(result => result.task.trace.outcome !== "completed"
            && result.settlement.taskStatus !== "completed"), "the wrong implementation must never be accepted, including intermediate operations");
        }
      } finally { await runtime.close(); }
    });
  });
}
