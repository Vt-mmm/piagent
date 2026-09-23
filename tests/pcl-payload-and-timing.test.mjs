import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAiCodexWireFingerprint, measureProviderPayload } from "../packages/piagent-core/runtime/model/provider-wire-fingerprint.ts";
import { firstCorrectEditTiming } from "../packages/piagent-core/runtime/product/edit-verifier-timing.ts";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";

const wire = (payload) => buildOpenAiCodexWireFingerprint({ payload, provider: "openai-codex", modelId: "pinned" });
test("payload components reconcile actual UTF-8 JSON for Unicode, tool pairs, long outputs and corrections", () => {
  for (const repeat of [1, 30000]) {
    const payload = { model: "pinned", instructions: "Keep user correction: mục tiêu 🧭", tools: [{ name: "read", parameters: { type: "object" } }],
      input: [{ role: "user", content: "Correction: preserve rename" }, { type: "function_call", call_id: "one", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "one", output: "源🙂".repeat(repeat) }], reasoning: { effort: "high" } };
    const before = JSON.stringify(payload);
    const result = wire(payload);
    const m = measureProviderPayload(payload);
    assert.equal(result.state, "known");
    assert.equal(m.totalBytes, Buffer.byteLength(before));
    assert.equal(m.totalBytes, m.instructionsBytes + m.toolsBytes + m.inputBytes + m.remainingBytes);
    assert.equal(m.inputBytes, Buffer.byteLength(JSON.stringify(payload.input)));
    assert.equal(m.cacheHit, null);
    assert.equal(JSON.stringify(payload), before);
    assert.doesNotMatch(JSON.stringify(result), /preserve rename|源|function_call_output/);
    const changed = wire({ ...payload, input: [{ role: "user", content: "different" }] });
    assert.equal(changed.requestPrefixFingerprint, result.requestPrefixFingerprint);
    assert.notEqual(measureProviderPayload({ ...payload, input: [{ role: "user", content: "different" }] }).inputBytes, m.inputBytes);
  }
});
test("invalid, cyclic and excessive full payload measurements fail closed", () => {
  const payload = { model: "pinned", instructions: "ok", tools: [], input: [] };
  const cycle = {}; cycle.self = cycle;
  for (const extra of [cycle, { opaque: "x".repeat(2000001) }]) {
    assert.equal(measureProviderPayload({ ...payload, extra }), null);
    assert.equal(wire(payload).state, "known");
  }
});
test("first correct edit requires actual mutation then all current verifiers and existing completion approval", () => {
  const tree = workingTreeEvidenceDigest({ "src/a.ts": `wt-content-v2:${"a".repeat(64)}` }), revision = `workspace-revision-v1:${"b".repeat(64)}`;
  const task = { taskId: "a", taskRunId: "run", sessionId: "session", createdAt: "2026-09-06T00:00:00Z", trace: { outcome: "completed" }, verifyCommands: ["test", "lint"],
    verifyEvidence: ["test", "lint"].map((command) => ({ command, exitCode: 0, observed: true, matchedProfileCommand: true, isError: false,
      observedAt: "2026-09-06T00:00:03Z", recordedAt: "2026-09-06T00:00:03Z", preWorkingTreeDigest: tree, workingTreeDigest: tree,
      preWorkspaceRevisionDigest: revision, workspaceRevisionDigest: revision })) };
  const edit = { event: "tool_result", taskUsageVersion: 1, taskId: "a", taskRunId: "run", sessionId: "session", toolCallId: "edit1", mutationObserved: true,
    isError: false, postWorkingTreeDigest: tree, postWorkspaceRevisionDigest: revision, recordedAt: "2026-09-06T00:00:01Z" };
  const source = { approved: true, treeDigest: tree, revisionDigest: revision };
  assert.equal(firstCorrectEditTiming(task, [edit, edit], true, source).timeToFirstCorrectEditMs, 1000);
  for (const change of [{ isError: true }, { mutationObserved: false }, { taskRunId: "other" }, { postWorkspaceRevisionDigest: `workspace-revision-v1:${"c".repeat(64)}` },
    { postWorkingTreeDigest: workingTreeEvidenceDigest({}) }, { recordedAt: "2026-09-06T00:00:04Z" }]) {
    assert.equal(firstCorrectEditTiming(task, [{ ...edit, ...change }], true, source).timeToFirstCorrectEditMs, null);
  }
  for (const [current, complete, gate] of [[task, false, source], [task, true, { ...source, approved: false }],
    [{ ...task, trace: { outcome: "blocked" } }, true, source], [{ ...task, verifyEvidence: task.verifyEvidence.slice(0, 1) }, true, source],
    [{ ...task, verifyEvidence: [...task.verifyEvidence, { ...task.verifyEvidence[0], exitCode: 1, observedAt: "2026-09-06T00:00:05Z" }] }, true, source]]) {
    assert.equal(firstCorrectEditTiming(current, [edit], complete, gate).timeToFirstCorrectEditMs, null);
  }
});
