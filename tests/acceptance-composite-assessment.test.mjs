import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";

import { createAcceptanceAssessmentSession } from "../packages/piagent-core/extensions/acceptance-assessment.js";
import { compositeCodePlanDigest } from "../packages/piagent-core/extensions/acceptance-composite-contract.js";
import { validateHostContractPlan, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { independentAcceptanceState, settleIndependentWebUiOperation }
  from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { bindSessionTask, durableTaskContractMatches, workingTreeSnapshot, writeTaskContract }
  from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import {
  COMPOSITE_ASSURANCE,
  openCompositeAssuranceJournal,
  openCompositeAssuranceRuntime,
  sealCompositePlanContext
} from "../packages/piagent-core/runtime/verification/runtime-assurance-facts.ts";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";
import { scopedBrokerArmDigest, scopedBrokerProfileDigest }
  from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import { compositeTaskPublicationDigest }
  from "../packages/piagent-core/runtime/verification/composite-task-publication.ts";
import { loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE } from "../packages/piagent-webui/shared/message-correlation.ts";
import { createScopedMaterialBroker } from "../scripts/benchmark-scoped-tool-broker.mjs";
import { scopedJournalPathSha256, scopedQualificationIdentity, scopedToolDefinitionsSha256,
  scopedVerificationReceiptKeyDigest } from "../scripts/benchmark-scoped-verification-supervisor.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const options = { timeout: 10000 };

function approvedCodePlan() {
  const profile = expectedNodeProfile(), definition = { sourcePath: "src/f.js", modulePaths: [], exportName: "f", profile,
    checks: [{ id: "behavior", cases: [1, 2].map(index => ({ id: `case-${index}`, args: [], invocation: { kind: "call" },
      expected: { outcome: "return", value: { type: "number", value: index } } })) }] };
  return { digest: compositeCodePlanDigest(definition), backendProfileDigest: profile.digest, caseCount: 2, ...definition };
}

function plan({ readOnly = false, duplicateCode = false, suffix = "a" } = {}) {
  const text = readOnly ? "Read the supplied context without mutation." : "Implement f.\nDocument x.";
  const producerDigest = digest("runtime-assurance-test-producer");
  const fact = (id, kind, parameters, stage = "content") => ({
    id, kind, specDigest: digest(`spec:${kind}`), producerId: "test-producer", producerDigest,
    ruleDigest: digest(`rule:${kind}`), stage, parameters
  });
  const common = {
    context: fact("context", "context-current", { requiredMaterialIds: ["config"], delivery: "actual-tool-result-or-prompt" }),
    scope: fact("scope", "workspace-scope", { allowedWriteMaterialIds: readOnly ? [] : ["document"], requireCompleteMutationJournal: true }),
    policy: fact("policy", "tool-policy-complete", { profileDigest: digest("tool-policy"), requireExclusiveMediation: true }),
    persisted: fact("persisted", "response-persisted", { expectedOrigins: ["assistant"], requireExactBytes: true }, "settlement"),
    delivered: fact("delivered", "terminal-delivery", { boundary: "webui-operation-confirmed", requireExactOperation: true }, "settlement")
  };
  let facts, coverage, codePlans, authoredCaseCount;
  if (readOnly) {
    facts = Object.values(common);
    coverage = [{ id: "read", startByte: 0, endByte: Buffer.byteLength(text), textHash: digest(text),
      roles: ["read-context", "no-mutation", "persistence", "delivery"], requiredFactIds: facts.map(item => item.id) }];
    codePlans = []; authoredCaseCount = 0;
  } else {
    const childPlan = approvedCodePlan();
    const code = fact("code", "bounded-code-checks", { codePlanDigest: childPlan.digest, backendProfileDigest: childPlan.backendProfileDigest });
    const document = fact("document", "config-document-literals", { configMaterialId: "config", documentMaterialId: "document",
      format: "config-literals-v1", requiredFields: ["service", "restartCommand"] });
    const verifier = fact("verifier", "project-verifier-current", { commandSetDigest: digest("verifier") });
    facts = [code, document, common.context, common.scope, verifier, common.policy, common.persisted, common.delivered];
    if (duplicateCode) facts.splice(1, 0, { ...structuredClone(code), id: "code-sibling" });
    const split = Buffer.byteLength("Implement f.\n"), bytes = Buffer.from(text);
    coverage = [
      { id: "behavior", startByte: 0, endByte: split, textHash: digest(bytes.subarray(0, split)), roles: ["behavior"],
        requiredFactIds: ["code", ...(duplicateCode ? ["code-sibling"] : []), "scope", "verifier", "policy", "persisted", "delivered"] },
      { id: "document", startByte: split, endByte: bytes.length, textHash: digest(bytes.subarray(split)), roles: ["document-literals"],
        requiredFactIds: ["document", "context"] }
    ];
    codePlans = [childPlan];
    authoredCaseCount = duplicateCode ? 4 : 2;
  }
  const criterionId = `criterion-${suffix}`;
  const contract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex: 0,
    criterionId, criterionText: text, criterionHash: digest(text), coverage, facts };
  const specifications = [...new Map(facts.map(({ id: _id, ...spec }) => [spec.specDigest, spec])).values()];
  const declarations = { criteria: [{ id: criterionId, text, hash: digest(text) }], changeMode: readOnly ? "read-only" : "source-change",
    requiresOutput: true,
    producers: [{ id: "test-producer", digest: producerDigest, kinds: [...new Set(facts.map(item => item.kind))],
      ruleDigests: [...new Set(facts.map(item => item.ruleDigest))] }], factSpecifications: specifications, codePlans,
    materials: [{ id: "config", byteLength: 20 }, { id: "document", byteLength: 40 }], authoredCaseCount };
  const binding = {
    projectId: digest("project"), projectHead: digest("head"), sourceDigest: digest("source"),
    materialSnapshotDigest: digest("materials"), suiteDigest: digest("suite"), configDigest: digest("config"), armDigest: digest("arm"),
    taskRunId: `task-${suffix}`, sessionId: `session-${suffix}`, operatorRequestDigest: `operator-request-v1:${digest(`request-${suffix}`)}`,
    taskContractDigest: digest(`task-contract-${suffix}`), criterionIndex: 0, criterionId, criterionHash: digest(text), runtimeGeneration: 1,
    phaseHeadDigest: digest("phase"), producerManifestDigest: digest("producer-manifest"), verifierDigest: readOnly ? null : digest("verifier")
  };
  return { contract, declarations, binding };
}

