import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceContractProofGuidance, acceptanceInvalidInputEvidence, sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { executableRejectionAssertions } from "../packages/piagent-core/extensions/acceptance-executable-evidence.js";

const criterion = "Invalid dates must throw `TypeError`.";
const fixtureTest = `
  import assert from "node:assert/strict";
  import { isExpired } from "../src/reliability/expiry.js";

  for (const value of ["", "not a date", "2026-02-30T00:00:00.000Z", new Date("invalid"), 0, null, undefined, false]) {
    assert.throws(() => isExpired(value, Date.parse("2026-01-01T00:00:00.000Z")), TypeError);
  }
  for (const value of [NaN, Infinity, "0", null, false, new Date("invalid")]) {
    assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", value), TypeError);
  }
`;
const fixtureWithoutImpossibleCalendar = fixtureTest.replace('"2026-02-30T00:00:00.000Z", ', "");
const temporalContractFixture = fixtureTest
  .replace('"not a date", ', '"not a date", "01/01/2026", ')
  .replace('[NaN, Infinity, "0", null, false, new Date("invalid")]', '[NaN, Infinity, "0", null, false, undefined, new Date("invalid")]');

function evidence(source, testText = fixtureTest, taskText = criterion) {
  return acceptanceInvalidInputEvidence({
    taskText,
    sourceText: source,
    testText,
    sourceEntries: [{ path: "src/reliability/expiry.js", text: source }],
    testEntries: [{ path: "test/expiry.test.js", text: testText }],
    namedTargets: ["isExpired"],
    provenanceTargets: ["isExpired"]
  });
}

function namedEvidence({ source, testText, taskText, target, sourcePath = "src/date.js" }) {
  return acceptanceInvalidInputEvidence({
    taskText,
    sourceText: source,
    testText,
    sourceEntries: [{ path: sourcePath, text: source }],
    testEntries: [{ path: "test/date.test.js", text: testText }],
    namedTargets: [target],
    provenanceTargets: [target]
  });
}

const exactExpiryFixture = `
  function timestampFrom(value, allowNumber) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");
      return timestamp;
    }
    if (allowNumber && typeof value === "number" && Number.isFinite(value)) return value;
    if (!allowNumber && typeof value === "string") {
      const match = /^(\\d{4})-(\\d{2})-(\\d{2})T/.exec(value);
      if (match) {
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const timestamp = Date.parse(value);
        if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && !Number.isNaN(timestamp)) return timestamp;
      }
    }
    throw new TypeError("Invalid date");
  }

  export function isExpired(expiresAt, now = Date.now()) {
    const timestamp = timestampFrom(expiresAt, false);
    return timestampFrom(now, true) >= timestamp;
  }
`;

const retainedExpiryFixture = `
  function expiryTimestamp(expiresAt) {
    if (expiresAt instanceof Date) {
      const timestamp = expiresAt.getTime();
      if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");
      return timestamp;
    }
    if (typeof expiresAt === "string") {
      const timestamp = Date.parse(expiresAt);
      if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");
      return timestamp;
    }
    throw new TypeError("Invalid expiry date");
  }

  function nowTimestamp(now) {
    if (now instanceof Date) {
      const timestamp = now.getTime();
      if (Number.isNaN(timestamp)) throw new TypeError("Invalid current date");
      return timestamp;
    }
    if (typeof now === "number" && Number.isFinite(now)) return now;
    throw new TypeError("Invalid current date");
  }

  export function isExpired(expiresAt, now) {
    const current = arguments.length < 2 ? Date.now() : now;
    return nowTimestamp(current) >= expiryTimestamp(expiresAt);
  }
`;

const productionExpiryFixture = `
  function expiryTime(value) {
    if (value instanceof Date) { const result = value.getTime(); if (!Number.isFinite(result)) throw new TypeError("invalid expiry"); return result; }
    if (typeof value !== "string") throw new TypeError("invalid expiry");
    const match = /^(\\d{4})-(\\d{2})-(\\d{2})T/.exec(value); const result = Date.parse(value);
    if (!match || !Number.isFinite(result)) throw new TypeError("invalid expiry");
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new TypeError("invalid expiry");
    return result;
  }
  function nowTime(value) { if (value instanceof Date) { const result = value.getTime(); if (!Number.isFinite(result)) throw new TypeError("invalid now"); return result; } if (typeof value === "number" && Number.isFinite(value)) return value; throw new TypeError("invalid now"); }
  export function isExpired(expiresAt, now) { return nowTime(arguments.length < 2 ? Date.now() : now) >= expiryTime(expiresAt); }
`;

const retainedS12ExpiryFixture = `
  function toExpiryTimestamp(value) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      if (!Number.isNaN(timestamp)) return timestamp;
      throw new TypeError("Invalid expiry date");
    }
    if (typeof value !== "string") throw new TypeError("Invalid expiry date");
    const match = /^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:?\\d{2}))?$/.exec(value);
    if (!match) throw new TypeError("Invalid expiry date");
    const [, year, month, day, hour, minute, second, fraction, zone] = match;
    const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth) {
      throw new TypeError("Invalid expiry date");
    }
    if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) {
      throw new TypeError("Invalid expiry date");
    }
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");
    return timestamp;
  }
  function toNowTimestamp(value) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      if (!Number.isNaN(timestamp)) return timestamp;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    throw new TypeError("Invalid current date");
  }
  export function isExpired(expiresAt, now) {
    const timestamp = toExpiryTimestamp(expiresAt);
    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);
    return currentTimestamp >= timestamp;
  }
`;

