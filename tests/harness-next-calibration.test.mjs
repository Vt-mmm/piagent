import assert from "node:assert/strict";
import test from "node:test";
import { developmentCorpus } from "../evals/harness-next/development-corpus.mjs";
import { calibrate } from "../evals/harness-next/run-calibration.mjs";
import { compileIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";

test("development calibration contains all required domains and independently declared valid, defective and unsupported programs", () => {
  const corpus = developmentCorpus();
  assert.equal(corpus.heldOut, false);
  assert.equal(corpus.claimEligible, false);
  assert.equal(corpus.rows.length, 21);
  assert.equal(new Set(corpus.rows.map((row) => row.id)).size, 21);
  for (const domain of ["pure-function", "temporal-input", "configuration-precedence", "stateful-recovery"]) {
    const rows = corpus.rows.filter((row) => row.domain === domain);
    assert.equal(rows.filter((row) => row.expectedVerdict === "pass").length, 2);
    assert.ok(rows.filter((row) => row.expectedVerdict === "fail").length >= 2);
    assert.equal(rows.filter((row) => row.expectedVerdict === "unknown").length, 1);
    for (const row of rows) {
      const request = JSON.parse(compileIndependentContract(JSON.stringify(row.plan)).requestText);
      assert.ok(request.cases.every((item) => !Object.hasOwn(item, "expected")));
    }
  }
});

test("calibration accounting exposes false acceptance, false rejection, abstention and errors separately", async () => {
  const corpus = developmentCorpus();
  // Accounting-only injection. This test does not represent worker execution.
  const observations = corpus.rows.map((row) => row.expectedVerdict);
  observations[0] = "fail"; observations[1] = "unknown"; observations[2] = "pass"; observations[3] = "error";
  let index = 0;
  const report = await calibrate({ corpus, execute: async () => ({ verdict: observations[index++], execution: { status: "completed", cleanupConfirmed: true }, counterexamples: [{ digest: "accounting-fixture" }] }) });
  assert.equal(report.summary.falseAcceptance, 1);
  assert.equal(report.summary.falseRejection, 1);
  assert.equal(report.summary.unexpectedAbstention, 1);
  assert.equal(report.summary.executorError, 1);
  assert.equal(report.summary.unknown, 5);
  assert.equal(report.summary.matched, 17);
  assert.equal(report.expectationsMatched, false);
  assert.equal(report.claimEligible, false);
  assert.equal(report.heldOut, false);
});

test("calibration refuses empty, duplicate, relabelled held-out or malformed plans before execution", async () => {
  for (const mutate of [
    (corpus) => { corpus.rows = []; }, (corpus) => { corpus.rows[1].id = corpus.rows[0].id; },
    (corpus) => { corpus.heldOut = true; }, (corpus) => { corpus.claimEligible = true; },
    (corpus) => { corpus.rows[0].plan.checks = []; }
  ]) {
    const corpus = developmentCorpus(); mutate(corpus);
    let calls = 0;
    await assert.rejects(() => calibrate({ corpus, execute: async () => { calls += 1; } }));
    assert.equal(calls, 0);
  }
});

test("a matching fail without a captured counterexample and unconfirmed cleanup never qualify", async () => {
  const corpus = developmentCorpus();
  let index = 0;
  const report = await calibrate({ corpus, execute: async () => ({ verdict: corpus.rows[index++].expectedVerdict,
    execution: { status: "completed", cleanupConfirmed: false }, counterexamples: [] }) });
  assert.equal(report.summary.matched, 0);
  assert.equal(report.expectationsMatched, false);
  assert.equal(report.summary.defectsRejectedWithCounterexamples, 0);
});
