import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acceptanceLanguageAdapterForPath,
  acceptanceLanguageAdapterStatus
} from "../packages/piagent-core/extensions/acceptance-language-adapters.js";
import {
  acceptanceCriticalRecoveryProjection,
  acceptanceSemanticConflicts,
  buildAcceptanceReceipt,
  invalidateAcceptanceReceiptAfterMutation,
  refreshAcceptanceReceipt
} from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { taskPerformanceAssurance } from "../packages/piagent-core/runtime/quality/performance-assurance.ts";

const treeDigest = (value) => versionWorkingTreeHash(value.repeat(64));
const criterion = "`take(items, options)` rejects zero, negative, and fractional `limit` values with `TypeError`.";

function task(changedFiles, digest = treeDigest("d"), verifyCommand = "node --test test/contract.test.js") {
  const built = buildAcceptanceReceipt({
    summary: `Implement a bounded contract. ${criterion}`,
    expectedOutput: "Focused executable tests prove the requested contract.",
    acceptanceCriteria: [criterion], changeMode: "source-change", source: "runtime",
    generatedAt: "2026-08-10T00:00:00.000Z"
  });
  return {
    taskId: "task-adapter", taskRunId: "run-adapter", taskAttempt: 1,
    summary: `Implement a bounded contract. ${criterion}`,
    expectedOutput: "Focused executable tests prove the requested contract.",
    acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
    changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
    scope: changedFiles, changedFiles, observedChangedFiles: changedFiles,
    verifyCommands: [verifyCommand],
    verifyEvidence: [{
      command: verifyCommand, exitCode: 0, observed: true, matchedProfileCommand: true,
      recordedAt: "2026-08-10T00:00:01.000Z", observedAt: "2026-08-10T00:00:01.000Z",
      preWorkingTreeDigest: digest, workingTreeDigest: digest
    }]
  };
}

function writeFiles(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-language-adapter-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  return cwd;
}

function invalidCriterion(result) {
  return result.receipt.criteria.find((item) => item.obligation === "invalid-input-rejection");
}

const esmSource = [
  "export function take(items, options = {}) {",
  "  const limit = options.limit === undefined ? 20 : options.limit;",
  "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
  "  return items.slice(0, limit);",
  "}", ""
].join("\n");
const esmTest = [
  "import assert from 'node:assert/strict';",
  "import { take } from '../src/limit.js';",
  "for (const limit of [0, -1, 1.5]) assert.throws(() => take([], { limit }), TypeError);",
  ""
].join("\n");

