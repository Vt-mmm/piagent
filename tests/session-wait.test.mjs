import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionWaitRuntime, SESSION_WAIT_ENTRY } from "../packages/piagent-core/runtime/tools/session-wait.ts";
import { registerSessionWaitTool } from "../packages/piagent-core/runtime/registration/session-wait-tool.ts";
import { phaseToolPolicy } from "../packages/piagent-core/runtime/tools/phase-tools.ts";
import { activeTaskToolGroups, toolGroupsForPrompt } from "../packages/piagent-core/runtime/tools/tool-groups.ts";

const Type = { Object: properties => ({ properties }), Number: options => options, String: options => options };

function harness(branch = []) {
  const hooks = new Map(); let tool; let sessionId = "first";
  const pi = {
    on(name, fn) { hooks.set(name, fn); },
    registerTool(value) { tool = value; },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    sendMessage() { assert.fail("waiting must not dispatch a model message"); },
    sendUserMessage() { assert.fail("waiting must not start another turn"); }
  };
  registerSessionWaitTool(pi, Type);
  const ctx = { cwd: "/fixture", sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
  return { tool, hooks, ctx, branch, switchSession() { sessionId = "second"; } };
}

test("one hour wait remains pending without periodic model updates, then returns only a check reminder", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); let settled = false;
  const p = h.tool.execute("wait-1", { seconds: 3600, nextCheck: "Read the existing job result" }, undefined,
    () => assert.fail("no periodic output"), h.ctx).then((r) => { settled = true; return r; });
  t.mock.timers.tick(3599999); await Promise.resolve();
  assert.equal(settled, false); assert.equal(h.branch.length, 1);
  t.mock.timers.tick(1); const r = await p;
  assert.equal(r.details.outcome, "elapsed");
  assert.equal(r.details.conditionChecked, false); assert.equal(r.details.followUpScheduled, false);
  assert.match(r.content[0].text, /remain unverified/);
  assert.deepEqual(h.branch.map(e => e.data.outcome), ["pending", "elapsed"]);
  assert.equal(h.tool.executionMode, "sequential");
});

test("abort interrupts immediately and removes the timer; other sessions can still wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waits = new SessionWaitRuntime(); const controller = new AbortController();
  const first = waits.wait("first", 3600, controller.signal); const second = waits.wait("second", 1);
  controller.abort(); assert.equal((await first).outcome, "interrupted");
  t.mock.timers.tick(1000); assert.equal((await second).outcome, "elapsed");
  const next = waits.wait("first", 1); t.mock.timers.tick(1000); assert.equal((await next).outcome, "elapsed");
});

test("duplicate active waits are refused without cancelling the existing wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waits = new SessionWaitRuntime(); const p = waits.wait("same", 3600);
  assert.throws(() => waits.wait("same", 1), /already active/);
  waits.interrupt("same"); assert.equal((await p).outcome, "interrupted");
});

test("invalid duration and missing next observation never create a journal entry", async () => {
  for (const seconds of [0, -1, 0.5, 3601, NaN, Infinity, "10"]) {
    const h = harness();
    await assert.rejects(h.tool.execute("invalid", { seconds, nextCheck: "Check once" }, undefined, undefined, h.ctx), /bounded wait/);
    assert.equal(h.branch.length, 0);
  }
  const h = harness();
  for (const nextCheck of ["", "   ", "a".repeat(241)]) {
    await assert.rejects(h.tool.execute("invalid", { seconds: 1, nextCheck }, undefined, undefined, h.ctx), /bounded wait/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.tool.execute("aborted", { seconds: 1, nextCheck: "Check" }, controller.signal, undefined, h.ctx), /before starting/);
  assert.equal(h.branch.length, 0);
});

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
  test(`${event} interrupts the wait without scheduling a new turn`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness(); const p = h.tool.execute("pending", { seconds: 3600, nextCheck: "Inspect once" }, undefined, undefined, h.ctx);
    await h.hooks.get(event)({}, h.ctx);
    assert.equal((await p).details.outcome, "interrupted");
    t.mock.timers.tick(3600000);
    assert.equal(h.branch.length, 2);
  });
}

test("restart retains pending as unknown and refuses replay, without starting a timer", async () => {
  for (const outcome of ["pending", "elapsed", "interrupted"]) {
    const h = harness([{ type: "custom", customType: SESSION_WAIT_ENTRY, data: { toolCallId: "old", outcome } }]);
    await assert.rejects(h.tool.execute("old", { seconds: 1, nextCheck: "Check" }, undefined, undefined, h.ctx), /do not replay/);
    assert.equal(h.branch.length, 1); assert.equal(h.branch[0].data.outcome, outcome);
  }
});

test("a late completion cannot append a receipt into a different session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); const p = h.tool.execute("switch", { seconds: 1, nextCheck: "Check" }, undefined, undefined, h.ctx);
  h.switchSession(); t.mock.timers.tick(1000); await p;
  assert.equal(h.branch.length, 1); assert.equal(h.branch[0].data.outcome, "pending");
});

test("waiting is opt-in by task intent, allowed while working, and forbidden after terminal completion", () => {
  assert.ok(toolGroupsForPrompt("Monitor this job and check back in five minutes").includes("waiting"));
  assert.ok(toolGroupsForPrompt("Chờ rồi kiểm tra lại tiến trình").includes("waiting"));
  assert.equal(toolGroupsForPrompt("Fix the parser").includes("waiting"), false);
  assert.ok(activeTaskToolGroups({ operatorRequest: "Monitor until the job finishes" }).includes("waiting"), "resume retains the original wait intent");
  assert.equal(activeTaskToolGroups({ operatorRequest: "Fix the parser" }).includes("waiting"), false);
  for (const phase of ["intake", "scout", "plan", "execute", "verify", "repair", "review"]) {
    assert.ok(phaseToolPolicy(phase, "read-only").modelVisiblePiagentTools.includes("piagent_wait"));
  }
  assert.equal(phaseToolPolicy("terminal", "source-change").modelVisiblePiagentTools.includes("piagent_wait"), false);
});
