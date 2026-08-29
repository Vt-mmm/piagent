import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callableBodies } from "../packages/piagent-core/extensions/acceptance-callable-scanner.js";
import { acceptanceInvalidInputEvidence, sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const source = `const ISO_TIMESTAMP = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;
function parseIsoTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return NaN;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[8].slice(1, 3));
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[8].slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return NaN;
  return Date.parse(value);
}
function expiryTimestamp(value) { if (value instanceof Date) return value.getTime(); return parseIsoTimestamp(value); }
function nowTimestamp(value) { if (value instanceof Date) return value.getTime(); if (typeof value === "number" && Number.isFinite(value)) return value; return NaN; }
export function isExpired(expiresAt, now) {
  const expiry = expiryTimestamp(expiresAt);
  if (!Number.isFinite(expiry)) throw new TypeError("Invalid expiry date");
  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);
  if (!Number.isFinite(current)) throw new TypeError("Invalid current date");
  return current >= expiry;
}`;

const tests = `import assert from "node:assert/strict"; import { isExpired } from "./expiry.js";
for (const value of ["January 1, 2024", "2024-02-30T00:00:00.000Z", new Date("invalid"), 0, null]) assert.throws(() => isExpired(value, 0), TypeError);
for (const now of [undefined, null, false, NaN, Infinity]) assert.throws(() => isExpired("2099-01-01T00:00:00.000Z", now), TypeError);
assert.equal(isExpired("1970-01-01T00:00:00.000Z", 0), true);`;

const contract = "`isExpired(expiresAt, now)` must throw `TypeError` for invalid dates and invalid explicit now values without using current machine time.";

function evidence(candidate = source, taskText = contract, testText = tests) {
  return acceptanceInvalidInputEvidence({
    taskText,
    sourceText: candidate, testText,
    sourceEntries: [{ path: "expiry.js", text: candidate }], testEntries: [{ path: "expiry.test.js", text: testText }],
    namedTargets: ["isExpired"], provenanceTargets: ["isExpired"]
  });
}

test("proves immutable NaN sentinel rejection through direct helper delegation", () => {
  assert.deepEqual(evidence(), { sourceOk: true, testOk: true });
  assert.equal(evidence(source, "Invalid dates and numeric zero now must throw TypeError.").sourceOk, false);
});

test("scanner retains exact declarations, spans, depth, and the closed module inventory", () => {
  const code = sanitizeJavaScriptEvidence(source);
  const bodies = callableBodies(code);
  assert.equal(bodies.scanComplete, true);
  assert.deepEqual(bodies.declarations.map(({ name, braceDepth }) => [name, braceDepth]), [
    ["parseIsoTimestamp", 0], ["expiryTimestamp", 0], ["nowTimestamp", 0], ["isExpired", 0]
  ]);
  assert.deepEqual(bodies.topLevelStatements.map(({ kind, declarationName }) => [kind, declarationName]), [
    ["immutable-binding", null], ["function-declaration", "parseIsoTimestamp"],
    ["function-declaration", "expiryTimestamp"], ["function-declaration", "nowTimestamp"],
    ["function-declaration", "isExpired"]
  ]);
  const publicCallable = bodies.get("isexpired");
  assert.equal(publicCallable.declarationName, "isExpired");
  assert.deepEqual(publicCallable.exactParameters, ["expiresAt", "now"]);
  assert.match(code.slice(publicCallable.declarationStart, publicCallable.declarationEnd), /^export function isExpired/);
  const collision = callableBodies(sanitizeJavaScriptEvidence(source.replace(
    "function expiryTimestamp", "function ParseIsoTimestamp(value) { return NaN; }\nfunction expiryTimestamp"
  )));
  assert.equal(collision.caseFoldCollisions.has("parseisotimestamp"), true);
});

const adversarialCases = [
  ["unowned top-level statement", `const harmless = 1;\n${source}`],
  ["mutable top-level regex binding", source.replace("const ISO_TIMESTAMP", "let ISO_TIMESTAMP")],
  ["strict regex missing start anchor", source.replace("/^(\\d{4})", "/(\\d{4})")],
  ["strict regex missing end anchor", source.replace("\\d{2})$/", "\\d{2})/")],
  ["intrinsic NaN shadow", `const NaN = 0;\n${source}`],
  ["regex exec member write", source.replace("function parseIsoTimestamp", "ISO_TIMESTAMP.exec = () => null;\nfunction parseIsoTimestamp")],
  ["regex compile call", source.replace("function parseIsoTimestamp", "ISO_TIMESTAMP.compile(/.*/);\nfunction parseIsoTimestamp")],
  ["RegExp prototype exec write", `RegExp.prototype.exec = () => null;\n${source}`],
  ["object destructuring delegate write", source.replace("export function isExpired", "({ expiryTimestamp } = { expiryTimestamp: () => 0 });\nexport function isExpired")],
  ["array destructuring delegate write", source.replace("export function isExpired", "[expiryTimestamp] = [() => 0];\nexport function isExpired")],
  ["for-of delegate write", source.replace("export function isExpired", "for (expiryTimestamp of [() => 0]) {}\nexport function isExpired")],
  ["regex const nested in block", source.replace(/^const ISO_TIMESTAMP = ([^;]+);/, "if (enabled) { const ISO_TIMESTAMP = $1; }")],
  ["parser nested in block", source.replace("function parseIsoTimestamp", "if (enabled) {\nfunction parseIsoTimestamp").replace("\nfunction expiryTimestamp", "\n}\nfunction expiryTimestamp")],
  ["delegate nested in block", source.replace("function expiryTimestamp", "if (enabled) {\nfunction expiryTimestamp").replace("\nfunction nowTimestamp", "\n}\nfunction nowTimestamp")],
  ["case mismatch match guard", source.replace("if (!match)", "if (!MATCH)")],
  ["case mismatch parser input", source.replace("ISO_TIMESTAMP.exec(value)", "ISO_TIMESTAMP.exec(Value)")],
  ["case mismatch delegate input", source.replace("parseIsoTimestamp(value)", "parseIsoTimestamp(Value)")],
  ["case mismatch public guard alias", source.replace("Number.isFinite(expiry)", "Number.isFinite(Expiry)")],
  ["case-fold duplicate callable", source.replace("function expiryTimestamp", "function ParseIsoTimestamp(value) { return NaN; }\nfunction expiryTimestamp")],
  ["leaf plain object-destructured formal", source.replace("function parseIsoTimestamp(value)", "function parseIsoTimestamp({ value })")],
  ["leaf defaulted object-destructured formal", source.replace("function parseIsoTimestamp(value)", 'function parseIsoTimestamp({ value = "2099-01-01T00:00:00.000Z" })')],
  ["leaf array-destructured formal", source.replace("function parseIsoTimestamp(value)", "function parseIsoTimestamp([value])")],
  ["leaf rest formal", source.replace("function parseIsoTimestamp(value)", "function parseIsoTimestamp(...value)")],
  ["leaf optional typed formal", source.replace("function parseIsoTimestamp(value)", "function parseIsoTimestamp(value?: string)")],
  ["leaf extra no-op", source.replace("function parseIsoTimestamp(value) {", "function parseIsoTimestamp(value) { void 0;")],
  ["leaf early return", source.replace("function parseIsoTimestamp(value) {", "function parseIsoTimestamp(value) { return 0;")],
  ["leaf Date.parse bypass", source.replace("return Date.parse(value);", "return 0;")],
  ["leaf input write", source.replace('if (typeof value !== "string")', 'value = "2099-01-01T00:00:00.000Z"; if (typeof value !== "string")')],
  ["leaf match write", source.replace("const year = Number(match[1]);", "match[3] = '01'; const year = Number(match[1]);")],
  ["leaf missing calendar bound", source.replace("month < 1 || ", "")],
  ["leaf widened calendar bound", source.replace("month > 12", "month > 120")],
  ["leaf gated calendar bound", source.replace("month < 1 || ", "enabled && month < 1 || ")],
  ["leaf async", source.replace("function parseIsoTimestamp", "async function parseIsoTimestamp")],
  ["leaf try-catch", source.replace("function parseIsoTimestamp(value) {", "function parseIsoTimestamp(value) { try {").replace("return Date.parse(value);\n}", "return Date.parse(value); } catch { return 0; }\n}")],
  ["delegate fixed argument", source.replace("return parseIsoTimestamp(value);", 'return parseIsoTimestamp("fixed");')],
  ["delegate defaulted object-destructured formal", source.replace("function expiryTimestamp(value)", "function expiryTimestamp({ value = new Date(0) })")],
  ["delegate extra no-op", source.replace("function expiryTimestamp(value) {", "function expiryTimestamp(value) { void 0;")],
  ["delegate conditional", source.replace("return parseIsoTimestamp(value);", "return enabled ? parseIsoTimestamp(value) : NaN;")],
  ["delegate caught", source.replace("function expiryTimestamp(value) { if (value instanceof Date) return value.getTime(); return parseIsoTimestamp(value); }", "function expiryTimestamp(value) { try { if (value instanceof Date) return value.getTime(); return parseIsoTimestamp(value); } catch { return 0; } }")],
  ["delegate async", source.replace("function expiryTimestamp", "async function expiryTimestamp")],
  ["public prior return", source.replace("const expiry = expiryTimestamp(expiresAt);", "return false; const expiry = expiryTimestamp(expiresAt);")],
  ["public extra no-op", source.replace("const expiry = expiryTimestamp(expiresAt);", "void 0; const expiry = expiryTimestamp(expiresAt);")],
  ["public unreachable suffix", source.replace("return current >= expiry;", "return current >= expiry; audit();")],
  ["public wrong error class", source.replace('new TypeError("Invalid expiry date")', 'new RangeError("Invalid expiry date")')],
  ["public loop before chain", source.replace("const expiry = expiryTimestamp(expiresAt);", "while (true) break; const expiry = expiryTimestamp(expiresAt);")],
  ["public input write", source.replace("const expiry = expiryTimestamp(expiresAt);", 'expiresAt = "2099-01-01T00:00:00.000Z"; const expiry = expiryTimestamp(expiresAt);')],
  ["public nested chain", source.replace("const expiry = expiryTimestamp(expiresAt);", "if (enabled) { const expiry = expiryTimestamp(expiresAt);").replace("return current >= expiry;", "return current >= expiry; }")],
  ["public caught guard", source.replace('if (!Number.isFinite(expiry)) throw new TypeError("Invalid expiry date");', 'try { if (!Number.isFinite(expiry)) throw new TypeError("Invalid expiry date"); } catch {}')],
  ["public async", source.replace("export function isExpired", "export async function isExpired")],
  ["public wrong guard alias", source.replace("Number.isFinite(expiry)", "Number.isFinite(current)")],
  ["public dynamic TypeError argument", source.replace('new TypeError("Invalid expiry date")', "new TypeError(fail())")],
  ["public interpolated TypeError template", source.replace('new TypeError("Invalid expiry date")', 'new TypeError(`${fail()}`)')],
  ["public arrow loses arguments ownership", source.replace("export function isExpired(expiresAt, now) {", "export const isExpired = (expiresAt, now) => {")],
  ["public defaulted object-destructured formal", source.replace("isExpired(expiresAt, now)", 'isExpired({ expiresAt = "2099-01-01T00:00:00.000Z" }, now)')],
  ["formal arguments shadows owned arguments", source.replace("export function isExpired(expiresAt, now)", "export function isExpired(arguments, now)")],
  ["wrong omission threshold", source.replace("arguments.length < 2", "arguments.length < 3")],
  ["defaulted now formal", source.replace("isExpired(expiresAt, now)", "isExpired(expiresAt, now = Date.now())")],
  ["now pre-use before omission", source.replace("const current = arguments.length", "void now; const current = arguments.length")],
  ["direct delegate reassignment", source.replace("export function isExpired", "expiryTimestamp = () => 0;\nexport function isExpired")]
];

test("named closed-module adversarial matrix fails every poisoned source", () => {
  for (const [name, candidate] of adversarialCases) {
    assert.notEqual(candidate, source, `${name}: fixture must mutate source`);
    assert.equal(evidence(candidate).sourceOk, false, name);
  }
});

test("helper partitions and ambiguous multi-parameter attribution fail closed", () => {
  assert.equal(evidence(source, "Invalid dates and numeric zero now must throw TypeError.").sourceOk, false,
    "the finite now helper accepts zero and must not claim its rejection");
  assert.equal(evidence(
    source.replace('new TypeError("Invalid expiry date")', 'new RangeError("Invalid expiry date")'),
    "`isExpired(expiresAt, now)` must throw TypeError for invalid explicit now values.",
    `import assert from "node:assert/strict"; import { isExpired } from "./expiry.js";
     for (const now of [undefined, null, false, NaN, Infinity]) assert.throws(() => isExpired("2099-01-01T00:00:00.000Z", now), TypeError);`
  ).sourceOk, false, "a later now proof cannot skip a wrong prior expiry rejection chain");
  const ambiguousTest = `import assert from "node:assert/strict"; import { isExpired } from "./expiry.js";
    assert.throws(() => isExpired(null, null), TypeError);`;
  assert.equal(evidence(source, "Invalid inputs to `isExpired` must throw `TypeError`.", ambiguousTest).sourceOk, false,
    "one ambiguous assertion cannot assign the invalid partition to either parameter");
  const validNumberNow = `import assert from "node:assert/strict"; import { isExpired } from "./expiry.js";
    for (const now of [1, 2, 3]) assert.throws(() => isExpired("2099-01-01T00:00:00.000Z", now), TypeError);`;
  assert.deepEqual(evidence(source,
    "`isExpired(expiresAt, now)` must reject every non-string `now` with `TypeError`.", validNumberNow),
  { sourceOk: false, testOk: true }, "finite numbers are valid now values, so the finite helper cannot claim the whole non-string domain");
  assert.deepEqual(evidence(source,
    "`isExpired(expiresAt, now)` must reject every non-array `now` with `TypeError`.", validNumberNow),
  { sourceOk: false, testOk: true }, "finite numbers are valid now values, so the finite helper cannot claim the whole non-array domain");
  const validDateExpiry = `import assert from "node:assert/strict"; import { isExpired } from "./expiry.js";
    for (const value of [new Date(1), new Date(2), new Date(3)]) assert.throws(() => isExpired(value, 0), TypeError);`;
  assert.deepEqual(evidence(source,
    "`isExpired(expiresAt, now)` must reject every non-string `expiresAt` with `TypeError`.", validDateExpiry),
  { sourceOk: false, testOk: true }, "valid Date objects are valid expiry values, so the strict-date delegate cannot claim the whole non-string domain");
});

test("receipt integration settles only the exact closed candidate", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-invalid-sentinel-proof-"));
  try {
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "test", "expiry.test.js"), tests.replace('from "./expiry.js"', 'from "../expiry.js"'));
    const digest = versionWorkingTreeHash("a".repeat(64));
    const command = "node --test test/expiry.test.js";
    const receiptFor = (candidate) => {
      fs.writeFileSync(path.join(cwd, "expiry.js"), candidate);
      const built = buildAcceptanceReceipt({
        summary: contract, expectedOutput: "The invalid timestamp contract is verified.",
        acceptanceCriteria: [contract], changeMode: "source-change", source: "runtime",
        generatedAt: "2026-08-29T00:00:00.000Z"
      });
      const task = {
        summary: contract, expectedOutput: "The invalid timestamp contract is verified.",
        acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
        changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
        changedFiles: ["expiry.js", "test/expiry.test.js"], verifyCommands: [command],
        verifyEvidence: [{ command, exitCode: 0, observed: true, matchedProfileCommand: true,
          recordedAt: "2026-08-29T00:00:01.000Z", preWorkingTreeDigest: digest, workingTreeDigest: digest }],
        trace: { outcome: "pending" }
      };
      return refreshAcceptanceReceipt(task, { cwd, changedFiles: task.changedFiles,
        currentWorkingTreeDigest: digest, recordedAt: "2026-08-29T00:00:02.000Z" });
    };
    const accepted = receiptFor(source);
    assert.equal(accepted.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    const poisoned = receiptFor(`const NaN = 0;\n${source}`);
    assert.equal(poisoned.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
