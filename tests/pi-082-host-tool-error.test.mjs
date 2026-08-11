import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { registerRuntimeTool } from "../packages/piagent-core/runtime/registration/extension-registration.ts";

const require = createRequire(import.meta.url);

function packageRootFrom(start) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (parsed.name === "@earendil-works/pi-coding-agent") return current;
    } catch {
      // Keep walking to the package root.
    }
    current = path.dirname(current);
  }
  return undefined;
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const candidate of process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name]) {
      const absolute = path.join(directory, candidate);
      try {
        fs.accessSync(absolute, fs.constants.X_OK);
        return fs.realpathSync(absolute);
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

function installedPiPackageRoot() {
  try {
    const resolved = require.resolve("@earendil-works/pi-coding-agent");
    const root = packageRootFrom(resolved);
    if (root) return root;
  } catch {
    // The local checkout may use the globally installed pinned Pi executable.
  }
  const executable = executableOnPath("pi");
  const root = executable ? packageRootFrom(executable) : undefined;
  if (!root) throw new Error("Pi 0.82 host package is unavailable on module resolution or PATH");
  return root;
}

function dependencyPackageRoot(start, packageName) {
  const segments = packageName.split("/");
  let current = start;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "node_modules", ...segments);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      if (parsed.name === packageName) return candidate;
    } catch {
      // Support both nested and npm-hoisted dependencies.
    }
    current = path.dirname(current);
  }
  throw new Error(`${packageName} is unavailable from ${start}`);
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now()
  };
}

test("Pi 0.82 host serializes a registered legacy refusal as an observed tool error without a provider", async (t) => {
  let piRoot;
  try {
    piRoot = installedPiPackageRoot();
  } catch (error) {
    // The package intentionally keeps Pi as an optional peer. Release/local
    // hosts exercise this boundary against the installed pin; dependency-only
    // CI remains valid without silently substituting a mock host.
    t.skip(error.message);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.82.0");

  const host = await import(pathToFileURL(path.join(piRoot, "dist", "index.js")));
  const piAiRoot = dependencyPackageRoot(piRoot, "@earendil-works/pi-ai");
  const piAi = await import(pathToFileURL(path.join(piAiRoot, "dist", "index.js")));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-pi-082-tool-error-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, "project");
  const agentDir = path.join(temporary, "agent");
  const sessionDir = path.join(temporary, "sessions");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.mkdirSync(sessionDir);

  const registered = [];
  registerRuntimeTool({ registerTool: (definition) => registered.push(definition) }, {
    name: "piagent_refused_fixture",
    label: "Piagent Refused Fixture",
    description: "Exercise legacy Piagent refusal compatibility.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return {
        content: [{ type: "text", text: "Task start refused: choose an exact scope." }],
        details: { candidates: ["packages/a/src/plan.js"] },
        isError: true
      };
    }
  });

  const model = {
    id: "fixture",
    name: "fixture",
    api: "fixture",
    provider: "fixture",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100
  };
  let turn = 0;
  const providerContexts = [];
  const streamSimple = (_model, context) => {
    providerContexts.push(structuredClone(context.messages));
    const stream = piAi.createAssistantMessageEventStream();
    const message = turn++ === 0
      ? assistantMessage([{
          type: "toolCall",
          id: "call-refused",
          name: "piagent_refused_fixture",
          arguments: {}
        }], "toolUse")
      : assistantMessage([{ type: "text", text: "Observed the refusal." }], "stop");
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  const modelRuntime = {
    streamSimple,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "fixture" }, env: {} }),
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    getModels: () => [model],
    getAvailable: async () => [model],
    getAvailableSnapshot: () => [model],
    getProviders: () => [],
    registerProvider() {},
    registerNativeProvider() {},
    unregisterProvider() {}
  };
  const sessionManager = host.SessionManager.create(cwd, sessionDir, { id: "piagent-host-error" });
  const { session } = await host.createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    sessionManager,
    noTools: "all",
    tools: ["piagent_refused_fixture"],
    customTools: registered
  });
  t.after(() => session.dispose());
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  t.after(unsubscribe);

  await session.prompt("Exercise the refused tool.", {
    expandPromptTemplates: false,
    source: "extension"
  });

  const execution = events.find((event) => (
    event.type === "tool_execution_end" && event.toolCallId === "call-refused"
  ));
  assert.equal(execution?.isError, true);
  assert.match(execution?.result?.content?.[0]?.text ?? "", /Task start refused/);

  const observed = providerContexts[1]?.find((message) => (
    message.role === "toolResult" && message.toolCallId === "call-refused"
  ));
  assert.equal(observed?.isError, true);
  assert.match(observed?.content?.[0]?.text ?? "", /Task start refused/);

  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const persisted = fs.readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => (
      entry.type === "message"
      && entry.message?.role === "toolResult"
      && entry.message.toolCallId === "call-refused"
    ));
  assert.equal(persisted?.message?.isError, true);
  assert.match(persisted?.message?.content?.[0]?.text ?? "", /Task start refused/);
  assert.equal(turn, 2);
});
