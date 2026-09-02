import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openAcceptanceEvidenceStore } from "../packages/piagent-core/extensions/acceptance-evidence-store.js";
import { createDurableContractRunner } from "../packages/piagent-core/extensions/acceptance-durable-execution.js";
import { createAuthenticatedAdmission, currentAuthenticatedAssessment } from "../packages/piagent-core/extensions/acceptance-authenticated-admission.js";
import { registerIndependentAcceptanceProvider } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { independentVerificationRecovery } from "../packages/piagent-core/runtime/recovery/independent-verification-recovery.ts";
import { selectRecoveryDecision, recoveryDecisionValidationErrors } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { checkpointSources } from "./helpers/async-production-cases.mjs";
import { checkpointFamilyCases as checkpointCases } from "./helpers/production-family-cases.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const scope = { taskRunId: "task-1", criterionId: "sum" };
const request = { scope, criterionHash: "a".repeat(64), maxAttempts: 3 };
const checks = () => [{ id: "sum", cases: [{ id: "sum-1", args: [{ type: "number", value: 2 }, { type: "number", value: 3 }],
  expected: { outcome: "return", value: { type: "number", value: 5 } } }] }];

test("async checkpoint observations survive authenticated persistence, reopening and exact-plan invalidation", integration, async context => {
  const f = fixture(context);
  fs.writeFileSync(f.sourceFile, checkpointSources[0]);
  const cases = checkpointCases(), options = { ...f.options, exportName: "resumeWork", checks: [{ id: "checkpoint", cases }] };
  const runner = createDurableContractRunner(options);
  // Caller mutation cannot grant more callback behavior after approval.
  cases[0].callbacks[0].repeatLast = false;
  const first = await runner.run(request), receipt = await runner.assess(first, { policy: "allow" });
  assert.equal(receipt.verdict, "pass", JSON.stringify(receipt));
  assert.equal(receipt.completionAllowed, true);
  assert.equal(first.evidence.observed.result.execution.observation.cases[0].errorObservation.identity, "failed");
  assert.deepEqual(first.evidence.observed.result.execution.observation.cases[0].referenceIdentity, [{ id: "fresh-checkpoint", same: false }]);
  const attemptId = first.attemptId;
  f.store.close();
  const reopened = f.open(), currentOptions = { ...options, store: reopened, checks: [{ id: "checkpoint", cases: checkpointCases() }] };
  const restored = createDurableContractRunner(currentOptions), cached = await restored.run(request);
  assert.equal(cached.reused, true); assert.equal(cached.attemptId, attemptId);
  assert.equal((await restored.assess(cached, { policy: "allow" })).completionAllowed, true);
  const altered = checkpointCases(); altered[0].referencePairs[0].right.path = ["results"];
  const changed = await createDurableContractRunner({ ...currentOptions, checks: [{ id: "checkpoint", cases: altered }] }).run(request);
  assert.equal(changed.reused, false); assert.notEqual(changed.attemptId, attemptId);
  assert.equal(reopened.latest(scope).attempt, 2);
  assert.equal((await restored.assess(cached, { policy: "allow" })).completionAllowed, false);
});

