import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildWebUiInspectionProjection } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const sessionId = "activity-reconciliation-session";
const registry = createWebUiSchemaRegistry();

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-activity-reconciliation-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function call(toolCallId, toolName, recordedAt, detail = {}) {
  return { activityId: `call:${toolCallId}`, event: "tool_call", sessionId, toolCallId, toolName, recordedAt, ...detail };
}

function result(toolCallId, toolName, timestamp, isError = false, text = "ok") {
  return { type: "message", timestamp, message: { role: "toolResult", toolCallId, toolName, isError,
    content: [{ type: "text", text }] } };
}

describe("Piagent WebUI Activity canonical result reconciliation", () => {
  it("settles lossy telemetry from session tool results and keeps only genuinely unmatched work running", async (t) => {
    const cwd = repository();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const events = [
      call("read-settled", "read", "2026-08-24T14:00:00.000Z", { targetPath: "docs/settled.md" }),
      call("bash-failed", "bash", "2026-08-24T14:00:01.000Z", { command: "npm test" }),
      call("read-unmatched", "read", "2026-08-24T14:00:02.000Z", { targetPath: "docs/unmatched.md" })
    ];
    const sessionEntries = [
      { type: "message", timestamp: "2026-08-24T14:00:00.500Z", message: { role: "assistant",
        content: [{ type: "toolCall", id: "bash-failed", name: "bash", arguments: { command: "npm test" } }] } },
      result("read-settled", "read", "2026-08-24T14:00:03.000Z"),
      result("bash-failed", "bash", "2026-08-24T14:00:04.000Z", true, "test process failed"),
      result("stale-current", "read", "2026-08-24T14:00:05.000Z")
    ];
    const current = [
      { toolCallId: "stale-current", toolName: "read", label: "read running", target: "docs/already-finished.md",
        startedAt: "2026-08-24T13:59:00.000Z", status: "running" },
      { toolCallId: "live-current", toolName: "read", label: "read running", target: "docs/live.md",
        startedAt: "2026-08-24T14:00:06.000Z", status: "running" }
    ];

    const projection = await buildWebUiInspectionProjection({ cwd, sessionId, events, sessionEntries, current,
      generatedAt: "2026-08-24T14:00:07.000Z" });
    const activity = projection.snapshot.activity;

    assert.deepEqual(activity.running.map((item) => item.preview).sort(), ["docs/live.md", "docs/unmatched.md"]);
    assert.equal(activity.running.some((item) => item.preview === "docs/already-finished.md"), false);
    assert.equal(activity.recent.find((item) => item.preview === "docs/settled.md")?.state, "passed");
    assert.equal(activity.recent.find((item) => item.preview === "docs/settled.md")?.finishedAt, "2026-08-24T14:00:03.000Z");
    assert.equal(activity.recent.find((item) => item.preview === "npm test")?.state, "failed");
    assert.equal(projection.snapshot.session.operation.liveness, "running");
    assert.equal(projection.snapshot.session.operation.startedAt, "2026-08-24T14:00:06.000Z");
    assert.equal(projection.scopedEvents.filter((event) => event.event === "tool_result").length, 2);

    const validation = validateFixture(registry, "snapshot-v1", projection.snapshot);
    assert.equal(validation.valid, true, validation.errors);
  });

  it("does not let an older canonical result overwrite explicit telemetry settlement", async (t) => {
    const cwd = repository();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const events = [
      call("explicit-result", "bash", "2026-08-24T14:10:00.000Z", { command: "npm test" }),
      { activityId: "result:explicit-result", event: "tool_result", sessionId, toolCallId: "explicit-result",
        toolName: "bash", recordedAt: "2026-08-24T14:10:02.000Z", isError: false, exitCode: 0, exitCodeExact: true }
    ];
    const sessionEntries = [result("explicit-result", "bash", "2026-08-24T14:10:01.000Z", true, "stale failed result")];

    const projection = await buildWebUiInspectionProjection({ cwd, sessionId, events, sessionEntries,
      generatedAt: "2026-08-24T14:10:03.000Z" });

    assert.equal(projection.snapshot.activity.running.length, 0);
    assert.equal(projection.snapshot.activity.recent[0].state, "passed");
    assert.equal(projection.scopedEvents.filter((event) => event.event === "tool_result").length, 1);
  });

  it("settles a stale current-only row when the branch already contains its result", async (t) => {
    const cwd = repository();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const projection = await buildWebUiInspectionProjection({ cwd, sessionId,
      sessionEntries: [result("current-finished", "read", "2026-08-24T14:20:01.000Z")],
      current: [{ toolCallId: "current-finished", toolName: "read", label: "read running", target: "docs/finished.md",
        startedAt: "2026-08-24T14:20:00.000Z", status: "running" }],
      generatedAt: "2026-08-24T14:20:02.000Z" });

    assert.equal(projection.snapshot.activity.running.length, 0);
    assert.equal(projection.snapshot.session.operation.liveness, "idle");
  });

  it("keeps a handled search warning non-failing after canonical refresh and reconciliation", async (t) => {
    const cwd = repository();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const command = "rg -n match missing.ts src";
    const content = "rg: missing.ts: No such file or directory (os error 2)\nsrc/found.ts:12:match\nCommand exited with code 2";
    const events = [
      call("search-warning", "bash", "2026-08-24T14:30:00.000Z", { command }),
      { activityId: "result:search-warning", event: "tool_result", sessionId, toolCallId: "search-warning", toolName: "bash",
        recordedAt: "2026-08-24T14:30:01.000Z", isError: true, exitCode: 2, exitCodeExact: true,
        reasonCode: "tool-result-failed" }
    ];
    const sessionEntries = [
      { type: "message", timestamp: "2026-08-24T14:30:00.000Z", message: { role: "assistant",
        content: [{ type: "toolCall", id: "search-warning", name: "bash", arguments: { command } }] } },
      result("search-warning", "bash", "2026-08-24T14:30:01.000Z", true, content)
    ];

    const projection = await buildWebUiInspectionProjection({ cwd, sessionId, events, sessionEntries,
      generatedAt: "2026-08-24T14:30:02.000Z" });
    const row = projection.snapshot.activity.recent.find((item) => item.preview === command);
    const reconciled = projection.scopedEvents.find((event) => event.event === "tool_result"
      && event.toolCallId === "search-warning");

    assert.equal(row?.state, "passed");
    assert.equal(row?.label, "bash warning");
    assert.equal(reconciled?.reasonCode, "search-target-missing");
    assert.equal(projection.snapshot.activity.running.length, 0);
    const validation = validateFixture(registry, "snapshot-v1", projection.snapshot);
    assert.equal(validation.valid, true, validation.errors);
  });

  it("replays a provider-level subagent rejection as failed instead of passed", async (t) => {
    const cwd = repository();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const events = [
      call("helper-rejected", "subagent", "2026-08-24T14:40:00.000Z"),
      { activityId: "result:helper-rejected", event: "tool_result", sessionId, toolCallId: "helper-rejected",
        toolName: "subagent", recordedAt: "2026-08-24T14:40:01.000Z", isError: false }
    ];
    const sessionEntries = [
      { type: "message", timestamp: "2026-08-24T14:40:00.000Z", message: { role: "assistant",
        content: [{ type: "toolCall", id: "helper-rejected", name: "subagent", arguments: { agent: "piagent-scout" } }] } },
      result("helper-rejected", "subagent", "2026-08-24T14:40:01.000Z", false,
        "Subagent spawn limit reached; no children were started.")
    ];

    const projection = await buildWebUiInspectionProjection({ cwd, sessionId, events, sessionEntries,
      generatedAt: "2026-08-24T14:40:02.000Z" });
    const row = projection.snapshot.activity.recent.find((item) => item.toolName === "subagent");
    const reconciled = projection.scopedEvents.find((event) => event.event === "tool_result"
      && event.toolCallId === "helper-rejected");

    assert.equal(row?.state, "failed");
    assert.equal(row?.label, "subagent failed");
    assert.equal(reconciled?.isError, true);
    assert.equal(reconciled?.reasonCode, "helper-dispatch-rejected");
    assert.equal(projection.snapshot.activity.running.length, 0);
  });
});
