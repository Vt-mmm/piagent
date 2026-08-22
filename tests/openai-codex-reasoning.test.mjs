import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeOpenAiCodexReasoningPayload } from "../packages/piagent-core/runtime/model/openai-codex-reasoning.ts";

function normalize(hostThinkingLevel, payload = { model: "gpt-5.6-sol", stream: true }) {
  return normalizeOpenAiCodexReasoningPayload({
    payload,
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    hostThinkingLevel
  });
}

describe("OpenAI Codex GPT-5.6 reasoning payload compatibility", () => {
  it("maps Pi off to the canonical provider none effort", () => {
    const result = normalize("off");
    assert.equal(result.applicable, true);
    assert.equal(result.changed, true);
    assert.equal(result.hostThinkingLevel, "off");
    assert.equal(result.providerEffort, "none");
    assert.deepEqual(result.payload.reasoning, { effort: "none", summary: "auto" });
  });

  it("maps minimal to low and preserves bounded reasoning fields", () => {
    const result = normalize("minimal", {
      model: "gpt-5.6-sol",
      reasoning: { effort: "minimal", summary: "detailed" },
      stream: true
    });
    assert.equal(result.changed, true);
    assert.equal(result.providerEffort, "low");
    assert.deepEqual(result.payload.reasoning, { effort: "low", summary: "detailed" });
  });

  it("enforces the full host-to-provider effort matrix", () => {
    const matrix = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    for (const [hostLevel, providerEffort] of Object.entries(matrix)) {
      const result = normalize(hostLevel, { model: "gpt-5.6-sol", reasoning: { effort: "wrong", summary: "auto" } });
      assert.equal(result.applicable, true);
      assert.equal(result.changed, true);
      assert.equal(result.expectedProviderEffort, providerEffort);
      assert.equal(result.providerEffort, providerEffort);
      assert.equal(result.payload.reasoning.effort, providerEffort);
    }
  });

  it("observes canonical efforts without rewriting already-correct payloads", () => {
    const matrix = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    for (const [hostLevel, providerEffort] of Object.entries(matrix)) {
      const payload = { model: "gpt-5.6-sol", reasoning: { effort: providerEffort, summary: "auto" } };
      const result = normalize(hostLevel, payload);
      assert.equal(result.applicable, true);
      assert.equal(result.changed, false);
      assert.equal(result.payload, payload);
      assert.equal(result.providerEffort, providerEffort);
    }
    assert.equal(normalize("minimal", { model: "gpt-5.6-sol", reasoning: { effort: "low" } }).changed, false);
  });

  it("does not touch another provider, model family, or mismatched payload model", () => {
    const cases = [
      { provider: "openai", modelId: "gpt-5.6-sol", payload: { model: "gpt-5.6-sol" } },
      { provider: "openai-codex", modelId: "gpt-5.5", payload: { model: "gpt-5.5" } },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", payload: { model: "gpt-5.6-terra" } },
      { provider: "openai-codex", modelId: "gpt-5.6-sol", payload: null }
    ];
    for (const input of cases) {
      const result = normalizeOpenAiCodexReasoningPayload({ ...input, hostThinkingLevel: "off" });
      assert.equal(result.applicable, false);
      assert.equal(result.changed, false);
      assert.equal(result.payload, input.payload);
    }
  });
});
