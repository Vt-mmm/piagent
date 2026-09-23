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

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const digest = value => createHash("sha256").update(value).digest("hex");
const prelude = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";

// Public request witnesses only: no grader, registered recipe, oracle or
// independent assessment authority is injected into these generated projects.
const tenantTests = prelude + `import { canManage } from '../src/backend/auth.js';
test('same-tenant active owners and admins are allowed', () => {
  assert.equal(canManage({ active: true, role: 'owner', tenantId: 'north' }, { tenantId: 'north' }), true);
  assert.equal(canManage({ active: true, role: 'admin', tenantId: 'north' }, { tenantId: 'north' }), true);
});
test('cross-tenant callers are denied', () => {
  assert.equal(canManage({ active: true, role: 'owner', tenantId: 'north' }, { tenantId: 'south' }), false);
  assert.equal(canManage({ active: true, role: 'admin', tenantId: 'south' }, { tenantId: 'north' }), false);
});
test('inactive users and other roles are denied', () => {
  for (const role of ['owner', 'admin']) {
    assert.equal(canManage({ active: false, role, tenantId: 'north' }, { tenantId: 'north' }), false);
  }
  for (const role of ['member', 'viewer', '', null, undefined]) {
    assert.equal(canManage({ active: true, role, tenantId: 'north' }, { tenantId: 'north' }), false);
  }
});
test('missing inputs and tenant identifiers are denied', () => {
  const user = { active: true, role: 'owner', tenantId: 'north' };
  assert.equal(canManage(), false);
  assert.equal(canManage(null, { tenantId: 'north' }), false);
  assert.equal(canManage(undefined, { tenantId: 'north' }), false);
  assert.equal(canManage(user, null), false);
  assert.equal(canManage(user, undefined), false);
  assert.equal(canManage({ active: true, role: 'owner' }, { tenantId: 'north' }), false);
  assert.equal(canManage(user, {}), false);
  assert.equal(canManage({ ...user, tenantId: '' }, { tenantId: '' }), false);
});
test('matching tenant identifiers must be non-empty strings', () => {
  assert.equal(canManage({ active: true, role: 'owner', tenantId: 7 }, { tenantId: 7 }), false);
  const shared = { id: 'north' };
  assert.equal(canManage({ active: true, role: 'admin', tenantId: shared }, { tenantId: shared }), false);
  assert.equal(canManage({ active: true, role: 'owner', tenantId: ['north'] }, { tenantId: ['north'] }), false);
});
`;

