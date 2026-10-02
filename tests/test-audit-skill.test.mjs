import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The packaged test-audit skill: Pi loads it from the package's skill folder as
// a model-invocable skill, and its text names no other project or product.
const root = path.resolve(import.meta.dirname, "..");
const skillDir = path.join(root, "packages", "piagent-core", "skills", "test-audit");
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), ".pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent");

test("Pi loads test-audit from the package as a model-invocable skill", { skip: !fs.existsSync(sdkRoot) }, async () => {
  const { loadSkillsFromDir } = await import(pathToFileURL(path.join(sdkRoot, "dist", "index.js")).href);
  const { skills, diagnostics } = loadSkillsFromDir({ dir: path.join(root, "packages", "piagent-core", "skills"), source: "package" });
  const skill = skills.find((item) => item.name === "test-audit");
  assert.ok(skill, JSON.stringify(diagnostics));
  assert.match(skill.description, /writing, changing, reviewing, or sweeping tests/);
  assert.notEqual(skill.disableModelInvocation, true);
});

test("the skill is one file in this package's words, with the repository's own checks", () => {
  assert.deepEqual(fs.readdirSync(skillDir), ["SKILL.md"]);
  const text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(text, /AGENTS\.md` "Checks"/);
  assert.match(text, /Commit or push only when the member asks/);
  // The skill points only at this repository: no outside links, no outside test runner.
  assert.doesNotMatch(text, /https?:\/\/|vitest/i);
});
