import assert from "node:assert/strict";
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compositeCodePlanDigest } from "../packages/piagent-core/extensions/acceptance-composite-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";

import {
  openCompositeAssuranceJournal,
  openCompositeAssuranceRuntime,
  sealCompositePlanContext
} from "../packages/piagent-core/runtime/verification/runtime-assurance-facts.ts";

const digest = value => createHash("sha256").update(value).digest("hex");
const options = { timeout: 5000 };

function definition() {
  const text = "Implement f.", producerDigest = digest("custody-producer");
  const profile = expectedNodeProfile(), codeDefinition = { sourcePath: "src/f.js", modulePaths: [], exportName: "f", profile,
    checks: [{ id: "behavior", cases: [{ id: "case-1", args: [], invocation: { kind: "call" },
      expected: { outcome: "return", value: { type: "number", value: 1 } } }] }] };
  const codePlan = { digest: compositeCodePlanDigest(codeDefinition), backendProfileDigest: profile.digest,
    caseCount: 1, ...codeDefinition };
  const fact = (id, kind, parameters, stage = "content") => ({ id, kind, specDigest: digest(`spec:${kind}`),
    producerId: "custody-producer", producerDigest, ruleDigest: digest(`rule:${kind}`), stage, parameters });
  const facts = [
    fact("code", "bounded-code-checks", { codePlanDigest: codePlan.digest, backendProfileDigest: codePlan.backendProfileDigest }),
    fact("verifier", "project-verifier-current", { commandSetDigest: digest("commands") }),
    fact("scope", "workspace-scope", { allowedWriteMaterialIds: [], requireCompleteMutationJournal: true }),
    fact("policy", "tool-policy-complete", { profileDigest: digest("policy"), requireExclusiveMediation: true }),
    fact("persisted", "response-persisted", { expectedOrigins: ["assistant"], requireExactBytes: true }, "settlement"),
    fact("delivered", "terminal-delivery", { boundary: "webui-operation-confirmed", requireExactOperation: true }, "settlement")
  ];
  const contract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex: 0,
    criterionId: "criterion-custody", criterionText: text, criterionHash: digest(text), facts,
    coverage: [{ id: "behavior", startByte: 0, endByte: Buffer.byteLength(text), textHash: digest(text), roles: ["behavior"],
      requiredFactIds: facts.map(item => item.id) }] };
  const declarations = { criteria: [{ id: contract.criterionId, text, hash: digest(text) }], changeMode: "source-change", requiresOutput: true,
    producers: [{ id: "custody-producer", digest: producerDigest, kinds: facts.map(item => item.kind), ruleDigests: facts.map(item => item.ruleDigest) }],
    factSpecifications: facts.map(({ id: _id, ...spec }) => spec),
    codePlans: [codePlan], materials: [], authoredCaseCount: 1 };
  const binding = { projectId: digest("project"), projectHead: digest("head"), sourceDigest: digest("source"),
    materialSnapshotDigest: digest("materials"), suiteDigest: digest("suite"), configDigest: digest("config"), armDigest: digest("arm"),
    taskRunId: "task-custody", sessionId: "session-custody", operatorRequestDigest: `operator-request-v1:${digest("request")}`,
    taskContractDigest: digest("task-contract"), criterionIndex: 0, criterionId: contract.criterionId, criterionHash: digest(text),
    runtimeGeneration: 3, phaseHeadDigest: digest("phase"), producerManifestDigest: digest("manifest"), verifierDigest: digest("verifier") };
  return { contract, declarations, binding };
}

