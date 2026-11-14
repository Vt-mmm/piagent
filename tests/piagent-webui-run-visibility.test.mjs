import assert from "node:assert/strict";
import test from "node:test";

import { helperRows } from "../packages/piagent-webui/client/src/live-state-view-model.ts";
import { managedProjection } from "../packages/piagent-webui/gateway/managed-projection.ts";

// Owner, 2026-11-14: the dashboard shows each subagent by role and what it
// does now, and the plan's phase with the steps added since the first checklist.
test("the subagent panel lists each subagent by role with its latest step", () => {
  const rows = helperRows([
    { toolCallRef: "t1", toolLabel: "read", state: "completed", agent: "scout", detail: "src/cart.js" },
    { toolCallRef: "t2", toolLabel: "grep", state: "running", agent: "scout", detail: "discount" },
    { toolCallRef: "t3", toolLabel: "web_search", state: "running", agent: "research#2", detail: "stripe fees" },
    { toolCallRef: "t4", toolLabel: "edit", state: "running", detail: "main's own step" },
  ], "vi");
  assert.deepEqual(rows.map((r) => [r.role, r.doing, r.steps, r.running]), [["Explore", "tìm discount", 2, true], ["Scout 2", "tìm trên web stripe fees", 1, true]]);
});

test("the plan reaches the dashboard with its phase header and where each added step came from", () => {
  const entries = [{ type: "custom", customType: "agent-watch-plan", data: { plan: [{ step: "a", status: "completed" }, { step: "Fix o3", status: "pending", source: "review o3" }],
    phase: { number: 1, head: "Phase 1 · gốc 1 · +1 phát sinh (review 1) · xong 1/2", base: ["a"], rounds: 1, added: [{ step: "Fix o3", source: "review o3", kind: "review", round: 1 }] } } }];
  const projected = managedProjection({ model: { provider: "agent_watch_managed" } }, entries);
  assert.deepEqual(projected.managedPlan, { head: "Phase 1 · gốc 1 · +1 phát sinh (review 1) · xong 1/2", steps: [{ step: "a", status: "completed" }, { step: "Fix o3", status: "pending", source: "review" }] });
  const old = managedProjection({ model: { provider: "agent_watch_managed" } }, [{ type: "custom", customType: "agent-watch-plan", data: { plan: [{ step: "a", status: "pending" }] } }]);
  assert.deepEqual(old.managedPlan, { steps: [{ step: "a", status: "pending" }] }, "a checklist written before phases has no header");
});
