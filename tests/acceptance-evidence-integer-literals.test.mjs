import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidenceStatements } from "../packages/piagent-core/extensions/acceptance-expression-parser.js";

test("bounded evidence parsing preserves exact decimal integers with separators", () => {
  for (const [literal, value] of [["0", 0], ["1_000", 1000], ["60_000", 60000], ["9_007_199_254_740_991", Number.MAX_SAFE_INTEGER]]) {
    assert.deepEqual(parseEvidenceStatements(`return ${literal};`), [["return", ["number", value]]]);
  }
  assert.deepEqual(parseEvidenceStatements("return offset * 60_000;"),
    [["return", ["binary", "*", ["id", "offset"], ["number", 60000]]]]);
});

test("malformed, rounded, or unsupported numeric evidence abstains", () => {
  for (const literal of ["1__000", "60_", "0_0", "01", "1_000n", "0x10", "1.5", "1e3", "9_007_199_254_740_992", "9".repeat(320)]) {
    assert.throws(() => parseEvidenceStatements(`return ${literal};`), /unsupported-temporal-syntax/, literal);
  }
  assert.deepEqual(parseEvidenceStatements("return count_1;"), [["return", ["id", "count_1"]]]);
});
