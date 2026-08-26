import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recoveredToolCalls } from "../packages/piagent-core/runtime/inspection/activity-recovery.ts";
import { classifyToolFailure, handledToolFailure } from "../packages/piagent-core/runtime/inspection/tool-failure-classification.ts";

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

  it("classifies deterministic built-in read misses as handled negative evidence", () => {
    const cases = [
      ["ENOENT: no such file or directory, open 'missing.ts'", "target-not-found"],
      ["EISDIR: illegal operation on a directory, read 'src'", "target-is-directory"]
    ];
    for (const [message, expected] of cases) {
      const reason = classifyToolFailure("read", true, [{ type: "text", text: message }]);
      assert.equal(reason, expected, message);
      assert.equal(handledToolFailure(reason, "read"), true, message);
    }
    assert.equal(classifyToolFailure("read", false, [{ type: "text", text: "ENOENT" }]), null,
      "a successful tool envelope must not be rewritten from message text alone");
    assert.equal(classifyToolFailure("piagent_document_read", true,
      [{ type: "text", text: "Document read failed: file does not exist" }]), "target-not-found");
    assert.equal(classifyToolFailure("vendor_read_file", true,
      [{ type: "text", text: "ENOENT: upstream request failed" }]), "tool-result-failed",
      "only Piagent-governed readers may downgrade an error to handled negative evidence");
    assert.equal(handledToolFailure("target-not-found", "vendor_read_file"), false);
    assert.equal(handledToolFailure("search-target-missing", "write"), false);
  });

  it("classifies missing targets from built-in grep, find, and ls as handled negative evidence", () => {
    const cases = [
      ["grep", "ENOENT: no such file or directory, scandir 'missing'"],
      ["grep", "Path not found: /workspace/src/missing.ts"],
      ["find", "ENOTDIR: not a directory, scandir 'README.md/src'"],
      ["find", "[fd error]: Search path '/workspace/src/missing' is not a directory.\n[fd error]: No valid search paths given."],
      ["ls", "Cannot find the path 'missing-directory' because it does not exist"]
    ];
    for (const [toolName, message] of cases) {
      const reason = classifyToolFailure(toolName, true, { content: [{ type: "text", text: message }] });
      assert.equal(reason, "search-target-missing", `${toolName}: ${message}`);
      assert.equal(handledToolFailure(reason, toolName), true, `${toolName}: ${message}`);
    }
  });

  it("keeps permission, transient, and unknown built-in tool errors as real failures", () => {
    const cases = [
      ["read", "EACCES: permission denied, open 'private.txt'"],
      ["grep", "EPERM: operation not permitted, scandir 'private'"],
      ["find", "ETIMEDOUT while enumerating the workspace"],
      ["ls", "ECONNRESET: connection reset by peer"],
      ["read", "Unexpected provider tool failure"],
      ["read", "ENOENT: no such file or directory\nEACCES: permission denied"],
      ["find", "No valid search paths given\nEPERM: operation not permitted"],
      ["grep", "Invalid regular expression containing 'Path not found(': unterminated group"]
    ];
    for (const [toolName, message] of cases) {
      const reason = classifyToolFailure(toolName, true, [{ type: "text", text: message }]);
      assert.equal(reason, "tool-result-failed", `${toolName}: ${message}`);
      assert.equal(handledToolFailure(reason, toolName), false, `${toolName}: ${message}`);
    }
  });

  it("classifies a multi-target search with useful matches and one missing target as handled", () => {
    const content = [{ type: "text", text: "rg: missing.ts: No such file or directory (os error 2)\nsrc/found.ts:12:match\nCommand exited with code 2" }];
    assert.equal(classifyToolFailure("bash", true, content, { command: "rg -n match missing.ts src" }), "search-target-missing");
    assert.equal(classifyToolFailure("bash", true, { content }, { command: "rg -n match missing.ts src" }), "search-target-missing",
      "the live tool_execution_end result envelope must classify like canonical toolResult content");
    assert.equal(classifyToolFailure("bash", true, [{ type: "text", text: "rg: missing.ts: No such file or directory" }],
      { command: "rg -n match missing.ts" }), "tool-result-failed");
    assert.equal(classifyToolFailure("bash", true, content,
      { command: "rg -n match missing.ts src; run-release" }), "tool-result-failed",
      "a missing search target must not hide a later command failure");
    assert.equal(classifyToolFailure("bash", true, [{ type: "text", text: `${content[0].text}\npermission denied` }],
      { command: "rg -n match missing.ts src" }), "tool-result-failed",
      "mixed search and permission failures remain real failures");
  });

  it("classifies edit anchor failures without hiding them as handled", () => {
    assert.equal(classifyToolFailure("edit", true, [{ type: "text", text: "Found 2 occurrences of edits[0]. Each oldText must be unique." }]), "edit-anchor-not-unique");
    assert.equal(classifyToolFailure("edit", true, [{ type: "text", text: "Could not find the exact text. The old text must match exactly." }]), "edit-anchor-stale");
    assert.equal(classifyToolFailure("replace", true, [{ type: "text", text: "Could not find exact text; oldText mismatch." }]), "tool-result-failed");
    assert.equal(classifyToolFailure("edit", true, [{ type: "text", text: "permission denied" }]), "tool-result-failed");
  });

  it("does not call a zero-error subagent envelope successful when no useful child ran", () => {
    assert.equal(classifyToolFailure("subagent", false,
      [{ type: "text", text: "Subagent spawn limit reached; no children were started." }]), "helper-dispatch-rejected");
    assert.equal(classifyToolFailure("subagent", false,
      [{ type: "text", text: "## Scout Summary\n- **Scope inspected:** None.\nStopped under the insufficient-evidence rule." }]),
    "helper-insufficient-evidence");
    assert.equal(classifyToolFailure("subagent", false,
      [{ type: "text", text: "## Scout Summary\n- Scope inspected: packages/runtime\n- Result: complete" }]), null);
  });
});
