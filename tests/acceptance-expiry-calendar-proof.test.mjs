import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptanceInvalidInputEvidence, sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const summary = [
  "Fix `isExpired(expiresAt, now)` in `src/reliability/expiry.js`.",
  "An item is expired when `now` is equal to or later than its expiry instant.",
  "Accept an ISO timestamp string or `Date` for `expiresAt`, and a millisecond number or `Date` for `now`.",
  "Invalid dates must throw `TypeError`; do not use the machine's current time when an explicit falsey value is provided.",
  "Preserve the API and verify the project."
].join(" ");

const expirySource = `function parseExpiry(expiresAt) {
  if (expiresAt instanceof Date) {
    const timestamp = expiresAt.getTime();
    if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");
    return timestamp;
  }

  if (typeof expiresAt !== "string") throw new TypeError("Invalid expiry date");

  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$/.exec(expiresAt);
  if (!match) throw new TypeError("Invalid expiry date");

  const [, year, month, day, hour, minute, second = "00"] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const leapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber - 1] || 0;
  if (
    monthNumber < 1 || monthNumber > 12 ||
    dayNumber < 1 || dayNumber > daysInMonth ||
    hourNumber > 23 || minuteNumber > 59 || secondNumber > 59
  ) {
    throw new TypeError("Invalid expiry date");
  }

  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");
  return timestamp;
}

function parseNow(now) {
  if (now instanceof Date) {
    const timestamp = now.getTime();
    if (Number.isNaN(timestamp)) throw new TypeError("Invalid current date");
    return timestamp;
  }

  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("Invalid current date");
  }
  return now;
}

export function isExpired(expiresAt, now) {
  const timestamp = parseExpiry(expiresAt);
  const currentTimestamp = arguments.length < 2 ? Date.now() : parseNow(now);
  return currentTimestamp >= timestamp;
}
`;

const expiryTest = `import assert from "node:assert/strict";
import test from "node:test";

import { isExpired } from "../src/reliability/expiry.js";

const expiry = "2025-01-01T00:00:00.000Z";
const expiryMilliseconds = Date.parse(expiry);

test("isExpired uses an inclusive expiry boundary", () => {
  assert.equal(isExpired(expiry, expiryMilliseconds - 1), false);
  assert.equal(isExpired(expiry, expiryMilliseconds), true);
  assert.equal(isExpired(expiry, expiryMilliseconds + 1), true);
});

test("isExpired accepts Date values", () => {
  assert.equal(isExpired(new Date(expiry), new Date(expiryMilliseconds)), true);
});

test("isExpired rejects a parseable non-ISO expiry string", () => {
  assert.throws(() => isExpired("January 1, 2025", 0), TypeError);
});

test("isExpired rejects an impossible ISO calendar date", () => {
  assert.throws(() => isExpired("2025-02-30T00:00:00.000Z", 0), TypeError);
});

test("isExpired rejects an invalid expiry Date", () => {
  assert.throws(() => isExpired(new Date(Number.NaN), 0), TypeError);
});

test("isExpired rejects invalid now values and preserves explicit zero", () => {
  assert.throws(() => isExpired(expiry, undefined), TypeError);
  assert.throws(() => isExpired(expiry, null), TypeError);
  assert.throws(() => isExpired(expiry, false), TypeError);
  assert.throws(() => isExpired(expiry, Number.NaN), TypeError);
  assert.throws(() => isExpired(expiry, Infinity), TypeError);
  assert.equal(isExpired(expiry, 0), false);
});

test("isExpired uses Date.now only when now is omitted", () => {
  const originalDateNow = Date.now;
  Date.now = () => expiryMilliseconds;
  try {
    assert.equal(isExpired(expiry), true);
    assert.throws(() => isExpired(expiry, undefined), TypeError);
  } finally {
    Date.now = originalDateNow;
  }
});

test("isExpired does not mutate Date inputs", () => {
  const expiresAt = new Date(expiry);
  const now = new Date(expiryMilliseconds);
  const expiresAtBefore = expiresAt.getTime();
  const nowBefore = now.getTime();

  isExpired(expiresAt, now);

  assert.equal(expiresAt.getTime(), expiresAtBefore);
  assert.equal(now.getTime(), nowBefore);
});
`;

function evidence(source = expirySource) {
  return acceptanceInvalidInputEvidence({
    taskText: summary,
    sourceText: source,
    testText: expiryTest,
    sourceEntries: [{ path: "src/reliability/expiry.js", text: source }],
    testEntries: [{ path: "test/expiry.test.js", text: expiryTest }],
    namedTargets: ["isExpired"],
    provenanceTargets: ["isExpired"]
  });
}

