import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acceptanceContractProofGuidance,
  acceptanceExecutableTestBinding,
  acceptanceInvalidInputEvidence,
  sanitizeJavaScriptEvidence
} from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import {
  buildAcceptanceReceipt,
  refreshAcceptanceReceipt
} from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const source = `const ISO_TIMESTAMP = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;

function expiryTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    throw new TypeError("expiresAt must be a valid date");
  }

  if (typeof value !== "string") throw new TypeError("expiresAt must be an ISO timestamp or Date");
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) throw new TypeError("expiresAt must be an ISO timestamp or Date");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new TypeError("expiresAt must be a valid date");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("expiresAt must be a valid date");
  return timestamp;
}

function nowTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError("now must be a millisecond number or Date");
}

export function isExpired(expiresAt, now) {
  const timestamp = expiryTimestamp(expiresAt);
  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);
  return current >= timestamp;
}
`;

const focusedTests = `import assert from "node:assert/strict";
import { isExpired } from "../src/reliability/expiry.js";

const expiry = "2026-01-01T00:00:00.000Z";
assert.equal(isExpired(expiry, Date.parse(expiry)), true);
assert.equal(isExpired(new Date(expiry), new Date(expiry)), true);
assert.equal(isExpired(expiry, Date.parse(expiry) - 1), false);
for (const value of ["January 1, 2026", "2026-02-30T00:00:00.000Z", new Date(NaN)]) {
  assert.throws(() => isExpired(value, 0), TypeError);
}
for (const value of [undefined, null, false, new Date(NaN), Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => isExpired(expiry, value), TypeError);
}
assert.equal(isExpired(new Date(0), 0), true);
assert.equal(isExpired("2099-01-01T00:00:00.000Z"), false);
`;

const contract = [
  "`isExpired(expiresAt, now)` accepts an ISO timestamp string or `Date` for `expiresAt`,",
  "and a millisecond number or `Date` for `now`. Invalid dates must throw `TypeError`;",
  "do not use the machine's current time when an explicit falsey value is provided."
].join(" ");

const robustInlineSource = `function expiryTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    throw new TypeError("expiresAt must be a valid date");
  }

  if (typeof value !== "string") throw new TypeError("expiresAt must be an ISO timestamp or Date");
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})$/.exec(value);
  if (!match) throw new TypeError("expiresAt must be an ISO timestamp or Date");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw new TypeError("expiresAt must be a valid date");

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("expiresAt must be a valid date");
  return timestamp;
}

function nowTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError("now must be a millisecond number or Date");
}

export function isExpired(expiresAt, now) {
  const timestamp = expiryTimestamp(expiresAt);
  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);
  return current >= timestamp;
}
`;

const dateUtcYearZeroBugSource = robustInlineSource
  .replace(
    "  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);\n  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];",
    "  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();"
  )
  .replace("daysInMonth[month - 1]", "daysInMonth");

const retainedInlineBugSource = dateUtcYearZeroBugSource.replace("const offset = match[8]", "const offset = match[7]");

function evidence(candidate = source, taskText = contract, testText = focusedTests) {
  return acceptanceInvalidInputEvidence({
    taskText,
    sourceText: candidate,
    testText,
    sourceEntries: [{ path: "src/reliability/expiry.js", text: candidate }],
    testEntries: [{ path: "test/smoke.test.js", text: testText }],
    namedTargets: ["isExpired"],
    provenanceTargets: ["isExpired"]
  });
}

test("recognizes the distinct zone-at-capture-seven strict timestamp literal", () => {
  assert.match(
    sanitizeJavaScriptEvidence(source),
    /__pi_strict_iso_timestamp_noncapturing_fraction_regex_literal__/
  );
  assert.match(
    sanitizeJavaScriptEvidence(source.replace("(?:\\.\\d+)?", "(\\.\\d+)?")),
    /__pi_strict_iso_timestamp_regex_literal__/
  );
  assert.match(
    sanitizeJavaScriptEvidence(source.replace("/^(\\d{4})", "/(\\d{4})")),
    /__pi_regex_literal__/
  );
});

test("proves the retained direct-TypeError helper module", () => {
  assert.deepEqual(evidence(), { sourceOk: true, testOk: true });
});

