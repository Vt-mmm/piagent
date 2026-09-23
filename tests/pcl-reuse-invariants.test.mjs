import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EditFreshnessGuard } from "../packages/piagent-core/runtime/quality/edit-freshness-guard.ts";
import { classifyToolFailure } from "../packages/piagent-core/runtime/inspection/tool-failure-classification.ts";
import { buildEditRecoveryContext } from "../packages/piagent-core/runtime/recovery/edit-recovery-context.ts";
import { formatRepositoryMemoryHints } from "../packages/piagent-core/runtime/context/repository-memory-hints.ts";
import { hasDurableContextEvidence } from "../packages/piagent-core/extensions/context-evidence.js";

test("rename and partial prior edits never retarget or roll back successful source during recovery", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pcl-freshness-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const ctx = { cwd, sessionManager: { getSessionId: () => "session" } }, guard = new EditFreshnessGuard();
  fs.writeFileSync(path.join(cwd, "old.ts"), "const alpha = 1;\nconst beta = 1;\n");
  guard.observe(ctx, "run", ["old.ts"], "read");
  fs.writeFileSync(path.join(cwd, "old.ts"), "const alpha = 2;\nconst beta = 1;\n");
  guard.observe(ctx, "run", ["old.ts"], "mutation");
  const recovery = buildEditRecoveryContext({ cwd, targetPath: "old.ts", reasonCode: "edit-anchor-stale", protectedPaths: [] });
  assert.match(recovery.text, /const alpha = 2/);
  assert.doesNotMatch(recovery.text, /const alpha = 1/);
  fs.renameSync(path.join(cwd, "old.ts"), path.join(cwd, "renamed.ts"));
  assert.deepEqual(guard.evaluate(ctx, "run", ["old.ts"]).stalePaths, ["old.ts"]);
  assert.equal(guard.evaluate(ctx, "run", ["renamed.ts"]).decision, "unobserved");
  assert.equal(buildEditRecoveryContext({ cwd, targetPath: "old.ts", reasonCode: "edit-anchor-stale", protectedPaths: [] }), undefined);
  assert.equal(fs.readFileSync(path.join(cwd, "renamed.ts"), "utf8"), "const alpha = 2;\nconst beta = 1;\n");
});
test("error classification and advisory memory cannot convert missing paths or failed code into current evidence", () => {
  assert.equal(classifyToolFailure("edit", true, "Found 2 occurrences of oldText"), "edit-anchor-not-unique");
  assert.equal(classifyToolFailure("edit", true, "Could not find the exact text"), "edit-anchor-stale");
  assert.equal(classifyToolFailure("read", true, "ENOENT no such file or directory"), "target-not-found");
  assert.equal(classifyToolFailure("read", true, "EACCES permission denied"), "tool-result-failed");
  assert.equal(classifyToolFailure("bash", true, "AssertionError after successful edit"), "tool-result-failed");
  const hint = formatRepositoryMemoryHints([{ record: { id: "old-fact", fact: "The old source used alpha = 1.", citations: [{ path: "old.ts" }] }, matchedTerms: ["alpha"] }], 400);
  assert.match(hint.text, /advisory only/);
  assert.match(hint.text, /cited current file/);
  assert.equal(hasDurableContextEvidence({ contextManifest: [{ path: "old.ts", reason: hint.text }], memoryCitations: [{ path: "old.ts" }] }), false);
});
