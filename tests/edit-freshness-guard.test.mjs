import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EditFreshnessGuard,
  editFreshnessModeFromEnvironment
} from "../packages/piagent-core/runtime/quality/edit-freshness-guard.ts";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-edit-freshness-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "value.ts"), "export const value = 1;\n");
  const sessionManager = { getSessionId: () => "session-a" };
  return { cwd, sessionManager };
}

test("edit freshness mode is enforce-by-default with explicit observe/off overrides", () => {
  assert.equal(editFreshnessModeFromEnvironment(undefined), "enforce");
  assert.equal(editFreshnessModeFromEnvironment("shadow"), "observe");
  assert.equal(editFreshnessModeFromEnvironment("off"), "off");
});

test("a read snapshot rejects whole-file drift until one fresh read is observed", () => {
  const ctx = fixture(), guard = new EditFreshnessGuard("enforce");
  assert.equal(guard.evaluate(ctx, "task-a", ["src/value.ts"]).decision, "unobserved");
  assert.deepEqual(guard.observe(ctx, "task-a", ["src/value.ts"], "read"), ["src/value.ts"]);
  assert.equal(guard.evaluate(ctx, "task-a", ["src/value.ts"]).decision, "current");

  fs.writeFileSync(path.join(ctx.cwd, "src", "value.ts"), "// external drift\nexport const value = 1;\n");
  const stale = guard.evaluate(ctx, "task-a", ["src/value.ts"]);
  assert.equal(stale.decision, "stale");
  assert.deepEqual(stale.stalePaths, ["src/value.ts"]);
  assert.equal(stale.enforce, true);

  guard.observe(ctx, "task-a", ["src/value.ts"], "read");
  assert.equal(guard.evaluate(ctx, "task-a", ["src/value.ts"]).decision, "current");
});

test("snapshot evidence is task-bound, batch-wide, bounded, and shadow mode does not enforce", () => {
  const ctx = fixture(), guard = new EditFreshnessGuard("observe");
  fs.writeFileSync(path.join(ctx.cwd, "src", "other.ts"), "export const other = 1;\n");
  guard.observe(ctx, "task-a", ["src/value.ts", "src/other.ts"], "read");
  fs.writeFileSync(path.join(ctx.cwd, "src", "other.ts"), "export const other = 2;\n");

  assert.equal(guard.evaluate(ctx, "task-b", ["src/other.ts"]).decision, "unobserved");
  const batch = guard.evaluate(ctx, "task-a", ["src/value.ts", "src/other.ts"]);
  assert.equal(batch.decision, "stale");
  assert.deepEqual(batch.checkedPaths, ["src/value.ts", "src/other.ts"]);
  assert.deepEqual(batch.stalePaths, ["src/other.ts"]);
  assert.equal(batch.enforce, false);

  guard.clear(ctx);
  assert.equal(guard.evaluate(ctx, "task-a", ["src/value.ts"]).decision, "unobserved");
});
