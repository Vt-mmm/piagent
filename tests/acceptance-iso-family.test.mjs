import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { compileContractSelection } from "../packages/piagent-core/extensions/acceptance-contract-selection.js";
import { compileIndependentContract, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { calendarExpirySource, ordinalExpirySource } from "./fixtures/iso-expiry-profile.mjs";

const libraryText = fs.readFileSync(new URL("../adapters/node-typescript/contract-families.json", import.meta.url), "utf8");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const hash = text => createHash("sha256").update(text).digest("hex");
const family = JSON.parse(libraryText).families.find(item => item.id === "iso-expiry-millisecond-profile");
function selected(call = "run") {
  const criterionText = family.description;
  const preview = compileContractSelection({ libraryText,
    taskText: JSON.stringify({ operatorRequestDigest: `operator-request-v1:${"a".repeat(64)}`, acceptanceCriteria: [criterionText],
      acceptanceReceipt: { criteria: [{ id: "iso-profile", hash: hash(criterionText), obligation: "requested-behavior" }] } }),
    recipeText: JSON.stringify({ schemaVersion: 1, backend: { imageId: imageId ?? `sha256:${"b".repeat(64)}`,
      dockerSocket: dockerSocket ?? "/unavailable.sock", timeoutMs: 10000 }, selections: [{
      criterion: { text: criterionText, obligation: "requested-behavior" }, family: { id: family.id, version: 1 },
      parameters: { call }, sourcePath: "src/expiry.js", maxAttempts: 2 }] }) });
  assert.equal(preview.status, "preview-only"); assert.equal(preview.completionAllowed, false);
  return preview.plan.contracts[0];
}
function plan(source, call) {
  const contract = selected(call);
  return JSON.stringify({ schemaVersion: 1, source, exportName: contract.exportName, checks: contract.checks });
}
const execute = (source, call) => runIndependentContract({ imageId, dockerSocket, planText: plan(source, call) });

test("ISO family is a data-only, bounded profile with independent literal epochs and instrumented clocks", () => {
  const contract = selected(), checks = contract.checks;
  assert.equal(checks.reduce((sum, check) => sum + check.cases.length, 0), 209);
  // Table authoring used Gregorian day counts and explicitly labelled fields,
  // not candidate outputs. V8 provides a second check on each valid epoch.
  for (const item of checks[0].cases) {
    const delta = item.id.endsWith("-before") ? -1 : item.id.endsWith("-after") ? 1 : 0;
    assert.equal(item.args[1].value, Date.parse(item.args[0].value) + delta, item.id);
    assert.equal(item.expected.value.value, delta >= 0, item.id);
  }
  assert.equal(checks[0].cases.find(item => item.id === "epoch-minute-equal").args[1].value, 0);
  assert.equal(checks[0].cases.find(item => item.id === "year-zero-offset-equal").args[1].value, -62167219260000);
  assert.equal(checks[0].cases.find(item => item.id === "before-epoch-equal").args[1].value, -1);
  for (const item of checks.flatMap(check => check.cases)) assert.ok(Object.hasOwn(item, "clock"), item.id);
  const request = JSON.parse(compileIndependentContract(plan(calendarExpirySource)).requestText);
  assert.ok(request.cases.every(item => !Object.hasOwn(item, "expected")), "expected values stay outside the guest");
  assert.match(family.description, /NOT all ISO 8601/);
});

test("ISO family accepts two implementations and a separately labelled equivalent mutant in the real worker", integration, async () => {
  // Without the multiline flag, JavaScript $ already requires end-of-input.
  // Removing this redundant length check is equivalent, not a defect to kill.
  const equivalent = calendarExpirySource.replace("!match || match[0] !== text", "!match");
  for (const source of [calendarExpirySource, ordinalExpirySource, equivalent]) {
    const result = await execute(source);
    assert.equal(result.verdict, "pass", JSON.stringify(result));
    assert.equal(result.execution.cleanupConfirmed, true);
    assert.equal(result.checks.reduce((sum, check) => sum + check.caseCount, 0), 209);
  }
});

const mutants = [
  ["exclusive-boundary", "return instant >= deadline;", "return instant > deadline;"],
  ["capture-groups", 'min, sec = "0", fraction = "", zone]', 'min, fraction = "", sec = "0", zone]'],
  ["small-year-remapping", "date.setUTCFullYear(year, month - 1, day);", "date.setUTCFullYear(year < 100 ? year + 1900 : year, month - 1, day);"],
  ["century-leap", "year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)", "year % 4 === 0"],
  ["calendar-normalization", "day > days[month - 1]", "day > 31"],
  ["offset-sign", "date.getTime() - offset * 60000", "date.getTime() + offset * 60000"],
  ["offset-minutes", "hours * 60 + minutes", "hours * 60"],
  ["offset-range", "hours > 23 || minutes > 59", "false"],
  ["fraction-rounding", 'Number((fraction + "000").slice(0, 3))', 'Math.round(Number("0." + (fraction || "0")) * 1000)'],
  ["fraction-padding", 'Number((fraction + "000").slice(0, 3))', 'Number(fraction || "0")'],
  ["whitespace-trimming", "const match =", "text = text.trim(); const match ="],
  ["numeric-expiry-coercion", 'if (typeof value === "string") return parseIso(value);', 'if (typeof value === "number" && Number.isFinite(value)) return value; if (typeof value === "string") return parseIso(value);'],
  ["explicit-falsy-clock", "arguments.length < 2 ? Date.now() : current(now)", "current(now || Date.now())"],
  ["explicit-undefined-clock", "arguments.length < 2 ? Date.now() : current(now)", 'now === undefined ? Date.now() : current(now)'],
  ["eager-clock", "const deadline = expiry(expiresAt);", "Date.now(); const deadline = expiry(expiresAt);"],
  ["date-mutation", "return value.getTime();", "{ const result = value.getTime(); value.setTime(result + 1); return result; }"],
  ["now-timeclip", "return timestamp;", "return new Date(timestamp).getTime();"]
];
test("ISO family rejects 17 deliberate development defects with retained counterexamples", integration, async context => {
  for (const [id, before, after] of mutants) {
    assert.ok(calendarExpirySource.includes(before), id);
    const result = await execute(calendarExpirySource.replace(before, after));
    assert.equal(result.verdict, "fail", JSON.stringify({ id, result }));
    assert.ok(result.counterexamples.length > 0, id);
    assert.equal(result.execution.cleanupConfirmed, true, id);
    context.diagnostic(`${id}: ${result.counterexamples.map(item => item.evidence.input.id).join(", ")}`);
  }
});

test("selected ISO family replays the retained source read-only without promoting it to a campaign", {
  ...integration, skip: integration.skip || !process.env.PIAGENT_RETAINED_EXPIRY_SOURCE
}, async context => {
  const sourcePath = process.env.PIAGENT_RETAINED_EXPIRY_SOURCE;
  const before = fs.readFileSync(sourcePath, "utf8");
  assert.equal(hash(before), "06e12ad0b3709d9cb1936501f423ee7eded80609e4c5f28d4d76f0b70159e1bf");
  const result = await execute(before, "isExpired");
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.execution.sourceDigest, hash(before));
  assert.equal(result.execution.cleanupConfirmed, true);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before);
  context.diagnostic("209 cases; 0 provider calls; diagnostic only, neither held-out nor a new campaign result");
});
