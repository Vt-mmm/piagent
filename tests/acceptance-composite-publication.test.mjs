import assert from "node:assert/strict";
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPOSITE_ASSURANCE,
  openCompositeAssuranceJournal,
  openCompositeAssuranceRuntime,
  sealCompositePlanContext
} from "../packages/piagent-core/runtime/verification/runtime-assurance-facts.ts";
import { compositeTaskPublicationDigest, openCompositeTaskPublicationStore, recoverCompositeTaskPublication }
  from "../packages/piagent-core/runtime/verification/composite-task-publication.ts";
import { bindSessionTask, durableTaskContractMatches, writeTaskContract }
  from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const options = { timeout: 5000 };

function definition({ boundary = "webui-operation-confirmed", origins = ["assistant"], nativeTemplate = null,
  criterionId = "criterion-publication", criterionIndex = 0,
  criterionText = "Refuse the protected action without mutation." } = {}) {
  const text = criterionText, producerDigest = digest("publication-producer");
  const fact = (id, kind, parameters, stage = "content") => ({ id, kind, specDigest: digest(`spec:${kind}:${boundary}:${origins.join("+")}`),
    producerId: "publication-producer", producerDigest, ruleDigest: digest(`rule:${kind}:${boundary}:${nativeTemplate}`), stage, parameters });
  const facts = [
    fact("refusal", "policy-refusal-output", { rule: "protected-env", protectedMaterialId: "protected-env", expectedDisposition: "deny",
      responseFormat: "refusal-v1", nativeTemplateSetDigest: nativeTemplate }),
    fact("policy", "tool-policy-complete", { profileDigest: digest("no-tools"), requireExclusiveMediation: true }),
    fact("scope", "workspace-scope", { allowedWriteMaterialIds: [], requireCompleteMutationJournal: true }),
    fact("persisted", "response-persisted", { expectedOrigins: origins, requireExactBytes: true }, "settlement"),
    fact("delivered", "terminal-delivery", { boundary, requireExactOperation: true }, "settlement")
  ];
  const contract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex,
    criterionId, criterionText: text, criterionHash: digest(text), facts,
    coverage: [{ id: "refusal", startByte: 0, endByte: Buffer.byteLength(text), textHash: digest(text),
      roles: ["refusal", "no-mutation", "persistence", "delivery"], requiredFactIds: facts.map(item => item.id) }] };
  const selectedCriterion = { id: contract.criterionId, text, hash: digest(text) };
  const criteria = criterionIndex === 0 ? [selectedCriterion] : [{ id: "criterion-publication",
    text: "Refuse the protected action without mutation.", hash: digest("Refuse the protected action without mutation.") }, selectedCriterion];
  const declarations = { criteria, changeMode: "read-only", requiresOutput: true,
    producers: [{ id: "publication-producer", digest: producerDigest, kinds: facts.map(item => item.kind), ruleDigests: facts.map(item => item.ruleDigest) }],
    factSpecifications: facts.map(({ id: _id, ...spec }) => spec), codePlans: [],
    materials: [{ id: "protected-env", byteLength: 0 }], authoredCaseCount: 0 };
  const binding = { projectId: digest("project"), projectHead: digest("head"), sourceDigest: digest("source"),
    materialSnapshotDigest: digest("materials"), suiteDigest: digest("suite"), configDigest: digest("config"), armDigest: digest("arm"),
    taskRunId: "task-publication", sessionId: "session-publication", operatorRequestDigest: `operator-request-v1:${digest("request")}`,
    taskContractDigest: digest("task-contract"), criterionIndex, criterionId: contract.criterionId, criterionHash: digest(text),
    runtimeGeneration: 7, phaseHeadDigest: digest("phase"), producerManifestDigest: digest("manifest"), verifierDigest: null };
  return { contract, declarations, binding };
}

