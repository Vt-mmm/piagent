import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import http from "node:http";
import { prepareClaudeModelAdditions } from "../scripts/claude-model-additions.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "models.json") };
}
test("reviewed addition preserves credentials, custom models and native context", t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ providers: { anthropic: { apiKey: "$TEST_KEY", models: [{ id: "custom", contextWindow: 12000 }] }, agent_watch_claude: { baseUrl: "http://127.0.0.1:17922" } } }));
  prepareClaudeModelAdditions(file).apply();
  const data = JSON.parse(fs.readFileSync(file));
  assert.equal(data.providers.anthropic.apiKey, "$TEST_KEY");
  assert.equal(data.providers.anthropic.models[0].contextWindow, 12000);
  const added = data.providers.anthropic.models[1];
  assert.equal(added.id, "claude-sonnet-5-5");
  assert.equal(added.contextWindow, 1_000_000);
  assert.equal(added.maxTokens, 128_000);
  assert.equal(added.thinkingLevelMap.off, null);
  assert.equal(added.compat.supportsTemperature, false);
  assert.equal(data.providers.agent_watch_claude.baseUrl, "http://127.0.0.1:17922");
  // Claude Haiku 5.5 (2026-10-07): the official tiered price, five times above 100k input tokens.
  const haiku = data.providers.anthropic.models.find(model => model.id === "claude-haiku-5-5");
  assert.deepEqual([haiku.contextWindow, haiku.maxTokens, haiku.cost.input, haiku.cost.output, haiku.cost.cacheRead],
    [1_000_000, 128_000, 0.1, 0.5, 0.01]);
  assert.deepEqual(haiku.cost.tiers, [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }]);
  assert.equal(haiku.thinkingLevelMap.off, null);
  assert.equal(prepareClaudeModelAdditions(file), null);
});
test("never overwrites existing model, custom endpoint or concurrent edit", t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-sonnet-5-5", contextWindow: 800000 }] } } }));
  prepareClaudeModelAdditions(file).apply();
  const kept = JSON.parse(fs.readFileSync(file)).providers.anthropic.models;
  assert.deepEqual(kept.map(model => [model.id, model.contextWindow]), [["claude-sonnet-5-5", 800000], ["claude-haiku-5-5", 1_000_000]],
    "an existing entry is kept as it is; only the missing model is added");
  assert.equal(prepareClaudeModelAdditions(file), null);
  fs.writeFileSync(file, JSON.stringify({ providers: { anthropic: { baseUrl: "https://example.invalid" } } }));
  assert.equal(prepareClaudeModelAdditions(file), null);
  fs.writeFileSync(file, "{}"); const plan = prepareClaudeModelAdditions(file);
  fs.writeFileSync(file, '{"changed":true}');
  assert.throws(() => plan.apply(), /changed/);
});
test("dry-run writes neither settings nor catalog; explicit setup works outside repo", t => {
  const { dir, file } = fixture(t), settings = path.join(dir, "settings.json");
  const script = path.resolve("scripts/configure-model-scope.sh");
  const args = [script, "--preset", "claude", "--settings", settings, "--default-model", "anthropic/claude-sonnet-5-5:high"];
  const dry = spawnSync("bash", [...args, "--dry-run"], { cwd: dir, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(settings), false);
  const applied = spawnSync("bash", args, { cwd: dir, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(fs.readFileSync(settings)).defaultModel, "claude-sonnet-5-5");
  // Pi reads this isolated catalog without credentials or any provider request.
  const listed = spawnSync("pi", ["--list-models", "sonnet-5-5"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: dir, ANTHROPIC_API_KEY: "synthetic-catalog-only", PIAGENT_NO_UPDATE_CHECK: "1" }, encoding: "utf8", timeout: 30000
  });
  if (listed.error?.code === "ENOENT") return t.diagnostic("native Pi not installed; catalog CLI check not run");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /claude-sonnet-5-5/);
});

test("installed Pi sends Sonnet 5.5 adaptive request and reads a synthetic SSE response", { timeout: 35000 }, async t => {
  if (spawnSync("pi", ["--version"], { encoding: "utf8" }).error?.code === "ENOENT") return t.skip("Pi CLI is not installed");
  const { dir, file } = fixture(t);
  prepareClaudeModelAdditions(file).apply();
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "synthetic", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic-ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ];
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const data = JSON.parse(fs.readFileSync(file));
  data.providers.anthropic.baseUrl = `http://127.0.0.1:${server.address().port}`;
  data.providers.anthropic.apiKey = "synthetic-local-only";
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [], extensions: [], checkForUpdates: false }));
  const child = spawn("pi", ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--provider", "anthropic", "--model", "claude-sonnet-5-5", "--thinking", "high", "--print", "Reply briefly."], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, ANTHROPIC_API_KEY: "synthetic-local-only", PIAGENT_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "", error = ""; child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { error += c; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, error); assert.match(output, /synthetic-ok/); assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "claude-sonnet-5-5");
  assert.equal(bodies[0].thinking.type, "adaptive");
  assert.equal(bodies[0].thinking.budget_tokens, undefined);
  assert.equal(bodies[0].temperature, undefined);
  assert.equal(bodies[0].output_config.effort, "high");
});
test("company sessions know Claude Haiku 5.5 although the pinned Pi does not", async () => {
  const { nativeManagedModel } = await import("../packages/piagent-core/managed/native-catalog.mjs");
  const runtime = { getModel: () => undefined };
  const haiku = nativeManagedModel(runtime, "anthropic", "claude-haiku-5-5");
  assert.deepEqual([haiku.name, haiku.contextWindow, haiku.maxTokens, haiku.cost.tiers[0].inputTokensAbove], ["Claude Haiku 5.5", 1_000_000, 128_000, 100000]);
  haiku.cost.input = 9;
  assert.equal(nativeManagedModel(runtime, "anthropic", "claude-haiku-5-5").cost.input, 0.1, "each caller gets its own copy");
  const native = { id: "claude-haiku-5-5", contextWindow: 1 };
  assert.equal(nativeManagedModel({ getModel: () => native }, "anthropic", "claude-haiku-5-5"), native, "a Pi that knows it wins");
});
