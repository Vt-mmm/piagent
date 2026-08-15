import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  SameSessionPiBridge,
  chatActionDigest,
  chatContentDigest
} from "../packages/piagent-webui/extension/same-session-bridge.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const expectedHostVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  .peerDependencies["@earendil-works/pi-coding-agent"];

function packageRootFrom(start) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return current;
    } catch { /* keep walking */ }
    current = path.dirname(current);
  }
  return undefined;
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const target = path.join(directory, name);
    try { fs.accessSync(target, fs.constants.X_OK); return fs.realpathSync(target); } catch { /* next */ }
  }
  return undefined;
}

function installedHostRoot() {
  try { const resolved = packageRootFrom(require.resolve("@earendil-works/pi-coding-agent")); if (resolved) return resolved; } catch { /* global host */ }
  const executable = executableOnPath("pi"), resolved = executable ? packageRootFrom(executable) : undefined;
  if (!resolved) throw new Error("The pinned Pi host package is unavailable");
  return resolved;
}

function dependencyRoot(start, packageName) {
  const segments = packageName.split("/"), candidates = [start, path.dirname(start)];
  for (const base of candidates) {
    let current = base;
    while (current !== path.dirname(current)) {
      const candidate = path.join(current, "node_modules", ...segments);
      try { if (JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name === packageName) return candidate; } catch { /* next */ }
      current = path.dirname(current);
    }
  }
  throw new Error(`${packageName} is unavailable from ${start}`);
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function messageText(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n")
    : String(message?.content ?? "");
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the in-process bridge dispatch");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a WebUI bridge message enters the exact running Pi process and current session", async (t) => {
  let hostRoot;
  try { hostRoot = installedHostRoot(); } catch (error) { t.skip(error.message); return; }
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).version, expectedHostVersion);
  const host = await import(pathToFileURL(path.join(hostRoot, "dist", "index.js")));
  const piAiRoot = dependencyRoot(hostRoot, "@earendil-works/pi-ai");
  const piAi = await import(pathToFileURL(path.join(piAiRoot, "dist", "index.js")));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-bridge-message-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, "project"), agentDir = path.join(temporary, "agent"), sessionDir = path.join(temporary, "sessions");
  for (const directory of [cwd, agentDir, sessionDir]) fs.mkdirSync(directory, { recursive: true });
  const marker = `webui-bridge-marker-${Date.now()}`, sessionId = "webui-bridge-current-session";
  const observed = { inputs: [] };
  let productionBridge;
  const precedingInputExtension = (pi) => {
    pi.on("input", async () => {
      await Promise.resolve();
      return { action: "continue" };
    });
  };
  const bridge = (pi) => {
    productionBridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime_bridge_e2e_01" });
    pi.on("session_start", (_event, ctx) => productionBridge.bind(ctx));
    pi.on("input", (event, ctx) => {
      observed.inputs.push({ text: event.text, source: event.source, sessionId: ctx.sessionManager.getSessionId() });
      productionBridge.observeInput(event, ctx);
    });
    pi.on("agent_start", (_event, ctx) => productionBridge.observeAgentStart(ctx));
    pi.on("message_start", (event, ctx) => productionBridge.observeMessageStart(event, ctx));
    pi.on("agent_settled", (_event, ctx) => productionBridge.observeAgentSettled(ctx));
    pi.on("session_shutdown", (_event, ctx) => productionBridge.shutdown(ctx));
  };
  const settingsManager = host.SettingsManager.inMemory({}, { projectTrusted: true });
  const resourceLoader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: [
      { name: "preceding-async-input-extension", factory: precedingInputExtension },
      { name: "piagent-webui-bridge-e2e", factory: bridge }
    ], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Reply once to the local bridge marker." });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const model = { id: "fixture", name: "fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000 };
  const providerContexts = [];
  const modelRuntime = {
    streamSimple(_model, context) {
      providerContexts.push(structuredClone(context.messages));
      const stream = piAi.createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "bridge acknowledged" }],
        api: "fixture", provider: "fixture", model: "fixture", usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() } });
      return stream;
    },
    hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }), getModel: (provider, id) => provider === "fixture" && id === "fixture" ? model : undefined,
    getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {}
  };
  const sessionManager = host.SessionManager.create(cwd, sessionDir, { id: sessionId });
  const { session } = await host.createAgentSession({ cwd, agentDir, model, thinkingLevel: "off", modelRuntime,
    settingsManager, resourceLoader, sessionManager, customTools: [] });
  await session.bindExtensions({});
  const hostEvents = [];
  const unsubscribe = session.subscribe((event) => hostEvents.push(event));
  try {
    const snapshot = productionBridge.snapshot();
    assert.equal(snapshot.state, "ready");
    const now = new Date(), expires = new Date(now.getTime() + 60_000);
    const payload = { messageRequestId: "message_request_bridge_e2e", capabilityAction: "send", delivery: "new-operation",
      text: marker, attachmentRefs: [] };
    payload.contentDigest = chatContentDigest(payload);
    const command = {
      schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: "command_bridge_e2e",
      idempotencyKey: "bridge-e2e-idempotency-key-00000001", requestedAt: now.toISOString(), expiresAt: expires.toISOString(),
      capabilityScope: "control.chat", action: "chat.send", actionDigest: "", identity: snapshot.identity,
      expectedRevisions: { ...snapshot.revisions, workspacePreimage: null, indexPreimage: null, patchPreimage: null }, payload
    };
    command.actionDigest = chatActionDigest(command);
    const receipt = await productionBridge.execute(command);
    assert.equal(receipt.resultCode, "dispatch-observed");
    assert.equal(receipt.identity.sessionRef, snapshot.identity.sessionRef);
    assert.match(receipt.identity.agentOperationId, /^operation\./);
    await waitFor(() => providerContexts.length > 0);
    await session.waitForIdle();
    assert.deepEqual(observed.inputs, [{ text: marker, source: "extension", sessionId }]);
    assert.equal(providerContexts.length, 1);
    assert.equal(providerContexts[0].some((message) => message.role === "user" && messageText(message) === marker), true);
    assert.equal(hostEvents.some((event) => event.type === "message_start" && event.message?.role === "user" && messageText(event.message) === marker), true);
    assert.equal(hostEvents.some((event) => event.type === "agent_settled"), true);
    assert.equal(sessionManager.getSessionId(), sessionId);
    const replay = await productionBridge.execute(command);
    assert.equal(replay.deduplicated, true);
    assert.equal(providerContexts.length, 1);
  } finally { unsubscribe(); session.dispose(); }
});
