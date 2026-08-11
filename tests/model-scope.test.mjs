import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function configureDefault(input) {
  const args = ["scripts/configure-model-scope.sh", "--dry-run", "--preset", "codex"];
  if (input) args.push("--default-model", input);
  const result = spawnSync("bash", args, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("model scope defaults", () => {
  it("uses gpt-5.5 high consistently for the Codex default and cycle scope", () => {
    const settings = configureDefault();
    assert.equal(settings.defaultProvider, "openai-codex");
    assert.equal(settings.defaultModel, "gpt-5.5");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.5:high"));
    assert.ok(!settings.enabledModels.includes("openai-codex/gpt-5.5:xhigh"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-luna:medium"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-terra:high"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-sol:high"));
  });

  it("falls back to high without a suffix and preserves an explicit override", () => {
    assert.equal(configureDefault("openai-codex/gpt-5.5").defaultThinkingLevel, "high");
    assert.equal(configureDefault("openai-codex/gpt-5.5:xhigh").defaultThinkingLevel, "xhigh");
  });

  it("keeps the global settings template on the same default", () => {
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "templates", "global", "settings.json"), "utf8"));
    assert.equal(template.defaultProvider, "openai-codex");
    assert.equal(template.defaultModel, "gpt-5.5");
    assert.equal(template.defaultThinkingLevel, "high");
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.5:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-luna:medium"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-terra:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-sol:high"));

    const projectTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "templates", "project", ".pi", "settings.json"), "utf8"));
    const repositorySettings = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".pi", "settings.json"), "utf8"));
    assert.equal(projectTemplate.defaultThinkingLevel, "high");
    assert.equal(repositorySettings.defaultThinkingLevel, "high");
  });
});
