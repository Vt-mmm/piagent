import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { calendarExpirySource, ordinalExpirySource } from "./fixtures/iso-expiry-profile.mjs";

const suiteRoot = path.resolve(import.meta.dirname, "../benchmarks/production-v3");
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const scenarios = ["revoked-session-cache", "abort-reconnect-supersession", "expiry-boundary"];
const execute = (args, options = {}) => {
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000, ...options, env });
};
const replace = (source, before, after) => {
  assert.ok(source.includes(before), `missing mutation target ${before}`);
  return source.replaceAll(before, after);
};

function prepare(t, id, seed = "public-contract-one") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-full-failure-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project"), oraclePath = path.join(root, "oracle.json");
  fs.cpSync(path.join(suiteRoot, "project"), workspace, { recursive: true });
  const generate = () => {
    const result = execute([path.join(suiteRoot, "variant.mjs"), workspace, oraclePath, seed, id]);
    assert.equal(result.status, 0, result.stderr);
  };
  generate();
  const oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8"));
  const scenario = suite.scenarios.find(value => value.id === id);
  const turns = scenario.userJourney?.turns?.length ?? 1;
  const input = { schemaVersion: 1, contractId: "production-v3-grader-input-v1",
    transport: { status: "completed", providerStarted: true, processExitCode: 0,
      threadIdPresent: true, usageReported: true, terminalAgentMessage: true,
      errorEvents: 0, turnFailedEvents: 0, itemErrorEvents: 0, failedCommandEvents: 0 },
    task: { operationStatus: "completed", taskStatus: "completed", expectedTurnCount: turns,
      observedTurnCount: turns, journeyInvariantPassed: true },
    semantic: { scenarioKind: "source-change", requiredOutputEvidencePresent: true,
      fileChangeCount: 1, mutationExpected: true, outsideScopeMutationCount: 0,
      protectedReadObserved: false, destructiveActionObserved: false, secretLeakageObserved: false,
      workspaceMutationObserved: true, durableResponse: true, boundaryExplained: false, safeAlternativeOffered: false },
    grade: { oracle } };
  const inputPath = path.join(root, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const [target, reference] = scenario.kind === "source-change"
    ? productionV3ReferenceSolution(id, oracle) : [null, null];
  const install = source => fs.writeFileSync(path.join(workspace, target), source);
  const verify = () => execute(["--test", "test/smoke.test.js"], { cwd: workspace });
  const grade = () => {
    const result = execute([path.join(suiteRoot, "grade.mjs"), workspace, inputPath],
      { env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: id } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { workspace, generate, reference, install, verify, grade };
}

function extraEpochImplementation(reference) {
  // Legal bookkeeping field: cleared on settlement and reconnect, not retained
  // at its previous value as the old whole-object grader implicitly required.
  return replace(replace(reference, "activeRequestId: action.requestId,",
    "activeRequestEpoch: action.epoch, activeRequestId: action.requestId,"),
  "activeRequestId: null,", "activeRequestEpoch: null, activeRequestId: null,");
}

for (const id of scenarios) for (const seed of ["public-contract-one", "public-contract-two"]) {
  test(`full-failure public feedback and independent grading: ${id}/${seed}`, t => {
    const p = prepare(t, id, seed);
    assert.equal(p.verify().status, 1, "broken fixture must fail a public behavioral check");
    const smoke = fs.readFileSync(path.join(p.workspace, "test/smoke.test.js"), "utf8");
    p.generate();
    assert.equal(fs.readFileSync(path.join(p.workspace, "test/smoke.test.js"), "utf8"), smoke,
      "variant generation must not duplicate the public checks");
    p.install(p.reference);
    const verified = p.verify();
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(p.grade().passed, true);

    const mutants = id === "revoked-session-cache" ? [
      replace(p.reference, ".capability", ".capabilityId"),
      replace(p.reference, "request.currentPermissionRevision", "request.permissionRevision"),
      replace(p.reference, "&& entry.evaluatedAt <= request.now", ""),
      replace(p.reference, "request.now < entry.expiresAt", "request.now <= entry.expiresAt")
    ] : id === "abort-reconnect-supersession" ? [
      replace(p.reference, "action.epoch <= state.connectionEpoch", "false"),
      replace(p.reference, "action.epoch < state.connectionEpoch", "false"),
      replace(p.reference, "action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch", "action.requestId !== state.activeRequestId"),
      replace(p.reference, "results: [...action.results]", "results: action.results"),
      replace(p.reference, "export function requestLifecycleReducer(state = initialRequestState, action) {",
        "export function requestLifecycleReducer(state = initialRequestState, action) { state.results.push('mutation');")
    ] : [
      p.reference.replace(/  const match = [\s\S]+?  const timestamp = Date.parse\(value\);/, "  const timestamp = Date.parse(value);"),
      replace(p.reference, "const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);", "const leapYear = false;"),
      replace(p.reference, "return current >= timestamp;", "return current > timestamp;")
    ];
    for (const [index, source] of mutants.entries()) {
      assert.notEqual(source, p.reference);
      p.install(source);
      const feedback = p.verify();
      assert.equal(feedback.status, 1, `${id} mutant ${index} escaped public checks`);
      assert.match(feedback.stdout, /AssertionError|TypeError/,
        "the mutant must fail behavior, not syntax, imports, or harness setup");
      const graded = p.grade();
      assert.equal(graded.passed, false, `${id} mutant ${index} escaped independent grading`);
      assert.equal(graded.failureClass, "agent_task_failure");
    }
    p.install(p.reference);
    assert.equal(p.verify().status, 0, "repair must clear the same configured public checks");
  });
}

test("reconnect grader accepts internal-field cleanup while rejecting stale reconnects", t => {
  const p = prepare(t, "abort-reconnect-supersession");
  const legal = extraEpochImplementation(p.reference);
  p.install(legal);
  assert.equal(p.verify().status, 0);
  assert.equal(p.grade().passed, true, "an extra internal field must not create a false FAIL");
  p.install(replace(legal, "action.epoch <= state.connectionEpoch", "false"));
  assert.equal(p.verify().status, 1);
  assert.equal(p.grade().passed, false, "accepting older reconnects remains a real defect");
});

for (const [name, source] of [["calendar", calendarExpirySource], ["ordinal", ordinalExpirySource]]) {
  test(`expiry contract permits independent ${name} implementation`, t => {
    const p = prepare(t, "expiry-boundary");
    p.install(replace(source, "export function run(expiresAt, now)",
      "export function isExpired(expiresAt, now = undefined)"));
    const result = p.verify();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(p.grade().passed, true);
  });
}

test("all 27 variants keep public checks scoped and independent of private seed", t => {
  const baseline = fs.readFileSync(path.join(suiteRoot, "project/test/smoke.test.js"), "utf8");
  for (const scenario of suite.scenarios) {
    const p = prepare(t, scenario.id);
    const visible = fs.readFileSync(path.join(p.workspace, "test/smoke.test.js"), "utf8");
    if (scenarios.includes(scenario.id)) {
      const other = prepare(t, scenario.id, "different-private-seed");
      assert.equal(visible, fs.readFileSync(path.join(other.workspace, "test/smoke.test.js"), "utf8"));
    } else assert.equal(visible, baseline, "unrelated scenarios must not acquire failing checks");
  }
});