function fixture(t) {
  const plan = definition(), key = createSecretKey(randomBytes(32));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piagent-composite-custody-")));
  const projectRoot = path.join(root, "project"), authority = path.join(root, "authority"), filePath = path.join(authority, "journal.jsonl");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  const sealed = sealCompositePlanContext({ key, contractText: JSON.stringify(plan.contract), declarations: plan.declarations,
    binding: plan.binding, maxAttempts: 2 });
  const current = structuredClone(plan.binding), fx = { plan, key, root, projectRoot, authority, filePath, sealed, current, journal: null, runtime: null };
  const open = expectedHead => {
    fx.journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: sealed.contextDigest,
      ...(expectedHead ? { expectedHead } : {}) });
    fx.runtime = openCompositeAssuranceRuntime({ key, sealedContext: sealed, journal: fx.journal,
      currentBinding: () => structuredClone(current) });
  };
  open(); fx.open = open;
  fx.responseBytes = '{"result":"custody"}\n';
  fx.response = { origin: "assistant", entryId: "assistant-entry", digest: digest(fx.responseBytes),
    byteLength: Buffer.byteLength(fx.responseBytes), operationRef: "operation-custody", messageRequestId: "request-custody" };
  t.after(() => { try { fx.journal?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return fx;
}

async function settle(fx, id, { status = "pass", reasonCodes = [], counterexampleRef = null, collect } = {}) {
  const reserved = fx.runtime.reserveFact(id, { retry: false });
  if (reserved.status === "current") return reserved.receipt;
  assert.equal(reserved.status, "reserved");
  const fact = fx.plan.contract.facts.find(item => item.id === id), producer = fx.runtime.producerFor(id);
  return fx.runtime.settleFact({ reservation: reserved.reservation, producer, collect: collect ?? (async () => ({
    status, observationDigest: digest(`observation:${id}:${status}`), counterexampleRef, reasonCodes,
    ...(fact.stage === "settlement" ? { response: fx.response } : {})
  })) });
}

async function prepare(fx) {
  const content = [];
  for (const fact of fx.plan.contract.facts.filter(item => item.stage === "content")) content.push(await settle(fx, fact.id));
  const preparation = fx.runtime.prepareResponse({ facts: content, bytes: fx.responseBytes, origin: fx.response.origin,
    entryId: fx.response.entryId, operationRef: fx.response.operationRef, messageRequestId: fx.response.messageRequestId });
  return { content, preparation };
}

test("GATE P1-CUSTODY 01/12 exact signed durable reread issues only new live capabilities", options, async t => {
  const fx = fixture(t), old = await settle(fx, "code"), head = fx.journal.head();
  fx.journal.close(); fx.open(head);
  const current = fx.runtime.reissue(); assert.equal(current.facts.length, 1); assert.equal(current.facts[0].status, "pass");
  assert.ok(fx.runtime.assess([old]).reasons.includes("untrusted-fact"));
  assert.ok(fx.runtime.assess(current.facts).missingFactIds.includes("verifier"));
});

test("GATE P1-CUSTODY 02/12 forged copied and replayed fact capabilities are rejected", options, async t => {
  const fx = fixture(t), first = await settle(fx, "code");
  for (const copied of [structuredClone(first), { ...first }]) assert.ok(fx.runtime.assess([copied]).reasons.includes("untrusted-fact"));
  const retry = fx.runtime.reserveFact("code", { retry: true }); assert.equal(retry.status, "reserved");
  const second = await fx.runtime.settleFact({ reservation: retry.reservation, producer: fx.runtime.producerFor("code"), collect: async () => ({
    status: "pass", observationDigest: digest("second"), counterexampleRef: null, reasonCodes: []
  }) });
  assert.ok(fx.runtime.assess([first]).reasons.includes("untrusted-fact")); assert.notEqual(first.recordDigest, second.recordDigest);
  const forged = structuredClone(fx.sealed); forged.signature = "0".repeat(64);
  assert.throws(() => openCompositeAssuranceRuntime({ key: fx.key, sealedContext: forged, journal: fx.journal,
    currentBinding: () => structuredClone(fx.current) }), /unauthenticated/);
});

test("GATE P1-CUSTODY 03/12 source drift invalidates a previously current fact", options, async t => {
  const fx = fixture(t), receipt = await settle(fx, "code"); fx.current.sourceDigest = digest("changed-source");
  const result = fx.runtime.assess([receipt]); assert.equal(result.verdict, "unknown"); assert.deepEqual(result.reasons, ["stale-binding"]);
});

test("GATE P1-CUSTODY 04/12 verifier drift invalidates a previously current fact", options, async t => {
  const fx = fixture(t), receipt = await settle(fx, "verifier"); fx.current.verifierDigest = digest("changed-verifier");
  assert.deepEqual(fx.runtime.assess([receipt]).reasons, ["stale-binding"]);
});

test("GATE P1-CUSTODY 05/12 stale rule identity cannot enter a signed plan", options, t => {
  const fx = fixture(t), changed = structuredClone(fx.plan);
  changed.contract.facts[0].ruleDigest = digest("changed-rule");
  assert.throws(() => sealCompositePlanContext({ key: fx.key, contractText: JSON.stringify(changed.contract), declarations: changed.declarations,
    binding: changed.binding, maxAttempts: 2 }), /unlisted producer\/rule|unlisted or changed fact specification/);
});

test("GATE P1-CUSTODY 06/12 stale producer manifest and wrong producer capability fail closed", options, async t => {
  const fx = fixture(t), reserved = fx.runtime.reserveFact("code"), wrong = fx.runtime.producerFor("verifier");
  await assert.rejects(() => fx.runtime.settleFact({ reservation: reserved.reservation, producer: wrong,
    collect: async () => ({ status: "pass", observationDigest: digest("wrong"), counterexampleRef: null, reasonCodes: [] }) }), /Untrusted/);
  fx.current.producerManifestDigest = digest("changed-manifest");
  assert.deepEqual(fx.runtime.assess([]).reasons, ["stale-binding"]);
});

test("GATE P1-CUSTODY 07/12 wrong task session request and operation identities abstain", options, async t => {
  const fx = fixture(t), receipt = await settle(fx, "code"), original = structuredClone(fx.current);
  for (const [field, value] of [["taskRunId", "other-task"], ["sessionId", "other-session"],
    ["operatorRequestDigest", `operator-request-v1:${digest("other-request")}`]]) {
    Object.assign(fx.current, original, { [field]: value }); assert.deepEqual(fx.runtime.assess([receipt]).reasons, ["stale-binding"]);
  }
  Object.assign(fx.current, original); const published = await prepare(fx);
  const reserved = fx.runtime.reserveFact("persisted"), producer = fx.runtime.producerFor("persisted");
  await assert.rejects(() => fx.runtime.settleFact({ reservation: reserved.reservation, producer, collect: async () => ({
    status: "pass", observationDigest: digest("persisted"), counterexampleRef: null, reasonCodes: [],
    response: { ...fx.response, operationRef: "other-operation" }
  }) }), /response mismatch/i);
  assert.ok(published.preparation);
});

test("GATE P1-CUSTODY 08/12 response byte mismatch cannot satisfy persistence", options, async t => {
  const fx = fixture(t); await prepare(fx);
  const reserved = fx.runtime.reserveFact("persisted"), producer = fx.runtime.producerFor("persisted");
  await assert.rejects(() => fx.runtime.settleFact({ reservation: reserved.reservation, producer, collect: async () => ({
    status: "pass", observationDigest: digest("persisted"), counterexampleRef: null, reasonCodes: [],
    response: { ...fx.response, digest: digest("different-response") }
  }) }), /response mismatch/i);
});

test("GATE P1-CUSTODY 09/12 mutation during an awaited producer capture becomes stale UNKNOWN", options, async t => {
  const fx = fixture(t), original = fx.current.sourceDigest;
  const receipt = await settle(fx, "code", { collect: async () => {
    fx.current.sourceDigest = digest("mid-await-source"); await Promise.resolve();
    return { status: "pass", observationDigest: digest("would-pass"), counterexampleRef: null, reasonCodes: [] };
  } });
  fx.current.sourceDigest = original;
  const result = fx.runtime.assess([receipt]); assert.equal(result.verdict, "unknown"); assert.ok(result.reasons.includes("stale-binding"));
});

test("GATE P1-CUSTODY 10/12 a corrupt durable chain is rejected before capability issue", options, async t => {
  const fx = fixture(t); await settle(fx, "code"); fx.journal.close();
  const source = fs.readFileSync(fx.filePath, "utf8"); fs.writeFileSync(fx.filePath, source.replace("context-opened", "context-Xpened"));
  assert.throws(() => fx.open(), /signature|chain/);
});

test("GATE P1-CUSTODY 11/12 an externally anchored head makes rollback observable", options, t => {
  const fx = fixture(t), snapshot = fs.readFileSync(fx.filePath), oldHead = fx.journal.head();
  fx.runtime.reserveFact("code"); const currentHead = fx.journal.head(); assert.notEqual(currentHead, oldHead);
  fx.journal.close(); fs.writeFileSync(fx.filePath, snapshot);
  assert.throws(() => fx.open(currentHead), /rollback|wrong head/);
});

test("GATE P1-CUSTODY 12/12 interrupted reservation needs exact stopped-producer reconciliation", options, async t => {
  const fx = fixture(t), first = fx.runtime.reserveFact("code"); assert.equal(first.status, "reserved");
  const head = fx.journal.head(); fx.journal.close(); fx.open(head);
  assert.deepEqual(fx.runtime.state().pendingFactIds, ["code"]);
  assert.throws(() => fx.runtime.reconcileInterrupted({ factId: "code", attemptId: first.reservation.attemptId, producerStopped: false }), /stopped/);
  fx.runtime.reconcileInterrupted({ factId: "code", attemptId: first.reservation.attemptId, producerStopped: true });
  const retry = fx.runtime.reserveFact("code", { retry: true }); assert.equal(retry.status, "reserved");
  const receipt = await fx.runtime.settleFact({ reservation: retry.reservation, producer: fx.runtime.producerFor("code"), collect: async () => ({
    status: "pass", observationDigest: digest("retry"), counterexampleRef: null, reasonCodes: []
  }) });
  assert.equal(receipt.status, "pass"); assert.deepEqual(fx.runtime.state().pendingFactIds, []);
});