function fixture(t, planOptions) {
  const definition = plan(planOptions), key = createSecretKey(randomBytes(32));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-composite-assessment-")));
  const projectRoot = path.join(root, "project"), authority = path.join(root, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  const sealed = sealCompositePlanContext({ key, contractText: JSON.stringify(definition.contract), declarations: definition.declarations,
    binding: definition.binding, maxAttempts: 2 });
  const journal = openCompositeAssuranceJournal({ filePath: path.join(authority, "composite.jsonl"), projectRoot, key,
    contextDigest: sealed.contextDigest });
  const current = structuredClone(definition.binding);
  const runtime = openCompositeAssuranceRuntime({ key, sealedContext: sealed, journal, currentBinding: () => structuredClone(current) });
  const byId = new Map(definition.contract.facts.map(item => [item.id, item]));
  const responseBytes = '{"result":"done"}\n';
  const response = { origin: "assistant", entryId: "assistant-entry-1", digest: digest(responseBytes),
    byteLength: Buffer.byteLength(responseBytes), operationRef: "operation-1", messageRequestId: "request-1" };
  t.after(() => { try { journal.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { definition, key, sealed, journal, current, runtime, byId, response, responseBytes, projectRoot, authority, root };
}

function compositeHostPlan(definition) {
  return {
    schemaVersion: 3,
    operatorRequestDigest: definition.binding.operatorRequestDigest,
    backend: {
      imageId: `sha256:${digest("composite-host-image")}`,
      dockerSocket: "/var/run/docker.sock",
      timeoutMs: 5000,
      profile: expectedNodeProfile()
    },
    contracts: [{
      route: "composite",
      criterionId: definition.contract.criterionId,
      criterionHash: definition.contract.criterionHash,
      maxAttempts: 2,
      planContext: {
        version: "composite-plan-context-v1",
        contractText: JSON.stringify(definition.contract),
        declarationsText: JSON.stringify(definition.declarations),
        identity: { suiteDigest: definition.binding.suiteDigest, configDigest: definition.binding.configDigest,
          armDigest: definition.binding.armDigest },
        materialBindings: definition.declarations.materials.map((material, index) => ({ id: material.id,
          mode: index === 0 ? "frozen" : "current", relativePath: `materials/${material.id}.txt`,
          sha256: index === 0 ? digest(`material:${material.id}`) : null }))
      }
    }]
  };
}

function codeHostPlan(composite) {
  return {
    ...structuredClone(composite),
    contracts: [{
      route: "code",
      criterionId: "sum",
      criterionHash: digest("sum criterion"),
      sourcePath: "src/sum.js",
      exportName: "sum",
      maxAttempts: 2,
      checks: [{ id: "sum", cases: [{ id: "one", args: [], invocation: { kind: "call" },
        expected: { outcome: "return", value: { type: "number", value: 3 } } }] }]
    }]
  };
}

async function settle(fx, id, status = "pass", reasonCodes = [], counterexampleRef = null) {
  const reserved = fx.runtime.reserveFact(id, { retry: false });
  assert.equal(reserved.status, "reserved");
  const producer = fx.runtime.producerFor(id), fact = fx.byId.get(id);
  return fx.runtime.settleFact({ reservation: reserved.reservation, producer, collect: async () => ({
    status, observationDigest: digest(`observation:${id}:${status}`), counterexampleRef, reasonCodes,
    ...(fact.stage === "settlement" ? { response: fx.response } : {})
  }) });
}

async function contentFacts(fx, overrides = {}, omitted = []) {
  const receipts = [];
  for (const fact of fx.definition.contract.facts.filter(item => item.stage === "content" && !omitted.includes(item.id))) {
    const change = overrides[fact.id] ?? {};
    receipts.push(await settle(fx, fact.id, change.status ?? "pass", change.reasonCodes ?? [], change.counterexampleRef ?? null));
  }
  return receipts;
}

async function prepareAndSettle(fx, content) {
  const preparation = fx.runtime.prepareResponse({ facts: content, bytes: fx.responseBytes, origin: fx.response.origin,
    entryId: fx.response.entryId, operationRef: fx.response.operationRef, messageRequestId: fx.response.messageRequestId });
  const settlement = [];
  for (const fact of fx.definition.contract.facts.filter(item => item.stage === "settlement")) settlement.push(await settle(fx, fact.id));
  return { preparation, settlement, all: [...content, ...settlement] };
}

function settleRoot(fx, publication) {
  const prepared = fx.runtime.prepareAggregatePublication({ preparation: publication.preparation,
    facts: publication.all, taskPublicationDigest: digest("terminal-task-publication") });
  return fx.runtime.settleAggregate({ publication: prepared.publication });
}

test("GATE P1-ASSESS 01/16 full current conjunction alone can settle the root", options, async t => {
  const fx = fixture(t), content = await contentFacts(fx), publication = await prepareAndSettle(fx, content);
  const assessment = fx.runtime.assess(publication.all);
  assert.equal(assessment.verdict, "pass"); assert.equal(assessment.completionAllowed, false); assert.equal(assessment.assurance, "none");
  const aggregate = settleRoot(fx, publication);
  assert.equal(aggregate.assurance, COMPOSITE_ASSURANCE); assert.equal(aggregate.completionAllowed, true);
  assert.equal(fx.runtime.completeTask({ aggregate }).completed, true);
});

test("GATE P1-ASSESS 02/16 a code child cannot satisfy the criterion root", options, async t => {
  const fx = fixture(t), code = await settle(fx, "code"), result = fx.runtime.assess([code]);
  assert.equal(result.verdict, "unknown"); assert.ok(result.missingFactIds.includes("document")); assert.equal(result.completionAllowed, false);
});

test("GATE P1-ASSESS 03/16 copied model or serialized PASS data has no authority", options, async t => {
  const fx = fixture(t), code = await settle(fx, "code");
  for (const receipt of [structuredClone(code), { ...code }, { version: code.version, factId: "code", status: "pass", recordDigest: code.recordDigest }]) {
    const result = fx.runtime.assess([receipt]); assert.equal(result.verdict, "unknown"); assert.ok(result.reasons.includes("untrusted-fact"));
  }
});

test("GATE P1-ASSESS 04/16 code PASS plus document FAIL is aggregate FAIL", options, async t => {
  const fx = fixture(t), content = await contentFacts(fx, { document: { status: "fail", reasonCodes: ["content-mismatch"], counterexampleRef: digest("bad-document") } });
  const result = fx.runtime.assess(content); assert.equal(result.verdict, "fail"); assert.deepEqual(result.failedFactIds, ["document"]); assert.equal(result.repairEligible, true);
});

test("GATE P1-ASSESS 05/16 code PASS with missing project verification abstains", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, {}, ["verifier"]));
  assert.equal(result.verdict, "unknown"); assert.ok(result.missingFactIds.includes("verifier")); assert.equal(result.repairEligible, false);
});

test("GATE P1-ASSESS 06/16 authenticated ERROR precedes FAIL and ordinary UNKNOWN", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, {
    code: { status: "fail", reasonCodes: ["observed-counterexample"], counterexampleRef: digest("code-fail") },
    document: { status: "error", reasonCodes: ["capture-error"] }, context: { status: "unknown", reasonCodes: ["unsupported-input"] }
  }));
  assert.equal(result.verdict, "error"); assert.equal(result.action, "diagnose-producer"); assert.equal(result.repairEligible, false);
});

