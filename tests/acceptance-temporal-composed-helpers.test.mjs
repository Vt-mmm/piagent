import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceptanceContractProofGuidance, acceptanceInvalidInputEvidence, sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { temporalProofReasonGuidance } from "../packages/piagent-core/extensions/acceptance-boundary-guidance.js";

const source = fs.readFileSync(new URL("./fixtures/temporal-composed-helpers.js", import.meta.url), "utf8");
const contract = "`isExpired(expiresAt, now)` accepts an ISO timestamp string or `Date` for `expiresAt`, and a millisecond number or `Date` for `now`. Invalid dates must throw `TypeError`; do not use the machine's current time when an explicit falsey value is provided.";
const focused = `import assert from "node:assert/strict";
import { isExpired } from "./expiry.js";
for (const value of ["January 1, 2026", "2026-02-30T00:00:00.000Z", new Date(NaN)]) assert.throws(() => isExpired(value, 0), TypeError);
for (const value of [undefined, null, false, new Date(NaN), Number.NaN, Infinity]) assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", value), TypeError);
assert.equal(isExpired(new Date(0), 0), true);
assert.equal(isExpired("2099-01-01T00:00:00.000Z"), false);`;
const evidence = (text = source, tests = focused) => acceptanceInvalidInputEvidence({
  taskText: contract, sourceText: text, testText: tests,
  sourceEntries: [{ path: "expiry.js", text }], testEntries: [{ path: "expiry.test.js", text: tests }],
  namedTargets: ["isExpired"], provenanceTargets: ["isExpired"], includeDiagnostics: true
});
const replace = (from, to) => { assert.ok(source.includes(from), from); return source.replace(from, to); };
const rejectBody = 'throw new TypeError("Invalid timestamp");';
const variants = [
  ["split parser and shared abrupt rejection", source],
  ["function names are not roles", ["rejectInvalid", "parseTimestamp", "expiration", "current"].reduce((text, name, index) => text.replaceAll(new RegExp(`\\b${name}\\b`, "g"), `helper${index}`), source)],
  ["declaration order", source.slice(source.indexOf("export function")) + source.slice(0, source.indexOf("export function"))],
  ["parser wrapper", source.replace("function parseTimestamp(value)", "function parseInner(value)").replace("function expiration(value)", "function parseTimestamp(value) { return parseInner(value); }\nfunction expiration(value)")],
  ["rejection wrapper", replace(rejectBody, "return rejectLeaf(value);") + '\nfunction rejectLeaf(value) { throw new TypeError("Invalid timestamp"); }\n'],
  ["statement abrupt rejection", source.replaceAll("return rejectInvalid(value);", "rejectInvalid(value);")],
  ["equivalent negative sign", replace('(zone[0] === "+" ? 1 : -1)', '(zone[0] === "-" ? -1 : 1)')],
  ["expanded error branches", replace("if (!match) return rejectInvalid(value);", "if (!match) { return rejectInvalid(value); }")]
];

test("closed acyclic helper composition proves equivalent temporal implementations", () => {
  for (const [name, text] of variants) assert.deepEqual(evidence(text), { sourceOk: true, testOk: true, sourceReasons: [] }, name);
});

async function implementation(text) {
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).isExpired;
}

test("proved helpers preserve precision, signed offsets, proleptic dates and invalid partitions", async () => {
  const valid = ["0000-02-29T00:00Z", "0099-12-31T23:59:59.999Z", "1900-02-28T00:00:00Z", "2000-02-29T23:59:59.1+07:00", "2026-01-01T00:00:00.123-03:30", "2026-01-01T00:00:00.123-00:30", "2026-01-01T00:00:00.999999999999999999Z"];
  for (const [name, text] of variants) {
    const fn = await implementation(text);
    for (const iso of valid) {
      const time = Date.parse(iso);
      assert.ok(Number.isFinite(time), iso);
      assert.equal(fn(iso, time - 1), false, `${name}: ${iso}`);
      assert.equal(fn(iso, time), true, `${name}: ${iso}`);
      assert.equal(fn(iso, time + 1), true, `${name}: ${iso}`);
    }
    for (const value of ["1900-02-29T00:00Z", "2026-02-30T00:00Z", "2026-00-01T00:00Z", "2026-13-01T00:00Z", "2026-01-01T24:00Z", "2026-01-01T00:00-24:00", "January 1, 2026", new Date(NaN)]) assert.throws(() => fn(value, 0), TypeError, name);
    const before = Date.now; let calls = 0;
    try {
      Date.now = () => { calls += 1; return 0; };
      assert.throws(() => fn(), TypeError, name); assert.equal(calls, 0, name);
      assert.equal(fn(new Date(0)), true, name); assert.equal(calls, 1, name);
      for (const value of [undefined, null, false, NaN, Infinity]) assert.throws(() => fn(new Date(0), value), TypeError, name);
      assert.equal(calls, 1, name);
      const expiry = new Date(0), now = new Date(0);
      assert.equal(fn(expiry, now), true, name);
      assert.equal(expiry.getTime(), 0, name); assert.equal(now.getTime(), 0, name);
    } finally { Date.now = before; }
  }
});

