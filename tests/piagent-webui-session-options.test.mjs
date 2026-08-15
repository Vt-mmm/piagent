import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SameSessionPiBridge, chatContentDigest, controlActionDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { SessionOptionsController, WEBUI_SESSION_OPTION_ENTRY_TYPE } from "../packages/piagent-webui/extension/session-options-controller.ts";
import { createWebUiExtensionRuntimeInstanceRef } from "../packages/piagent-webui/extension/piagent-webui.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const models = [
  { provider: "provider-a", id: "model-a", name: "Model A", reasoning: true, input: ["text", "image"],
    thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    contextWindow: 200_000, maxTokens: 32_000 },
  { provider: "provider-b", id: "model-b", name: "Model B", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 16_000 }
];

function surface(catalogModels = models) {
  const entries = []; let activeModel = catalogModels[0], thinking = "medium", idle = true, sequence = 0, sessionId = "session-options";
  const ctx = {
    cwd: "/project/session-options", get model() { return activeModel; }, get thinkingLevel() { return thinking; },
    scopedModels: [], isIdle: () => idle,
    modelRegistry: { getAvailable: () => structuredClone(catalogModels) },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => structuredClone(entries), getLeafId: () => entries.at(-1)?.id ?? null }
  };
  const calls = { model: 0, thinking: 0, messages: 0 };
  const pi = {
    appendEntry(customType, data) { entries.push({ id: `entry_${++sequence}`, type: "custom", customType, data: structuredClone(data) }); },
    sendUserMessage() { calls.messages += 1; },
    async setModel(model) { calls.model += 1; activeModel = model; return true; },
    setThinkingLevel(level) { calls.thinking += 1; thinking = level; },
    getThinkingLevel() { return thinking; }
  };
  return { ctx, pi, entries, calls, setIdle(value) { idle = value; }, setModel(value) { activeModel = value; }, setThinking(value) { thinking = value; },
    setSession(value) { sessionId = value; } };
}

