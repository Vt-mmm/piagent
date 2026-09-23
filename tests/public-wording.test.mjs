import assert from "node:assert/strict";
import test from "node:test";
import { publicWordingViolations } from "../scripts/check-public-wording.mjs";

test("public wording preserves named research sources without allowing product comparisons", () => {
  const research = "docs/piagent-core-reasoning-research-2026-09-06.md";
  assert.deepEqual(publicWordingViolations(research, "Claude Code quality postmortem"), []);
  assert.equal(publicWordingViolations(research, "A Codex-inspired product").length, 1);
  assert.equal(publicWordingViolations(research, "Pi vs Codex").length, 1);
  for (const file of ["README.md", "packages/piagent-core/runtime/example.ts", "docs/unreviewed-research.md"]) {
    assert.equal(publicWordingViolations(file, "Claude Code").length, 1);
    assert.equal(publicWordingViolations(file, "<!-- research -->\nCodex CLI")[0].line, 2);
  }
  assert.equal(publicWordingViolations(research, "CODEX-GRADE").length, 1);
});