function durableWrite(file, bytes) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function fixture(t, options = {}) {
  const plan = definition(options), key = createSecretKey(randomBytes(32));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-composite-publication-")));
  const projectRoot = path.join(root, "project"), authority = path.join(root, "authority"), output = path.join(authority, "response.bin"),
    delivery = path.join(authority, "delivery.json"),
    filePath = path.join(authority, `composite-${digest("publication-journal")}.jsonl`);
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  const sealed = sealCompositePlanContext({ key, contractText: JSON.stringify(plan.contract), declarations: plan.declarations,
    binding: plan.binding, maxAttempts: 2 });
  const current = structuredClone(plan.binding), fx = { plan, key, sealed, current, root, projectRoot, authority, output, delivery, filePath,
    journal: null, runtime: null };
  const open = expectedHead => {
    fx.journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: sealed.contextDigest,
      ...(expectedHead ? { expectedHead } : {}) });
    fx.runtime = openCompositeAssuranceRuntime({ key, sealedContext: sealed, journal: fx.journal,
      currentBinding: () => structuredClone(current) });
  };
  open(); fx.open = open;
  fx.responseBytes = JSON.stringify({ schemaVersion: 1, kind: "refusal", rule: "protected-env", target: ".env",
    disposition: "declined", reason: "protected-secret", alternative: "describe-required-variable-names-without-values" }) + "\n";
  fx.response = { origin: options.origin ?? "assistant", entryId: "assistant-entry", digest: digest(fx.responseBytes),
    byteLength: Buffer.byteLength(fx.responseBytes), operationRef: "operation-publication", messageRequestId: "request-publication" };
  t.after(() => { try { fx.journal?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return fx;
}

function siblingFixture(t, fx, suffix) {
  const plan = definition({ criterionId: `criterion-publication-${suffix}`, criterionIndex: 1,
    criterionText: `Refuse the protected action without mutation (${suffix}).` });
  const sealed = sealCompositePlanContext({ key: fx.key, contractText: JSON.stringify(plan.contract), declarations: plan.declarations,
    binding: plan.binding, maxAttempts: 2 });
  const current = structuredClone(plan.binding), filePath = path.join(fx.authority,
    `composite-${digest(`publication-journal-${suffix}`)}.jsonl`);
  const peer = { plan, key: fx.key, sealed, current, projectRoot: fx.projectRoot, authority: fx.authority,
    output: fx.output, delivery: fx.delivery, filePath, responseBytes: fx.responseBytes, response: structuredClone(fx.response),
    journal: null, runtime: null };
  peer.open = expectedHead => {
    peer.journal = openCompositeAssuranceJournal({ filePath, projectRoot: fx.projectRoot, key: fx.key,
      contextDigest: sealed.contextDigest, ...(expectedHead ? { expectedHead } : {}) });
    peer.runtime = openCompositeAssuranceRuntime({ key: fx.key, sealedContext: sealed, journal: peer.journal,
      currentBinding: () => structuredClone(current) });
  };
  peer.open(); t.after(() => { try { peer.journal?.close(); } catch {} }); return peer;
}

async function settle(fx, id, collect) {
  const reserved = fx.runtime.reserveFact(id); if (reserved.status === "current") return reserved.receipt;
  assert.equal(reserved.status, "reserved");
  return fx.runtime.settleFact({ reservation: reserved.reservation, producer: fx.runtime.producerFor(id), collect: collect ?? (async () => ({
    status: "pass", observationDigest: digest(`observation:${id}`), counterexampleRef: null, reasonCodes: []
  })) });
}

async function prepare(fx) {
  const content = [];
  for (const fact of fx.plan.contract.facts.filter(item => item.stage === "content")) content.push(await settle(fx, fact.id));
  const preparation = fx.runtime.prepareResponse({ facts: content, bytes: fx.responseBytes, origin: fx.response.origin,
    entryId: fx.response.entryId, operationRef: fx.response.operationRef, messageRequestId: fx.response.messageRequestId });
  return { content, preparation };
}

function persistSurface(fx, surface) {
  durableWrite(fx.output, fx.responseBytes);
  durableWrite(fx.delivery, JSON.stringify({ surface, responseDigest: fx.response.digest, operationRef: fx.response.operationRef,
    messageRequestId: fx.response.messageRequestId, entryId: fx.response.entryId }));
}

async function prepareAggregate(fx, content, preparation, surface) {
  const persisted = await settle(fx, "persisted", async () => {
    const bytes = fs.readFileSync(fx.output), matched = digest(bytes) === fx.response.digest && bytes.equals(Buffer.from(fx.responseBytes));
    return { status: matched ? "pass" : "fail", observationDigest: digest(bytes),
      counterexampleRef: matched ? null : digest("persisted-mismatch"), reasonCodes: matched ? [] : ["persistence-mismatch"], response: fx.response };
  });
  const delivered = await settle(fx, "delivered", async () => {
    const observed = JSON.parse(fs.readFileSync(fx.delivery, "utf8")), matched = observed.surface === surface
      && observed.responseDigest === fx.response.digest && observed.operationRef === fx.response.operationRef
      && observed.messageRequestId === fx.response.messageRequestId && observed.entryId === fx.response.entryId;
    return { status: matched ? "pass" : "fail", observationDigest: digest(JSON.stringify(observed)),
      counterexampleRef: matched ? null : digest("delivery-mismatch"), reasonCodes: matched ? [] : ["delivery-mismatch"], response: fx.response };
  });
  const facts = [...content, persisted, delivered];
  const taskPublicationDigest = fx.taskPublication?.terminalTaskDigest ?? digest("terminal-task-publication");
  const aggregatePreparation = fx.runtime.prepareAggregatePublication({ preparation, facts, taskPublicationDigest });
  return { persisted, delivered, facts, aggregatePreparation };
}

async function settlePublication(fx, content, preparation, surface) {
  const prepared = await prepareAggregate(fx, content, preparation, surface);
  const publicationRecord = fx.taskPublication && openCompositeTaskPublicationStore({ key: fx.key,
    directory: fx.authority, projectRoot: fx.projectRoot }).prepare({ pendingTask: fx.taskPublication.pendingTask,
    terminalTask: fx.taskPublication.terminalTask, workingTreeDigest: fx.taskPublication.workingTreeDigest,
    entries: [prepared.aggregatePreparation.entry] });
  const aggregate = fx.runtime.settleAggregate({ publication: prepared.aggregatePreparation.publication });
  return { ...prepared, aggregate, publicationRecord };
}

function publicationTasks(fx, peers = []) {
  const recordedAt = "2026-09-01T00:00:00.000Z", operatorRequest = "request";
  const pending = writeTaskContract(fx.projectRoot, { schemaVersion: 2, taskRunId: fx.plan.binding.taskRunId,
    taskId: "publication-task", sessionId: fx.plan.binding.sessionId, changeMode: "read-only", mutationPolicy: "forbidden",
    attempt: 1, maxAttempts: 3, previousAttempts: [], summary: "Publish the exact bounded response", operatorRequest,
    operatorRequestDigest: fx.plan.binding.operatorRequestDigest, riskLane: "tiny", intakeMode: "runtime",
    expectedOutput: "The exact response is durably published.",
    acceptanceCriteria: [fx, ...peers].map(item => item.plan.contract.criterionText),
    scope: ["README.md"], outOfScope: [], protectedPaths: [], requiredContext: [], contextManifest: [], memoryCitations: [],
    mcpCapabilities: [], verifyCommands: [], workPlan: [], reviewLenses: [], workingTreeDigestAlgorithm: "wt-content-v2",
    baselineChangedFiles: [], baselineFileDigests: {}, observedChangedFiles: [], finalWorkingTreeFiles: [], finalFileDigests: {},
    changedFiles: [], verifyEvidence: [], trace: { outcome: "pending" }, createdAt: recordedAt, updatedAt: recordedAt });
  bindSessionTask(fx.projectRoot, pending.sessionId, undefined, pending);
  const terminalTask = { ...pending, trace: { outcome: "completed", recordedAt } };
  return { pendingTask: pending, terminalTask, terminalTaskDigest: compositeTaskPublicationDigest(terminalTask),
    workingTreeDigest: workingTreeEvidenceDigest({}) };
}

test("GATE P1-PUBLISH 01/10 actual CLI bytes persist before aggregate settlement", options, async t => {
  const fx = fixture(t, { boundary: "cli-final-output-durable" }), prepared = await prepare(fx);
  persistSurface(fx, "cli-final-output-durable");
  const result = await settlePublication(fx, prepared.content, prepared.preparation, "cli-final-output-durable");
  assert.equal(result.aggregate.assurance, COMPOSITE_ASSURANCE);
  const completed = fx.runtime.completeTask({ aggregate: result.aggregate });
  assert.equal(completed.completed, true); assert.equal(completed.responseDigest, digest(fs.readFileSync(fx.output)));
});

test("GATE P1-PUBLISH 02/10 actual WebUI operation identity is durably read back", options, async t => {
  const fx = fixture(t), prepared = await prepare(fx); persistSurface(fx, "webui-operation-confirmed");
  const result = await settlePublication(fx, prepared.content, prepared.preparation, "webui-operation-confirmed");
  assert.equal(result.delivered.status, "pass"); assert.equal(fx.runtime.completeTask({ aggregate: result.aggregate }).completed, true);
});

test("GATE P1-PUBLISH 03/10 crash after prepared response resumes without replacing output", options, async t => {
  const fx = fixture(t), prepared = await prepare(fx), head = fx.journal.head(); persistSurface(fx, "webui-operation-confirmed");
  fx.journal.close(); fx.open(head);
  const reissued = fx.runtime.reissue(); assert.equal(reissued.preparation.responseDigest, fx.response.digest);
  const result = await settlePublication(fx, reissued.facts, reissued.preparation, "webui-operation-confirmed");
  assert.equal(fx.runtime.completeTask({ aggregate: result.aggregate }).responseDigest, fx.response.digest);
  assert.ok(prepared.preparation);
});

test("GATE P1-PUBLISH 04/10 crash after aggregate settlement resumes one idempotent completion", options, async t => {
  const fx = fixture(t); fx.taskPublication = publicationTasks(fx);
  const prepared = await prepare(fx); persistSurface(fx, "webui-operation-confirmed");
  const settled = await settlePublication(fx, prepared.content, prepared.preparation, "webui-operation-confirmed"), head = fx.journal.head();
  assert.ok(settled.publicationRecord); fx.journal.close();
  const store = openCompositeTaskPublicationStore({ key: fx.key, directory: fx.authority, projectRoot: fx.projectRoot });
  const record = store.read(fx.plan.binding.taskRunId, fx.plan.binding.sessionId);
  assert.equal(record.terminalTaskDigest, fx.taskPublication.terminalTaskDigest); assert.equal(store.inspect(record).allSettled, true);
  assert.throws(() => store.inspect(structuredClone(record)), /Untrusted composite task publication/);
  const recovery = { store, record, task: fx.taskPublication.pendingTask,
    currentWorkingTreeDigest: fx.taskPublication.workingTreeDigest,
    expectedCriteria: [{ criterionId: fx.plan.contract.criterionId, criterionHash: fx.plan.contract.criterionHash }],
    cwd: fx.projectRoot, writeTask: writeTaskContract };
  const completedTask = recoverCompositeTaskPublication(recovery);
  assert.equal(durableTaskContractMatches(fx.projectRoot, completedTask), true);
  recoverCompositeTaskPublication({ ...recovery, task: completedTask });
  fx.open(); const reissued = fx.runtime.reissue(); assert.equal(reissued.completed, true); const before = fx.runtime.state().eventCount;
  fx.runtime.completeTask({ aggregate: reissued.aggregate }); assert.equal(fx.runtime.state().eventCount, before);
  assert.notEqual(fx.runtime.state().journalHead, head); assert.ok(settled.aggregate);
});

test("GATE P1-PUBLISH 05/10 cancellation and supersession invalidate prepared authority", options, async t => {
  for (const reason of ["cancelled", "superseded"]) {
    const fx = fixture(t), prepared = await prepare(fx); fx.runtime.invalidate(reason);
    assert.equal(fx.runtime.state().phase, reason); assert.equal(fx.runtime.reissue().preparation, null);
    assert.throws(() => fx.runtime.prepareAggregatePublication({ preparation: prepared.preparation, facts: prepared.content,
      taskPublicationDigest: digest("terminal-task-publication") }), /invalidated|not satisfied/);
  }
});

test("GATE P1-PUBLISH 06/10 custom receipt is not an assistant response and native origin must be pinned", options, async t => {
  const custom = fixture(t), customContent = await prepare(custom);
  assert.throws(() => custom.runtime.prepareResponse({ facts: customContent.content, bytes: custom.responseBytes, origin: "custom-receipt",
    entryId: custom.response.entryId, operationRef: custom.response.operationRef, messageRequestId: custom.response.messageRequestId }), /response identity/);
  const native = fixture(t, { origins: ["assistant", "native-policy"], nativeTemplate: digest("native-template"), origin: "native-policy" });
  const prepared = await prepare(native); assert.equal(prepared.preparation.responseDigest, native.response.digest);
});

test("GATE P1-PUBLISH 07/10 completion creates no extra model turn or duplicate output", options, async t => {
  const fx = fixture(t), prepared = await prepare(fx); persistSurface(fx, "webui-operation-confirmed");
  const result = await settlePublication(fx, prepared.content, prepared.preparation, "webui-operation-confirmed");
  const beforeBytes = fs.readFileSync(fx.output), beforeEvents = fx.runtime.state().eventCount;
  const first = fx.runtime.completeTask({ aggregate: result.aggregate }), afterFirst = fx.runtime.state().eventCount;
  const second = fx.runtime.completeTask({ aggregate: result.aggregate });
  assert.equal(first.outputCreated, false); assert.equal(first.modelTurnRequested, false); assert.deepEqual(second, first);
  assert.equal(afterFirst, beforeEvents + 1); assert.equal(fx.runtime.state().eventCount, afterFirst); assert.deepEqual(fs.readFileSync(fx.output), beforeBytes);
});

test("GATE P1-PUBLISH 08/10 prepared content is not PASS and cannot complete a cycle", options, async t => {
  const fx = fixture(t), prepared = await prepare(fx), state = fx.runtime.state();
  assert.equal(state.phase, "prepared"); assert.equal(fx.runtime.assess(prepared.content).verdict, "unknown");
  assert.throws(() => fx.runtime.prepareAggregatePublication({ preparation: prepared.preparation, facts: prepared.content,
    taskPublicationDigest: digest("terminal-task-publication") }), /not satisfied/);
  assert.equal(fx.runtime.state().phase, "prepared"); assert.equal(fx.runtime.reissue().completed, false);
});

test("GATE P1-PUBLISH 09/10 a partial multi-criterion aggregate crash resumes from the signed task intent", options, async t => {
  const fx = fixture(t), peer = siblingFixture(t, fx, "peer");
  const taskPublication = publicationTasks(fx, [peer]); fx.taskPublication = taskPublication; peer.taskPublication = taskPublication;
  const first = await prepare(fx), second = await prepare(peer); persistSurface(fx, "webui-operation-confirmed");
  const firstAggregate = await prepareAggregate(fx, first.content, first.preparation, "webui-operation-confirmed");
  const secondAggregate = await prepareAggregate(peer, second.content, second.preparation, "webui-operation-confirmed");
  const store = openCompositeTaskPublicationStore({ key: fx.key, directory: fx.authority, projectRoot: fx.projectRoot });
  const record = store.prepare({ pendingTask: taskPublication.pendingTask, terminalTask: taskPublication.terminalTask,
    workingTreeDigest: taskPublication.workingTreeDigest,
    entries: [firstAggregate.aggregatePreparation.entry, secondAggregate.aggregatePreparation.entry] });
  fx.runtime.settleAggregate({ publication: firstAggregate.aggregatePreparation.publication });
  fx.journal.close(); peer.journal.close();
  const reopenedStore = openCompositeTaskPublicationStore({ key: fx.key, directory: fx.authority, projectRoot: fx.projectRoot });
  const reopened = reopenedStore.read(fx.plan.binding.taskRunId, fx.plan.binding.sessionId);
  assert.deepEqual(reopenedStore.inspect(reopened).statuses.map(item => item.status), ["aggregate-settled", "pre-aggregate"]);
  const completedTask = recoverCompositeTaskPublication({ store: reopenedStore, record: reopened,
    task: taskPublication.pendingTask, currentWorkingTreeDigest: taskPublication.workingTreeDigest,
    expectedCriteria: [fx, peer].map(item => ({ criterionId: item.plan.contract.criterionId,
      criterionHash: item.plan.contract.criterionHash })), cwd: fx.projectRoot, writeTask: writeTaskContract });
  assert.equal(durableTaskContractMatches(fx.projectRoot, completedTask), true);
  assert.equal(reopenedStore.inspect(reopened).allCompleted, true);
  fx.open(); peer.open(); assert.equal(fx.runtime.reissue().completed, true); assert.equal(peer.runtime.reissue().completed, true);
  const counts = [fx.runtime.state().eventCount, peer.runtime.state().eventCount];
  recoverCompositeTaskPublication({ store: reopenedStore, record: reopened, task: completedTask,
    currentWorkingTreeDigest: taskPublication.workingTreeDigest,
    expectedCriteria: [fx, peer].map(item => ({ criterionId: item.plan.contract.criterionId,
      criterionHash: item.plan.contract.criterionHash })), cwd: fx.projectRoot, writeTask: writeTaskContract });
  assert.deepEqual([fx.runtime.state().eventCount, peer.runtime.state().eventCount], counts); assert.ok(record);
});

test("GATE P1-PUBLISH 10/10 a failed durable intent leaves every prepared aggregate uncommitted", options, async t => {
  const fx = fixture(t); fx.taskPublication = publicationTasks(fx);
  const prepared = await prepare(fx); persistSurface(fx, "webui-operation-confirmed");
  const aggregate = await prepareAggregate(fx, prepared.content, prepared.preparation, "webui-operation-confirmed");
  const store = openCompositeTaskPublicationStore({ key: fx.key, directory: fx.authority, projectRoot: fx.projectRoot });
  const originalRename = fs.renameSync; let injected = false;
  fs.renameSync = function(from, to) {
    if (!injected && String(to).includes("composite-publication-")) { injected = true; throw new Error("injected-publication-rename"); }
    return originalRename.apply(fs, arguments);
  };
  try {
    assert.throws(() => store.prepare({ pendingTask: fx.taskPublication.pendingTask,
      terminalTask: fx.taskPublication.terminalTask, workingTreeDigest: fx.taskPublication.workingTreeDigest,
      entries: [aggregate.aggregatePreparation.entry] }), /injected-publication-rename/);
  } finally { fs.renameSync = originalRename; }
  assert.equal(injected, true); assert.equal(store.read(fx.plan.binding.taskRunId, fx.plan.binding.sessionId), null);
  assert.equal(fx.runtime.state().phase, "prepared");
  assert.equal(fx.journal.events().filter(event => event.kind === "aggregate-settled").length, 0);
});
