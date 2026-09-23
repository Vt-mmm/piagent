import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const criterion = "`requireInteger` must throw `TypeError` for fractional input.";
const source = "export function requireInteger(value) { if (!Number.isInteger(value)) throw new TypeError('integer required'); return value; }\n";
const sourcePath = "src/number.mjs", testPath = "test/number.test.mjs";
const testSource = (binding = "import { requireInteger } from '../src/number.mjs';", call = "requireInteger") =>
  `import assert from 'node:assert/strict';\n${binding}\nassert.throws(() => ${call}(1.5), TypeError);\n`;

function evidence({ candidate = source, text = testSource(), sources, tests, provenanceTargets = [] } = {}) {
  return acceptanceInvalidInputEvidence({ taskText: criterion, sourceText: candidate, testText: text,
    sourceEntries: sources ?? [{ path: sourcePath, text: candidate }],
    testEntries: tests ?? [{ path: testPath, text }], namedTargets: ["requireInteger"],
    // Bare prose is not promoted to explicit callable syntax by the caller.
    provenanceTargets });
}

for (const [name, binding, call] of [
  ["direct", "import { requireInteger } from '../src/number.mjs';", "requireInteger"],
  ["renamed", "import { requireInteger as check } from '../src/number.mjs';", "check"],
  ["namespace", "import * as numbers from '../src/number.mjs';", "numbers.requireInteger"]
]) {
  test(`bare exported entrypoint uses actual ${name} import provenance`, () => {
    assert.deepEqual(evidence({ text: testSource(binding, call) }), { sourceOk: true, testOk: true });
  });
}

for (const [name, text] of [
  ["wrong module", testSource("import { requireInteger } from '../src/decoy.mjs';")],
  ["wrong namespace module", testSource("import * as numbers from '../src/decoy.mjs';", "numbers.requireInteger")],
  ["local function", testSource("function requireInteger() { throw new TypeError('decoy'); }")],
  ["local object method", testSource("const numbers = { requireInteger() { throw new TypeError('decoy'); } };", "numbers.requireInteger")],
  ["shadowed import", testSource().replace("assert.throws", "function run(requireInteger) { assert.throws") + "}\nrun(() => { throw new TypeError('decoy'); });\n"],
  ["shadowed namespace", testSource("import * as numbers from '../src/number.mjs';", "numbers.requireInteger")
    .replace("assert.throws", "function run(numbers) { assert.throws") + "}\n"],
  ["reassigned alias", testSource("import { requireInteger as check } from '../src/number.mjs';\ncheck = () => { throw new TypeError('decoy'); };", "check")],
  ["mutated namespace", testSource("import * as numbers from '../src/number.mjs';\nnumbers.requireInteger = () => { throw new TypeError('decoy'); };", "numbers.requireInteger")],
  ["disabled assertion", testSource().replace("assert.throws", "assert.throws = () => {};\nassert.throws")],
  ["wrong error class", testSource().replace(", TypeError)", ", RangeError)")],
  ["unexecuted assertion", testSource().replace("assert.throws", "if (false) assert.throws")]
]) {
  test(`bare exported entrypoint rejects ${name} evidence`, () => {
    assert.equal(evidence({ text }).testOk, false);
  });
}

test("bare exported entrypoint cannot borrow assertions from another file", () => {
  const importsOnly = "import { requireInteger } from '../src/number.mjs';\n";
  const decoy = testSource("function requireInteger() { throw new TypeError('decoy'); }");
  assert.equal(evidence({ tests: [{ path: testPath, text: importsOnly }, { path: "test/decoy.test.mjs", text: decoy }] }).testOk, false);
});

test("bare exported entrypoint abstains on ambiguous exports and unstable source bindings", () => {
  assert.deepEqual(evidence({ sources: [{ path: sourcePath, text: source }, { path: "src/other.mjs", text: source }] }),
    { sourceOk: false, testOk: false });
  assert.deepEqual(evidence({ candidate: source + "requireInteger = () => 0;\n" }), { sourceOk: false, testOk: false });
});

