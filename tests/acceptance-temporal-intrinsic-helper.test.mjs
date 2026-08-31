import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

// Generic public source inputs; no campaign state, oracle or provider is used.
const source = fs.readFileSync(new URL("./fixtures/temporal-intrinsic-helper.js", import.meta.url), "utf8");
const contract = "`deadlinePassed(deadline, currentTime)` accepts an ISO timestamp string or `Date` for `deadline`, and a millisecond number or `Date` for `currentTime`. Invalid dates must throw `TypeError`; do not use the machine's current time when an explicit falsey value is provided.";
const focused = `import assert from "node:assert/strict";
import { deadlinePassed } from "./deadline.js";
for (const value of ["January 1, 2026", "2026-02-30T00:00:00Z", new Date(NaN)]) assert.throws(() => deadlinePassed(value, 0), TypeError);
for (const value of [undefined, null, false, new Date(NaN), Number.NaN, Infinity]) assert.throws(() => deadlinePassed("2026-01-01T00:00:00Z", value), TypeError);
assert.equal(deadlinePassed(new Date(0), 0), true);
assert.equal(deadlinePassed("9999-01-01T00:00:00Z"), false);`;
const evidence = (text = source, tests = focused) => acceptanceInvalidInputEvidence({
  taskText: contract, sourceText: text, testText: tests,
  sourceEntries: [{ path: "deadline.js", text }], testEntries: [{ path: "deadline.test.js", text: tests }],
  namedTargets: ["deadlinePassed"], provenanceTargets: ["deadlinePassed"], includeDiagnostics: true
});
const replace = (from, to) => {
  assert.ok(source.includes(from), `Mutation must match: ${from}`);
  const result = source.replace(from, to);
  assert.notEqual(result, source);
  return result;
};
const offsetSign = '(zone[0] === "+" ? 1 : -1)';
const wrappedTime = "new Date(date.getTime() - offsetMinutes * 60_000)";
const variants = [
  ["intrinsic Date reader and nullish optional captures", source],
  ["alpha-renamed helpers", ["readInstant", "parseDeadline", "deadlineValue", "referenceValue"].reduce((text, name, index) => text.replaceAll(new RegExp(`\\b${name}\\b`, "g"), `stage${index}`), source)],
  ["hoisted declarations in a different order", source.slice(source.indexOf("export function")) + source.slice(0, source.indexOf("export function"))],
  ["read-only Date view forwarded through another helper", replace("function readInstant(value) {", "function readInstant(value) { return inspectInstant(value); }\n\nfunction inspectInstant(value) {")],
  ["equivalent negative sign branch", replace(offsetSign, '(zone[0] === "-" ? -1 : 1)')],
  ["equivalent integral scale spelling", replace("offsetMinutes * 60_000", "60000 * offsetMinutes")],
  ["named owned Date passed read-only to helper", replace(`return readInstant(${wrappedTime});`, `const adjusted = ${wrappedTime};\n  return readInstant(adjusted);`)],
  ["intrinsic reader for the owned Date as well", replace("new Date(date.getTime() -", "new Date(Date.prototype.getTime.call(date) -")],
  ["read-only alias of the owned calendar", replace(`return readInstant(${wrappedTime});`, "const alias = date;\n  return readInstant(new Date(alias.getTime() - offsetMinutes * 60_000));")]
];

async function implementation(text) {
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).deadlinePassed;
}

// Date.UTC supplies independent epochs. A full Gregorian 400-year cycle avoids
// its special handling of years 0..99 without reusing the candidate's setters.
function utc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const shift = year >= 0 && year <= 99;
  return Date.UTC(year + (shift ? 400 : 0), month - 1, day, hour, minute, second, millisecond)
    - (shift ? 146097 * 86_400_000 : 0);
}
const valid = [
  ["2026-01-01T00:00Z", utc(2026, 1, 1)],
  ["2026-01-01T00:00:00Z", utc(2026, 1, 1)],
  ["2026-01-01T00:00:00.9Z", utc(2026, 1, 1, 0, 0, 0, 900)],
  ["2026-01-01T00:00:00.99Z", utc(2026, 1, 1, 0, 0, 0, 990)],
  ["2026-01-01T00:00:00.999999999999999999Z", utc(2026, 1, 1, 0, 0, 0, 999)],
  ["2026-01-01T00:00:00-00:30", utc(2026, 1, 1, 0, 30)],
  ["2026-01-01T00:00:00-07:00", utc(2026, 1, 1, 7)],
  ["2026-01-01T00:00:00+07:00", utc(2025, 12, 31, 17)],
  ["2026-01-01T00:00:00.123-03:30", utc(2026, 1, 1, 3, 30, 0, 123)],
  ["0000-02-29T00:00Z", utc(0, 2, 29)],
  ["0096-02-29T00:00+07:00", utc(96, 2, 28, 17)],
  ["0099-12-31T23:59:59.999Z", utc(99, 12, 31, 23, 59, 59, 999)],
  ["1900-02-28T00:00Z", utc(1900, 2, 28)],
  ["2000-02-29T00:00Z", utc(2000, 2, 29)],
  ["1969-12-31T23:59:59.999Z", -1],
  ["0000-01-01T00:00+23:59", utc(0, 1, 1) - (23 * 60 + 59) * 60_000],
  ["9999-12-31T23:59:59.999-23:59", utc(9999, 12, 31, 23, 59, 59, 999) + (23 * 60 + 59) * 60_000]
];