test("split parser executes every year and month end in the four-digit calendar domain", async () => {
  const fn = await implementation(source);
  for (let year = 0; year <= 9999; year += 1) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month += 1) {
      const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;
      const iso = `${prefix}${days[month - 1]}T00:00:00.999Z`;
      const expected = new Date(0);
      expected.setUTCFullYear(year, month - 1, days[month - 1]); expected.setUTCHours(0, 0, 0, 999);
      assert.equal(fn(iso, expected.getTime()), true, iso);
      assert.equal(fn(iso, expected.getTime() - 1), false, iso);
      assert.throws(() => fn(`${prefix}${days[month - 1] + 1}T00:00Z`, 0), TypeError);
    }
  }
});

const mutants = [
  ["reject helper returns a value", replace(rejectBody, "return 0;")],
  ["reject helper falls through", replace(rejectBody, "")],
  ["reject helper wrong error class", replace("new TypeError", "new RangeError")],
  ["reject helper conditional success", replace(rejectBody, 'if (value === undefined) return 0;\n  throw new TypeError("Invalid timestamp");')],
  ["reject helper extra effect", replace(rejectBody, 'audit(value);\n  throw new TypeError("Invalid timestamp");')],
  ["recursive helper", replace(rejectBody, "return rejectInvalid(value);")],
  ["indirect helper cycle", replace(rejectBody, "return rejectionCycle(value);") + "\nfunction rejectionCycle(value) { return rejectInvalid(value); }\n"],
  ["helper aliases are not resolved by name", replace("if (!match) return rejectInvalid(value);", "const reject = rejectInvalid;\n  if (!match) return reject(value);")],
  ["wrong parser argument", replace("return parseTimestamp(value);", "return parseTimestamp(0);")],
  ["unguarded parser call", replace('if (typeof value === "string") return parseTimestamp(value);', "return parseTimestamp(value);")],
  ["wrong public argument", replace("expiration(expiresAt)", "expiration(now)")],
  ["borrowed input mutation", replace("if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();", "if (value instanceof Date) { value.setTime(0); return value.getTime(); }")],
  ["missing date finite guard", replace("value instanceof Date && !Number.isNaN(value.getTime())", "value instanceof Date")],
  ["missing calendar upper bound", replace("day > days[month - 1] || ", "")],
  ["wrong leap divisor", replace("year % 400", "year % 300")],
  ["wrong UTC anchor", replace("Date.UTC(2000,", "Date.UTC(year,")],
  ["wrong proleptic correction", replace("date.setUTCFullYear(year);", "date.setUTCFullYear(month);")],
  ["wrong timezone sign", replace('(zone[0] === "+" ? 1 : -1)', "1")],
  ["wrong timezone scale", replace("* 60000)", "* 6000)")],
  ["wrong millisecond truncation", replace("slice(0, 3)", "slice(0, 2)")],
  ["wrong fraction padding", replace('padEnd(3, "0")', 'padEnd(3, "1")')],
  ["wrong missing fraction", replace("fractionText === undefined ? 0", "fractionText === undefined ? 1")],
  ["helper arguments are not public arity", replace(rejectBody, 'if (arguments.length === 0) throw new TypeError("Invalid timestamp");\n  return 0;')],
  ["unreachable extra helper", source + '\nfunction unused(value) { throw new TypeError("unused"); }\n'],
  ["dead ternary edge does not make a helper reachable", replace("return time >= expiration(expiresAt);", "return true ? time >= expiration(expiresAt) : unused(now);") + "\nfunction unused(value) { audit(value); return 0; }\n"],
  ["dead logical edge does not make a helper reachable", replace("return time >= expiration(expiresAt);", "return time >= expiration(expiresAt) || false && unused(now);") + "\nfunction unused(value) { audit(value); return 0; }\n"],
  ["unreachable effect after abrupt call", replace("if (!match) return rejectInvalid(value);", "if (!match) { rejectInvalid(value); audit(value); }")],
  ["captured caller local is not helper scope", replace("const year = Number(yearText);", "const year = Number(expiresAt);")],
  ["helper default parameter", replace("function parseTimestamp(value)", 'function parseTimestamp(value = "")')],
  ["async helper", replace("function parseTimestamp(value)", "async function parseTimestamp(value)")],
  ["helper intrinsic shadow", replace("function rejectInvalid(value)", "function rejectInvalid(TypeError)")]
];

