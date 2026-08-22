import assert from "node:assert/strict";
import test from "node:test";

import {
  durableContextEvidenceEntries,
  hasDurableContextEvidence,
  isPlannedContextEntry,
  isRuntimeOwnedContextEvidenceEntry
} from "../packages/piagent-core/extensions/context-evidence.js";
import { mergeObservedTaskContext } from "../packages/piagent-core/extensions/task-contract-view.js";

test("criterion context remains planning data until runtime observes or confirms delivery", () => {
  const task = {
    contextManifest: [
      { path: "src/invoice.ts", reason: "criterion-01 scope target" },
      { path: "README.md", reason: "Runtime observed successful source read." }
    ]
  };

  assert.equal(isPlannedContextEntry(task.contextManifest[0]), true);
  assert.deepEqual(durableContextEvidenceEntries(task), [task.contextManifest[1]]);
  assert.equal(hasDurableContextEvidence({ contextManifest: [task.contextManifest[0]] }), false);
  assert.equal(hasDurableContextEvidence(task), true);
});

test("observed evidence replaces a legacy criterion seed for the same path", () => {
  const task = {
    contextManifest: [{ path: "src/invoice.ts", reason: "criterion-01 scope target" }]
  };

  const added = mergeObservedTaskContext(task, [{
    path: "src/invoice.ts",
    reason: "Runtime observed successful source read."
  }], 8);

  assert.deepEqual(added, ["src/invoice.ts"]);
  assert.deepEqual(task.contextManifest, [{
    path: "src/invoice.ts",
    reason: "Runtime observed successful source read."
  }]);
  assert.equal(hasDurableContextEvidence(task), true);
});

test("legacy manual reasons fail closed until runtime-owned evidence replaces them", () => {
  const task = {
    contextManifest: [
      { path: "README.md", reason: "Model says this file was read." },
      { path: "src/confirmed.ts", reason: "Runtime confirmed delivery of criterion-selected context." }
    ]
  };

  assert.equal(isRuntimeOwnedContextEvidenceEntry(task.contextManifest[0]), false);
  assert.equal(isRuntimeOwnedContextEvidenceEntry(task.contextManifest[1]), true);
  assert.deepEqual(durableContextEvidenceEntries(task), [task.contextManifest[1]]);

  assert.deepEqual(mergeObservedTaskContext(task, [{
    path: "README.md",
    reason: "Another model-supplied reason."
  }], 8), []);
  assert.equal(task.contextManifest[0].reason, "Model says this file was read.");

  assert.deepEqual(mergeObservedTaskContext(task, [{
    path: "README.md",
    reason: "Runtime observed successful source read."
  }], 8), ["README.md"]);
  assert.equal(task.contextManifest[0].reason, "Runtime observed successful source read.");
  assert.equal(hasDurableContextEvidence(task), true);
});
