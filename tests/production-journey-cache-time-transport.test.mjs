import { assertJourneyAcceptance } from "./helpers/production-journey-acceptance-mode.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { buildWorkflowFollowUp } from "../packages/piagent-core/runtime/workflows/workflow-follow-up.ts";
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const projectStatus = cwd => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8" });
const prelude = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";

// Finite executable witnesses of the unchanged public clauses. They are not a
// hidden grader, registered recipe, or authority for whole-domain acceptance.
const cases = [
  { id: "tenant-cache-isolation", profile: "backend-api", lifecycle: "steady-state", implementationIndex: 1,
    turns: [["scout", "scout"], ["implement", "task"], ["verify", "review"]],
    scout: "Inspected the cache implementation and package commands without editing. Its key omits tenant identity and concatenates entity and id with punctuation, so both cross-tenant and delimiter collisions are possible. Use all three components without ambiguous encoding, preserve set/get and the class, add isolation and punctuation witnesses, then run focused and configured project checks.",
    mutate: source => source.replace("JSON.stringify([tenantId, entity, id])", "[tenantId, entity, id].join(':')"),
    failureWitness: "punctuation cannot make different identity tuples collide",
    tests: prelude + `import { TenantCache } from '../src/backend/cache.js';
test('all three identity components independently isolate entries', () => {
  const cache = new TenantCache();
  cache.set('north', 'invoice', '1', 'first');
  cache.set('south', 'invoice', '1', 'other tenant');
  cache.set('north', 'user', '1', 'other entity');
  cache.set('north', 'invoice', '2', 'other id');
  assert.equal(cache.get('north', 'invoice', '1'), 'first');
  assert.equal(cache.get('south', 'invoice', '1'), 'other tenant');
  assert.equal(cache.get('north', 'user', '1'), 'other entity');
  assert.equal(cache.get('north', 'invoice', '2'), 'other id');
});
test('punctuation cannot make different identity tuples collide', () => {
  const cache = new TenantCache();
  cache.set('tenant:a', 'b', 'c', 'tenant punctuation');
  cache.set('tenant', 'a:b', 'c', 'entity punctuation');
  cache.set('tenant', 'a', 'b:c', 'id punctuation');
  assert.equal(cache.get('tenant:a', 'b', 'c'), 'tenant punctuation');
  assert.equal(cache.get('tenant', 'a:b', 'c'), 'entity punctuation');
  assert.equal(cache.get('tenant', 'a', 'b:c'), 'id punctuation');
  cache.set('x|y', '[entity]', '"id"', 'quoted');
  cache.set('x', 'y|[entity]', '"id"', 'pipe');
  assert.equal(cache.get('x|y', '[entity]', '"id"'), 'quoted');
  assert.equal(cache.get('x', 'y|[entity]', '"id"'), 'pipe');
});
test('the existing class set/get API updates only the exact key and instances stay independent', () => {
  const first = new TenantCache(), second = new TenantCache();
  first.set('tenant', 'entity', '1', { count: 1 });
  first.set('tenant', 'entity', '2', 'kept');
  first.set('tenant', 'entity', '1', { count: 2 });
  second.set('tenant', 'entity', '1', 'separate');
  assert.deepEqual(first.get('tenant', 'entity', '1'), { count: 2 });
  assert.equal(first.get('tenant', 'entity', '2'), 'kept');
  assert.equal(second.get('tenant', 'entity', '1'), 'separate');
  assert.equal(second.get('tenant', 'entity', '2'), undefined);
});
` },
  { id: "expiry-boundary", profile: "node-typescript", lifecycle: "steady-state", implementationIndex: 1,
    turns: [["scout", undefined], ["implement", undefined], ["verify", undefined]],
    scout: "Inspected the expiry implementation and package commands without editing. Equality currently uses a strict greater-than check; invalid expiry returns false and now is coerced. Implement inclusive expiry, explicit Date/ISO and Date/number handling, TypeError for invalid values, and no current-clock fallback for explicit falsey inputs. Preserve input dates and the API, add focused boundary tests, then verify the project.",
    mutate: source => source.replace("return current >= timestamp;", "return current > timestamp;"),
    failureWitness: "expiry is inclusive for both supported representations",
    tests: prelude + `import { isExpired } from '../src/reliability/expiry.js';
test('expiry is inclusive for both supported representations', () => {
  const iso = '1970-01-01T00:00:01.000Z', date = new Date(1000);
  assert.equal(isExpired(iso, 999), false);
  assert.equal(isExpired(iso, 1000), true);
  assert.equal(isExpired(iso, 1001), true);
  assert.equal(isExpired(date, new Date(999)), false);
  assert.equal(isExpired(date, new Date(1000)), true);
  assert.equal(isExpired(date, new Date(1001)), true);
});
test('ISO offsets and fractional seconds identify the actual instant', () => {
  assert.equal(isExpired('2024-03-01T00:30:00+01:00', Date.parse('2024-02-29T23:30:00Z')), true);
  assert.equal(isExpired('2024-02-29T23:30:00-01:00', Date.parse('2024-03-01T00:30:00Z') - 1), false);
  assert.equal(isExpired('1970-01-01T00:00:00.001Z', 0), false);
  assert.equal(isExpired('1970-01-01T00:00:00.001Z', 1), true);
});
test('explicit falsey now never consults the current clock', () => {
  const original = Date.now;
  Date.now = () => { throw new Error('machine clock must not be used'); };
  try {
    assert.equal(isExpired('1970-01-01T00:00:01Z', 0), false);
    assert.equal(isExpired('1970-01-01T00:00:00Z', -0), true);
    for (const now of [undefined, null, false, '', NaN]) {
      assert.throws(() => isExpired('1970-01-01T00:00:01Z', now), TypeError);
    }
  } finally { Date.now = original; }
});
test('invalid dates and unsupported input types throw TypeError', () => {
  for (const expiresAt of [new Date(NaN), '', 'not-a-date', '2023-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z', '2024-13-01T00:00:00Z', '2024-01-01T25:00:00Z', null, undefined, 0]) {
    assert.throws(() => isExpired(expiresAt, 0), TypeError);
  }
  for (const now of [new Date(NaN), Infinity, -Infinity, '1000', {}, []]) {
    assert.throws(() => isExpired('1970-01-01T00:00:01Z', now), TypeError);
  }
});
test('omitted now preserves arity and reads the clock after expiry validation', () => {
  const original = Date.now; let reads = 0;
  Date.now = () => { reads += 1; return 1000; };
  try {
    assert.equal(isExpired.length, 1);
    assert.equal(isExpired('1970-01-01T00:00:01.000Z'), true);
    assert.equal(reads, 1);
    assert.equal(isExpired('1970-01-01T00:00:01.001Z'), false);
    assert.equal(reads, 2);
    assert.throws(() => isExpired(new Date(NaN)), TypeError);
    assert.equal(reads, 2);
    assert.throws(() => isExpired('1970-01-01T00:00:01.000Z', undefined), TypeError);
    assert.equal(reads, 2);
  } finally { Date.now = original; }
});
test('Date input values remain unchanged', () => {
  const expiry = new Date(1000), now = new Date(999);
  assert.equal(isExpired(expiry, now), false);
  assert.equal(expiry.getTime(), 1000);
  assert.equal(now.getTime(), 999);
});
` },
  { id: "billing-cutoff-clock-skew", profile: "backend-api", lifecycle: "cold-start", implementationIndex: 0,
    turns: [["request", undefined], ["recover", undefined]],
    mutate: source => source.replace("event.occurredAt < period.startsAt", "event.occurredAt <= period.startsAt"),
    failureWitness: "billing occurrences use the half-open period boundaries",
    tests: prelude + `import { billingBucket } from '../src/backend/billing-window.js';
const period = (changes = {}) => ({ startsAt: 10, endsAt: 20, maxClockSkewMs: 2, ...changes });
const event = (changes = {}) => ({ occurredAt: 10, receivedAt: 10, ...changes });
test('billing occurrences use the half-open period boundaries', () => {
  assert.equal(billingBucket(event({ occurredAt: 9 }), period()), 'outside');
  assert.equal(billingBucket(event(), period()), 'current');
  assert.equal(billingBucket(event({ occurredAt: 19, receivedAt: 19 }), period()), 'current');
  assert.equal(billingBucket(event({ occurredAt: 20, receivedAt: 20 }), period()), 'outside');
});
test('clock skew and late receipt have their exact inclusive and exclusive boundaries', () => {
  assert.equal(billingBucket(event({ receivedAt: 8 }), period()), 'current');
  assert.equal(billingBucket(event({ receivedAt: 7 }), period()), 'invalid-clock');
  assert.equal(billingBucket(event({ receivedAt: 21 }), period()), 'current');
  assert.equal(billingBucket(event({ receivedAt: 22 }), period()), 'late');
  assert.equal(billingBucket(event({ receivedAt: 23 }), period()), 'late');
  assert.equal(billingBucket(event({ receivedAt: 9 }), period({ maxClockSkewMs: 0 })), 'invalid-clock');
  assert.equal(billingBucket(event({ receivedAt: 20 }), period({ maxClockSkewMs: 0 })), 'late');
});
test('outside occurrence takes precedence and negative integer timestamps remain valid', () => {
  assert.equal(billingBucket(event({ occurredAt: 9, receivedAt: 0 }), period()), 'outside');
  assert.equal(billingBucket(event({ occurredAt: 20, receivedAt: 100 }), period()), 'outside');
  assert.equal(billingBucket({ occurredAt: -5, receivedAt: -5 }, { startsAt: -10, endsAt: 0, maxClockSkewMs: 0 }), 'current');
});
test('each time and skew field must be finite integer and the period must increase', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 0.5, '10', null, undefined]) {
    for (const field of ['occurredAt', 'receivedAt']) assert.throws(() => billingBucket(event({ [field]: invalid }), period()), TypeError);
    for (const field of ['startsAt', 'endsAt', 'maxClockSkewMs']) assert.throws(() => billingBucket(event(), period({ [field]: invalid })), TypeError);
  }
  assert.throws(() => billingBucket(event(), period({ maxClockSkewMs: -1 })), TypeError);
  assert.throws(() => billingBucket(event(), period({ endsAt: 10 })), TypeError);
  assert.throws(() => billingBucket(event(), period({ endsAt: 9 })), TypeError);
  for (const invalid of [null, undefined, 1, '', {}]) {
    assert.throws(() => billingBucket(invalid, period()), TypeError);
    assert.throws(() => billingBucket(event(), invalid), TypeError);
  }
});
test('all outcomes and validation failures leave event and period unchanged', () => {
  for (const changes of [{}, { occurredAt: 9 }, { receivedAt: 7 }, { receivedAt: 22 }, { receivedAt: '10' }]) {
    const input = event(changes), window = period(), before = structuredClone([input, window]);
    if (typeof input.receivedAt === 'string') assert.throws(() => billingBucket(input, window), TypeError);
    else billingBucket(input, window);
    assert.deepEqual([input, window], before);
  }
});
` }
];

