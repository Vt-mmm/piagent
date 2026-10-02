import assert from "node:assert/strict";
import { test } from "node:test";

import { projectTranscript } from "../packages/piagent-webui/server/transcript-projection.ts";
import { managedProjection } from "../packages/piagent-webui/gateway/managed-projection.ts";
import { timelineTurns } from "../packages/piagent-webui/client/src/timeline-view-model.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

// What the member sees of the Harness workflow: the agent's checklist, each
// time the harness sent the agent back (checks, blocking review findings) and
// how the turn ended. Findings are redacted like any other text.
const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.process", runtimeInstanceId: "runtime.process", sessionRef: "session.process",
  taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
const revision = { runtimeRevision: "runtime_rev_01", taskRevision: null, controlRevision: null, workspaceRevision: null,
  indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: "queue_rev_01" };
let clock = 0;
const at = () => `2026-10-01T09:00:${String(clock++).padStart(2, "0")}.000Z`;
const message = (id, role, content, extra = {}) => ({ id, type: "message", timestamp: at(), message: { role, content, ...extra } });
const note = (id, customType, details, content = "model-facing text") => ({ id, type: "custom_message", timestamp: at(), customType, content, display: true, details });

test("harness process notes reach the timeline in order, with redacted findings and the plan as a tool step", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
  const value = projectTranscript({ identity, revision, eventCursor: "cursor.process", generatedAt: "2026-10-01T09:01:00.000Z", entries: [
    message("e1", "user", [{ type: "text", text: "Fix the cart total" }]),
    message("e2", "assistant", [{ type: "toolCall", id: "p1", name: "update_plan", arguments: { plan: [{ step: "Read cart.js", status: "completed" }, { step: "Fix total", status: "in_progress" }] } },
      { type: "toolCall", id: "w1", name: "write", arguments: { path: "/work/cart.js", content: "x" } }], { stopReason: "toolUse" }),
    message("e3", "assistant", [{ type: "text", text: "Done." }], { stopReason: "stop" }),
    note("e4", "agent-watch-process", { phase: "verify", loop: 1, maxLoops: 2, lastCheckFailed: false }),
    note("e5", "agent-watch-helper-receipt", { role: "review" }, "Review: 1,200 tokens"),
    note("e6", "agent-watch-process", { phase: "review", loop: 2, maxLoops: 2, findings: [{ severity: "blocking", file: "cart.js", line: 3, issue: `uses ${secret}`, evidence: "x" },
      { severity: "style", file: "x", line: 1, issue: "ignored" }] }),
    message("e7", "assistant", [{ type: "text", text: "Fixed." }], { stopReason: "stop" }),
    note("e8", "agent-watch-process", { phase: "plan", planOpen: 1 }),
    message("e9", "assistant", [{ type: "text", text: "The checklist stays: the last step was not needed." }], { stopReason: "stop" }),
    note("e10", "agent-watch-process", { phase: "final", outcome: "clean", verified: true, reviewed: true, blockingOpen: 0, planOpen: 1, planSkipped: true, checks: 2, fixLoops: 2, policy: { verify: "require", review: "require" } }),
  ] });
  const validation = validateFixture(registry, "transcript-v1", value);
  assert.equal(validation.valid, true, validation.errors);
  const processes = value.items.filter(item => item.process);
  assert.deepEqual(processes.map(item => item.process.phase), ["verify", "review", "plan", "final"]);
  assert.equal(value.items.filter(item => item.role === "custom").length, 4, "other harness notes stay out");
  assert.deepEqual(processes[1].process.findings.map(f => [f.severity, f.file, f.line]), [["blocking", "cart.js", 3]]);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.deepEqual(processes[2].process, { phase: "plan", planOpen: 1 });
  assert.deepEqual(processes[3].process, { phase: "final", outcome: "clean", verified: true, reviewed: true, blockingOpen: 0, planOpen: 1, planSkipped: true, verifyPolicy: "require", reviewPolicy: "require" });
  const plan = value.items.find(item => item.toolCalls[0]?.summary?.kind === "plan").toolCalls[0].summary;
  assert.deepEqual([plan.target, plan.detail], ["1/2", "Fix total"]);
  const [turn] = timelineTurns(value.items);
  // The answer the harness sent back stays a step; how the turn ended follows the final answer.
  assert.deepEqual(turn.steps.map(step => step.kind === "note" ? step.text : step.kind), ["tool", "tool", "Done.", "process", "process", "Fixed.", "process"]);
  assert.equal(turn.answer, "The checklist stays: the last step was not needed."); assert.equal(turn.process.outcome, "clean");
});

test("the session row carries the checklist and the last turn's process, and drops malformed ones", () => {
  const context = { model: { provider: "agent_watch_managed" } };
  const plan = { type: "custom", customType: "agent-watch-plan", data: { plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "in_progress" }] } };
  const final = (outcome, extra = {}) => ({ type: "custom_message", customType: "agent-watch-process", details: { phase: "final", outcome, verified: false, reviewed: true, blockingOpen: 2, ...extra } });
  const out = managedProjection(context, [plan, final("clean"), { type: "custom_message", customType: "agent-watch-process", details: { phase: "verify" } }, final("blocking_open")]);
  assert.deepEqual(out.managedPlan, { steps: [{ step: "Read", status: "completed" }, { step: "Fix", status: "in_progress" }] });
  assert.deepEqual(out.managedProcess, { outcome: "blocking_open", verified: false, reviewed: true, blockingOpen: 2 });
  // A turn that changed code before its required plan says so on the row too; only `true` is kept.
  assert.equal(managedProjection(context, [final("clean", { planSkipped: true })]).managedProcess.planSkipped, true);
  assert.equal("planSkipped" in managedProjection(context, [final("clean", { planSkipped: "yes" })]).managedProcess, false);
  const bad = managedProjection(context, [{ ...plan, data: { plan: [{ step: "x", status: "done" }] } }, final("great")]);
  assert.equal(bad.managedPlan, undefined); assert.equal(bad.managedProcess, undefined);
  assert.deepEqual(managedProjection({ model: { provider: "anthropic" } }, [plan]), {});
});
