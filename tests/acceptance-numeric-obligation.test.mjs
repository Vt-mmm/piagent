import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inferAcceptanceObligations, buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { automaticAcceptanceCriteria } from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { executableRejectionAssertions } from "../packages/piagent-core/extensions/acceptance-executable-evidence.js";

test("positive operations on integers do not invent an input-rejection requirement", () => {
  for (const text of [
    "otherwise it clamps an integer page to the inclusive range `1..pageCount`.",
    "`roundCount` returns an integer after rounding upward.",
    "`roundCount` must return a non-negative integer after rounding upward.",
    "`count` returns a positive integer.",
    "`scale` multiplies an integer amount by the current factor."
  ]) assert.equal(inferAcceptanceObligations(text).includes("invalid-input-rejection"), false, text);
});

test("explicit input constraints and rejection requirements are retained", () => {
  for (const text of [
    "The `limit` must be an integer.",
    "The parser requires an integer `limit`.",
    "The `limit` must be a positive integer.",
    "The `offset` should be a non-negative integer.",
    "`nowMs` and `leadMs` must be non-negative safe integers;",
    "Clamp an integer page and throw TypeError for invalid values.",
    "`clampPage` must reject a non-integer page with `TypeError`;",
    "`pageCount` throws TypeError unless totalItems is a non-negative integer and pageSize is a positive integer."
  ]) assert.equal(inferAcceptanceObligations(text).includes("invalid-input-rejection"), true, text);
});

test("the unchanged production prompt retains its clauses while classifying positive clamping as a boundary", () => {
  const prompt = fs.readFileSync(path.join(import.meta.dirname, "../benchmarks/production-v3/prompts/pagination-boundary.md"), "utf8");
  const criteria = automaticAcceptanceCriteria(prompt);
  const receipt = buildAcceptanceReceipt({ summary: prompt, acceptanceCriteria: criteria, changeMode: "source-change", source: "runtime" });
  assert.deepEqual(receipt.acceptanceCriteria, criteria);
  assert.equal(receipt.receipt.criteria[3].obligation, "boundary-case");
  assert.equal(receipt.receipt.criteria[1].obligation, "invalid-input-rejection");
  assert.equal(receipt.receipt.criteria[4].obligation, "invalid-input-rejection");
});


test("quoted outcome values do not invent an input-rejection obligation", () => {
  for (const text of [
    'Return `invalid-clock` when the receipt precedes the event beyond the skew.',
    'The function returns "invalid-input" for that outcome.',
    "Return 'invalid' when the state is unavailable."
  ]) assert.equal(inferAcceptanceObligations(text).includes("invalid-input-rejection"), false, text);
  assert.equal(inferAcceptanceObligations('Return `invalid-clock` for skew; malformed inputs throw `TypeError`.')
    .includes("invalid-input-rejection"), true);
});

const extractedRejections = (body) => executableRejectionAssertions(sanitizeJavaScriptEvidence(
  'import assert from "node:assert/strict";\nimport { checkValue } from "../src/value.js";\n' + body
).toLowerCase(), new Set(["checkvalue"]));

test("a block-local window data binding does not reject the entire assertion corpus", () => {
  const positive = 'import test from "node:test"; test("contract", () => { const input = 1, window = 2, before = [input, window]; assert.throws(() => checkValue(null), TypeError); });';
  assert.equal(extractedRejections(positive).length, 1);
  const negatives = [
    'window.alert(); assert.throws(() => checkValue(null), TypeError);',
    '{ const window = 2; } window.alert(); assert.throws(() => checkValue(null), TypeError);',
    'window.alert(); const window = 2; assert.throws(() => checkValue(null), TypeError);',
    'for (const window of [2]) {} window.alert(); assert.throws(() => checkValue(null), TypeError);',
    '{ const window = globalThis; window.alert(); assert.throws(() => checkValue(null), TypeError); }'
  ];
  for (const text of negatives) assert.equal(extractedRejections(text).length, 0, text);
});

test("non-finite rejection witnesses do not demand rejection of finite negative inputs", () => {
  for (const value of ["-Infinity", "Number.NEGATIVE_INFINITY", "Infinity"]) {
    const assertions = extractedRejections(`assert.throws(() => checkValue(${value}), TypeError);`);
    assert.equal(assertions.length, 1, value);
    assert.equal(assertions[0].partitions.has("non-finite"), true, value);
    assert.equal(assertions[0].partitions.has("negative"), false, value);
  }
  const finite = extractedRejections('assert.throws(() => checkValue(-1), TypeError);');
  assert.equal(finite[0].partitions.has("negative"), true);
  assert.equal(finite[0].partitions.has("non-finite"), false);
});