test("composition abstains on wrong returns, open call graphs, effects and temporal mutants", () => {
  for (const [name, text] of mutants) assert.equal(evidence(text).sourceOk, false, name);
});

test("dynamic error-message coercion is a concrete wrong-class defect, not merely unknown proof", async () => {
  const unsafe = replace(rejectBody, 'throw new TypeError(`Invalid timestamp: ${String(value)}`);');
  const rejected = evidence(unsafe);
  assert.equal(rejected.sourceOk, false); assert.equal(rejected.testOk, true);
  assert.ok(rejected.sourceReasons.some((reason) => ["typeerror-rejection-unproven", "rejection-message-effect-unproven"].includes(reason)));
  for (const [text, error, expectedCoercions] of [[unsafe, RangeError, 1], [source, TypeError, 0]]) {
    const fn = await implementation(text);
    for (const key of ["toString", Symbol.toPrimitive]) {
      for (const position of [0, 1]) {
        let coercions = 0;
        const invalidDate = new Date(NaN);
        Object.defineProperty(invalidDate, key, {
          configurable: true, value: () => { coercions += 1; throw new RangeError("coercion executed"); }
        });
        assert.ok(Number.isNaN(Date.prototype.getTime.call(invalidDate)));
        assert.throws(() => position === 0 ? fn(invalidDate, 0) : fn("1970-01-01T00:00Z", invalidDate), error);
        assert.equal(coercions, expectedCoercions);
      }
    }
  }
});

test("helper source proof still requires separately bound executable rejection tests", () => {
  for (const tests of [focused.replaceAll("assert.throws", "assert.equal"), focused.replace('from "./expiry.js"', 'from "./other.js"'), focused.replace("[undefined, null, false, new Date(NaN), Number.NaN, Infinity]", "[null, false, new Date(NaN), Number.NaN, Infinity]")]) assert.equal(evidence(source, tests).testOk, false);
});

test("padding marker is distinct and reason-specific recovery does not claim a proven defect", () => {
  assert.equal(sanitizeJavaScriptEvidence('"0"'), "__pi_zero_string_literal__");
  assert.notEqual(sanitizeJavaScriptEvidence('"1"'), "__pi_zero_string_literal__");
  assert.notEqual(sanitizeJavaScriptEvidence('`0`'), "__pi_zero_string_literal__");
  const hints = temporalProofReasonGuidance(["typeerror-rejection-unproven"]);
  assert.equal(hints.length, 1); assert.ok(hints[0].length <= 300);
  assert.match(hints[0], /invalid Date.*toString.*Symbol\.toPrimitive.*RangeError/);
  assert.match(hints[0], /repair only after reproducing/);
  assert.deepEqual(temporalProofReasonGuidance(["closed-temporal-module-unproven"]), []);
  const initial = acceptanceContractProofGuidance(contract);
  assert.equal(initial.length, 5);
  assert.ok(initial.every((hint) => hint.length <= 300));
  assert.ok(initial.some((hint) => /invalid Date objects with throwing toString\/Symbol\.toPrimitive/.test(hint)));
});
