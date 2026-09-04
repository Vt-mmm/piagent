import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { genericCriterionEvidence } from "../packages/piagent-core/extensions/acceptance-behavior-proof.js";
import { sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { automaticAcceptanceCriteria } from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const prompt = [
  "Implement `bucketForKey` in `src/bucket.js` and verify it with the focused test.",
  "", "Contract:", "",
  "- `key` must be a non-empty string;",
  "- `bucketCount` must be an integer from 1 through 65,536;",
  "- invalid input throws `TypeError`;",
  "- hash the UTF-8 bytes of `key` with unsigned 32-bit FNV-1a: start at",
  "  `2166136261`, XOR each byte, then multiply with `Math.imul` by `16777619`",
  "  and coerce to unsigned 32-bit after every byte;",
  "- return the unsigned hash modulo `bucketCount`;",
  "- do not add dependencies or mutate inputs.",
  "", "Keep changes within `src/bucket.js` and `test/**`. Run `npm test` before the",
  "final response and report the result."
].join("\n");

const source = `export function bucketForKey(key, bucketCount) {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("key");
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > 65536) throw new TypeError("bucketCount");
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(key)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash % bucketCount;
}
`;

const tests = `import assert from "node:assert/strict";
import test from "node:test";
import { bucketForKey } from "../src/bucket.js";
test("FNV-1a bucket smoke", () => {
  assert.equal(bucketForKey("a", 16), 12);
  assert.throws(() => bucketForKey("", 16), TypeError);
});
test("hashes UTF-8 bytes and returns a bucket in range", () => {
  assert.equal(bucketForKey("é", 256), 193);
  assert.equal(bucketForKey("🙂", 65536), 31307);
  assert.equal(bucketForKey("a", 1), 0);
  assert.equal(bucketForKey("a", 65536), 10540);
});
test("rejects invalid keys", () => {
  for (const key of ["", 1, null, undefined, false, {}, []]) assert.throws(() => bucketForKey(key, 16), TypeError);
});
test("rejects invalid bucket counts", () => {
  for (const count of [0, -1, 65537, 1.5, NaN, Infinity, -Infinity, "16", null, undefined]) {
    assert.throws(() => bucketForKey("key", count), TypeError);
  }
  assert.doesNotThrow(() => bucketForKey("key", 1));
  assert.doesNotThrow(() => bucketForKey("key", 65536));
});
`;

function writeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-contract-"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "test"));
  fs.writeFileSync(path.join(cwd, "src/bucket.js"), source);
  fs.writeFileSync(path.join(cwd, "test/bucket.test.js"), tests);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module" }));
  return cwd;
}

function currentTask(criteria, receipt, command, digest) {
  const observedAt = "2026-09-04T00:00:00.000Z";
  return {
    taskId: "runtime-contract", taskRunId: "runtime-contract-run", taskAttempt: 1,
    summary: prompt, changeMode: "source-change", mutationPolicy: "required",
    acceptanceCriteria: criteria, acceptanceReceipt: receipt,
    scope: ["src/bucket.js", "test/bucket.test.js"],
    changedFiles: ["src/bucket.js", "test/bucket.test.js"],
    observedChangedFiles: ["src/bucket.js", "test/bucket.test.js"],
    verifyCommands: [command], workingTreeDigestAlgorithm: "wt-content-v2",
    verifyEvidence: [{ command, exitCode: 0, observed: true, matchedProfileCommand: true,
      observedAt, recordedAt: observedAt, preWorkingTreeDigest: digest, workingTreeDigest: digest }]
  };
}

function refreshedBucket(cwd, selectedSource = source, extraChangedFiles = []) {
  fs.writeFileSync(path.join(cwd, "src/bucket.js"), selectedSource);
  const command = "node --test test/bucket.test.js";
  const criteria = automaticAcceptanceCriteria(prompt);
  const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change", mutationPolicy: "required",
    summary: prompt, acceptanceCriteria: criteria, generatedAt: "2026-09-04T00:00:00.000Z" });
  const digest = versionWorkingTreeHash(crypto.createHash("sha256").update(selectedSource).update(tests).digest("hex"));
  const task = currentTask(built.acceptanceCriteria, built.receipt, command, digest);
  task.scope.push(...extraChangedFiles); task.changedFiles.push(...extraChangedFiles); task.observedChangedFiles.push(...extraChangedFiles);
  return { built, refreshed: refreshAcceptanceReceipt(task, { cwd, currentWorkingTreeDigest: digest }) };
}

