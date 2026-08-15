import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function packageRootFrom(start) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") return current;
    } catch {
      // Keep walking toward the package root.
    }
    current = path.dirname(current);
  }
  return undefined;
}

function installedHostRoot() {
  try {
    const found = packageRootFrom(require.resolve("@earendil-works/pi-coding-agent"));
    if (found) return found;
  } catch {
    // The normal operator installation is global.
  }
  const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const found = packageRootFrom(fs.realpathSync(executable));
  if (!found) throw new Error("The pinned Pi host package is unavailable");
  return found;
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-hub-sdk-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# Session Hub SDK proof\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function proofExtension(pi) {
  pi.on("session_start", (event) => {
    pi.appendEntry("piagent-session-hub-sdk-proof", {
      reason: event.reason,
      marker: "same-extension-stack"
    });
  });
}

function uiContext() {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "confirm") return async () => false;
      if (property === "select" || property === "input") return async () => undefined;
      return () => undefined;
    }
  });
}

describe("Piagent Session Hub real Pi SDK spike", () => {
  it("creates, persists, reopens, and forks one session with the Piagent guard extension stack", async (t) => {
    let hostRoot;
    try {
      hostRoot = installedHostRoot();
    } catch (error) {
      t.skip(error.message);
      return;
    }

    const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
      .peerDependencies["@earendil-works/pi-coding-agent"];
    assert.equal(JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).version, expected);
    const host = await import(pathToFileURL(path.join(hostRoot, "dist", "index.js")));

    const cwd = repository();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-hub-runtime-"));
    const agentDir = path.join(temporary, "agent");
    const sessionDir = path.join(temporary, "sessions");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    t.after(() => {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(temporary, { recursive: true, force: true });
    });

    const model = {
      id: "fixture",
      name: "Fixture model",
      api: "fixture",
      provider: "fixture",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 1000
    };
    const modelRuntime = {
      async refresh() {},
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

    const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
      const settingsManager = host.SettingsManager.inMemory({}, { projectTrusted: true });
      const services = await host.createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [path.join(root, "packages", "piagent-core", "extensions", "piagent-guard.ts")],
          extensionFactories: [
            { name: "piagent-session-hub-sdk-proof", factory: proofExtension }
          ],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "Session Hub SDK persistence proof."
        }
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const result = await host.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: "off",
        noTools: "all"
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };

    const bind = async (session) => session.bindExtensions({ mode: "rpc", uiContext: uiContext() });
    const originalManager = host.SessionManager.create(cwd, sessionDir, { id: "session-hub-original" });
    let runtime = await host.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: originalManager,
      sessionStartEvent: { type: "session_start", reason: "startup" }
    });
    runtime.setRebindSession(bind);
    await bind(runtime.session);

    const userEntryId = runtime.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Keep this conversation across Gateway restarts." }],
      timestamp: Date.now()
    });
    const assistantEntryId = runtime.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "This reply makes the Pi session durably visible." }],
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    });
    runtime.session.sessionManager.appendSessionInfo("Durable Session Hub proof");
    const originalFile = runtime.session.sessionFile;
    assert.ok(originalFile && fs.existsSync(originalFile));
    assert.equal(runtime.session.sessionManager.getSessionName(), "Durable Session Hub proof");
    await runtime.dispose();

    const catalogAfterCreate = await host.SessionManager.list(cwd, sessionDir);
    assert.equal(catalogAfterCreate.length, 1);
    assert.equal(catalogAfterCreate[0].id, "session-hub-original");
    assert.equal(catalogAfterCreate[0].name, "Durable Session Hub proof");
    assert.match(catalogAfterCreate[0].firstMessage, /Keep this conversation/);

    const reopenedManager = host.SessionManager.open(originalFile, sessionDir);
    runtime = await host.createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: reopenedManager,
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: originalFile }
    });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    assert.equal(runtime.session.sessionManager.getSessionId(), "session-hub-original");
    assert.equal(runtime.session.sessionManager.getEntry(userEntryId).message.content[0].text,
      "Keep this conversation across Gateway restarts.");
    assert.equal(runtime.session.sessionManager.getEntries().some((entry) =>
      entry.type === "custom" && entry.customType === "piagent-session-hub-sdk-proof" && entry.data?.reason === "resume"), true);

    const forkResult = await runtime.fork(assistantEntryId, { position: "at" });
    assert.deepEqual(forkResult, { cancelled: false, selectedText: undefined });
    const forkFile = runtime.session.sessionFile;
    assert.ok(forkFile && forkFile !== originalFile && fs.existsSync(forkFile));
    assert.equal(runtime.session.sessionManager.getHeader().parentSession, originalFile);
    assert.equal(runtime.session.sessionManager.getEntry(userEntryId).message.content[0].text,
      "Keep this conversation across Gateway restarts.");
    assert.equal(runtime.session.sessionManager.getEntries().some((entry) =>
      entry.type === "custom" && entry.customType === "piagent-session-hub-sdk-proof" && entry.data?.reason === "fork"), true);

    const catalogAfterFork = await host.SessionManager.list(cwd, sessionDir);
    assert.equal(catalogAfterFork.length, 2);
    assert.equal(catalogAfterFork.some((entry) => entry.path === originalFile), true);
    assert.equal(catalogAfterFork.some((entry) => entry.path === forkFile && entry.parentSessionPath === originalFile), true);
    await runtime.dispose();
  });
});