test("closed intrinsic helpers and equivalent owned-Date forms receive source proof", () => {
  for (const [name, text] of variants) assert.deepEqual(evidence(text), { sourceOk: true, testOk: true, sourceReasons: [] }, name);
});

test("intrinsic helper variants execute independent UTC boundaries, early years and fractions", async () => {
  for (const [name, text] of variants) {
    const fn = await implementation(text);
    for (const [iso, epoch] of valid) {
      assert.ok(Number.isSafeInteger(epoch), iso);
      for (const delta of [-1, 0, 1]) assert.equal(fn(iso, epoch + delta), delta >= 0, `${name}: ${iso} delta ${delta}`);
    }
    for (const value of ["January 1, 2026", "0099-02-29T00:00Z", "1900-02-29T00:00Z", "2026-02-30T00:00Z", "2026-04-31T00:00Z", "2026-00-01T00:00Z", "2026-13-01T00:00Z", "2026-01-00T00:00Z", "2026-01-32T00:00Z", "2026-01-01T24:00Z", "2026-01-01T00:60Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00-24:00", "2026-01-01T00:00+07:60", new Date(NaN)]) assert.throws(() => fn(value, 0), TypeError, name);
    for (const value of [undefined, null, false, "", NaN, Infinity, -Infinity, new Date(NaN)]) assert.throws(() => fn("1970-01-01T00:00Z", value), TypeError, name);
    const before = Date.now; let calls = 0;
    try {
      Date.now = () => { calls += 1; return 0; };
      assert.throws(() => fn(), TypeError, name);
      assert.throws(() => fn("invalid"), TypeError, name);
      assert.equal(calls, 0, name);
      assert.equal(fn(new Date(0)), true, name);
      assert.equal(calls, 1, name);
      assert.throws(() => fn(new Date(0), undefined), TypeError, name);
      assert.equal(fn(new Date(0), 0), true, name);
      assert.equal(calls, 1, name);
    } finally { Date.now = before; }
  }
});

test("intrinsic Date reads bypass per-object hooks and preserve valid and invalid Date inputs", async () => {
  for (const [name, text] of variants) {
    const fn = await implementation(text);
    for (const invalid of [false, true]) for (const position of [0, 1]) {
      let calls = 0;
      const value = new Date(invalid ? NaN : 0);
      for (const key of ["getTime", "toString", Symbol.toPrimitive]) Object.defineProperty(value, key, {
        configurable: true, value: () => { calls += 1; throw new RangeError("input hook executed"); }
      });
      const invoke = () => position === 0 ? fn(value, 0) : fn("1970-01-01T00:00Z", value);
      if (invalid) assert.throws(invoke, TypeError, name);
      else assert.equal(invoke(), true, name);
      assert.equal(calls, 0, name);
      assert.equal(Date.prototype.getTime.call(value), invalid ? NaN : 0, name);
    }
  }
});

