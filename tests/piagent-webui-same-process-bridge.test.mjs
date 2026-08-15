import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PINNED_BRIDGE_HOST_VERSION,
  probeSameProcessBridge
} from "../packages/piagent-core/runtime/inspection/same-process-bridge-proof.ts";
import { buildWebUiInspectionProjection } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const registry = createWebUiSchemaRegistry();

function surfaces(overrides = {}) {
  let invoked = 0;
  const action = () => { invoked += 1; throw new Error("probe invoked an action method"); };
  const pi = { on: action, sendUserMessage: action, setModel: action, setThinkingLevel: action, ...overrides.pi };
  const ctx = {
    abort: action, hasPendingMessages: action, getContextUsage: action,
    scopedModels: [{ model: { provider: "test", id: "model" } }], thinkingLevel: "xhigh",
    sessionManager: { getSessionId: () => "private-current-session-id", getBranch: action },
    ...overrides.ctx
  };
  return { pi, ctx, invoked: () => invoked };
}

describe("Piagent WebUI same-process bridge proof", () => {
  it("proves current-session chat/stream feasibility without invoking model or control actions", () => {
    const surface = surfaces();
    const proof = probeSameProcessBridge({ hostVersion: PINNED_BRIDGE_HOST_VERSION, runtimeInstanceId: "runtime_01", pi: surface.pi, ctx: surface.ctx });
    assert.equal(surface.invoked(), 0);
    assert.equal(proof.compatible, true);
    assert.equal(proof.overall, "inspect-and-chat-feasible");
    assert.equal(proof.productionControlAllowed, false);
    assert.equal(proof.secondRuntimeAllowed, false);
    assert.match(proof.sessionRef, /^session\.[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(proof).includes("private-current-session-id"), false);
    for (const key of ["sameProcessIdentity", "chatDispatch", "assistantStreaming", "toolStreaming", "providerObservation", "sessionOptions", "attachments"]) {
      assert.equal(proof.features[key].state, "proven", key);
    }
  });

  it("keeps Stop partial and semantic Pause, Resume and approval unavailable on Pi 0.84.1", () => {
    const surface = surfaces(), proof = probeSameProcessBridge({ hostVersion: "0.84.1", runtimeInstanceId: "runtime_01", pi: surface.pi, ctx: surface.ctx });
    assert.equal(proof.features.stop.state, "partial");
    assert.equal(proof.features.stop.reasonCode, "void-abort-without-operation-ack");
    assert.equal(proof.features.pause.state, "unavailable");
    assert.equal(proof.features.pause.reasonCode, "semantic-pause-api-unavailable");
    assert.equal(proof.features.resume.state, "unavailable");
    assert.equal(proof.features.queueObservation.state, "partial");
    assert.equal(proof.features.queueObservation.reasonCode, "queue-boolean-only");
    assert.equal(proof.features.approvalBroker.state, "unavailable");
    assert.equal(proof.features.usageTotals.state, "partial");
    assert.equal(surface.invoked(), 0);
  });

  it("fails closed on unsupported host, missing session identity or incomplete extension surface", () => {
    const complete = surfaces();
    const unsupported = probeSameProcessBridge({ hostVersion: "0.85.0", runtimeInstanceId: "runtime_01", pi: complete.pi, ctx: complete.ctx });
    assert.equal(unsupported.compatible, false); assert.equal(unsupported.overall, "inspect-only");
    assert.equal(unsupported.features.sameProcessIdentity.reasonCode, "unsupported-host-version");
    const incomplete = surfaces({ pi: { sendUserMessage: undefined }, ctx: { sessionManager: { getSessionId: () => "", getBranch: () => [] } } });
    const unavailable = probeSameProcessBridge({ hostVersion: "0.84.1", runtimeInstanceId: "runtime_01", pi: incomplete.pi, ctx: incomplete.ctx });
    assert.equal(unavailable.sessionRef, null); assert.equal(unavailable.overall, "inspect-only");
    assert.equal(unavailable.features.chatDispatch.state, "unavailable");
  });

  it("stays aligned with the pinned package contract and contains no second-runtime path", () => {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const corePackage = JSON.parse(fs.readFileSync(path.join(root, "packages/piagent-core/package.json"), "utf8"));
    assert.equal(rootPackage.peerDependencies["@earendil-works/pi-coding-agent"], PINNED_BRIDGE_HOST_VERSION);
    assert.equal(corePackage.peerDependencies["@earendil-works/pi-coding-agent"], PINNED_BRIDGE_HOST_VERSION);
    const source = fs.readFileSync(path.join(root, "packages/piagent-core/runtime/inspection/same-process-bridge-proof.ts"), "utf8");
    for (const forbidden of ["node:child_process", "spawn(", "exec(", "pi --session", "RpcClient", "AgentSession"]) assert.equal(source.includes(forbidden), false, forbidden);
  });

  it("keeps the public handshake inspect-only until the remaining chat-control gates pass", async () => {
    const cwd = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "piagent-webui-bridge-snapshot-"));
    const projection = await buildWebUiInspectionProjection({ cwd, sessionId: "private-session-id", runtimeInstanceId: "runtime_01",
      generatedAt: "2026-08-13T05:30:00.000Z" });
    const capabilities = projection.snapshot.capabilities;
    assert.equal(capabilities.mode, "inspect-only");
    assert.equal(capabilities.capabilities["control.chat"].status, "unavailable");
    assert.equal(capabilities.capabilities["control.chat"].reason.code, "chat-control-not-enabled");
    assert.equal(capabilities.capabilities["control.lifecycle"].reason.code, "lifecycle-contract-incomplete");
    const result = validateFixture(registry, "snapshot-v1", projection.snapshot);
    assert.equal(result.valid, true, result.errors);
  });
});
