import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { requestGatewayControl } from "../packages/piagent-webui/gateway/control-socket.ts";
import { createAttachmentCommand } from "../packages/piagent-webui/client/src/chat-command.ts";
import { loadPinnedPiHost } from "../packages/piagent-webui/gateway/pi-host.ts";
import { gatewayProfileState, readGatewayDescriptor } from "../packages/piagent-webui/gateway/profile-state.ts";
import { SessionAttachmentRegistry } from "../packages/piagent-webui/gateway/session-attachment-registry.ts";
import { startPiagentGateway } from "../packages/piagent-webui/gateway/gateway-service.ts";
import { SessionInspectionRegistry } from "../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";
import { ensureWebUiBuild } from "./helpers/piagent-webui-build.mjs";
import { docx, DOCX_MIME } from "./helpers/piagent-docx-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const expectedPiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  .peerDependencies["@earendil-works/pi-coding-agent"];
const registry = createWebUiSchemaRegistry();
function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

describe("Piagent local Session Hub Gateway", () => {
  it("rejects repository TypeScript that needs code generation", (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-typescript-loader-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const fixture = path.join(temporary, "parameter-property.ts");
    fs.writeFileSync(fixture, "class Example { constructor(readonly value: string) {} }\nprocess.stdout.write(new Example('ready').value);\n");
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import",
      path.join(root, "scripts", "register-typescript-loader.mjs"), fixture], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|parameter property/);
  });

  it("projects only opaque projects and credential-safe authenticated model choices", async () => {
    const key = Buffer.alloc(32, 4), cwd = "/safe/project";
    const registry = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_safe_options", key, packageRoot: root,
      host: { SessionManager: { listAll: async () => [{ path: "/opaque/session.jsonl", id: "raw", cwd,
        created: new Date(), modified: new Date(), messageCount: 2, firstMessage: "safe", allMessagesText: "safe" }] } },
      models: { getModel() {}, getAvailableSnapshot: () => [
        { provider: "fixture", id: "safe-model", name: "Visible sk-proj-abcdefghijklmnopqrstuvwxyz", reasoning: true, input: ["text", "image"] },
        { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true,
          thinkingLevelMap: { high: "high", xhigh: "xhigh" }, input: ["text", "image"] },
        { provider: "fixture", id: "sk-proj-abcdefghijklmnopqrstuvwxyz", name: "Must be omitted", reasoning: true }
      ] } });
    const projected = await registry.creationOptions();
    assert.equal(projected.projects.length, 1);
    assert.equal(projected.projects[0].label, "project");
    assert.equal(JSON.stringify(projected).includes(cwd), false);
    assert.equal(projected.models.length, 2);
    assert.equal(projected.models[0].modelId, "safe-model");
    assert.equal(projected.models[0].imageInput, true);
    assert.equal(projected.models.find((model) => model.modelRef === projected.defaultModelRef)?.modelId, "gpt-5.6-sol");
    assert.equal(projected.defaultThinkingLevel, "high");
    assert.equal(projected.webSearch.state, "unavailable");
    assert.equal(projected.models[0].displayName.includes("sk-proj-"), false);
    assert.equal(JSON.stringify(projected).includes("abcdefghijklmnopqrstuvwxyz"), false);
  });

  it("reports a Codex-first web-search route without projecting credentials", async (t) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-web-search-capability-"));
    t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
    const packageDir = path.join(agentDir, "npm", "node_modules", "pi-web-access");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "pi-web-access", version: "0.17.0" }));
    const models = [{ provider: "openai-codex", id: "gpt-safe", name: "GPT Safe", reasoning: true, input: ["text", "image"] }];
    const inspection = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_codex_capabilities", key: Buffer.alloc(32, 9),
      packageRoot: root, agentDir, host: { SessionManager: { listAll: async () => [] } },
      models: { getModel() {}, getAvailableSnapshot: () => models } });
    const projected = await inspection.creationOptions();
    assert.deepEqual(projected.webSearch, { state: "configured", route: "codex-first", provider: "openai-codex",
      fallbackProvider: "exa", integration: { name: "pi-web-access", version: "0.17.0" }, reasonCode: null });
    assert.equal(projected.models[0].imageInput, true);
    assert.equal(JSON.stringify(projected).includes("apiKey"), false);
  });

  it("does not expose an internal revived subagent through creation options or read models", async () => {
    const key = Buffer.alloc(32, 10), sessionPath = "/private/agent/sessions/project/revived.jsonl";
    const hidden = { path: sessionPath, id: "raw-child", cwd: "/private/hidden-project",
      name: "subagent-piagent-planner-96dfe478-1", parentSessionPath: "/private/agent/sessions/project/parent.jsonl",
      created: new Date("2026-08-17T07:11:40.620Z"), modified: new Date("2026-08-17T07:15:00.000Z"), messageCount: 3,
      firstMessage: "Inherited user request", allMessagesText: "Inherited user request\nTask: You are reviving a previous subagent conversation." };
    const inspection = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_hidden_subagent", key, packageRoot: root,
      host: { SessionManager: { listAll: async () => [hidden], open() { throw new Error("must-not-open"); } },
        calculateContextTokens() { return 0; }, estimateTokens() { return 0; }, getLatestCompactionEntry() { return null; } } });
    const options = await inspection.creationOptions();
    assert.deepEqual(options.projects, []);
    await assert.rejects(() => inspection.provider(sessionRefForPath(key, sessionPath)));
  });

  it("projects persisted context usage for a saved session without starting a model turn", async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-saved-context-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    fs.mkdirSync(path.join(temporary, ".git"));
    const key = Buffer.alloc(32, 5), sessionPath = path.join(temporary, "session.jsonl");
    const savedAssistant = assistantMessage("saved answer");
    savedAssistant.usage.totalTokens = 1_000;
    const messages = [{ role: "user", content: [{ type: "text", text: "saved context" }], timestamp: Date.now() }, savedAssistant];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry_${index}`, message }));
    const info = { path: sessionPath, id: "saved-session", cwd: temporary, created: new Date(), modified: new Date(),
      messageCount: entries.length, firstMessage: "saved context", allMessagesText: "saved context saved answer" };
    const inspection = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_saved_context", key, packageRoot: root,
      host: {
        SessionManager: { listAll: async () => [info], open: () => ({ getBranch: () => entries,
          buildSessionContext: () => ({ model: { provider: "fixture", modelId: "saved-model" }, thinkingLevel: "high", messages }) }) },
        calculateContextTokens: (usage) => Number(usage?.totalTokens ?? 0),
        estimateTokens: () => 10,
        getLatestCompactionEntry: () => null
      },
      models: { getModel: () => ({ provider: "fixture", id: "saved-model", name: "Saved model", reasoning: true,
        contextWindow: 16_000 }), getAvailableSnapshot: () => [] } });

    const provider = await inspection.provider(sessionRefForPath(key, sessionPath));
    const snapshot = await provider.snapshot();
    assert.deepEqual(snapshot.usage.context, { state: "known", tokens: 1_000, contextWindow: 16_000, percent: 6.25,
      capturedAt: snapshot.generatedAt, reasonCode: null });
  });

  it("inspects a newly created session from the Gateway session source before the host index refreshes", async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-new-session-inspection-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    fs.mkdirSync(path.join(temporary, ".git"));
    const key = Buffer.alloc(32, 6), sessionPath = path.join(temporary, "new-session.jsonl");
    const transient = { path: sessionPath, id: "new-session", cwd: temporary, name: "New conversation",
      created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "(no messages)", allMessagesText: "" };
    let liveOpened = 0;
    const liveManager = { getBranch: () => [], buildSessionContext: () => ({ model: null, thinkingLevel: "high", messages: [] }) };
    const inspection = new SessionInspectionRegistry({ gatewayInstanceRef: "gateway_new_session_inspection", key, packageRoot: root,
      listSessions: async () => [transient],
      openLiveSession(value) { liveOpened += 1; assert.equal(value, sessionRefForPath(key, sessionPath)); return liveManager; },
      host: {
        SessionManager: { listAll: async () => [], open() { throw new Error("unpersisted-session-must-use-live-manager"); } },
        calculateContextTokens: () => 0, estimateTokens: () => 0, getLatestCompactionEntry: () => null
      } });
    const provider = await inspection.provider(sessionRefForPath(key, sessionPath));
    const snapshot = await provider.snapshot();
    assert.equal(snapshot.version, "piagent-webui-snapshot-v1");
    assert.match(snapshot.identity.sessionRef, /^session\./);
    assert.equal(liveOpened, 1);
    const attachments = new SessionAttachmentRegistry({ inspect: async () => await provider.snapshot(), tempRoot: temporary });
    t.after(() => attachments.close());
    const command = await createAttachmentCommand(snapshot, "message-request.new-session-docx", {
      displayName: "brief.docx", declaredMimeType: DOCX_MIME,
      dataBase64: docx("Deferred session attachment proof.").toString("base64")
    });
    const receipt = await attachments.execute(sessionRefForPath(key, sessionPath), command);
    assert.equal(receipt.resultCode, "staged");
    assert.equal(receipt.attachment?.kind, "document");
  });

  it("reports owner-safe lifecycle health and repairs an invalid stopped descriptor only when requested", (t) => {
    ensureWebUiBuild(root);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-gateway-doctor-")), agentDir = path.join(temporary, "agent");
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const invoke = (...arguments_) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import",
      path.join(root, "scripts", "register-typescript-loader.mjs"), path.join(root, "scripts", "piagent-dashboard.mjs"),
      "doctor", "--json", "--agent-dir", agentDir, ...arguments_], { cwd: root, encoding: "utf8" });
    const healthy = invoke();
    assert.equal(healthy.status, 0, healthy.stderr);
    const result = JSON.parse(healthy.stdout);
    assert.equal(result.ok, true); assert.match(result.profileRef, /^profile_/);
    assert.equal(JSON.stringify(result).includes(agentDir), false);
    const state = gatewayProfileState(agentDir);
    fs.writeFileSync(state.descriptorFile, "{\"invalid\":true}\n", { mode: 0o600 });
    const repair = invoke("--repair");
    assert.equal(repair.status, 1);
    assert.deepEqual(JSON.parse(repair.stdout).repaired, ["invalid-descriptor-removed"]);
    const verified = invoke();
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).ok, true);
  });

  it("returns from the launcher while its detached Gateway stays healthy", async (t) => {
    ensureWebUiBuild(root);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-gateway-detached-"));
    const agentDir = path.join(temporary, "agent");
    const invoke = (action, timeout = 10_000) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import",
      path.join(root, "scripts", "register-typescript-loader.mjs"), path.join(root, "scripts", "piagent-dashboard.mjs"),
      action, "--no-open", "--agent-dir", agentDir], { cwd: root, encoding: "utf8", timeout });
    t.after(() => {
      invoke("stop");
      fs.rmSync(temporary, { recursive: true, force: true });
    });

    const startedAt = Date.now();
    const launch = invoke("open");
    assert.equal(launch.status, 0, launch.stderr);
    assert.ok(Date.now() - startedAt < 5_000, "the detached launcher must return promptly");
    assert.match(launch.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/);
    const state = gatewayProfileState(agentDir), descriptor = readGatewayDescriptor(state);
    assert.ok(descriptor);
    assert.doesNotThrow(() => process.kill(descriptor.pid, 0));
    const health = await requestGatewayControl(state.controlSocket, { action: "health" });
    assert.equal(health.ok, true);
    const errorLog = path.join(state.root, "gateway-stderr.log");
    assert.equal(fs.statSync(errorLog).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(errorLog, "utf8"), "");
  });

  it("runs once per profile, serves a schema-valid redacted catalog, and restarts with new authority", async (t) => {
    ensureWebUiBuild(root);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-gateway-test-"));
    const agentDir = path.join(temporary, "agent");
    const cwd = path.join(temporary, "project-secret-name");
    fs.mkdirSync(cwd, { recursive: true });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    t.after(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(temporary, { recursive: true, force: true });
    });

    const first = await startPiagentGateway({ packageRoot: root, expectedPiVersion, agentDir });
    t.after(() => first.close());
    const state = gatewayProfileState(agentDir);
    assert.equal(readGatewayDescriptor(state)?.gatewayInstanceRef, first.descriptor.gatewayInstanceRef);
    assert.equal(fs.statSync(state.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(state.descriptorFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state.controlSocket).mode & 0o777, 0o600);
    await assert.rejects(() => startPiagentGateway({ packageRoot: root, expectedPiVersion, agentDir }), /gateway-already-running/);

    const host = await loadPinnedPiHost(expectedPiVersion);
    const manager = host.SessionManager.create(cwd, undefined, { id: "raw-session-id-must-not-leak" });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Discuss a safe local dashboard." }], timestamp: Date.now() });
    manager.appendMessage(assistantMessage("The durable session is ready."));
    manager.appendSessionInfo("Gateway session sk-proj-abcdefghijklmnopqrstuvwxyz");
    assert.equal(fs.existsSync(manager.getSessionFile()), true);
    assert.equal((await host.SessionManager.listAll()).length, 1);

    const launch = await requestGatewayControl(state.controlSocket, { action: "issue-launch-url" });
    assert.equal(launch.ok, true);
    const launchUrl = launch.value.launchUrl;
    const target = new URL(launchUrl);
    const capability = new URLSearchParams(target.hash.slice(1)).get("bootstrap");
    const index = await fetch(target.origin);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /name="piagent-webui-mode" content="gateway"/);
    const exchange = await fetch(`${target.origin}/api/v1/bootstrap`, {
      method: "POST",
      headers: { Origin: target.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability })
    });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get("set-cookie").split(";", 1)[0];
    const capabilities = await (await fetch(`${target.origin}/api/v1/capabilities`, { headers: { Origin: target.origin, Cookie: cookie } })).json();
    assert.equal(validateFixture(registry, "gateway-capabilities-v1", capabilities).valid, true);
    assert.equal(capabilities.mode, "full");
    assert.equal(capabilities.capabilities.sessionRuntime.status, "available");
    assert.equal(capabilities.capabilities.sessionActions.create.status, "available");
    assert.equal(capabilities.capabilities.sessionActions.acquire.status, "available");
    assert.equal(capabilities.capabilities.sessionActions.send.status, "available");
    const catalog = await (await fetch(`${target.origin}/api/v1/session-catalog`, { headers: { Origin: target.origin, Cookie: cookie } })).json();
    const validation = validateFixture(registry, "session-catalog-v1", catalog);
    assert.equal(validation.valid, true, validation.errors);
    assert.equal(catalog.sessions.length, 1);
    assert.equal(catalog.sessions[0].title.includes("sk-proj-"), false);
    assert.equal(catalog.sessions[0].title.includes("[REDACTED_SECRET]"), true);
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes("raw-session-id-must-not-leak"), false);
    assert.equal(serialized.includes(manager.getSessionFile()), false);
    assert.equal(serialized.includes(cwd), false);
    const creation = await (await fetch(`${target.origin}/api/v1/session-creation-options`, {
      headers: { Origin: target.origin, Cookie: cookie }
    })).json();
    assert.equal(creation.version, "piagent-session-creation-options-v1");
    assert.equal(creation.projects.length, 1);
    assert.equal(creation.projects[0].label, "project-secret-name");
    assert.equal(JSON.stringify(creation).includes(cwd), false);

    const firstInstance = first.descriptor.gatewayInstanceRef;
    await first.close();
    assert.equal(readGatewayDescriptor(state), null);
    assert.equal(fs.existsSync(state.controlSocket), false);
    const second = await startPiagentGateway({ packageRoot: root, expectedPiVersion, agentDir });
    t.after(() => second.close());
    assert.notEqual(second.descriptor.gatewayInstanceRef, firstInstance);
    await second.close();
  });
});
