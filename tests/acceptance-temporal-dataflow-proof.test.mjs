import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { evidenceBooleanAlgebra, parseEvidenceStatements } from "../packages/piagent-core/extensions/acceptance-expression-parser.js";
import { isExpired } from "./fixtures/temporal-expiry-dataflow.js";

const source = fs.readFileSync(new URL("./fixtures/temporal-expiry-dataflow.js", import.meta.url), "utf8");
const contract = "`isExpired(expiresAt, now)` accepts an ISO timestamp string or `Date` for `expiresAt`, and a millisecond number or `Date` for `now`. Invalid dates must throw `TypeError`; do not use the machine's current time when an explicit falsey value is provided.";
const focused = `import assert from "node:assert/strict";
import { isExpired } from "./expiry.js";
for (const value of ["January 1, 2026", "2026-02-30T00:00:00.000Z", new Date(NaN)]) {
  assert.throws(() => isExpired(value, 0), TypeError);
}
for (const value of [undefined, null, false, new Date(NaN), Number.NaN, Infinity]) {
  assert.throws(() => isExpired("2026-01-01T00:00:00.000Z", value), TypeError);
}
assert.equal(isExpired(new Date(0), 0), true);
assert.equal(isExpired("2099-01-01T00:00:00.000Z"), false);`;
const evidence = (text = source, includeDiagnostics = false) => acceptanceInvalidInputEvidence({
  taskText: contract, sourceText: text, testText: focused,
  sourceEntries: [{ path: "expiry.js", text }], testEntries: [{ path: "expiry.test.js", text: focused }],
  namedTargets: ["isExpired"], provenanceTargets: ["isExpired"], includeDiagnostics
});
const mutate = (from, to) => { assert.ok(source.includes(from), `missing mutation target: ${from}`); return source.replace(from, to); };
const captureStatement = 'const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", fraction = "", zone] = match;';
const indexedCaptures = [
  "const yearText = match[1];", "const monthText = match[2];", "const dayText = match[3];",
  "const hourText = match[4];", "const minuteText = match[5];",
  'const secondText = match[6] === undefined ? "00" : match[6];',
  'const fraction = match[7] === undefined ? "" : match[7];', "const zone = match[8];"
].join("\n");
const publicStart = source.indexOf("export function isExpired");
const currentStart = source.indexOf("function currentTimestamp");
const variants = [
  ["retained string-first/destructured/manual-UTC implementation", source],
  ["indexed captures", mutate(captureStatement, indexedCaptures)],
  ["independent declaration order", mutate("const year = Number(yearText);\n      const month = Number(monthText);", "const month = Number(monthText);\n      const year = Number(yearText);")],
  ["conjunction order", mutate("month >= 1 && month <= 12 && day >= 1 && day <= validDays && hour <= 23 && minute <= 59 && second <= 59", "second <= 59 && minute <= 59 && hour <= 23 && day <= validDays && day >= 1 && month <= 12 && month >= 1")],
  ["commuted leap condition", mutate("month === 2 && leap", "leap && month === 2")],
  ["negative calendar guard", mutate("month >= 1 && month <= 12 && day >= 1 && day <= validDays && hour <= 23 && minute <= 59 && second <= 59", "!(month < 1 || month > 12 || day < 1 || day > validDays || hour > 23 || minute > 59 || second > 59)")],
  ["helper declaration order", source.slice(currentStart, publicStart) + source.slice(0, currentStart) + source.slice(publicStart)],
  ["export before hoisted helpers", source.slice(publicStart) + source.slice(0, publicStart)],
  ["inclusive comparison direction", mutate("return currentTimestamp(current) >= expiryTimestamp(expiresAt);", "return expiryTimestamp(expiresAt) <= currentTimestamp(current);")],
  ["separate public normalization", mutate("return currentTimestamp(current) >= expiryTimestamp(expiresAt);", "const end = expiryTimestamp(expiresAt);\n  const start = currentTimestamp(current);\n  return start >= end;")],
  ["equivalent nonleap/leap anchors", source.replace("Date.UTC(2001,", "Date.UTC(2100,").replace("Date.UTC(2000,", "Date.UTC(2400,")],
  ["fraction digits topology", source.replace("(\\.\\d+)?", "(?:\\.(\\d+))?").replace("fraction.slice(1)", "fraction")],
  ["calendar table", source.replace("      const daysInMonth = new Date(Date.UTC(2001, month, 0)).getUTCDate();\n", "").replace("const validDays = month === 2 && leap ? 29 : daysInMonth;", "const validDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];")],
  ["alpha-renamed bindings", ["expiryTimestamp", "currentTimestamp", "yearText", "monthText", "dayText", "hourText", "minuteText", "secondText", "validDays", "daysInMonth", "utcDate", "milliseconds", "fraction", "zone", "match"].reduce((text, name, index) => text.replace(new RegExp(`\\b${name}\\b`, "g"), `binding${index}`), source)]
];

test("temporal proof accepts dataflow-equivalent implementations without a statement template", () => {
  for (const [name, candidate] of variants) assert.deepEqual(evidence(candidate), { sourceOk: true, testOk: true }, `${name}: ${JSON.stringify(evidence(candidate, true))}`);
});

