import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticReadOnlyTaskIntakeEligible,
  automaticTaskIntakeEligible,
  automaticTaskIntakeMode,
  automaticTaskMutationPolicy
} from "../packages/piagent-core/runtime/workflows/task-intake.ts";

function policy(prompt) {
  const mode = automaticTaskIntakeMode(prompt, []);
  return { mode, mutationPolicy: automaticTaskMutationPolicy(prompt, mode ?? "source-change") };
}

test("local path constraints remain mutation-capable", () => {
  for (const prompt of [
    "Implement frontend; do not edit files outside v-nexus-frontend/src/**.",
    "Implement frontend; no edits to files outside v-nexus-frontend/src/**.",
    "Implement frontend; no source changes outside v-nexus-frontend/src/**.",
    "Implement frontend without editing files outside v-nexus-frontend/src/**.",
    "Implement frontend; do not edit files, except under v-nexus-frontend/src/**.",
    "Implement frontend; do not edit any files except v-nexus-frontend/src/**.",
    "Implement frontend; do not make changes to backend files.",
    "Only edit v-nexus-frontend/src/** and update the implementation.",
    "Mutate only v-nexus-frontend/src/**; all other paths are read-only."
  ]) {
    assert.deepEqual(policy(prompt), { mode: "source-change", mutationPolicy: "required" }, prompt);
  }
});

test("temporary no-mutation qualifiers defer automatic intake without becoming durable authority", () => {
  for (const prompt of [
    "Prepare src/greeting.js, but do not modify the project yet.",
    "Prepare src/greeting.js, but do not modify the project, yet.",
    "Prepare src/greeting.js, but do not modify the project—not yet.",
    "Prepare src/greeting.js, but do not modify the project for now.",
    "Prepare src/greeting.js, but do not modify the project right now.",
    "Prepare src/greeting.js, but do not modify the project at this stage.",
    "Prepare src/greeting.js, but do not modify the project during this step.",
    "Prepare src/greeting.js without editing files while planning.",
    "Prepare src/greeting.js, but do not modify the project unless approved.",
    "Prepare src/greeting.js, but do not modify the project until approval.",
    "Prepare src/greeting.js, but do not modify the project before implementation."
  ]) {
    assert.equal(automaticTaskIntakeMode(prompt, []), undefined, prompt);
    assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
  }
});

test("the governed source-task inspection prompt remains manual", () => {
  const prompt = "Inspect src/greeting.js and prepare a governed source task, but do not modify the project yet.";
  assert.equal(automaticTaskIntakeEligible(prompt, []), false);
  assert.equal(automaticReadOnlyTaskIntakeEligible(prompt, []), false);
  assert.equal(automaticTaskIntakeMode(prompt, []), undefined);
  assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required");
});

test("domain read-only wording does not become task-wide read-only authority", () => {
  for (const prompt of [
    "Update the read-only task behavior in src/policy.ts.",
    "Implement src/form.ts while documenting read-only mode behavior.",
    "Read-only field behavior must be implemented in src/form.ts.",
    "Convert the read-only review widget in src/review.ts to an editable form."
  ]) {
    assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
  }
});

test("explicit task-wide zero-delta language remains forbidden", () => {
  for (const prompt of [
    "Run tests; do not edit source files.",
    "Run tests and make no code changes.",
    "Inspect src/greeting.js without touching any files.",
    "Leave the project unchanged.",
    "No project files are changed.",
    "This task must remain mutation-free.",
    "Run the configured verifier in read-only mode."
  ]) {
    assert.equal(automaticTaskMutationPolicy(prompt, automaticTaskIntakeMode(prompt, []) ?? "source-change"), "forbidden", prompt);
  }
});
