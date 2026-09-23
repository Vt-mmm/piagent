import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PiSessionStreamAdapter } from "../packages/piagent-webui/extension/session-stream-adapter.ts";
import { classifyPreUsageFailure } from "../packages/piagent-core/benchmark/benchmark-transport-evidence.js";
import { createWebUiSchemaRegistry } from "./helpers/piagent-webui-schema-registry.mjs";

const snapshot = { state: "ready", identity: { projectRef: "project.activity", runtimeInstanceId: "runtime.activity",
  sessionRef: "session.activity", taskId: null, taskRunId: null, agentOperationId: "operation.activity", toolCallId: null },
  revisions: { runtimeRevision: "revision.activity", taskRevision: null, controlRevision: null, workspaceRevision: null,
    indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null }, liveness: "running", eventSequence: 1 };

function fixture() {
  let tick = Date.parse("2026-09-06T10:00:00.000Z");
  const adapter = new PiSessionStreamAdapter({ now: () => new Date(tick) });
  adapter.turnStarted({ turnIndex: 0, timestamp: tick }, snapshot);
  adapter.messageStarted({ message: { role: "assistant", content: [] } }, snapshot);
  return { adapter, update(type, extra = {}) { tick += 100;
    return adapter.messageUpdated({ assistantMessageEvent: { type, contentIndex: 0, ...extra } }, snapshot); },
    end(reason = "aborted") { tick += 100;
      return adapter.messageEnded({ message: { role: "assistant", content: [], stopReason: reason,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }, snapshot).at(-1); },
    at: () => new Date(tick).toISOString() };
}

test("terminal telemetry distinguishes projected silence from partial tool-call consumer activity", () => {
  const f = fixture();
  assert.equal(f.update("thinking_end", { content: "PRIVATE_THINKING" }).length, 1);
  for (const type of ["toolcall_start", "toolcall_delta", "toolcall_delta"])
    assert.deepEqual(f.update(type, { delta: "PRIVATE_ARGUMENTS", partial: { secret: "PRIVATE_PARTIAL" } }), []);
  const lastObservedAt = f.at(), ended = f.end();
  assert.equal(ended.kind, "message.failed");
  assert.deepEqual(ended.payload.streamActivity, { schemaVersion: 1, boundary: "pi-message-update-hook",
    observedUpdates: 4, textUpdates: 0, thinkingUpdates: 1, toolCallUpdates: 3, otherUpdates: 0,
    lastUpdateKind: "toolcall_delta", lastObservedAt, countersCapped: false });
  assert.doesNotMatch(JSON.stringify(ended.payload.streamActivity), /PRIVATE_/);
  assert.equal(ended.payload.usage, undefined, "aborted local zero must not become a provider usage receipt");
  const disposition = classifyPreUsageFailure({ timedOut: true, code: 1 },
    { sessions: 4, input: 11415, output: 2985, cacheRead: 5120, cacheWrite: 0, reasoning: 504,
      fresh: 14400, total: 19520 }, "aborted");
  assert.equal(disposition.usageStatus, "measured-lower-bound");
  assert.equal(disposition.retryable, false);
});

test("redacted thinking and buffered newline-free text still count as consumer activity", () => {
  const f = fixture();
  f.update("thinking_delta", { delta: "PRIVATE_THINKING" });
  assert.deepEqual(f.update("thinking_delta", { delta: "PRIVATE_THINKING" }), []);
  assert.deepEqual(f.update("text_delta", { delta: "PRIVATE_TEXT_WITHOUT_NEWLINE" }), []);
  const lastObservedAt = f.at(), summary = f.end("stop").payload.streamActivity;
  assert.equal(summary.observedUpdates, 3); assert.equal(summary.thinkingUpdates, 2);
  assert.equal(summary.textUpdates, 1); assert.equal(summary.lastUpdateKind, "text_delta");
  assert.equal(summary.lastObservedAt, lastObservedAt); assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_/);
});

test("consumer telemetry is message-local and never copies an unknown update kind", () => {
  const f = fixture(); f.update("PRIVATE_UNRECOGNIZED_KIND", { delta: "PRIVATE_VALUE" });
  const first = f.end().payload.streamActivity;
  assert.equal(first.otherUpdates, 1); assert.equal(first.lastUpdateKind, "other");
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  assert.deepEqual(f.update("toolcall_delta"), []);
  f.adapter.messageStarted({ message: { role: "assistant", content: [] } }, snapshot);
  const second = f.end("stop").payload.streamActivity;
  assert.equal(second.observedUpdates, 0); assert.equal(second.lastUpdateKind, null);
  assert.equal(second.lastObservedAt, null);
});

test("consumer telemetry counters and memory stay bounded while the last observation advances", () => {
  const f = fixture();
  for (let index = 0; index < 100_002; index++) f.update("toolcall_delta", { delta: "PRIVATE_ARGUMENT" });
  const lastObservedAt = f.at(), summary = f.end().payload.streamActivity;
  assert.equal(summary.observedUpdates, 100_000); assert.equal(summary.toolCallUpdates, 100_000);
  assert.equal(summary.countersCapped, true); assert.equal(summary.lastObservedAt, lastObservedAt);
  assert.ok(JSON.stringify(summary).length < 400);
});

