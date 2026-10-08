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

test("a helper's objection, a failed claim, the reviewer judging an answer and a disagreement for the member reach the timeline", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
  const issue = { kind: "wrong_premise", detail: `billing.js does not exist; key ${secret}`, evidence: "find: nothing" };
  const value = projectTranscript({ identity, revision, eventCursor: "cursor.objection", generatedAt: "2026-10-01T09:02:00.000Z", entries: [
    message("o1", "user", [{ type: "text", text: "Where is the discount computed?" }]),
    message("o2", "assistant", [{ type: "toolCall", id: "d1", name: "delegate", arguments: { role: "scout", task: "Find billing.js" } }], { stopReason: "toolUse" }),
    note("o3", "agent-watch-process", { phase: "objection", role: "scout", by: "main", issues: [issue, { kind: "style", detail: "x" }] }),
    note("o4", "agent-watch-process", { phase: "dispute", role: "scout", issues: [issue] }),
    note("o5", "agent-watch-process", { phase: "claims", claims: [{ claim: "a.txt says fixed" }, { claim: " " }] }),
    note("o6", "agent-watch-process", { phase: "rejudge", role: "review" }),
    note("o7", "agent-watch-process", { phase: "answer", role: "research", issues: [{ kind: "ambiguous", detail: "which cart?" }] }),
    message("o8", "assistant", [{ type: "text", text: "The scout and I disagree about billing.js." }], { stopReason: "stop" }),
    note("o9", "agent-watch-process", { phase: "final", outcome: "disputed", disputes: 1, unchanged: true, verified: false, reviewed: false, blockingOpen: 0, policy: { verify: "require", review: "off" } }),
  ] });
  const validation = validateFixture(registry, "transcript-v1", value);
  assert.equal(validation.valid, true, validation.errors);
  const processes = value.items.filter(item => item.process).map(item => item.process);
  assert.deepEqual(processes.map(p => p.phase), ["objection", "dispute", "claims", "rejudge", "answer", "final"]);
  assert.equal(JSON.stringify(value).includes(secret), false, "objection text is redacted like findings");
  assert.deepEqual(processes[0].issues.map(i => i.kind), ["wrong_premise"]);
  assert.equal("evidence" in processes[0].issues[0], false, "only the kind and the detail reach the browser");
  assert.deepEqual([processes[0].role, processes[0].by], ["scout", "main"]);
  assert.deepEqual(processes[2].claims, [{ claim: "a.txt says fixed" }]);
  assert.deepEqual(processes[5], { phase: "final", outcome: "disputed", disputes: 1, unchanged: true, verified: false, reviewed: false, blockingOpen: 0, verifyPolicy: "require", reviewPolicy: "off" });
  const [turn] = timelineTurns(value.items);
  assert.equal(turn.process.outcome, "disputed");
  assert.equal(turn.answer, "The scout and I disagree about billing.js.");
  // The reviewer judging the agent's answer and the disagreement after it keep that answer the turn's answer.
  const later = projectTranscript({ identity, revision, eventCursor: "cursor.dispute", generatedAt: "2026-10-01T09:03:00.000Z", entries: [
    message("q1", "user", [{ type: "text", text: "Make a.txt say fixed" }]),
    message("q2", "assistant", [{ type: "text", text: "Done." }], { stopReason: "stop" }),
    note("q3", "agent-watch-process", { phase: "review", loop: 1, maxLoops: 2, findings: [{ severity: "blocking", file: "a.txt", line: 1, issue: "no header" }] }),
    message("q4", "assistant", [{ type: "text", text: "The finding is wrong: no file here has a header." }], { stopReason: "stop" }),
    note("q5", "agent-watch-process", { phase: "rejudge", role: "review" }),
    note("q6", "agent-watch-process", { phase: "dispute", role: "review", findings: [{ severity: "blocking", file: "a.txt", line: 1, issue: "no header" }] }),
    note("q7", "agent-watch-process", { phase: "final", outcome: "disputed", disputes: 1, verified: false, reviewed: true, blockingOpen: 1, policy: { verify: "off", review: "require" } }),
  ] });
  const [disputed] = timelineTurns(later.items);
  assert.equal(disputed.answer, "The finding is wrong: no file here has a header.");
  assert.deepEqual(disputed.steps.map(step => step.kind === "note" ? step.text : step.kind === "process" ? step.process.phase : step.kind), ["Done.", "review", "rejudge", "dispute"]);
  // The session row says a turn ended with a disagreement for the member.
  const row = managedProjection({ model: { provider: "agent_watch_managed" } }, [{ type: "custom_message", customType: "agent-watch-process", details: { phase: "final", outcome: "disputed", verified: false, reviewed: false, blockingOpen: 0 } }]);
  assert.equal(row.managedProcess.outcome, "disputed");
});

