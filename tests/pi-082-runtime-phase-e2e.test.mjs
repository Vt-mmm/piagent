import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const capabilityPromptRoot = path.join(repoRoot, "benchmarks", "capability-v1", "prompts");
const expectedPiHostVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  .peerDependencies["@earendil-works/pi-coding-agent"];

function packageRootFrom(start) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    try {
      if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return current;
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
    const candidates = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
    for (const candidate of candidates) {
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
    const root = packageRootFrom(require.resolve("@earendil-works/pi-coding-agent"));
    if (root) return root;
  } catch {
    // The release host may only be available through the pinned global CLI.
  }
  const executable = executableOnPath("pi");
  const root = executable ? packageRootFrom(executable) : undefined;
  if (!root) throw new Error("The pinned Pi host package is unavailable on module resolution or PATH");
  return root;
}

function dependencyPackageRoot(start, packageName) {
  const segments = packageName.split("/");
  let current = start;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "node_modules", ...segments);
    try {
      if (JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name === packageName) return candidate;
    } catch {
      // Support nested and npm-hoisted dependencies.
    }
    current = path.dirname(current);
  }
  throw new Error(`${packageName} is unavailable from ${start}`);
}

function copyRuntimePlatform(temporary, piRoot) {
  const platformRoot = path.join(temporary, "platform");
  const packageRoot = path.join(platformRoot, "packages", "piagent-core");
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.cpSync(path.join(repoRoot, "packages", "piagent-core"), packageRoot, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(platformRoot, "package.json"));
  for (const directory of ["adapters", "packs", "evals"]) {
    fs.cpSync(path.join(repoRoot, directory), path.join(platformRoot, directory), { recursive: true });
  }

  const dependencies = path.join(platformRoot, "node_modules");
  fs.mkdirSync(path.join(dependencies, "@earendil-works"), { recursive: true });
  fs.symlinkSync(piRoot, path.join(dependencies, "@earendil-works", "pi-coding-agent"), "dir");
  fs.symlinkSync(
    dependencyPackageRoot(piRoot, "@earendil-works/pi-ai"),
    path.join(dependencies, "@earendil-works", "pi-ai"),
    "dir"
  );
  fs.symlinkSync(path.join(piRoot, "node_modules", "typebox"), path.join(dependencies, "typebox"), "dir");
  return { platformRoot, packageRoot };
}

function writeFile(cwd, relative, content) {
  const target = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createProject(temporary, options = {}) {
  const cwd = path.join(temporary, "project");
  fs.mkdirSync(cwd, { recursive: true });
  writeFile(cwd, ".pi/piagent-profile.json", `${JSON.stringify({
    schemaVersion: 1,
    projectId: "pinned-pi-runtime-e2e",
    displayName: "Pinned Pi Runtime E2E",
    mode: "node-javascript",
    ...(options.authorityProfile ? { authorityProfile: options.authorityProfile } : {}),
    protectedPaths: [],
    shellProtectedPaths: [],
    readOnlyPaths: [],
    requiredContext: [],
    verifyCommands: { source: ["node --test test/greeting.test.js"] },
    mcpCapabilities: ["filesystem-readonly", "filesystem-write", "shell"],
    permissionProfile: "workspace-write",
    runtimePolicy: {
      execPolicy: "enforce",
      contextBudget: "off",
      toolRegistry: "off",
      finalGate: "enforce"
    }
  }, null, 2)}\n`);
  writeFile(cwd, "package.json", `${JSON.stringify({ name: "pinned-pi-runtime-e2e", private: true, type: "module" }, null, 2)}\n`);
  writeFile(cwd, "src/greeting.js", [
    "export function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    ""
  ].join("\n"));
  writeFile(cwd, "test/greeting.test.js", [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { greet } from '../src/greeting.js';",
    "",
    "test('uses the selected welcome phrase', () => {",
    "  assert.equal(greet('Ada'), 'Welcome, Ada!');",
    "});",
    ""
  ].join("\n"));
  const capabilityFiles = [
    "packages/migration/src/plan.js",
    "packages/migration/src/runner.js",
    "packages/lease/src/store.js",
    "packages/lease/src/with-lease.js",
    "packages/shared/src/search-contract.js",
    "services/catalog/src/search.js",
    "apps/web/src/search-view.js",
    "packages/policy/src/rollout.js",
    "packages/api/src/feature-access.js",
    "apps/admin/src/rollout-view.js"
  ];
  for (const relative of capabilityFiles) {
    writeFile(cwd, relative, `export const fixture = ${JSON.stringify(relative)};\n`);
  }
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "piagent-test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function configureAuthRecoveryProject(cwd) {
  const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  profile.verifyCommands.source = ["node --test test/auth.test.js"];
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFile(cwd, "src/backend/auth.js", [
    "export function canManage() {",
    "  return false;",
    "}",
    ""
  ].join("\n"));
  writeFile(cwd, "test/auth.test.js", [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { canManage } from '../src/backend/auth.js';",
    "test('starts denied', () => assert.equal(canManage(), false));",
    ""
  ].join("\n"));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "auth recovery fixture"]);
}

function configureLimitRepairProject(cwd) {
  const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  profile.verifyCommands.source = ["node --test test/limit.test.js"];
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFile(cwd, "src/limit.js", [
    "export function take(items) {",
    "  return items;",
    "}",
    ""
  ].join("\n"));
  writeFile(cwd, "test/limit.test.js", [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { take } from '../src/limit.js';",
    "test('starts without a limit contract', () => assert.deepEqual(take([1, 2]), [1, 2]));",
    ""
  ].join("\n"));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "limit repair fixture"]);
}

function configureCountRecoveryProject(cwd) {
  const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  profile.verifyCommands.source = ["node --test test/count.test.js"];
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFile(cwd, "src/count.js", [
    "export function parseCount(value) {",
    "  return value;",
    "}",
    ""
  ].join("\n"));
  writeFile(cwd, "test/count.test.js", [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { parseCount } from '../src/count.js';",
    "test('starts with the valid case', () => assert.equal(parseCount(2), 2));",
    ""
  ].join("\n"));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "count recovery fixture"]);
}

function configureStableOrderReviewProject(cwd) {
  const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  profile.verifyCommands.source = ["node --test test/order.test.js"];
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  writeFile(cwd, "src/order.js", [
    "export function stableOrder(items) {",
    "  return items;",
    "}",
    ""
  ].join("\n"));
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "stable order review fixture"]);
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