const retainedS12ExpiryTest = `
  import assert from "node:assert/strict";
  import { isExpired } from "../src/reliability/expiry.js";
  const expiry = "2026-01-01T00:00:00.000Z";
  assert.equal(isExpired(expiry, Date.parse(expiry)), true);
  assert.equal(isExpired(new Date(expiry), 1767225600000), true);
  for (const value of [undefined, null, false, 0, "January 1, 2026", "2025-02-29T00:00:00Z", new Date("invalid")]) {
    assert.throws(() => isExpired(value, 0), TypeError);
  }
  for (const value of [undefined, null, false, "2026-01-01", NaN, Infinity, new Date("invalid")]) {
    assert.throws(() => isExpired(expiry, value), TypeError);
  }
  assert.equal(isExpired("1970-01-01T00:00:00.000Z", 0), true);
  assert.equal(isExpired("2999-01-01T00:00:00.000Z"), false);
`;

const expiryBoundaryTask = [
  "`isExpired(expiresAt, now)` accepts an ISO timestamp string or Date for expiresAt,",
  "and a millisecond number or Date for now. Invalid dates must throw TypeError;",
  "do not use the machine's current time when an explicit falsey value is provided."
].join(" ");

test("accepts the exact timestampFrom/isExpired fixture for the bounded evidence it actually exercises", () => {
  assert.deepEqual(evidence(exactExpiryFixture), { sourceOk: true, testOk: true });
});

test("distinguishes explicit undefined from omission and rejects Date.parse-only ISO validation", () => {
  const temporalContract = [
    "Accept an ISO timestamp string or Date for expiresAt, and a millisecond number or Date for now.",
    "Invalid dates must throw TypeError; do not use the machine's current time when an explicit falsey value is provided."
  ].join(" ");
  assert.deepEqual(evidence(productionExpiryFixture, temporalContractFixture, temporalContract), { sourceOk: true, testOk: true });
  assert.equal(evidence(productionExpiryFixture, fixtureTest, temporalContract).testOk, false);
  assert.equal(evidence(exactExpiryFixture, temporalContractFixture, temporalContract).sourceOk, false);
  assert.equal(evidence(retainedExpiryFixture, temporalContractFixture, temporalContract).sourceOk, false);
  const exactPrompt = "`isExpired(expiresAt, now)` accepts an ISO timestamp string or Date for expiresAt, and a millisecond number or Date for now. Invalid dates must throw TypeError; do not use the machine's current time when an explicit falsey value is provided.";
  assert.deepEqual(evidence(productionExpiryFixture, temporalContractFixture, exactPrompt), { sourceOk: true, testOk: true });
  for (const threshold of [0, 1, 3, 99]) {
    assert.equal(evidence(
      productionExpiryFixture.replace("arguments.length < 2", `arguments.length < ${threshold}`),
      temporalContractFixture,
      exactPrompt
    ).sourceOk, false, `arguments.length < ${threshold} must not prove omission semantics`);
  }
});

test("projects bounded temporal proof guidance from the operator contract", () => {
  const guidance = acceptanceContractProofGuidance([
    "Accept an ISO timestamp string or Date for expiresAt.",
    "Invalid dates must throw TypeError.",
    "Do not use the machine's current time when an explicit falsey value is provided."
  ].join(" "));
  assert.ok(guidance.some((item) => /parseable non-ISO string.*impossible calendar date.*invalid Date object/i.test(item)));
  assert.ok(guidance.some((item) => /omitted time argument.*explicitly supplied undefined.*default parameter/i.test(item)));
});

test("binds a one-argument ISO contract without relying on an expiry-like parameter name", () => {
  const source = productionExpiryFixture
    .replace("export function isExpired(expiresAt, now) { return nowTime(arguments.length < 2 ? Date.now() : now) >= expiryTime(expiresAt); }", "export function parseDate(value) { return expiryTime(value); }");
  const testText = `
    import assert from "node:assert/strict";
    import { parseDate } from "../src/date.js";
    for (const value of ["not a date", "01/01/2026", "2026-02-30T00:00:00.000Z", new Date("invalid")]) {
      assert.throws(() => parseDate(value), TypeError);
    }
  `;
  const taskText = "`parseDate(value)` accepts an ISO timestamp string. Invalid dates must throw `TypeError`.";
  assert.deepEqual(namedEvidence({ source, testText, taskText, target: "parseDate" }), { sourceOk: true, testOk: true });
  const unsupported = "`parseDate(value)` accepts only ISO timestamp strings. Unsupported values must throw `TypeError`.";
  assert.deepEqual(namedEvidence({ source, testText, taskText: unsupported, target: "parseDate" }), { sourceOk: true, testOk: true });
  assert.deepEqual(namedEvidence({
    source: "export function parseDate(value) { const result = Date.parse(value); if (!Number.isFinite(result)) throw new TypeError('date'); return result; }",
    testText: testText.replace(', "01/01/2026", "2026-02-30T00:00:00.000Z"', ""),
    taskText: unsupported,
    target: "parseDate"
  }), { sourceOk: false, testOk: false });
});

