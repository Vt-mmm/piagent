import assert from "node:assert/strict";
import test from "node:test";

import { GatewayEventStore } from "../packages/piagent-webui/gateway/gateway-events.ts";
import { GatewaySessionStream } from "../packages/piagent-webui/gateway/gateway-session-stream.ts";
import { activityLogGroups } from "../packages/piagent-webui/client/src/activity-view-model.ts";
import { timelineTurns } from "../packages/piagent-webui/client/src/timeline-view-model.ts";
import { withLiveActivity } from "../packages/piagent-webui/client/src/live-state-view-model.ts";

const at = (minute) => `2026-10-31T16:${String(minute).padStart(2, "0")}:00.000Z`;
const base = (ref, role, minute, extra = {}) => ({ messageRef: ref, role, recordedAt: at(minute), content: { text: "" }, toolCalls: [], ...extra });
const user = base("u1", "user", 0, { content: { text: "do it" } });
const answer = (ref, minute, text) => base(ref, "assistant", minute, { content: { text } });
const process = (ref, minute, phase, extra = {}) => base(ref, "custom", minute, { process: { phase, ...extra } });

test("an answer before the review is a draft, the answer after it the final result", () => {
  const reviewing = timelineTurns([user, answer("a1", 29, "Done, I think"), process("p1", 30, "reviewing")])[0];
  assert.equal(reviewing.reviewing, true);
  assert.equal(reviewing.answer, "Done, I think");
  const turn = timelineTurns([user, answer("a1", 29, "Done, I think"), process("p1", 30, "reviewing"), process("p2", 49, "review", { loop: 1 }),
    answer("a2", 53, "Fixed the blocking finding"), process("p3", 54, "final", { reviewed: true })])[0];
  const drafts = turn.steps.filter((step) => step.kind === "note" && step.draft);
  assert.deepEqual(drafts.map((step) => [step.text, step.beforeReview]), [["Done, I think", true]]);
  assert.equal(turn.answer, "Fixed the blocking finding");
  assert.equal(turn.reviewing, false);
});

test("a clean review leaves the only answer as the final result", () => {
  const turn = timelineTurns([user, answer("a1", 29, "Done"), process("p1", 30, "reviewing"), process("p2", 49, "final", { reviewed: true })])[0];
  assert.equal(turn.answer, "Done");
  assert.equal(turn.reviewing, false);
  assert.equal(turn.steps.filter((step) => step.kind === "note").length, 0);
});

test("a helper's saved run is not a message of the conversation", () => {
  const run = base("h1", "custom", 40, { helperRun: { agent: "review", startedAt: at(30), endedAt: at(49), total: 1, steps: [] } });
  const turn = timelineTurns([user, run, answer("a1", 50, "Done")])[0];
  assert.equal(turn.steps.length, 0);
  assert.equal(turn.answer, "Done");
});

test("Activity groups calls by agent, newest first, a running subagent's too", () => {
  const items = [user, base("m1", "assistant", 10, { toolCalls: [{ toolCallRef: "t1", toolName: "bash", state: "completed", summary: { kind: "command", target: "go test", detail: null } }] }),
    base("m2", "assistant", 20, { toolCalls: [{ toolCallRef: "t2", toolName: "edit", state: "failed", summary: { kind: "edit", target: "a.go", detail: null } }] }),
    base("h1", "custom", 25, { helperRun: { agent: "scout", startedAt: at(21), endedAt: at(25), total: 300, steps: [{ toolName: "read", target: "b.go", at: at(22) }] } })];
  const live = [{ toolCallRef: "x", toolLabel: "grep", agent: "review", detail: "TODO", state: "completed", startedAt: at(40) },
    { toolCallRef: "y", toolLabel: "read", agent: "review", state: "running", startedAt: at(41) }];
  const groups = activityLogGroups(items, live);
  assert.deepEqual(groups.map((group) => [group.agent, group.total]), [["main", 2], ["scout", 300], ["review", 1]]);
  assert.deepEqual(groups[0].steps.map((step) => [step.toolName, step.target, step.state]), [["edit", "a.go", "failed"], ["bash", "go test", "completed"]]);
  assert.equal(groups[2].steps[0].target, "TODO");
});

test("a long review does not push the main agent's steps out", () => {
  let rows = [{ toolCallRef: "main", toolLabel: "bash", state: "running" }];
  for (let i = 0; i < 300; i += 1) rows = withLiveActivity(rows, { toolCallRef: `h${i}`, toolLabel: "read", agent: "review", state: "completed" });
  assert.equal(rows.filter((row) => !row.agent).length, 1);
  assert.equal(rows.filter((row) => row.agent).length, 200);
});

test("a subagent's steps reach the browser named after it", () => {
  const events = new GatewayEventStore(), observed = [];
  events.subscribe((event) => observed.push(event));
  const stream = new GatewaySessionStream({ sessionRef: "session-steps", operationRef: "operation-steps", events });
  stream.observe({ type: "agent_start" });
  const state = (step, tool, args) => ({ type: "managed_helper_state", helpers: [{ key: "review", role: "review", slot: 1, job: "j", step, tool, args }] });
  stream.observe({ type: "managed_helper_state", helpers: [{ key: "review", role: "review", slot: 1, job: "j", step: "đọc brief" }] });
  stream.observe(state("đọc a.go", "read", { path: "src/a.go" }));
  stream.observe(state("chạy x", "bash", { command: "echo token=abc123456789abcdef" }));
  stream.observe({ type: "managed_helper_state", helpers: [] });
  const tools = observed.filter((event) => event.kind.startsWith("tool."));
  assert.deepEqual(tools.map((event) => [event.kind, event.payload.agent, event.payload.toolLabel]), [
    ["tool.started", "review", "read"], ["tool.completed", "review", "read"], ["tool.started", "review", "bash"], ["tool.completed", "review", "bash"]]);
  assert.match(tools[0].payload.detail, /a\.go/);
  assert.doesNotMatch(tools[2].payload.detail ?? "", /abc123456789abcdef/);
});

// A helper ends in its own finally, which may come after the turn settled.
test("a subagent ending after the turn settled does not reopen it", async () => {
  const events = new GatewayEventStore(), observed = [];
  const stream = new GatewaySessionStream({ sessionRef: "session-late", operationRef: "operation-late", events });
  stream.observe({ type: "agent_start" });
  stream.observe({ type: "managed_helper_state", helpers: [{ key: "review", step: "đọc a.go", tool: "read", args: { path: "a.go" } }] });
  stream.observe({ type: "agent_end", messages: [] });
  stream.observe({ type: "agent_settled" });
  await stream.settled();
  events.subscribe((event) => observed.push(event));
  stream.observe({ type: "managed_helper_state", helpers: [] });
  stream.observe({ type: "managed_helper_state", helpers: [{ key: "review", step: "đọc b.go", tool: "read", args: { path: "b.go" } }] });
  assert.deepEqual(observed.filter((event) => event.kind.startsWith("tool.")), []);
});