function toolTurn(id, name, arguments_) {
  return assistantMessage([{ type: "toolCall", id, name, arguments: arguments_ }], "toolUse");
}

function textTurn(text) {
  return assistantMessage([{ type: "text", text }], "stop");
}

function mutationCarrierTool(cwd, name, target = "src/phase-carrier.txt") {
  return {
    name,
    label: `Fixture ${name}`,
    description: "Test-only local mutation carrier; the Piagent phase guard must intercept it before execution.",
    parameters: name === "exec"
      ? {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false
        }
      : {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false
        },
    async execute() {
      writeFile(cwd, target, `UNAUTHORIZED ${name}\n`);
      return { content: [{ type: "text", text: `${name} executed` }] };
    }
  };
}

function fixtureModel() {
  return {
    id: "fixture",
    name: "fixture",
    api: "fixture",
    provider: "fixture",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 1_000
  };
}

function scriptedRuntime(piAi, turns, providerContexts) {
  const model = fixtureModel();
  let turn = 0;
  return {
    model,
    turnCount: () => turn,
    runtime: {
      streamSimple(_model, context) {
        providerContexts.push(structuredClone(context.messages));
        const stream = piAi.createAssistantMessageEventStream();
        const message = turns[turn++] ?? textTurn("The scripted run is incomplete and requires attention.");
        stream.push({ type: "done", reason: message.stopReason, message });
        return stream;
      },
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
    }
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function taskForSession(cwd, sessionId) {
  const directory = path.join(cwd, ".pi", "piagent-state", "tasks");
  if (!fs.existsSync(directory)) return undefined;
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")))
    .find((task) => task.sessionId === sessionId);
}

function toolEvent(events, toolCallId) {
  return events.find((event) => event.type === "tool_execution_end" && event.toolCallId === toolCallId);
}

function persistedToolResult(entries, toolCallId) {
  return entries.find((entry) => (
    entry.type === "message"
    && entry.message?.role === "toolResult"
    && entry.message.toolCallId === toolCallId
  ));
}

function contextText(context) {
  return JSON.stringify(context ?? []);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n")
    : "";
}

async function runActualSession({ host, piAi, guard, cwd, temporary, id, prompt, turns, customTools = [] }) {
  const agentDir = path.join(temporary, "agents", id);
  const sessionDir = path.join(temporary, "sessions", id);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const settingsManager = host.SettingsManager.inMemory({}, { projectTrusted: true });
  const resourceLoader = new host.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "piagent-runtime-e2e", factory: guard }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a provider-free scripted coding agent operating inside the current project."
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], `extension load failed for ${id}`);

  const providerContexts = [];
  const scripted = scriptedRuntime(piAi, turns, providerContexts);
  const sessionManager = host.SessionManager.create(cwd, sessionDir, { id });
  const { session } = await host.createAgentSession({
    cwd,
    agentDir,
    model: scripted.model,
    thinkingLevel: "off",
    modelRuntime: scripted.runtime,
    settingsManager,
    resourceLoader,
    sessionManager,
    customTools
  });
  const events = [];
  const extensionErrors = [];
  let activeTools = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  const unsubscribeErrors = session.extensionRunner.onError((error) => extensionErrors.push(error));
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
    activeTools = resourceLoader.getExtensions().runtime.getActiveTools();
  } finally {
    unsubscribe();
    unsubscribeErrors();
    session.dispose();
  }
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile, `session JSONL missing for ${id}`);
  return {
    events,
    extensionErrors,
    providerContexts,
    activeTools,
    sessionEntries: readJsonl(sessionFile),
    turnCount: scripted.turnCount()
  };
}