const mutants = [
  ["unsigned offset", replace(offsetSign, "1")],
  ["reversed offset sign", replace(offsetSign, '(zone[0] === "+" ? -1 : 1)')],
  ["incorrect offset scale", replace("offsetMinutes * 60_000", "offsetMinutes * 6000")],
  ["incorrect minute contribution", replace("offsetHour * 60 + offsetMinute", "offsetHour * 60 - offsetMinute")],
  ["borrowed Date mutation inside helper", replace("const timestamp = Date.prototype.getTime.call(value);", "value.setTime(0);\n  const timestamp = Date.prototype.getTime.call(value);")],
  ["escaped Date helper argument", replace("const timestamp = Date.prototype.getTime.call(value);", "inspect(value);\n  const timestamp = Date.prototype.getTime.call(value);")],
  ["escaped owned Date", replace("date.setUTCFullYear", "inspect(date);\n  date.setUTCFullYear")],
  ["unmodeled intrinsic call", replace("Date.prototype.getTime.call(value)", "Number.prototype.valueOf.call(value)")],
  ["unmodeled getter alias", replace("const timestamp = Date.prototype.getTime.call(value);", "const getter = Date.prototype.getTime;\n  const timestamp = getter.call(value);")],
  ["unmodeled apply invocation", replace("Date.prototype.getTime.call(value)", "Date.prototype.getTime.apply(value, [])")],
  ["wrong intrinsic receiver", replace("Date.prototype.getTime.call(value)", "Date.prototype.getTime.call(0)")],
  ["unknown call with extra argument", replace("Date.prototype.getTime.call(value)", "Date.prototype.getTime.call(value, inspect(value))")],
  ["effectful nullish seconds fallback", replace("match[6] ?? 0", "match[6] ?? Date.now()")],
  ["effectful nullish fraction fallback", replace('match[7] ?? ""', 'match[7] ?? inspect(value)')],
  ["non-integral TimeClip is not identity", replace(wrappedTime, "new Date(date.getTime() - offsetMinutes * 60_000 + 0.5)")],
  ["integral literals can still produce fractional TimeClip", replace(wrappedTime, "new Date(date.getTime() - offsetMinutes * 60_000 + 1 / 2)")],
  ["out-of-range TimeClip is not identity", replace(wrappedTime, "new Date(date.getTime() - offsetMinutes * 60_000 + 8_640_000_000_000_001)")],
  ["unbounded constructor timestamp", replace(wrappedTime, "new Date(date.getTime() - offsetMinutes * 60_000 + Number(value))")],
  ["invalid intrinsic result accepted", replace('if (!Number.isFinite(timestamp)) throw new TypeError("Invalid timestamp");', "")],
  ["helper returns input instead of milliseconds", replace("return timestamp;", "return value;")],
  ["helper returns reboxed Date instead of milliseconds", replace("return timestamp;", "return new Date(timestamp);")],
  ["reboxing a read-only helper view does not authorize a setter", replace("const timestamp = Date.prototype.getTime.call(value);", "const boxed = new Date(Date.prototype.getTime.call(value));\n  boxed.setUTCFullYear(2000, 0, 1);\n  const timestamp = Date.prototype.getTime.call(boxed);")],
  // These inputs are inspected only, never executed: intrinsic admission must
  // not accept a module that replaces the very primitive used as its proof.
  ["Date getter intrinsic overwritten", "Date.prototype.getTime = () => 0;\n" + source],
  ["finite predicate intrinsic overwritten", "Number.isFinite = () => true;\n" + source],
  ["wrong calendar setter", replace("setUTCFullYear(year,", "setUTCFullYear(month,")],
  ["missing calendar day roundtrip", replace("\n    || date.getUTCDate() !== day", "")],
  ["wrong optional capture", replace("match[6] ?? 0", "match[7] ?? 0")],
  ["wrong nullish seconds default", replace("match[6] ?? 0", "match[6] ?? 1")],
  ["wrong fraction truncation", replace("slice(0, 3)", "slice(0, 2)")],
  ["wrong public omission behavior", replace("arguments.length === 1", "arguments.length < 3")]
];

test("intrinsic-helper proof abstains on unsigned arithmetic, effects, alias calls and unproved TimeClip", () => {
  for (const [name, text] of mutants) assert.equal(evidence(text).sourceOk, false, name);
});

test("offset and TimeClip abstention preserve their actionable bounded reason", () => {
  for (const [name, reason] of [
    ["unsigned offset", "iso-offset-arithmetic-unproven"],
    ["integral literals can still produce fractional TimeClip", "date-timeclip-unproven"],
    ["out-of-range TimeClip is not identity", "date-timeclip-unproven"]
  ]) {
    const result = evidence(mutants.find(([label]) => label === name)[1]);
    assert.equal(result.sourceOk, false, name);
    assert.ok(result.sourceReasons.includes(reason), `${name}: ${JSON.stringify(result)}`);
  }
});

test("unsigned offsets and fractional or out-of-range TimeClip have concrete runtime counterexamples", async () => {
  const unsigned = await implementation(mutants.find(([name]) => name === "unsigned offset")[1]);
  for (const [iso, epoch] of valid.filter(([iso]) => /-(?:00:30|07:00)$/.test(iso))) {
    assert.equal(unsigned(iso, epoch - 1), true, `${iso} expires prematurely`);
    assert.equal((await implementation(source))(iso, epoch - 1), false, iso);
  }
  const positiveOffset = valid.find(([iso]) => iso.endsWith("+07:00"));
  assert.equal(unsigned(positiveOffset[0], positiveOffset[1] - 1), false, "positive offsets alone do not expose unsigned arithmetic");
  for (const label of ["non-integral TimeClip is not identity", "integral literals can still produce fractional TimeClip"]) {
    const fractional = await implementation(mutants.find(([name]) => name === label)[1]);
    assert.equal(fractional("1969-12-31T23:59:59.999Z", -1), false, `${label}: TimeClip truncates -0.5 to zero and changes inclusive expiry`);
  }
  const outOfRange = await implementation(mutants.find(([name]) => name === "out-of-range TimeClip is not identity")[1]);
  assert.throws(() => outOfRange("2026-01-01T00:00Z", utc(2026, 1, 1)), TypeError, "a valid ISO timestamp becomes invalid after TimeClip overflow");
});

test("safe source proof does not replace live imported rejection evidence", () => {
  for (const tests of [focused.replaceAll("assert.throws", "assert.equal"), focused.replace('from "./deadline.js"', 'from "./unrelated.js"'), focused.replace("[undefined, null, false, new Date(NaN), Number.NaN, Infinity]", "[null, false, new Date(NaN), Number.NaN, Infinity]")]) {
    assert.equal(evidence(source, tests).testOk, false);
  }
});
