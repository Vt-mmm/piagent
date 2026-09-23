import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registerTaskUsageHooks } from "../packages/piagent-core/runtime/product/task-usage-hooks.ts";
import { readTaskUsage } from "../packages/piagent-core/runtime/product/task-usage.ts";
import { registerAdaptiveContextGovernor, auditToolProtocol } from "../packages/piagent-core/runtime/session/adaptive-context-governor.ts";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { appendContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";

const sdkRoot = process.env.PIAGENT_REAL_PI_HOST || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
test("pinned SDK hook dispatch, real read tool, repeated terminal and cold telemetry readback reconcile two tasks", { skip: !fs.existsSync(path.join(sdkRoot, "dist/index.js")) }, async (t) => {
  const expected = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).peerDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"))).version, expected);
  const host = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
  const ai = await import(pathToFileURL(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcl-sdk-usage-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "example.txt"), "test-owned source\n");
  const agentDir = path.join(cwd, "agent"), sessionDir = path.join(cwd, "sessions");
  fs.mkdirSync(agentDir); fs.mkdirSync(sessionDir);
  const manager = host.SessionManager.create(cwd, sessionDir);
  const fixture = JSON.parse(fs.readFileSync(new URL("../evals/fixtures/task-contract.valid.json", import.meta.url)));
  const correction = "Correction: preserve Unicode 源🙂, do not send externally, keep the remaining verification obligation.";
  const first = { ...fixture, operatorRequest: correction, operatorRequestDigest: operatorRequestDigest(correction), taskId: "first", taskRunId: "first-run", sessionId: manager.getSessionId() };
  const second = { ...first, taskId: "second", taskRunId: "second-run" };
  let active = first, call = 0;
  const model = { id: "fixture", name: "fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
  const runtime = {
    streamSimple(_model, _context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const index = call++;
      const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: Date.now(),
        content: index === 0 ? [{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "example.txt" } }, { type: "toolCall", id: "read-blocked", name: "read", arguments: { path: "blocked.txt" } },
          { type: "toolCall", id: "read-invalid", name: "read", arguments: {} }] : index === 2 ? [{ type: "toolCall", id: "read-truncated", name: "read", arguments: { path: "example.txt" } }] : [{ type: "text", text: "fixture complete" }],
        stopReason: index === 0 ? "toolUse" : index === 2 ? "length" : "stop", usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 22, cost: { total: 0.1 } } };
      queueMicrotask(async () => {
        try { await options.onPayload?.({ fixture: true }, model); stream.push({ type: "done", reason: message.stopReason, message }); }
        catch (error) { stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }); }
      });
      return stream;
    },
    hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "synthetic-fixture" }, env: {} }), getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}
  };
  const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 } }, { projectTrusted: true });
  const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Test-owned scripted runtime.",
    extensionFactories: [{ name: "pcl-usage", factory: (pi) => {
      const dependencies = { activeTask: () => active, telemetry: (_ctx, event) => appendContextTelemetry(cwd, event) };
      registerTaskUsageHooks(pi, dependencies);
      pi.on("tool_call", event => event.toolCallId === "read-blocked" ? { block: true, reason: "fixture blocked" } : undefined);
      registerAdaptiveContextGovernor(pi, dependencies);
    } }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await host.createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "off",
    settingsManager, resourceLoader: loader, sessionManager: manager, tools: ["read"] });
  const errors = [];
  session.extensionRunner.onError((error) => errors.push(error));
  let sessionFile;
  try {
    await session.bindExtensions({ mode: "json" });
    await session.prompt("Read the fixture", { expandPromptTemplates: false });
    const realRead = manager.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "read-one");
    assert.equal(realRead.message.isError, false);
    assert.match(JSON.stringify(realRead.message.content), /test-owned source/);
    active = second;
    await session.prompt("A separate fixture task", { expandPromptTemplates: false });
    active = first;
    for (let index = 0; index < 16; index++) {
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect current source" }], timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: `historical-${index}`, name: "read", arguments: { path: "example.txt" } }],
        api: "fixture", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
      manager.appendMessage({ role: "toolResult", toolCallId: `historical-${index}`, toolName: "read", content: [{ type: "text", text: "源🙂".repeat(4000) }], isError: false, timestamp: Date.now() });
    }
    manager.appendMessage({ role: "user", content: [{ type: "text", text: correction }], timestamp: Date.now() });
    session.agent.state.messages = manager.buildSessionContext().messages;
    const beforeCompact = call;
    await session.compact();
    assert.equal(call, beforeCompact, "governor override must not call the scripted summarizer");
    const compacted = manager.getEntries().findLast((entry) => entry.type === "compaction");
    assert.equal(compacted.details.deterministic, true);
    assert.match(compacted.summary, /preserve Unicode 源🙂/);
    assert.equal(auditToolProtocol(manager.buildSessionContext().messages).intact, true);
    sessionFile = session.sessionFile;
  } finally { session.dispose(); }
  assert.deepEqual(errors, []);
  assert.equal(call, 4);
  const reopened = host.SessionManager.open(sessionFile, sessionDir);
  const coldContext = reopened.buildSessionContext().messages;
  assert.match(JSON.stringify(coldContext), /preserve Unicode 源🙂/);
  assert.equal(auditToolProtocol(coldContext).intact, true);
  assert.equal(reopened.getSessionId(), first.sessionId);
  assert.equal(readTaskUsage(cwd, first).tokens, 44);
  assert.equal(readTaskUsage(cwd, second).tokens, 44);
  assert.equal(readTaskUsage(cwd, first).attemptedToolCalls, 3);
  assert.equal(readTaskUsage(cwd, first).notExecutedToolCalls, 2);
  assert.equal(readTaskUsage(cwd, second).notExecutedToolCalls, 1);
  assert.deepEqual(readTaskUsage(cwd, second).actualInvocationCounts, {});
  assert.deepEqual(readTaskUsage(cwd, first).actualInvocationCounts, { read: 1 });
  assert.equal(readTaskUsage(cwd, first).billedCost, null);
});
