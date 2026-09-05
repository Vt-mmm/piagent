import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createBenchmarkBudgetProcessRegistry } from "../scripts/benchmark-budget-processes.mjs";

const stageId = "a".repeat(32);
const packet = (event, pid = 12345) => ({ kind: "benchmark-budget-process-v1", stageId, event, pid });

function fakeRegistry(options = {}) {
  const alive = new Set();
  const signals = [];
  let time = 0;
  const registry = createBenchmarkBudgetProcessRegistry({ stageId,
    now: () => time,
    sleep: async ms => { time += ms; },
    groupAlive: pid => alive.has(pid),
    signalGroup: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL") alive.delete(pid); },
    ...options });
  return { registry, alive, signals };
}

test("registry targets only registered provider groups and confirms dead groups", async () => {
  const { registry, alive, signals } = fakeRegistry();
  alive.add(12345); alive.add(99999);
  registry.handleMessage(packet("started"));
  const result = await registry.drain({ termGraceMs: 20, killGraceMs: 20, pollMs: 5 });
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(signals, [[12345, "SIGTERM"], [12345, "SIGKILL"]]);
  assert.equal(alive.has(99999), true);
  assert.deepEqual(result.unconfirmedPids, []);
});

test("confirmed controller cleanup unregisters a group without parent signalling", async () => {
  const { registry, signals } = fakeRegistry();
  registry.handleMessage(packet("started")); registry.handleMessage(packet("closed"));
  assert.equal((await registry.drain()).cleanupConfirmed, true);
  assert.deepEqual(signals, []);
});

test("malformed, foreign, duplicate and unknown-close packets poison cleanup assurance", async () => {
  for (const value of [null, {}, packet("other"), packet("started", 0), packet("started", -1),
    packet("started", 1.5), packet("started", process.pid), { ...packet("started"), stageId: "foreign" },
    { ...packet("started"), extra: true }, packet("closed")]) {
    const { registry } = fakeRegistry();
    assert.throws(() => registry.handleMessage(value), /registry/);
    assert.equal((await registry.drain()).cleanupConfirmed, false);
  }
  const { registry } = fakeRegistry();
  registry.handleMessage(packet("started"));
  assert.throws(() => registry.handleMessage(packet("started")), /duplicate/);
  assert.equal((await registry.drain()).cleanupConfirmed, false);
});

test("a child close message cannot hide a still-live detached provider group", async () => {
  const { registry, alive, signals } = fakeRegistry(); alive.add(12345);
  registry.handleMessage(packet("started"));
  assert.throws(() => registry.handleMessage(packet("closed")), /still alive/);
  const result = await registry.drain({ termGraceMs: 0, killGraceMs: 0 });
  assert.deepEqual(signals, [[12345, "SIGTERM"], [12345, "SIGKILL"]]);
  assert.equal(result.cleanupConfirmed, false);
  assert.deepEqual(result.unconfirmedPids, []);
});

test("bounded drain reports surviving or uninspectable groups instead of assuming exit", async () => {
  for (const groupAlive of [() => true, () => { throw new Error("not inspectable"); }]) {
    const { registry } = fakeRegistry({ groupAlive, signalGroup: () => {} });
    registry.handleMessage(packet("started"));
    const result = await registry.drain({ termGraceMs: 10, killGraceMs: 10, pollMs: 5 });
    assert.equal(result.cleanupConfirmed, false);
    assert.deepEqual(result.unconfirmedPids, [12345]);
  }
});

test("registry rejects late admission after core close and invalid timing bounds", async () => {
  const { registry } = fakeRegistry();
  await registry.drain();
  assert.throws(() => registry.handleMessage(packet("started")), /draining|closed/);
  await assert.rejects(fakeRegistry().registry.drain({ termGraceMs: 100_000 }), /bounds/);
});

test("parent kills a registered detached provider even when its event loop ignores TERM", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setTimeout(()=>{while(true){}},0)"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  const closed = once(child, "close");
  await once(child.stdout, "data");
  const registry = createBenchmarkBudgetProcessRegistry({ stageId });
  registry.handleMessage(packet("started", child.pid));
  const result = await registry.drain({ termGraceMs: 40, killGraceMs: 1000, pollMs: 10 });
  await closed;
  assert.equal(result.cleanupConfirmed, true);
  assert.ok(result.signals.some(value => value.pid === child.pid && value.signal === "SIGKILL"));
});
