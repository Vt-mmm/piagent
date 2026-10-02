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

test("task workflow delegates evidence and final gating to runtime hooks", () => {
  const task = readPrompt("task");
  assert.match(task, /Risk-adaptive enrichment:/);
  assert.match(task, /piagent_task_start` exactly once/);
  assert.match(task, /Automatic tasks need no lifecycle calls/);
  assert.match(task, /runtime-created contract/);
  assert.doesNotMatch(task, /piagent_task_progress/);
  assert.match(task, /runtime hooks record context, changed files, verification, trace, and final-gate state/i);
  assert.match(task, /at most one bounded read-only finder pass/);
  assert.doesNotMatch(task, /piagent_(?:context_record|verify_record|trace_record|task_gate_check|context_engine)/);
  assert.doesNotMatch(task, /Mandatory flow:/);
  assert.ok(
    task.indexOf("piagent_task_start` exactly once") < task.indexOf("Read the likely target"),
    "task intake must precede exploratory reads so read evidence is not repeated before the contract"
  );
});

test("narrow scout does not force full context or a persisted task contract", () => {
  const scout = readPrompt("scout");
  assert.match(scout, /Read targeted current files/);
  assert.match(scout, /only for a broad governed scout/);
  assert.match(scout, /one bounded finder pass/);
  assert.match(scout, /Do not call diagnostic Piagent tools for a routine scout/);
  assert.doesNotMatch(scout, /piagent_(?:context_preflight|context_budget|context_engine|exec_policy_check)/);
  assert.doesNotMatch(scout, /detail=full/);
});

// The prompts above are no longer loaded by Pi (the package dropped pi.prompts
// with the 2026-09-30 task-contract retirement); the project template and the
// skill still are, so they must not teach a tool that is gone.
test("project and skill instructions keep routine tool choreography bounded", () => {
  const projectInstructions = fs.readFileSync(path.join(root, "templates", "project", "AGENTS.md"), "utf8");
  const skill = fs.readFileSync(path.join(root, "packages", "piagent-core", "skills", "piagent-ops", "SKILL.md"), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /Ordinary work needs nothing from it/);
  for (const instructions of [projectInstructions, skill]) {
    assert.match(instructions, /(?:Read|Inspect) the narrow target/);
    assert.match(instructions, /protected paths/i);
    assert.doesNotMatch(instructions, /piagent_(?:task_start|task_progress|context_record|verify_record|trace_record|task_gate_check|context_preflight|exec_policy_check|tool_policy_check|context_budget)/);
    assert.doesNotMatch(instructions, /task contract is required|\/workflow|\/onboard/i);
  }
});
