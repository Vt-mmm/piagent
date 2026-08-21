import assert from "node:assert/strict";
import test from "node:test";

import { PiApprovalBroker } from "../packages/piagent-core/runtime/inspection/approval-broker.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();

const identity = { projectRef: "project.test", runtimeInstanceId: "runtime.test", sessionRef: "session.test", taskId: "task:test",
  taskRunId: "run:test", agentOperationId: "operation.test" };
const revisions = { runtimeRevision: "runtime-rev.test", taskRevision: "task-rev.test", controlRevision: "control-rev.test" };
const tree = { workspaceRevision: "workspace-rev.test", indexRevision: null, preimageDigest: `sha256:${"a".repeat(64)}` };
const shellAction = { kind: "workspace-patch", preconditionClass: "workspace-tree", toolName: "bash",
  rawAction: { command: "printf secret" }, commandPreview: "printf sk-proj-abcdefghijklmnopqrstuvwxyz123456", parameterPreview: "api_key=secret",
  targetPaths: ["src/app.ts"], targetSummaries: ["writes a source file"], provider: null, urlOrigin: null, requestedScope: "one-shell-command",
  reason: "Command can modify source", riskClass: "high", allowConsequence: "Run once", denyConsequence: "Block", treePrecondition: tree };
const externalAction = { kind: "external-provider-action", preconditionClass: "runtime-only", toolName: "mcp__github__create_issue",
  rawAction: { token: "sk-proj-abcdefghijklmnopqrstuvwxyz123456", action: "create" }, commandPreview: null, parameterPreview: "Create issue",
  targetPaths: [], targetSummaries: [], provider: "github", urlOrigin: "https://github.com", requestedScope: "one-external-action",
  reason: "External write", riskClass: "high", allowConsequence: "Create once", denyConsequence: "Block" };

