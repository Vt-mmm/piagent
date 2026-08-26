import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { webUiModelRef } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createProductionRuntimeFactory } from "../packages/piagent-webui/gateway/session-runtime-factory.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const info = { path: "/private/session.jsonl", id: "session-id", cwd: "/private/project", created: new Date(),
  modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };

function hostFixture(models) {
  const creations = [];
  const host = {
    async createAgentSessionServices() {
      return { modelRuntime: { getAvailableSnapshot: () => models }, diagnostics: [],
        resourceLoader: { getExtensions: () => ({ errors: [] }) } };
    },
    async createAgentSessionFromServices(options) {
      creations.push(options);
      return { session: { async bindExtensions() {} } };
    },
    async createAgentSessionRuntime(createRuntime, options) {
      const initial = await createRuntime(options);
      await createRuntime(options);
      return { session: initial.session, setRebindSession() {}, async dispose() {} };
    }
  };
  return { host, creations };
}

test("production runtime factory applies create options without persisting session defaults", async () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const { host, creations } = hostFixture([model]);
  const factory = createProductionRuntimeFactory({ host, agentDir: "/private/pi-home", packageRoot });

  await factory(info, "runtime_ref", { id: "manager" }, {
    modelRef: webUiModelRef(model.provider, model.id), thinkingLevel: "medium"
  });

  assert.equal(creations.length, 2);
  assert.equal(creations[0].model, model);
  assert.equal(creations[0].thinkingLevel, "medium");
  assert.equal("model" in creations[1], false, "runtime reuse must restore its own session state");
  assert.equal("thinkingLevel" in creations[1], false, "initial composer options are one-shot");
});

test("production runtime factory rejects an unavailable initial model before session construction", async () => {
  const { host, creations } = hostFixture([]);
  const factory = createProductionRuntimeFactory({ host, agentDir: "/private/pi-home", packageRoot });

  await assert.rejects(() => factory(info, "runtime_ref", { id: "manager" }, {
    modelRef: webUiModelRef("openai-codex", "missing"), thinkingLevel: "medium"
  }), /session-model-unavailable/);
  assert.equal(creations.length, 0);
});