test("requires every task-bound temporal parameter and rejects default-parameter laundering", () => {
  const parser = productionExpiryFixture.slice(0, productionExpiryFixture.indexOf("  function nowTime"));
  const source = `${parser}\n  export function compareRange(startTimestamp, endTimestamp) { return expiryTime(startTimestamp) <= expiryTime(endTimestamp); }\n`;
  const testText = `
    import assert from "node:assert/strict";
    import { compareRange } from "../src/date.js";
    const valid = "2026-01-01T00:00:00.000Z";
    for (const value of ["not a date", "01/01/2026", "2026-02-30T00:00:00.000Z", new Date("invalid")]) {
      assert.throws(() => compareRange(value, valid), TypeError);
      assert.throws(() => compareRange(valid, value), TypeError);
    }
  `;
  const taskText = "`compareRange(startTimestamp, endTimestamp)` requires both timestamp arguments to be ISO strings. Invalid timestamps must throw `TypeError`.";
  assert.deepEqual(namedEvidence({ source, testText, taskText, target: "compareRange" }), { sourceOk: true, testOk: true });
  assert.deepEqual(namedEvidence({
    source: source.replaceAll("startTimestamp", "start").replaceAll("endTimestamp", "end"),
    testText,
    taskText: "`compareRange(start, end)` requires both arguments to be ISO timestamp strings. Unsupported values must throw `TypeError`.",
    target: "compareRange"
  }), { sourceOk: true, testOk: true });
  assert.equal(namedEvidence({
    source: source.replace("expiryTime(endTimestamp)", "expiryTime(startTimestamp)"), testText, taskText, target: "compareRange"
  }).sourceOk, false);
  assert.equal(namedEvidence({
    source, testText: testText.replace("      assert.throws(() => compareRange(valid, value), TypeError);\n", ""), taskText, target: "compareRange"
  }).testOk, false);

  const defaulted = productionExpiryFixture.replace(
    "export function isExpired(expiresAt, now)",
    "export function isExpired(expiresAt, now = Date.now())"
  );
  const expiryTask = "`isExpired(expiresAt, now)` accepts an ISO timestamp string or Date for expiresAt, and a millisecond number or Date for now. Invalid dates must throw TypeError; do not use the machine's current time when an explicit falsey value is provided.";
  assert.equal(evidence(defaulted, temporalContractFixture, expiryTask).sourceOk, false);
  const withoutExplicitUndefined = temporalContractFixture.replace("false, undefined, new Date", "false, new Date");
  for (const wording of [
    "Do not use Date.now when explicitly supplied undefined is passed for now.",
    "Distinguish an omitted now argument from an explicitly supplied undefined.",
    "Do not use current time when an explicit falsey value is provided.",
    "Do not use the system clock when an explicit falsey value is provided.",
    "Do not use the current clock when an explicit falsey value is provided."
  ]) {
    const naturalTask = `\`isExpired(expiresAt, now)\` accepts an ISO timestamp string or Date for expiresAt, and a millisecond number or Date for now. Invalid dates must throw TypeError. ${wording}`;
    assert.deepEqual(evidence(defaulted, withoutExplicitUndefined, naturalTask), { sourceOk: false, testOk: false });
    assert.deepEqual(evidence(productionExpiryFixture, temporalContractFixture, naturalTask), { sourceOk: true, testOk: true });
  }
});

test("requires explicit calendar bounds when executable evidence includes a non-existent date", () => {
  assert.deepEqual(evidence(retainedExpiryFixture, fixtureWithoutImpossibleCalendar), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence(retainedExpiryFixture), { sourceOk: false, testOk: true });
  assert.deepEqual(evidence(exactExpiryFixture), { sourceOk: true, testOk: true });
  assert.equal(evidence(exactExpiryFixture.replace("(\\d{4})", "(\\d)\\d")).sourceOk, false);
});

test("requires fail-closed normalizer coverage for every argument exercised as invalid", () => {
  const invalidSources = [
    retainedExpiryFixture.replace("nowTimestamp(current)", "current"),
    retainedExpiryFixture.replace("expiryTimestamp(expiresAt)", "expiresAt"),
    retainedExpiryFixture.replace(" && Number.isFinite(now)", ""),
    exactExpiryFixture.replace("return timestampFrom(now, true) >= timestamp;", "return now >= timestamp;"),
    exactExpiryFixture.replace(" && Number.isFinite(value)", "")
  ];
  for (const source of invalidSources) assert.equal(evidence(source).sourceOk, false, source);
  assert.deepEqual(evidence(retainedExpiryFixture), { sourceOk: false, testOk: true });
  assert.deepEqual(evidence(retainedExpiryFixture, fixtureWithoutImpossibleCalendar), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence(exactExpiryFixture), { sourceOk: true, testOk: true });
});