test("reserves the two-digit zero sentinel for the exact literal only", () => {
  assert.match(sanitizeJavaScriptEvidence('const second = "00";'), /__pi_two_digit_zero_string_literal__/);
  for (const value of ["0", "000", " 00", "00 "]) {
    assert.doesNotMatch(sanitizeJavaScriptEvidence(`const second = "${value}";`), /__pi_two_digit_zero_string_literal__/);
  }
});

test("does not let the two-digit zero sentinel change an unrelated acceptance contract", () => {
  const contractEvidence = (literal) => acceptanceInvalidInputEvidence({
    taskText: "`parseCount(value)` rejects negative and fractional values with `TypeError`.",
    sourceText: `export const marker = "${literal}"; export function parseCount(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("value"); return value; }`,
    testText: `import assert from "node:assert/strict"; import { parseCount } from "../src/count.js"; assert.throws(() => parseCount(-1), TypeError); assert.throws(() => parseCount(1.5), TypeError);`,
    sourceEntries: [{ path: "src/count.js", text: `export const marker = "${literal}"; export function parseCount(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("value"); return value; }` }],
    testEntries: [{ path: "test/count.test.js", text: `import assert from "node:assert/strict"; import { parseCount } from "../src/count.js"; assert.throws(() => parseCount(-1), TypeError); assert.throws(() => parseCount(1.5), TypeError);` }],
    namedTargets: ["parseCount"], provenanceTargets: ["parseCount"]
  });
  assert.deepEqual(contractEvidence("00"), { sourceOk: true, testOk: true });
  assert.deepEqual(contractEvidence("07"), { sourceOk: true, testOk: true });
});

test("accepts only the exact retained full ISO calendar parser proof", () => {
  assert.deepEqual(evidence(), { sourceOk: true, testOk: true });
  const mutations = [
    ["wrong parser parameter", expirySource.replace("parseExpiry(expiresAt)", "parseExpiry(value)")],
    ["missing start anchor", expirySource.replace("/^(\\d{4})", "/(\\d{4})")],
    ["missing end anchor", expirySource.replace("\\d{2})$/.exec", "\\d{2})/.exec")],
    ["wrong year width", expirySource.replace("\\d{4}", "\\d{3}")],
    ["wrong month width", expirySource.replace("-(\\d{2})-(\\d{2})T", "-(\\d{1,2})-(\\d{2})T")],
    ["permissive timezone", expirySource.replace("[+-]\\d{2}:?\\d{2}", "[+-]\\d{1,2}:?\\d{2}")],
    ["multiline regex flag", expirySource.replace("\\d{2})$/.exec", "\\d{2})$/m.exec")],
    ["lowercase regex digit class", expirySource.replace("\\d{4}", "\\D{4}")],
    ["lowercase time separator", expirySource.replace(")T(\\d{2}", ")t(\\d{2}")],
    ["lowercase UTC marker", expirySource.replace("(?:Z|", "(?:z|")],
    ["lowercase Date intrinsic", expirySource.replace("instanceof Date", "instanceof date")],
    ["lowercase Number intrinsic", expirySource.replace("Number.isNaN", "number.isNaN")],
    ["lowercase TypeError", expirySource.replace("new TypeError", "new typeerror")],
    ["wrong second default", expirySource.replace('second = "00"', 'second = "0"')],
    ["capture reorder", expirySource.replace("hour, minute, second", "minute, hour, second")],
    ["capture dropped", expirySource.replace("hour, minute, second", "hour, second")],
    ["wrong month binding", expirySource.replace("Number(month);", "Number(day);")],
    ["wrong leap divisor", expirySource.replace("yearNumber % 400", "yearNumber % 300")],
    ["wrong leap operator", expirySource.replace("=== 0 && (yearNumber", "=== 0 || (yearNumber")],
    ["wrong month table", expirySource.replace("leapYear ? 29 : 28", "leapYear ? 29 : 27")],
    ["wrong month index", expirySource.replace("[monthNumber - 1]", "[monthNumber]")],
    ["wrong table fallback", expirySource.replace("] || 0;", "] ?? 0;")],
    ["missing lower month bound", expirySource.replace("monthNumber < 1 || ", "")],
    ["widened upper month bound", expirySource.replace("monthNumber > 12", "monthNumber > 13")],
    ["missing lower day bound", expirySource.replace("dayNumber < 1 || ", "")],
    ["missing upper day bound", expirySource.replace("dayNumber > daysInMonth ||", "")],
    ["widened hour bound", expirySource.replace("hourNumber > 23", "hourNumber > 24")],
    ["widened minute bound", expirySource.replace("minuteNumber > 59", "minuteNumber > 60")],
    ["widened second bound", expirySource.replace("secondNumber > 59", "secondNumber > 60")],
    ["calendar conjunction", expirySource.replace("monthNumber < 1 || monthNumber", "monthNumber < 1 && monthNumber")],
    ["wrong rejection class", expirySource.replace("new TypeError", "new RangeError")],
    ["missing Date invalid guard", expirySource.replace('    if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");\n    return timestamp;', "    return timestamp;")],
    ["missing Date.parse invalid guard", expirySource.replace('  if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");\n  return timestamp;\n}', "  return timestamp;\n}")],
    ["wrong timestamp return", expirySource.replace("  return timestamp;\n}\n\nfunction parseNow", "  return 0;\n}\n\nfunction parseNow")],
    ["wrong omission threshold", expirySource.replace("arguments.length < 2", "arguments.length < 3")],
    ["default parameter laundering", expirySource.replace("isExpired(expiresAt, now)", "isExpired(expiresAt, now = Date.now())")]
    ,["computed Object defineProperty poisoning", `Object["defineProperty"](Date, "parse", { value: () => 0 });\n${expirySource}`]
    ,["destructured defineProperty poisoning", `const { defineProperty } = Object; defineProperty(Date, "parse", { value: () => 0 });\n${expirySource}`]
    ,["aliased Object defineProperty poisoning", `const O = Object; O.defineProperty(Date, "parse", { value: () => 0 });\n${expirySource}`]
    ,["Reflect set poisoning", `Reflect["set"](Number, "isNaN", () => false);\n${expirySource}`]
    ,["Date getTime poisoning", `Date.prototype.getTime = () => 0;\n${expirySource}`]
    ,["computed Date parse poisoning", `Date["parse"] = () => 0;\n${expirySource}`]
    ,["computed Number isNaN poisoning", `Number["isNaN"] = () => false;\n${expirySource}`]
    ,["aliased Date poisoning", `const D = Date; D.parse = () => 0;\n${expirySource}`]
    ,["arbitrary Date poison call", `poison(Date);\n${expirySource}`]
  ];
  for (const [name, source] of mutations) {
    assert.notEqual(source, expirySource, `${name} mutation must change the source`);
    assert.equal(evidence(source).sourceOk, false, name);
  }
});