const revocationTests = prelude + `import { isCachedAccessUsable } from '../src/backend/revocation-cache.js';
const entry = (changes = {}) => ({ tenantId: 'north', userId: 'user-1', capability: 'edit',
  permissionRevision: 3, evaluatedAt: 10, expiresAt: 20, ...changes });
const request = (changes = {}) => ({ tenantId: 'north', userId: 'user-1', capability: 'edit',
  currentPermissionRevision: 3, now: 10, revokedAt: null, ...changes });
test('matching current grants are usable from evaluation until strictly before expiry', () => {
  assert.equal(isCachedAccessUsable(entry(), request()), true);
  assert.equal(isCachedAccessUsable(entry(), request({ now: 19 })), true);
  assert.equal(isCachedAccessUsable(entry(), request({ now: 20 })), false);
  assert.equal(isCachedAccessUsable(entry(), request({ now: 21 })), false);
  assert.equal(isCachedAccessUsable(entry({ evaluatedAt: 11 }), request()), false);
  assert.equal(isCachedAccessUsable(entry({ permissionRevision: -1, evaluatedAt: -2, expiresAt: 1 }),
    request({ currentPermissionRevision: -1, now: 0 })), true);
});
test('cached grants cannot cross tenant boundaries', () => {
  assert.equal(isCachedAccessUsable(entry(), request({ tenantId: 'south' })), false);
});
test('user capability and revision must match the current request', () => {
  assert.equal(isCachedAccessUsable(entry(), request({ userId: 'user-2' })), false);
  assert.equal(isCachedAccessUsable(entry(), request({ capability: 'delete' })), false);
  assert.equal(isCachedAccessUsable(entry(), request({ currentPermissionRevision: 4 })), false);
});
test('revocation at or before now invalidates the entry but future revocation does not', () => {
  assert.equal(isCachedAccessUsable(entry(), request({ revokedAt: 9 })), false);
  assert.equal(isCachedAccessUsable(entry(), request({ revokedAt: 10 })), false);
  assert.equal(isCachedAccessUsable(entry(), request({ revokedAt: 11 })), true);
  assert.equal(isCachedAccessUsable(entry(), request({ revokedAt: null })), true);
});
test('malformed objects and empty identifiers throw TypeError', () => {
  for (const invalid of [null, undefined, [], 1, 'entry', {}]) {
    assert.throws(() => isCachedAccessUsable(invalid, request()), TypeError);
    assert.throws(() => isCachedAccessUsable(entry(), invalid), TypeError);
  }
  for (const field of ['tenantId', 'userId', 'capability']) {
    for (const invalid of ['', null, 1, undefined]) {
      assert.throws(() => isCachedAccessUsable(entry({ [field]: invalid }), request()), TypeError);
      assert.throws(() => isCachedAccessUsable(entry(), request({ [field]: invalid })), TypeError);
    }
  }
});
test('all time and revision fields require finite integers and revokedAt allows only null or finite integer', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 0.25, '10', null, undefined]) {
    for (const field of ['permissionRevision', 'evaluatedAt', 'expiresAt']) {
      assert.throws(() => isCachedAccessUsable(entry({ [field]: invalid }), request()), TypeError);
    }
    for (const field of ['currentPermissionRevision', 'now']) {
      assert.throws(() => isCachedAccessUsable(entry(), request({ [field]: invalid })), TypeError);
    }
    if (invalid !== null) assert.throws(() => isCachedAccessUsable(entry(), request({ revokedAt: invalid })), TypeError);
  }
});
test('usable denied and malformed evaluations leave both arguments unchanged', () => {
  for (const input of [request(), request({ revokedAt: 10 }), request({ now: '10' })]) {
    const cached = entry(), beforeEntry = structuredClone(cached), beforeRequest = structuredClone(input);
    if (typeof input.now === 'string') assert.throws(() => isCachedAccessUsable(cached, input), TypeError);
    else isCachedAccessUsable(cached, input);
    assert.deepEqual(cached, beforeEntry);
    assert.deepEqual(input, beforeRequest);
  }
});
`;

// These explicit finite examples do not settle the separate large-integer or
// Number-arithmetic interpretation question in the plan of record.
const invoiceTests = prelude + `import { invoiceTotalCents } from '../src/backend/invoice.js';
test('omitted quantity defaults to one and omitted discount and tax default to zero', () => {
  assert.equal(invoiceTotalCents([{ unitCents: 101 }]), 101);
  assert.equal(invoiceTotalCents([{ unitCents: 101, quantity: 3 }]), 303);
  assert.equal(invoiceTotalCents([]), 0);
});
test('quantity multiplication precedes discount and each line rounds before summation', () => {
  assert.equal(invoiceTotalCents([{ unitCents: 101, quantity: 3, discountBps: 2500 }]), 227);
  assert.equal(invoiceTotalCents([{ unitCents: 1, discountBps: 5000 },
    { unitCents: 1, discountBps: 5000 }]), 2);
});
test('tax applies once after rounded line totals and the invoice rounds once more', () => {
  assert.equal(invoiceTotalCents([{ unitCents: 1 }, { unitCents: 1 }, { unitCents: 1 }], 5000), 5);
  assert.equal(invoiceTotalCents([{ unitCents: 199, quantity: 2, discountBps: 1250 }], 825), 377);
});
test('zero money and inclusive basis point endpoints are valid', () => {
  assert.equal(invoiceTotalCents([{ unitCents: 0, quantity: 1, discountBps: 0 }], 0), 0);
  assert.equal(invoiceTotalCents([{ unitCents: 99, quantity: 1, discountBps: 10000 }], 10000), 0);
  assert.equal(invoiceTotalCents([{ unitCents: 101, quantity: 1, discountBps: 0 }], 10000), 202);
});
test('negative and non-integer money or quantity throws TypeError and quantity is positive', () => {
  for (const unitCents of [-1, 0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => invoiceTotalCents([{ unitCents, quantity: 1 }]), TypeError);
  }
  for (const quantity of [0, -1, 0.5, NaN, Infinity, '1']) {
    assert.throws(() => invoiceTotalCents([{ unitCents: 1, quantity }]), TypeError);
  }
});
test('discount and tax reject values outside the inclusive integer basis point range', () => {
  for (const invalid of [-1, 10001, 0.5, NaN, Infinity, '1']) {
    assert.throws(() => invoiceTotalCents([{ unitCents: 1, discountBps: invalid }]), TypeError);
    assert.throws(() => invoiceTotalCents([{ unitCents: 1 }], invalid), TypeError);
  }
});
`;