function command(snapshot, action, target, suffix = "01") {
  const payload = action === "session-options.set-model"
    ? { modelRef: target, effectScopeAcknowledged: "session-and-user-default" }
    : { thinkingLevel: target, effectScopeAcknowledged: "session-and-user-default" };
  const value = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: `command_option_${suffix}`,
    idempotencyKey: `session-option-key-${suffix.padEnd(32, "0")}`, requestedAt: "2026-08-13T15:00:00.000Z",
    expiresAt: "2026-08-13T15:05:00.000Z", capabilityScope: "control.sessionOptions", action, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null,
      indexPreimage: null, patchPreimage: null }, payload };
  value.actionDigest = controlActionDigest(value); return value;
}
function chatCommand(snapshot) {
  const payload = { messageRequestId: "message_request_option_race", capabilityAction: "send", delivery: "new-operation",
    text: "Must not start during a model change.", attachmentRefs: [] };
  payload.contentDigest = chatContentDigest(payload);
  const value = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: "command_option_race_chat",
    idempotencyKey: "session-option-race-chat-key-00000000", requestedAt: "2026-08-13T15:00:00.000Z",
    expiresAt: "2026-08-13T15:05:00.000Z", capabilityScope: "control.chat", action: "chat.send", actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions: { ...structuredClone(snapshot.revisions), workspacePreimage: null,
      indexPreimage: null, patchPreimage: null }, payload };
  value.actionDigest = controlActionDigest(value); return value;
}
function validate(name, value) {
  const result = validateFixture(registry, name, value); assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI session model and thinking controller", () => {
  it("projects only the authenticated current-runtime catalog without credentials", () => {
    const rawCredential = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const contaminated = [{ ...models[0], name: `Debug ${rawCredential}` }, models[1],
      { ...models[1], id: rawCredential, name: "Must be omitted" }];
    const host = surface(contaminated), bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-options",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog(); validate("model-catalog-v1", catalog);
    assert.equal(catalog.state, "ready"); assert.equal(catalog.models.length, 2); assert.equal(catalog.activeThinkingLevel, "medium");
    assert.doesNotMatch(JSON.stringify(catalog), /"(?:apiKey|credential|accessToken|refreshToken)"|raw-secret|sk-proj-/i);
    assert.match(catalog.models[0].displayName, /\[REDACTED_SECRET\]/);
    assert.equal(catalog.effectScope, "session-and-user-default");
  });

  it("changes model and thinking only while idle, with exact scope acknowledgement and zero model turns", async () => {
    const host = surface(), bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-change",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const initial = controller.catalog();
    const modelReceipt = await controller.execute(command(bridge.snapshot(), "session-options.set-model", initial.models[1].modelRef, "model"));
    assert.equal(modelReceipt.phase, "settled"); assert.equal(modelReceipt.resultCode, "changed"); validate("control-command-v1", modelReceipt);
    assert.equal(host.calls.model, 1); assert.equal(host.calls.messages, 0); assert.notEqual(modelReceipt.observedRevisionsBefore.sessionOptionRevision,
      modelReceipt.observedRevisionsAfter.sessionOptionRevision);
    const afterModel = controller.catalog(); assert.equal(afterModel.activeModelRef, initial.models[1].modelRef);
    const thinkingReceipt = await controller.execute(command(bridge.snapshot(), "session-options.set-thinking", "off", "thinking"));
    assert.equal(thinkingReceipt.resultCode, "changed"); validate("control-command-v1", thinkingReceipt);
    assert.equal(host.calls.thinking, 1); assert.equal(host.calls.messages, 0);
    assert.equal(host.entries.filter((entry) => entry.customType === WEBUI_SESSION_OPTION_ENTRY_TYPE).length, 2);
    const replay = await controller.execute(command({ identity: modelReceipt.identity, revisions: modelReceipt.observedRevisionsBefore },
      "session-options.set-model", initial.models[1].modelRef, "model"));
    assert.equal(replay.deduplicated, true); assert.equal(host.calls.model, 1);
  });

  it("fails stale, busy, unsupported and unacknowledged commands before mutating Pi", async () => {
    const host = surface(), bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-reject",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const unacknowledged = command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "unack");
    unacknowledged.payload.effectScopeAcknowledged = "session"; unacknowledged.actionDigest = controlActionDigest(unacknowledged);
    assert.equal((await controller.execute(unacknowledged)).resultCode, "invalid-command");
    const stale = command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "stale");
    stale.expectedRevisions.sessionOptionRevision = "session-option-rev.stale"; stale.actionDigest = controlActionDigest(stale);
    assert.equal((await controller.execute(stale)).resultCode, "stale-revision");
    host.setIdle(false); assert.equal((await controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "busy"))).resultCode,
      "capability-unavailable"); host.setIdle(true);
    assert.equal((await controller.execute(command(bridge.snapshot(), "session-options.set-thinking", "max", "unsupported"))).resultCode,
      "capability-unavailable");
    assert.equal(host.calls.model, 0); assert.equal(host.calls.thinking, 0); assert.equal(host.calls.messages, 0);
  });

  it("reports unknown effect and advances CAS when Pi changes but evidence cannot be recorded", async () => {
    const host = surface(); let failEvidence = false;
    const pi = { ...host.pi, appendEntry(customType, data) { if (failEvidence && customType === WEBUI_SESSION_OPTION_ENTRY_TYPE) throw new Error("disk full");
      host.pi.appendEntry(customType, data); } };
    const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime.session-option-evidence",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog(), before = bridge.snapshot().revisions.sessionOptionRevision; failEvidence = true;
    const receipt = await controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "diskfull"));
    assert.equal(receipt.phase, "uncertain"); assert.equal(receipt.resultCode, "effect-unknown"); validate("control-command-v1", receipt);
    assert.equal(host.calls.model, 1); assert.notEqual(bridge.snapshot().revisions.sessionOptionRevision, before);
  });

  it("linearizes option changes against a concurrent WebUI dispatch", async () => {
    const host = surface(); let releaseModel, markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const released = new Promise((resolve) => { releaseModel = resolve; });
    host.pi.setModel = async (model) => { host.calls.model += 1; markStarted(); await released; host.setModel(model); return true; };
    const bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-race",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const option = controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "race"));
    await started; assert.equal(bridge.sessionOptionMutationActive(host.ctx), true);
    const chat = await bridge.execute(chatCommand(bridge.snapshot()));
    assert.equal(chat.resultCode, "capability-unavailable"); assert.equal(chat.error.code, "session-option-change-in-progress");
    assert.equal(host.calls.messages, 0); releaseModel();
    assert.equal((await option).resultCode, "changed"); assert.equal(bridge.sessionOptionMutationActive(host.ctx), false);
  });

  it("proves an accepted thinking change creates zero provider, message, token or prompt work", async () => {
    const host = surface(), bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-zero-turn",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx);
    const observe = () => ({ providerRequests: 0, userMessages: host.calls.messages, assistantMessages: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
      continuationConsumed: 0, turnTriggers: 0, sessionRef: "session.options.zero-turn", leafMessageRef: null,
      messageSetDigest: digestZeroTurnFact("messages", []), taskContractDigest: null, journalHead: null,
      promptDigest: digestZeroTurnFact("prompt", "unchanged"), toolSchemaDigest: providerVisibleToolSchemaDigest([]),
      latestCausalSequence: 0, causalEvents: [] });
    const report = await runZeroTurnConformance({ action: "session-options.set-thinking", commandId: "command.zero-turn",
      concurrency: "quiescent", mutationClass: "control" }, observe,
    () => controller.execute(command(bridge.snapshot(), "session-options.set-thinking", "high", "zero_turn")));
    assert.equal(report.passed, true, report.violations.join(", ")); assert.equal(report.result.resultCode, "changed");
  });

  it("does not let an outgoing option permit settle into or unlock a replacement session", async () => {
    const host = surface(); let releaseModel, markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; }), released = new Promise((resolve) => { releaseModel = resolve; });
    host.pi.setModel = async (model) => { host.calls.model += 1; markStarted(); await released; host.setModel(model); return true; };
    const bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-replacement",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const outgoing = controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "replacement"));
    await started; bridge.replacementPending(); host.setSession("session-options-replacement"); bridge.bind(host.ctx); controller.reset(); controller.bind(host.ctx);
    const replacementRevision = bridge.snapshot().revisions.sessionOptionRevision; releaseModel();
    const oldReceipt = await outgoing; assert.equal(oldReceipt.phase, "uncertain"); assert.equal(oldReceipt.resultCode, "effect-unknown");
    assert.equal(bridge.snapshot().revisions.sessionOptionRevision, replacementRevision);
    assert.equal(bridge.sessionOptionMutationActive(host.ctx), false);
  });

  it("retains the mutation barrier when a pending replacement is cancelled", async () => {
    const host = surface(); let releaseModel, markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; }), released = new Promise((resolve) => { releaseModel = resolve; });
    host.pi.setModel = async (model) => { host.calls.model += 1; markStarted(); await released; host.setModel(model); return true; };
    const bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-cancelled-replacement",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const option = controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "cancelled_replacement"));
    await started; bridge.replacementPending();
    assert.equal(bridge.sessionOptionMutationActive(host.ctx), true);
    assert.equal(bridge.revalidateUnchangedSession(host.ctx), true);
    assert.equal(bridge.snapshot().state, "ready");
    assert.equal(bridge.sessionOptionMutationActive(host.ctx), true);
    assert.equal((await bridge.execute(chatCommand(bridge.snapshot()))).resultCode, "capability-unavailable");
    assert.equal(host.calls.messages, 0); releaseModel();
    const receipt = await option; assert.equal(receipt.phase, "uncertain"); assert.equal(receipt.resultCode, "effect-unknown");
    assert.equal(bridge.sessionOptionMutationActive(host.ctx), false);
  });

  it("invalidates stale browser authority after a native model selection", async () => {
    const modelC = { ...models[1], id: "model-c", name: "Model C" }, host = surface([...models, modelC]);
    const bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-native-selection",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); const controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog(), stale = command(bridge.snapshot(),
      "session-options.set-model", catalog.models.find((item) => item.modelId === "model-b").modelRef, "native_selection");
    const before = bridge.snapshot().revisions.sessionOptionRevision;
    host.setModel(modelC); assert.equal(bridge.observeSessionOptionChange(host.ctx), true); controller.refresh(host.ctx);
    assert.notEqual(bridge.snapshot().revisions.sessionOptionRevision, before);
    const receipt = await controller.execute(stale);
    assert.equal(receipt.resultCode, "stale-revision"); assert.equal(host.calls.model, 0);
    assert.equal(controller.catalog().activeModelRef, catalog.models.find((item) => item.modelId === "model-c").modelRef);
  });

  it("gives every reloaded extension factory a distinct runtime authority", async () => {
    const oldHost = surface(), oldRuntime = createWebUiExtensionRuntimeInstanceRef();
    const oldBridge = new SameSessionPiBridge(oldHost.pi, { runtimeInstanceId: oldRuntime, now: () => new Date("2026-08-13T15:00:01.000Z") });
    oldBridge.bind(oldHost.ctx); const oldController = new SessionOptionsController({ pi: oldHost.pi, bridge: oldBridge,
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    oldController.bind(oldHost.ctx); const catalog = oldController.catalog();
    const stale = command(oldBridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "factory_reload");
    const newHost = surface(), newRuntime = createWebUiExtensionRuntimeInstanceRef();
    assert.notEqual(newRuntime, oldRuntime);
    const newBridge = new SameSessionPiBridge(newHost.pi, { runtimeInstanceId: newRuntime, now: () => new Date("2026-08-13T15:00:01.000Z") });
    newBridge.bind(newHost.ctx); const newController = new SessionOptionsController({ pi: newHost.pi, bridge: newBridge,
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    newController.bind(newHost.ctx);
    assert.notDeepEqual(newBridge.snapshot().identity, oldBridge.snapshot().identity);
    assert.equal((await newController.execute(stale)).resultCode, "identity-mismatch"); assert.equal(newHost.calls.model, 0);
  });

  it("does not claim success when a native selection races an async WebUI model change", async () => {
    const modelC = { ...models[1], id: "model-c-race", name: "Model C race" }, host = surface([...models, modelC]);
    let releaseModel, markStarted, bridge, controller;
    const started = new Promise((resolve) => { markStarted = resolve; }), released = new Promise((resolve) => { releaseModel = resolve; });
    host.pi.setModel = async (model) => { host.calls.model += 1; markStarted(); await released; host.setModel(model);
      controller.observeHostOptionChange(host.ctx); return true; };
    bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-native-race",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const pending = controller.execute(command(bridge.snapshot(), "session-options.set-model",
      catalog.models.find((item) => item.modelId === "model-b").modelRef, "native_race"));
    await started; host.setModel(modelC); controller.observeHostOptionChange(host.ctx); releaseModel();
    const receipt = await pending;
    assert.equal(receipt.phase, "uncertain"); assert.equal(receipt.resultCode, "effect-unknown");
    assert.equal(receipt.settlementEvidenceRef, null); assert.equal(host.calls.model, 1);
  });

  it("accepts the causal thinking clamp and model events from one Pi model change", async () => {
    const host = surface(); let bridge, controller;
    host.pi.setModel = async (model) => { host.calls.model += 1; host.setThinking("off"); controller.observeHostOptionChange(host.ctx);
      host.setModel(model); controller.observeHostOptionChange(host.ctx); return true; };
    bridge = new SameSessionPiBridge(host.pi, { runtimeInstanceId: "runtime.session-option-causal-cascade",
      now: () => new Date("2026-08-13T15:00:01.000Z") });
    bridge.bind(host.ctx); controller = new SessionOptionsController({ pi: host.pi, bridge, now: () => new Date("2026-08-13T15:00:01.000Z") });
    controller.bind(host.ctx); const catalog = controller.catalog();
    const receipt = await controller.execute(command(bridge.snapshot(), "session-options.set-model", catalog.models[1].modelRef, "causal_cascade"));
    assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "changed"); assert.ok(receipt.settlementEvidenceRef);
    assert.equal(host.calls.model, 1); assert.equal(controller.catalog().activeThinkingLevel, "off");
  });
});
