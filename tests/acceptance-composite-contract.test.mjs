import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { compileCompositeContract, compositeCodePlanDigest, ConfigurationError } from "../packages/piagent-core/extensions/acceptance-composite-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const profile = expectedNodeProfile(), profileDigest = profile.digest;
const producerDigest = hash("test-only producer, not authority");

function codePlan(caseCount = 2) {
  const definition = { sourcePath: "src/f.js", modulePaths: [], exportName: "f", profile,
    checks: [{ id: "behavior", cases: Array.from({ length: caseCount }, (_, index) => ({ id: `case-${index}`,
      args: [], invocation: { kind: "call" }, expected: { outcome: "return", value: { type: "number", value: 1 } } })) }] };
  return { digest: compositeCodePlanDigest(definition), backendProfileDigest: profileDigest, caseCount, ...definition };
}

function fixture(text = "Implement f.\nDocument x.") {
  const approvedCodePlan = codePlan(), codeDigest = approvedCodePlan.digest;
  const fact = (id, kind, parameters, stage = "content") => ({
    id, kind, specDigest: hash(`spec:${kind}`), producerId: "test-producer", producerDigest,
    ruleDigest: hash(`rule:${kind}`), stage, parameters
  });
  const facts = [
    fact("code", "bounded-code-checks", { codePlanDigest: codeDigest, backendProfileDigest: profileDigest }),
    fact("document", "config-document-literals", { configMaterialId: "config", documentMaterialId: "document",
      format: "config-literals-v1", requiredFields: ["service", "restartCommand"] }),
    fact("context", "context-current", { requiredMaterialIds: ["config"], delivery: "actual-tool-result-or-prompt" }),
    fact("scope", "workspace-scope", { allowedWriteMaterialIds: ["document"], requireCompleteMutationJournal: true }),
    fact("verifier", "project-verifier-current", { commandSetDigest: hash("fixed verifier declaration") }),
    fact("policy", "tool-policy-complete", { profileDigest: hash("fixed tool policy"), requireExclusiveMediation: true }),
    fact("persisted", "response-persisted", { expectedOrigins: ["assistant"], requireExactBytes: true }, "settlement"),
    fact("delivered", "terminal-delivery", { boundary: "webui-operation-confirmed", requireExactOperation: true }, "settlement")
  ];
  const split = Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1));
  const bytes = Buffer.from(text);
  const clause = (id, startByte, endByte, roles, requiredFactIds) => ({
    id, startByte, endByte, textHash: hash(bytes.subarray(startByte, endByte)), roles, requiredFactIds
  });
  const contract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex: 0,
    criterionId: "criterion-a", criterionText: text, criterionHash: hash(text), facts,
    coverage: [clause("behavior", 0, split, ["behavior"], ["code", "scope", "verifier", "policy", "persisted", "delivered"]),
      clause("document", split, bytes.length, ["document-literals"], ["document", "context"])] };
  const context = {
    criteria: [{ id: "criterion-a", text, hash: hash(text) },
      { id: "criterion-b", text: "Keep the safety constraint.", hash: hash("Keep the safety constraint.") }],
    changeMode: "source-change", requiresOutput: true,
    producers: [{ id: "test-producer", digest: producerDigest, kinds: facts.map(x => x.kind), ruleDigests: facts.map(x => x.ruleDigest) }],
    factSpecifications: facts.map(({ id: _id, ...spec }) => spec),
    codePlans: [approvedCodePlan],
    materials: [{ id: "config", byteLength: 20 }, { id: "document", byteLength: 40 }], authoredCaseCount: 2
  };
  return { contract, context };
}

function replaceCodePlan(data, caseCount) {
  const plan = codePlan(caseCount);
  for (const fact of data.contract.facts.filter(item => item.kind === "bounded-code-checks")) fact.parameters.codePlanDigest = plan.digest;
  data.context.factSpecifications.find(item => item.kind === "bounded-code-checks").parameters.codePlanDigest = plan.digest;
  data.context.codePlans = [plan];
}

const compile = ({ contract, context }) => compileCompositeContract(JSON.stringify(contract), context);
function rejects(change, pattern = /./) {
  const data = fixture(); change(data.contract, data.context);
  assert.throws(() => compile(data), error => error instanceof ConfigurationError && pattern.test(error.message));
}
function removeFact(contract, id) {
  contract.facts = contract.facts.filter(x => x.id !== id);
  for (const clause of contract.coverage) clause.requiredFactIds = clause.requiredFactIds.filter(x => x !== id);
}
function duplicateCode(data, count) {
  for (let index = 1; index < count; index += 1) {
    const copy = { ...structuredClone(data.contract.facts[0]), id: `code-${index}` };
    data.contract.facts.push(copy); data.contract.coverage[0].requiredFactIds.push(copy.id);
  }
}