const mutations = [
  ["zone capture swapped", mutate('fraction = "", zone', 'zone = "", fraction')],
  ["numeric captures reordered", mutate("yearText, monthText, dayText", "yearText, dayText, monthText")],
  ["wrong seconds default", mutate('secondText = "00"', 'secondText = "01"')],
  ["fraction capture omitted", mutate('fraction = "", zone', "zone")],
  ["wrong year binding", mutate("Number(yearText)", "Number(monthText)")],
  ["leap-century divisor", mutate("year % 400", "year % 300")],
  ["nonleap month baseline", mutate("Date.UTC(2001, month, 0)", "Date.UTC(2000, month, 0)")],
  ["Date.UTC actual-year remapping", mutate("Date.UTC(2001, month, 0)", "Date.UTC(year, month, 0)")],
  ["wrong leap bound", mutate("? 29 : daysInMonth", "? 28 : daysInMonth")],
  ["missing month lower bound", mutate("month >= 1 && ", "")],
  ["missing month upper bound", mutate("month <= 12 && ", "")],
  ["missing day lower bound", mutate("day >= 1 && ", "")],
  ["missing day upper bound", mutate("day <= validDays && ", "")],
  ["hour overflow", mutate("hour <= 23", "hour <= 24")],
  ["minute overflow", mutate("minute <= 59", "minute <= 60")],
  ["second overflow", mutate("second <= 59", "second <= 60")],
  ["narrowed valid year domain", mutate("month >= 1 &&", "year >= 1970 && month >= 1 &&")],
  ["short millisecond pad", mutate('+ "000"', '+ "00"')],
  ["wrong fraction slice", mutate("fraction.slice(1)", "fraction.slice(2)")],
  ["wrong millisecond precision", mutate(".slice(0, 3)", ".slice(0, 2)")],
  ["nonleap UTC anchor", mutate("Date.UTC(2000, month - 1", "Date.UTC(2001, month - 1")],
  ["actual year as UTC anchor", mutate("Date.UTC(2000, month - 1", "Date.UTC(year, month - 1")],
  ["missing proleptic year correction", mutate("        utcDate.setUTCFullYear(year);\n", "")],
  ["wrong corrected year", mutate("setUTCFullYear(year)", "setUTCFullYear(month)")],
  ["missing timezone bound", mutate('zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)', "true")],
  ["offset hour overflow", mutate("Number(zone.slice(1, 3)) <= 23", "Number(zone.slice(1, 3)) <= 24")],
  ["offset minute overflow", mutate("Number(zone.slice(4)) <= 59", "Number(zone.slice(4)) <= 60")],
  ["offset minute slice", mutate("Number(zone.slice(4));", "Number(zone.slice(3));")],
  ["offset hour conversion", mutate("* 60 + Number", "* 600 + Number")],
  ["offset sign", mutate('zone.startsWith("+")', 'zone.startsWith("-")')],
  ["offset multiplier", mutate("* 60000;", "* 6000;")],
  ["offset direction", mutate("utcDate.getTime() -", "utcDate.getTime() +")],
  ["expiry Date finite guard", mutate("if (!Number.isNaN(timestamp)) return timestamp;", "return timestamp;")],
  ["now Date finite guard", mutate("value instanceof Date && !Number.isNaN(value.getTime())", "value instanceof Date")],
  ["now number finite guard", mutate('typeof value === "number" && Number.isFinite(value)', 'typeof value === "number"')],
  ["wrong TypeError class", source.replaceAll("new TypeError", "new RangeError")],
  ["dynamic error message", mutate('new TypeError("now must be a finite millisecond number or Date")', "new TypeError(message())")],
  ["truthy now fallback", mutate("arguments.length < 2 ? Date.now() : now", "now || Date.now()")],
  ["wrong omission threshold", mutate("arguments.length < 2", "arguments.length < 3")],
  ["eager clock", mutate("const current = arguments.length", "const clock = Date.now();\n  const current = arguments.length")],
  ["eager explicit-now normalization", mutate("const current = arguments.length", "const normalized = currentTimestamp(now);\n  const current = arguments.length")],
  ["shadowed helper binding", mutate("const current = arguments.length", "const currentTimestamp = 0;\n  const current = arguments.length")],
  ["shadowed helper parameter", mutate("isExpired(expiresAt, now)", "isExpired(expiresAt, currentTimestamp)")],
  ["wrong helper argument", mutate("expiryTimestamp(expiresAt);", "expiryTimestamp(now);")],
  ["exclusive comparison", mutate("currentTimestamp(current) >=", "currentTimestamp(current) >")],
  ["extra top-level effect", `Date.prototype.getTime = () => 0;\n${source}`],
  ["extra top-level declaration", `const unrelated = 1;\n${source}`],
  ["module helper reassignment", `${source}\ncurrentTimestamp = () => 0;`],
  ["input mutation", mutate("const timestamp = value.getTime();", "value.setTime(0);\n    const timestamp = value.getTime();")],
  ["unreachable unknown effect", mutate("return currentTimestamp(current) >= expiryTimestamp(expiresAt);", "return currentTimestamp(current) >= expiryTimestamp(expiresAt);\n  audit();")],
  ["unanchored regex", mutate("/^(\\d{4})", "/(\\d{4})")],
  ["regex flags", mutate("\\d{2})$/.exec", "\\d{2})$/m.exec")],
  ["reserved sentinel injection", mutate('zone.startsWith("+")', "zone.startsWith(__pi_positive_sign_string_literal__)")],
  ["split return keyword", mutate("return currentTimestamp(current)", "ret/*x*/urn currentTimestamp(current)")],
  ["return ASI", mutate("return currentTimestamp(current)", "return\ncurrentTimestamp(current)")]
];

