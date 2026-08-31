import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

// Public, generic fixtures: no campaign paths, generated artifacts, or oracle.
const source = fs.readFileSync(new URL("./fixtures/temporal-owned-date.js", import.meta.url), "utf8");
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
const variants = [
  ["owned UTC setters and calendar roundtrip", source],
  ["owned alias shares the same abstract allocation", replace("date.setUTCFullYear", "const alias = date;\n  alias.setUTCFullYear")],
  ["negative sign branch", replace('(zone[0] === "+" ? offset : -offset)', '(zone[0] === "-" ? -offset : offset)')],
  ["negative startsWith branch", replace('(zone[0] === "+" ? offset : -offset)', '(zone.startsWith("-") ? -offset : offset)')],
  ["explicit sign multiplication", replace('(zone[0] === "+" ? offset : -offset) * 60_000', '60_000 * offset * (zone[0] === "+" ? 1 : -1)')],
  ["affine offset arithmetic", replace('date.getTime() - (zone[0] === "+" ? offset : -offset) * 60_000', 'date.getTime() + (zone[0] === "-" ? offset : -offset) * 60000')],
  ["separate calendar rejection guards", replace('if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new TypeError("Invalid date");', 'if (date.getUTCDate() !== day) throw new TypeError("Invalid date");\n  if (date.getUTCMonth() !== month - 1) throw new TypeError("Invalid date");\n  if (date.getUTCFullYear() !== year) throw new TypeError("Invalid date");')],
  ["omission less-than form", replace("arguments.length === 1", "arguments.length < 2")],
  ["integer milliseconds without truncation", replace("Math.trunc(milliseconds)", "milliseconds")]
];

test("owned Date semantics prove equivalent state transitions and sign-aware arithmetic", () => {
  for (const [name, text] of variants) assert.deepEqual(evidence(text), { sourceOk: true, testOk: true, sourceReasons: [] }, name);
});

async function implementation(text) {
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).isExpired;
}

test("proved owned Date variants execute both offset signs, zero-hour offset, calendar and omission boundaries", async () => {
  const valid = ["0000-02-29T00:00Z", "0099-12-31T23:59:59.999Z", "2000-02-29T23:59:59.999+07:00", "2026-01-01T00:00:00.123-07:00", "2026-01-01T00:00:00.123-03:30", "2026-01-01T00:00:00.123-00:30", "2026-01-01T00:00:00.999999999999999999Z"];
  for (const [name, text] of variants) {
    const fn = await implementation(text);
    for (const iso of valid) {
      const timestamp = Date.parse(iso);
      assert.ok(Number.isFinite(timestamp), iso);
      assert.equal(fn(iso, timestamp - 1), false, `${name}: ${iso}`);
      assert.equal(fn(iso, timestamp), true, `${name}: ${iso}`);
      assert.equal(fn(iso, timestamp + 1), true, `${name}: ${iso}`);
    }
    for (const value of ["1900-02-29T00:00Z", "2026-02-30T00:00Z", "2026-13-01T00:00Z", "2026-01-01T24:00Z", "2026-01-01T00:00-24:00", new Date(NaN)]) assert.throws(() => fn(value, 0), TypeError, name);
    const before = Date.now; let calls = 0;
    try {
      Date.now = () => { calls += 1; return 0; };
      assert.throws(() => fn(), TypeError, name);
      assert.equal(calls, 0, name);
      assert.equal(fn(new Date(0)), true, name);
      assert.equal(calls, 1, name);
      for (const value of [undefined, null, false, NaN, Infinity]) assert.throws(() => fn(new Date(0), value), TypeError, name);
      assert.equal(calls, 1, name);
      const expiry = new Date(0), now = new Date(0);
      assert.equal(fn(expiry, now), true, name);
      assert.equal(expiry.getTime(), 0, name); assert.equal(now.getTime(), 0, name);
    } finally { Date.now = before; }
  }
});

