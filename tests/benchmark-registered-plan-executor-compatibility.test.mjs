import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { buildRegisteredPlanDrafts } from "../scripts/benchmark-registered-plan-author.mjs";
import { calendarExpirySource } from "./fixtures/iso-expiry-profile.mjs";
import { familyRows } from "./helpers/production-family-programs.mjs";

const ASSET_ROOT = process.env.PIAGENT_REGISTERED_ASSET_ROOT;
const ENABLED = process.env.PIAGENT_RUN_REGISTERED_PLAN_EXECUTOR === "1";
const SCENARIO = process.env.PIAGENT_REGISTERED_PLAN_SCENARIO;
const SUITE_DIGEST = "83b03a0ec872d1d6196fb8c4447e628459c11303748109c24da8dbccbbece8cb";
const ZERO = "0".repeat(64);
const SUITE_ROOT = path.resolve(import.meta.dirname, "../benchmarks/production-v2");
const planFile = ASSET_ROOT ? fs.readdirSync(path.join(ASSET_ROOT, "plans")).sort()
  .find(name => name.endsWith(".json")) : null;
const dockerCommand = planFile
  ? JSON.parse(fs.readFileSync(path.join(ASSET_ROOT, "plans", planFile), "utf8")).backend?.dockerCommand
  : null;
const drafts = ASSET_ROOT ? buildRegisteredPlanDrafts({ assetRoot: fs.realpathSync.native(ASSET_ROOT),
  suiteRoot: fs.realpathSync.native(SUITE_ROOT), suiteDigest: SUITE_DIGEST,
  configDigest: ZERO, armDigests: { piagent: ZERO, "codex-cli": ZERO }, dockerCommand }) : null;
const NULL = Object.freeze({ type: "null" });
const PROBE_SOURCE = `
export class ReceiverProbe { set(...args){ return null; } get(...args){ return null; } }
export function inputProbe(...args){ return null; }
export function outputProbe(value){ return value; }
export function throwProbe(name){
  if(name==='TypeError')throw new TypeError('probe');if(name==='RangeError')throw new RangeError('probe');
  if(name==='SyntaxError')throw new SyntaxError('probe');if(name==='ReferenceError')throw new ReferenceError('probe');
  if(name==='EvalError')throw new EvalError('probe');if(name==='URIError')throw new URIError('probe');
  if(name==='non-error')throw null;throw new Error('probe');
}`;
const registeredExpirySource = calendarExpirySource.replace("export function run(", "export function isExpired(");
assert.notEqual(registeredExpirySource, calendarExpirySource);
const FAMILY_SOURCES = new Map([["src/reliability/expiry.js", registeredExpirySource],
  ...familyRows.map(row => [`src/${row.fixture}`, row.sources[0]])]);

function allCases(contract) {
  return contract.checks.flatMap(check => check.cases);
}

function recordProperty(value, key) {
  assert.equal(value?.type, "record");
  const property = value.value.find(entry => entry.key === key);
  assert.ok(property, `missing public referenced property: ${key}`);
  return property.value;
}

function resolvedArgument(value, casesById) {
  if (value?.type === "result") {
    const expected = casesById.get(value.value)?.expected;
    assert.equal(expected?.outcome, "return");
    return expected.value;
  }
  if (value?.type === "error-property") {
    const expected = casesById.get(value.value)?.expected;
    assert.equal(expected?.outcome, "throw");
    return recordProperty(expected.errorObservation?.properties, value.key);
  }
  return value;
}

function inputProbeCases(contract) {
  const source = allCases(contract), casesById = new Map(source.map(item => [item.id, item]));
  return source.map((item, index) => {
    const args = item.args.map(value => resolvedArgument(value, casesById)), invocation = item.invocation ?? { kind: "call" },
      constructed = invocation.kind === "construct";
    const sequence = source.some(value => value.invocation?.kind === "construct")
      ? "registered-input-probe" : `registered-input-probe-${Math.floor(index / 16)}`;
    return { id: `input-${index}-${item.id}`, sequence,
      invocation, ...(invocation.kind === "call" ? { exportName: "inputProbe" }
        : constructed ? { exportName: "ReceiverProbe" } : {}), args,
      observeArgs: true, ...(item.callbacks ? { callbacks: item.callbacks } : {}),
      ...(item.errors ? { errors: item.errors } : {}),
      expected: { outcome: constructed ? "constructed" : "return", ...(!constructed ? { value: NULL } : {}),
        argsAfter: args, ...(item.callbacks ? { callbackTrace: [] } : {}) } };
  });
}