test("the pinned Pi host executes Piagent runtime tasks end to end without a provider or phase deadlock", async (t) => {
  let piRoot;
  try {
    piRoot = installedPiPackageRoot();
  } catch (error) {
    t.skip(error.message);
    return;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8")).version, expectedPiHostVersion);

  const previousEnvironment = new Map();
  const environment = {
    PI_OFFLINE: "1",
    PIAGENT_AUTO_CONTEXT: "0",
    PIAGENT_AUTO_RECOVERY: "1",
    PIAGENT_CONTEXT_TELEMETRY: "0",
    PIAGENT_DYNAMIC_TOOLS: "1",
    PIAGENT_NO_MCP_NOTICE: "1",
    PIAGENT_PARENT_ROUTING: "off",
    PIAGENT_PHASE_TOOLS: "on",
    PIAGENT_RUNTIME_SNAPSHOT: "0",
    PIAGENT_SOLVER_MODE: "off"
  };
  for (const [name, value] of Object.entries(environment)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-pinned-runtime-e2e-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { packageRoot } = copyRuntimePlatform(temporary, piRoot);
  const host = await import(pathToFileURL(path.join(piRoot, "dist", "index.js")));
  const piAi = await import(pathToFileURL(path.join(dependencyPackageRoot(piRoot, "@earendil-works/pi-ai"), "dist", "index.js")));
  const guardModule = await import(`${pathToFileURL(path.join(packageRoot, "extensions", "piagent-guard.ts")).href}?e2e=${Date.now()}`);
  const guard = guardModule.default;

  await t.test("all four capability prompt shapes create bounded runtime tasks and can inspect their declared source", async () => {
    const testScope = ["test/**", "tests/**", "spec/**", "__tests__/**"];
    const cases = [
      {
        id: "capability-migration",
        file: "resumable-migration-runner.md",
        sources: ["packages/migration/src/plan.js", "packages/migration/src/runner.js"],
        finalObligation: /does not rerun earlier completed steps/
      },
      {
        id: "capability-lease",
        file: "concurrent-lease-lifecycle.md",
        sources: ["packages/lease/src/store.js", "packages/lease/src/with-lease.js"],
        finalObligation: /cleanup must not delete a lease that changed owner after expiry/
      },
      {
        id: "capability-search",
        file: "fullstack-search-contract.md",
        sources: ["packages/shared/src/search-contract.js", "services/catalog/src/search.js", "apps/web/src/search-view.js"],
        finalObligation: /Empty results return `<ul aria-label="Search results"><\/ul>`/
      },
      {
        id: "capability-rollout",
        file: "multi-package-rollout.md",
        sources: ["packages/policy/src/rollout.js", "packages/api/src/feature-access.js", "apps/admin/src/rollout-view.js"],
        finalObligation: /`rolloutSummary`.*`enabled=<true\|false>; percentage=<n>; tenants=<comma-separated tenants>`/
      }
    ];
    for (const item of cases) {
      const cwd = createProject(path.join(temporary, "workspaces", item.id));
      const prompt = fs.readFileSync(path.join(capabilityPromptRoot, item.file), "utf8");
      const callId = `read-${item.id}`;
      const run = await runActualSession({
        host,
        piAi,
        guard,
        cwd,
        temporary,
        id: item.id,
        prompt,
        turns: [
          toolTurn(callId, "read", { path: item.sources[0] }),
          textTurn("Inspection is in progress; implementation is not complete.")
        ]
      });
      const task = taskForSession(cwd, item.id);
      assert.ok(task, `${item.file}: errors=${contextText(run.extensionErrors)}; provider=${contextText(run.providerContexts[0])}`);
      assert.equal(task.intakeMode, "runtime", item.file);
      assert.equal(task.changeMode, "source-change", item.file);
      assert.deepEqual(task.scope, [...item.sources, ...testScope], item.file);
      assert.match(task.acceptanceCriteria.join("\n"), item.finalObligation, item.file);
      const runtimeIntake = run.providerContexts[0]
        ?.map((message) => messageText(message))
        .find((text) => text.startsWith("Piagent runtime task:"));
      assert.ok(runtimeIntake, `${item.file}: provider context is missing runtime intake`);
      assert.match(runtimeIntake, /complete operator request above is the authoritative acceptance contract/);
      assert.doesNotMatch(runtimeIntake, /Acceptance focus:|Pre-completion contract review:/);
      assert.match(runtimeIntake, /criterion context snapshot/);
      assert.match(runtimeIntake, new RegExp(item.sources[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(runtimeIntake.length < 3_600, `${item.file}: runtime intake expanded to ${runtimeIntake.length} chars`);
      assert.equal(toolEvent(run.events, callId)?.isError, false, item.file);
      assert.equal(persistedToolResult(run.sessionEntries, callId)?.message?.isError, false, item.file);
      assert.match(persistedToolResult(run.sessionEntries, callId)?.message?.content?.[0]?.text ?? "", /fixture/, item.file);
    }
  });

  await t.test("high-risk manual intake blocks mutation and serializes the host error", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "manual-high-risk"));
    const before = fs.readFileSync(path.join(cwd, "src", "greeting.js"), "utf8");
    const callId = "manual-edit";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "manual-high-risk",
      prompt: "Implement a production credential rotation in src/greeting.js before any task contract is started.",
      turns: [
        toolTurn(callId, "edit", {
          path: "src/greeting.js",
          edits: [{ oldText: "Hello", newText: "Unsafe" }]
        }),
        textTurn("The unauthorized mutation was blocked; implementation remains incomplete.")
      ]
    });
    assert.equal(taskForSession(cwd, "manual-high-risk"), undefined);
    assert.equal(fs.readFileSync(path.join(cwd, "src", "greeting.js"), "utf8"), before);
    assert.equal(toolEvent(run.events, callId)?.isError, true);
    assert.match(toolEvent(run.events, callId)?.result?.content?.[0]?.text ?? "", /Task Implementation Contract|required before/i);
    const providerResult = run.providerContexts[1]?.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    assert.equal(providerResult?.isError, true);
    assert.match(providerResult?.content?.[0]?.text ?? "", /Task Implementation Contract|required before/i);
    const persisted = persistedToolResult(run.sessionEntries, callId);
    assert.equal(persisted?.message?.isError, true);
    assert.match(persisted?.message?.content?.[0]?.text ?? "", /Task Implementation Contract|required before/i);
  });

  await t.test("phase-on blocks shell and proxy-like mutation carriers during the manual high-risk plan", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "phase-carriers"));
    const startId = "carrier-start";
    const planExecId = "carrier-plan-exec";
    const readId = "carrier-plan-read";
    const planProxyId = "carrier-plan-proxy";
    const target = path.join(cwd, "src", "phase-carrier.txt");
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "phase-carriers",
      prompt: "Implement a production credential change in src/phase-carrier.txt using an explicit governed task.",
      customTools: [
        mutationCarrierTool(cwd, "exec"),
        mutationCarrierTool(cwd, "filesystem_write_file")
      ],
      turns: [
        toolTurn(startId, "piagent_task_start", {
          taskId: "phase-carrier-high-risk",
          summary: "Implement a bounded high-risk phase-carrier fixture",
          riskLane: "high-risk",
          expectedOutput: "The phase policy blocks mutation until execution is authorized.",
          acceptanceCriteria: ["The phase boundary remains fail closed."],
          scope: ["src/phase-carrier.txt"]
        }),
        toolTurn(planExecId, "exec", { command: "printf unsafe > src/phase-carrier.txt" }),
        toolTurn(readId, "read", { path: "src/greeting.js" }),
        toolTurn(planProxyId, "filesystem_write_file", { path: "src/phase-carrier.txt", content: "unsafe\n" }),
        textTurn("The phase-policy fixture remains incomplete because mutation was blocked.")
      ]
    });
    assert.equal(toolEvent(run.events, startId)?.isError, false);
    assert.equal(toolEvent(run.events, planExecId)?.isError, true);
    assert.match(toolEvent(run.events, planExecId)?.result?.content?.[0]?.text ?? "", /Phase plan does not allow host tool exec/i);
    assert.equal(toolEvent(run.events, readId)?.isError, false);
    assert.equal(toolEvent(run.events, planProxyId)?.isError, true);
    assert.match(toolEvent(run.events, planProxyId)?.result?.content?.[0]?.text ?? "", /Phase plan does not authorize project mutation/i);
    assert.equal(fs.existsSync(target), false, "neither custom mutation carrier may execute");
    const task = taskForSession(cwd, "phase-carriers");
    assert.ok(task);
    assert.equal(task.riskLane, "high-risk");
    assert.equal(task.intakeMode, "model");
    const trajectory = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "trajectory", `${task.taskRunId}.json`),
      "utf8"
    ));
    assert.equal(trajectory.currentPhase, "plan");
    for (const callId of [planExecId, planProxyId]) {
      assert.equal(persistedToolResult(run.sessionEntries, callId)?.message?.isError, true);
    }
  });

  await t.test("runtime read-only intake records inspection but blocks mutation in host events and JSONL", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-readonly"));
    const before = fs.readFileSync(path.join(cwd, "src", "greeting.js"), "utf8");
    const readId = "readonly-read";
    const editId = "readonly-edit";
    const execId = "readonly-exec";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-readonly",
      prompt: "Inspect src/greeting.js as a read-only task. Do not edit any file; report only observed evidence.",
      customTools: [mutationCarrierTool(cwd, "exec", "src/read-only-carrier.txt")],
      turns: [
        toolTurn(readId, "read", { path: "src/greeting.js" }),
        toolTurn(editId, "edit", {
          path: "src/greeting.js",
          edits: [{ oldText: "Hello", newText: "Unsafe" }]
        }),
        toolTurn(execId, "exec", { command: "printf unsafe > src/read-only-carrier.txt" }),
        textTurn("Read-only evidence was inspected, and the unauthorized edit was blocked.")
      ]
    });
    const task = taskForSession(cwd, "runtime-readonly");
    assert.ok(task);
    assert.equal(task.changeMode, "read-only");
    assert.equal(task.intakeMode, "runtime");
    assert.ok(task.contextManifest.some((entry) => entry.path === "src/greeting.js"));
    assert.equal(fs.readFileSync(path.join(cwd, "src", "greeting.js"), "utf8"), before);
    assert.equal(toolEvent(run.events, readId)?.isError, false);
    assert.equal(toolEvent(run.events, editId)?.isError, true);
    assert.match(toolEvent(run.events, editId)?.result?.content?.[0]?.text ?? "", /read-only|Phase .* does not allow host tool edit/i);
    assert.equal(toolEvent(run.events, execId)?.isError, true);
    assert.match(toolEvent(run.events, execId)?.result?.content?.[0]?.text ?? "", /read-only|Phase .* does not allow host tool exec/i);
    assert.equal(fs.existsSync(path.join(cwd, "src", "read-only-carrier.txt")), false);
    const persisted = persistedToolResult(run.sessionEntries, editId);
    assert.equal(persisted?.message?.isError, true);
    assert.match(persisted?.message?.content?.[0]?.text ?? "", /read-only|Phase .* does not allow host tool edit/i);
    assert.equal(persistedToolResult(run.sessionEntries, execId)?.message?.isError, true);
  });

  await t.test("policy-approved recovery spends the only continuation and hands off before a second review turn", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-repair"), { authorityProfile: "strict-high-risk" });
    configureAuthRecoveryProject(cwd);
    const prompt = "Implement canManage in src/backend/auth.js so active owner/admin users must belong to the same non-empty tenant. Preserve the boolean return shape. Missing input, inactive users, wrong roles, and cross-tenant resources must be denied. Add focused tests and run the configured verifier.";
    const weakSource = [
      "export function canManage(user, resource) {",
      "  return user?.active === true && ['owner', 'admin'].includes(user?.role) && Boolean(resource);",
      "}",
      ""
    ].join("\n");
    const weakTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { canManage } from '../src/backend/auth.js';",
      "test('allows an active owner', () => assert.equal(canManage({ tenantId: 'a', role: 'owner', active: true }, { tenantId: 'a' }), true));",
      ""
    ].join("\n");
    const repairedSource = [
      "export function canManage(user, resource) {",
      "  if (!user?.tenantId || !resource?.tenantId || user.active !== true) return false;",
      "  if (!['owner', 'admin'].includes(user.role)) return false;",
      "  return user.tenantId === resource.tenantId;",
      "}",
      ""
    ].join("\n");
    const focusedTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { canManage } from '../src/backend/auth.js';",
      "test('enforces tenant and role boundaries', () => {",
      "  assert.equal(canManage({ tenantId: 'a', role: 'owner', active: true }, { tenantId: 'a' }), true);",
      "  assert.equal(canManage({ tenantId: 'a', role: 'admin', active: true }, { tenantId: 'b' }), false);",
      "  assert.equal(canManage({ tenantId: '', role: 'owner', active: true }, { tenantId: '' }), false);",
      "  assert.equal(canManage({ tenantId: 'a', role: 'member', active: true }, { tenantId: 'a' }), false);",
      "  assert.equal(canManage({ tenantId: 'a', role: 'owner', active: false }, { tenantId: 'a' }), false);",
      "  assert.equal(canManage(undefined, { tenantId: 'a' }), false);",
      "});",
      ""
    ].join("\n");
    const readId = "repair-read";
    const weakSourceId = "repair-weak-source";
    const weakTestId = "repair-weak-test";
    const firstVerifyId = "repair-first-verify";
    const sourceRepairId = "repair-source";
    const testRepairId = "repair-test";
    const finalVerifyId = "repair-final-verify";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-repair",
      prompt,
      turns: [
        toolTurn(readId, "read", { path: "src/backend/auth.js" }),
        toolTurn(weakSourceId, "write", { path: "src/backend/auth.js", content: weakSource }),
        toolTurn(weakTestId, "write", { path: "test/auth.test.js", content: weakTest }),
        toolTurn(firstVerifyId, "bash", { command: "node --test test/auth.test.js" }),
        textTurn("Implemented canManage and the configured verifier passed."),
        toolTurn(sourceRepairId, "write", { path: "src/backend/auth.js", content: repairedSource }),
        toolTurn(testRepairId, "write", { path: "test/auth.test.js", content: focusedTest }),
        toolTurn(finalVerifyId, "bash", { command: "node --test test/auth.test.js" }),
        textTurn("Task complete: the repaired tenant boundary and focused tests pass the exact configured verifier.")
      ]
    });
    assert.equal(toolEvent(run.events, firstVerifyId)?.isError, false);
    const continuationEntries = run.sessionEntries.filter((entry) => entry.type === "custom_message");
    const continuationTypes = continuationEntries.map((entry) => entry.customType);
    const recoveryDiagnostic = continuationEntries.find((entry) => entry.customType === "piagent-completion-recovery");
    assert.equal(
      toolEvent(run.events, sourceRepairId)?.isError,
      false,
      `${toolEvent(run.events, sourceRepairId)?.result?.content?.[0]?.text}; continuations=${continuationTypes.join(",")}; recovery=${contextText(recoveryDiagnostic)}`
    );
    assert.equal(toolEvent(run.events, testRepairId)?.isError, false, toolEvent(run.events, testRepairId)?.result?.content?.[0]?.text);
    assert.equal(toolEvent(run.events, finalVerifyId)?.isError, false);
    assert.ok(run.turnCount <= 9, `bounded recovery should hand off without a second system turn, got ${run.turnCount} turns`);
    assert.match(fs.readFileSync(path.join(cwd, "src", "backend", "auth.js"), "utf8"), /user\.tenantId === resource\.tenantId/);
    assert.match(fs.readFileSync(path.join(cwd, "test", "auth.test.js"), "utf8"), /cross|tenant and role boundaries/i);
    const recoveries = run.sessionEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "piagent-completion-recovery");
    assert.equal(recoveries.length, 1, "one bounded recovery turn should replace futile verify-phase retries");
    const performanceReviews = run.sessionEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "piagent-performance-review");
    assert.equal(performanceReviews.length, 0, "the recovery already consumed the one global continuation");
    const terminalTraces = run.sessionEntries.filter((entry) => (
      entry.type === "custom"
      && entry.customType === "piagent-task-trace"
      && entry.data?.event === "task_auto_completed"
    ));
    assert.equal(terminalTraces.length, 0, "strict semantic review remains an explicit handoff after the global budget is spent");
    const task = taskForSession(cwd, "runtime-repair");
    assert.ok(task);
    assert.equal(task.trace.outcome, "pending");
    assert.ok(task.acceptanceReceipt.criteria.every((criterion) => criterion.status === "satisfied"));
    assert.ok(task.verifyEvidence.some((entry) => entry.command === "node --test test/auth.test.js" && entry.exitCode === 0));
    const transitions = readJsonl(path.join(cwd, ".pi", "piagent-state", "trajectory", `${task.taskRunId}.events.jsonl`));
    assert.equal(transitions.filter((entry) => entry.cause === "recovery-requested" && entry.to === "repair").length, 1);
    const handoff = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "handoffs", `${task.taskRunId}.json`),
      "utf8"
    ));
    assert.equal(handoff.state.taskOutcome, "pending");
    assert.equal(handoff.state.gateDecision, "fail");
    assert.equal(handoff.state.completionApproved, false);
    assert.match(handoff.state.missing.join("; "), /semantic review handoff: global-budget-exhausted/);
    assert.equal(handoff.nextSafeAction.action, "handoff");
  });

  await t.test("completion recovery names the task-derived target, criterion, and missing proof dimension", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-recovery-guidance"), { authorityProfile: "strict-high-risk" });
    configureCountRecoveryProject(cwd);
    const prompt = [
      "Implement `parseCount(value)` in src/count.js and focused tests in test/count.test.js.",
      "- [C1] `parseCount(value)` returns a positive safe integer unchanged.",
      "- [C2] `parseCount(value)` rejects zero, negative, and fractional values with `TypeError`.",
      "Run the configured verifier."
    ].join("\n");
    const guardedSource = [
      "export function parseCount(value) {",
      "  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('value');",
      "  return value;",
      "}",
      ""
    ].join("\n");
    const validOnlyTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { parseCount } from '../src/count.js';",
      "test('returns a positive safe integer', () => assert.equal(parseCount(2), 2));",
      ""
    ].join("\n");
    const readId = "guidance-read";
    const sourceId = "guidance-source";
    const testId = "guidance-test";
    const verifyId = "guidance-verify";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-recovery-guidance",
      prompt,
      turns: [
        toolTurn(readId, "read", { path: "src/count.js" }),
        toolTurn(sourceId, "write", { path: "src/count.js", content: guardedSource }),
        toolTurn(testId, "write", { path: "test/count.test.js", content: validOnlyTest }),
        toolTurn(verifyId, "bash", { command: "node --test test/count.test.js" }),
        textTurn("Implemented parseCount and the exact configured verifier passes; the task is complete."),
        textTurn("The focused proof repair is still in progress and is not complete.")
      ]
    });
    assert.deepEqual(run.extensionErrors, []);
    assert.equal(toolEvent(run.events, verifyId)?.isError, false);
    const recoveries = run.sessionEntries.filter((entry) => (
      entry.type === "custom_message" && entry.customType === "piagent-completion-recovery"
    ));
    assert.equal(recoveries.length, 1, contextText(recoveries));
    const guidance = recoveries[0].content ?? "";
    assert.match(guidance, /Target: parseCount; missing proof: executable-focused-test/i);
    assert.match(guidance, /\[C2\].*rejects zero, negative, and fractional values with `TypeError`/i);
    assert.doesNotMatch(guidance, /\bac-\d/i, "opaque receipt ids remain in structured audit details, not model recovery guidance");
    assert.doesNotMatch(guidance, /\b(?:oracle|benchmark scenario)\b/i);

    const task = taskForSession(cwd, "runtime-recovery-guidance");
    assert.ok(task);
    assert.equal(task.trace.outcome, "pending");
    assert.deepEqual(task.finalWorkingTreeFiles, [], "a pending recovery must not persist a final snapshot");
    assert.deepEqual(task.finalFileDigests, {}, "a pending recovery must not persist final digest evidence");
    const observedVerifier = task.verifyEvidence.find((entry) => entry.command === "node --test test/count.test.js" && entry.exitCode === 0);
    assert.ok(observedVerifier, "the completed verifier observation remains durable audit evidence");
    assert.equal(observedVerifier.preWorkingTreeDigest, observedVerifier.workingTreeDigest);
    assert.ok(task.acceptanceReceipt.criteria.some((criterion) => criterion.priority === "critical" && criterion.status === "pending"));
  });

  await t.test("a proven post-verify contradiction enters one early repair without guard-denial retries", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-early-repair"), { authorityProfile: "strict-high-risk" });
    configureLimitRepairProject(cwd);
    const prompt = "Implement `take` in src/limit.js and focused tests in test/limit.test.js without mutating caller inputs. Omitted `options` defaults to an empty object; when supplied it must be a non-null object. Omitted or undefined `limit` defaults to 20; when supplied `limit` must be a positive safe integer or throw `TypeError`. Run the configured verifier.";
    const weakSource = [
      "export function take(items, options = {}) {",
      "  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options');",
      "  const limit = options.limit ?? 20;",
      "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
      "  return items.slice(0, limit);",
      "}",
      ""
    ].join("\n");
    const weakTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { take } from '../src/limit.js';",
      "const items = Array.from({ length: 25 }, (_, index) => index);",
      "test('defaults and validates positive safe-integer limits', () => {",
      "  assert.equal(take(items).length, 20);",
      "  assert.deepEqual(take(items, { limit: 2 }), [0, 1]);",
      "  for (const limit of [0, -1, 1.5]) assert.throws(() => take(items, { limit }), TypeError);",
      "});",
      ""
    ].join("\n");
    const finalTest = weakTest.replace(
      "for (const limit of [0, -1, 1.5])",
      "for (const limit of [null, 0, -1, 1.5])"
    ).replace(
      "});\n",
      "  assert.throws(() => take(items, null), TypeError);\n});\n"
    );
    const readId = "early-read";
    const weakSourceId = "early-weak-source";
    const weakTestId = "early-weak-test";
    const firstVerifyId = "early-first-verify";
    const sourceRepairId = "early-source-repair";
    const testRepairId = "early-test-repair";
    const finalVerifyId = "early-final-verify";
    const reviewDiffId = "early-review-diff";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-early-repair",
      prompt,
      turns: [
        toolTurn(readId, "read", { path: "src/limit.js" }),
        toolTurn(weakSourceId, "write", { path: "src/limit.js", content: weakSource }),
        toolTurn(weakTestId, "write", { path: "test/limit.test.js", content: weakTest }),
        toolTurn(firstVerifyId, "bash", { command: "node --test test/limit.test.js" }),
        toolTurn(sourceRepairId, "edit", {
          path: "src/limit.js",
          edits: [{
            oldText: "  const limit = options.limit ?? 20;",
            newText: "  const limit = options.limit === undefined ? 20 : options.limit;"
          }]
        }),
        toolTurn(testRepairId, "write", { path: "test/limit.test.js", content: finalTest }),
        toolTurn(finalVerifyId, "bash", { command: "node --test test/limit.test.js" }),
        textTurn("The final source rejects supplied null, preserves the omitted default, and the exact verifier passes."),
        toolTurn(reviewDiffId, "bash", {
          command: "git diff --no-ext-diff HEAD -- src/limit.js test/limit.test.js && git status --short"
        }),
        textTurn("Semantic review confirms the final bounded limit contract; task complete.")
      ]
    });
    assert.deepEqual(run.extensionErrors, []);
    assert.equal(toolEvent(run.events, firstVerifyId)?.isError, false);
    assert.equal(toolEvent(run.events, sourceRepairId)?.isError, false, toolEvent(run.events, sourceRepairId)?.result?.content?.[0]?.text);
    assert.equal(toolEvent(run.events, testRepairId)?.isError, false, toolEvent(run.events, testRepairId)?.result?.content?.[0]?.text);
    assert.equal(toolEvent(run.events, finalVerifyId)?.isError, false);
    assert.ok(run.turnCount <= 10, `early repair should not spend turns on guard denials, got ${run.turnCount}`);
    const earlyRecoveries = run.sessionEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "piagent-completion-recovery");
    assert.equal(earlyRecoveries.length, 0, JSON.stringify(earlyRecoveries));
    assert.match(fs.readFileSync(path.join(cwd, "src", "limit.js"), "utf8"), /limit === undefined \? 20/);
    assert.match(fs.readFileSync(path.join(cwd, "test", "limit.test.js"), "utf8"), /\[null, 0, -1, 1\.5\]/);

    const task = taskForSession(cwd, "runtime-early-repair");
    assert.ok(task);
    assert.equal(task.trace.outcome, "completed");
    assert.ok(task.acceptanceReceipt.criteria.every((criterion) => criterion.status === "satisfied"));
    assert.equal(task.acceptanceReceipt.provenance?.disposition, "repaired-success");
    assert.equal(task.acceptanceReceipt.provenance?.repairCount, 1);
    assert.equal(task.acceptanceReceipt.provenance?.finalRecoveryDisposition, "succeeded");
    const finalVerifier = task.verifyEvidence.filter((entry) => (
      entry.command === "node --test test/limit.test.js" && entry.exitCode === 0
    )).at(-1);
    assert.ok(finalVerifier?.workingTreeDigest);
    const criterionDigests = task.acceptanceReceipt.criteria.flatMap((criterion) => (
      criterion.evidence.map((entry) => entry.workingTreeDigest)
    ));
    assert.ok(criterionDigests.length > 0);
    assert.ok(criterionDigests.every((digest) => digest === finalVerifier.workingTreeDigest));
    const transitions = readJsonl(path.join(cwd, ".pi", "piagent-state", "trajectory", `${task.taskRunId}.events.jsonl`));
    assert.equal(transitions.filter((entry) => entry.from === "verify" && entry.to === "repair" && entry.cause === "recovery-requested").length, 1);
    const traces = readJsonl(path.join(cwd, ".pi", "piagent-state", "traces.jsonl"));
    assert.equal(traces.filter((entry) => entry.event === "semantic_contradiction_repair_reserved").length, 1);
    assert.equal(traces.filter((entry) => entry.event === "semantic_contradiction_repair_opened").length, 1);
    assert.equal(traces.filter((entry) => entry.event === "semantic_repair_passed").length, 1);
  });

  await t.test("write then edit of an authored untracked test preserves current-tree review credit", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-authored-untracked-edit"), { authorityProfile: "strict-high-risk" });
    configureStableOrderReviewProject(cwd);
    const prompt = [
      "Implement stableOrder(items) in src/order.js and focused tests in test/order.test.js.",
      "Preserve stable input order when ranks tie, return the original item objects without mutating the caller array, and reject non-array input with TypeError.",
      "Run the configured verifier."
    ].join(" ");
    const sourceBefore = fs.readFileSync(path.join(cwd, "src", "order.js"), "utf8");
    const sourceAfter = [
      "export function stableOrder(items) {",
      "  if (!Array.isArray(items)) throw new TypeError('items');",
      "  return items",
      "    .map((item, index) => ({ item, index }))",
      "    .sort((left, right) => (left.item.rank - right.item.rank) || (left.index - right.index))",
      "    .map(({ item }) => item);",
      "}",
      ""
    ].join("\n");
    const initialTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { stableOrder } from '../src/order.js';",
      "",
      "test('orders stably without mutating input and validates the boundary', () => {",
      "  const input = [{ id: 'a', rank: 2 }, { id: 'b', rank: 1 }, { id: 'c', rank: 1 }];",
      "  const snapshot = [...input];",
      "  const expectedIds = ['a', 'b', 'c'];",
      "  const ordered = stableOrder(input);",
      "  assert.deepEqual(ordered.map(({ id }) => id), expectedIds);",
      "  assert.strictEqual(ordered[0], input[1]);",
      "  assert.deepEqual(input, snapshot);",
      "  assert.throws(() => stableOrder(null), TypeError);",
      "});",
      ""
    ].join("\n");
    const expectedBefore = "  const expectedIds = ['a', 'b', 'c'];";
    const expectedAfter = "  const expectedIds = ['b', 'c', 'a'];";
    const readId = "authored-edit-read";
    const sourceEditId = "authored-edit-source";
    const testWriteId = "authored-edit-test-write";
    const testEditId = "authored-edit-test-edit";
    const verifyId = "authored-edit-verify";
    const reviewId = "authored-edit-review";
    const reviewCommand = [
      "git diff --no-ext-diff HEAD -- src/order.js test/order.test.js",
      "git status --short --untracked-files=all",
      "! git diff --no-index -- /dev/null test/order.test.js"
    ].join(" && ");
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-authored-untracked-edit",
      prompt,
      turns: [
        toolTurn(readId, "read", { path: "src/order.js" }),
        toolTurn(sourceEditId, "edit", { path: "src/order.js", edits: [{ oldText: sourceBefore, newText: sourceAfter }] }),
        toolTurn(testWriteId, "write", { path: "test/order.test.js", content: initialTest }),
        toolTurn(testEditId, "edit", { path: "test/order.test.js", edits: [{ oldText: expectedBefore, newText: expectedAfter }] }),
        toolTurn(verifyId, "bash", { command: "node --test test/order.test.js" }),
        textTurn("The stable-order implementation and focused boundary tests pass the exact configured verifier."),
        toolTurn(reviewId, "bash", { command: reviewCommand }),
        textTurn("Current-tree semantic review confirms stable ordering, identity preservation, non-mutation, and TypeError handling; task complete.")
      ]
    });
    assert.deepEqual(run.extensionErrors, []);
    for (const toolCallId of [readId, sourceEditId, testWriteId, testEditId, verifyId, reviewId]) {
      assert.equal(toolEvent(run.events, toolCallId)?.isError, false, `${toolCallId}: ${toolEvent(run.events, toolCallId)?.result?.content?.[0]?.text}`);
    }
    assert.equal(run.turnCount, 8, "one semantic review should complete without a redundant recovery turn");
    assert.equal(
      run.sessionEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "piagent-performance-review").length,
      1
    );
    const traces = readJsonl(path.join(cwd, ".pi", "piagent-state", "traces.jsonl"));
    assert.equal(traces.filter((entry) => entry.event === "task_auto_completed").length, 1);
    const terminalTraces = run.sessionEntries.filter((entry) => (
      entry.type === "custom"
      && entry.customType === "piagent-task-trace"
      && entry.data?.event === "task_auto_completed"
    ));
    assert.equal(terminalTraces.length, 1);
    assert.deepEqual(terminalTraces[0].data.changedFiles, ["src/order.js", "test/order.test.js"]);

    const task = taskForSession(cwd, "runtime-authored-untracked-edit");
    assert.ok(task);
    assert.equal(task.trace.outcome, "completed");
    assert.ok(task.acceptanceReceipt.criteria.every((criterion) => criterion.status === "satisfied"));
    assert.deepEqual(task.finalWorkingTreeFiles, ["src/order.js", "test/order.test.js"]);
    assert.deepEqual(Object.keys(task.finalFileDigests).sort(), task.finalWorkingTreeFiles);
    assert.ok(Object.values(task.finalFileDigests).every((digest) => /^wt-content-v2:[a-f0-9]{64}$/.test(digest)));
    const finalTreeDigest = workingTreeEvidenceDigest(task.finalFileDigests);
    const finalVerifier = task.verifyEvidence.filter((entry) => (
      entry.command === "node --test test/order.test.js" && entry.exitCode === 0
    )).at(-1);
    assert.equal(finalVerifier?.preWorkingTreeDigest, finalTreeDigest);
    assert.equal(finalVerifier?.workingTreeDigest, finalTreeDigest);
    const handoff = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "handoffs", `${task.taskRunId}.json`),
      "utf8"
    ));
    assert.equal(handoff.tree.currentDigest, finalTreeDigest);
    assert.equal(handoff.tree.latestVerifierMatchesCurrentTree, true);
  });

  await t.test("mechanical rollback resumes through a durable handoff and clean replacement task", async () => {
    const workspaceRoot = path.join(temporary, "workspaces", "runtime-authority-rollback");
    const cwd = createProject(workspaceRoot, { authorityProfile: "strict-high-risk" });
    const id = "runtime-authority-rollback";
    const startCallId = "rollback-start";
    const first = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id,
      prompt: "Inspect src/greeting.js and prepare a governed source task, but do not modify the project yet.",
      turns: [
        toolTurn(startCallId, "piagent_task_start", {
          taskId: "authority-rollback",
          summary: "Prepare a governed source task before an operator authority rollback",
          riskLane: "normal",
          expectedOutput: "The strict task remains pending without any project mutation.",
          acceptanceCriteria: ["The task preserves its pinned strict authority until an explicit replacement"],
          scope: ["src/greeting.js"]
        }),
        toolTurn("rollback-read", "read", { path: "src/greeting.js" }),
        textTurn("The strict task is still pending before any project mutation.")
      ]
    });
    assert.deepEqual(first.extensionErrors, []);
    assert.equal(toolEvent(first.events, startCallId)?.isError, false, toolEvent(first.events, startCallId)?.result?.content?.[0]?.text);
    const original = taskForSession(cwd, id);
    assert.ok(original);
    assert.equal(original.authoritySnapshot.profile, "strict-high-risk");
    const originalPath = path.join(cwd, ".pi", "piagent-state", "tasks", `${original.taskRunId}.json`);
    const originalBytes = fs.readFileSync(originalPath);
    const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    profile.authorityProfile = "mechanical-only";
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

    const replacementCallId = "rollback-replacement";
    const second = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id,
      prompt: "Apply the configured mechanical rollback by starting a clean replacement for the handed-off task.",
      turns: [
        toolTurn(replacementCallId, "piagent_task_start", {
          taskId: original.taskId,
          summary: "Start a clean mechanical-only replacement after explicit rollback",
          riskLane: "normal",
          expectedOutput: "The replacement task carries only the new mechanical authority snapshot.",
          acceptanceCriteria: ["No advanced authority or proof is inherited from the strict run"],
          scope: ["src/greeting.js"]
        }),
        textTurn("The mechanical replacement task is active and no source mutation has occurred.")
      ]
    });
    assert.deepEqual(second.extensionErrors, []);
    const rollbackJournal = readJsonl(path.join(cwd, ".pi", "piagent-state", "task-journal", "events.jsonl"));
    const rollbackDispositions = rollbackJournal.filter((event) => event.eventType === "authority-new-attempt-required");
    assert.equal(
      toolEvent(second.events, replacementCallId)?.isError,
      false,
      `${toolEvent(second.events, replacementCallId)?.result?.content?.[0]?.text}; active=${second.activeTools.join(",")}; dispositions=${JSON.stringify(rollbackDispositions.map((event) => event.data))}`
    );
    assert.deepEqual(fs.readFileSync(originalPath), originalBytes, "the Pi host must not rewrite the pinned strict task");
    const handoff = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "handoffs", `${original.taskRunId}.json`), "utf8"
    ));
    assert.equal(handoff.nextSafeAction.action, "handoff");
    assert.match(handoff.state.missing.join("; "), /mechanical-rollback-requested/);
    const journal = readJsonl(path.join(cwd, ".pi", "piagent-state", "task-journal", "events.jsonl"));
    assert.equal(journal.filter((event) => event.eventType === "authority-new-attempt-required" && event.taskRunId === original.taskRunId).length, 1);
    const tasks = fs.readdirSync(path.join(cwd, ".pi", "piagent-state", "tasks"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "piagent-state", "tasks", file), "utf8")));
    const replacement = tasks.find((task) => task.taskRunId !== original.taskRunId && task.taskId === original.taskId);
    assert.ok(replacement);
    assert.equal(replacement.attempt, original.attempt);
    assert.equal(replacement.authoritySnapshot.profile, "mechanical-only");
    assert.deepEqual(replacement.changedFiles, []);
    assert.deepEqual(replacement.verifyEvidence, []);
  });

  await t.test("automatic normal source intake reads, edits, verifies, and reaches an approved terminal receipt", async () => {
    const cwd = createProject(path.join(temporary, "workspaces", "runtime-normal"));
    const prompt = "Implement the greeting update in src/greeting.js so the greet function uses the project selected welcome phrase. The repository already contains a small executable check, and this ordinary source task is described in enough detail to exercise the normal runtime lane while remaining bounded to the named file. Run the configured verifier when finished.";
    const readId = "normal-read";
    const editId = "normal-edit";
    const verifyId = "normal-verify";
    const run = await runActualSession({
      host,
      piAi,
      guard,
      cwd,
      temporary,
      id: "runtime-normal",
      prompt,
      turns: [
        toolTurn(readId, "read", { path: "src/greeting.js" }),
        toolTurn(editId, "edit", {
          path: "src/greeting.js",
          edits: [{
            oldText: "  return `Hello, ${name}!`;",
            newText: "  return `Welcome, ${name}!`;"
          }]
        }),
        toolTurn(verifyId, "bash", { command: "node --test test/greeting.test.js" }),
        textTurn("Implemented the bounded greeting update, and the exact configured verifier passed.")
      ]
    });
    assert.equal(run.turnCount, 4, "the automatic task must not need model-managed phase or recovery turns");
    assert.equal(toolEvent(run.events, readId)?.isError, false);
    assert.equal(
      toolEvent(run.events, editId)?.isError,
      false,
      toolEvent(run.events, editId)?.result?.content?.[0]?.text
    );
    assert.equal(toolEvent(run.events, verifyId)?.isError, false);
    assert.match(fs.readFileSync(path.join(cwd, "src", "greeting.js"), "utf8"), /Welcome/);

    const task = taskForSession(cwd, "runtime-normal");
    assert.ok(task);
    assert.equal(task.riskLane, "normal");
    assert.equal(task.intakeMode, "runtime");
    assert.equal(task.trace.outcome, "completed");
    assert.deepEqual(task.changedFiles, ["src/greeting.js"]);
    assert.deepEqual(task.verifyCommands, ["node --test test/greeting.test.js"]);
    assert.ok(task.verifyEvidence.some((entry) => (
      entry.command === "node --test test/greeting.test.js"
      && entry.exitCode === 0
      && entry.observed === true
      && entry.matchedProfileCommand === true
    )));
    assert.ok(task.workPlan.every((step) => step.status === "done"));
    assert.ok(task.acceptanceReceipt.criteria.every((criterion) => criterion.status === "satisfied"));
    assert.equal(task.acceptanceReceipt.provenance?.assurance, "runtime-observed");
    assert.equal(task.acceptanceReceipt.provenance?.disposition, "first-pass-success");
    assert.equal(task.acceptanceReceipt.provenance?.finalRecoveryDisposition, "not-needed");
    assert.deepEqual(task.finalWorkingTreeFiles, ["src/greeting.js"]);
    assert.deepEqual(Object.keys(task.finalFileDigests).sort(), task.finalWorkingTreeFiles);
    assert.ok(Object.values(task.finalFileDigests).every((digest) => /^wt-content-v2:[a-f0-9]{64}$/.test(digest)));
    const finalTreeDigest = workingTreeEvidenceDigest(task.finalFileDigests);
    const finalVerifier = task.verifyEvidence.filter((entry) => (
      entry.command === "node --test test/greeting.test.js"
      && entry.exitCode === 0
      && entry.observed === true
      && entry.matchedProfileCommand === true
    )).at(-1);
    assert.equal(finalVerifier?.preWorkingTreeDigest, finalTreeDigest);
    assert.equal(finalVerifier?.workingTreeDigest, finalTreeDigest);
    assert.ok(Date.parse(task.trace.recordedAt) >= Date.parse(finalVerifier.observedAt ?? finalVerifier.recordedAt));

    const trajectory = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "trajectory", `${task.taskRunId}.json`),
      "utf8"
    ));
    assert.equal(trajectory.currentPhase, "terminal");
    assert.equal(trajectory.terminalTaskOutcomeRef?.taskRunId, task.taskRunId);
    assert.equal(trajectory.terminalTaskOutcomeRef?.taskUpdatedAt, task.updatedAt);
    const handoff = JSON.parse(fs.readFileSync(
      path.join(cwd, ".pi", "piagent-state", "handoffs", `${task.taskRunId}.json`),
      "utf8"
    ));
    assert.equal(handoff.state.taskOutcome, "completed");
    assert.equal(handoff.state.gateDecision, "pass");
    assert.equal(handoff.state.completionApproved, true);
    assert.equal(handoff.nextSafeAction.action, "completed");
    assert.deepEqual(handoff.verification.missingCommands, []);
    assert.equal(handoff.tree.currentDigest, finalTreeDigest);
    assert.equal(handoff.tree.evidenceCurrent, true);
    assert.equal(handoff.tree.latestVerifierMatchesCurrentTree, true);
    assert.equal(handoff.verification.latestObserved?.preWorkingTreeDigest, finalTreeDigest);
    assert.equal(handoff.verification.latestObserved?.workingTreeDigest, finalTreeDigest);
  });
});