test("proves the corrected closed inline ISO parser and rejects the retained capture/calendar bugs", () => {
  assert.match(
    sanitizeJavaScriptEvidence(robustInlineSource),
    /__pi_strict_iso_timestamp_optional_seconds_capturing_fraction_regex_literal__/
  );
  assert.deepEqual(evidence(robustInlineSource), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence(retainedInlineBugSource), { sourceOk: false, testOk: true });
  assert.deepEqual(evidence(dateUtcYearZeroBugSource), { sourceOk: false, testOk: true });
  assert.equal(evidence(robustInlineSource.replace("const offset = match[8]", "const offset = match[7]")).sourceOk, false);
});

test("inline ISO parser proof remains fail-closed across capture, calendar, and module poisons", () => {
  const inlinePoisonCases = [
    ["zone reads optional fraction capture", robustInlineSource.replace("const offset = match[8]", "const offset = match[7]")],
    ["Date.UTC remaps years zero through 99", dateUtcYearZeroBugSource],
    ["wrong leap-century divisor", robustInlineSource.replace("year % 400", "year % 300")],
    ["seconds read from fraction capture", robustInlineSource.replace(
      "match[6] === undefined ? 0 : Number(match[6])",
      "match[7] === undefined ? 0 : Number(match[7])"
    )],
    ["missing offset-minute bound", robustInlineSource.replace(" || offsetMinute > 59", "")],
    ["extra top-level statement", `const unrelated = 1;\n${robustInlineSource}`]
  ];
  for (const [name, candidate] of inlinePoisonCases) {
    assert.notEqual(candidate, robustInlineSource, `${name}: mutation must alter source`);
    assert.equal(evidence(candidate).sourceOk, false, name);
  }
});