test("one direct invalid literal identifies the exact argument that requires validation", () => {
  const directNow = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", NaN), TypeError);
  `;
  const directExpiry = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired("not a date", 0), TypeError);
  `;
  assert.deepEqual(evidence(retainedExpiryFixture, directNow), { sourceOk: true, testOk: true });
  assert.equal(evidence(retainedExpiryFixture.replace(" && Number.isFinite(now)", ""), directNow).sourceOk, false);
  assert.deepEqual(evidence(retainedExpiryFixture, directExpiry), { sourceOk: true, testOk: true });
  assert.equal(evidence(retainedExpiryFixture.replace(
    'const timestamp = Date.parse(expiresAt);\n      if (Number.isNaN(timestamp)) throw',
    'const timestamp = Date.parse(expiresAt);\n      if (false) throw'
  ), directExpiry).sourceOk, false);

  const directHyphenatedExpiry = directExpiry.replace('"not a date"', '"not-a-date"');
  assert.deepEqual(evidence(retainedExpiryFixture, directHyphenatedExpiry), { sourceOk: true, testOk: true });
  assert.equal(evidence(retainedExpiryFixture.replace(
    'const timestamp = Date.parse(expiresAt);\n      if (Number.isNaN(timestamp)) throw',
    'const timestamp = Date.parse(expiresAt);\n      if (false) throw'
  ), directHyphenatedExpiry).sourceOk, false);

  const directInvalidObject = directExpiry.replace('"not a date"', "new Date(undefined)");
  assert.deepEqual(evidence(retainedExpiryFixture, directInvalidObject), { sourceOk: true, testOk: true });
  assert.equal(evidence(retainedExpiryFixture.replace(
    'if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");\n      return timestamp;',
    "return timestamp;"
  ), directInvalidObject).sourceOk, false);

  const exactFirstArgumentCases = [
    directExpiry.replace('"not a date"', '"01/01/2026"'),
    directExpiry.replace('"not a date"', "new Date(Infinity)"),
    directExpiry.replace('"not a date"', 'new Date("")')
  ];
  for (const directCase of exactFirstArgumentCases) {
    const assertions = executableRejectionAssertions(
      sanitizeJavaScriptEvidence(directCase).toLowerCase(), new Set(["isexpired"])
    );
    assert.deepEqual(assertions[0]?.invalidArgumentIndices, [0], directCase);
    assert.deepEqual(evidence(exactExpiryFixture, directCase), { sourceOk: true, testOk: true }, directCase);
    assert.equal(evidence(retainedExpiryFixture.replace("expiryTimestamp(expiresAt)", "expiresAt"), directCase).sourceOk, false, directCase);
  }
});