function fixture(context) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-durable-execution-")));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project"), authority = path.join(directory, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  git(projectRoot, "init", "-q"); git(projectRoot, "config", "user.name", "Test"); git(projectRoot, "config", "user.email", "test@example.com");
  const sourceFile = path.join(projectRoot, "sum.mjs"); fs.writeFileSync(sourceFile, "export const sum = (a, b) => a + b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "test baseline");
  const storeOptions = { filePath: path.join(authority, "evidence.sqlite"), projectRoot, key: createSecretKey(randomBytes(32)) };
  const stores = []; context.after(() => { for (const store of stores) store.close(); });
  const open = () => { const store = openAcceptanceEvidenceStore(storeOptions); stores.push(store); return store; };
  const store = open();
  const options = { projectRoot, sourcePath: "sum.mjs", authorizeSourceRead: () => true, checks: checks(), exportName: "sum",
    imageId: imageId ?? `sha256:${"b".repeat(64)}`, dockerSocket: dockerSocket ?? "/unavailable-piagent-test.sock", verifierDigest: "c".repeat(64),
    getProjectVerificationDigest: () => "d".repeat(64), store };
  return { projectRoot, sourceFile, options, open, store, storeOptions };
}

function recoveryFor(context, options, receipt) {
  const task = { ...scope, taskId: "sum", sessionId: "session-1", acceptanceReceipt: { criteria: [{ id: scope.criterionId, hash: request.criterionHash }] } };
  context.after(registerIndependentAcceptanceProvider(options.projectRoot, task, () => ({ projectVerificationDigest: "d".repeat(64),
    entries: [{ criterionId: scope.criterionId, criterionHash: request.criterionHash, receipt }] })));
  const recovery = independentVerificationRecovery(options.projectRoot, task, receipt.workingTreeDigest);
  assert.ok(recovery, JSON.stringify(receipt));
  const decision = selectRecoveryDecision({ featureEnabled: true, task: { taskId: "sum", taskRunId: scope.taskRunId, attempt: 1, maxAttempts: 2, changeMode: "source-change" },
    classification: recovery.classification, currentPhase: "verify", proposedHypothesisRef: recovery.hypothesisRef,
    independentDisposition: recovery.independentDisposition, exactVerifierAvailable: true });
  assert.deepEqual(recoveryDecisionValidationErrors(decision), []);
  assert.equal(decision.sourceMutationAllowed, false);
  return { recovery, decision };
}

test("missing current project verification and pre-cancellation reserve no attempt", async (context) => {
  const { options, store } = fixture(context);
  const missing = createDurableContractRunner({ ...options, getProjectVerificationDigest: () => null });
  assert.equal((await missing.run(request)).reason, "current-project-verifier-missing");
  assert.equal(store.latest(scope), null);
  const cancelled = createDurableContractRunner(options);
  assert.equal((await cancelled.run({ ...request, signal: AbortSignal.abort() })).reason, "cancelled-before-reservation");
  assert.equal(store.latest(scope), null);
});

test("durable admission authenticates structured sequence results and their complete counterexample history", integration, async (context) => {
  const f = fixture(context), record = (total) => ({ type: "record", value: [{ key: "total", value: { type: "number", value: total } }] });
  fs.writeFileSync(f.sourceFile, "let total=0; export function sum(input){ total+=input.total; return {total}; }\n");
  const history = [{ id: "history", cases: [
    { id: "one", sequence: "sum-history", args: [record(2)], expected: { outcome: "return", value: record(2) } },
    { id: "two", sequence: "sum-history", args: [record(3)], expected: { outcome: "return", value: record(5) } }
  ] }];
  const runner = createDurableContractRunner({ ...f.options, checks: history });
  const first = await runner.run(request), accepted = await runner.assess(first, { policy: "allow" });
  assert.equal(accepted.verdict, "pass", JSON.stringify(accepted));
  assert.equal(accepted.completionAllowed, true);
  const cached = await runner.run(request);
  assert.equal(cached.reused, true);
  assert.equal(f.store.latest(scope).attempt, 1);
  fs.writeFileSync(f.sourceFile, "let total=0; export function sum(input){ total+=input.total+(total>0?1:0); return {total}; }\n");
  const failed = await runner.run(request), rejected = await runner.assess(failed, { policy: "allow" });
  assert.equal(rejected.verdict, "fail", JSON.stringify(rejected));
  assert.equal(rejected.repairEligible, true);
  assert.equal(rejected.sourceMutationAllowed, false);
  assert.deepEqual(rejected.counterexamples[0].evidence.input.prefix.map((item) => item.id), ["one", "two"]);
  assert.deepEqual(rejected.counterexamples[0].evidence.observed.value, record(6));
  assert.equal(f.store.latest(scope).attempt, 2);
});

test("unavailable backend errors are durably settled without implicit retries", async (context) => {
  const { options, store } = fixture(context);
  const runner = createDurableContractRunner({ ...options, dockerSocket: "/piagent-test-backend-does-not-exist.sock" });
  const first = await runner.run(request);
  assert.equal(first.verdict, "error"); assert.equal(first.reused, false); assert.equal(first.completionAllowed, false);
  const assessment = await runner.assess(first, { policy: "allow" });
  assert.equal(assessment.verdict, "error", JSON.stringify(assessment));
  assert.ok(assessment.reasons.includes("local-backend-unavailable"));
  assert.equal(assessment.repairEligible, false);
  assert.equal(recoveryFor(context, options, assessment).decision.action, "ask-operator");
  const second = await runner.run(request);
  assert.equal(second.verdict, "error"); assert.equal(second.reused, true);
  assert.equal(store.latest(scope).attempt, 1);
  assert.equal((await runner.run({ ...request, retry: true })).reused, false);
  assert.equal(store.latest(scope).attempt, 2);
});

test("authenticated module execution invalidates dependency-only drift and detaches the approved allowlist", integration, async (context) => {
  const f = fixture(context), modulePaths = ["arithmetic.mjs"];
  fs.writeFileSync(f.sourceFile, "export {sum} from './arithmetic.mjs';\n");
  const dependency = path.join(f.projectRoot, modulePaths[0]);
  fs.writeFileSync(dependency, "export const sum=(a,b)=>a+b;\n");
  const runner = createDurableContractRunner({ ...f.options, modulePaths });
  modulePaths.push("not-approved.mjs");
  const first = await runner.run(request), receipt = await runner.assess(first, { policy: "allow" });
  assert.equal(receipt.verdict, "pass", JSON.stringify(receipt));
  assert.equal(receipt.completionAllowed, true);
  assert.deepEqual(receipt.sourcePaths, ["sum.mjs", "arithmetic.mjs"]);
  assert.equal((await runner.run(request)).reused, true);
  assert.equal(f.store.latest(scope).attempt, 1);
  fs.writeFileSync(dependency, "export const sum=(a,b)=>a-b;\n");
  assert.equal((await runner.assess(first, { policy: "allow" })).completionAllowed, false);
  const failed = await runner.run(request), rejected = await runner.assess(failed, { policy: "allow" });
  assert.equal(rejected.verdict, "fail", JSON.stringify(rejected));
  assert.equal(rejected.repairEligible, true);
  assert.equal(rejected.sourceMutationAllowed, false);
  assert.equal(f.store.latest(scope).attempt, 2);
  assert.notEqual(first.evidence.observed.result.execution.sourceDigest, failed.evidence.observed.result.execution.sourceDigest);
});

for (const [name, source, verdict, reason, action] of [
  ["unsupported return type", "export const sum = (a,b) => Promise.resolve(a+b);", "unknown", "return-type-unsupported", "handoff"],
  ["unsupported import", "import {x} from './other.mjs'; export const sum = (a,b) => a+b;", "unknown", "module-import-unsupported", "handoff"],
  ["guest CPU budget", "export const sum = () => { while(true) {} };", "error", "guest-cpu-budget", "retry"]
]) test(`authenticated ${name} diagnostics never authorize source repair`, integration, async (context) => {
  const { options, sourceFile, store } = fixture(context);
  fs.writeFileSync(sourceFile, source);
  const runner = createDurableContractRunner(options), actual = await runner.run(request);
  const assessment = await runner.assess(actual, { policy: "allow" });
  assert.equal(assessment.verdict, verdict, JSON.stringify({ actual, assessment }));
  assert.equal(assessment.completionAllowed, false); assert.equal(assessment.repairEligible, false);
  assert.ok(assessment.reasons.includes(reason), JSON.stringify(assessment));
  const { recovery, decision } = recoveryFor(context, options, assessment);
  assert.equal(decision.action, action, JSON.stringify(decision));
  assert.match(recovery.guidance.join(" "), /No source mutation/);
  assert.equal((await runner.run(request)).reused, true, "diagnosis does not automatically launch an identical execution");
  assert.equal(store.latest(scope).attempt, 1);
  assert.equal(fs.readFileSync(sourceFile, "utf8"), source);
});

test("real execution can be authenticated and reused after reopening the host store", integration, async (context) => {
  const { options, open, store } = fixture(context);
  const runner = createDurableContractRunner(options);
  // Constructor retains a detached host plan, not a mutable caller reference.
  options.checks[0].cases[0].expected.value.value = 999;
  const first = await runner.run(request);
  assert.equal(first.verdict, "pass", JSON.stringify(first));
  assert.equal(first.reused, false); assert.equal(first.completionAllowed, false);
  assert.equal((await runner.assess(first)).completionAllowed, false, "policy must be explicit");
  const accepted = await runner.assess(first, { policy: "allow" });
  assert.equal(accepted.verdict, "pass", JSON.stringify(accepted)); assert.equal(accepted.completionAllowed, true);
  assert.equal(accepted.assurance, "bounded-contract-tested"); assert.equal(accepted.sourceMutationAllowed, false);
  const admissionContext = { ...scope, criterionHash: request.criterionHash, workingTreeDigest: first.evidence.observed.binding.workingTreeDigest,
    projectVerificationDigest: "d".repeat(64), policy: "allow" };
  assert.equal(currentAuthenticatedAssessment(accepted, admissionContext), accepted);
  assert.equal(currentAuthenticatedAssessment(structuredClone(accepted), admissionContext), null);
  for (const field of ["taskRunId", "criterionId", "criterionHash", "workingTreeDigest", "projectVerificationDigest", "policy"]) {
    assert.equal(currentAuthenticatedAssessment(accepted, { ...admissionContext, [field]: "wrong" }), null, field);
  }
  assert.equal((await runner.assess(structuredClone(first), { policy: "allow" })).completionAllowed, false);
  const runId = first.evidence.observed.result.execution.runId;
  assert.equal(runId, first.attemptId);
  store.close();
  assert.equal(currentAuthenticatedAssessment(accepted, admissionContext), null, "closed authority cannot certify completion");
  const reopened = open(), resumed = createDurableContractRunner({ ...options, checks: checks(), store: reopened });
  const cached = await resumed.run(request);
  assert.equal(cached.verdict, "pass", JSON.stringify(cached)); assert.equal(cached.reused, true);
  assert.equal(cached.evidence.observed.result.execution.runId, runId);
  assert.equal(cached.attemptId, first.attemptId); assert.equal(reopened.latest(scope).sequence, 2);
  assert.equal((await resumed.assess(first, { policy: "allow" })).completionAllowed, false, "another runner cannot admit the old result object");
  const restored = await resumed.assess(cached, { policy: "allow" });
  assert.equal(currentAuthenticatedAssessment(restored, admissionContext).verdict, "pass");
});

test("authenticated durable admission binds protocol v2 profile, compiler, typed bytes and current source", integration, async (context) => {
  const f = fixture(context), profile = structuredClone(expectedNodeProfile());
  fs.writeFileSync(f.sourceFile, "export const sum = value => Buffer.from(value).toString('utf8');\n");
  const nodeChecks = [{ id: "decode", cases: [{ id: "one", invocation: { kind: "call" },
    args: [{ type: "buffer", value: { backingBase64: "eGhlbGxveQ==", byteOffset: 1, byteLength: 5 } }],
    expected: { outcome: "return", value: { type: "string", value: "hello" } } }] }];
  const runner = createDurableContractRunner({ ...f.options, profile, checks: nodeChecks });
  profile.digest = "0".repeat(64);
  const first = await runner.run(request), admitted = await runner.assess(first, { policy: "allow" });
  assert.equal(first.verdict, "pass", JSON.stringify(first));
  assert.equal(admitted.completionAllowed, true, JSON.stringify(admitted));
  assert.equal(admitted.contractVersion, "bounded-node-profile-contract-comparison-v1");
  assert.equal(admitted.profileDigest, expectedNodeProfile().digest);
  assert.equal(first.evidence.observed.result.execution.profileDigest, expectedNodeProfile().digest);
  assert.equal((await runner.run(request)).reused, true);
});

test("a changed clean commit runs again and its captured counterexample replaces the cached pass", integration, async (context) => {
  const { options, projectRoot, sourceFile, store } = fixture(context), runner = createDurableContractRunner(options);
  const first = await runner.run(request); assert.equal(first.verdict, "pass");
  const accepted = await runner.assess(first, { policy: "allow" });
  const admissionContext = { ...scope, criterionHash: request.criterionHash, workingTreeDigest: accepted.workingTreeDigest,
    projectVerificationDigest: "d".repeat(64), policy: "allow" };
  fs.writeFileSync(sourceFile, "export const sum = (a, b) => a - b;\n");
  assert.equal(currentAuthenticatedAssessment(accepted, admissionContext), null, "source drift immediately invalidates admission");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "invalid new baseline");
  const changed = await runner.run(request);
  assert.equal(changed.verdict, "fail", JSON.stringify(changed)); assert.equal(changed.reused, false);
  assert.equal(changed.evidence.observed.result.counterexamples.length, 1);
  const rejected = await runner.assess(changed, { policy: "allow" });
  assert.equal(rejected.verdict, "fail"); assert.equal(rejected.repairEligible, true); assert.equal(rejected.sourceMutationAllowed, false);
  assert.equal(currentAuthenticatedAssessment(accepted, admissionContext), null, "newer failure never selects an older pass");
  const cachedFailure = await runner.run(request);
  assert.equal(cachedFailure.verdict, "fail"); assert.equal(cachedFailure.reused, true);
  assert.equal(store.latest(scope).attempt, 2);
});