test("DA2 composite preserves full LF and Unicode coverage without authority", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/composite-criterion.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  for (const text of ["Implement f.\nDocument x.", "Implement café 😀.\nDocument 日本語."]) {
    const data = fixture(text), result = compile(data);
    assert.equal(validate(data.contract), true, JSON.stringify(validate.errors));
    assert.equal(result.criterionBinding, "matched");
    assert.equal(result.contract.criterionText, text);
    assert.equal(result.contract.criterionHash, hash(text));
    const bytes = Buffer.from(text);
    assert.equal(Buffer.concat(result.contract.coverage.map(span => bytes.subarray(span.startByte, span.endByte))).toString(), text);
    assert.deepEqual(new Set(result.requiredFactIds), new Set(data.contract.facts.map(x => x.id)));
    assert.equal(result.caseCount, 2);
    assert.equal(result.authority, "none");
    for (const field of ["verdict", "completionAllowed", "assurance", "receipt"]) assert.equal(Object.hasOwn(result, field), false);
    assert.ok(result.requirements.includes("authenticated-current-full-criterion-aggregate"));
    assert.equal(data.context.criteria.length, 2);
  }
});

test("DA2 composite result and input declarations are independent immutable data", () => {
  const data = fixture(), result = compile(data);
  data.context.codePlans[0].caseCount = 256;
  data.contract.criterionText = "Changed after compilation";
  assert.equal(result.caseCount, 2);
  assert.equal(result.contract.criterionText, "Implement f.\nDocument x.");
  assert.throws(() => result.contract.facts[0].parameters.codePlanDigest = hash("changed"), TypeError);
  assert.throws(() => result.requiredFactIds.push("invented"), TypeError);
  assert.throws(() => result.requirements.length = 0, TypeError);
});

test("DA2 composite rejects unknown versions and strict schema fields", () => {
  rejects(c => c.route = "code");
  rejects(c => c.compositeContractVersion = "composite-criterion-v2");
  rejects(c => c.verdict = "pass");
  rejects(c => c.facts[0].parameters.optional = true);
  rejects(c => c.coverage[0].threshold = 1);
  rejects(c => c.facts[0].kind = { toString: 0 });
  rejects(c => c.coverage[0].roles = [{ toString: 0 }]);
  rejects(c => c.coverage[0] = null);
  rejects(c => c.facts[6].stage = "content");
  rejects(c => c.facts[1].parameters.requiredFields.reverse());
});

test("DA2 composite rejects duplicate JSON keys including escaped aliases", () => {
  const { contract, context } = fixture(), raw = JSON.stringify(contract);
  for (const duplicate of [
    raw.replace('"route":"composite"', '"route":"code","route":"composite"'),
    raw.replace('"criterionId":', '"criterionId":"ignored","criterion\\u0049d":'),
    raw.replace('"stage":"content"', '"st\\u0061ge":"settlement","stage":"content"'),
    raw.replace('"requireExactBytes":true', '"requireExactBytes":false,"requireExactBytes":true')
  ]) assert.throws(() => compileCompositeContract(duplicate, context), ConfigurationError);
  assert.equal(compileCompositeContract(raw, context).criterionBinding, "matched");
});

test("DA2 composite rejects duplicate identifiers and invalid declarations", () => {
  rejects(c => c.facts[1].id = c.facts[0].id);
  rejects(c => c.coverage[1].id = c.coverage[0].id);
  rejects(c => c.coverage[0].roles.push("behavior"));
  rejects(c => c.coverage[0].requiredFactIds.push("code"));
  rejects((c, x) => x.criteria[1].id = x.criteria[0].id);
  rejects((c, x) => x.factSpecifications.push(x.factSpecifications[0]));
  rejects((c, x) => x.codePlans.push(x.codePlans[0]));
  rejects((c, x) => x.materials.push(x.materials[0]));
});

test("DA2 composite rejects gaps overlaps and reordered coverage", () => {
  rejects(c => c.coverage[0].startByte = 1);
  rejects(c => c.coverage[1].startByte += 1);
  rejects(c => c.coverage[1].startByte -= 1);
  rejects(c => c.coverage[1].endByte -= 1);
  rejects(c => c.coverage.reverse());
  rejects(c => c.coverage.pop());
  rejects(c => c.coverage[0].endByte = 0);
});