const mutants = [
  ["unsigned offset", replace('(zone[0] === "+" ? offset : -offset)', "offset")],
  ["reversed sign", replace('(zone[0] === "+" ? offset : -offset)', '(zone[0] === "+" ? -offset : offset)')],
  ["wrong offset scale", replace("* 60_000", "* 6000")],
  ["wrong offset minute contribution", replace("+ Number(zone.slice(4, 6))", "- Number(zone.slice(4, 6))")],
  ["floating point cancellation is not integer algebra", replace("date.getTime() -", "(date.getTime() + 9007199254740991 - 9007199254740991) -")],
  ["missing year roundtrip", replace("date.getUTCFullYear() !== year || ", "")],
  ["missing month roundtrip", replace("date.getUTCMonth() !== month - 1 || ", "")],
  ["missing day roundtrip", replace(" || date.getUTCDate() !== day", "")],
  ["wrong roundtrip binding", replace("date.getUTCDate() !== day", "date.getUTCDate() !== month")],
  ["missing setter", replace("  date.setUTCFullYear(year, month - 1, day);\n", "")],
  ["missing time setter", replace("  date.setUTCHours(hour, minute, second, Math.trunc(milliseconds));\n", "")],
  ["incorrect year setter", replace("setUTCFullYear(year,", "setUTCFullYear(month,")],
  ["wrong month base", replace("setUTCFullYear(year, month - 1, day)", "setUTCFullYear(year, month, day)")],
  ["intermediate hour overflow cannot be overwritten away", replace("  date.setUTCHours(hour", "  date.setUTCHours(24, 0, 0, 0);\n  date.setUTCHours(hour")],
  ["intermediate TimeClip cannot be overwritten away", replace("  date.setUTCFullYear(year", "  date.setUTCFullYear(999999, 0, 1);\n  date.setUTCFullYear(year")],
  ["Date.UTC remaps early years", replace("new Date(0)", "new Date(Date.UTC(year, month - 1, day))")],
  ["missing hour validation", replace("hour > 23 || ", "")],
  ["missing timezone validation", replace('(zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))', "false")],
  ["borrowed Date mutation", replace("const timestamp = value.getTime();", "value.setUTCFullYear(2000, 0, 1);\n    const timestamp = value.getTime();")],
  ["owned alias mutation changes result", replace("const timestamp = date.getTime()", "const alias = date;\n  alias.setUTCFullYear(2000, month - 1, day);\n  const timestamp = date.getTime()")],
  ["unknown owned Date escape", replace("date.setUTCFullYear", "inspect(date);\n  date.setUTCFullYear")],
  ["shadowed Date intrinsic", replace("const date = new Date(0);", "const Date = Number;\n  const date = new Date(0);")],
  ["module helper shadows Math intrinsic", source.replaceAll(/\bcurrent\b/g, "Math")],
  ["unguarded Date delegation", replace("if (value instanceof Date) return expiration(value);", "return expiration(value);")],
  ["wrong omission zero", replace("arguments.length === 1", "arguments.length === 0")],
  ["wrong omission explicit two", replace("arguments.length === 1", "arguments.length === 2")],
  ["zero-argument success bypass", replace("  const end = expiration(expiresAt);", "  if (arguments.length === 0) return true;\n  const end = expiration(expiresAt);")],
  ["eager normalization of explicit undefined", replace("arguments.length === 1 ? Date.now() : current(now)", "current(now)")]
];

test("owned Date proof abstains on incorrect arithmetic, incomplete validation and unowned effects", () => {
  for (const [name, text] of mutants) assert.equal(evidence(text).sourceOk, false, name);
});

test("unsigned negative offset is concretely incorrect even with passing positive-offset controls", async () => {
  const text = mutants[0][1], fn = await implementation(text);
  assert.equal(evidence(text).sourceOk, false);
  for (const suffix of ["-07:00", "-03:30", "-00:30"]) {
    const iso = `2026-01-01T00:00:00.123${suffix}`;
    assert.equal(fn(iso, Date.parse(iso) - 1), true, suffix);
  }
  const control = "2026-01-01T00:00:00.123+07:00";
  assert.equal(fn(control, Date.parse(control) - 1), false);
});

test("floating fraction rounding remains unproved despite corrected offset and Math.trunc", async () => {
  const text = replace('const milliseconds = Number((fraction + "000").slice(0, 3));', 'const milliseconds = Number(`0.${fraction}`) * 1000;');
  assert.equal(evidence(text).sourceOk, false);
  const fn = await implementation(text), iso = "2026-01-01T00:00:00.999999999999999999Z";
  assert.equal(fn(iso, Date.parse(iso)), false);
});

test("semantic source proof still needs live entrypoint-bound focused rejection assertions", () => {
  for (const text of [focused.replaceAll("assert.throws", "assert.equal"), focused.replace('from "./expiry.js"', 'from "./other.js"'), focused.replace("[undefined, null, false, new Date(NaN), Number.NaN, Infinity]", "[null, false, new Date(NaN), Number.NaN, Infinity]")]) {
    assert.equal(evidence(source, text).testOk, false);
  }
});
