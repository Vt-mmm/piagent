import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";

// Optional read-only diagnostic of a retained artifact. No benchmark grader,
// task journal, campaign result, or provider invocation is imported or changed.
const sourcePath = process.env.PIAGENT_RETAINED_EXPIRY_SOURCE;
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !sourcePath || !imageId || !dockerSocket, timeout: 60000 };
const RETAINED_HASH = "06e12ad0b3709d9cb1936501f423ee7eded80609e4c5f28d4d76f0b70159e1bf";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const num = (value) => ({ type: "number", value });
const date = (value) => ({ type: "date", value });
const str = (value) => ({ type: "string", value });
const ret = (value, extra = {}) => ({ outcome: "return", value: { type: "boolean", value }, clockReads: 0, ...extra });
const throws = { outcome: "throw", errorClass: "TypeError", clockReads: 0 };

function temporalPlan(source) {
  const valid = [];
  const isoCases = [
    "2024-02-29T12:34Z", "2024-02-29T12:34:56Z", "2024-02-29T12:34:56.000Z",
    "2024-02-29T12:34:56.9Z", "2024-02-29T12:34:56.99Z", "2024-02-29T12:34:56.999Z",
    "2024-02-29T12:34:56.9999Z", "2024-02-29T12:34:56+07:00", "2024-02-29T12:34:56.999-05:30",
    "0000-02-29T00:00:00Z", "0099-12-31T23:59:59.999Z", "0096-02-29T00:00+07:00"
  ];
  // V8's explicit-ISO parser supplies epochs for independently selected valid
  // calendar partitions; the candidate uses its own parser in a different VM.
  // Invalid calendars below are explicitly labelled, never normalized by Date.
  for (const year of [0, 1, 4, 99, 100, 400, 1900, 2000, 2100, 9999]) {
    for (const month of [1, 2, 3, 12]) isoCases.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01T00:00:00Z`);
  }
  for (const [index, iso] of isoCases.entries()) {
    const timestamp = Date.parse(iso);
    assert.ok(Number.isFinite(timestamp));
    for (const delta of [-1, 0, 1]) valid.push({ id: `iso-${index}-${delta + 1}`, args: [str(iso), num(timestamp + delta)], expected: ret(delta >= 0) });
  }
  const badIso = ["", "garbage", "2023-02-29T00:00Z", "1900-02-29T00:00Z", "0099-02-29T00:00Z", "2024-02-30T00:00Z",
    "2024-04-31T00:00Z", "2024-00-01T00:00Z", "2024-13-01T00:00Z", "2024-01-00T00:00Z", "2024-01-32T00:00Z",
    "2024-01-01T24:00Z", "2024-01-01T00:60Z", "2024-01-01T00:00:60Z", "2024-01-01T00:00+24:00", "2024-01-01T00:00+07:60",
    "2024-01-01T00:00", " 2024-01-01T00:00Z", "2024-01-01T00:00Z "];
  const invalid = badIso.map((iso, index) => ({ id: `invalid-iso-${index}`, args: [str(iso), num(0)], expected: throws }));
  const badExpiry = [{ type: "undefined" }, { type: "null" }, { type: "boolean", value: false }, num(0), num("NaN"), date("NaN")];
  for (const [index, value] of badExpiry.entries()) invalid.push({ id: `invalid-expiry-${index}`, args: [value, num(0)], expected: throws });
  const badNow = [{ type: "undefined" }, { type: "null" }, { type: "boolean", value: false }, str("1970-01-01T00:00Z"), num("NaN"), num("Infinity"), num("-Infinity"), date("NaN")];
  for (const [index, value] of badNow.entries()) invalid.push({ id: `invalid-now-${index}`, args: [str("1970-01-01T00:00Z"), value], expected: throws });
  const stability = [
    { id: "date-expiry", args: [date(10), num(10)], expected: ret(true, { dateArgsAfter: [{ index: 0, value: 10 }] }) },
    { id: "date-now", args: [str("1970-01-01T00:00Z"), date(-1)], expected: ret(false, { dateArgsAfter: [{ index: 1, value: -1 }] }) },
    { id: "both-dates", args: [date(10), date(11)], expected: ret(true, { dateArgsAfter: [{ index: 0, value: 10 }, { index: 1, value: 11 }] }) },
    { id: "clock-fallback", args: [str("1970-01-01T00:00Z")], clock: 0, expected: ret(true, { clockReads: 1 }) },
    { id: "invalid-before-clock", args: [str("invalid")], clock: 0, expected: throws }
  ];
  return { schemaVersion: 1, source, exportName: "isExpired", checks: [
    { id: "iso-calendar-and-inclusive-boundary", cases: valid }, { id: "invalid-input-type-and-calendar", cases: invalid },
    { id: "input-stability-and-lazy-clock", cases: stability }
  ] };
}

test("retained valid expiry artifact passes independent execution without rewriting source", integration, async (context) => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(sha(source), RETAINED_HASH);
  const result = await runIndependentContract({ planText: JSON.stringify(temporalPlan(source)), imageId, dockerSocket });
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.execution.sourceDigest, RETAINED_HASH);
  assert.equal(sha(await readFile(sourcePath)), RETAINED_HASH);
  context.diagnostic(`read-only retained replay: ${result.checks.reduce((sum, check) => sum + check.caseCount, 0)} cases; 0 provider calls; not a campaign pass`);
});

test("the same independent expiry plan rejects four deliberate source defects", integration, async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.equal(sha(source), RETAINED_HASH);
  const mutations = [
    ["return nowTimestamp >= expiryTimestamp;", "return nowTimestamp > expiryTimestamp;"],
    ["minuteText, secondText, fractionText, zone]", "minuteText, fractionText, secondText, zone]"],
    ["date.setUTCFullYear(year, month - 1, day);", "date.setUTCFullYear(year < 100 ? year + 1900 : year, month - 1, day);"],
    ["date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day", "false"]
  ];
  for (const [before, after] of mutations) {
    assert.ok(source.includes(before));
    const result = await runIndependentContract({ planText: JSON.stringify(temporalPlan(source.replace(before, after))), imageId, dockerSocket });
    assert.equal(result.verdict, "fail", JSON.stringify(result));
    assert.ok(result.counterexamples.length > 0);
  }
  assert.equal(sha(await readFile(sourcePath)), RETAINED_HASH);
});