test("ISO recovery guidance identifies optional captures and proleptic calendar hazards", () => {
  const guidance = acceptanceContractProofGuidance(contract).join("\n");
  assert.match(guidance, /with and without fractional seconds/i);
  assert.match(guidance, /optional capturing groups shift later match indexes/i);
  assert.match(guidance, /years 0000 through 0099/i);
  assert.match(guidance, /Date\.UTC\(year/i);
});

const poisonCases = [
  ["extra top-level statement", `const unrelated = 1;\n${source}`],
  ["mutable regex", source.replace("const ISO_TIMESTAMP", "let ISO_TIMESTAMP")],
  ["missing regex start anchor", source.replace("/^(\\d{4})", "/(\\d{4})")],
  ["missing regex end anchor", source.replace("\\d{2})$/", "\\d{2})/")],
  ["regex flags", source.replace("\\d{2})$/;", "\\d{2})$/m;")],
  ["capture-eight topology", source.replace("(?:\\.\\d+)?", "(\\.\\d+)?")],
  ["wrong zone capture", source.replace("const offset = match[7]", "const offset = match[8]")],
  ["fixed regex input", source.replace("ISO_TIMESTAMP.exec(value)", "ISO_TIMESTAMP.exec('fixed')")],
  ["missing Date finite guard", source.replace("    if (Number.isFinite(timestamp)) return timestamp;\n    throw new TypeError", "    return timestamp;\n    throw new TypeError")],
  ["wrong error class", source.replaceAll("new TypeError", "new RangeError")],
  ["dynamic error argument", source.replace('new TypeError("expiresAt must be a valid date")', "new TypeError(message())")],
  ["gated type guard", source.replace("if (typeof value !== \"string\")", "if (enabled && typeof value !== \"string\")")],
  ["missing match guard", source.replace('  if (!match) throw new TypeError("expiresAt must be an ISO timestamp or Date");\n', "")],
  ["wrong parser input alias", source.replace("ISO_TIMESTAMP.exec(value)", "ISO_TIMESTAMP.exec(other)")],
  ["wrong year capture", source.replace("Number(match[1])", "Number(match[2])")],
  ["wrong leap divisor", source.replace("year % 400", "year % 300")],
  ["wrong leap February", source.replace("leapYear ? 29 : 28", "leapYear ? 29 : 27")],
  ["wrong month index", source.replace("daysInMonth[month - 1]", "daysInMonth[month]")],
  ["missing lower month bound", source.replace("month < 1 || ", "")],
  ["widened upper month bound", source.replace("month > 12", "month > 13")],
  ["missing lower day bound", source.replace("day < 1 || ", "")],
  ["missing upper day bound", source.replace("day > daysInMonth[month - 1] || ", "")],
  ["widened hour bound", source.replace("hour > 23", "hour > 24")],
  ["widened minute bound", source.replace("minute > 59", "minute > 60")],
  ["widened second bound", source.replace("second > 59", "second > 60")],
  ["widened offset-hour bound", source.replace("offsetHour > 23", "offsetHour > 24")],
  ["widened offset-minute bound", source.replace("offsetMinute > 59", "offsetMinute > 60")],
  ["fixed Date.parse input", source.replace("Date.parse(value)", "Date.parse('fixed')")],
  ["missing final finite guard", source.replace('  if (!Number.isFinite(timestamp)) throw new TypeError("expiresAt must be a valid date");\n  return timestamp;', "  return timestamp;")],
  ["now Date returns invalid timestamp", source.replace("    if (Number.isFinite(timestamp)) return timestamp;\n  } else if", "    return timestamp;\n  } else if")],
  ["now accepts non-finite number", source.replace('typeof value === "number" && Number.isFinite(value)', 'typeof value === "number"')],
  ["now fallback accepts zero", source.replace('  throw new TypeError("now must be a millisecond number or Date");', "  return 0;")],
  ["truthy clock fallback", source.replace("arguments.length < 2 ? Date.now() : nowTimestamp(now)", "now || Date.now()")],
  ["wrong omission threshold", source.replace("arguments.length < 2", "arguments.length < 3")],
  ["defaulted now parameter", source.replace("isExpired(expiresAt, now)", "isExpired(expiresAt, now = Date.now())")],
  ["eager now normalization", source.replace("const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);", "const normalized = nowTimestamp(now); const current = arguments.length < 2 ? Date.now() : normalized;")],
  ["swapped helpers", source.replace("expiryTimestamp(expiresAt)", "nowTimestamp(expiresAt)")],
  ["fixed expiry helper input", source.replace("expiryTimestamp(expiresAt)", "expiryTimestamp('fixed')")],
  ["exclusive comparison", source.replace("return current >= timestamp", "return current > timestamp")],
  ["prior public return", source.replace("  const timestamp = expiryTimestamp(expiresAt);", "  return false;\n  const timestamp = expiryTimestamp(expiresAt);")],
  ["public extra path", source.replace("  const timestamp = expiryTimestamp(expiresAt);", "  audit();\n  const timestamp = expiryTimestamp(expiresAt);")],
  ["async public", source.replace("export function isExpired", "export async function isExpired")],
  ["LF-split return token", source.replace("return current >= timestamp;", "ret\nurn current >= timestamp;")],
  ["CR-split return token", source.replace("return current >= timestamp;", "ret\rurn current >= timestamp;")],
  ["CRLF-split return token", source.replace("return current >= timestamp;", "ret\r\nurn current >= timestamp;")],
  ["Unicode line-separator return ASI", source.replace("return current >= timestamp;", "return\u2028current >= timestamp;")],
  ["Unicode paragraph-separator return ASI", source.replace("return current >= timestamp;", "return\u2029current >= timestamp;")],
  ["Unicode line-separator split return token", source.replace("return current >= timestamp;", "ret\u2028urn current >= timestamp;")],
  ["Unicode paragraph-separator split return token", source.replace("return current >= timestamp;", "ret\u2029urn current >= timestamp;")],
  ["block-comment split return token", source.replace("return current >= timestamp;", "ret/*x*/urn current >= timestamp;")],
  ["line-comment split return token", source.replace("return current >= timestamp;", "ret//x\nurn current >= timestamp;")],
  ["block-comment line-separator return ASI", source.replace("return current >= timestamp;", "return/*\u2028*/ current >= timestamp;")],
  ["line-comment line-separator intrinsic breakout", source.replace(";\n\nfunction expiryTimestamp", "; //\u2028Number.isFinite = () => true;\nfunction expiryTimestamp")],
  ["line-comment paragraph-separator intrinsic breakout", source.replace(";\n\nfunction expiryTimestamp", "; //\u2029Number.isFinite = () => true;\nfunction expiryTimestamp")],
  ["split instanceof token", source.replace("value instanceof Date", "value instance/*x*/of Date")],
  ["split typeof token", source.replace("typeof value", "type/*x*/of value")],
  ["split new token", source.replace("throw new TypeError", "throw ne/*x*/w TypeError")],
  ["split arguments identifier", source.replace("arguments.length", "argu/*x*/ments.length")],
  ["split Date.now member", source.replace("Date.now()", "Date.n/*x*/ow()")],
  ["split greater-equal operator", source.replace("return current >= timestamp;", "return current >/*x*/= timestamp;")],
  ["split strict-equal operator", source.replace("year % 4 === 0", "year % 4 =/*x*/== 0")],
  ["split logical-and operator", source.replace("=== 0 &&", "=== 0 &/*x*/&")],
  ["split logical-or operator", source.replace("!== 0 ||", "!== 0 |/*x*/|")],
  ["split strict-not-equal operator", source.replace('typeof value !== "string"', 'typeof value !/*x*/== "string"')],
  ["split numeric literal", source.replace("hour > 23", "hour > 2/*x*/3")],
  ["fused throw-new-TypeError", source.replaceAll("throw new TypeError", "thrownewTypeError")],
  ["fused new-TypeError", source.replaceAll("throw new TypeError", "throw newTypeError")],
  ["fused typeof-value", source.replace("typeof value", "typeofvalue")],
  ["fused value-instanceof-Date", source.replace("value instanceof Date", "valueinstanceofDate")],
  ["fused return-timestamp", source.replace("return timestamp;", "returntimestamp;")],
  ["fused return-current", source.replace("return current >= timestamp;", "returncurrent >= timestamp;")],
  ["script-only await binding", source.replaceAll("timestamp", "await")],
  ["helper reassignment", source.replace("export function isExpired", "expiryTimestamp = () => 0;\nexport function isExpired")],
  ["regex exec mutation", source.replace("function expiryTimestamp", "ISO_TIMESTAMP.exec = () => null;\nfunction expiryTimestamp")],
  ["Date.parse mutation", `Date.parse = () => 0;\n${source}`],
  ["reflective intrinsic mutation", `Reflect.set(Number, "isFinite", () => true);\n${source}`],
  ["case-fold callable collision", source.replace("function expiryTimestamp", "function ExpiryTimestamp(value) { return 0; }\nfunction expiryTimestamp")],
  ["destructured expiry parameter", source.replace("function expiryTimestamp(value)", "function expiryTimestamp({ value })")]
];

test("direct-TypeError whole-module poison matrix remains fail-closed", () => {
  for (const [name, candidate] of poisonCases) {
    assert.notEqual(candidate, source, `${name}: mutation must alter source`);
    assert.equal(evidence(candidate).sourceOk, false, name);
  }
});

test("native syntax gate preserves valid comments between complete tokens", () => {
  const validTriviaCases = [
    source.replace("return current >= timestamp;", "return /*x*/ current >= timestamp;"),
    source.replace("return current >= timestamp;", "return current /*x*/ >= /*y*/ timestamp;"),
    source.replaceAll("throw new TypeError", "throw/*x*/ new/*y*/ TypeError"),
    source.replace("} else if", "} else/*x*/ if"),
    source.replace("export function isExpired", "export/*x*/ function isExpired")
  ];
  for (const candidate of validTriviaCases) assert.equal(evidence(candidate).sourceOk, true);
});

const invalidStringEscapes = [
  String.raw`\8`, String.raw`\9`, String.raw`\1`, String.raw`\07`, String.raw`\08`, String.raw`\01`,
  String.raw`\x`, String.raw`\x0`, String.raw`\xGG`, String.raw`\u`, String.raw`\u000`,
  String.raw`\uZZZZ`, String.raw`\u{}`, String.raw`\u{xyz}`, String.raw`\u{41`, String.raw`\u{110000}`
];

test("strict string escape validation cannot promote malformed module source", () => {
  for (const escape of invalidStringEscapes) {
    const candidate = source.replace('"expiresAt must be a valid date"', `"bad${escape}"`);
    assert.match(sanitizeJavaScriptEvidence(candidate), /__pi_invalid_escape_lexeme__/, escape);
    assert.equal(evidence(candidate).sourceOk, false, escape);
  }
});

test("strict string escape validation retains valid escapes and continuations", () => {
  const validEscapes = [
    String.raw`\0`, String.raw`\x00`, String.raw`\x41`, String.raw`\x414`, String.raw`\u0000`,
    String.raw`\uD800`, String.raw`\u{0}`, String.raw`\u{10FFFF}`, String.raw`\u{D800}`,
    String.raw`\u{000000041}`, String.raw`\q`, String.raw`\"`, String.raw`\\`
  ];
  for (const escape of validEscapes) {
    const candidate = source.replace('"expiresAt must be a valid date"', `"bad${escape}"`);
    assert.doesNotMatch(sanitizeJavaScriptEvidence(candidate), /__pi_invalid_escape_lexeme__/, escape);
    assert.equal(evidence(candidate).sourceOk, true, escape);
  }
  for (const continuation of ["\\\n", "\\\r", "\\\r\n", "\\\u2028", "\\\u2029"]) {
    const candidate = source.replace('"expiresAt must be a valid date"', `"bad${continuation}message"`);
    assert.doesNotMatch(sanitizeJavaScriptEvidence(candidate), /__pi_invalid_escape_lexeme__/);
    assert.equal(evidence(candidate).sourceOk, true);
  }
});

test("invalid escapes cannot retain or shift a later executable test binding", () => {
  const sourceEntry = { path: "src/reliability/expiry.js", text: source };
  const liveTest = { path: "test/smoke.test.js", text: focusedTests };
  assert.equal(acceptanceExecutableTestBinding({ sourceEntry, testEntry: liveTest }).linked, true);
  const invalidPrefix = `const marker = "bad${String.raw`\8`}";\n`;
  const malformedTest = { ...liveTest, text: `${invalidPrefix}${focusedTests}` };
  assert.equal(acceptanceExecutableTestBinding({ sourceEntry, testEntry: malformedTest }).linked, false);
  assert.equal(evidence(source, contract, malformedTest.text).testOk, false);
});

test("unterminated lexical tails cannot preserve otherwise valid evidence", () => {
  const sourceEntry = { path: "src/reliability/expiry.js", text: source };
  const invalidTails = ["/* unterminated", 'const marker = "unterminated', "const marker = `unterminated", "const marker = /unterminated"];
  for (const tail of invalidTails) {
    const malformedSource = `${source}\n${tail}`;
    const malformedTest = `${focusedTests}\n${tail}`;
    assert.match(sanitizeJavaScriptEvidence(malformedSource), /__pi_invalid_[a-z0-9_]*lexeme__/);
    assert.equal(evidence(malformedSource).sourceOk, false, tail);
    assert.equal(evidence(source, contract, malformedTest).testOk, false, tail);
    assert.equal(acceptanceExecutableTestBinding({
      sourceEntry,
      testEntry: { path: "test/smoke.test.js", text: malformedTest }
    }).linked, false, tail);
  }
});

test("string sentinels use exact cooked values for modules, typeof, errors, and whitespace", () => {
  for (const specifier of [" NODE:ASSERT/STRICT ", "Node:Assert/Strict", " assert "]) {
    const testText = focusedTests.replace("node:assert/strict", specifier);
    assert.doesNotMatch(sanitizeJavaScriptEvidence(testText), /__pi_node_assert_module_literal__/);
    assert.equal(evidence(source, contract, testText).testOk, false, specifier);
  }
  assert.doesNotMatch(sanitizeJavaScriptEvidence('const kind = " STRING ";'), /__pi_typeof_string_literal__/);
  assert.doesNotMatch(sanitizeJavaScriptEvidence(String.raw`const value = "\0";`), /__pi_whitespace_string_literal__/);
  assert.doesNotMatch(sanitizeJavaScriptEvidence(String.raw`const value = "\n\0";`), /__pi_whitespace_string_literal__/);
  for (const literal of [String.raw`\x20`, String.raw`\u0020`, String.raw`\ `, String.raw`\u00a0`]) {
    assert.match(sanitizeJavaScriptEvidence(`const value = "${literal}";`), /__pi_whitespace_string_literal__/, literal);
  }

  const exactName = focusedTests.replaceAll(", TypeError);", ', { name: "TypeError" });');
  const wrongName = exactName.replaceAll('name: "TypeError"', 'name: "typeerror"');
  const paddedName = exactName.replaceAll('name: "TypeError"', 'name: " TYPEERROR "');
  assert.equal(evidence(source, contract, exactName).testOk, true);
  assert.equal(evidence(source, contract, wrongName).testOk, false);
  assert.equal(evidence(source, contract, paddedName).testOk, false);
});

test("bound module strings cook valid escapes without weakening exact identity", () => {
  const escapedProduct = focusedTests.replace(
    "../src/reliability/expiry.js",
    String.raw`../src/reliability/expir\u0079.js`
  );
  const escapedAssert = focusedTests.replace("node:assert/strict", String.raw`node:assert/str\u0069ct`);
  const escapedSlash = focusedTests.replace("node:assert/strict", String.raw`node:assert\/strict`);
  for (const testText of [escapedProduct, escapedAssert, escapedSlash]) {
    assert.equal(evidence(source, contract, testText).testOk, true);
  }
});

test("quoted U+2028 and U+2029 remain valid cooked string content", () => {
  for (const separator of ["\u2028", "\u2029"]) {
    const message = `"bad${separator}message"`;
    const candidate = source.replace('"expiresAt must be a valid date"', message);
    assert.doesNotMatch(sanitizeJavaScriptEvidence(candidate), /__pi_invalid_[a-z0-9_]*lexeme__/);
    assert.equal(evidence(candidate).sourceOk, true);
  }
});

test("closed invalid template and regex literals cannot preserve valid test evidence", () => {
  const invalidStatements = [
    "const junk = `\\8`;", "const junk = `\\x`;", "const junk = `\\u{}`;",
    "const junk = /\\8/u;", "const junk = /(/;", "const junk = /x/gg;",
    "const junk = /x/z;", "const junk = /\\u{110000}/u;"
  ];
  for (const statement of invalidStatements) {
    const malformedTest = `${focusedTests}\n${statement}`;
    assert.match(sanitizeJavaScriptEvidence(malformedTest), /__pi_invalid_(?:template|regex)_lexeme__/, statement);
    assert.equal(evidence(source, contract, malformedTest).testOk, false, statement);
  }
});

test("direct helper partitions remain bound to the requested parameter", () => {
  const invalidNowOnly = "`isExpired(expiresAt, now)` must throw `TypeError` for invalid explicit `now` values.";
  assert.equal(evidence(source, invalidNowOnly).sourceOk, true);
  assert.equal(evidence(source, "Numeric zero `now` must throw `TypeError`.").sourceOk, false);
  assert.equal(evidence(source, "Every non-string `expiresAt` must throw `TypeError`.").sourceOk, false);
  assert.equal(evidence(source, "Every non-array `now` must throw `TypeError`.").sourceOk, false);
  const ambiguous = `import assert from "node:assert/strict"; import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired(null, null), TypeError);`;
  assert.equal(evidence(source, "Invalid inputs to `isExpired` must throw `TypeError`.", ambiguous).sourceOk, false);
});

test("receipt integration settles only the exact direct-TypeError module", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-direct-throw-proof-"));
  try {
    fs.mkdirSync(path.join(cwd, "src/reliability"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src/reliability/expiry.js"), source);
    fs.writeFileSync(path.join(cwd, "test/smoke.test.js"), focusedTests);
    const digest = versionWorkingTreeHash("b".repeat(64));
    const command = "node --test test/smoke.test.js";
    const refresh = (candidate) => {
      fs.writeFileSync(path.join(cwd, "src/reliability/expiry.js"), candidate);
      const built = buildAcceptanceReceipt({
        summary: contract,
        expectedOutput: "The strict expiry contract is implemented and verified.",
        acceptanceCriteria: [contract],
        changeMode: "source-change",
        source: "runtime",
        generatedAt: "2026-08-29T00:00:00.000Z"
      });
      const task = {
        summary: contract,
        expectedOutput: "The strict expiry contract is implemented and verified.",
        acceptanceCriteria: built.acceptanceCriteria,
        acceptanceReceipt: built.receipt,
        changeMode: "source-change",
        workingTreeDigestAlgorithm: "wt-content-v2",
        changedFiles: ["src/reliability/expiry.js", "test/smoke.test.js"],
        verifyCommands: [command],
        verifyEvidence: [{
          command,
          exitCode: 0,
          observed: true,
          matchedProfileCommand: true,
          recordedAt: "2026-08-29T00:00:01.000Z",
          preWorkingTreeDigest: digest,
          workingTreeDigest: digest
        }],
        trace: { outcome: "pending" }
      };
      return refreshAcceptanceReceipt(task, {
        cwd,
        changedFiles: task.changedFiles,
        currentWorkingTreeDigest: digest,
        recordedAt: "2026-08-29T00:00:02.000Z"
      });
    };
    assert.equal(refresh(source).criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    assert.equal(refresh(source.replace("month > 12", "month > 13")).criticalMissing
      .some((item) => item.obligation === "invalid-input-rejection"), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
