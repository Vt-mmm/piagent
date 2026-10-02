import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { knownModels, piPackageRoot, pruneSettings, stalePatterns } from "../scripts/model-scope-prune.mjs";

const piRoot = piPackageRoot({ ...process.env, PATH: `${os.homedir()}/.pi/npm-global/bin:${process.env.PATH}` });

// Pi warns "No models match pattern" for each of these on every start.
test("only patterns no model matches are removed; a signed-out provider keeps its own", { skip: !piRoot }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-scope-prune-"));
  try {
    const settingsPath = path.join(root, "settings.json");
    const patterns = ["openai-codex/gpt-gone-1:high", "anthropic/claude-sonnet-4-5:high", "openai-codex/*", "*sonnet*", "nobody/*", "custom-lab/tiny"];
    fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: { "custom-lab": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions",
      apiKey: "CUSTOM_LAB_KEY", models: [{ id: "tiny", name: "Tiny", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "openai-codex", enabledModels: patterns, theme: "dark" }, null, 2), { mode: 0o600 });
    // No credentials are used: a provider nobody signed in to still has known models.
    const stale = await stalePatterns(patterns, await knownModels(piRoot, root), piRoot);
    assert.deepEqual(stale, ["openai-codex/gpt-gone-1:high", "nobody/*"]);
    assert.equal(pruneSettings(settingsPath, stale), 4);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(after, { defaultProvider: "openai-codex", enabledModels: ["anthropic/claude-sonnet-4-5:high", "openai-codex/*", "*sonnet*", "custom-lab/tiny"], theme: "dark" });
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