test("authenticated admission rejects malformed signed observations and newer pending work", integration, async (context) => {
  const { options, store } = fixture(context), runner = createDurableContractRunner(options);
  const actual = await runner.run(request), accepted = await runner.assess(actual, { policy: "allow" });
  assert.equal(accepted.verdict, "pass");
  const original = store.latest(scope), snapshotRequest = { projectRoot: options.projectRoot, sourcePath: options.sourcePath, authorizeSourceRead: () => true };
  const admission = createAuthenticatedAdmission({ store, snapshotRequest, verifierDigest: options.verifierDigest, imageId: options.imageId, exportName: options.exportName, checks: options.checks });
  const expectedChecks = [{ id: "sum", caseCount: 1 }];
  const unbranded = createAuthenticatedAdmission({ store: { ...store }, snapshotRequest, verifierDigest: options.verifierDigest, imageId: options.imageId, exportName: options.exportName, checks: options.checks });
  assert.equal(unbranded.issue({ scope, binding: original.binding, event: original, expectedChecks }).completionAllowed, false);
  for (const [index, mutate] of [
    (e) => { e.observed.result.checks = []; },
    (e) => { e.observed.result.checks.push(e.observed.result.checks[0]); },
    (e) => { e.observed.result.checks[0].caseCount = 0; },
    (e) => { e.observed.result.checks[0].caseCount = 2; },
    (e) => { e.observed.result.checks[0].id = "unapproved"; },
    (e) => { e.observed.result.execution.cleanupConfirmed = false; },
    (e) => { e.observed.result.execution.runId = "another-run"; },
    (e) => { e.observed.result.execution.sourceDigest = "0".repeat(64); },
    (e) => { e.observed.result.execution.requestDigest = "0".repeat(64); },
    (e) => { delete e.observed.result.execution.observation; },
    (e) => { e.observed.result.execution.observation.cases[0].value.value = 999; },
    (e) => { e.observed.result.execution.observation.cases = []; },
    (e) => { e.observed.result.execution.observation.status = "error"; },
    (e) => { e.observed.result.execution.imageId = `sha256:${"0".repeat(64)}`; },
    (e) => { e.observed.result.planDigest = "0".repeat(64); },
    (e) => { e.verdict = "fail"; },
    (e) => { e.verdict = e.observed.verdict = e.observed.result.verdict = "fail";
      Object.assign(e.observed.result.checks[0], { status: "fail", counterexampleRef: "0".repeat(64) }); }
  ].entries()) {
    const testScope = { ...scope, taskRunId: `malformed-${index}` };
    const reserved = store.reserve({ scope: testScope, binding: original.binding, maxAttempts: 1 });
    const evidence = structuredClone(actual.evidence); evidence.observed.result.execution.runId = reserved.event.attemptId;
    mutate(evidence);
    const event = store.settle(reserved.reservation, JSON.stringify(evidence));
    let result;
    try { result = admission.issue({ scope: testScope, binding: original.binding, event, expectedChecks }); } catch { result = null; }
    assert.notEqual(result?.completionAllowed, true, `signed malformed observation ${index}`);
    assert.notEqual(result?.repairEligible, true, `signed malformed observation ${index} cannot authorize repair eligibility`);
  }
  const pending = store.reserve({ scope, binding: original.binding, maxAttempts: request.maxAttempts, retry: true });
  assert.equal(pending.status, "reserved");
  assert.equal(currentAuthenticatedAssessment(accepted, { ...scope, criterionHash: request.criterionHash,
    workingTreeDigest: accepted.workingTreeDigest, projectVerificationDigest: "d".repeat(64), policy: "allow" }), null);
  assert.equal((await runner.assess(actual, { policy: "allow" })).completionAllowed, false);
});