const scenarios = [
  { id: "tenant-role-authorization", lifecycle: "steady-state", turns: ["request"], tests: tenantTests,
    variants: ["helper-reference", "public-contract-implementation", "cross-tenant-mutant"],
    source(reference, variant) {
      if (variant === "helper-reference") return reference;
      const candidate = reference;
      return variant === "public-contract-implementation" ? candidate : candidate.replace(" && user.tenantId === resource.tenantId", "");
    }, failureWitness: "cross-tenant callers are denied" },
  { id: "revoked-session-cache", lifecycle: "steady-state", turns: ["request", "recover"], tests: revocationTests,
    variants: ["helper-reference", "cross-tenant-mutant"],
    source: (reference, variant) => variant === "helper-reference" ? reference
      : reference.replace("return entry.tenantId === request.tenantId\n    && ", "return "),
    failureWitness: "cached grants cannot cross tenant boundaries" },
  { id: "invoice-rounding", lifecycle: "cold-start", turns: ["request"], tests: invoiceTests,
    variants: ["helper-reference", "quantity-default-mutant"],
    source: (reference, variant) => variant === "helper-reference" ? reference : reference.replace("line?.quantity ?? 1", "line?.quantity ?? 2"),
    failureWitness: "omitted quantity defaults to one and omitted discount and tax default to zero" }
];