// A checklist the main agent left open is carried on by harness rounds; the
// member's message ends with one line saying whether the task is finished.
test("harness rounds that carry a checklist on stay in order, and the turn ends with how it ended", () => {
  const end = (id, data) => ({ id, type: "custom", timestamp: at(), customType: "agent-watch-turn-end", data });
  const final = (id) => note(id, "agent-watch-process", { phase: "final", outcome: "clean", verified: true, reviewed: true, blockingOpen: 0, policy: { verify: "require", review: "require" } });
  const value = projectTranscript({ identity, revision, eventCursor: "cursor.rounds", generatedAt: "2026-10-01T09:02:00.000Z", entries: [
    message("r1", "user", [{ type: "text", text: "Implement STEP01 to STEP22" }]),
    message("r2", "assistant", [{ type: "text", text: "STEP01 done; next STEP02." }], { stopReason: "stop" }),
    final("r3"),
    note("r4", "agent-watch-process", { phase: "continue", round: 1, maxRounds: 30, planOpen: 21, planDone: 1, planSteps: 22 }),
    message("r5", "assistant", [{ type: "text", text: "All 22 steps are done." }], { stopReason: "stop" }),
    final("r6"),
    end("r7", { state: "midway", planSteps: 22, planDone: 6, rounds: 2, reason: "idle", at: "x" }),
  ] });
  const validation = validateFixture(registry, "transcript-v1", value);
  assert.equal(validation.valid, true, validation.errors);
  assert.deepEqual(value.items.find(item => item.process?.phase === "continue").process, { phase: "continue", planOpen: 21, planDone: 1, planSteps: 22, round: 1, maxRounds: 30 });
  assert.deepEqual(value.items.find(item => item.turnEnd).turnEnd, { state: "midway", planSteps: 22, planDone: 6, rounds: 2, reason: "idle" });
  const [turn] = timelineTurns(value.items);
  // Each round keeps its answer and its status; the last answer and the turn's end close it.
  assert.deepEqual(turn.steps.map(step => step.kind === "note" ? step.text : step.process.phase), ["STEP01 done; next STEP02.", "final", "continue"]);
  assert.equal(turn.answer, "All 22 steps are done."); assert.equal(turn.process.phase, "final");
  assert.equal(turn.end.state, "midway");
  // The session row says it too, until a newer message runs.
  const context = { model: { provider: "agent_watch_managed" } };
  const entries = [message("s1", "user", "go"), end("s2", { state: "failed", planSteps: 3, planDone: 1, rounds: 0, role: "main", code: "upstream_unavailable" })];
  assert.deepEqual(managedProjection(context, entries).managedTurnEnd, { state: "failed", planSteps: 3, planDone: 1 });
  assert.equal(managedProjection(context, [...entries, message("s3", "user", "tiếp tục")]).managedTurnEnd, undefined);
  assert.equal(managedProjection(context, [message("s4", "user", "go"), end("s5", { state: "done", planSteps: 2, planDone: 3, rounds: 0 })]).managedTurnEnd, undefined, "malformed");
});