test("DA2 composite rejects split codepoints and malformed Unicode", () => {
  const data = fixture("Implement 😀.\nDocument x.");
  const bytes = Buffer.from(data.contract.criterionText), split = Buffer.byteLength("Implement ") + 1;
  data.contract.coverage[0].endByte = split; data.contract.coverage[1].startByte = split;
  data.contract.coverage[0].textHash = hash(bytes.subarray(0, split));
  data.contract.coverage[1].textHash = hash(bytes.subarray(split));
  assert.throws(() => compile(data), ConfigurationError);
  rejects(c => { c.criterionText = "bad\ud800"; c.criterionHash = hash(c.criterionText); });
  const good = fixture();
  assert.throws(() => compileCompositeContract(JSON.stringify(good.contract).replace('"route":', '"\ud800":0,"route":'), good.context), ConfigurationError);
});

test("DA2 composite distinguishes current criterion mismatch from configuration errors", () => {
  for (const mutate of [
    c => c.criterionIndex = 1,
    c => c.criterionId = "different-id",
    (c, x) => { x.criteria[0].text = "Current replacement."; x.criteria[0].hash = hash(x.criteria[0].text); }
  ]) {
    const data = fixture(); mutate(data.contract, data.context);
    const result = compile(data);
    assert.equal(result.criterionBinding, "unknown");
    assert.deepEqual(result.bindingReasons, ["current-criterion-mismatch"]);
    assert.equal(result.authority, "none");
  }
  rejects(c => c.criterionHash = hash("Implement f."));
  rejects((c, x) => x.criteria[0].hash = hash("sibling alias"));
  rejects(c => c.criterionIndex = 12);
});

test("DA2 composite rejects incorrect span hashes", () => {
  rejects(c => c.coverage[0].textHash = hash("Implement f."));
  rejects(c => c.coverage[1].textHash = c.coverage[0].textHash);
  rejects(c => c.coverage[1].textHash = "A".repeat(64));
});

test("DA2 composite requires every role and every referenced fact", () => {
  rejects(c => c.coverage[0].roles = []);
  rejects(c => c.coverage[0].roles = ["any-proof"]);
  rejects(c => c.coverage[1].requiredFactIds.push("missing"));
  rejects(c => c.coverage[1].requiredFactIds = ["context"]);
  rejects(c => c.coverage[0].requiredFactIds = c.coverage[0].requiredFactIds.filter(id => id !== "policy"));
});

test("DA2 composite enforces conjunctive role compatibility", () => {
  rejects(c => c.coverage[0].roles = ["diagnosis"]);
  rejects(c => c.coverage[1].roles = ["refusal"]);
  rejects(c => { c.coverage[0].roles.push("path-scope"); removeFact(c, "policy"); });
  rejects(c => { c.coverage[0].roles.push("verification"); removeFact(c, "verifier"); });
  rejects(c => removeFact(c, "context"));
  rejects(c => { c.coverage[0].roles.push("persistence"); removeFact(c, "persisted"); });
});

test("DA2 composite inserts output and mutation prerequisites", () => {
  for (const id of ["persisted", "delivered", "verifier", "scope"]) rejects(c => removeFact(c, id));
  const readOnly = fixture();
  readOnly.context.changeMode = "read-only";
  readOnly.contract.facts.find(x => x.id === "scope").parameters.allowedWriteMaterialIds = [];
  readOnly.context.factSpecifications.find(x => x.kind === "workspace-scope").parameters.allowedWriteMaterialIds = [];
  removeFact(readOnly.contract, "code"); removeFact(readOnly.contract, "verifier");
  readOnly.contract.coverage[0].roles = ["read-context"];
  readOnly.contract.coverage[0].requiredFactIds.push("context");
  const result = compile(readOnly);
  assert.equal(result.criterionBinding, "matched");
  assert.equal(result.caseCount, 0);
  assert.ok(!result.requiredFactIds.includes("verifier"));
  assert.ok(result.requirements.includes("current-source-task-session-request-response-policy-binding"));
  rejects(c => {
    for (const id of ["verifier", "scope", "policy"]) removeFact(c, id);
    for (const clause of c.coverage) {
      clause.roles = ["read-context"];
      if (!clause.requiredFactIds.includes("context")) clause.requiredFactIds.push("context");
    }
  });
});

