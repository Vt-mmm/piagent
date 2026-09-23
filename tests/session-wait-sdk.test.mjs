import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registerSessionWaitTool } from "../packages/piagent-core/runtime/registration/session-wait-tool.ts";
import { SESSION_WAIT_ENTRY } from "../packages/piagent-core/runtime/tools/session-wait.ts";
import { auditToolProtocol } from "../packages/piagent-core/runtime/session/adaptive-context-governor.ts";

const sdkRoot = process.env.PIAGENT_REAL_PI_HOST || "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
for (const abort of [false, true]) test(`installed SDK wait ${abort ? "abort" : "elapsed"} makes no model call while pending and survives cold readback`,
  { skip: !fs.existsSync(path.join(sdkRoot, "dist/index.js")) }, async (t) => {
    const expected = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).peerDependencies["@earendil-works/pi-coding-agent"];
    assert.equal(JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"))).version, expected);
    const host = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
    const ai = await import(pathToFileURL(path.join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
    const { Type } = await import(pathToFileURL(createRequire(path.join(sdkRoot, "package.json")).resolve("typebox")));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-wait-sdk-")));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const agentDir = path.join(cwd, "agent"), sessionDir = path.join(cwd, "sessions");
    fs.mkdirSync(agentDir); fs.mkdirSync(sessionDir);
    const manager = host.SessionManager.create(cwd, sessionDir);
    let calls = 0;
    const model = { id: "fixture", name: "fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
    const runtime = {
      streamSimple() {
        const stream = ai.createAssistantMessageEventStream(); const first = calls++ === 0;
        const message = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: Date.now(),
          content: first ? [{ type: "toolCall", id: "wait-sdk", name: "piagent_wait", arguments: { seconds: abort ? 3600 : 1, nextCheck: "Inspect the existing result" } }]
            : [{ type: "text", text: "The interval elapsed; the job outcome is still unverified." }],
          stopReason: first ? "toolUse" : "stop", usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { total: 0 } } };
        queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message })); return stream;
      },
      hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
      getAuth: async () => ({ auth: { apiKey: "synthetic-fixture" }, env: {} }), getModel: () => model, getModels: () => [model],
      getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
      registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}
    };
    const settingsManager = host.SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } }, { projectTrusted: true });
    const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Test-owned scripted wait.",
      extensionFactories: [{ name: "wait-fixture", factory: pi => registerSessionWaitTool(pi, Type) }] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await host.createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "off",
      settingsManager, resourceLoader: loader, sessionManager: manager, tools: ["piagent_wait"] });
    const errors = []; session.extensionRunner.onError(e => errors.push(e));
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "json" });
    session.setActiveToolsByName(["piagent_wait"]);
    const run = session.prompt("Wait until the next useful check", { expandPromptTemplates: false });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(calls, 1, `no model turn during the timer interval: ${JSON.stringify(manager.getEntries().filter(e => e.message?.role === "toolResult").map(e => e.message.content))}`);
    assert.equal(manager.getEntries().filter(e => e.customType === SESSION_WAIT_ENTRY).at(-1)?.data.outcome, "pending");
    if (abort) await session.abort();
    await run;
    assert.equal(calls, abort ? 1 : 2, "only the normal post-tool continuation is allowed");
    const entries = manager.getEntries().filter(e => e.customType === SESSION_WAIT_ENTRY);
    assert.deepEqual(entries.map(e => e.data.outcome), ["pending", abort ? "interrupted" : "elapsed"]);
    assert.equal(auditToolProtocol(manager.buildSessionContext().messages).intact, true);
    const reopened = host.SessionManager.open(session.sessionFile, sessionDir);
    assert.deepEqual(reopened.getEntries().filter(e => e.customType === SESSION_WAIT_ENTRY).map(e => e.data.outcome), entries.map(e => e.data.outcome));
    assert.equal(auditToolProtocol(reopened.buildSessionContext().messages).intact, true);
    assert.equal(calls, abort ? 1 : 2, "cold readback does not restart a wait or model");
    assert.deepEqual(errors, []);
  });
