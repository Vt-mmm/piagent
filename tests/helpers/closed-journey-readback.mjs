import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { activeSessionTask } from "../../packages/piagent-core/extensions/task-state.js";
import { SessionInspectionRegistry } from "../../packages/piagent-webui/gateway/session-inspection-registry.ts";
import { terminalDeliverySessionEntries } from "../../packages/piagent-webui/server/terminal-delivery-receipt.ts";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function captureJourneyBeforeClose({ manager, cwd, turns }) {
  const task = activeSessionTask(cwd, manager.getSessionId());
  return { file: manager.getSessionFile(), sessionId: manager.getSessionId(),
    branchDigest: digest(manager.getBranch()), branchEntries: manager.getBranch().length,
    taskDigest: digest(task ?? null), taskRunId: task?.taskRunId ?? null,
    taskOutcome: task?.trace.outcome ?? null, terminalDisposition: task?.trace.terminalDisposition ?? null,
    turns: structuredClone(turns) };
}

// This readback runs only after the test-owned connection and supervisor close.
// Fresh SDK/inspection instances read disk, with no live-manager callback or
// cached provider. Compare hashes to avoid printing raw session/task contents.
export async function readClosedJourney({ before, host, cwd, agentDir, sessionDir, key, repositoryRoot,
  gatewayInstanceRef, supervisor, leases, sessionRef, transport, scenarioId }) {
  assert.equal(supervisor.activeCount, 0, "readback requires a closed runtime");
  assert.equal(leases.inspect(sessionRef).state, "released");
  assert.ok(typeof before.file === "string" && before.file.startsWith(sessionDir + path.sep),
    "only this fixture's SDK session may be inspected");
  const strictEntries = terminalDeliverySessionEntries(before.file, before.sessionId);
  assert.ok(strictEntries.length > 0, "strict disk parse must retain complete SDK JSONL");
  const cold = host.SessionManager.open(before.file);
  assert.equal(cold.getSessionId(), before.sessionId);
  assert.equal(cold.getCwd(), cwd);
  assert.equal(digest(cold.getBranch()), before.branchDigest, "SDK branch changed or was not durable after close");
  assert.equal(cold.getBranch().length, before.branchEntries);
  const diskEntries = new Map(strictEntries.map(entry => [entry.id, entry]));
  assert.equal(diskEntries.size, strictEntries.length, "persisted entries must have unique identities");
  for (const entry of cold.getBranch()) assert.equal(digest(diskEntries.get(entry.id)), digest(entry),
    "cold SDK branch cannot invent or omit a persisted entry");
  const task = activeSessionTask(cwd, before.sessionId);
  assert.equal(digest(task ?? null), before.taskDigest, "persisted task changed across close");
  const inspection = new SessionInspectionRegistry({ gatewayInstanceRef, host, key, packageRoot: repositoryRoot,
    agentDir, listSessions: () => host.SessionManager.list(cwd, sessionDir) });
  const transcript = await (await inspection.provider(sessionRef)).transcript(null, 200);
  const correlations = before.turns.map(turn => {
    const users = transcript.items.filter(item => item.role === "user"
      && item.messageRequestId === turn.messageRequestId && item.agentOperationId === turn.operationRef);
    assert.equal(users.length, 1, `one persisted user required for ${turn.id}`);
    assert.ok(String(users[0].content.text ?? "").trim().endsWith(turn.message.trim()),
      "cold transcript must preserve the submitted public request");
    const replies = transcript.items.filter(item => ["assistant", "custom"].includes(item.role)
      && item.messageRequestId === turn.messageRequestId && item.agentOperationId === turn.operationRef
      && item.parentMessageRef === users[0].messageRef);
    assert.ok(replies.length > 0, `correlated persisted response required for ${turn.id}`);
    return { id: turn.id, messageRequestId: turn.messageRequestId, operationRef: turn.operationRef,
      taskRunId: turn.taskRunId, observedTaskStatus: turn.taskStatus, userCopies: users.length,
      replyRoles: [...new Set(replies.map(item => item.role))],
      unavailableReasons: [...new Set(replies.flatMap(item => item.content.reasonCode ? [item.content.reasonCode] : []))] };
  });
  return { stage: "post-close-readback-v1", scenarioId, transport, sessionId: before.sessionId,
    branchEntries: before.branchEntries, branchDigest: before.branchDigest, taskRunId: before.taskRunId,
    taskOutcome: before.taskOutcome, terminalDisposition: before.terminalDisposition, correlations,
    activeRuntimes: supervisor.activeCount, leaseState: "released", verified: true,
    boundary: "connection/supervisor closed; fresh SDK disk read; not process-crash or power-loss proof" };
}
