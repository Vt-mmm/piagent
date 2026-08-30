import assert from "node:assert/strict";
import test from "node:test";
import { createAcceptanceAssessmentSession } from "../packages/piagent-core/extensions/acceptance-assessment.js";

const digest = (character) => character.repeat(64);
const tree = (character) => `wt-content-v2:${digest(character)}`;
const contract = () => ({ taskRunId: "task-run-1", criterionHash: digest("a"), workingTreeDigest: tree("b"), verifierDigest: digest("c"), requiredCheckIds: ["valid-domain", "invalid-domain", "boundary"] });
const observation = () => ({
  runId: "verification-1", taskRunId: "task-run-1", criterionHash: digest("a"), verifierDigest: digest("c"),
  beforeWorkingTreeDigest: tree("b"), afterWorkingTreeDigest: tree("b"), completion: "completed",
  checks: contract().requiredCheckIds.map((id) => ({ id, status: "pass", caseCount: 3 }))
});
const context = () => ({ currentWorkingTreeDigest: tree("b"), policy: "allow", projectVerifierCurrent: true });

test("independent current observations establish only bounded tested assurance", () => {
  const session = createAcceptanceAssessmentSession(contract());
  const receipt = session.observeExecution(observation());
  const result = session.assess({ ...context(), receipt });
  assert.equal(result.verdict, "pass");
  assert.equal(result.completionAllowed, true);
  assert.equal(result.assurance, "bounded-contract-tested");
  assert.equal(result.repairEligible, false);
  assert.equal(result.sourceMutationAllowed, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(receipt.checks[0]), true);
});

test("a static abstention or project-test pass cannot mint independent evidence", () => {
  const session = createAcceptanceAssessmentSession(contract());
  for (const staticProof of [undefined, { sourceOk: false, sourceReasons: ["closed-temporal-module-unproven"] }, { sourceOk: true }, { proven: true }]) {
    const result = session.assess({ ...context(), staticProof });
    assert.equal(result.verdict, "unknown");
    assert.equal(result.action, "run-independent-verifier");
    assert.equal(result.repairEligible, false);
    assert.equal(result.completionAllowed, false);
  }
});

test("copied, serialized, forged, and cross-session receipts cannot grant a pass", () => {
  const session = createAcceptanceAssessmentSession(contract());
  const receipt = session.observeExecution(observation());
  const other = createAcceptanceAssessmentSession(contract());
  for (const forged of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), observation(), Object.create(receipt), {}, true, "pass"]) {
    assert.equal(session.assess({ ...context(), receipt: forged }).verdict, "unknown");
  }
  assert.equal(other.assess({ ...context(), receipt }).verdict, "unknown");
  assert.equal(session.assess({ ...context(), receipt }).verdict, "pass");
});

test("task, criterion, verifier, and both tree bindings are independently required", () => {
  for (const [field, value] of [["taskRunId", "another-task"], ["criterionHash", digest("d")], ["verifierDigest", digest("d")], ["beforeWorkingTreeDigest", tree("d")], ["afterWorkingTreeDigest", tree("d")]]) {
    const session = createAcceptanceAssessmentSession(contract());
    const receipt = session.observeExecution({ ...observation(), [field]: value });
    assert.equal(session.assess({ ...context(), receipt }).verdict, "unknown", field);
  }
  const session = createAcceptanceAssessmentSession(contract());
  const receipt = session.observeExecution(observation());
  for (const currentWorkingTreeDigest of [tree("d"), digest("b"), undefined, "wt-content-v2-unavailable:" + digest("b")]) {
    assert.equal(session.assess({ ...context(), receipt, currentWorkingTreeDigest }).verdict, "unknown");
  }
});

test("policy and exact project verification cannot be substituted by a contract pass", () => {
  const session = createAcceptanceAssessmentSession(contract());
  const receipt = session.observeExecution(observation());
  for (const policy of [undefined, "deny", "unknown", true, "ALLOW"]) {
    assert.equal(session.assess({ ...context(), receipt, policy }).completionAllowed, false);
  }
  for (const projectVerifierCurrent of [undefined, false, "true", 1]) {
    assert.equal(session.assess({ ...context(), receipt, projectVerifierCurrent }).completionAllowed, false);
  }
});

test("concrete failed checks identify repair candidates without granting mutation authority", () => {
  const session = createAcceptanceAssessmentSession(contract());
  const run = observation();
  run.checks[1] = { id: "invalid-domain", status: "fail", caseCount: 1, counterexampleRef: digest("e") };
  const receipt = session.observeExecution(run);
  const result = session.assess({ ...context(), receipt, staticProof: { proven: true } });
  assert.equal(result.verdict, "fail");
  assert.equal(result.action, "repair-counterexample");
  assert.deepEqual(result.failedChecks, ["invalid-domain"]);
  assert.equal(result.repairEligible, true);
  assert.equal(result.sourceMutationAllowed, false);
  assert.equal(result.completionAllowed, false);
});