function setup() {
  const broker = new PiApprovalBroker(); let taskState = "active", currentRevisions = { ...revisions };
  broker.bind({ cwd: "/repo", rawSessionId: "raw-session", runtimeInstanceId: identity.runtimeInstanceId,
    authority: () => ({ identity, revisions: currentRevisions, taskState }) });
  return { broker, terminal: deferred(), setTaskState(value) { taskState = value; }, setControlRevision(value) { currentRevisions = { ...currentRevisions, controlRevision: value }; } };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function decision(request, answer = "allow", overrides = {}) {
  return { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "decision", approvalRef: request.approvalRef,
    decisionId: "decision.web", decisionToken: request.decisionToken, identity: structuredClone(request.identity), actionDigest: request.action.actionDigest,
    expectedRevisions: structuredClone(request.expectedRevisions), decision: answer, reason: null, decidedAt: new Date().toISOString(),
    expiresAt: request.expiresAt, decisionSurface: "webui", executor: "pi-guard", directExecution: false, ...overrides };
}
async function pending(setupValue, action = shellAction) {
  const promise = setupValue.broker.request({ cwd: "/repo", rawSessionId: "raw-session", toolCallId: "tool.test", action,
    terminalConfirm: () => setupValue.terminal.promise, recheck: () => true, ttlMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const projection = setupValue.broker.projection("/repo", "raw-session");
  const request = setupValue.broker.detail("/repo", "raw-session", projection.summary.pending[0].approvalRef);
  return { promise, projection, request };
}

test("WebUI allow is provisional, redacted, exact-bound and consumed once", async () => {
  const current = setup(), item = await pending(current);
  assert.equal(item.projection.summary.state, "waiting");
  const requestValidation = validateFixture(registry, "approval-v1", item.request);
  assert.equal(requestValidation.valid, true, requestValidation.errors);
  assert.equal(JSON.stringify(item.request).includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(JSON.stringify(item.request).includes("api_key=secret"), false);
  const receiptPromise = current.broker.decide("/repo", "raw-session", item.request.approvalRef, decision(item.request));
  const guard = await item.promise;
  assert.equal(guard.allowed, true); assert.equal(guard.receipt.permit.status, "provisional");
  assert.equal(guard.consume(), true); assert.equal(guard.consume(), true);
  const receipt = await receiptPromise;
  const receiptValidation = validateFixture(registry, "approval-v1", receipt);
  assert.equal(receiptValidation.valid, true, receiptValidation.errors);
  assert.equal(receipt.permit.status, "consumed"); assert.equal(receipt.winnerSurface, "webui");
  const replay = await current.broker.decide("/repo", "raw-session", item.request.approvalRef, decision(item.request));
  assert.equal(replay.deduplicated, true); assert.equal(replay.permit.status, "consumed");
});

test("provider tool-call IDs outside the public ref alphabet are brokered as opaque refs", async () => {
  const current = setup();
  const providerToolCallId = "call_ZS4wdqvNqZ2VUAl2NNAXIRJU|fc_0a7bbd5bd03d96fb016a872a10be0081";
  const promise = current.broker.request({ cwd: "/repo", rawSessionId: "raw-session", toolCallId: providerToolCallId,
    action: shellAction, terminalConfirm: () => current.terminal.promise, recheck: () => true, ttlMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const projection = current.broker.projection("/repo", "raw-session");
  assert.equal(projection.summary.state, "waiting");
  const request = current.broker.detail("/repo", "raw-session", projection.summary.pending[0].approvalRef);
  assert.match(request.identity.toolCallId, /^tool\.[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(request).includes(providerToolCallId), false);
  const receiptPromise = current.broker.decide("/repo", "raw-session", request.approvalRef, decision(request));
  const guard = await promise;
  assert.equal(guard.allowed, true); assert.equal(guard.consume(), true);
  assert.equal((await receiptPromise).permit.status, "consumed");
});

test("Gateway fallback denies immediately when approval brokering is unavailable", async () => {
  const broker = new PiApprovalBroker();
  const guard = await broker.request({ cwd: "/repo", rawSessionId: "missing-session", toolCallId: "tool.missing",
    action: externalAction, terminalConfirm: () => new Promise(() => undefined), unavailableFallback: "deny" });
  assert.equal(guard.allowed, false); assert.equal(guard.brokered, false); assert.equal(guard.consume(), false);
});

test("terminal and WebUI race has exactly one winner", async () => {
  const terminalFirst = setup(), one = await pending(terminalFirst);
  terminalFirst.terminal.resolve(false); const denied = await one.promise;
  assert.equal(denied.allowed, false); assert.equal(denied.receipt.winnerSurface, "terminal");
  await assert.rejects(() => terminalFirst.broker.decide("/repo", "raw-session", one.request.approvalRef,
    decision(one.request, "allow", { decisionId: "decision.late" })), /resolved|pending/);

  const webFirst = setup(), two = await pending(webFirst);
  const receiptPromise = webFirst.broker.decide("/repo", "raw-session", two.request.approvalRef, decision(two.request));
  const allowed = await two.promise; webFirst.terminal.resolve(false);
  assert.equal(allowed.consume(), true); assert.equal((await receiptPromise).winnerSurface, "webui");
});

test("stale, replayed, cross-session and malformed decisions fail closed", async () => {
  const current = setup(), item = await pending(current);
  await assert.rejects(() => current.broker.decide("/repo", "raw-session", item.request.approvalRef,
    decision(item.request, "allow", { decisionToken: "x".repeat(32) })), /invalid/);
  await assert.rejects(() => current.broker.decide("/repo", "other-session", item.request.approvalRef, decision(item.request)), /unavailable/);
  await assert.rejects(() => current.broker.decide("/repo", "raw-session", item.request.approvalRef,
    decision(item.request, "allow", { decidedAt: "2026-99-99T00:00:00.000Z" })), /invalid/);
  current.terminal.resolve(false); await item.promise;
});

test("revision or task transition cancels an allow before tool start", async () => {
  const changed = setup(), one = await pending(changed);
  const receiptOne = changed.broker.decide("/repo", "raw-session", one.request.approvalRef, decision(one.request));
  const guardOne = await one.promise; changed.setControlRevision("control-rev.changed");
  assert.equal(guardOne.consume(), false); assert.equal((await receiptOne).permit.status, "cancelled");

  const terminal = setup(), two = await pending(terminal);
  const receiptTwo = terminal.broker.decide("/repo", "raw-session", two.request.approvalRef, decision(two.request));
  const guardTwo = await two.promise; terminal.setTaskState("terminal");
  assert.equal(guardTwo.consume(), false); assert.equal((await receiptTwo).permit.status, "cancelled");
});

test("runtime replacement cancels pending approval and rejects the old token", async () => {
  const current = setup(), item = await pending(current);
  current.broker.bind({ cwd: "/repo", rawSessionId: "raw-session", runtimeInstanceId: "runtime.new",
    authority: () => ({ identity: { ...identity, runtimeInstanceId: "runtime.new" }, revisions, taskState: "active" }) });
  const guard = await item.promise;
  assert.equal(guard.allowed, false); assert.equal(guard.receipt.winnerSurface, "runtime-restart");
  await assert.rejects(() => current.broker.decide("/repo", "raw-session", item.request.approvalRef, decision(item.request)), /pending/);
});

test("operation abort resolves its exact pending approval", async () => {
  const current = setup(), item = await pending(current);
  assert.equal(current.broker.cancelForOperation("/repo", "raw-session", identity.agentOperationId), 1);
  const guard = await item.promise;
  assert.equal(guard.allowed, false); assert.equal(guard.receipt.winnerSurface, "runtime-control");
  assert.equal(guard.receipt.resolutionReason, "operation-aborted");
});

test("runtime expiry defaults to deny and never issues a permit", async () => {
  const current = setup();
  let deadline;
  const keepAlive = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("approval-expiry-timeout")), 7_000); });
  const guard = await Promise.race([current.broker.request({ cwd: "/repo", rawSessionId: "raw-session", toolCallId: "tool.expiry", action: externalAction,
    expectedTask: { taskId: identity.taskId, taskRunId: identity.taskRunId }, terminalConfirm: () => current.terminal.promise, ttlMs: 5_000 }), keepAlive]);
  clearTimeout(deadline);
  assert.equal(guard.allowed, false); assert.equal(guard.receipt.state, "expired"); assert.equal(guard.receipt.permit.status, "expired");
  assert.equal(guard.receipt.winnerSurface, "runtime-expiry");
});

test("subscriber failures and browser disconnect do not resolve approval", async () => {
  const current = setup(); current.broker.subscribe("/repo", "raw-session", () => { throw new Error("ui crashed"); });
  const item = await pending(current);
  assert.equal(current.broker.projection("/repo", "raw-session").summary.state, "waiting");
  current.terminal.resolve(false); assert.equal((await item.promise).allowed, false);
});

test("external-provider request has schema-valid provider evidence without raw credentials", async () => {
  const current = setup(), item = await pending(current, externalAction);
  const validation = validateFixture(registry, "approval-v1", item.request); assert.equal(validation.valid, true, validation.errors);
  assert.equal(JSON.stringify(item.request).includes("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(item.request.action.providerRef, /^provider\./); current.terminal.resolve(false); await item.promise;
});
