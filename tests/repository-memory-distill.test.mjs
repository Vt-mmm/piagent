import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readRepositoryMemoryFacts, recordCompletedTaskMemory } from "../packages/piagent-core/extensions/repository-memory.js";

// A completed task is written to repository memory only when it adds
// something: disposable files are left out, and the same files at the same
// digests are not recorded twice.
test("completed tasks skip disposable and already recorded changes", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-distill-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const skipped = [];
  const onSkip = (reason) => skipped.push(reason);
  const digests = { "src/app.js": "wt-content-v2:" + "a".repeat(64) };

  assert.equal(recordCompletedTaskMemory(cwd, { changedFiles: ["dist/app.js", "coverage/lcov.info", "debug.log"] }, { onSkip }), undefined);
  assert.deepEqual(skipped, ["not_durable"]);

  const first = recordCompletedTaskMemory(cwd, { changedFiles: ["src/app.js", "dist/app.js"], finalFileDigests: digests }, { onSkip });
  assert.deepEqual(first.citations.map((c) => c.path), ["src/app.js"]);
  assert.equal(recordCompletedTaskMemory(cwd, { changedFiles: ["src/app.js"], finalFileDigests: digests }, { onSkip }), undefined);
  assert.deepEqual(skipped, ["not_durable", "already_known"]);

  // The same file changed again (a new digest) is new.
  assert.ok(recordCompletedTaskMemory(cwd, { changedFiles: ["src/app.js"], finalFileDigests: { "src/app.js": "wt-content-v2:" + "b".repeat(64) } }, { onSkip }));
  assert.equal(readRepositoryMemoryFacts(cwd).length, 2);
});