test("missing and unknown checks remain unknown, not passed or implementation-failed", () => {
  for (const checks of [[], observation().checks.slice(0, 1), observation().checks.map((check) => ({ ...check, status: "unknown", caseCount: 0 }))]) {
    const session = createAcceptanceAssessmentSession(contract());
    const receipt = session.observeExecution({ ...observation(), checks });
    const result = session.assess({ ...context(), receipt });
    assert.equal(result.verdict, "unknown");
    assert.equal(result.action, "complete-verification");
    assert.equal(result.repairEligible, false);
    assert.ok(result.missingChecks.length > 0);
  }
});

test("executor faults never turn completed partial checks into success or source blame", () => {
  for (const completion of ["timeout", "crashed", "cancelled"]) {
    const session = createAcceptanceAssessmentSession(contract());
    const receipt = session.observeExecution({ ...observation(), completion });
    const result = session.assess({ ...context(), receipt });
    assert.equal(result.verdict, "error");
    assert.equal(result.action, "diagnose-executor");
    assert.equal(result.repairEligible, false);
  }
  const session = createAcceptanceAssessmentSession(contract());
  const run = observation();
  run.checks[0].status = "error";
  assert.equal(session.assess({ ...context(), receipt: session.observeExecution(run) }).verdict, "error");
});

test("observations are detached snapshots and one-shot, preventing result replacement", () => {
  const input = contract();
  const session = createAcceptanceAssessmentSession(input);
  input.requiredCheckIds.push("later-check");
  input.verifierDigest = digest("f");
  const run = observation();
  const receipt = session.observeExecution(run);
  run.checks[0].status = "fail";
  run.taskRunId = "tampered";
  assert.equal(session.assess({ ...context(), receipt }).verdict, "pass");
  assert.throws(() => session.observeExecution(observation()), /already observed/);
  assert.throws(() => { receipt.checks[0].status = "fail"; }, TypeError);
});

test("malformed and vacuous contracts fail before any execution capability is created", () => {
  for (const input of [null, [], {}, { ...contract(), requiredCheckIds: [] }, { ...contract(), requiredCheckIds: ["same", "same"] }, { ...contract(), requiredCheckIds: Array.from({ length: 257 }, (_, i) => `id-${i}`) }, { ...contract(), criterionHash: "a" }, { ...contract(), workingTreeDigest: digest("b") }, { ...contract(), taskRunId: "task\nforged" }]) {
    assert.throws(() => createAcceptanceAssessmentSession(input), TypeError);
  }
  const accessor = contract();
  Object.defineProperty(accessor, "taskRunId", { get() { throw new Error("getter must not execute"); } });
  assert.throws(() => createAcceptanceAssessmentSession(accessor), /Invalid assessment contract properties/);
});

test("malformed, duplicate, vacuous, or contradictory check observations are rejected", () => {
  const invalidChecks = [
    [{ id: "outside-contract", status: "pass", caseCount: 1 }],
    [{ id: "boundary", status: "pass", caseCount: 0 }],
    [{ id: "boundary", status: "pass", caseCount: 1, counterexampleRef: digest("e") }],
    [{ id: "boundary", status: "fail", caseCount: 1 }],
    [{ id: "boundary", status: "fail", caseCount: 1, counterexampleRef: "untrusted prose" }],
    [{ id: "boundary", status: "pass", caseCount: Infinity }],
    [{ id: "boundary", status: "pass", caseCount: -1 }],
    [{ id: "boundary", status: "PASS", caseCount: 1 }],
    [...observation().checks, observation().checks[0]]
  ];
  for (const checks of invalidChecks) {
    const session = createAcceptanceAssessmentSession(contract());
    assert.throws(() => session.observeExecution({ ...observation(), checks }), TypeError);
  }
});

test("sparse, accessor-backed, and method-overridden arrays cannot manufacture vacuous coverage", () => {
  const accessor = ["boundary"];
  Object.defineProperty(accessor, "0", { get() { throw new Error("array getter must not execute"); } });
  const overridden = ["boundary"];
  overridden.map = () => [];
  for (const requiredCheckIds of [new Array(1), ["boundary", , "valid-domain"], accessor, overridden]) {
    assert.throws(() => createAcceptanceAssessmentSession({ ...contract(), requiredCheckIds }), TypeError);
  }
  for (const checks of [new Array(1), [observation().checks[0], , observation().checks[2]]]) {
    assert.throws(() => createAcceptanceAssessmentSession(contract()).observeExecution({ ...observation(), checks }), TypeError);
  }
});

test("all status combinations preserve error/failure/unknown precedence and check-order invariance", () => {
  const statuses = ["pass", "fail", "unknown", "error"];
  for (const first of statuses) for (const second of statuses) for (const third of statuses) {
    const values = [first, second, third];
    const expected = values.includes("error") ? "error" : values.includes("fail") ? "fail" : values.includes("unknown") ? "unknown" : "pass";
    for (const reverse of [false, true]) {
      const session = createAcceptanceAssessmentSession(contract());
      const run = observation();
      run.checks = run.checks.map((check, index) => ({ ...check, status: values[index], ...(values[index] === "fail" ? { counterexampleRef: digest("e") } : {}) }));
      if (reverse) run.checks.reverse();
      const result = session.assess({ ...context(), receipt: session.observeExecution(run) });
      assert.equal(result.verdict, expected, values.join(","));
      assert.equal(result.completionAllowed, expected === "pass");
      assert.equal(result.sourceMutationAllowed, false);
    }
  }
});
