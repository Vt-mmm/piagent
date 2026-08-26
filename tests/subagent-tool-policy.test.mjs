import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyDirectSubagentResult,
  evaluateDirectSubagentDispatch
} from "../packages/piagent-core/runtime/orchestration/subagent-tool-policy.ts";

const cwd = "/workspace/project";
const localRequest = {
  agent: "piagent-scout",
  task: "Inspect src/runtime and return exact local file evidence.",
  context: "fresh",
  cwd,
  timeoutMs: 300_000,
  turnBudget: { maxTurns: 8 },
  toolBudget: { hard: 8 }
};

function preflight(toolInput, overrides = {}) {
  return evaluateDirectSubagentDispatch({
    toolName: "subagent",
    toolInput,
    cwd,
    helpersMode: "on",
    taskPending: true,
    dispatchAuthority: true,
    durableSubagentState: "not-used",
    ...overrides
  });
}

describe("direct subagent policy", () => {
  it("allows management calls but enforces task-bound CAP-14 before spawn", () => {
    assert.equal(preflight({ action: "list" }).allowed, true);
    assert.equal(preflight({ action: "list" }).dispatch, false);
    const disabled = preflight(localRequest, { helpersMode: "off", dispatchAuthority: false });
    assert.equal(disabled.allowed, false);
    assert.equal(disabled.reasonCode, "helper-dispatch-authority-disabled");
  });

  it("blocks the exact waste lanes: parallel helpers, retries, forked context, and remote retrieval without a web tool", () => {
    assert.equal(preflight({ tasks: [localRequest, { ...localRequest, task: "Inspect tests" }] }).reasonCode, "helper-count-exceeds-one");
    assert.equal(preflight(localRequest, { durableSubagentState: "used" }).reasonCode, "helper-retry-forbidden");
    assert.equal(preflight({ ...localRequest, context: "fork" }).reasonCode, "helper-parent-history-forbidden");
    assert.equal(preflight({ ...localRequest, task: "Analyze https://github.com/example/project with source evidence" }).reasonCode, "helper-source-access-unavailable");
  });

  it("enforces the owned helper call, turn, time, cwd, and read-only-role ceilings", () => {
    assert.equal(preflight({ ...localRequest, timeoutMs: undefined }).reasonCode, "helper-time-budget-missing");
    assert.equal(preflight({ ...localRequest, turnBudget: undefined }).reasonCode, "helper-turn-budget-missing");
    assert.equal(preflight({ ...localRequest, toolBudget: undefined }).reasonCode, "helper-call-budget-missing");
    assert.equal(preflight({ ...localRequest, toolBudget: { hard: 9 } }).reasonCode, "helper-call-budget-exceeded");
    assert.equal(preflight({ ...localRequest, turnBudget: { maxTurns: 9 } }).reasonCode, "helper-turn-budget-exceeded");
    assert.equal(preflight({ ...localRequest, timeoutMs: 300_001 }).reasonCode, "helper-time-budget-exceeded");
    assert.equal(preflight({ ...localRequest, cwd: "/workspace/other" }).reasonCode, "helper-cwd-outside-project");
    assert.equal(preflight({ ...localRequest, agent: "piagent-worker" }).reasonCode, "automatic-helper-role-disabled");
    assert.equal(preflight(localRequest).allowed, true);
  });

  it("classifies a zero-exit child with unsatisfied acceptance as failed and preserves digest-only usage truth", () => {
    const result = classifyDirectSubagentResult({
      toolName: "subagent",
      toolInput: localRequest,
      content: [{ type: "text", text: "## Scout Summary\n- Scope inspected: None" }],
      isError: false,
      details: {
        runId: "child-1",
        results: [{
          agent: "piagent-scout",
          exitCode: 0,
          toolCount: 5,
          finalOutput: "private failed output",
          acceptance: { status: "attested", childReport: { criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied" }] } }
        }],
        totalChildUsage: { input: 5083, output: 983, cacheRead: 3072, cacheWrite: 0 }
      }
    });
    assert.equal(result.spawned, true);
    assert.equal(result.failed, true);
    assert.equal(result.reasonCode, "helper-insufficient-evidence");
    assert.equal(result.calls, 5);
    assert.equal(result.tokens, 9138);
    assert.equal(result.outputDigest, null);
    assert.equal(JSON.stringify(result).includes("private failed output"), false);
  });

  it("does not claim a provider-level spawn rejection as helper use", () => {
    const result = classifyDirectSubagentResult({
      toolName: "subagent",
      toolInput: localRequest,
      content: [{ type: "text", text: "Subagent spawn limit reached; no children were started." }],
      details: { mode: "single", results: [] },
      isError: false
    });
    assert.equal(result.spawned, false);
    assert.equal(result.failed, true);
    assert.equal(result.reasonCode, "helper-dispatch-rejected");
    assert.equal(result.tokens, 0);
  });

  it("accepts a source-backed child and stores only its output digest", () => {
    const result = classifyDirectSubagentResult({
      toolName: "subagent",
      toolInput: localRequest,
      content: [{ type: "text", text: "Found the bounded entry point." }],
      details: { results: [{ agent: "piagent-scout", exitCode: 0, toolCount: 3, finalOutput: "source-backed evidence", usage: { input: 100, output: 40 } }] },
      isError: false
    });
    assert.equal(result.failed, false);
    assert.equal(result.disposition, "succeeded");
    assert.match(result.outputDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.tokens, 140);
  });
});
