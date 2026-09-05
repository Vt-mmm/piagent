import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBenchmarkBudgetProcessHooks } from "../scripts/benchmark-budget-ipc.mjs";
import { BENCHMARK_BUDGET_CONTEXT } from "../scripts/benchmark-budget-runtime.mjs";

const stageId = "a".repeat(32);
function fixture(reply) {
  const channel = new EventEmitter();
  Object.assign(channel, { ppid: 42, connected: true, send(message, callback) {
    callback?.(); queueMicrotask(() => reply?.(message, channel));
  } });
  const env = { [BENCHMARK_BUDGET_CONTEXT]: JSON.stringify({ stageId, parentPid: 42 }) };
  const hooks = createBenchmarkBudgetProcessHooks({ env, channel, timeoutMs: 30 });
  return { channel, env, hooks };
}
const receipt = message => ({ ...message, kind: "benchmark-budget-process-ack-v1", accepted: true });

test("unbudgeted commands do not require an IPC channel", () => {
  assert.deepEqual(createBenchmarkBudgetProcessHooks({ env: {}, channel: {} }), {});
});
test("budgeted commands require their direct connected parent", () => {
  const f = fixture();
  f.channel.ppid = 43;
  assert.throws(() => createBenchmarkBudgetProcessHooks(f), /direct launcher IPC/);
});
test("ownership receipts acknowledge concurrent processes and remove listeners", async () => {
  const f = fixture((message, channel) => channel.emit("message", receipt(message)));
  await Promise.all([f.hooks.started(101), f.hooks.started(102)]);
  await f.hooks.closed(101);
  assert.equal(f.channel.listenerCount("message"), 0);
  assert.equal(f.channel.listenerCount("disconnect"), 0);
});
test("foreign receipt and negative acknowledgement fail closed", async () => {
  for (const change of [{ stageId: "b".repeat(32) }, { accepted: false }, { event: "closed" }]) {
    const f = fixture((message, channel) => channel.emit("message", { ...receipt(message), ...change }));
    await assert.rejects(f.hooks.started(101), /mismatched/);
  }
});
test("missing receipts and disconnected launcher fail bounded", async () => {
  const missing = fixture();
  await assert.rejects(missing.hooks.started(101), /timed out/);
  const disconnected = fixture((_message, channel) => channel.emit("disconnect"));
  await assert.rejects(disconnected.hooks.started(101), /disconnected/);
  assert.equal(disconnected.channel.listenerCount("message"), 0);
});
