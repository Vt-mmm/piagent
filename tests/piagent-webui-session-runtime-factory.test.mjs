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

test("production runtime factory wires one host-only scoped router with exact tools and native session identity", async () => {
  const tools = ["scoped_read", "scoped_write_document", "scoped_verify"], observed = {
    services: null, creation: null, ownership: 0, begins: [], finishes: [], disposed: 0
  };
  const router = {
    toolNames: tools,
    extensionFactory() {},
    assertOwnership() { observed.ownership++; },
    beginOperation(identity) { observed.begins.push(identity);
      return reason => observed.finishes.push(reason); },
    settlementEvidence() { return { version: "fixture" }; },
    async dispose() { observed.disposed++; }
  };
  const host = {
    async createAgentSessionServices(options) {
      observed.services = options;
      return { modelRuntime: { getAvailableSnapshot: () => [] }, diagnostics: [],
        resourceLoader: { getExtensions: () => ({ errors: [], extensions: [] }) } };
    },
    async createAgentSessionFromServices(options) {
      observed.creation = options;
      return { session: { getActiveToolNames: () => tools, async bindExtensions() {} } };
    },
    async createAgentSessionRuntime(createRuntime, options) {
      const created = await createRuntime(options);
      return { session: created.session, setRebindSession() {}, async dispose() {} };
    }
  };
  const manager = { getSessionId: () => "native-session" };
  const runtime = await createProductionRuntimeFactory({ host, agentDir: "/private/pi-home", packageRoot,
    scopedBrokerRouter: router })(info, "runtime_ref", manager);
  const finish = runtime.beginWireOperation({ operationRef: "operation-one",
    messageRequestId: "message-one", inputText: "first turn" });
  finish("operation-settled"); await runtime.dispose();
  assert.equal(observed.ownership, 1);
  assert.equal(observed.services.resourceLoaderOptions.noExtensions, true);
  assert.equal(observed.services.resourceLoaderOptions.noSkills, true);
  assert.deepEqual(observed.services.resourceLoaderOptions.extensionFactories, [router.extensionFactory]);
  assert.equal(observed.creation.noTools, "all"); assert.deepEqual(observed.creation.tools, tools);
  assert.deepEqual(observed.begins, [{ sessionId: "native-session", operationRef: "operation-one",
    messageRequestId: "message-one", inputText: "first turn" }]);
  assert.deepEqual(observed.finishes, ["operation-settled"]); assert.equal(observed.disposed, 1);
});