test("accepts independently shaped alpha-equivalent strict calendar parsers", () => {
  const rename = new Map([
    ["parseExpiry", "decodeDeadline"], ["expiresAt", "deadline"], ["match", "parts"],
    ["yearNumber", "yyyy"], ["monthNumber", "mm"], ["dayNumber", "dd"],
    ["hourNumber", "hh"], ["minuteNumber", "mi"], ["secondNumber", "ss"],
    ["daysInMonth", "monthLimit"], ["leapYear", "isLeap"], ["timestamp", "instant"],
    ["year", "yearPart"], ["month", "monthPart"], ["day", "dayPart"],
    ["hour", "hourPart"], ["minute", "minutePart"], ["second", "secondPart"]
  ]);
  const renamed = [...rename].sort(([left], [right]) => right.length - left.length)
    .reduce((source, [from, to]) => source.replace(new RegExp(`\\b${from}\\b`, "g"), to), expirySource);
  const variants = [
    renamed,
    renamed.replace("const parts = /", "const parts = deadline.match(/").replace("$/.exec(deadline);", "$/);") ,
    expirySource.replace(/\n  /g, "\n      ").replace(/ = /g, "  =  "),
    expirySource.replace(
      "[31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber - 1] || 0",
      "monthNumber === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(monthNumber) ? 30 : 31"
    ),
    expirySource.replaceAll('if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");', 'if (Number.isNaN(timestamp)) { throw new TypeError("Invalid expiry date"); }'),
    expirySource.replace(/function parseExpiry[\s\S]*?\n}\n\nfunction parseNow/, (block) => block.replace(/;/g, "")),
    expirySource.replace(
      `if (\n    monthNumber < 1 || monthNumber > 12 ||\n    dayNumber < 1 || dayNumber > daysInMonth ||\n    hourNumber > 23 || minuteNumber > 59 || secondNumber > 59\n  ) {\n    throw new TypeError("Invalid expiry date");\n  }`,
      `if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth) { throw new TypeError("Invalid expiry date"); }\n  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) { throw new TypeError("Invalid expiry date"); }`
    ),
    expirySource.replace(
      `const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber - 1] || 0;`,
      `const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];\n  const daysInMonth = monthDays[monthNumber - 1] || 0;`
    ),
    expirySource.replace(
      `[31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber - 1]`,
      `[0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber]`
    ),
    expirySource.replace("const [, year, month, day, hour, minute, second", "let [, year, month, day, hour, minute, second")
    ,expirySource.replace('if (typeof expiresAt !== "string") throw new TypeError("Invalid expiry date");', 'if (typeof expiresAt !== "string") { throw new TypeError("Invalid expiry date"); }')
    ,expirySource.replace('if (!match) throw new TypeError("Invalid expiry date");', 'if (!match) { throw new TypeError("Invalid expiry date"); }')
    ,expirySource
      .replaceAll('if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");', 'if (Number.isNaN(timestamp)) { throw new TypeError("Invalid expiry date"); }')
      .replace('if (typeof expiresAt !== "string") throw new TypeError("Invalid expiry date");', 'if (typeof expiresAt !== "string") { throw new TypeError("Invalid expiry date"); }')
      .replace('if (!match) throw new TypeError("Invalid expiry date");', 'if (!match) { throw new TypeError("Invalid expiry date"); }')
  ];
  for (const [index, source] of variants.entries()) {
    assert.deepEqual(evidence(source), { sourceOk: true, testOk: true }, `positive variant ${index + 1}`);
  }
  const direct = variants[3];
  assert.equal(evidence(direct.replace("[4, 6, 9, 11]", "[4, 6, 9, 12]")).sourceOk, false);
  assert.equal(evidence(direct.replace("monthNumber === 2", "monthNumber === 3")).sourceOk, false);
  assert.equal(evidence(expirySource.replace("monthNumber < 1 ||", "yearNumber < 1970 || monthNumber < 1 ||")).sourceOk, false,
    "an extra year floor narrows the valid four-digit ISO contract and is not equivalent");
  const bracedType = variants.at(-3);
  assert.equal(evidence(bracedType.replace("{ throw new TypeError", "{ audit(expiresAt); throw new TypeError")).sourceOk, false,
    "a brace block with an extra statement is not a simple rejection guard");
  assert.equal(evidence(bracedType.replace("new TypeError", "new RangeError")).sourceOk, false,
    "a brace block with the wrong error class is rejected");
  assert.equal(evidence(bracedType.replace("; }", "; } else { return 0; }")).sourceOk, false,
    "a brace guard with an else branch is not normalized");
});

