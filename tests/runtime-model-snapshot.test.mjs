import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeRuntimeModelSnapshots,
  captureActiveRuntimeSnapshot,
  RuntimeSnapshotCapture,
  runtimeModelSnapshotDigest,
  runtimeModelSnapshotValidationErrors,
  serializeRuntimeModelSnapshot,
  validateRuntimeModelSnapshot
} from "../packages/piagent-core/runtime/model/runtime-snapshot.ts";

const capturedAt = "2026-08-08T00:00:00.000Z";

function snapshot(source = "pi-runtime", overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt,
    source,
    piHostVersion: source === "pi-runtime" ? "0.82.0" : null,
    piagentVersion: "1.2.17",
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    availability: source === "authenticated-catalog" ? "authenticated" : "unknown",
    contextWindow: source === "pi-runtime" ? 200_000 : null,
    requestedThinkingLevel: "medium",
    effectiveThinkingLevel: source === "pi-runtime" ? "medium" : null,
    supportedThinkingLevels: null,
    capabilities: [{ name: "image-input", value: null, source }],
    provenance: [{ field: "modelId", source, capturedAt }],
    warnings: [],
    ...overrides
  };
}

describe("runtime model snapshot v1", () => {
  it("preserves explicit unknown values and serializes deterministically", () => {
    const value = validateRuntimeModelSnapshot(snapshot());
    assert.equal(value.capabilities[0].value, null);
    assert.equal(value.supportedThinkingLevels, null);
    assert.equal(serializeRuntimeModelSnapshot(value), serializeRuntimeModelSnapshot(structuredClone(value)));
  });

  it("rejects credentials, unknown fields, timestamps, and invalid context windows", () => {
    assert.match(runtimeModelSnapshotValidationErrors({ ...snapshot(), accessToken: "synthetic" }).join("; "), /accessToken/);
    assert.match(runtimeModelSnapshotValidationErrors(snapshot("pi-runtime", { capturedAt: "soon" })).join("; "), /capturedAt/);
    assert.match(runtimeModelSnapshotValidationErrors(snapshot("pi-runtime", { contextWindow: 0 })).join("; "), /contextWindow/);
    assert.throws(() => validateRuntimeModelSnapshot(snapshot("pi-runtime", {
      capabilities: [{ name: "tools", value: true, source: "pi-runtime", password: "synthetic" }]
    })), /password/);
  });

  it("keeps runtime facts above authenticated and profile hints", () => {
    const runtime = snapshot("pi-runtime", { contextWindow: 200_000, capabilities: [{ name: "image-input", value: false, source: "pi-runtime" }] });
    const catalog = snapshot("authenticated-catalog", { contextWindow: 400_000, capabilities: [{ name: "image-input", value: true, source: "authenticated-catalog" }] });
    const profile = snapshot("provider-profile", { contextWindow: 1_000_000 });
    const merged = mergeRuntimeModelSnapshots([profile, catalog, runtime]);
    assert.equal(merged.contextWindow, 200_000);
    assert.deepEqual(merged.capabilities[0], { name: "image-input", value: false, source: "pi-runtime" });
  });

  it("uses lower-trust hints only to fill facts that remain unknown", () => {
    const runtime = snapshot("pi-runtime", { supportedThinkingLevels: null });
    const profile = snapshot("provider-profile", { supportedThinkingLevels: ["low", "medium"] });
    assert.deepEqual(mergeRuntimeModelSnapshots([runtime, profile]).supportedThinkingLevels, ["low", "medium"]);
  });

  it("redacts bounded diagnostic text and ignores capture timestamps in identity digests", () => {
    const first = snapshot("pi-runtime", { warnings: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz"] });
    const second = snapshot("pi-runtime", {
      capturedAt: "2026-08-08T01:00:00.000Z",
      provenance: [{ field: "modelId", source: "pi-runtime", capturedAt: "2026-08-08T01:00:00.000Z" }],
      warnings: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz"]
    });
    assert.doesNotMatch(serializeRuntimeModelSnapshot(first), /abcdefghijklmnopqrstuvwxyz/);
    assert.equal(runtimeModelSnapshotDigest(first), runtimeModelSnapshotDigest(second));
  });

  it("captures missing runtime facts as unknown without throwing", () => {
    const value = captureActiveRuntimeSnapshot({
      model: undefined,
      getContextUsage: () => undefined,
      sessionManager: { getSessionId: () => "session-missing" }
    }, { capturedAt, requestedThinkingLevel: null, effectiveThinkingLevel: null });
    assert.equal(value.provider, null);
    assert.equal(value.modelId, null);
    assert.equal(value.contextWindow, null);
    assert.match(value.warnings.join(" "), /unavailable/);
  });

  it("invalidates the session cache when model, context window, or effort changes", () => {
    let modelId = "gpt-a";
    let contextWindow = 100_000;
    const ctx = {
      get model() { return { provider: "openai-codex", id: modelId }; },
      getContextUsage: () => ({ contextWindow }),
      sessionManager: { getSessionId: () => "session-cache" }
    };
    const cache = new RuntimeSnapshotCapture();
    const first = cache.capture(ctx, { capturedAt, effectiveThinkingLevel: "medium" });
    const same = cache.capture(ctx, { capturedAt: "2026-08-08T01:00:00.000Z", effectiveThinkingLevel: "medium" });
    assert.equal(same.capturedAt, first.capturedAt);
    modelId = "gpt-b";
    const modelChanged = cache.capture(ctx, { capturedAt: "2026-08-08T02:00:00.000Z", effectiveThinkingLevel: "medium" });
    assert.notEqual(modelChanged.capturedAt, first.capturedAt);
    contextWindow = 200_000;
    const contextChanged = cache.capture(ctx, { capturedAt: "2026-08-08T03:00:00.000Z", effectiveThinkingLevel: "medium" });
    assert.equal(contextChanged.contextWindow, 200_000);
    const effortChanged = cache.capture(ctx, { capturedAt: "2026-08-08T04:00:00.000Z", effectiveThinkingLevel: "high" });
    assert.equal(effortChanged.effectiveThinkingLevel, "high");
  });
});
