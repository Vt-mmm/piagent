import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
  it("uses gpt-6-sol high consistently for the Codex default and cycle scope", () => {
    const settings = configureDefault();
    assert.equal(settings.defaultProvider, "openai-codex");
    assert.equal(settings.defaultModel, "gpt-6-sol");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.5:high"));
    assert.ok(!settings.enabledModels.includes("openai-codex/gpt-5.5:xhigh"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-luna:medium"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-terra:high"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-5.6-sol:high"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-luna:medium"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-sol:medium"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-sol:high"));
    assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-astra:xhigh"));
    assert.ok(settings.enabledModels.includes("openai-codex/*"));
  });

  it("falls back to high without a suffix and preserves an explicit override", () => {
    assert.equal(configureDefault("openai-codex/gpt-6-sol").defaultThinkingLevel, "high");
    assert.equal(configureDefault("openai-codex/gpt-6-astra:xhigh").defaultThinkingLevel, "xhigh");
  });

  it("keeps the global settings template on the same default", () => {
    const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "templates", "global", "settings.json"), "utf8"));
    assert.equal(template.defaultProvider, "openai-codex");
    assert.equal(template.defaultModel, "gpt-6-sol");
    assert.equal(template.defaultThinkingLevel, "high");
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.5:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-luna:medium"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-terra:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-5.6-sol:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-6-luna:medium"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-6-sol:high"));
    assert.ok(template.enabledModels.includes("openai-codex/gpt-6-astra:xhigh"));
    assert.ok(template.enabledModels.includes("openai-codex/*"));

    const projectTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "templates", "project", ".pi", "settings.json"), "utf8"));
    const repositorySettings = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ".pi", "settings.json"), "utf8"));
    assert.equal(projectTemplate.defaultThinkingLevel, "high");
    assert.equal(repositorySettings.defaultThinkingLevel, "high");
  });
});

// Installs and updates (piagent-update, the dashboard's update, piagent-setup)
// keep what the member chose; only a first install sets the default model and
// list, and an update adds only models new to that release.
describe("model scope keeps the member's choices", () => {
  function configure(settingsPath, ...extra) {
    const result = spawnSync("bash", ["scripts/configure-model-scope.sh", "--preset", "codex", "--settings", settingsPath, ...extra], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  }
  const temporary = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-model-scope-"));
    return { directory, settings: path.join(directory, "settings.json"), record: path.join(directory, "piagent-model-scope.json") };
  };

  it("sets the defaults on a first install and records what it offered", () => {
    const t = temporary();
    try {
      const { settings } = configure(t.settings, "--keep-member-choices");
      assert.equal(settings.defaultModel, "gpt-6-sol");
      assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-astra:xhigh"));
      assert.deepEqual(JSON.parse(fs.readFileSync(t.record, "utf8")).offered, settings.enabledModels);
    } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
  });

  it("keeps the member's default and list, adds only newly offered models and never re-adds a removed one", () => {
    const t = temporary();
    try {
      const preset = configure(t.settings).settings.enabledModels;
      // The member chose another default and dropped gpt-5.5; the last release
      // had not offered gpt-6-astra yet.
      const mine = preset.filter((model) => model !== "openai-codex/gpt-5.5:high" && model !== "openai-codex/gpt-6-astra:xhigh");
      fs.writeFileSync(t.settings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5", defaultThinkingLevel: "high", enabledModels: mine, packages: ["npm:extra@1.0.0"] }));
      fs.writeFileSync(t.record, JSON.stringify({ version: 1, preset: "codex", offered: preset.filter((model) => model !== "openai-codex/gpt-6-astra:xhigh") }));
      const { settings, stdout } = configure(t.settings, "--keep-member-choices");
      assert.equal(settings.defaultProvider, "anthropic");
      assert.equal(settings.defaultModel, "claude-sonnet-5-5");
      assert.deepEqual(settings.enabledModels, [...mine, "openai-codex/gpt-6-astra:xhigh"]);
      assert.ok(!settings.enabledModels.includes("openai-codex/gpt-5.5:high"), "a model the member removed comes back");
      assert.deepEqual(settings.packages, ["npm:extra@1.0.0"]);
      assert.match(stdout, /kept the member's default: anthropic\/claude-sonnet-5-5:high/);
      assert.match(stdout, /added openai-codex\/gpt-6-astra:xhigh/);
    } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
  });

  it("leaves a list from before the record alone, and starts the record", () => {
    const t = temporary();
    try {
      fs.writeFileSync(t.settings, JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-6-luna", enabledModels: ["openai-codex/gpt-6-luna:medium"] }));
      const { settings } = configure(t.settings, "--keep-member-choices");
      assert.deepEqual(settings.enabledModels, ["openai-codex/gpt-6-luna:medium"]);
      assert.equal(settings.defaultModel, "gpt-6-luna");
      assert.ok(fs.existsSync(t.record));
    } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
  });

  it("still applies the preset when run by hand (piagent-model-scope)", () => {
    const t = temporary();
    try {
      fs.writeFileSync(t.settings, JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5", enabledModels: ["anthropic/claude-sonnet-5-5"] }));
      const { settings } = configure(t.settings, "--default-model", "openai-codex/gpt-6-astra:xhigh");
      assert.equal(settings.defaultModel, "gpt-6-astra");
      assert.ok(settings.enabledModels.includes("openai-codex/gpt-6-sol:high"));
      assert.ok(!settings.enabledModels.includes("anthropic/claude-sonnet-5-5"));
    } finally { fs.rmSync(t.directory, { recursive: true, force: true }); }
  });
});