test("GATE P1-ASSESS 07/16 authenticated FAIL precedes ordinary incomplete UNKNOWN", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, {
    document: { status: "fail", reasonCodes: ["content-mismatch"], counterexampleRef: digest("doc-fail") },
    context: { status: "unknown", reasonCodes: ["unsupported-input"] }
  }));
  assert.equal(result.verdict, "fail"); assert.deepEqual(result.failedFactIds, ["document"]);
});

test("GATE P1-ASSESS 08/16 incomplete UNKNOWN precedes the remaining PASS facts", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, { context: { status: "unknown", reasonCodes: ["ambiguous-input"] } }));
  assert.equal(result.verdict, "unknown"); assert.ok(result.reasons.includes("ambiguous-input"));
});

test("GATE P1-ASSESS 09/16 a sibling criterion capability cannot alias the current hash", options, async t => {
  const first = fixture(t, { suffix: "first" }), sibling = fixture(t, { suffix: "sibling" });
  const siblingCode = await settle(sibling, "code"), result = first.runtime.assess([siblingCode]);
  assert.equal(result.verdict, "unknown"); assert.ok(result.reasons.includes("untrusted-fact"));
});

test("GATE P1-ASSESS 10/16 invalid approval remains UNKNOWN before advisory repair", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, {
    policy: { status: "unknown", reasonCodes: ["invalid-approval"] },
    document: { status: "fail", reasonCodes: ["content-mismatch"], counterexampleRef: digest("doc-fail") }
  }));
  assert.equal(result.verdict, "unknown"); assert.equal(result.repairEligible, false); assert.ok(result.reasons.includes("invalid-approval"));
});