test("refreshes the retained calendar receipt to satisfied on the current tree", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-expiry-calendar-proof-"));
  try {
    fs.mkdirSync(path.join(cwd, "src", "reliability"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "reliability", "expiry.js"), expirySource);
    fs.writeFileSync(path.join(cwd, "test", "expiry.test.js"), expiryTest);
    const criteria = ["Invalid dates must throw `TypeError`", "do not use the machine's current time when an explicit falsey value is provided."];
    const built = buildAcceptanceReceipt({
      summary, expectedOutput: "The exact retained temporal contract is verified.", acceptanceCriteria: criteria,
      changeMode: "source-change", source: "runtime", generatedAt: "2026-08-29T00:00:00.000Z"
    });
    const digest = versionWorkingTreeHash("a".repeat(64));
    const command = "node --test test/expiry.test.js";
    const task = {
      summary, expectedOutput: "The exact retained temporal contract is verified.",
      acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
      changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
      changedFiles: ["src/reliability/expiry.js", "test/expiry.test.js"], verifyCommands: [command],
      verifyEvidence: [{ command, exitCode: 0, observed: true, matchedProfileCommand: true,
        recordedAt: "2026-08-29T00:00:01.000Z", preWorkingTreeDigest: digest, workingTreeDigest: digest }],
      trace: { outcome: "pending" }
    };
    const refreshed = refreshAcceptanceReceipt(task, {
      cwd, changedFiles: task.changedFiles, currentWorkingTreeDigest: digest,
      recordedAt: "2026-08-29T00:00:02.000Z"
    });
    assert.equal(refreshed.receipt.criteria.find((item) => item.obligation === "invalid-input-rejection")?.status, "satisfied");
    assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
