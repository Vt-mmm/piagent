import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ModelRouteRuntime, readModelRouteEvents } from "../packages/piagent-core/runtime/model/model-route-runtime.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";

const catalog = { schemaVersion: 1, capturedAt: "2026-08-08T00:00:00.000Z", source: "authenticated-catalog", availability: "authenticated", models: [{ provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["medium"] }], warnings: [] };
const features = extractTaskFeatures({ request: "Fix src/a.ts", profileMode: "node-typescript", gitReady: true, verifierReady: true, dirtyTree: false, runtimeCapabilitiesKnown: true, activeTaskState: "none" });

describe("model route shadow runtime", () => {
  it("persists only bounded decisions and reuses identical input", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-route-runtime-"));
    const runtime = new ModelRouteRuntime("shadow", "balance");
    const input = { features, catalog, selectionSource: "global-default", current: { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" }, freshTaskBoundary: true, hostBoundary: "unavailable" };
    const first = runtime.evaluate(cwd, "secret-session", input);
    const second = runtime.evaluate(cwd, "secret-session", input);
    assert.equal(first.status, "ok");
    assert.equal(first.persisted, true);
    assert.equal(second.status, "ok");
    assert.equal(second.reused, true);
    const events = readModelRouteEvents(cwd);
    assert.equal(events.records.length, 1);
    assert.equal(JSON.stringify(events.records).includes("secret-session"), false);
    assert.equal(events.latest.decision.enforced, false);
  });

  it("performs no state write while off", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-route-off-"));
    const result = new ModelRouteRuntime("off", "balance").evaluate(cwd, "s", { features, catalog, selectionSource: "unknown", current: { provider: null, modelId: null, effort: null }, freshTaskBoundary: true, hostBoundary: "unavailable" });
    assert.equal(result.status, "off");
    assert.equal(fs.existsSync(path.join(cwd, ".pi")), false);
  });

  it("cannot switch the parent model or thinking level inside a running task", () => {
    const runtimeSources = [
      "packages/piagent-core/runtime/model/model-route-policy.ts",
      "packages/piagent-core/runtime/model/model-route-runtime.ts"
    ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(runtimeSources, /\bsetModel\b|\bsetThinkingLevel\b|\bspawn(?:Sync)?\b/);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-route-running-task-"));
    const result = new ModelRouteRuntime("auto", "balance").evaluate(cwd, "s", {
      features,
      catalog,
      selectionSource: "workspace-default",
      current: { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" },
      freshTaskBoundary: false,
      hostBoundary: "unavailable"
    });
    assert.equal(result.status, "ok");
    assert.equal(result.decision.disposition, "recommended");
    assert.equal(result.decision.enforced, false);
    assert.ok(result.decision.reasonCodes.includes("not-fresh-task-boundary"));
    assert.ok(result.decision.reasonCodes.includes("safe-host-adapter-unavailable"));
  });
});
