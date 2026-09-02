import assert from "node:assert/strict";
import test from "node:test";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";
import { completionPreparationCurrent, completionPreparationDeferred } from "../packages/piagent-core/runtime/verification/completion-preparation.ts";
import { projectCompositeLifecycle } from "../packages/piagent-core/runtime/verification/composite-runtime-binding.ts";

function fixture() {
  const tasks = new Map();
  const runtime = new IndependentAcceptanceRuntime({ state: {}, installedRoot: "/unused", activeTask: (ctx) => tasks.get(ctx.sessionManager.getSessionId()), authorizeSourceRead: () => false });
  const session = (sessionId) => {
    const ctx = { cwd: "/unused", sessionManager: { getSessionId: () => sessionId } };
    const task = { taskRunId: `run-${sessionId}`, sessionId, trace: { outcome: "pending" } };
    tasks.set(sessionId, task);
    return { ctx, task };
  };
  return { runtime, session, tasks };
}

test("completion preparation is fenced to the active session generation and task", async () => {
  const { runtime, session, tasks } = fixture(), { ctx, task } = session("one");
  assert.equal(await runtime.prepare(ctx, task), false, "preparation cannot activate an unopened session");
  await runtime.activate(ctx);
  const prepared = await runtime.prepare(ctx, task);
  assert.equal(completionPreparationCurrent(prepared), true);
  const closing = runtime.clear(ctx);
  assert.equal(completionPreparationCurrent(prepared), false, "the fence closes before asynchronous teardown resolves");
  await closing;
  assert.equal(await runtime.prepare(ctx, task), false);
  await runtime.activate(ctx);
  assert.equal(completionPreparationCurrent(prepared), false, "reactivation cannot renew a stale completion");
  const current = await runtime.prepare(ctx, task);
  assert.equal(completionPreparationCurrent(current), true);
  tasks.set("one", { ...task, taskRunId: "new-task" });
  assert.equal(completionPreparationCurrent(current), false, "a task switch invalidates an outstanding preparation");
  assert.equal(await runtime.prepare(ctx, { ...task, sessionId: "foreign" }), false);
  tasks.set("one", task);
  const beforeInvalidation = await runtime.prepare(ctx, task);
  ctx.sessionManager.getSessionId = () => { throw new Error("Extension context invalidated"); };
  assert.equal(beforeInvalidation.isCurrent(), false, "an invalidated host getter cannot approve late completion");
});

test("completion preparation rejects malformed or throwing fences without treating truthiness as approval", () => {
  assert.equal(completionPreparationCurrent(undefined), true, "isolated hooks without an optional preparer remain supported");
  assert.equal(completionPreparationCurrent(true), true);
  assert.equal(completionPreparationCurrent({ isCurrent: () => true }), true);
  const deferred = { completion: "deferred", reason: "persistence pending", isCurrent: () => true };
  assert.equal(completionPreparationDeferred(deferred), true);
  assert.equal(completionPreparationCurrent(deferred), false, "deferred content observation cannot authorize completion");
  assert.equal(completionPreparationDeferred({ completion: "ready", isCurrent: () => true }), false);
  assert.equal(completionPreparationDeferred({ completion: "deferred", isCurrent: () => false }), false);
  for (const value of [false, null, 1, "true", {}, { isCurrent: true }, { isCurrent: () => false },
    { isCurrent: () => 1 }, { isCurrent: () => Promise.resolve(true) },
    { isCurrent: () => { throw new Error("stale context"); } },
    { get isCurrent() { throw new Error("disposed accessor"); } }]) {
    assert.equal(completionPreparationCurrent(value), false);
  }
});

test("composite lifecycle projection advances only the exact runtime-owned plan shape and required host facts", () => {
  const source = { schemaVersion: 2, taskRunId: "source-run", sessionId: "source-session", changeMode: "source-change",
    mutationPolicy: "required", riskLane: "tiny", intakeMode: "runtime", trace: { outcome: "pending" },
    acceptanceCriteria: ["Implement and verify the bounded change."], scope: ["src/value.js"], verifyCommands: ["node --test"],
    workPlan: [{ id: "implement", role: "parent", mode: "single-writer", status: "in-progress" },
      { id: "verify", role: "parent", mode: "review", status: "pending", dependsOn: ["implement"] }] };
  const facts = ["bounded-code-checks", "workspace-scope", "tool-policy-complete", "project-verifier-current"];
  const projected = projectCompositeLifecycle(source, facts);
  assert.deepEqual(projected.workPlan.map(step => step.status), ["done", "done"]);
  assert.deepEqual(source.workPlan.map(step => step.status), ["in-progress", "pending"], "projection cannot mutate the active task");
  assert.equal(projectCompositeLifecycle(source, facts.filter(kind => kind !== "tool-policy-complete")), false);

  const readOnly = { ...source, taskRunId: "read-run", changeMode: "read-only", mutationPolicy: "forbidden", riskLane: "normal",
    verifyCommands: [], workPlan: [{ id: "scout", role: "parent", mode: "read-only", status: "pending" },
      { id: "review", role: "piagent-reviewer", mode: "review", status: "pending", dependsOn: ["scout"] }] };
  const readProjected = projectCompositeLifecycle(readOnly,
    ["policy-refusal-output", "workspace-scope", "tool-policy-complete"]);
  assert.deepEqual(readProjected.workPlan.map(step => step.status), ["done", "done"]);
});

test("active lifecycle ownership is bounded without an ever-growing closed-session set", async () => {
  const { runtime, session } = fixture();
  const first = session("first"); await runtime.activate(first.ctx);
  const prepared = await runtime.prepare(first.ctx, first.task);
  for (let index = 0; index < 100; index += 1) await runtime.activate(session(`active-${index}`).ctx);
  assert.equal(completionPreparationCurrent(prepared), false, "the oldest active slot is retired at the bound");
  assert.equal(await runtime.prepare(first.ctx, first.task), false);
  for (let index = 0; index < 1000; index += 1) {
    const value = session(`closed-${index}`);
    await runtime.activate(value.ctx); await runtime.clear(value.ctx);
    assert.equal(await runtime.prepare(value.ctx, value.task), false);
  }
  assert.equal(completionPreparationCurrent(prepared), false);
});