describe("finite acceptance language adapters", () => {
  it("classifies only the closed JavaScript/TypeScript family as proof-capable", () => {
    for (const extension of ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"]) {
      assert.equal(acceptanceLanguageAdapterForPath(`src/value.${extension}`).disposition, "supported");
    }
    for (const extension of ["py", "go", "rs"]) {
      assert.equal(acceptanceLanguageAdapterForPath(`src/value.${extension}`).disposition, "unsupported");
    }
    assert.equal(acceptanceLanguageAdapterForPath("src/value.future").disposition, "unresolved");
    assert.equal(acceptanceLanguageAdapterStatus(["src/value.ts", "package.json"]).proofCapable, true);
    assert.equal(acceptanceLanguageAdapterStatus(["src/value.ts", "src/value.py"]).proofCapable, false);
    assert.equal(acceptanceLanguageAdapterStatus(["README.md"]).status, "neutral");
  });

  it("accepts positive ESM proof and an alternative-valid CJS implementation", () => {
    const variants = [{
      files: { "src/limit.js": esmSource, "test/contract.test.js": esmTest },
      paths: ["src/limit.js", "test/contract.test.js"]
    }, {
      files: {
        "src/limit.cjs": esmSource.replace("export function take", "function take") + "module.exports = { take };\n",
        "test/contract.test.cjs": [
          "const assert = require('node:assert/strict');",
          "const { take } = require('../src/limit.cjs');",
          "for (const limit of [0, -1, 1.5]) assert.throws(() => take([], { limit }), TypeError);", ""
        ].join("\n")
      },
      paths: ["src/limit.cjs", "test/contract.test.cjs"]
    }];
    for (const variant of variants) {
      const cwd = writeFiles(variant.files);
      try {
        const refreshed = refreshAcceptanceReceipt(task(variant.paths), {
          cwd, changedFiles: variant.paths, currentWorkingTreeDigest: treeDigest("d")
        });
        assert.equal(invalidCriterion(refreshed).status, "satisfied");
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    }
  });

  it("keeps incomplete supported-language proof pending", () => {
    const cwd = writeFiles({
      "src/limit.js": esmSource.replace("!Number.isSafeInteger(limit) || limit <= 0", "limit <= 0"),
      "test/contract.test.js": esmTest
    });
    try {
      const candidate = task(["src/limit.js", "test/contract.test.js"]);
      const refreshed = refreshAcceptanceReceipt(candidate, {
        cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(invalidCriterion(refreshed).status, "pending");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("invalidates old proof after mutation and requires current semantic proof", () => {
    const cwd = writeFiles({ "src/limit.js": esmSource, "test/contract.test.js": esmTest });
    try {
      const candidate = task(["src/limit.js", "test/contract.test.js"]);
      const accepted = refreshAcceptanceReceipt(candidate, {
        cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(invalidCriterion(accepted).status, "satisfied");
      Object.assign(candidate, invalidateAcceptanceReceiptAfterMutation({
        ...candidate, acceptanceReceipt: accepted.receipt
      }, "2026-08-10T00:00:02.000Z").task);
      candidate.verifyEvidence = [{ ...candidate.verifyEvidence[0], preWorkingTreeDigest: treeDigest("e"), workingTreeDigest: treeDigest("e"), recordedAt: "2026-08-10T00:00:03.000Z" }];
      fs.writeFileSync(path.join(cwd, "src/limit.js"), esmSource.replace("!Number.isSafeInteger(limit) || limit <= 0", "limit <= 0"));
      const mutated = refreshAcceptanceReceipt(candidate, {
        cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: treeDigest("e")
      });
      assert.equal(invalidCriterion(mutated).status, "pending");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("abstains for unsupported languages without turning regex text into proof or review turns", () => {
    const paths = ["src/limit.py", "test/test_limit.py"];
    const cwd = writeFiles({
      "src/limit.py": "# Number.isSafeInteger(limit); throw new TypeError('limit')\ndef take(items, limit): return items[:limit]\n",
      "test/test_limit.py": "# assert.throws(() => take([], 1.5), TypeError)\ndef test_take(): assert True\n"
    });
    try {
      const candidate = task(paths, treeDigest("d"), "python -m pytest");
      const refreshed = refreshAcceptanceReceipt(candidate, {
        cwd, changedFiles: paths, currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(invalidCriterion(refreshed).status, "pending");
      assert.deepEqual(acceptanceSemanticConflicts(candidate, { cwd, changedFiles: paths }), []);
      assert.deepEqual(acceptanceCriticalRecoveryProjection(candidate, {
        cwd, changedFiles: paths, currentWorkingTreeDigest: treeDigest("d")
      }), []);
      const assurance = taskPerformanceAssurance({
        ...candidate,
        summary: "Preserve dependency stable order and prevent race conditions.",
        acceptanceCriteria: ["Dependencies run before their dependents."]
      });
      assert.equal(assurance.requiresReview, false);
      assert.deepEqual(assurance.reasonCodes, ["unsupported-language-abstain"]);
      const supportedAssurance = taskPerformanceAssurance({
        ...candidate, summary: "Preserve dependency stable order and prevent race conditions.",
        acceptanceCriteria: ["Dependencies run before their dependents."],
        changedFiles: ["src/limit.ts"], observedChangedFiles: ["src/limit.ts"]
      });
      assert.equal(supportedAssurance.requiresReview, true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