test("DA2 composite rejects unknown producer rule specification and backend pins", () => {
  rejects(c => c.facts[0].producerId = "unlisted");
  rejects(c => c.facts[0].producerDigest = hash("other producer"));
  rejects(c => c.facts[0].ruleDigest = hash("unlisted rule"));
  rejects(c => c.facts[0].specDigest = hash("unknown spec"));
  rejects((c, x) => x.codePlans = []);
  rejects((c, x) => x.codePlans[0].backendProfileDigest = hash("other profile"));
  rejects((c, x) => x.codePlans[0].sourcePath = "../outside.js");
  rejects((c, x) => x.codePlans[0].checks[0].cases[0].expected.value.value = 2);
  rejects(c => c.facts[1].parameters.documentMaterialId = "unlisted");
  rejects((c, x) => x.producers[0].kinds = ["config-document-literals"]);
  rejects(c => c.facts.find(x => x.kind === "context-current").parameters.requiredMaterialIds = []);
  rejects(c => c.facts.find(x => x.kind === "context-current").parameters.delivery = "declared-only");
});

test("DA2 composite enforces span and criterion fact limits", () => {
  rejects(c => c.coverage = Array.from({ length: 33 }, (_, i) => ({ ...c.coverage[0], id: `span-${i}` })));
  const maxFacts = fixture(); duplicateCode(maxFacts, 9);
  maxFacts.context.authoredCaseCount = 18;
  assert.equal(maxFacts.contract.facts.length, 16);
  assert.equal(compile(maxFacts).caseCount, 18);
  duplicateCode(maxFacts, 2); maxFacts.contract.facts.at(-1).id = "extra-code";
  maxFacts.contract.coverage[0].requiredFactIds[maxFacts.contract.coverage[0].requiredFactIds.length - 1] = "extra-code";
  assert.throws(() => compile(maxFacts), ConfigurationError);
  rejects(c => c.coverage[0].requiredFactIds = Array.from({ length: 17 }, (_, i) => `fact-${i}`));
});

test("DA2 composite enforces shared specification and aggregate case budgets", () => {
  const data = fixture(); duplicateCode(data, 2);
  replaceCodePlan(data, 128); data.context.authoredCaseCount = 256;
  assert.equal(compile(data).caseCount, 256);
  replaceCodePlan(data, 129); data.context.authoredCaseCount = 258;
  assert.throws(() => compile(data), ConfigurationError);
  rejects((c, x) => x.authoredCaseCount = 6913);
  rejects((c, x) => x.authoredCaseCount = 1);
  rejects((c, x) => x.factSpecifications = Array.from({ length: 17 }, (_, i) => ({ ...x.factSpecifications[0], specDigest: hash(`spec-${i}`) })));
  rejects((c, x) => x.criteria = Array.from({ length: 13 }, (_, i) => ({ ...x.criteria[0], id: `criterion-${i}` })));
});

test("DA2 composite rejects oversized or hostile compile inputs", () => {
  const data = fixture(), raw = JSON.stringify(data.contract);
  for (const input of [null, data.contract, " ".repeat(1024 * 1024 + 1), raw + "x", raw.replace('"criterionIndex":0', '"criterionIndex":1e999')]) {
    assert.throws(() => compileCompositeContract(input, data.context), ConfigurationError);
  }
  let reads = 0;
  const hostile = { ...data.context };
  Object.defineProperty(hostile, "requiresOutput", { enumerable: true, get() { reads += 1; return true; } });
  assert.throws(() => compileCompositeContract(raw, hostile), ConfigurationError);
  assert.equal(reads, 0);
  const proxy = new Proxy(data.context, { getPrototypeOf() { reads += 1; return Object.prototype; } });
  assert.throws(() => compileCompositeContract(raw, proxy), ConfigurationError);
  assert.equal(reads, 0);
  for (const change of [
    x => delete x.criteria[0],
    x => x.criteria.extra = true,
    x => Object.setPrototypeOf(x.producers[0], { inherited: true }),
    x => Object.defineProperty(x, Symbol("hidden"), { value: true }),
    x => x.materials[0].byteLength = 65537,
    x => x.materials = Array.from({ length: 17 }, (_, i) => ({ id: `material-${i}`, byteLength: 65536 }))
  ]) {
    const context = structuredClone(data.context); change(context);
    assert.throws(() => compileCompositeContract(raw, context), ConfigurationError);
  }
  const repeated = { ...data.context, fillers: Array(32).fill("\n".repeat(65536)) };
  const stringify = JSON.stringify;
  let aggregateSerializations = 0;
  JSON.stringify = function (value, ...args) {
    if (value && typeof value === "object" && Object.hasOwn(value, "fillers")) {
      aggregateSerializations += 1; throw new Error("Unbounded aggregate serialization attempted");
    }
    return stringify(value, ...args);
  };
  try { assert.throws(() => compileCompositeContract(raw, repeated), ConfigurationError); }
  finally { JSON.stringify = stringify; }
  assert.equal(aggregateSerializations, 0);
});
