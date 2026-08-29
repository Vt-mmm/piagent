import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  WEBUI_RUNTIME_ACTIONS,
  WEBUI_RUNTIME_ACTION_IDS,
  buildWebUiRuntimeCommand
} from "../packages/piagent-core/runtime/workflows/webui-runtime-command.ts";
import { WEBUI_WORKFLOW_IDS, buildWebUiWorkflowCommand } from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import { RuntimeCommandController } from "../packages/piagent-webui/gateway/runtime-command-controller.ts";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { executeRuntimeCommand as executeHostRuntimeCommand } from "../packages/piagent-webui/gateway/runtime-session-controls.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const baseCatalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/session-catalog-v1.valid.json"), "utf8"));

function command(overrides = {}) {
  return { schemaVersion: 1, version: "piagent-runtime-command-v1", messageType: "command",
    requestId: "runtime_request_01", sessionRef: "session_01", expectedSessionRevision: "session_rev_01",
    action: "runtime.status", argument: null, confirmed: false, ...overrides };
}

function serviceTierDetails(overrides = {}) {
  return { schemaVersion: 1, enabled: true, mode: "fast", source: "session-command", requestedServiceTier: "fast",
    observedRequestServiceTier: null, providerResponseServiceTier: null, providerResponseEvidence: "unavailable-host-api",
    provider: "openai-codex", modelId: "gpt-5.6-luna", applied: false, reasonCode: "fast-request-pending", ...overrides };
}

function serviceTierOutput(details = serviceTierDetails()) {
  return { customType: "piagent-service-tier-receipt", content: `fastMode: ${details.mode}`,
    truncated: false, redacted: false, details };
}

function harness(runtimeResult = { outputs: [{ customType: "piagent-status", content: "status: ready", truncated: false, redacted: false }], modelCallObserved: false }) {
  let calls = 0, observedCommand = null;
  const catalog = structuredClone(baseCatalog), events = new GatewayEventStore();
  const runtimes = { async runRuntimeCommand(_sessionRef, value) { calls += 1; observedCommand = value; return runtimeResult; } };
  const controller = new RuntimeCommandController({ catalog: async () => catalog, runtimes, events });
  return { controller, events, calls: () => calls, observedCommand: () => observedCommand };
}

