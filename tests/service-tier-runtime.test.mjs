import assert from "node:assert/strict";
import test from "node:test";

import {
  PIAGENT_FAST_MODE_STATE_ENTRY_TYPE,
  PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE,
  ServiceTierRuntime,
  parseServiceTierReceipt,
  registerFastModeCommand
} from "../packages/piagent-core/runtime/model/service-tier-runtime.ts";

function context(options = {}) {
  const branch = options.branch ?? [];
  return {
    model: options.model ?? { provider: "openai-codex", id: "gpt-5.6-luna" },
    thinkingLevel: "medium",
    sessionManager: { getSessionId: () => options.sessionId ?? "session-1", getBranch: () => branch },
    ui: { notices: [], notify(message, level) { this.notices.push({ message, level }); } }
  };
}

function host() {
  const commands = new Map(), entries = [], messages = [];
  return {
    pi: {
      registerCommand(name, definition) { commands.set(name, definition); },
      appendEntry(customType, data) { entries.push({ customType, data }); },
      sendMessage(message) { messages.push(message); }
    },
    commands,
    entries,
    messages
  };
}

test("Fast mode defaults off and does not touch provider payload", () => {
  const runtime = new ServiceTierRuntime(), ctx = context(), { pi, entries } = host();
  const restored = runtime.restore(ctx);
  assert.equal(restored.mode, "standard");
  assert.equal(restored.requestedServiceTier, null);
  const payload = { model: "gpt-5.6-luna", reasoning: { effort: "medium" } };
  const result = runtime.applyProviderRequest(pi, ctx, payload);
  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
  assert.equal(entries.length, 0);
  assert.deepEqual(ctx.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
  assert.equal(ctx.thinkingLevel, "medium");
});

test("explicit environment opt-in requests fast and records outbound evidence once", () => {
  const runtime = new ServiceTierRuntime({ environmentValue: "fast" }), ctx = context(), { pi, entries } = host();
  runtime.restore(ctx);
  const payload = { model: "gpt-5.6-luna", service_tier: "default", reasoning: { effort: "medium" } };
  const first = runtime.applyProviderRequest(pi, ctx, payload);
  assert.equal(first.changed, true);
  assert.deepEqual(first.payload, { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, "default", "host-owned payload must not be mutated");
  assert.equal(first.receipt.requestedServiceTier, "fast");
  assert.equal(first.receipt.observedRequestServiceTier, "priority");
  assert.equal(first.receipt.providerResponseServiceTier, null);
  assert.equal(first.receipt.providerResponseEvidence, "unavailable-host-api");
  assert.equal(first.receipt.applied, true);
  assert.equal(entries.filter((entry) => entry.customType === PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE).length, 1);
  runtime.applyProviderRequest(pi, ctx, first.payload);
  assert.equal(entries.filter((entry) => entry.customType === PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE).length, 1,
    "one session setting must not append a receipt on every model turn");
  assert.deepEqual(ctx.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
  assert.equal(ctx.thinkingLevel, "medium");
});

test("outbound Fast evidence is bound to the exact provider and model that was observed", () => {
  const runtime = new ServiceTierRuntime({ environmentValue: "fast" }), ctx = context(), { pi } = host();
  runtime.restore(ctx);
  runtime.applyProviderRequest(pi, ctx, { model: "gpt-5.6-luna", reasoning: { effort: "medium" } });

  ctx.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const beforeSolRequest = runtime.receipt(ctx);
  assert.equal(beforeSolRequest.observedRequestServiceTier, null);
  assert.equal(beforeSolRequest.applied, false);
  assert.equal(beforeSolRequest.reasonCode, "fast-request-pending");

  const solPayload = { model: "gpt-5.6-sol", reasoning: { effort: "medium" } };
  const solRequest = runtime.applyProviderRequest(pi, ctx, solPayload);
  assert.equal(solRequest.receipt.observedRequestServiceTier, "priority");
  assert.equal(solRequest.receipt.applied, true);
  assert.equal(solRequest.receipt.reasonCode, "fast-request-observed");
  assert.deepEqual(solRequest.payload, { ...solPayload, service_tier: "priority" });
  assert.equal(solPayload.service_tier, undefined);

  ctx.model = { provider: "anthropic", id: "claude-sonnet" };
  const unsupported = runtime.receipt(ctx);
  assert.equal(unsupported.observedRequestServiceTier, null);
  assert.equal(unsupported.applied, false);
  assert.equal(unsupported.reasonCode, "provider-not-supported");
  assert.deepEqual(ctx.model, { provider: "anthropic", id: "claude-sonnet" });
  assert.equal(ctx.thinkingLevel, "medium");
});

test("structured service-tier receipts fail closed on extra fields or semantic contradictions", () => {
  const runtime = new ServiceTierRuntime({ environmentValue: "fast" }), ctx = context(), { pi } = host();
  runtime.restore(ctx);
  const receipt = runtime.applyProviderRequest(pi, ctx, { model: "gpt-5.6-luna" }).receipt;
  assert.deepEqual(parseServiceTierReceipt(receipt), receipt);
  assert.equal(parseServiceTierReceipt({ ...receipt, injected: true }), null);
  assert.equal(parseServiceTierReceipt({ ...receipt, applied: false }), null);
  assert.equal(parseServiceTierReceipt({ ...receipt, provider: "anthropic", reasonCode: "provider-not-supported" }), null,
    "an unsupported provider cannot retain an observed Fast request");
});

test("durable session state restores Fast mode while an explicit environment off wins", () => {
  const branch = [{ type: "custom", customType: PIAGENT_FAST_MODE_STATE_ENTRY_TYPE,
    data: { schemaVersion: 1, enabled: true, requestedServiceTier: "fast", source: "session-command" } }];
  const ctx = context({ branch });
  assert.equal(new ServiceTierRuntime().restore(ctx).mode, "fast");
  assert.equal(new ServiceTierRuntime({ environmentValue: "off" }).restore(ctx).mode, "standard");
});

test("unsupported providers remain fail-visible and never receive a Fast field", () => {
  const runtime = new ServiceTierRuntime({ environmentValue: "on" });
  const ctx = context({ model: { provider: "anthropic", id: "claude-sonnet" } }), { pi, entries } = host();
  assert.equal(runtime.restore(ctx).reasonCode, "provider-not-supported");
  const payload = { model: "claude-sonnet" }, result = runtime.applyProviderRequest(pi, ctx, payload);
  assert.equal(result.payload, payload);
  assert.equal(result.changed, false);
  assert.equal(result.receipt.applied, false);
  assert.equal(result.receipt.reasonCode, "provider-not-supported");
  assert.equal(entries.length, 0);
});

test("/fast on, status and off are zero-turn session controls with explicit receipts", async () => {
  const runtime = new ServiceTierRuntime(), ctx = context(), fixture = host();
  runtime.restore(ctx); registerFastModeCommand(fixture.pi, runtime);
  const command = fixture.commands.get("fast");
  assert.ok(command);
  assert.deepEqual(command.getArgumentCompletions("o").map((item) => item.value), ["on", "off"]);

  await command.handler("on", ctx);
  assert.equal(runtime.receipt(ctx).mode, "fast");
  assert.equal(fixture.entries.at(-1).customType, PIAGENT_FAST_MODE_STATE_ENTRY_TYPE);
  assert.equal(fixture.messages.at(-1).customType, "piagent-service-tier-receipt");
  assert.equal(fixture.messages.at(-1).details.requestedServiceTier, "fast");
  assert.equal(fixture.messages.at(-1).details.observedRequestServiceTier, null);

  await command.handler("status", ctx);
  assert.equal(fixture.messages.at(-1).details.mode, "fast");
  await command.handler("off", ctx);
  assert.equal(runtime.receipt(ctx).mode, "standard");
  assert.equal(fixture.messages.at(-1).details.requestedServiceTier, null);
  assert.deepEqual(ctx.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
  assert.equal(ctx.thinkingLevel, "medium");
});
