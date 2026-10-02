import assert from "node:assert/strict";
import test from "node:test";
import { publicWordingViolations } from "../scripts/check-public-wording.mjs";

test("public wording names no other agent product and makes no product comparison", () => {
  for (const file of ["README.md", "packages/piagent-core/runtime/example.ts", "docs/piagent-core-improvement-plan.md"]) {
    assert.equal(publicWordingViolations(file, "Claude Code").length, 1);
    assert.equal(publicWordingViolations(file, "<!-- research -->\nCodex CLI")[0].line, 2);
    assert.equal(publicWordingViolations(file, "a bounded retrieval route, Windsurf-style").length, 1);
  }
  assert.equal(publicWordingViolations("docs/plan.md", "A Codex-inspired product").length, 1);
  assert.equal(publicWordingViolations("docs/plan.md", "Pi vs Codex").length, 1);
  assert.equal(publicWordingViolations("docs/plan.md", "CODEX-GRADE").length, 1);
  assert.deepEqual(publicWordingViolations("docs/plan.md", "Sessions run like OpenHands and Aider").map((v) => v.keyword), ["OpenHands", "Aider"]);
  // Ordinary words that contain a name are not mentions.
  assert.deepEqual(publicWordingViolations("docs/plan.md", "The request was declined; a cursor pages the results."), []);
});
