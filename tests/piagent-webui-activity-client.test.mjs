import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { activityResult, activityTime, mergeActivityRows,
  terminalOperationActivityRow } from "../packages/piagent-webui/client/src/activity-view-model.ts";

const root = path.resolve(import.meta.dirname, "..");
function activity(state, overrides = {}) {
  return { activityRef: `activity.${state}`, kind: "command", state, label: "npm test", preview: "bounded preview", toolCallId: "tool.1", toolName: "bash",
    commandDigest: "sha256:test", logRef: "log.1", exitCode: null, exitCodeExact: false,
    startedAt: "2026-08-13T09:00:00.000Z", finishedAt: "2026-08-13T09:00:05.000Z", ...overrides };
}

describe("Piagent WebUI activity and log preview", () => {
  it("keeps pass, fail, blocked and running outcomes exact", () => {
    assert.equal(activityResult(activity("passed", { exitCode: 0, exitCodeExact: true })), "Pass · exit 0");
    assert.equal(activityResult(activity("passed", { label: "read recovered" })), "Đã khôi phục");
    assert.equal(activityResult(activity("passed", { label: "read recovered" }), "en"), "Recovered");
    assert.equal(activityResult(activity("passed", { label: "bash warning" })), "Đã xử lý cảnh báo");
    assert.equal(activityResult(activity("passed", { label: "bash warning" }), "en"), "Handled warning");
    assert.equal(activityResult(activity("failed", { exitCode: 2, exitCodeExact: true })), "Fail · exit 2");
    assert.equal(activityResult(activity("blocked")), "Blocked");
    assert.equal(activityResult(activity("running", { finishedAt: null })), "Đang chạy");
    assert.equal(activityTime(activity("passed")), "5s");
  });

  it("loads bounded previews by opaque activity ref and never renders raw HTML", () => {
    const panel = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/ActivityPanel.tsx"), "utf8");
    const api = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/api.ts"), "utf8");
    assert.match(panel, /aria-expanded/);
    assert.match(panel, /preview\.value\?\.truncated/);
    assert.match(panel, /Không có nội dung log/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML/);
    assert.match(api, /log-previews\/\$\{encodeURIComponent\(activityRef\)\}/);
  });

  it("shows terminal operation failures as system Activity and lets persisted truth replace the overlay", () => {
    const terminal = { activityRef: "operation.failure.1", operationRef: "operation.failure.1", settlement: "error",
      state: "failed", reasonCode: "assistant-response-failed", settledAt: "2026-08-21T08:00:00.000Z", sequence: 44 };
    const row = terminalOperationActivityRow(terminal, "en");
    assert.equal(row.kind, "system");
    assert.equal(row.state, "failed");
    assert.equal(row.preview, "assistant-response-failed");
    assert.equal(row.logRef, null);

    const overlay = mergeActivityRows([], [], [terminal], "en");
    assert.equal(overlay.rows.length, 1);
    assert.equal(overlay.terminalCount, 1);
    const canonical = activity("failed", { activityRef: terminal.activityRef, label: "Canonical operation failure" });
    const reconciled = mergeActivityRows([], [canonical], [terminal], "en");
    assert.equal(reconciled.rows.length, 1);
    assert.equal(reconciled.rows[0].label, "Canonical operation failure");
    assert.equal(reconciled.terminalCount, 0);
  });
});