test("constant-folds only the active branch of a literal-boolean ternary argument", () => {
  const assertionFor = (argument) => {
    const raw = `
      import assert from "node:assert/strict";
      import { isExpired } from "../src/reliability/expiry.js";
      assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", ${argument}), TypeError);
    `;
    const assertions = executableRejectionAssertions(
      sanitizeJavaScriptEvidence(raw).toLowerCase(), new Set(["isexpired"])
    );
    assert.equal(assertions.length, 1);
    return assertions[0].invalidArgumentIndices;
  };
  assert.deepEqual(assertionFor("true ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("(true) ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("!false ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("1 === 1 ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("1 ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("(!(!true)) ? NaN : 0"), [1]);
  assert.deepEqual(assertionFor("false ? 0 : NaN"), [1]);
  assert.deepEqual(assertionFor("true ? (false ? 0 : NaN) : 0"), [1]);
  assert.deepEqual(assertionFor("false ? NaN : 0"), []);
  assert.deepEqual(assertionFor("(false) ? NaN : 0"), []);
  assert.deepEqual(assertionFor("!true ? NaN : 0"), []);
  assert.deepEqual(assertionFor("0 ? NaN : 0"), []);
  assert.deepEqual(assertionFor("1 === 2 ? NaN : 0"), []);
  assert.deepEqual(assertionFor("enabled ? NaN : 0"), []);
  assert.deepEqual(assertionFor("enabled ? 0 : NaN"), []);
  assert.deepEqual(assertionFor("enabled() ? NaN : 0"), []);
  assert.deepEqual(assertionFor("config.enabled ? NaN : 0"), []);
});

test("accepts a pure transform with dominating guards and a final top-level return", () => {
  const directInvalid = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired("not a date"), TypeError);
  `;
  const source = `
    function normalize(value) {
      if (typeof value !== "string") throw new TypeError("Invalid date");
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) throw new TypeError("Invalid date");
      return timestamp;
    }
    export function isExpired(expiresAt, now = Date.now()) {
      return normalize(expiresAt) <= now;
    }
  `;
  assert.deepEqual(evidence(source, directInvalid), { sourceOk: true, testOk: true });
  assert.equal(evidence(source.replace('const timestamp = Date.parse(value);', 'JSON.parse("{}");\n      const timestamp = Date.parse(value);'), directInvalid).sourceOk, false);
  assert.equal(evidence(`const Date = { parse: () => 0 };\n${source}`, directInvalid).sourceOk, false);
  assert.equal(evidence(`Date.parse = () => 0;\n${source}`, directInvalid).sourceOk, false);
  const intrinsicMutations = [
    `Date["parse"] = () => 0;\n${source}`,
    `Date.prototype.parse = () => 0;\n${source}`,
    `const D = Date; D["parse"] = () => 0;\n${source}`,
    `const D = Date; const Alias = D; Alias.parse = () => 0;\n${source}`,
    `const D = (Date); D.parse = () => 0;\n${source}`,
    `const D = [Date][0]; D.parse = () => 0;\n${source}`,
    `const D = { D: Date }.D; D.parse = () => 0;\n${source}`,
    `const D = Date || Number; D.parse = () => 0;\n${source}`,
    `const D = (0, Date); D.parse = () => 0;\n${source}`,
    `RegExp.prototype.exec = () => ["", "2026", "01", "01"];\n${source}`,
    `Array.isArray = () => true;\n${source}`,
    `const A = Array; const Alias = (A); Alias.isArray = () => true;\n${source}`,
    `Object.defineProperty(Date, "parse", { value: () => 0 });\n${source}`,
    `Object.defineProperty(Date.prototype, "parse", { value: () => 0 });\n${source}`,
    `Reflect.set(Date, "parse", () => 0);\n${source}`
  ];
  for (const mutation of intrinsicMutations) assert.equal(evidence(mutation, directInvalid).sourceOk, false, mutation);

  const parameterShadow = `
    function normalize(Date) {
      if (typeof Date === "string") return Date;
      throw new TypeError("Invalid date");
    }
    export function isExpired(expiresAt) { return normalize(expiresAt); }
  `;
  assert.equal(evidence(parameterShadow, directInvalid).sourceOk, false);
});

test("rejects unmodeled or wrong-error work hidden in conditional branches", () => {
  const directInvalid = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired(null), TypeError);
  `;
  const helper = `function normalize(value) { if (typeof value === "string") return value; throw new TypeError("invalid"); }`;
  const caller = `export function isExpired(expiresAt) { return normalize(expiresAt); }`;
  const invalid = [
    `function normalize(value) { if (enabled) throw new RangeError("wrong"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`,
    `function normalize(value) { if (enabled) JSON.parse("{}"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`,
    `function normalize(value) { if (JSON.parse("{}")) throw new TypeError("invalid"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`,
    `function normalize(value) { if (value.explodes) throw new TypeError("invalid"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`,
    `function normalize(value) { if (value["explodes"]) throw new TypeError("invalid"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`,
    `function normalize(value) { if (value < 0) throw new TypeError("invalid"); if (typeof value === "string") return value; throw new TypeError("invalid"); }\n${caller}`
  ];
  assert.deepEqual(evidence(`${helper}\n${caller}`, directInvalid), { sourceOk: true, testOk: true });
  for (const source of invalid) assert.equal(evidence(source, directInvalid).sourceOk, false, source);
});

test("requires every input-relevant top-level helper before a normalizer to be modeled", () => {
  const directInvalid = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired(null), TypeError);
  `;
  const normalizer = `function normalize(value) { if (typeof value === "string") return value; throw new TypeError("invalid"); }`;
  const invalid = [
    `function audit(value) { if (value) throw new RangeError("audit"); }\n${normalizer}\nexport function isExpired(expiresAt) { audit(expiresAt); return normalize(expiresAt); }`,
    `function audit(value) { JSON.parse(value); }\n${normalizer}\nexport function isExpired(expiresAt) { audit(expiresAt); return normalize(expiresAt); }`
  ];
  for (const source of invalid) assert.equal(evidence(source, directInvalid).sourceOk, false, source);
});

test("recursively proves a direct validator helper without misclassifying it as a normalizer", () => {
  const source = `
    export function pageCount(totalItems, pageSize) {
      if (!Number.isInteger(totalItems) || totalItems < 0) throw new TypeError("invalid totalItems");
      if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError("invalid pageSize");
      return Math.ceil(totalItems / pageSize);
    }
    export function clampPage(page, totalItems, pageSize) {
      if (!Number.isInteger(page)) throw new TypeError("invalid page");
      const count = pageCount(totalItems, pageSize);
      return count === 0 ? 0 : Math.min(Math.max(1, page), count);
    }
  `;
  const testText = `
    import assert from "node:assert/strict";
    import { clampPage, pageCount } from "../src/frontend/pagination.js";
    assert.throws(() => pageCount(-1, 20), TypeError);
    assert.throws(() => pageCount(1, 0), TypeError);
    assert.throws(() => clampPage(1.2, 10, 5), TypeError);
  `;
  const proof = (candidate) => acceptanceInvalidInputEvidence({
    taskText: "pageCount and clampPage must throw TypeError for invalid non-integer and boundary inputs.",
    sourceText: candidate,
    testText,
    sourceEntries: [{ path: "src/frontend/pagination.js", text: candidate }],
    testEntries: [{ path: "test/pagination.test.js", text: testText }],
    namedTargets: ["pageCount", "clampPage"],
    provenanceTargets: ["pageCount", "clampPage"]
  });
  assert.deepEqual(proof(source), { sourceOk: true, testOk: true });
  assert.equal(proof(source.replaceAll("new TypeError", "new RangeError")).sourceOk, false);
});

test("accepts the exact production expiry reference with chained invalid guards", () => {
  const productionInvalidTest = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired("not-a-date", 0), TypeError);
    assert.throws(() => isExpired("01/01/2026", 0), TypeError);
    assert.throws(() => isExpired("2026-02-30T00:00:00.000Z", 0), TypeError);
    assert.throws(() => isExpired(new Date(Number.NaN), 0), TypeError);
    assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", new Date(Number.NaN)), TypeError);
    assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", Number.POSITIVE_INFINITY), TypeError);
  `;
  const invalidExpiryOnly = productionInvalidTest.split("\n").filter((line) => !line.includes("new Date(Number.NaN)), TypeError")
    && !line.includes("Number.POSITIVE_INFINITY), TypeError")).join("\n");
  const invalidNowOnly = productionInvalidTest.split("\n").filter((line) => !line.includes("not-a-date")
    && !line.includes("01/01/2026") && !line.includes("2026-02-30") && !line.includes("new Date(Number.NaN), 0")).join("\n");
  assert.deepEqual(evidence(productionExpiryFixture, invalidExpiryOnly), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence(productionExpiryFixture, invalidNowOnly), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence(productionExpiryFixture, productionInvalidTest), { sourceOk: true, testOk: true });
  assert.equal(evidence(productionExpiryFixture.replace("month > 12 || ", ""), productionInvalidTest).sourceOk, false);
  assert.equal(evidence(productionExpiryFixture.replace("!match || ", ""), productionInvalidTest).sourceOk, false);
});

test("accepts the retained S12 destructured ISO normalizer and fails closed under proof mutations", () => {
  assert.deepEqual(evidence(retainedS12ExpiryFixture, retainedS12ExpiryTest, expiryBoundaryTask), { sourceOk: true, testOk: true });
  const exactRetainedPrompt = [
    "`isExpired(expiresAt, now)` accepts an ISO timestamp string or `Date` for `expiresAt`,",
    "and a millisecond number or `Date` for `now`. Invalid dates must throw `TypeError`;",
    "do not use the machine's current time when an explicit falsey value is provided."
  ].join(" ");
  assert.deepEqual(evidence(retainedS12ExpiryFixture, retainedS12ExpiryTest, exactRetainedPrompt), { sourceOk: true, testOk: true });
  assert.equal(evidence(retainedS12ExpiryFixture.replace(
    "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
    "    arguments.length = 1;\n    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);"
  ), retainedS12ExpiryTest, exactRetainedPrompt).sourceOk, false);
  const mutations = [
    {
      name: "missing capture guard",
      source: retainedS12ExpiryFixture.replace('    if (!match) throw new TypeError("Invalid expiry date");\n', "")
    },
    {
      name: "missing calendar bound",
      source: retainedS12ExpiryFixture.replace("Number(month) > 12 || ", "")
    },
    {
      name: "missing timestamp invalid guard",
      source: retainedS12ExpiryFixture.replace('    if (Number.isNaN(timestamp)) throw new TypeError("Invalid expiry date");\n    return timestamp;', "    return timestamp;")
    },
    {
      name: "wrong calendar rejection class",
      source: retainedS12ExpiryFixture.replace(
        'Number(day) > daysInMonth) {\n      throw new TypeError("Invalid expiry date");',
        'Number(day) > daysInMonth) {\n      throw new RangeError("Invalid expiry date");'
      )
    },
    {
      name: "lazy timestamp derivation",
      source: retainedS12ExpiryFixture.replace("const timestamp = Date.parse(value);", "const timestamp = enabled && Date.parse(value);")
    },
    {
      name: "unrelated calendar derivation",
      source: retainedS12ExpiryFixture.replace("Number(day) > daysInMonth", "Number(otherDay) > daysInMonth")
    },
    {
      name: "untrusted optional-time guard",
      source: retainedS12ExpiryFixture.replace("hour !== undefined &&", "enabled() && hour !== undefined &&")
    },
    {
      name: "wrong omission threshold",
      source: retainedS12ExpiryFixture.replace("arguments.length < 2", "arguments.length < 3")
    },
    {
      name: "generic lazy helper selection",
      source: retainedS12ExpiryFixture.replace("arguments.length < 2", "useClock")
    },
    {
      name: "eager now normalization before omission selection",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
        "    const normalizedNow = toNowTimestamp(now);\n    const currentTimestamp = arguments.length < 2 ? Date.now() : normalizedNow;"
      )
    },
    {
      name: "duplicate eager now normalization before omission selection",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
        "    toNowTimestamp(now);\n    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);"
      )
    },
    {
      name: "arguments length assignment before omission selection",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
        "    arguments.length = 1;\n    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);"
      )
    },
    {
      name: "arguments length decrement before omission selection",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
        "    arguments.length--;\n    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);"
      )
    },
    {
      name: "arguments length reflective mutation before omission selection",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);",
        "    Object.defineProperty(arguments, \"length\", { value: 1 });\n    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);"
      )
    },
    {
      name: "arrow callable captures or lacks an own arguments binding",
      source: retainedS12ExpiryFixture.replace(
        "  export function isExpired(expiresAt, now) {",
        "  export const isExpired = (expiresAt, now) => {"
      )
    },
    {
      name: "unmodeled less-than-or-equal omission selector after eager normalization",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);\n    return currentTimestamp >= timestamp;",
        "    const currentTimestamp = toNowTimestamp(now);\n    return (arguments.length <= 1 ? Date.now() : currentTimestamp) >= timestamp;"
      )
    },
    {
      name: "aliased arguments length selector after eager normalization",
      source: retainedS12ExpiryFixture.replace(
        "    const currentTimestamp = arguments.length < 2 ? Date.now() : toNowTimestamp(now);\n    return currentTimestamp >= timestamp;",
        "    const currentTimestamp = toNowTimestamp(now);\n    const argc = arguments.length;\n    return (argc < 2 ? Date.now() : currentTimestamp) >= timestamp;"
      )
    },
    {
      name: "destructured Number intrinsic shadow",
      source: `const intrinsics = { Number: { isNaN() { return false; }, isFinite() { return true; } } };\nconst { Number } = intrinsics;\n${retainedS12ExpiryFixture}`
    },
    {
      name: "calendar capture alias collides with Number intrinsic",
      source: retainedS12ExpiryFixture.replace(
        "const [, year, month, day, hour, minute, second, fraction, zone] = match;",
        "const [, year, month, day, hour, minute, second, fraction, Number] = match;"
      )
    },
    {
      name: "calendar capture alias collides with capture binding",
      source: retainedS12ExpiryFixture.replace(
        "const [, year, month, day, hour, minute, second, fraction, zone] = match;",
        "const [, year, month, day, hour, minute, second, fraction, match] = match;"
      )
    },
    {
      name: "multiline ISO regex flag permits newline junk",
      source: retainedS12ExpiryFixture.replace(
        "(Z|[+-]\\d{2}:?\\d{2}))?$/.exec(value)",
        "(Z|[+-]\\d{2}:?\\d{2}))?$/m.exec(value)"
      ),
      testText: `${retainedS12ExpiryTest}\nassert.throws(() => isExpired("2026-01-01\\nJUNK", 0), TypeError);`
    }
  ];
  for (const { name, source, testText = retainedS12ExpiryTest } of mutations) {
    assert.equal(evidence(source, testText, expiryBoundaryTask).sourceOk, false, name);
  }
});

