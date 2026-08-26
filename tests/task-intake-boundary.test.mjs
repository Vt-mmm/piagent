import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticReadOnlyTaskIntakeEligible,
  automaticTaskIntakeEligible,
  automaticTaskIntakeMode,
  automaticTaskMutationPolicy,
  isLightweightNonAuthorizingChangeContinuation,
  isNonAuthorizingChangeClarification,
  manualTaskIntakeEligible
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

test("change questions and choices do not authorize durable source-change intake", () => {
  const questions = [
    ["Vậy bây giờ a cần test hay em có thể fix ngay", true],
    ["Vậy bây giờ anh cần test hay em có thể sửa ngay?", true],
    ["Có nên test trước hay sửa ngay?", true],
    ["Anh cần fix ngay hay test trước?", true],
    ["Should I test or can you fix it now?", true],
    ["Do we need to test first, or should you implement the fix?", true],
    ["Can we implement the change now or discuss it first?", true],
    ["Should we implement the fix now?", true],
    ["Can I fix it now?", true],
    ["How should we implement this safely?", false],
    ["Why should we change the current implementation?", false],
    ["Vậy bây giờ có nên sửa ngay không?", true],
    ["Anh có cần fix ngay không?", true],
    ["Em fix được ngay hay anh cần test trước?", true],
    ["Anh nên test trước hay em sửa luôn?", true],
    ["Vậy chốt là test hay fix?", true]
  ];
  for (const [prompt, lightweight] of questions) {
    assert.equal(isNonAuthorizingChangeClarification(prompt), true, prompt);
    assert.equal(isLightweightNonAuthorizingChangeContinuation(prompt), lightweight, prompt);
    assert.equal(automaticTaskIntakeEligible(prompt, []), false, prompt);
    assert.equal(manualTaskIntakeEligible(prompt, []), false, prompt);
    assert.equal(automaticTaskIntakeMode(prompt, []), undefined, prompt);
  }
});

test("explicit Vietnamese and English implementation requests remain mutation-capable", () => {
  const requests = [
    "fix đi",
    "Tiến hành sửa",
    "Oke, sửa luôn cho anh.",
    "Vậy bây giờ anh fix ngay đi em.",
    "Please implement the approved fix and run tests.",
    "Can you implement the approved fix now?",
    "Could you please fix src/cart.ts?",
    "Can you fix or replace the parser?",
    "Could you implement the fix or update the tests?",
    "Please fix the parser or replace it?",
    "Go ahead and apply the fix.",
    "Proceed with the implementation.",
    "Fix or replace the parser and run tests."
  ];
  for (const prompt of requests) {
    assert.equal(isNonAuthorizingChangeClarification(prompt), false, prompt);
    assert.equal(isLightweightNonAuthorizingChangeContinuation(prompt), false, prompt);
    assert.equal(automaticTaskIntakeEligible(prompt, []), true, prompt);
    assert.equal(manualTaskIntakeEligible(prompt, []), true, prompt);
    assert.equal(automaticTaskIntakeMode(prompt, []), "source-change", prompt);
    assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
  }
  assert.equal(isNonAuthorizingChangeClarification("/task Should I test or can you fix it now?"), false);
  assert.equal(automaticTaskIntakeMode("/task Should I test or can you fix it now?", []), "source-change");
});

test("canonical workflow intent controls durable automatic intake", () => {
  const cases = [
    ["/task Implement src/example.ts and run tests.", "source-change"],
    ["/scout Inspect src/example.ts as a read-only task. Do not edit any file.", "read-only"],
    ["/be-to-fe Implement src/example.ts from the backend contract and run tests.", "source-change"],
    ["/discuss Implement src/example.ts after we agree on the behavior.", undefined],
    ["/plan Implement src/example.ts and run tests after the plan is approved.", undefined],
    ["/review Inspect src/example.ts as a read-only task. Do not edit any file.", "read-only"],
    ["/commit Run tests and commit the current changes.", undefined],
    ["/pr Review the diff and prepare the pull request.", undefined],
    ["/onboard Inspect the repository and configure its profile.", undefined],
    ["/platform-improve Implement src/example.ts and run tests.", "source-change"]
  ];
  for (const [prompt, expected] of cases) assert.equal(automaticTaskIntakeMode(prompt, []), expected, prompt);
  for (const prompt of [
    "/plan run tests and explain the implementation sequence",
    "/plan implement the approved design after planning",
    "/discuss inspect the code in read-only mode",
    "/discuss implement the idea after clarification"
  ]) {
    assert.equal(automaticTaskIntakeEligible(prompt, []), false, prompt);
    assert.equal(automaticReadOnlyTaskIntakeEligible(prompt, []), false, prompt);
  }
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