test("authenticated cancellation and cleanup uncertainty stop automatic continuation", integration, async (context) => {
  const { options, store, sourceFile } = fixture(context);
  const runner = createDurableContractRunner(options), actual = await runner.run(request);
  const original = store.latest(scope);
  const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: fs.readFileSync(sourceFile, "utf8"), exportName: options.exportName, checks: options.checks }));
  const snapshotRequest = { projectRoot: options.projectRoot, sourcePath: options.sourcePath, authorizeSourceRead: () => true };
  const admission = createAuthenticatedAdmission({ store, snapshotRequest, verifierDigest: options.verifierDigest, imageId: options.imageId, exportName: options.exportName, checks: options.checks });
  for (const [status, cleanupConfirmed, reason, action] of [
    ["cancelled", true, "cancelled", "handoff"],
    ["error", false, "container-cleanup-unconfirmed", "ask-operator"]
  ]) {
    // Synthetic signed host events test admission/recovery semantics here; the
    // actual running-worker cancellation is covered by the completion hook test.
    const reserved = store.reserve({ scope, binding: original.binding, maxAttempts: 3, retry: true });
    const { observation, ...identity } = actual.evidence.observed.result.execution;
    const result = compareIndependentExecution(compiled, { ...identity, runId: reserved.event.attemptId, status, cleanupConfirmed, reason });
    const evidence = structuredClone(actual.evidence);
    evidence.verdict = evidence.observed.verdict = result.verdict; evidence.observed.result = result;
    const event = store.settle(reserved.reservation, JSON.stringify(evidence));
    const receipt = admission.issue({ scope, binding: original.binding, event, expectedChecks: [{ id: "sum", caseCount: 1 }] });
    assert.equal(receipt.verdict, "error", JSON.stringify(receipt));
    assert.equal(receipt.completionAllowed, false); assert.equal(receipt.repairEligible, false);
    assert.equal(recoveryFor(context, options, receipt).decision.action, action);
    const current = { ...scope, criterionHash: request.criterionHash, workingTreeDigest: receipt.workingTreeDigest, projectVerificationDigest: "d".repeat(64), policy: "allow" };
    assert.equal(currentAuthenticatedAssessment(receipt, current), receipt);
    assert.equal(currentAuthenticatedAssessment(structuredClone(receipt), current), null, "serialized diagnostics cannot become recovery authority");
  }
});

