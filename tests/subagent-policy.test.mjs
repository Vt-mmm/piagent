import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const subagentsDir = path.join(repoRoot, "packages", "piagent-core", "subagents");
const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
const mutationTools = new Set(["bash", "edit", "write", "apply_patch"]);

function frontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, `${path.basename(file)} must have frontmatter`);
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/))
      .filter(Boolean)
      .map((item) => [item[1], item[2].trim()])
  );
}

describe("subagent capability policy", () => {
  it("keeps every read-only role on the audited read-only tool allowlist", () => {
    const files = fs.readdirSync(subagentsDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(subagentsDir, name));

    for (const file of files) {
      const config = frontmatter(file);
      if (config.acceptanceRole !== "read-only") continue;
      const tools = (config.tools ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      assert.ok(tools.length > 0, `${path.basename(file)} must declare an explicit read-only tool allowlist`);
      assert.deepEqual(
        tools.filter((tool) => !readOnlyTools.has(tool)),
        [],
        `${path.basename(file)} grants a non-read-only tool`
      );
    }
  });

  it("keeps mutation tools available only on an explicit writer role", () => {
    const reviewer = frontmatter(path.join(subagentsDir, "piagent-reviewer.md"));
    const worker = frontmatter(path.join(subagentsDir, "piagent-worker.md"));
    const reviewerTools = new Set(reviewer.tools.split(",").map((item) => item.trim()));
    const workerTools = new Set(worker.tools.split(",").map((item) => item.trim()));

    assert.equal(reviewer.acceptanceRole, "read-only");
    assert.equal([...mutationTools].some((tool) => reviewerTools.has(tool)), false);
    assert.equal(worker.acceptanceRole, "writer");
    assert.equal([...mutationTools].every((tool) => workerTools.has(tool)), true);
  });

  it("does not ask the reviewer to use capabilities its allowlist revokes", () => {
    const reviewer = fs.readFileSync(path.join(subagentsDir, "piagent-reviewer.md"), "utf8");
    assert.match(reviewer, /Never edit files or run mutation commands/);
    assert.doesNotMatch(reviewer, /\b(?:autofix|contact_supervisor|corrective edits?)\b/i);
  });

  it("keeps every packaged helper on fresh context, zero retry, and a bounded turn budget", () => {
    for (const name of fs.readdirSync(subagentsDir).filter((entry) => entry.endsWith(".md"))) {
      const config = frontmatter(path.join(subagentsDir, name));
      assert.equal(config.inheritProjectContext, "false", `${name} must not inherit parent project history`);
      assert.equal(config.defaultContext, "fresh", `${name} must start from fresh context`);
      assert.equal(config.turnBudget, '{"maxTurns":8,"graceTurns":0}', `${name} must fail once without grace retries`);
      assert.equal(config.helperRequestSchemaVersion, "2", `${name} must require HelperRequest v2`);
    }
  });

  it("clamps every compatibility preset to one read-only helper and disables worker surfaces", () => {
    const script = path.join(repoRoot, "scripts", "configure-subagents.sh");
    for (const preset of ["minimal", "safe", "async", "parallel"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `piagent-subagents-${preset}-`));
      const result = spawnSync("bash", [script, "--preset", preset, "--config", path.join(root, "config.json"), "--settings", path.join(root, "settings.json"), "--dry-run"], { encoding: "utf8" });
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.config.globalConcurrencyLimit, 1);
      assert.equal(report.config.maxSubagentSpawnsPerSession, 1);
      assert.equal(report.config.parallel.maxTasks, 1);
      assert.equal(report.config.parallel.concurrency, 1);
      assert.equal(report.config.waitTool.enabled, false);
      assert.equal(report.config.intercomBridge.mode, "off");
      assert.equal(report.settingsSubagents.disableBuiltins, true);
      assert.equal(report.settingsSubagents.agentOverrides.worker.disabled, true);
      assert.equal(report.settingsSubagents.agentOverrides["piagent-worker"].disabled, true);
    }
  });
});
