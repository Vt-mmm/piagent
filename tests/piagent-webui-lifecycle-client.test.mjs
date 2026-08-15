import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { createLifecycleCommand, createResumeAndContinueCommand } from "../packages/piagent-webui/client/src/chat-command.ts";
import { controlActionDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const registry = createWebUiSchemaRegistry();

function activeSnapshot() {
  const value = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));
  value.identity.taskId = "task_lifecycle_client"; value.identity.taskRunId = "run_lifecycle_client";
  value.identity.agentOperationId = "operation_lifecycle_client";
  value.revision.taskRevision = "task_rev_lifecycle_client"; value.revision.controlRevision = "control_rev_lifecycle_client";
  value.revision.queueRevision = "queue_rev_lifecycle_client";
  return value;
}

describe("Piagent WebUI lifecycle client", () => {
  it("builds schema-valid Stop, Pause and Resume commands with the runtime action digest", async () => {
    const snapshot = activeSnapshot();
    for (const action of ["lifecycle.stop", "lifecycle.pause", "lifecycle.resume"]) {
      const command = await createLifecycleCommand(snapshot, action);
      const result = validateFixture(registry, "control-command-v1", command);
      assert.equal(result.valid, true, `${action}: ${result.errors}`);
      assert.equal(command.actionDigest, controlActionDigest(command));
      assert.equal(command.identity.agentOperationId, snapshot.identity.agentOperationId);
      assert.equal(command.expectedRevisions.controlRevision, snapshot.revision.controlRevision);
    }
  });

  it("renders explicit safe-point, zero-model-turn and uncertain-state guidance", () => {
    const panel = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/LifecyclePanel.tsx"), "utf8");
    assert.match(panel, /Dừng lượt hiện tại/); assert.match(panel, /Tạm dừng task/); assert.match(panel, /Tiếp tục task/);
    assert.match(panel, /chờ tool hiện tại kết thúc/); assert.match(panel, /không tự gọi model/); assert.match(panel, /Tiếp tục & gửi/);
    assert.match(panel, /Chưa xác nhận được Pi đã dừng/); assert.match(panel, /sendLifecycleCommand/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML|contentEditable/);
  });

  it("builds one schema-valid Resume & Continue command with an operator-authored message", async () => {
    const snapshot = activeSnapshot(); snapshot.identity.agentOperationId = null;
    const command = await createResumeAndContinueCommand(snapshot, "Continue from the verified checkpoint.");
    const result = validateFixture(registry, "control-command-v1", command);
    assert.equal(result.valid, true, result.errors); assert.equal(command.action, "lifecycle.resume-and-continue");
    assert.equal(command.capabilityScope, "control.resumeAndContinue"); assert.equal(command.payload.delivery, "new-operation");
    assert.equal(command.actionDigest, controlActionDigest(command));
  });
});