test("project-verifier drift during execution or cache admission never reuses a passing verdict", integration, async (context) => {
  const { options, store } = fixture(context);
  let calls = 0;
  const runner = createDurableContractRunner({ ...options, getProjectVerificationDigest: () => ++calls === 1 ? "d".repeat(64) : null });
  const result = await runner.run(request);
  assert.equal(result.evidence.observed.verdict, "pass"); assert.equal(result.verdict, "unknown");
  assert.equal(store.latest(scope).phase, "settled");
  const fixed = createDurableContractRunner(options);
  assert.equal((await fixed.run({ ...request, retry: true })).verdict, "pass");
  calls = 0;
  const cached = await runner.run(request);
  assert.equal(cached.verdict, "unknown"); assert.equal(cached.reason, "cached-evidence-binding-drift");
  assert.equal(store.latest(scope).attempt, 2);
});

test("concurrent runner calls share one reservation and do not spawn duplicate executions", integration, async (context) => {
  const { options, store } = fixture(context), runner = createDurableContractRunner(options);
  const results = await Promise.all([runner.run(request), runner.run(request)]);
  assert.deepEqual(results.map((value) => value.verdict).sort(), ["pass", "unknown"]);
  assert.ok(results.some((value) => value.reason === "evidence-pending"));
  assert.equal(store.latest(scope).attempt, 1);
});