for (const fixture of scenarios) for (const variant of fixture.variants) {
  test(`actual backend journey through loopback HTTP/WebSocket: ${fixture.id}/${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-backend-transport-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, fixture.id);
    assert.equal(prepared.scenario.profile, "backend-api");
    assert.equal(prepared.scenario.lifecycle, fixture.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => turn.id), fixture.turns);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(Object.hasOwn(turn, "workflow"), false);
      assert.equal(turn.reconnectBefore === true, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain === true, false);
    }
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const [sourcePath, reference] = productionV3ReferenceSolution(fixture.id);
    const source = fixture.source(reference, variant), mutant = variant.endsWith("-mutant");
    if (mutant) assert.notEqual(source, reference); else assert.equal(source, reference);
    const testPath = "test/backend-public.test.js";
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const finalAnswer = mutant || (fixture.id === "tenant-role-authorization" && variant === "helper-reference")
      ? "The configured verification detects a public contract violation. The implementation is incomplete; no successful task completion is claimed."
      : "Implemented the requested public contract and ran configured project verification. The requested work is complete if all current acceptance obligations are established.";
    const scripts = [
      [scriptedTool("backend-read-source", "read", { path: sourcePath }),
        scriptedTool("backend-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("backend-write-tests", "write", { path: testPath, content: fixture.tests }),
        ...commands.map((command, index) => scriptedTool(`backend-implement-verify-${index}`, "bash", { command })), scriptedText(finalAnswer)],
      [scriptedTool("backend-recover-source", "read", { path: sourcePath }),
        scriptedTool("backend-recover-tests", "read", { path: testPath }),
        ...commands.map((command, index) => scriptedTool(`backend-recover-verify-${index}`, "bash", { command })), scriptedText(finalAnswer)]
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
          result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          result.durableReplay = durableReplay;
          result.currentVerification = Boolean(result.task && allConfiguredVerifierEvidenceCurrent(result.task,
            result.verificationSnapshot.digest, result.verificationSnapshot.workspaceRevisionDigest));
          results.push(result);
          t.diagnostic(JSON.stringify({ scenario: fixture.id, variant, turn: turn.id, profile: prepared.scenario.profile,
            lifecycle: prepared.scenario.lifecycle, promptSha256: digest(turn.message), sourceSha256: digest(source), testSha256: digest(fixture.tests),
            sessionRef: result.sessionRef, operationRef: result.operationRef, receipt: result.receipt,
            settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId,
              operatorRequest: result.task.operatorRequest, outcome: result.task.trace.outcome, changeMode: result.task.changeMode,
              verifyCommands: result.task.verifyCommands, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerification: result.currentVerification, durableReplay, scriptedTurns: result.scriptedTurns,
            unconsumedScript: result.unconsumedScript, metrics: runtime.metrics }));
        }
        // Completion assertions are deliberately after every declared turn has
        // traversed the real ingress and produced observable task/wire evidence.
        const first = results[0], last = results.at(-1), transport = runtime.transport.snapshot();
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
          && /^backend-(?:implement|recover)-verify-/.test(event.toolCallId));
        const failures = verifications.filter(event => event.isError === true);
        t.diagnostic(JSON.stringify({ scenario: fixture.id, variant, transport, metrics: runtime.metrics,
          verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: textContent(event.result?.content) })),
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []);
        assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.ok(runtime.metrics.unexpectedTurns <= (failures.length ? 1 : 0), "only a real failed verifier may trigger one bounded diagnosis");
        assert.equal(transport.kind, "loopback-http-websocket");
        assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1);
        assert.equal(transport.connections, fixture.turns.length);
        assert.equal(transport.reconnects, fixture.turns.length - 1);
        assert.equal(transport.commandDispatches, fixture.turns.length);
        assert.equal(transport.uncertainSends, 0);
        assert.equal(transport.droppedConnections, 0);
        assert.equal(new Set(results.map(result => result.sessionRef)).size, 1);
        assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
        assert.equal(new Set(results.map(result => result.operationRef)).size, fixture.turns.length);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0);
          assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(Object.hasOwn(result.command.payload, "workflow"), false);
          assert.equal(result.wireSettlement.kind, "operation.settled");
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.receipt.sessionRef);
          assert.equal(result.settlement.operationRef, result.receipt.operationRef);
          assert.equal(result.settlement.sessionRef, result.sessionRef);
          assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled"
            && event.payload.operationRef === result.operationRef).length, 1);
          assert.ok(result.task, "a source request must retain a governed durable task");
          assert.equal(result.task.taskRunId, first.task.taskRunId);
          assert.equal(result.task.sessionId, result.sessionId);
          assert.equal(result.task.operatorRequest, prepared.turns[0].message);
          assert.equal(result.task.changeMode, "source-change");
          if (index > 0) assert.equal(result.scriptedTurns, result.durableReplay ? 0 : scripts[index].length,
            "reconnect must not cause another unscripted model diagnosis");
        }
        const recoveredWithTools = results.length > 1 && !last.durableReplay;
        assert.deepEqual(verifications.map(event => event.toolCallId), [
          ...commands.map((_, index) => `backend-implement-verify-${index}`),
          ...(recoveredWithTools ? commands.map((_, index) => `backend-recover-verify-${index}`) : [])]);
        for (const event of verifications) {
          const output = textContent(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.match(event.toolCallId, /^backend-recover-/);
            assert.ok(first.task.verifyEvidence.some(item => verificationEvidenceProvesStableTree(item,
              last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest)));
            assert.deepEqual(last.task.verifyEvidence, first.task.verifyEvidence);
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
            assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        if (last.durableReplay) {
          assert.deepEqual(last.task.verifyEvidence, first.task.verifyEvidence);
          assert.equal(last.verificationSnapshot.digest, first.verificationSnapshot.digest);
          assert.equal(last.verificationSnapshot.workspaceRevisionDigest, first.verificationSnapshot.workspaceRevisionDigest);
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), fixture.tests);
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2,
          "recovery must not duplicate implementation writes");
        if (mutant) {
          assert.ok(failures.length > 0, "the wrong implementation must fail the actual public verifier");
          const output = failures.map(event => textContent(event.result?.content)).join("\n");
          assert.match(output, /ERR_ASSERTION/);
          assert.match(output, new RegExp(`(?:✖ |not ok \\d+ - )${fixture.failureWitness}`));
          assert.equal(last.currentVerification, false);
          assert.ok(results.every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        } else {
          assert.ok(verifications.every(event => event.isError === false), "the supplied candidate must satisfy the executable public contract");
          assert.equal(last.currentVerification, true);
          assert.equal(last.task.trace.outcome, "completed", "a correct current candidate must really complete after all declared journey turns");
          assert.equal(last.settlement.taskStatus, "completed");
          assert.equal(last.settlement.settlement, "completed");
          assert.equal(last.settlement.reasonCode, null);
          assert.ok(last.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        }
      } finally { await runtime.close(); }
    });
  });
}