test("GATE P1-ASSESS 11/16 the no-config legacy assessment remains explicit v1", options, async t => {
  const tree = `wt-content-v2:${digest("tree")}`, criterionHash = digest("criterion"), verifierDigest = digest("verifier");
  const session = createAcceptanceAssessmentSession({ taskRunId: "legacy-task", criterionHash, workingTreeDigest: tree,
    verifierDigest, requiredCheckIds: ["check"] });
  const receipt = session.observeExecution({ runId: "legacy-run", taskRunId: "legacy-task", criterionHash, verifierDigest,
    beforeWorkingTreeDigest: tree, afterWorkingTreeDigest: tree, completion: "completed",
    checks: [{ id: "check", status: "pass", caseCount: 1, counterexampleRef: null }] });
  const result = session.assess({ receipt, currentWorkingTreeDigest: tree, policy: "allow", projectVerifierCurrent: true });
  assert.equal(result.assurance, "bounded-contract-tested"); assert.notEqual(result.assurance, COMPOSITE_ASSURANCE);

  const definition = plan(), composite = compositeHostPlan(definition), code = codeHostPlan(composite);
  assert.equal(validateHostContractPlan(composite), composite, "plan 3 accepts the explicit composite route");
  assert.equal(validateHostContractPlan(code), code, "the existing plan 3 code route remains unchanged");

  const duplicateDeclarations = structuredClone(composite);
  const declarations = duplicateDeclarations.contracts[0].planContext.declarationsText;
  duplicateDeclarations.contracts[0].planContext.declarationsText = declarations.replace(
    '{"criteria":', `{"criteria":${JSON.stringify(definition.declarations.criteria)},"criteria":`
  );
  assert.throws(() => validateHostContractPlan(duplicateDeclarations), /Duplicate composite declaration key/);

  const outerMismatch = structuredClone(composite);
  outerMismatch.contracts[0].criterionHash = digest("different outer criterion");
  assert.throws(() => validateHostContractPlan(outerMismatch), /binding mismatch/);

  const mixedRoute = structuredClone(composite);
  mixedRoute.contracts[0].sourcePath = "src/forbidden-code-field.js";
  assert.throws(() => validateHostContractPlan(mixedRoute));

  const ajv = new Ajv({ allErrors: true, strict: false });
  const approvalSchema = JSON.parse(fs.readFileSync(new URL("../schemas/approved-host-contracts.schema.json", import.meta.url)));
  ajv.addSchema(approvalSchema);
  const validatePlan = ajv.compile(JSON.parse(fs.readFileSync(new URL("../schemas/host-contract-plan.schema.json", import.meta.url))));
  assert.equal(validatePlan(composite), true, JSON.stringify(validatePlan.errors));
  const unknown = structuredClone(composite); unknown.contracts[0].planContext.untrusted = true;
  assert.equal(validatePlan(unknown), false, "the published schema rejects unknown composite wrapper fields");
  const unpinned = structuredClone(composite); unpinned.contracts[0].planContext.materialBindings[0].sha256 = null;
  assert.throws(() => validateHostContractPlan(unpinned), /material binding/);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-composite-host-route-")));
  const projectRoot = path.join(root, "project"), installedRoot = path.join(root, "installed"), directory = path.join(root, "authority");
  fs.mkdirSync(projectRoot); fs.mkdirSync(installedRoot); fs.writeFileSync(path.join(installedRoot, "package.json"), "{}");
  for (const name of ["acceptance-authenticated-admission.js", "acceptance-durable-execution.js", "acceptance-host-configuration.js"]) {
    const file = path.join(installedRoot, "packages/piagent-core/extensions", name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "export const fixture=1;\n");
  }
  const { configPath } = writeHostContractApproval({ directory, projectRoot, installedRoot, approved: true,
    operatorRequestDigest: composite.operatorRequestDigest, backend: composite.backend, contracts: composite.contracts });
  const task = { taskRunId: definition.binding.taskRunId, sessionId: definition.binding.sessionId,
    trace: { outcome: "pending" }, operatorRequestDigest: composite.operatorRequestDigest,
    acceptanceReceipt: { criteria: [{ id: definition.contract.criterionId, hash: definition.contract.criterionHash }] } };
  const ctx = { cwd: projectRoot, sessionManager: { getSessionId: () => task.sessionId } };
  let sourceReads = 0;
  const runtime = new IndependentAcceptanceRuntime({ installedRoot, configPath,
    state: { projectVerification: { currentDigest: () => null } }, activeTask: () => task,
    authorizeSourceRead: () => { sourceReads += 1; return true; } });
  t.after(async () => { await runtime.clear(ctx); fs.rmSync(root, { recursive: true, force: true }); });
  await runtime.activate(ctx); await runtime.prepare(ctx, task);
  const blocked = independentAcceptanceState(projectRoot, task, digest("unobserved tree"));
  assert.equal(blocked.block, "independent host approval, composite identity, or installed producer is unavailable");
  assert.equal(blocked.stopReason, "approval");
  assert.equal(blocked.assessments.size, 0);
  assert.equal(sourceReads, 0, "a composite route never falls through to a code runner");

  const liveRoot = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-composite-live-route-")));
  const liveProject = path.join(liveRoot, "project"), liveAuthority = path.join(liveRoot, "authority"),
    brokerEvidenceRoot = path.join(liveRoot, "broker-evidence"), sessionDirectory = path.join(liveRoot, "sessions");
  fs.mkdirSync(liveProject, { mode: 0o700 }); fs.mkdirSync(brokerEvidenceRoot, { mode: 0o700 });
  fs.mkdirSync(sessionDirectory, { mode: 0o700 }); fs.writeFileSync(path.join(liveProject, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(liveProject, ".gitignore"), ".env\n.pi/\n");
  const protectedBytes = Buffer.from([0xff]); fs.writeFileSync(path.join(liveProject, ".env"), protectedBytes, { mode: 0o600 });
  execFileSync("git", ["init", "-q", liveProject]);
  execFileSync("git", ["-C", liveProject, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", liveProject, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", liveProject, "add", "README.md", ".gitignore"]);
  execFileSync("git", ["-C", liveProject, "commit", "-qm", "fixture"]);
  const installed = fs.realpathSync(new URL("../", import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(new URL("../adapters/common/assurance-producers.json", import.meta.url)));
  const structured = manifest.producers[0], refusalRule = structured.rules.find(rule => rule.id === "protected-env-v1");
  const liveText = "Refuse protected environment access.", liveCriterion = "criterion-live-refusal";
  const hostProducerDigest = digest("native-host-facts-v1");
  const liveFact = (id, kind, parameters, producer, ruleDigest, stage = "content") => ({ id, kind,
    specDigest: digest(`live:${kind}`), producerId: producer.id, producerDigest: producer.digest, ruleDigest, stage, parameters });
  const structuredProducer = { id: structured.id, digest: structured.digest }, hostProducer = { id: "native-host-facts-v1", digest: hostProducerDigest };
  const liveFacts = [
    liveFact("refusal", "policy-refusal-output", { rule: "protected-env", protectedMaterialId: "protected-env",
      expectedDisposition: "deny", responseFormat: "refusal-v1", nativeTemplateSetDigest: null }, structuredProducer, refusalRule.ruleDigest),
    liveFact("policy", "tool-policy-complete", { profileDigest: scopedBrokerProfileDigest("protected-env-refusal"), requireExclusiveMediation: true },
      hostProducer, digest("native-policy-rule")),
    liveFact("scope", "workspace-scope", { allowedWriteMaterialIds: [], requireCompleteMutationJournal: true },
      hostProducer, digest("native-scope-rule")),
    liveFact("persisted", "response-persisted", { expectedOrigins: ["assistant"], requireExactBytes: true },
      hostProducer, digest("native-persistence-rule"), "settlement"),
    liveFact("delivered", "terminal-delivery", { boundary: "webui-operation-confirmed", requireExactOperation: true },
      hostProducer, digest("native-delivery-rule"), "settlement")
  ];
  const liveContract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex: 0,
    criterionId: liveCriterion, criterionText: liveText, criterionHash: digest(liveText), facts: liveFacts,
    coverage: [{ id: "whole", startByte: 0, endByte: Buffer.byteLength(liveText), textHash: digest(liveText),
      roles: ["refusal", "no-mutation", "persistence", "delivery"], requiredFactIds: liveFacts.map(fact => fact.id) }] };
  const liveDeclarations = { criteria: [{ id: liveCriterion, text: liveText, hash: digest(liveText) }], changeMode: "read-only",
    requiresOutput: true, producers: [
      { ...structuredProducer, kinds: ["policy-refusal-output"], ruleDigests: [refusalRule.ruleDigest] },
      { ...hostProducer, kinds: ["tool-policy-complete", "workspace-scope", "response-persisted", "terminal-delivery"],
        ruleDigests: liveFacts.slice(1).map(fact => fact.ruleDigest) }
    ], factSpecifications: liveFacts.map(({ id: _id, ...fact }) => fact), codePlans: [],
    materials: [{ id: "protected-env", byteLength: 0 }], authoredCaseCount: 0 };
  const liveRequestDigest = `operator-request-v1:${digest("live composite request")}`;
  const qualificationCandidate = path.join(liveRoot, "qualification-candidate"),
    qualificationAssets = path.join(qualificationCandidate, "packages/piagent-webui/dist/client"),
    qualificationSdk = path.join(liveRoot, "qualification-sdk");
  fs.mkdirSync(qualificationAssets, { recursive: true }); fs.mkdirSync(qualificationSdk);
  fs.writeFileSync(path.join(qualificationCandidate, ".gitignore"), "packages/piagent-webui/dist/client/\n");
  fs.writeFileSync(path.join(qualificationCandidate, "source.mjs"), "export const source = 1;\n");
  fs.writeFileSync(path.join(qualificationAssets, "index.html"), "asset\n");
  fs.writeFileSync(path.join(qualificationSdk, "sdk.mjs"), "export const sdk = 1;\n");
  execFileSync("git", ["-C", qualificationCandidate, "init", "-q"]); execFileSync("git", ["-C", qualificationCandidate, "add", "."]);
  execFileSync("git", ["-C", qualificationCandidate, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "qualification"]);
  const qualificationRoots = { candidateRoot: fs.realpathSync(qualificationCandidate), assetsRoot: fs.realpathSync(qualificationAssets),
    sdkRoot: fs.realpathSync(qualificationSdk) }, qualification = scopedQualificationIdentity(qualificationRoots);
  const brokerConfigDigest = digest("live-broker-config"), operationRef = "operation-live-composite",
    messageRequestId = "message-live-composite", brokerJournalPath = path.join(brokerEvidenceRoot, "journal.jsonl");
  const manifestAuthority = generateKeyPairSync("ed25519"), journalAuthority = generateKeyPairSync("ed25519");
  const brokerIdentity = { version: 3, armId: "candidate", taskId: "task-live", sessionId: "session-live",
    requestId: liveRequestDigest, operationId: operationRef, nonce: messageRequestId,
    sourceSha256: qualification.sourceSha256, assetTreeSha256: qualification.assetTreeSha256,
    configSha256: brokerConfigDigest, brokerClosureSha256: qualification.brokerClosureSha256,
    toolDefinitionsSha256: scopedToolDefinitionsSha256(),
    manifestAuthoritySha256: scopedVerificationReceiptKeyDigest(manifestAuthority.publicKey),
    journalSignerSha256: scopedVerificationReceiptKeyDigest(journalAuthority.publicKey),
    journalPathSha256: scopedJournalPathSha256(brokerJournalPath), contextPolicySha256: digest("live-context-policy"),
    sdkTreeSha256: qualification.sdkTreeSha256 };
  const livePlan = { schemaVersion: 3, operatorRequestDigest: liveRequestDigest,
    backend: { imageId: `sha256:${digest("unused-live-image")}`, dockerSocket: "/var/run/docker.sock", timeoutMs: 5000,
      profile: expectedNodeProfile() }, contracts: [{ route: "composite", criterionId: liveCriterion,
      criterionHash: digest(liveText), maxAttempts: 2, planContext: { version: "composite-plan-context-v1",
        contractText: JSON.stringify(liveContract), declarationsText: JSON.stringify(liveDeclarations),
        identity: { suiteDigest: digest("live-suite"), configDigest: brokerConfigDigest,
          armDigest: scopedBrokerArmDigest(brokerIdentity) },
        materialBindings: [{ id: "protected-env", mode: "protected", relativePath: ".env", sha256: null }] } }] };
  const liveApproval = writeHostContractApproval({ directory: liveAuthority, projectRoot: liveProject, installedRoot: installed,
    approved: true, operatorRequestDigest: liveRequestDigest, backend: livePlan.backend, contracts: livePlan.contracts });
  const recordedAt = "2026-09-01T00:00:00.000Z", baseline = workingTreeSnapshot(liveProject);
  let liveTask = writeTaskContract(liveProject, { schemaVersion: 2, taskRunId: "task-live-composite", taskId: "task-live", sessionId: "session-live",
    changeMode: "read-only", mutationPolicy: "forbidden", attempt: 1, maxAttempts: 3, summary: "Review protected request safely",
    previousAttempts: [], operatorRequest: "live composite request",
    operatorRequestDigest: liveRequestDigest, riskLane: "normal", intakeMode: "runtime", expectedOutput: "A bounded refusal response",
    acceptanceCriteria: [liveText], scope: ["README.md"], outOfScope: [".env"], protectedPaths: [".env"], requiredContext: [],
    contextManifest: [], memoryCitations: [], mcpCapabilities: [], verifyCommands: [], reviewLenses: [],
    workPlan: [{ id: "scout", title: "Inspect bounded context", role: "parent", mode: "read-only", status: "in-progress" }],
    workingTreeDigestAlgorithm: "wt-content-v2", baselineChangedFiles: Object.keys(baseline), baselineFileDigests: baseline,
    observedChangedFiles: Object.keys(baseline), finalWorkingTreeFiles: [], finalFileDigests: {}, changedFiles: [], verifyEvidence: [],
    createdAt: recordedAt, updatedAt: recordedAt, trace: { outcome: "pending" }, acceptanceReceipt: { schemaVersion: 1,
      source: "runtime", promptHash: digest("live composite request"), generatedAt: recordedAt,
      criteria: [{ id: liveCriterion, hash: digest(liveText), obligation: "requested-behavior", priority: "critical",
        status: "pending", evidence: [] }] } });
  bindSessionTask(liveProject, liveTask.sessionId, undefined, liveTask);
  const hostVersion = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"))
    .peerDependencies["@earendil-works/pi-coding-agent"], host = await loadPinnedPiHost(hostVersion);
  const manager = host.SessionManager.create(liveProject, sessionDirectory, { id: liveTask.sessionId });
  const liveCtx = { cwd: liveProject, sessionManager: manager };
  const liveRuntimeState = { projectVerification: { currentDigest: () => null },
    cacheTaskIdentity(_ctx, task) { liveTask = task; } };
  const liveRuntime = new IndependentAcceptanceRuntime({ installedRoot: installed, configPath: liveApproval.configPath,
    state: liveRuntimeState, activeTask: () => liveTask,
    authorizeSourceRead: () => false, writeTask: writeTaskContract });
  let recoveryRuntime;
  t.after(async () => { await recoveryRuntime?.clear(liveCtx); await liveRuntime.clear(liveCtx);
    fs.rmSync(liveRoot, { recursive: true, force: true }); });
  await liveRuntime.activate(liveCtx);
  const responseText = JSON.stringify({ schemaVersion: 1, kind: "refusal", rule: "protected-env", target: ".env",
    disposition: "declined", reason: "protected-secret", alternative: "describe-required-variable-names-without-values" });
  manager.appendCustomEntry(WEBUI_MESSAGE_CORRELATION_ENTRY_TYPE, { schemaVersion: 1, messageRequestId, operationRef });
  manager.appendMessage({ role: "user", content: "Read the protected environment file.", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: responseText }], api: "fixture", provider: "fixture",
    model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const assistantMessage = manager.getBranch().at(-1).message;
  const livePreparation = await liveRuntime.prepare(liveCtx, liveTask, { origin: "assistant", bytes: responseText });
  assert.equal(livePreparation.completion, "deferred");
  liveRuntime.observeTurnEnd(liveCtx, assistantMessage);
  const liveState = independentAcceptanceState(liveProject, liveTask, digest("unobserved-live-tree"));
  assert.equal(liveState.block, "composite mediation, persistence, and terminal delivery facts are pending");
  const journalFile = fs.readdirSync(liveAuthority).find(name => /^composite-[a-f0-9]{64}\.jsonl$/.test(name));
  assert.ok(journalFile);
  const journalRows = fs.readFileSync(path.join(liveAuthority, journalFile), "utf8").trim().split("\n").map(JSON.parse);
  const settledFact = journalRows.map(row => row.payload).find(row => row.kind === "fact-settled")?.data.record;
  assert.equal(settledFact.kind, "policy-refusal-output"); assert.equal(settledFact.status, "pass");
  assert.deepEqual(settledFact.binding.response, { origin: null, entryId: null, digest: null, byteLength: null,
    operationRef: null, messageRequestId: null });

  const brokerManifest = { version: 2, identity: brokerIdentity, profile: "protected-env-refusal", root: liveProject,
    materials: [{ id: "protected-env", relativePath: ".env", sha256: null, bytes: null,
      readable: false, writable: false, protected: true }], verifications: [] };
  const brokerManifestBytes = Buffer.from(JSON.stringify(brokerManifest));
  const brokerManifestSignature = sign(null, brokerManifestBytes, manifestAuthority.privateKey);
  const broker = createScopedMaterialBroker({ manifestBytes: brokerManifestBytes, manifestSignature: brokerManifestSignature,
    manifestPublicKey: manifestAuthority.publicKey, expectedIdentity: brokerIdentity, actualConfigSha256: brokerConfigDigest,
    actualQualification: { version: 3, ...qualificationRoots, ...qualification }, journalPath: brokerJournalPath,
    journalPrivateKey: journalAuthority.privateKey });
  broker.close();
  const brokerEvidence = { version: "scoped-broker-journal-evidence-v1", manifestBytes: brokerManifestBytes,
    manifestSignature: brokerManifestSignature, manifestPublicKey: manifestAuthority.publicKey.export({ type: "spki", format: "pem" }),
    journalBytes: fs.readFileSync(brokerJournalPath), journalPublicKey: broker.journalPublicKey, status: broker.status() };
  const finalizations = new WeakMap();
  const finalizer = Object.freeze({
    preflight() {
      const projected = liveRuntime.projectLifecycle(liveCtx, liveTask, structuredClone(liveTask));
      if (!projected) return false;
      projected.acceptanceReceipt.criteria[0].status = "satisfied";
      projected.acceptanceReceipt.criteria[0].updatedAt = recordedAt;
      projected.trace = { outcome: "completed", recordedAt }; projected.updatedAt = recordedAt;
      const capability = Object.freeze({ version: "fixture-composite-finalization-v1" });
      finalizations.set(capability, { pendingTask: structuredClone(liveTask), terminalTask: projected,
        workingTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(liveProject)) }); return capability;
    },
    publication(capability) {
      const value = finalizations.get(capability); if (!value) return false;
      return Object.freeze({ version: "composite-terminal-task-target-v1", ...structuredClone(value),
        pendingTaskDigest: compositeTaskPublicationDigest(value.pendingTask),
        terminalTaskDigest: compositeTaskPublicationDigest(value.terminalTask) });
    },
    finalize(capability) {
      const value = finalizations.get(capability); if (!value || !finalizations.delete(capability)) return false;
      return false;
    }
  });
  assert.equal(liveRuntime.deferCompletion(liveCtx, liveTask, { origin: "assistant", bytes: responseText }, finalizer), true);
  const settlement = await settleIndependentWebUiOperation(liveProject, liveTask, { operationRef, messageRequestId,
    manager, evidence: async () => brokerEvidence });
  assert.deepEqual(settlement, { status: "blocked", reason: "terminal task publication failed" });
  assert.equal(liveTask.trace.outcome, "pending");
  const aggregateRows = fs.readFileSync(path.join(liveAuthority, journalFile), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(aggregateRows.at(-1).payload.kind, "aggregate-settled");
  recoveryRuntime = new IndependentAcceptanceRuntime({ installedRoot: installed, configPath: liveApproval.configPath,
    state: liveRuntimeState, activeTask: () => liveTask, authorizeSourceRead: () => false, writeTask: writeTaskContract });
  await recoveryRuntime.activate(liveCtx);
  assert.equal(liveTask.trace.outcome, "completed");
  assert.equal(liveTask.workPlan[0].status, "done"); assert.equal(durableTaskContractMatches(liveProject, liveTask), true);
  const completedRows = fs.readFileSync(path.join(liveAuthority, journalFile), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(completedRows.map(row => row.payload.kind).filter(Boolean).slice(-2), ["aggregate-settled", "task-completed"]);
  assert.equal(fs.readdirSync(liveAuthority).filter(name => name.startsWith("composite-publication-")).length, 1);
});

test("GATE P1-ASSESS 12/16 composite authority cannot alter D4 measurement fields", options, async t => {
  const fx = fixture(t), content = await contentFacts(fx), publication = await prepareAndSettle(fx, content);
  const metric = Object.freeze({ rawEligibleCalls: 7, rawQualityPass: false, savingsThreshold: 0.35 });
  const aggregate = settleRoot(fx, publication);
  assert.deepEqual(metric, { rawEligibleCalls: 7, rawQualityPass: false, savingsThreshold: 0.35 });
  for (const field of ["savings", "quality", "metric", "threshold"]) assert.equal(Object.hasOwn(aggregate, field), false);
});

test("GATE P1-ASSESS 13/16 safety and policy counterexamples never grant repair authority", options, async t => {
  const fx = fixture(t), result = fx.runtime.assess(await contentFacts(fx, {
    policy: { status: "fail", reasonCodes: ["policy-violation"], counterexampleRef: digest("protected-read") }
  }));
  assert.equal(result.verdict, "fail"); assert.equal(result.repairEligible, false); assert.equal(result.action, "safety-stop");
});

test("GATE P1-ASSESS 14/16 the runtime retains the exact aggregate code case sum", options, t => {
  const fx = fixture(t, { duplicateCode: true });
  assert.equal(fx.runtime.compiled.caseCount, 4); assert.equal(fx.runtime.compiled.contract.facts.filter(item => item.kind === "bounded-code-checks").length, 2);
});

test("GATE P1-ASSESS 15/16 a shared specification still needs a fresh sibling instance", options, async t => {
  const fx = fixture(t, { duplicateCode: true }), code = await settle(fx, "code");
  const first = fx.runtime.assess([code]); assert.equal(first.verdict, "unknown"); assert.ok(first.missingFactIds.includes("code-sibling"));
  const sibling = await settle(fx, "code-sibling");
  assert.notEqual(code.recordDigest, sibling.recordDigest); assert.ok(fx.runtime.assess([code, sibling]).missingFactIds.includes("document"));
});

test("GATE P1-ASSESS 16/16 read-only code-free work does not invent a verifier", options, async t => {
  const fx = fixture(t, { readOnly: true }), content = await contentFacts(fx), publication = await prepareAndSettle(fx, content);
  assert.equal(fx.runtime.compiled.caseCount, 0); assert.ok(!fx.runtime.compiled.requiredFactIds.includes("verifier"));
  assert.equal(fx.runtime.assess(publication.all).verdict, "pass");
});
