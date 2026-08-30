import assert from "node:assert/strict";
import test from "node:test";
import { classifyConditionalRepairIntent } from "../packages/piagent-core/runtime/workflows/task-repair-intent.ts";
import { automaticTaskIntakeMode, automaticTaskMutationPolicy } from "../packages/piagent-core/runtime/workflows/task-intake.ts";

test("inspection distance does not turn conditional repair into mandatory source changes", () => {
  const endings = ["Fix a defect only if verification exposes one.", "Fix only if a test fails.", "Only repair when the verifier detects an error."];
  for (const repeat of [0, 10, 100, 180]) {
    for (const ending of endings) {
      const prompt = `Verify this API. ${"The declared deadline is inclusive. ".repeat(repeat)} ${ending}`;
      assert.equal(classifyConditionalRepairIntent(prompt), "conditional-only", `${repeat}: ${ending}`);
      assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "allowed");
      assert.equal(automaticTaskIntakeMode(prompt, []), "source-change");
    }
  }
});

test("a conditional follow-up cannot erase an unconditional implementation obligation", () => {
  for (const prompt of [
    "Implement the new API. Verify it and fix if needed.",
    "Implement the new API and verify it and fix if needed.",
    "Review existing source. Implement the new API, then fix any issues.",
    "Verify the module and fix any issues. Add the new endpoint.",
    "Fix the known parser failure now. Run tests and fix any additional failure.",
    "Patch the known parser defect now. Verify it and fix if needed.",
    "Address the known parser defect now. Verify it and fix if needed.",
    "If verification finds an error, fix it, but implement the new API regardless.",
    "Review the code and fix any failures. Regardless, implement the new API.",
    "Implement the new API and if tests fail, fix the failure.",
    "Only implement the new API. Verify it and fix if needed.",
    "1. Add the new parser.\n2. Verify it and fix if needed.",
    "Kiểm tra source. Thêm endpoint mới, rồi sửa nếu có lỗi."
  ]) {
    assert.equal(classifyConditionalRepairIntent(prompt), "mixed", prompt);
    assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
  }
});

test("condition-first and coordinated repairs remain optional while explicit no-edit wins", () => {
  for (const prompt of [
    "If verification exposes a defect, fix it and update the regression test.",
    "Review this API. If needed, repair it.",
    "Kiểm tra lại phần vừa sửa, nếu có lỗi thì sửa.",
    "Kiểm tra API. Chỉ sửa nếu kiểm thử phát hiện lỗi."
  ]) assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "allowed", prompt);
  assert.equal(automaticTaskMutationPolicy("Verify this API. Fix if needed. Do not edit source files.", "source-change"), "forbidden");
});

test("modal and additive implementation clauses retain the mandatory obligation", () => {
  const obligations = [
    "You must implement the new API", "You need to implement the new API",
    "The task must add the new API", "Must implement the new API", "Also implement the new API",
    "Always implement the new API", "Em phải thêm endpoint mới"
  ];
  for (const obligation of obligations) {
    for (const prompt of [
      `${obligation}. Verify the API and fix if needed.`,
      `Verify the API and fix if needed. ${obligation}.`,
      `Verify the API and fix if needed, then ${obligation}.`
    ]) {
      assert.equal(classifyConditionalRepairIntent(prompt), "mixed", prompt);
      assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
    }
  }
});

test("a local prohibition or a repair word in an implementation description cannot erase the main command", () => {
  const mixed = "Implement the new API (do not change README). Verify it and fix if needed.";
  assert.equal(classifyConditionalRepairIntent(mixed), "mixed");
  assert.equal(automaticTaskMutationPolicy(mixed, "source-change"), "required");
  const description = "Implement the new API with a function named fix if needed. Verify it.";
  assert.equal(classifyConditionalRepairIntent(description), "none");
  assert.equal(automaticTaskMutationPolicy(description, "source-change"), "required");
  for (const prompt of ["Could you fix the API if verification fails?", "I need you to fix the API if verification fails."]) {
    assert.equal(classifyConditionalRepairIntent(prompt), "conditional-only", prompt);
  }
});

test("descriptions of prior repairs and domain conditions do not authorize conditional changes", () => {
  for (const prompt of [
    "Kiểm tra phần vừa sửa bị lỗi.",
    "Review the previous fix for failures.",
    "Implement the new API which checks if the caller can fix the record. Run tests.",
    "Verify this API. Do not fix it if a test fails."
  ]) assert.equal(classifyConditionalRepairIntent(prompt), "none", prompt);
  assert.equal(automaticTaskMutationPolicy("Verify the API and fix every failure.", "source-change"), "allowed");
});

test("quoted examples and code are not conditional task authority", () => {
  for (const quoted of ['"Verify and fix if needed."', "`Verify and fix if needed.`", "```text\nVerify and fix if needed.\n```", "> Verify and fix if needed.\n"]) {
    const prompt = `Implement the API. Example input:\n${quoted}\nRun tests.`;
    assert.equal(classifyConditionalRepairIntent(prompt), "none", prompt);
    assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required");
  }
});