function outputProbeCases(contract) {
  return allCases(contract).map((item, index) => {
    const expected = item.expected;
    const sequence = `registered-output-probe-${Math.floor(index / 16)}`;
    if (expected.outcome === "constructed") return { id: `output-${index}-${item.id}`,
      sequence, exportName: "ReceiverProbe",
      invocation: { kind: "construct", receiverId: `output-${index}` }, args: [], observeArgs: true,
      expected: { outcome: "constructed", argsAfter: [] } };
    const value = expected.outcome === "return" ? expected.value : { type: "string", value: expected.errorClass };
    return { id: `output-${index}-${item.id}`, sequence,
      exportName: expected.outcome === "return" ? "outputProbe" : "throwProbe",
      invocation: { kind: "call" }, args: [value], observeArgs: true,
      expected: expected.outcome === "return"
        ? { outcome: "return", value: expected.value, argsAfter: [value] }
        : { outcome: "throw", errorClass: expected.errorClass, argsAfter: [value] } };
  });
}

async function assess(item, source, checks, exportName = "inputProbe") {
  return runIndependentContract({ imageId: item.plan.backend.imageId,
    dockerSocket: item.plan.backend.dockerSocket, dockerCommand: item.plan.backend.dockerCommand,
    timeoutMs: item.plan.backend.timeoutMs,
    profile: item.plan.backend.profile, planText: JSON.stringify({ schemaVersion: 2,
      profile: item.plan.backend.profile, source, exportName, checks }) });
}

for (const item of drafts?.plans.filter(value => value.route === "code"
  && (!SCENARIO || value.scenarioId === SCENARIO)) ?? []) {
  test(`registered plan protocol round-trips every public input and expected output for ${item.scenarioId}`, {
    skip: !ENABLED, timeout: 30000
  }, async t => {
    const contract = item.plan.contracts[0], input = await assess(item, PROBE_SOURCE,
      [{ id: "public-input-probe", cases: inputProbeCases(contract) }]), output = await assess(item, PROBE_SOURCE,
      [{ id: "public-output-probe", cases: outputProbeCases(contract) }]);
    t.diagnostic(JSON.stringify({ scenarioId: item.scenarioId,
      input: { status: input.execution.status, verdict: input.verdict, cases: input.checks[0].caseCount },
      output: { status: output.execution.status, verdict: output.verdict, cases: output.checks[0].caseCount } }));
    for (const assessment of [input, output]) {
      assert.equal(assessment.execution.status, "completed");
      assert.equal(assessment.execution.cleanupConfirmed, true);
      assert.equal(assessment.verdict, "pass");
      assert.ok(assessment.checks.every(check => check.status === "pass"));
    }
  });

  const familySource = FAMILY_SOURCES.get(item.plan.contracts[0].sourcePath);
  if (familySource) test(`registered public family reference passes its exact authored plan for ${item.scenarioId}`, {
    skip: !ENABLED, timeout: 30000
  }, async t => {
    const contract = item.plan.contracts[0], assessment = await assess(item, familySource, contract.checks,
      contract.exportName);
    t.diagnostic(JSON.stringify({ scenarioId: item.scenarioId, status: assessment.execution.status,
      verdict: assessment.verdict, cases: assessment.checks[0].caseCount,
      incomplete: (assessment.execution.observation?.cases ?? []).filter(value =>
        !["return", "throw", "constructed"].includes(value.outcome)).slice(0, 3)
        .map(value => ({ id: value.id, outcome: value.outcome, reason: value.reason ?? null })) }));
    assert.equal(assessment.execution.status, "completed");
    assert.equal(assessment.execution.cleanupConfirmed, true);
    assert.equal(assessment.verdict, "pass");
    assert.ok(assessment.checks.every(check => check.status === "pass"));
  });
}