describe("WebUI runtime command parity", () => {
  it("maps all ten WebUI workflow choices to the exact Terminal workflow ingress", () => {
    assert.equal(WEBUI_WORKFLOW_IDS.length, 10);
    for (const workflow of WEBUI_WORKFLOW_IDS) {
      assert.equal(buildWebUiWorkflowCommand(workflow, "deep logic request"), `/workflow ${workflow} deep logic request`);
    }
    const multiline = "Inspect the boundary.\n\nConstraints:\n- preserve paragraphs\n- preserve lists";
    assert.equal(buildWebUiWorkflowCommand("scout", multiline), `/workflow scout ${multiline}`);
    assert.equal(buildWebUiWorkflowCommand(null, "plain request"), "plain request");
  });

  it("maps every advertised UI action to one bounded Terminal command", () => {
    assert.deepEqual(WEBUI_RUNTIME_ACTIONS.map((item) => item.id), [...WEBUI_RUNTIME_ACTION_IDS]);
    for (const spec of WEBUI_RUNTIME_ACTIONS) {
      const argument = spec.argument === "none" ? null : spec.argument === "profile" ? "web-frontend"
        : spec.argument === "connection" ? "github" : "benchmark parity";
      const built = buildWebUiRuntimeCommand({ action: spec.id, argument, confirmed: spec.requiresConfirmation });
      assert.ok(built.command.startsWith("/"), spec.id);
      assert.equal(built.command.includes("\n"), false, spec.id);
      assert.equal(built.spec, spec);
    }
  });

  it("requires explicit confirmation for every write or model-assisted control", () => {
    for (const spec of WEBUI_RUNTIME_ACTIONS.filter((item) => item.requiresConfirmation)) {
      const argument = spec.argument === "profile" ? "web-frontend" : spec.argument === "connection" ? "github" : null;
      assert.throws(() => buildWebUiRuntimeCommand({ action: spec.id, argument }), /confirmation-required/);
    }
  });

  it("maps visible Fast controls to the same zero-turn Terminal command", () => {
    const status = buildWebUiRuntimeCommand({ action: "runtime.fast-status" });
    const on = buildWebUiRuntimeCommand({ action: "runtime.fast-on", confirmed: true });
    const off = buildWebUiRuntimeCommand({ action: "runtime.fast-off", confirmed: true });
    assert.equal(status.command, "/fast status");
    assert.equal(status.spec.effect, "read-only");
    assert.equal(on.command, "/fast on");
    assert.equal(off.command, "/fast off");
    assert.equal(on.spec.effect, "session-setting");
    assert.equal(off.spec.effect, "session-setting");
    assert.throws(() => buildWebUiRuntimeCommand({ action: "runtime.fast-on" }), /confirmation-required/);
  });

  it("carries only an exact structured Fast receipt across the runtime boundary", async () => {
    const exact = serviceTierDetails();
    const session = { messages: [], async prompt() { this.messages.push({ role: "custom",
      customType: "piagent-service-tier-receipt", content: "fastMode: fast", details: exact }); } };
    const accepted = await executeHostRuntimeCommand(session, "/fast on");
    assert.deepEqual(accepted.outputs[0].details, exact);
    assert.equal(accepted.modelCallObserved, false);

    const invalidSession = { messages: [], async prompt() { this.messages.push({ role: "custom",
      customType: "piagent-service-tier-receipt", content: "fastMode: fast", details: { ...exact, injected: true } }); } };
    const rejected = await executeHostRuntimeCommand(invalidSession, "/fast on");
    assert.equal(rejected.outputs[0].details, undefined);
  });

  it("dispatches Fast session controls as zero-turn commands and fails visible if a model turn starts", async () => {
    const target = harness({ outputs: [serviceTierOutput()], modelCallObserved: false });
    const receipt = await target.controller.execute(command({ requestId: "runtime_request_fast_on",
      action: "runtime.fast-on", confirmed: true }));
    assert.equal(target.observedCommand(), "/fast on");
    assert.equal(receipt.state, "settled");
    assert.equal(receipt.effect, "session-setting");
    assert.equal(receipt.modelCallObserved, false);
    assert.equal(receipt.outputs[0].customType, "piagent-service-tier-receipt");
    assert.equal(receipt.outputs[0].details.reasonCode, "fast-request-pending");
    assert.equal(validateFixture(createWebUiSchemaRegistry(), "runtime-command-v1", receipt).valid, true);

    const disabledDetails = serviceTierDetails({ enabled: false, mode: "standard", requestedServiceTier: null,
      reasonCode: "fast-mode-disabled" });
    const disabled = await harness({ outputs: [serviceTierOutput(disabledDetails)], modelCallObserved: false }).controller.execute(command({
      requestId: "runtime_request_fast_off", action: "runtime.fast-off", confirmed: true
    }));
    assert.equal(disabled.state, "settled");
    assert.equal(disabled.resultCode, "completed");
    assert.deepEqual(disabled.outputs[0].details, disabledDetails);

    const violation = harness({ outputs: [serviceTierOutput(disabledDetails)], modelCallObserved: true });
    const failed = await violation.controller.execute(command({ requestId: "runtime_request_fast_violation",
      action: "runtime.fast-off", confirmed: true }));
    assert.equal(failed.state, "uncertain");
    assert.equal(failed.resultCode, "effect-unknown");
    assert.equal(failed.reasonCode, "session-setting-command-started-model-call");
  });

  it("fails Fast controls visible when the exact structured receipt is missing or malformed", async () => {
    const missing = await harness({ outputs: [], modelCallObserved: false }).controller.execute(command({
      requestId: "runtime_request_fast_missing", action: "runtime.fast-on", confirmed: true
    }));
    assert.equal(missing.state, "uncertain");
    assert.equal(missing.resultCode, "effect-unknown");
    assert.equal(missing.reasonCode, "fast-service-tier-receipt-missing");

    const malformed = await harness({ outputs: [{ ...serviceTierOutput(), details: { ...serviceTierDetails(), unexpected: true } }],
      modelCallObserved: false }).controller.execute(command({
      requestId: "runtime_request_fast_invalid", action: "runtime.fast-on", confirmed: true
    }));
    assert.equal(malformed.state, "uncertain");
    assert.equal(malformed.resultCode, "effect-unknown");
    assert.equal(malformed.reasonCode, "fast-service-tier-receipt-invalid");
    assert.equal(malformed.outputs[0].details, undefined, "invalid structured details must not cross the Gateway boundary");
  });

  it("reports an unsupported Fast provider as unavailable instead of green success", async () => {
    const unsupportedDetails = serviceTierDetails({ observedRequestServiceTier: null, provider: "anthropic",
      modelId: "claude-sonnet", applied: false, reasonCode: "provider-not-supported" });
    const receipt = await harness({ outputs: [serviceTierOutput(unsupportedDetails)], modelCallObserved: false }).controller.execute(command({
      requestId: "runtime_request_fast_unsupported", action: "runtime.fast-on", confirmed: true
    }));
    assert.equal(receipt.state, "rejected");
    assert.equal(receipt.resultCode, "unavailable");
    assert.equal(receipt.reasonCode, "provider-not-supported");
    assert.deepEqual(receipt.outputs[0].details, unsupportedDetails);
  });

  it("executes a read-only command once, validates its receipt, and deduplicates replay", async () => {
    const target = harness();
    const first = await target.controller.execute(command());
    const second = await target.controller.execute(command());
    assert.equal(first.state, "settled");
    assert.equal(first.effect, "read-only");
    assert.equal(first.modelCallObserved, false);
    assert.equal(first.outputs[0].content, "status: ready");
    assert.equal(target.observedCommand(), "/piagent-status");
    assert.equal(target.calls(), 1);
    assert.deepEqual(second, first);
    assert.equal(target.events.stateVersion, 1);
    assert.equal(validateFixture(createWebUiSchemaRegistry(), "runtime-command-v1", first).valid, true);
  });

  it("rejects stale revisions and unconfirmed writes before runtime dispatch", async () => {
    const target = harness();
    const stale = await target.controller.execute(command({ requestId: "runtime_request_stale", expectedSessionRevision: "session_rev_old" }));
    const unconfirmed = await target.controller.execute(command({ requestId: "runtime_request_write", action: "context.rebuild" }));
    assert.equal(stale.resultCode, "stale-revision");
    assert.equal(unconfirmed.resultCode, "confirmation-required");
    assert.equal(target.calls(), 0);
  });

  it("fails closed when a read-only handler unexpectedly starts a model call", async () => {
    const target = harness({ outputs: [], modelCallObserved: true });
    const receipt = await target.controller.execute(command());
    assert.equal(receipt.state, "uncertain");
    assert.equal(receipt.resultCode, "effect-unknown");
    assert.equal(receipt.reasonCode, "read-only-command-started-model-call");
  });

  it("allows the explicitly confirmed compact action to report a model call", async () => {
    const target = harness({ outputs: [], modelCallObserved: true });
    const receipt = await target.controller.execute(command({ action: "context.compact", argument: "deep benchmark", confirmed: true }));
    assert.equal(receipt.state, "settled");
    assert.equal(receipt.effect, "model-assisted");
    assert.equal(receipt.modelCallObserved, true);
  });
});