test("optional stream summary preserves old payload compatibility and rejects unconstrained data", () => {
  const registry = createWebUiSchemaRegistry();
  const schema = registry.documents.find(({ entry }) => entry.name === "runtime-event-v2").schema;
  for (const [reason, definition] of [["stop", "messageCompletedPayload"], ["aborted", "messageFailedPayload"]]) {
    const validate = registry.ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
    const f = fixture(); f.update("toolcall_delta", { delta: "PRIVATE_ARGUMENT" });
    const payload = f.end(reason).payload;
    assert.equal(validate(payload), true, JSON.stringify(validate.errors));
    const old = structuredClone(payload); delete old.streamActivity;
    assert.equal(validate(old), true, "old payloads without stream activity remain valid");
    for (const mutate of [s => { s.raw = "PRIVATE_ARGUMENT"; }, s => { s.lastUpdateKind = "PRIVATE_KIND"; },
      s => { s.toolCallUpdates = 100_001; }, s => { s.lastObservedAt = "not-a-time"; }]) {
      const wrong = structuredClone(payload); mutate(wrong.streamActivity);
      assert.equal(validate(wrong), false);
    }
  }
});

const hostRoot = process.env.PIAGENT_REAL_PI_HOST;
test("actual pinned Pi consumes partial tool calls then aborts once without exact usage or replay", {
  skip: !hostRoot, timeout: 20_000
}, async t => {
  const repo = path.resolve(import.meta.dirname, "..");
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"))).peerDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"))).version, expectedVersion);
  const host = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")));
  const ai = path.join(hostRoot, "node_modules/@earendil-works/pi-ai/dist");
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(ai, "utils/event-stream.js")));
  const { getModel } = await import(pathToFileURL(path.join(ai, "compat.js")));
  const model = getModel("openai-codex", "gpt-5.6-luna");
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-activity-sdk-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let fakeStreams = 0, authCalls = 0, toolExecutions = 0, notifyPartial;
  const partialObserved = new Promise(resolve => { notifyPartial = resolve; });
  const adapter = new PiSessionStreamAdapter(), terminal = [];
  const modelRuntime = { async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }),
    isUsingOAuth: () => false, getAuth: async () => { authCalls++; throw new Error("real-auth-forbidden"); },
    getModel: () => model, getModels: () => [model], getAvailable: async () => [model], getAvailableSnapshot: () => [model],
    getProviders: () => [], registerProvider() { throw new Error("provider-registration-forbidden"); },
    registerNativeProvider() { throw new Error("provider-registration-forbidden"); }, unregisterProvider() {},
    streamSimple(_model, _context, options) {
      fakeStreams++;
      const stream = new AssistantMessageEventStream();
      const response = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }], stopReason: "pending", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: response });
        stream.push({ type: "thinking_end", contentIndex: 0, content: "PRIVATE_THINKING", partial: response });
        stream.push({ type: "toolcall_start", contentIndex: 1, partial: response });
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "PRIVATE_ARGUMENT", partial: response });
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "PRIVATE_ARGUMENT", partial: response });
      });
      options.signal.addEventListener("abort", () => {
        response.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: response });
      }, { once: true });
      return stream;
    } };
  const services = await host.createAgentSessionServices({ cwd: temp, agentDir: path.join(temp, "agent"), modelRuntime,
    settingsManager: host.SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } },
      { projectTrusted: true }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, extensionFactories: [pi => {
        pi.on("turn_start", e => adapter.turnStarted(e, snapshot));
        pi.on("message_start", e => adapter.messageStarted(e, snapshot));
        pi.on("message_update", e => { adapter.messageUpdated(e, snapshot);
          if (e.assistantMessageEvent?.type === "toolcall_delta") notifyPartial(); });
        pi.on("message_end", e => terminal.push(...adapter.messageEnded(e, snapshot)));
        pi.on("tool_execution_start", () => { toolExecutions++; });
      }] } });
  const { session } = await host.createAgentSessionFromServices({ services, model, thinkingLevel: "medium", noTools: "all",
    sessionManager: host.SessionManager.inMemory(temp) });
  t.after(() => session.dispose());
  const prompt = session.prompt("Offline partial stream only.");
  await partialObserved; await session.abort(); await prompt;
  const failed = terminal.find(e => e.kind === "message.failed");
  assert.ok(failed); assert.equal(failed.payload.reason, "aborted");
  assert.equal(failed.payload.streamActivity.toolCallUpdates, 3);
  assert.equal(failed.payload.streamActivity.lastUpdateKind, "toolcall_delta");
  assert.equal(failed.payload.usage, undefined);
  assert.equal(fakeStreams, 1); assert.equal(authCalls, 0); assert.equal(toolExecutions, 0);
  assert.doesNotMatch(JSON.stringify(failed.payload.streamActivity), /PRIVATE_/);
  const disposition = classifyPreUsageFailure({ code: 1, timedOut: true }, null, "aborted");
  assert.equal(disposition.usageStatus, "unknown-after-provider-start");
  assert.equal(disposition.retryable, false);
});
