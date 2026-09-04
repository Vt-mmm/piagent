import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash, WORKING_TREE_DIGEST_ALGORITHM } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { automaticAcceptanceCriteria } from "../packages/piagent-core/runtime/workflows/task-intake.ts";

const CURRENT_DIGEST = versionWorkingTreeHash("d".repeat(64));
const COMPOUND_INPUT = "Contract: `jobs` must be an array; `nowMs` and `leadMs` must be non-negative safe integers; `limit` must be a positive safe integer";
const RESULT_CONTRACT = "return only their IDs, capped at `limit`;";

function temporaryProject(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-conjunctive-proof-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function sourceText(name, variant = "complete") {
  const leadGuard = variant === "partial-input" ? "" : "  if (!Number.isSafeInteger(leadMs) || leadMs < 0) throw new TypeError('leadMs');\n";
  const cap = variant === "wrong-cap" ? "limit + 1" : "limit";
  const projection = variant === "wrong-shape" ? "job" : "job.id";
  return [
    `export function ${name}(jobs, nowMs, leadMs, limit) {`,
    "  if (!Array.isArray(jobs)) throw new TypeError('jobs');",
    "  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs');",
    leadGuard.trimEnd(),
    "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
    "  return jobs",
    "    .filter((job) => job.expiresAt > nowMs && job.expiresAt <= nowMs + leadMs)",
    `    .slice(0, ${cap})`,
    `    .map((job) => ${projection});`,
    "}",
    ""
  ].filter(Boolean).join("\n");
}

function testText(sourceName, localName, variant = "complete") {
  if (variant === "detached") {
    return "import assert from 'node:assert/strict';\nassert.deepEqual(['a', 'b'], ['a', 'b']);\n";
  }
  const leadAssertion = variant === "partial-input"
    ? ""
    : `assert.throws(() => ${localName}([], 0, -1, 1), TypeError);`;
  const expected = variant === "wrong-shape"
    ? "jobs.slice(0, 2)"
    : "['a', 'b']";
  return [
    "import assert from 'node:assert/strict';",
    `import { ${sourceName}${localName === sourceName ? "" : ` as ${localName}`} } from '../src/jobs.js';`,
    "const jobs = [",
    "  { id: 'a', expiresAt: 10 },",
    "  { id: 'b', expiresAt: 20 },",
    "  { id: 'c', expiresAt: 30 },",
    "  { id: 'd', expiresAt: 40 }",
    "];",
    `assert.deepEqual(${localName}(jobs, 0, 100, 2), ${expected});`,
    `assert.throws(() => ${localName}(null, 0, 0, 1), TypeError);`,
    `assert.throws(() => ${localName}([], -1, 0, 1), TypeError);`,
    leadAssertion,
    `assert.throws(() => ${localName}([], 0, 0, 0), TypeError);`,
    ""
  ].filter(Boolean).join("\n");
}

function refreshedFixture(t, { sourceName = "selectJobs", localName = sourceName, sourceVariant = "complete", testVariant = sourceVariant } = {}) {
  const cwd = temporaryProject(t);
  fs.writeFileSync(path.join(cwd, "src", "jobs.js"), sourceText(sourceName, sourceVariant));
  fs.writeFileSync(path.join(cwd, "test", "jobs.test.js"), testText(sourceName, localName, testVariant));
  const criteria = [
    COMPOUND_INPUT,
    "invalid input throws `TypeError`;",
    RESULT_CONTRACT,
    "do not mutate the input array.",
    "The configured verification command passes after the final mutation."
  ];
  const built = buildAcceptanceReceipt({
    summary: `Implement \`${sourceName}\` with bounded validation and output.`,
    expectedOutput: "The exact requested behavior is implemented.",
    acceptanceCriteria: criteria,
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-09-04T00:00:00.000Z"
  });
  const changedFiles = ["src/jobs.js", "test/jobs.test.js"];
  const criterionGraph = compileCriterionGraph({
    acceptanceCriteria: built.acceptanceCriteria,
    scope: ["src/jobs.js", "test/**"],
    verifyCommands: ["npm test"],
    changeMode: "source-change",
    createdAt: "2026-09-04T00:00:00.000Z"
  });
  const task = {
    schemaVersion: 2,
    changeMode: "source-change",
    summary: `Implement \`${sourceName}\` with bounded validation and output.`,
    expectedOutput: "The exact requested behavior is implemented.",
    acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt,
    criterionGraph,
    scope: ["src/jobs.js", "test/**"],
    outOfScope: [],
    protectedPaths: [],
    changedFiles,
    observedChangedFiles: changedFiles,
    verifyCommands: ["npm test"],
    verifyEvidence: [{
      command: "npm test",
      exitCode: 0,
      observed: true,
      matchedProfileCommand: true,
      preWorkingTreeDigest: CURRENT_DIGEST,
      workingTreeDigest: CURRENT_DIGEST,
      recordedAt: "2026-09-04T00:00:01.000Z"
    }],
    workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
    trace: { outcome: "completed" }
  };
  return refreshAcceptanceReceipt(task, {
    cwd,
    changedFiles,
    currentWorkingTreeDigest: CURRENT_DIGEST,
    recordedAt: "2026-09-04T00:00:02.000Z"
  });
}

function missingText(result) {
  const missing = new Set(result.criticalMissing.map((criterion) => criterion.hash));
  return result.task.acceptanceCriteria.filter((_criterion, index) => missing.has(result.receipt.criteria[index].hash));
}

test("automatic intake gives each top-level semicolon conjunct its own stable criterion", () => {
  const criteria = automaticAcceptanceCriteria([
    "Implement `selectJobs`.",
    "",
    `- ${COMPOUND_INPUT}; invalid input throws TypeError;`,
    `- ${RESULT_CONTRACT}`
  ].join("\n"));
  assert.ok(criteria.includes("Contract: `jobs` must be an array;"));
  assert.ok(criteria.includes("`nowMs` and `leadMs` must be non-negative safe integers;"));
  assert.ok(criteria.includes("`limit` must be a positive safe integer;"));
});

test("retained compound input and result-shape criteria receive conjunctive executable proof", (t) => {
  const result = refreshedFixture(t);
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[0].hash), false);
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[2].hash), false);
});

test("partial validation, wrong cap, wrong shape, and detached green assertions remain unproven", async (t) => {
  const variants = [
    { sourceVariant: "partial-input", missingIndex: 0 },
    { sourceVariant: "wrong-cap", missingIndex: 2 },
    { sourceVariant: "wrong-shape", missingIndex: 2 },
    { testVariant: "detached", missingIndex: 2 }
  ];
  for (const variant of variants) {
    await t.test(variant.sourceVariant ?? variant.testVariant, (child) => {
      const result = refreshedFixture(child, variant);
      assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[variant.missingIndex].hash), true, JSON.stringify(missingText(result)));
    });
  }
});

test("proof follows a statically imported renamed callable instead of lexical name overlap", (t) => {
  const result = refreshedFixture(t, { sourceName: "selectJobs", localName: "choose" });
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[2].hash), false);
});