test("temporal dataflow mutation matrix rejects every broken invariant and module poison", () => {
  for (const [name, candidate] of mutations) {
    assert.notEqual(candidate, source, name);
    assert.equal(evidence(candidate).sourceOk, false, name);
  }
});

test("source diagnostics identify the failed invariant without changing legacy evidence shape", () => {
  assert.deepEqual(evidence(source, true), { sourceOk: true, testOk: true, sourceReasons: [] });
  assert.deepEqual(evidence(mutate("        utcDate.setUTCFullYear(year);\n", ""), true).sourceReasons, ["proleptic-year-unproven"]);
  assert.deepEqual(evidence(mutate("day <= validDays && ", ""), true).sourceReasons, ["calendar-or-zone-validation-unproven"]);
  assert.deepEqual(evidence(mutate("const current = arguments.length", "const clock = Date.now();\n  const current = arguments.length"), true).sourceReasons, ["eager-clock-fallback-unproven"]);
});

async function implementation(text) {
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).isExpired;
}

test("accepted variants independently execute ISO shape, offset, year and explicit-now contracts", async () => {
  const instants = [
    "0000-02-29T00:00Z", "0099-12-31T23:59:59.999Z", "0100-03-01T00:00:00Z",
    "2000-02-29T23:59:59.999+07:00", "2026-01-01T00:00:00.1-03:30",
    "2026-01-01T00:00:00.123456Z", "9999-12-31T23:59:59.999-23:59"
  ];
  for (const [name, candidate] of variants) {
    const fn = await implementation(candidate);
    for (const iso of instants) {
      const expected = Date.parse(iso);
      assert.ok(Number.isFinite(expected), iso);
      assert.equal(fn(iso, expected), true, `${name}: ${iso}`);
      assert.equal(fn(iso, expected - 1), false, `${name}: ${iso}`);
    }
    for (const value of [undefined, null, false, "", NaN, Infinity, -Infinity, new Date(NaN)]) assert.throws(() => fn(instants[0], value), TypeError, name);
    for (const value of [undefined, null, false, 0, "", NaN, Infinity, "1900-02-29T00:00Z", "2026-01-01T24:00Z", "2026-01-01T00:00+24:00"]) assert.throws(() => fn(value, 0), TypeError, name);
    const expiry = new Date(0), now = new Date(0);
    assert.equal(fn(expiry, now), true, name);
    assert.equal(expiry.getTime(), 0); assert.equal(now.getTime(), 0);
    const saved = Date.now; let calls = 0;
    try {
      Date.now = () => { calls += 1; return 0; };
      assert.equal(fn(expiry), true); assert.equal(calls, 1);
      assert.throws(() => fn(expiry, undefined), TypeError); assert.equal(calls, 1);
      assert.equal(fn(expiry, 0), true); assert.equal(calls, 1);
    } finally { Date.now = saved; }
  }
});

test("retained implementation covers every year/month calendar boundary from 0000 through 9999", () => {
  for (let year = 0; year <= 9999; year += 1) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month += 1) {
      const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;
      const iso = `${prefix}${days[month - 1]}T00:00:00.999Z`;
      const expected = new Date(0); expected.setUTCFullYear(year, month - 1, days[month - 1]); expected.setUTCHours(0, 0, 0, 999);
      assert.equal(isExpired(iso, expected.getTime()), true, iso);
      assert.equal(isExpired(iso, expected.getTime() - 1), false, iso);
      assert.throws(() => isExpired(`${prefix}${days[month - 1] + 1}T00:00Z`, 0), TypeError);
    }
  }
});

test("bounded parser and Boolean algebra fail closed and compare equivalent path formulae", () => {
  for (const syntax of ["while (true) {}", "const x = 0; x = 1;", "return import(x);", "const x = `raw`;", "return " + "!".repeat(70) + "x;"]) assert.throws(() => parseEvidenceStatements(syntax));
  const b = evidenceBooleanAlgebra(), x = b.atom("x"), y = b.atom("y"), z = b.atom("z");
  assert.equal(b.or(b.and(x, y), b.and(x, z)), b.and(x, b.or(y, z)));
  assert.equal(b.not(b.and(x, y)), b.or(b.not(x), b.not(y)));
  assert.equal(b.implies(b.and(x, y), x), true);
  assert.equal(b.implies(x, b.and(x, y)), false);
});