test("host death during a real worker run preserves its exact identity and blocks duplicate execution", integration, async (context) => {
  const { projectRoot, sourceFile, options, open, store, storeOptions } = fixture(context);
  fs.writeFileSync(sourceFile, "export function sum(a, b) { const start=Date.now(); while(Date.now()-start<75) {} return a+b; }\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "bounded slow test worker");
  const slowChecks = checks();
  slowChecks[0].cases = Array.from({ length: 64 }, (_, index) => ({ ...checks()[0].cases[0], id: `case-${index}` }));
  const runnerPath = fileURLToPath(new URL("../packages/piagent-core/extensions/acceptance-durable-execution.js", import.meta.url));
  const storePath = fileURLToPath(new URL("../packages/piagent-core/extensions/acceptance-evidence-store.js", import.meta.url));
  const script = `import {createDurableContractRunner} from ${JSON.stringify(runnerPath)};
    import {openAcceptanceEvidenceStore} from ${JSON.stringify(storePath)}; import {createSecretKey} from 'node:crypto';
    const input=JSON.parse(process.env.PIAGENT_DURABLE_TEST_INPUT);
    const raw=openAcceptanceEvidenceStore({...input.store,key:createSecretKey(Buffer.from(input.key,'hex'))});
    const store={...raw,reserve(value){const result=raw.reserve(value); if(result.status==='reserved') process.send(result.event.attemptId); return result;}};
    const runner=createDurableContractRunner({...input.runner,store,authorizeSourceRead:()=>true,getProjectVerificationDigest:()=>input.verification});
    await runner.run(input.request); raw.close();`;
  const input = { store: { filePath: storeOptions.filePath, projectRoot }, key: storeOptions.key.export().toString("hex"),
    runner: { projectRoot, sourcePath: options.sourcePath, exportName: options.exportName, checks: slowChecks,
      imageId, dockerSocket, verifierDigest: options.verifierDigest }, verification: "d".repeat(64), request };
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, PIAGENT_DURABLE_TEST_INPUT: JSON.stringify(input) } });
  let attemptId, errors = "";
  child.stderr.on("data", (data) => { errors = (errors + data).slice(-4096); });
  const docker = (...args) => execFileSync("docker", ["--host", `unix://${dockerSocket}`, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
  function ownedContainer() {
    if (!attemptId) return null;
    try {
      const [container] = JSON.parse(docker("inspect", "--type", "container", `piagent-contract-${attemptId}`));
      if (container.Image === imageId && container.Config?.Labels?.["io.piagent.contract-execution"] === attemptId) return container;
    } catch {}
    return null;
  }
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
    }
    const owned = ownedContainer();
    if (owned) docker("rm", "--force", owned.Id);
  });
  attemptId = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", () => reject(new Error(errors))); });
  let container = null;
  const startedDeadline = Date.now() + 7000;
  while (Date.now() < startedDeadline) {
    container = ownedContainer();
    if (container?.State?.Running) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(container?.State?.Running, true, "the actual isolated worker must have started before killing its host");
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
  assert.equal(store.latest(scope).phase, "reserved");
  assert.equal(store.latest(scope).attemptId, attemptId);
  const reopened = open();
  const resumed = createDurableContractRunner({ ...options, checks: slowChecks, store: reopened });
  assert.equal((await resumed.run(request)).reason, "evidence-pending");
  assert.equal(reopened.latest(scope).attempt, 1);
  const stoppedDeadline = Date.now() + 12000;
  while (Date.now() < stoppedDeadline && ownedContainer()?.State?.Running) await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = ownedContainer();
  assert.ok(stopped && stopped.State.Running === false, "the isolated worker terminates even after host death");
  docker("rm", stopped.Id);
  assert.equal(ownedContainer(), null);
  reopened.recordStoppedAttempt({ scope, attemptId, executorStopped: true });
  assert.equal((await resumed.run(request)).reason, "evidence-interrupted");
  assert.equal(reopened.latest(scope).attempt, 1);
});
