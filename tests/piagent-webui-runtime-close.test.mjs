import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerIndependentAcceptanceProvider } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/gateway/session-lease-store.ts";
import { SessionRuntimeSupervisor } from "../packages/piagent-webui/gateway/session-runtime-supervisor.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, composite) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-close-settlement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
  const key = Buffer.alloc(32, 7), target = { path: path.join(root, "synthetic.jsonl"), id: "close-session", cwd,
    name: "Close settlement", created: new Date(), modified: new Date(), messageCount: 2,
    firstMessage: "Synthetic close", allMessagesText: "Synthetic close" };
  const entered = deferred(), finish = deferred(), listeners = new Set(), observed = [];
  const events = new GatewayEventStore(); events.subscribe(event => observed.push(event));
  let disposed = 0;
  const session = { isIdle: true, isStreaming: false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt() { for (const listener of listeners) listener({ type: "agent_start" });
      for (const listener of listeners) listener({ type: "agent_settled" }); },
    async abort() {}, clearQueue() {} };
  if (composite) {
    const template = JSON.parse(fs.readFileSync(new URL("../evals/fixtures/task-contract.valid.json", import.meta.url), "utf8"));
    const task = writeTaskContract(cwd, { ...template, taskId: "close-task", taskRunId: "close-task-run",
      sessionId: target.id, sessionName: "Close settlement", trace: { outcome: "pending", recordedAt: new Date().toISOString() } });
    bindSessionTask(cwd, target.id, task.sessionName, task);
    t.after(registerIndependentAcceptanceProvider(cwd, task, { read: () => ({ entries: [] }),
      webUiSettlementApplicability: () => "composite",
      async settleWebUi() { entered.resolve(); await finish.promise; return { status: "settled", taskStatus: "completed" }; } }));
  }
  const leases = new SessionLeaseStore(root, key), ref = sessionRefForPath(key, target.path);
  const supervisor = new SessionRuntimeSupervisor({ gatewayInstanceRef: "gateway_close_test", key, leases, events,
    listSessions: async () => [target], operationWatchdog: { terminationTimeoutMs: 100, projectionTimeoutMs: 100 },
    runtimeFactory: async () => ({ session, async dispose() { disposed++; } }) });
  supervisor.setProjectionReader(async () => {
    if (!composite) { entered.resolve(); await finish.promise; }
    return { sessionRevision: "revision_closed", liveState: "idle" };
  });
  return { supervisor, ref, leases, entered, finish, observed, disposed: () => disposed };
}

test("close waits for ordinary settlement and releases the runtime once", { timeout: 2000 }, async t => {
  const f = fixture(t, false);
  await f.supervisor.send(f.ref, { delivery: "new-operation", message: "Finish", expectedOperationRef: null }, "revision_start");
  await f.entered.promise;
  let closed = false, secondClosed = false;
  const closing = f.supervisor.close().then(() => { closed = true; });
  const secondClosing = f.supervisor.close().then(() => { secondClosed = true; });
  await tick(); assert.equal(closed, false); assert.equal(secondClosed, false);
  f.finish.resolve(); await Promise.all([closing, secondClosing]);
  assert.equal(f.supervisor.activeCount, 0); assert.equal(f.disposed(), 1);
  assert.equal(f.leases.inspect(f.ref).state, "released");
  await f.supervisor.close(); assert.equal(f.disposed(), 1);
});

test("close quarantines stalled settlement and late completion cannot restore authority", { timeout: 2000 }, async t => {
  const f = fixture(t, true);
  await f.supervisor.send(f.ref, { delivery: "new-operation", message: "Finish", expectedOperationRef: null }, "revision_start");
  await f.entered.promise; await f.supervisor.close();
  assert.equal(f.supervisor.activeCount, 0); assert.equal(f.disposed(), 1);
  assert.equal(f.leases.inspect(f.ref).state, "recovery-required");
  f.finish.resolve(); await tick(); await f.supervisor.close();
  assert.equal(f.supervisor.activeCount, 0); assert.equal(f.disposed(), 1);
  assert.equal(f.leases.inspect(f.ref).state, "recovery-required");
  const terminals = f.observed.filter(event => event.kind === "operation.settled");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].payload.settlement, "error");
  assert.equal(terminals[0].payload.reasonCode, "session-runtime-shutdown-incomplete");
});
