import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPrompt(name) {
  return fs.readFileSync(
    path.join(root, "packages", "piagent-core", "prompts", `${name}.md`),
    "utf8"
  );
}

test("task workflow keeps mandatory safety gates but adapts advisory work by risk", () => {
  const task = readPrompt("task");
  assert.match(task, /Risk-adaptive enrichment:/);
  assert.match(task, /`tiny`: use only the core flow/);
  assert.match(task, /piagent_verify_record/);
  assert.match(task, /piagent_task_gate_check/);
  assert.match(task, /piagent_context_engine/);
  assert.match(task, /at most one bounded read-only finder pass/);
  assert.match(task, /runtime guards still apply/);
  assert.doesNotMatch(task, /Mandatory flow:/);
});

test("narrow scout does not force full context or a persisted task contract", () => {
  const scout = readPrompt("scout");
  assert.match(scout, /For a narrow lookup/);
  assert.match(scout, /concise detail/);
  assert.match(scout, /only for a broad governed scout/);
  assert.match(scout, /piagent_context_engine/);
  assert.match(scout, /one bounded finder pass/);
  assert.doesNotMatch(scout, /detail=full/);
});
