import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recoveredToolCalls } from "../packages/piagent-core/runtime/inspection/activity-recovery.ts";
import { classifyToolFailure } from "../packages/piagent-core/runtime/inspection/tool-failure-classification.ts";

const common = { sessionId: "session-1", taskRunId: "task-run-1" };
function event(eventName, toolCallId, toolName, recordedAt, overrides = {}) {
  return { ...common, event: eventName, toolCallId, toolName, recordedAt, ...overrides };
}

describe("Piagent logical activity recovery", () => {
  it("resolves a missing-file read after the same requested path is created", () => {
    const events = [
      { ...common, event: "user_input", recordedAt: "2026-08-21T07:42:59.000Z" },
      event("tool_call", "read-1", "read", "2026-08-21T07:43:26.000Z", { targetPath: "docs/plan.md" }),
      event("tool_result", "read-1", "read", "2026-08-21T07:43:27.000Z", { targetPath: "docs/plan.md", isError: true }),
      event("tool_call", "write-1", "write", "2026-08-21T07:45:16.000Z", { targetPath: "docs/plan.md" }),
      event("tool_result", "write-1", "write", "2026-08-21T07:45:17.000Z", { targetPath: "docs/plan.md", isError: false })
    ];
    const recovery = recoveredToolCalls(events).get("read-1");
    assert.equal(recovery?.recoveryToolCallId, "write-1");
    assert.equal(recovery?.recoveryToolName, "write");
  });

  it("resolves an exact command retry but never crosses a new user request", () => {
    const retried = [
      event("tool_call", "test-1", "bash", "2026-08-21T08:00:00.000Z", { command: "npm test" }),
      event("tool_result", "test-1", "bash", "2026-08-21T08:00:01.000Z", { isError: true, exitCode: 1, exitCodeExact: true }),
      event("tool_call", "test-2", "bash", "2026-08-21T08:00:02.000Z", { command: "npm test" }),
      event("tool_result", "test-2", "bash", "2026-08-21T08:00:03.000Z", { isError: false, exitCode: 0, exitCodeExact: true })
    ];
    assert.equal(recoveredToolCalls(retried).has("test-1"), true);
    retried.splice(2, 0, { ...common, event: "user_input", recordedAt: "2026-08-21T08:00:01.500Z" });
    assert.equal(recoveredToolCalls(retried).has("test-1"), false);
  });

  it("resolves an immediate corrected filename after a speculative read misses", () => {
    const events = [
      event("tool_call", "read-wrong", "read", "2026-08-21T08:00:00.000Z", { targetPath: "runtime/session/runtime-session-state.ts" }),
      event("tool_result", "read-wrong", "read", "2026-08-21T08:00:01.000Z", { isError: true, reasonCode: "target-not-found" }),
      event("tool_call", "read-correct", "read", "2026-08-21T08:00:02.000Z", { targetPath: "runtime/session/runtime-state.ts" }),
      event("tool_result", "read-correct", "read", "2026-08-21T08:00:03.000Z", { isError: false })
    ];
    assert.equal(recoveredToolCalls(events).get("read-wrong")?.recoveryToolCallId, "read-correct");
  });

  it("does not hide a missing file when the next successful read is unrelated", () => {
    const events = [
      event("tool_call", "read-missing", "read", "2026-08-21T08:00:00.000Z", { targetPath: "runtime/session/runtime-session-state.ts" }),
      event("tool_result", "read-missing", "read", "2026-08-21T08:00:01.000Z", { isError: true, reasonCode: "target-not-found" }),
      event("tool_call", "read-other", "read", "2026-08-21T08:00:02.000Z", { targetPath: "runtime/session/model-authorship-state.ts" }),
      event("tool_result", "read-other", "read", "2026-08-21T08:00:03.000Z", { isError: false })
    ];
    assert.equal(recoveredToolCalls(events).has("read-missing"), false);
  });

  it("keeps unrelated failures failed", () => {
    const events = [
      event("tool_call", "read-1", "read", "2026-08-21T08:00:00.000Z", { targetPath: "docs/a.md" }),
      event("tool_result", "read-1", "read", "2026-08-21T08:00:01.000Z", { isError: true }),
      event("tool_call", "write-1", "write", "2026-08-21T08:00:02.000Z", { targetPath: "docs/b.md" }),
      event("tool_result", "write-1", "write", "2026-08-21T08:00:03.000Z", { isError: false })
    ];
    assert.equal(recoveredToolCalls(events).has("read-1"), false);
  });

  it("classifies a read ENOENT as target-not-found without weakening other failures", () => {
    assert.equal(classifyToolFailure("read", true, [{ type: "text", text: "ENOENT: no such file or directory" }]), "target-not-found");
    assert.equal(classifyToolFailure("read", true, [{ type: "text", text: "permission denied" }]), "tool-result-failed");
    assert.equal(classifyToolFailure("read", false, [{ type: "text", text: "ENOENT" }]), null);
  });

  it("classifies a multi-target search with useful matches and one missing target as handled", () => {
    const content = [{ type: "text", text: "rg: missing.ts: No such file or directory (os error 2)\nsrc/found.ts:12:match\nCommand exited with code 2" }];
    assert.equal(classifyToolFailure("bash", true, content, { command: "rg -n match missing.ts src" }), "search-target-missing");
    assert.equal(classifyToolFailure("bash", true, [{ type: "text", text: "rg: missing.ts: No such file or directory" }],
      { command: "rg -n match missing.ts" }), "tool-result-failed");
  });
});