function titledEvidence(body) {
  const requirement = "Return the unsigned checksum modulo `bucketCount`.";
  const product = "export function bucketForKey(key, bucketCount) { return key.length % bucketCount; }";
  const raw = "import assert from 'node:assert/strict'; import test from 'node:test'; "
    + "import { bucketForKey } from '../src/bucket.js'; " + body;
  const entry = (file, text) => ({ path: file, text, evidenceText: sanitizeJavaScriptEvidence(text) });
  return genericCriterionEvidence({ obligation: "requested-behavior",
    task: { changeMode: "source-change", acceptanceCriteria: [requirement], verifyCommands: ["node --test test/bucket.test.js"] },
    criterion: { hash: crypto.createHash("sha256").update(requirement).digest("hex"), priority: "critical" },
    taskText: requirement, passingVerifier: true, verifierEvidence: { kind: "verify-command", exitCode: 0 },
    corpus: { adapter: { proofCapable: true }, files: ["src/bucket.js", "test/bucket.test.js"],
      sourceFiles: ["src/bucket.js"], testFiles: ["test/bucket.test.js"],
      sourceEntries: [entry("src/bucket.js", product)], testEntries: [entry("test/bucket.test.js", raw)] }
  }).evidence;
}

test("runtime intake attaches a standalone contract label to its first list requirement", () => {
  const criteria = automaticAcceptanceCriteria(prompt);
  assert.equal(criteria.includes("Contract:"), false);
  assert.ok(criteria.some((criterion) => criterion.startsWith("Contract:") && criterion.includes("`key` must be a non-empty string")));
});

test("test descriptions count only when they enclose linked assertions with two semantic anchors", () => {
  assert.ok(titledEvidence("test('unsigned checksum stays inside bucket count', () => assert.equal(bucketForKey('a', 16), 1));"));
  assert.equal(titledEvidence("test('unsigned checksum stays inside bucket count', () => assert.equal(1, 1)); assert.equal(bucketForKey('a', 16), 1);"), undefined);
  assert.equal(titledEvidence("test('checksum works', () => assert.equal(bucketForKey('a', 16), 1));"), undefined);
});

test("live focused bucket proof settles every critical runtime criterion", () => {
  const cwd = writeProject();
  try {
    const command = "node --test test/bucket.test.js";
    const run = spawnSync(process.execPath, ["--test", "test/bucket.test.js"], { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const { built, refreshed } = refreshedBucket(cwd);
    const keyCriterion = built.receipt.criteria.find((criterion) => (
      built.acceptanceCriteria.find((text) => crypto.createHash("sha256").update(text).digest("hex") === criterion.hash)
        ?.includes("`key` must be a non-empty string")
    ));
    assert.equal(keyCriterion?.obligation, "invalid-input-rejection");
    assert.deepEqual(refreshed.criticalMissing.map((criterion) => (
      built.acceptanceCriteria.find((text) => crypto.createHash("sha256").update(text).digest("hex") === criterion.hash)
    )), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("primitive contracts do not hide an observed pre-guard input mutation", () => {
  const cwd = writeProject();
  try {
    const unsafe = source.replace("  if (typeof key", "  if (key && typeof key === 'object') key.touched = true;\n  if (typeof key");
    const { built, refreshed } = refreshedBucket(cwd, unsafe);
    const pending = refreshed.criticalMissing.map((criterion) => (
      built.acceptanceCriteria.find((text) => crypto.createHash("sha256").update(text).digest("hex") === criterion.hash)
    ));
    assert.ok(pending.includes("do not add dependencies or mutate inputs."), JSON.stringify(pending));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a changed dependency manifest keeps dependency neutrality pending", () => {
  const cwd = writeProject();
  try {
    const { built, refreshed } = refreshedBucket(cwd, source, ["package.json"]);
    const pending = refreshed.criticalMissing.map((criterion) => (
      built.acceptanceCriteria.find((text) => crypto.createHash("sha256").update(text).digest("hex") === criterion.hash)
    ));
    assert.ok(pending.includes("do not add dependencies or mutate inputs."));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a mutable object still needs an explicit non-mutation assertion", () => {
  const criterionText = "Do not mutate the `options` object.";
  const mutableSource = "export function pick(options) { return options.value; }\n";
  const mutableTest = "import assert from 'node:assert/strict'; import test from 'node:test'; import { pick } from '../src/pick.js'; test('does not mutate options', () => assert.equal(pick({ value: 1 }), 1));\n";
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-mutable-contract-"));
  try {
    fs.mkdirSync(path.join(cwd, "src")); fs.mkdirSync(path.join(cwd, "test"));
    fs.writeFileSync(path.join(cwd, "src/pick.js"), mutableSource);
    fs.writeFileSync(path.join(cwd, "test/pick.test.js"), mutableTest);
    const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change",
      summary: criterionText, acceptanceCriteria: [criterionText], generatedAt: "2026-09-04T00:00:00.000Z" });
    const digest = versionWorkingTreeHash(crypto.createHash("sha256").update(mutableSource).update(mutableTest).digest("hex"));
    const task = currentTask(built.acceptanceCriteria, built.receipt, "node --test test/pick.test.js", digest);
    task.summary = criterionText; task.scope = task.changedFiles = task.observedChangedFiles = ["src/pick.js", "test/pick.test.js"];
    const refreshed = refreshAcceptanceReceipt(task, { cwd, currentWorkingTreeDigest: digest });
    assert.equal(refreshed.receipt.criteria[0].status, "pending");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