test("an unstable target cannot disappear in favor of a stable same-name decoy export", () => {
  const unstable = "export function requireInteger(value) { return value; }\nrequireInteger = value => value;\n";
  const decoyTest = testSource("import { requireInteger } from '../src/other.mjs';");
  for (const provenanceTargets of [[], ["requireInteger"]]) {
    assert.deepEqual(evidence({ candidate: unstable, text: decoyTest, provenanceTargets,
      sources: [{ path: sourcePath, text: unstable }, { path: "src/other.mjs", text: source }] }),
      { sourceOk: false, testOk: false });
  }
});

test("a bare method target cannot borrow proof from an unrelated same-name export", () => {
  const method = "export class Guard { requireInteger(value) { return value; } }\n";
  const decoyTest = testSource("import { requireInteger } from '../src/other.mjs';");
  const result = acceptanceInvalidInputEvidence({
    taskText: "The `requireInteger` method in `src/number.mjs` must throw `TypeError` for fractional input.",
    sourceText: method + source, testText: decoyTest,
    sourceEntries: [{ path: sourcePath, text: method }, { path: "src/other.mjs", text: source }],
    testEntries: [{ path: testPath, text: decoyTest }], namedTargets: ["requireInteger"], provenanceTargets: [] });
  assert.equal(result.sourceOk && result.testOk, false);
});

test("a direct import is not source proof when the rejection guard is absent", () => {
  assert.deepEqual(evidence({ candidate: "export function requireInteger(value) { return value; }\n" }),
    { sourceOk: false, testOk: true });
  assert.equal(evidence({ candidate: source.replace("export ", "") }).testOk, false);
});

test("bare criterion reaches receipt proof only with current passing verification", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-bare-export-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "test"));
  fs.writeFileSync(path.join(cwd, sourcePath), source);
  fs.writeFileSync(path.join(cwd, testPath), testSource());
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", testPath], { cwd, env, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /(?:#|ℹ)\s+tests 1\b/);
  assert.match(run.stdout, /(?:#|ℹ)\s+skipped 0\b/);
  const digest = versionWorkingTreeHash(createHash("sha256").update(source).update(testSource()).digest("hex"));
  const command = `node --test ${testPath}`;
  const built = buildAcceptanceReceipt({ summary: criterion, expectedOutput: "Implement the requested input validation.",
    acceptanceCriteria: [criterion], changeMode: "source-change", source: "runtime", generatedAt: "2026-09-06T00:00:00.000Z" });
  const task = { summary: criterion, expectedOutput: "Implement the requested input validation.",
    acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt, changeMode: "source-change",
    workingTreeDigestAlgorithm: "wt-content-v2", changedFiles: [sourcePath, testPath], verifyCommands: [command],
    verifyEvidence: [{ command, exitCode: run.status, observed: true, matchedProfileCommand: true,
      recordedAt: "2026-09-06T00:00:01.000Z", preWorkingTreeDigest: digest, workingTreeDigest: digest }],
    trace: { outcome: "pending" } };
  const refresh = (candidate = task, currentWorkingTreeDigest = digest) => refreshAcceptanceReceipt(candidate,
    { cwd, changedFiles: task.changedFiles, currentWorkingTreeDigest, recordedAt: "2026-09-06T00:00:02.000Z" });
  assert.equal(refresh().receipt.criteria[0].obligation, "invalid-input-rejection");
  assert.equal(refresh().receipt.criteria[0].status, "satisfied");
  assert.equal(refresh(task, versionWorkingTreeHash("c".repeat(64))).receipt.criteria[0].status, "pending");
  assert.equal(refresh({ ...task, verifyEvidence: [] }).receipt.criteria[0].status, "pending");
  assert.equal(refresh({ ...task, verifyEvidence: [{ ...task.verifyEvidence[0], exitCode: 1 }] }).receipt.criteria[0].status, "pending");
  fs.writeFileSync(path.join(cwd, sourcePath), "export function requireInteger(value) { return value; }\n");
  assert.equal(refresh().receipt.criteria[0].status, "pending", "an asserted verifier pass cannot replace source proof");
});
