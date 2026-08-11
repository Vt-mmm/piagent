import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { captureAuthenticatedModelCatalog } from "../packages/piagent-core/runtime/model/authenticated-catalog.ts";

const capturedAt = "2026-08-08T00:00:00.000Z";
const model = (provider, id, overrides = {}) => ({ provider, id, contextWindow: 200_000, reasoning: true, input: ["text"], ...overrides });

describe("authenticated model catalog", () => {
  it("sorts exact provider/model ids and removes duplicates deterministically", async () => {
    const registry = {
      getAvailable: () => [model("z-provider", "b"), model("a-provider", "z"), model("z-provider", "b")],
      getAll: () => []
    };
    const result = await captureAuthenticatedModelCatalog(registry, { capturedAt });
    assert.equal(result.availability, "authenticated");
    assert.deepEqual(result.models.map((entry) => `${entry.provider}/${entry.modelId}`), ["a-provider/z", "z-provider/b"]);
  });

  it("reports empty, logged-out, offline, and failed registries without throwing", async () => {
    assert.equal((await captureAuthenticatedModelCatalog({ getAvailable: () => [], getAll: () => [] }, { capturedAt })).availability, "unavailable");
    assert.equal((await captureAuthenticatedModelCatalog({ getAvailable: () => [], getAll: () => [model("p", "m")] }, { capturedAt })).availability, "logged-out");
    assert.equal((await captureAuthenticatedModelCatalog({ getAvailable: () => { throw new Error("Bearer synthetic-secret"); } }, { capturedAt })).availability, "unavailable");
    assert.equal((await captureAuthenticatedModelCatalog(undefined, { capturedAt, offline: true })).availability, "offline");
  });

  it("projects only bounded capability facts and never registry credential material", async () => {
    const result = await captureAuthenticatedModelCatalog({
      getAvailable: () => [model("p", "m", {
        apiKey: "sk-synthetic-secret-value-that-must-not-appear",
        headers: { Authorization: "Bearer synthetic-secret" },
        input: ["text", "image"],
        thinkingLevelMap: { low: 1, medium: 2, high: null }
      })]
    }, { capturedAt });
    assert.equal(result.models[0].imageInput, true);
    assert.deepEqual(result.models[0].supportedThinkingLevels, ["low", "medium"]);
    assert.doesNotMatch(JSON.stringify(result), /apiKey|Authorization|synthetic-secret/);
  });

  it("keeps partial records explicit instead of guessing missing capability values", async () => {
    const result = await captureAuthenticatedModelCatalog({ getAvailable: () => [{ provider: "p", id: "partial" }] }, { capturedAt });
    assert.deepEqual(result.models[0], {
      provider: "p",
      modelId: "partial",
      contextWindow: null,
      reasoning: null,
      imageInput: null,
      supportedThinkingLevels: null
    });
  });
});
