import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import webUiExtension from "../packages/piagent-webui/extension/piagent-webui.ts";
import { createChatCommand, createSessionOptionCommand } from "../packages/piagent-webui/client/src/chat-command.ts";
import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { webUiProjectRef, webUiSessionRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";
import { ensureWebUiBuild } from "./helpers/piagent-webui-build.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const registry = createWebUiSchemaRegistry();
function packageRootFrom(start) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    try { if (JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return current; }
    catch { /* keep walking */ }
    current = path.dirname(current);
  }
  return undefined;
}

function installedHostRoot() {
  try { const found = packageRootFrom(require.resolve("@earendil-works/pi-coding-agent")); if (found) return found; } catch { /* global host */ }
  const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const found = packageRootFrom(fs.realpathSync(executable));
  if (!found) throw new Error("The pinned Pi host package is unavailable");
  return found;
}

function dependencyRoot(start, packageName) {
  const segments = packageName.split("/");
  let current = start;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "node_modules", ...segments);
    try { if (JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name === packageName) return candidate; } catch { /* next */ }
    current = path.dirname(current);
  }
  throw new Error(`${packageName} is unavailable`);
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantMessage(content, stopReason) {
  return { role: "assistant", content, api: "fixture", provider: "fixture", model: "fixture",
    usage: zeroUsage(), stopReason, timestamp: Date.now() };
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-launcher-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "example.txt"), "local launcher\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WebUI sidecar state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Piagent WebUI production launcher", () => {
  it("starts an isolated sidecar bound to the exact current session and survives sidecar termination", async (t) => {
    ensureWebUiBuild(root);
    const cwd = repository(), sessionId = "current-pi-session-launcher";
    const commands = new Map(), events = new Map(), notifications = [], sessionEntries = [];
    const launcherModels = [
      { provider: "fixture", id: "fixture", name: "Fixture model", reasoning: true, input: ["text"],
        thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high", xhigh: null, max: null }, contextWindow: 16_000, maxTokens: 1_000 },
      { provider: "fixture", id: "fixture-next", name: "Fixture next", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000 }
    ];
    let activeModel = launcherModels[0], thinking = "off";
    const pi = {
      registerCommand(name, definition) { commands.set(name, definition); },
      on(name, handler) { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
      appendEntry(customType, data) { sessionEntries.push({ id: `entry_${sessionEntries.length + 1}`, parentId: sessionEntries.at(-1)?.id ?? null,
        type: "custom", customType, data, timestamp: new Date().toISOString() }); },
      sendUserMessage() { throw new Error("held messages must not dispatch"); },
      getThinkingLevel: () => thinking,
      async setModel(model) { activeModel = model; return true; },
      setThinkingLevel(level) { thinking = level; }
    };
    webUiExtension(pi);
    assert.ok(commands.has("piagent-webui"));
    const ctx = {
      cwd, hasUI: true, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: 1_000, contextWindow: 16_000, percent: 6.25 }), isIdle: () => true,
      get thinkingLevel() { return thinking; }, get model() { return activeModel; }, scopedModels: [],
      modelRegistry: { getAvailable: () => structuredClone(launcherModels) },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => structuredClone(sessionEntries), getEntries: () => structuredClone(sessionEntries),
        getLeafId: () => sessionEntries.at(-1)?.id ?? null, getLeafEntry: () => structuredClone(sessionEntries.at(-1) ?? null), getSessionName: () => "Launcher test" },
      ui: { notify(message, level) { notifications.push({ message, level }); } }
    };
    const command = commands.get("piagent-webui");
    for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
    await command.handler("--no-open", ctx);
    assert.equal(notifications.some((item) => /could not|missing|timed out|exited/i.test(item.message)), false, JSON.stringify(notifications));
    const directory = path.join(cwd, ".pi", "piagent-state", "webui-launcher");
    await waitFor(() => fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith(".json")));
    const descriptorFile = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".json")));
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
    t.after(() => { try { process.kill(descriptor.sidecarPid, "SIGTERM"); } catch { /* already stopped */ } });
    assert.equal(descriptor.sessionRef, webUiSessionRef(sessionId));
    assert.notEqual(descriptor.sidecarPid, process.pid);
    assert.doesNotThrow(() => process.kill(descriptor.sidecarPid, 0));
    assert.equal(fs.existsSync(descriptor.controlSocket), true);
    const controlDirectory = path.dirname(descriptor.controlSocket);
    assert.equal(path.basename(descriptor.controlSocket), "control.sock");
    assert.equal(path.dirname(controlDirectory), path.resolve(os.tmpdir()));
    assert.equal(fs.statSync(controlDirectory).mode & 0o777, 0o700);

    const launch = spawnSync(process.execPath, [path.join(root, "scripts", "piagent-webui-launcher.mjs"), "--no-open"], { cwd, encoding: "utf8" });
    assert.equal(launch.status, 0, launch.stderr);
    const launchUrl = launch.stdout.trim();
    const target = new URL(launchUrl), capability = new URLSearchParams(target.hash.slice(1)).get("bootstrap");
    const exchange = await fetch(`${target.origin}/api/v1/bootstrap`, { method: "POST", headers: { Origin: target.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability }) });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get("set-cookie").split(";", 1)[0];
    const snapshotResponse = await fetch(`${target.origin}/api/v1/snapshot`, { headers: { Origin: target.origin, Cookie: cookie } });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    const validation = validateFixture(registry, "snapshot-v1", snapshot);
    assert.equal(validation.valid, true, validation.errors);
    assert.equal(snapshot.identity.sessionRef, webUiSessionRef(sessionId));
    assert.equal(snapshot.capabilities.mode, "control-enabled");
    assert.equal(snapshot.capabilities.capabilities["control.chat"].status, "available");
    assert.equal(snapshot.capabilities.capabilities["control.sessionOptions"].status, "available");
    assert.equal(snapshot.session.model.value.displayName, "Fixture model");
    assert.equal(snapshot.session.thinking.value, "off");
    assert.deepEqual(snapshot.session.context, { state: "known", tokens: 1_000, contextWindow: 16_000, percent: 6.25,
      capturedAt: snapshot.generatedAt, reasonCode: null });
    const monitorResponse = await fetch(`${target.origin}/api/v1/monitoring/release`, { headers: { Origin: target.origin, Cookie: cookie } });
    assert.equal(monitorResponse.status, 200);
    const monitor = await monitorResponse.json(); assert.equal(validateFixture(registry, "release-monitor-v1", monitor).valid, true);
    assert.deepEqual(monitor.actions, { runBenchmark: false, resumeBenchmark: false, releaseCommit: false, tag: false, publish: false, push: false });

    const browserSession = await exchange.json();
    const modelsResponse = await fetch(`${target.origin}/api/v1/session-options/models`, { headers: { Origin: target.origin, Cookie: cookie } });
    assert.equal(modelsResponse.status, 200); const catalog = await modelsResponse.json();
    assert.equal(validateFixture(registry, "model-catalog-v1", catalog).valid, true); assert.equal(catalog.models.length, 2);
    const thinkingCommand = await createSessionOptionCommand(snapshot, "session-options.set-thinking", "low");
    const thinkingResponse = await fetch(`${target.origin}/api/v1/session-options`, { method: "POST",
      headers: { Origin: target.origin, Cookie: cookie, "Content-Type": "application/json", "X-Piagent-CSRF": browserSession.csrfToken },
      body: JSON.stringify(thinkingCommand) });
    assert.equal(thinkingResponse.status, 200); const thinkingReceipt = await thinkingResponse.json();
    assert.equal(thinkingReceipt.resultCode, "changed"); assert.equal(validateFixture(registry, "control-command-v1", thinkingReceipt).valid, true);
    assert.equal(thinking, "low");
    const freshSnapshot = await (await fetch(`${target.origin}/api/v1/snapshot`, { headers: { Origin: target.origin, Cookie: cookie } })).json();
    const heldCommand = await createChatCommand(freshSnapshot, "Keep this message across a sidecar restart.", "hold");
    const heldResponse = await fetch(`${target.origin}/api/v1/chat/messages`, { method: "POST",
      headers: { Origin: target.origin, Cookie: cookie, "Content-Type": "application/json", "X-Piagent-CSRF": browserSession.csrfToken },
      body: JSON.stringify(heldCommand) });
    assert.equal(heldResponse.status, 200);
    const heldReceipt = await heldResponse.json();
    assert.equal(heldReceipt.resultCode, "held");
    assert.equal(validateFixture(registry, "control-command-v1", heldReceipt).valid, true);
    const queueResponse = await fetch(`${target.origin}/api/v1/chat/queue`, { headers: { Origin: target.origin, Cookie: cookie } });
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json();
    assert.equal(validateFixture(registry, "queue-v1", queue).valid, true);
    assert.equal(queue.heldCount, 1);

    const piOperation = new Promise((resolve) => setTimeout(() => resolve("pi-continued"), 80));
    process.kill(descriptor.sidecarPid, "SIGTERM");
    assert.equal(await piOperation, "pi-continued");
    assert.equal(ctx.sessionManager.getSessionId(), sessionId);
    await waitFor(() => !fs.existsSync(descriptorFile));
    await waitFor(() => !fs.existsSync(controlDirectory));
    await command.handler("--no-open", ctx);
    await waitFor(() => fs.existsSync(descriptorFile));
    const restartedDescriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
    assert.notEqual(path.dirname(restartedDescriptor.controlSocket), controlDirectory);
    t.after(() => { try { process.kill(restartedDescriptor.sidecarPid, "SIGTERM"); } catch { /* already stopped */ } });
    const restartedLaunch = spawnSync(process.execPath, [path.join(root, "scripts", "piagent-webui-launcher.mjs"), "--no-open"], { cwd, encoding: "utf8" });
    assert.equal(restartedLaunch.status, 0, restartedLaunch.stderr);
    const restartedTarget = new URL(restartedLaunch.stdout.trim()), restartedCapability = new URLSearchParams(restartedTarget.hash.slice(1)).get("bootstrap");
    const restartedExchange = await fetch(`${restartedTarget.origin}/api/v1/bootstrap`, { method: "POST",
      headers: { Origin: restartedTarget.origin, "Content-Type": "application/json" }, body: JSON.stringify({ capability: restartedCapability }) });
    const restartedCookie = restartedExchange.headers.get("set-cookie").split(";", 1)[0];
    const restartedQueue = await fetch(`${restartedTarget.origin}/api/v1/chat/queue`, { headers: { Origin: restartedTarget.origin, Cookie: restartedCookie } });
    assert.equal(restartedQueue.status, 200);
    assert.equal((await restartedQueue.json()).heldCount, 1, "sidecar restart must not lose the runtime-owned held queue");
    await command.handler("status", ctx);
    assert.match(notifications.at(-1).message, /is running/);
  });

  it("lets a real current Pi tool call finish when the WebUI sidecar crashes", async (t) => {
    ensureWebUiBuild(root);
    let hostRoot;
    try { hostRoot = installedHostRoot(); } catch (error) { t.skip(error.message); return; }
    const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).peerDependencies["@earendil-works/pi-coding-agent"];
    assert.equal(JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).version, expected);
    const host = await import(pathToFileURL(path.join(hostRoot, "dist", "index.js")));
    const piAiRoot = dependencyRoot(hostRoot, "@earendil-works/pi-ai");
    const piAi = await import(pathToFileURL(path.join(piAiRoot, "dist", "index.js")));
    const cwd = repository(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-pi-runtime-"));
    const agentDir = path.join(temporary, "agent"), sessionDir = path.join(temporary, "sessions");
    fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(sessionDir, { recursive: true });
    const previousAutostart = process.env.PIAGENT_WEBUI_AUTOSTART;
    process.env.PIAGENT_WEBUI_AUTOSTART = "1";
    t.after(() => {
      if (previousAutostart === undefined) delete process.env.PIAGENT_WEBUI_AUTOSTART;
      else process.env.PIAGENT_WEBUI_AUTOSTART = previousAutostart;
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    const settingsManager = host.SettingsManager.inMemory({}, { projectTrusted: true });
    const resourceLoader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      extensionFactories: [{ name: "piagent-webui-runtime-e2e", factory: webUiExtension }], noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Call the fixture tool once." });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    let releaseTool, markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const released = new Promise((resolve) => { releaseTool = resolve; });
    const slowTool = { name: "fixture_wait", label: "Fixture wait", description: "Wait until the isolation assertion releases it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { markStarted(); await released; return { content: [{ type: "text", text: "tool finished after sidecar exit" }] }; } };
    const model = { id: "fixture", name: "fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000 };
    let turn = 0;
    const modelRuntime = {
      streamSimple() {
        const stream = piAi.createAssistantMessageEventStream();
        const message = turn++ === 0
          ? assistantMessage([{ type: "toolCall", id: "call_wait", name: "fixture_wait", arguments: {} }], "toolUse")
          : assistantMessage([{ type: "text", text: "finished" }], "stop");
        stream.push({ type: "done", reason: message.stopReason, message }); return stream;
      },
      hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
      getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }), getModel: (provider, id) => provider === "fixture" && id === "fixture" ? model : undefined,
      getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
      registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}
    };
    const sessionId = "webui-sidecar-isolation-current-session";
    const sessionManager = host.SessionManager.create(cwd, sessionDir, { id: sessionId });
    const { session } = await host.createAgentSession({ cwd, agentDir, model, thinkingLevel: "off", modelRuntime,
      settingsManager, resourceLoader, sessionManager, customTools: [slowTool] });
    const events = [], unsubscribe = session.subscribe((event) => events.push(event));
    try {
      const uiContext = new Proxy({}, {
        get(_target, property) {
          if (property === "confirm") return async () => false;
          if (property === "select" || property === "input") return async () => undefined;
          return () => undefined;
        }
      });
      await session.bindExtensions({ mode: "rpc", uiContext });
      const directory = path.join(cwd, ".pi", "piagent-state", "webui-launcher");
      await waitFor(() => fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith(".json")));
      const descriptorFile = path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".json")));
      const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
      t.after(() => { try { process.kill(descriptor.sidecarPid, "SIGTERM"); } catch { /* already stopped */ } });
      const prompt = session.prompt("Run the fixture wait tool.", { expandPromptTemplates: false });
      await started;
      process.kill(descriptor.sidecarPid, "SIGTERM");
      await waitFor(() => !fs.existsSync(descriptorFile));
      releaseTool();
      await prompt;
      assert.equal(sessionManager.getSessionId(), sessionId);
      assert.equal(events.some((event) => event.type === "tool_execution_end" && event.toolCallId === "call_wait" && event.isError === false), true);
      assert.equal(events.some((event) => event.type === "agent_settled"), true);
      const streamStore = new RuntimeEventStore({ projectRoot: cwd, projectRef: webUiProjectRef(cwd), runtimeInstanceId: descriptor.runtimeInstanceId,
        sessionRef: webUiSessionRef(sessionId) });
      const streamReplay = streamStore.replay(null, 100);
      assert.equal(streamReplay.state, "current");
      assert.equal(streamReplay.events.some((event) => event.kind === "message.completed" && event.payload.textPreview === "finished"), true);
      assert.equal(streamReplay.events.some((event) => event.kind === "activity.started" && event.payload.toolName === "fixture_wait"), true);
      assert.equal(streamReplay.events.some((event) => event.kind === "activity.finished" && event.payload.toolName === "fixture_wait"), true);
      for (const event of streamReplay.events) {
        const validation = validateFixture(registry, "runtime-event-v2", event);
        assert.equal(validation.valid, true, `${event.kind}: ${validation.errors}`);
      }
      assert.equal(JSON.stringify(streamReplay.events).includes("tool finished after sidecar exit"), false);
    } finally { releaseTool(); unsubscribe(); session.dispose(); }
  });
});