for (const spec of cases) for (const variant of ["reference", "public-mutant"]) {
  test(`generated-package cache/time journey through HTTP/WebSocket: ${spec.id}/${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-cache-time-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, spec.id);
    assert.equal(prepared.scenario.profile, spec.profile);
    assert.equal(prepared.scenario.lifecycle, spec.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => [turn.id, turn.workflow]), spec.turns);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.reconnectBefore === true, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain === true, declared.receiptUncertain === true);
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(spec.id);
    const source = variant === "reference" ? reference : spec.mutate(reference);
    if (variant !== "reference") assert.notEqual(source, reference);
    const testPath = "test/cache-time-public.test.js", initialSource = fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8");
    const initialStatus = projectStatus(prepared.workspace);
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const projectSettings = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/settings.json"), "utf8"));
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const scripts = prepared.turns.map((turn, index) => index < spec.implementationIndex ? [
      scriptedTool(`ct-${index}-source`, "read", { path: sourcePath }),
      scriptedTool(`ct-${index}-package`, "read", { path: "package.json" }), scriptedText(spec.scout)
    ] : [
      scriptedTool(`ct-${index}-source`, "read", { path: sourcePath }),
      ...(index === spec.implementationIndex ? [
        scriptedTool("ct-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("ct-write-tests", "write", { path: testPath, content: spec.tests })
      ] : [scriptedTool(`ct-${index}-tests`, "read", { path: testPath }),
        scriptedTool(`ct-${index}-focused`, "bash", { command: `node --test ${testPath}` })]),
      ...commands.map((command, commandIndex) => scriptedTool(`ct-${index}-verify-${commandIndex}`, "bash", { command })),
      scriptedTool(`ct-${index}-diff`, "bash", { command: `git diff -- ${sourcePath}` }),
      scriptedText(variant === "reference"
        ? "The requested implementation and public witnesses were reviewed, the configured checks were run, and the diff remains scoped. Report the observed result and any unmet original obligations honestly."
        : "The public verifier detects the incorrect boundary behavior. The task remains incomplete; no additional edits or successful completion are claimed.")
    ]);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir,
        repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const durableReplay = turn.id === "recover" && results[spec.implementationIndex]?.task?.trace.outcome === "completed";
          const result = await runtime.turn(turn, durableReplay ? [] : scripts[index]);
          result.durableReplay = durableReplay;
          result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          result.status = projectStatus(prepared.workspace);
          result.sourceSha256 = sha(fs.readFileSync(path.join(prepared.workspace, sourcePath)));
          results.push(result);
          const checks = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && new RegExp(`^ct-${index}-(?:verify-|focused)`).test(event.toolCallId));
          t.diagnostic(JSON.stringify({ scenario: spec.id, variant, turn: turn.id, profile: spec.profile, lifecycle: spec.lifecycle,
            promptSha256: sha(turn.message), expectedSourceSha256: sha(source), sourceSha256: result.sourceSha256,
            expectedTestSha256: sha(spec.tests), testSha256: fs.existsSync(path.join(prepared.workspace, testPath))
              ? sha(fs.readFileSync(path.join(prepared.workspace, testPath))) : null,
            projectResources: runtime.projectResources, receipt: result.receipt, recovery: result.recovery,
            sessionRef: result.sessionRef, operationRef: result.operationRef, settlement: result.settlement,
            wireSettlement: result.wireSettlement, transport: result.transport, durableReplay,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, operatorRequest: result.task.operatorRequest,
              outcome: result.task.trace.outcome, changeMode: result.task.changeMode, mutationPolicy: result.task.mutationPolicy,
              observedChangedFiles: result.task.observedChangedFiles, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerification: result.task && allConfiguredVerifierEvidenceCurrent(result.task,
              result.verificationSnapshot.digest, result.verificationSnapshot.workspaceRevisionDigest),
            checks: checks.map(event => ({ id: event.toolCallId, isError: event.isError, output: textContent(event.result?.content) })),
            scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript, metrics: runtime.metrics }));
        }
        const implementation = results[spec.implementationIndex], last = results.at(-1), transport = runtime.transport.snapshot();
        const verification = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^ct-\d+-verify-/.test(event.toolCallId));
        const failed = verification.filter(event => event.isError === true);
        t.diagnostic(JSON.stringify({ scenario: spec.id, variant, declaredTurns: prepared.turns.length, observedTurns: results.length,
          projectResources: runtime.projectResources, transport, metrics: runtime.metrics,
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        const pendingImplementation = implementation.task.trace.outcome === "pending"
          && implementation.task.acceptanceReceipt.criteria.some(criterion => criterion.status !== "satisfied");
        assert.ok(runtime.metrics.unexpectedTurns <= (pendingImplementation ? 1 : 0),
          "an unresolved original obligation may trigger at most one existing diagnostic; completed tasks need none");
        assert.ok(runtime.projectResources.length > 0);
        for (const resources of runtime.projectResources) {
          assert.deepEqual(resources.packages, projectSettings.packages);
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-core/extensions/piagent-guard.ts")));
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts")));
        }
        const reconnects = prepared.turns.filter(turn => turn.reconnectBefore).length;
        assert.equal(transport.kind, "loopback-http-websocket"); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.connections, reconnects + 1); assert.equal(transport.reconnects, reconnects);
        assert.equal(transport.commandDispatches, prepared.turns.length); assert.equal(transport.bootstrapCount, 1);
        assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
        assert.equal(new Set(results.map(result => result.operationRef)).size, prepared.turns.length);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, prepared.turns[index].workflow);
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.sessionRef);
          assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(result.receipt.sessionRef, result.sessionRef);
          assert.equal(result.receipt.operationRef, result.operationRef);
          assert.equal(result.sessionRef, results[0].sessionRef);
          assert.ok(result.task); assert.equal(result.task.sessionId, result.sessionId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled" && event.payload.operationRef === result.operationRef).length, 1);
          if (index < spec.implementationIndex) {
            assert.equal(result.task.changeMode, "read-only");
            assert.equal(result.task.mutationPolicy, "forbidden");
            assert.equal(result.status, initialStatus);
            assert.equal(result.sourceSha256, sha(initialSource));
            assert.deepEqual(result.task.observedChangedFiles, []);
            assert.equal(result.task.trace.outcome, "completed", "the read-only scout must actually complete");
            assert.notEqual(result.task.taskRunId, implementation.task.taskRunId);
          } else if (index > spec.implementationIndex) {
            assert.equal(result.sourceSha256, implementation.sourceSha256);
            assert.equal(result.verificationSnapshot.digest, implementation.verificationSnapshot.digest);
            assert.equal(result.verificationSnapshot.workspaceRevisionDigest, implementation.verificationSnapshot.workspaceRevisionDigest);
            assert.equal(result.scriptedTurns, result.durableReplay ? 0 : scripts[index].length);
            if (implementation.task.trace.outcome !== "completed") assert.equal(result.task.taskRunId, implementation.task.taskRunId,
              "an unresolved implementation cannot disappear into a replacement review task");
          }
        }
        const implementationTurn = prepared.turns[spec.implementationIndex];
        assert.equal(implementation.task.operatorRequest, implementationTurn.workflow
          ? buildWorkflowFollowUp(implementationTurn.workflow, implementationTurn.message) : implementationTurn.message);
        assert.equal(implementation.task.changeMode, "source-change");
        assert.deepEqual(verification.map(event => event.toolCallId), results.flatMap((result, index) => index < spec.implementationIndex || result.durableReplay
          ? [] : commands.map((_, commandIndex) => `ct-${index}-verify-${commandIndex}`)));
        for (const event of verification) {
          const output = textContent(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.ok(implementation.task.verifyEvidence.some(item => verificationEvidenceProvesStableTree(item,
              last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest)));
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
            assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), spec.tests);
        if (variant === "public-mutant") {
          assert.ok(failed.length > 0, "the near-miss must fail the actual configured verifier");
          const output = failed.map(event => textContent(event.result?.content)).join("\n");
          assert.match(output, /ERR_ASSERTION/);
          assert.match(output, new RegExp(`(?:✖ |not ok \\d+ - )${spec.failureWitness}`));
          assert.ok(results.slice(spec.implementationIndex).every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        } else {
          assert.ok(verification.every(event => event.isError === false), "the immutable shared reference must satisfy the public witnesses");
          assert.equal(allConfiguredVerifierEvidenceCurrent(implementation.task,
            last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest), true);
          assert.equal(last.task.trace.outcome, "completed", "the final declared review or recovery must complete");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          const completedImplementation = implementation.task.trace.outcome === "completed" ? implementation.task : last.task;
          if (prepared.scenario.id === "expiry-boundary") assertJourneyAcceptance(repositoryRoot, completedImplementation, completedImplementation);
          else assert.ok(completedImplementation.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        }
      } finally { await runtime.close(); }
    });
  });
}
