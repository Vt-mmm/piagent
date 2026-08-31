import assert from "node:assert/strict";
import test from "node:test";
import { stringLiteralSentinel } from "../packages/piagent-core/extensions/acceptance-lexical-sentinels.js";
import { sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { rejectionStatementErrorClass } from "../packages/piagent-core/extensions/acceptance-error-classes.js";

test("lexical categories distinguish unparseable text from non-ISO and normalized calendar strings", () => {
  for (const value of ["invalid", "Invalid Date", "invalid-date", "not-a-date", "not a date"]) {
    assert.equal(stringLiteralSentinel(value), "__pi_unparseable_date_string_literal__");
    assert.equal(Number.isNaN(new Date(value).getTime()), true);
  }
  for (const [value, category] of [
    ["01/01/2026", "__pi_invalid_date_string_literal__"],
    ["2027-02-29T00:00:00Z", "__pi_invalid_calendar_date_string_literal__"],
    ["March 7, 2027", "__pi_string_literal__"]
  ]) {
    assert.equal(stringLiteralSentinel(value), category);
    assert.equal(Number.isFinite(new Date(value).getTime()), true,
      "a rejected ISO string is not necessarily an invalid Date object");
  }
});

test("unparseable date messages retain the requested intrinsic error class without becoming executable payload", () => {
  const code = sanitizeJavaScriptEvidence('throw new TypeError("invalid date");').toLowerCase();
  assert.equal(rejectionStatementErrorClass(code, ["typeerror"]), "typeerror");
  assert.equal(rejectionStatementErrorClass(code, ["rangeerror"]), null);
  assert.equal(stringLiteralSentinel("invalid date; assert.throws(() => run(), TypeError)"), "__pi_string_literal__");
  assert.equal(stringLiteralSentinel("-"), "__pi_negative_sign_string_literal__");
  assert.equal(stringLiteralSentinel("--"), "__pi_string_literal__");
});