test("accepts the closed full top-level calendar shape with an exact Date/getTime ternary", () => {
  const directCalendar = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired("2026-02-30T00:00:00.000Z"), TypeError);
  `;
  const source = `
    function normalize(value) {
      if (value instanceof Date) {
        const timestamp = value.getTime();
        if (!Number.isFinite(timestamp)) throw new TypeError("Invalid date");
        return timestamp;
      }
      if (typeof value !== "string") throw new TypeError("Invalid date");
      const match = /^(\\d{4})-(\\d{2})-(\\d{2})T/.exec(value);
      if (!match) throw new TypeError("Invalid date");
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
      if (month >= 1 && month <= 12 && day >= 1 && day <= days && Number.isFinite(timestamp)) return timestamp;
      throw new TypeError("Invalid date");
    }
    export function isExpired(expiresAt) { return normalize(expiresAt) <= Date.now(); }
  `;
  assert.deepEqual(evidence(source, directCalendar), { sourceOk: true, testOk: true });
  const invalidGuardSource = source.replace(
    'if (month >= 1 && month <= 12 && day >= 1 && day <= days && Number.isFinite(timestamp)) return timestamp;\n      throw new TypeError("Invalid date");',
    'if (month < 1 || month > 12 || day < 1 || day > days || !Number.isFinite(timestamp)) throw new TypeError("Invalid date");\n      return timestamp;'
  );
  assert.deepEqual(evidence(invalidGuardSource, directCalendar), { sourceOk: true, testOk: true });
  const invalid = [
    source.replace("(\\d{4})", "(\\d)\\d"),
    source.replace('if (!match) throw new TypeError("Invalid date");', "if (match) {}"),
    source.replace("day <= days", "day <= 31"),
    source.replace("value instanceof Date ? value.getTime()", "enabled ? value.getTime()")
  ];
  for (const candidate of invalid) assert.equal(evidence(candidate, directCalendar).sourceOk, false, candidate);
  const invalidGuardMutations = [
    invalidGuardSource.replace("month > 12 || ", ""),
    invalidGuardSource.replace("day > days", "day > 31"),
    invalidGuardSource.replace("!Number.isFinite(timestamp)", "enabled || !Number.isFinite(timestamp)"),
    invalidGuardSource.replace('throw new TypeError("Invalid date");\n      return timestamp;', 'throw new RangeError("Invalid date");\n      return timestamp;')
  ];
  for (const candidate of invalidGuardMutations) assert.equal(evidence(candidate, directCalendar).sourceOk, false, candidate);
});

test("accepts exact dominating invalid guards and enclosing positive finite guards", () => {
  const finiteGuards = exactExpiryFixture
    .replace(
      'if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");',
      'if (!Number.isFinite(timestamp)) { throw new TypeError("Invalid date"); }'
    )
    .replace(
      "&& !Number.isNaN(timestamp)) return timestamp;",
      "&& Number.isFinite(timestamp)) { return timestamp; }"
    );
  assert.deepEqual(evidence(finiteGuards), { sourceOk: true, testOk: true });
});

test("derived timestamp returns require a branch-local dominating validity proof", () => {
  const invalidSources = [
    {
      name: "missing getTime guard",
      source: exactExpiryFixture.replace(
        'if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");\n      return timestamp;',
        "return timestamp;"
      )
    },
    {
      name: "missing Date.parse guard",
      source: exactExpiryFixture.replace(
        "&& !Number.isNaN(timestamp)) return timestamp;",
        ") return timestamp;"
      )
    },
    {
      name: "reversed polarity",
      source: exactExpiryFixture.replace(
        "if (Number.isNaN(timestamp)) throw",
        "if (!Number.isNaN(timestamp)) throw"
      )
    },
    {
      name: "wrong rejection class",
      source: exactExpiryFixture.replace(
        'if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");',
        'if (Number.isNaN(timestamp)) throw new RangeError("Invalid date");'
      )
    },
    {
      name: "constant-suppressed guard",
      source: exactExpiryFixture.replace(
        "if (Number.isNaN(timestamp)) throw",
        "if (false && Number.isNaN(timestamp)) throw"
      )
    },
    {
      name: "feature-suppressed guard",
      source: exactExpiryFixture.replace(
        "if (Number.isNaN(timestamp)) throw",
        "if (allowNumber && Number.isNaN(timestamp)) throw"
      )
    },
    {
      name: "unrelated identifier guard",
      source: exactExpiryFixture.replace(
        "Number.isNaN(timestamp)) throw",
        "Number.isNaN(other)) throw"
      )
    },
    {
      name: "guard after return",
      source: exactExpiryFixture.replace(
        'if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");\n      return timestamp;',
        'return timestamp;\n      if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");'
      )
    },
    {
      name: "nested optional guard",
      source: exactExpiryFixture.replace(
        'if (Number.isNaN(timestamp)) throw new TypeError("Invalid date");',
        'if (allowNumber) { if (Number.isNaN(timestamp)) throw new TypeError("Invalid date"); }'
      )
    },
    {
      name: "shadowed return binding",
      source: exactExpiryFixture.replace(
        "return timestamp;\n    }\n    if (allowNumber",
        "{ const timestamp = Number.NaN; return timestamp; }\n    }\n    if (allowNumber"
      )
    }
  ];

  for (const { name, source } of invalidSources) {
    assert.equal(evidence(source).sourceOk, false, name);
  }
});

test("accepts only unconditional bare, const-initializer, and return normalizer calls", () => {
  const helper = `
    function normalize(value) {
      if (typeof value === "string") return value;
      throw new TypeError("invalid");
    }
  `;
  const focusedTest = `
    import assert from "node:assert/strict";
    import { isExpired } from "../src/reliability/expiry.js";
    assert.throws(() => isExpired(null), TypeError);
  `;
  const callers = [
    "export function isExpired(expiresAt, now = Date.now()) { normalize(expiresAt); return false; }",
    "export function isExpired(expiresAt, now = Date.now()) { const timestamp = normalize(expiresAt); return timestamp; }",
    "export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }"
  ];
  for (const caller of callers) assert.deepEqual(evidence(`${helper}\n${caller}`, focusedTest), { sourceOk: true, testOk: true }, caller);
});

test("normalizer propagation fails closed for async, caught, conditional, unrelated, unstable, and wrong-error paths", () => {
  const validHelper = `function normalize(value) { if (typeof value === "string") return value; throw new TypeError("invalid"); }`;
  const invalidSources = [
    `async function normalize(value) { if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { const timestamp = normalize(expiresAt); return timestamp; }`,
    `${validHelper}\nexport async function isExpired(expiresAt, now = Date.now()) { const timestamp = normalize(expiresAt); return timestamp; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { try { return normalize(expiresAt); } catch { return false; } }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { const timestamp = expiresAt && normalize(expiresAt); return timestamp; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return expiresAt ? normalize(expiresAt) : false; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { const timestamp = normalize("fixed"); return timestamp; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { expiresAt = "fixed"; const timestamp = normalize(expiresAt); return timestamp; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { const normalize = (value) => value; return normalize(expiresAt); }`,
    `function normalize(value) { value = "fixed"; if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { value.items.push("fixed"); if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { { const value = "fixed"; if (typeof value === "string") return value; } throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (typeof value === "string") return value; throw new RangeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { const unrelated = "fixed"; if (typeof unrelated === "string") return unrelated; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { if (expiresAt) normalize(expiresAt); return false; }`,
    `function normalize(value) { if (typeof value !== "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value, allowNumber) { if (typeof allowNumber === "boolean") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt, false); }`,
    `function normalize(value) { if (typeof value === "string") return value; if (false) throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { if (enabled)\n return normalize(expiresAt); return false; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return enabled && normalize(expiresAt); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return enabled || normalize(expiresAt); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return enabled ?? normalize(expiresAt); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return enabled ? normalize(expiresAt) : false; }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return receiver?.consume(normalize(expiresAt)); }`,
    `${validHelper}\nexport function isExpired(expiresAt, now = Date.now()) { return () => normalize(expiresAt); }`,
    `function normalize(value) { if (true) return "fixed"; if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `const cached = "fixed"; function normalize(value) { if (enabled) return cached; if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (true) return arguments[0]; if (typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (typeof value === "string") return value; else return "fixed"; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (!(typeof value === "string")) return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (false === (typeof value === "string")) return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if ((typeof value === "string") === false) return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value) { if (!(Number.isFinite(value))) return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt); }`,
    `function normalize(value, allowNumber) { if (!value && typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt, false); }`,
    `function normalize(value, allowNumber) { if (value && typeof value === "string") return value; throw new TypeError("invalid"); }
      export function isExpired(expiresAt, now = Date.now()) { return normalize(expiresAt, false); }`
  ];
  for (const source of invalidSources) assert.equal(evidence(source).sourceOk, false, source);
});
