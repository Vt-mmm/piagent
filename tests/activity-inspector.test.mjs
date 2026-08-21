import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import {
  buildActivityInspector,
  formatActivityInspector
} from "../packages/piagent-core/runtime/product/activity-inspector.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { formatActivityFooter, formatActivityPanel } from "../packages/piagent-core/runtime/product/activity-inspector-footer.ts";
import { registerActivityInspector } from "../packages/piagent-core/runtime/registration/activity-inspector-command.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));
const TEST_AT = "2026-08-13T14:00:00.000Z";

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-inspector-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 1;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function task(baseline, overrides = {}) {
  const value = {
    ...structuredClone(fixture),
    taskId: "inspect-101",
    taskRunId: "inspect-101-run-1",
    sessionId: "inspect-session",
    sessionName: "INSPECT-101",
    scope: ["src/**", "tests/**"],
    baselineChangedFiles: Object.keys(baseline),
    baselineFileDigests: baseline,
    verifyCommands: ["npm test"],
    verifyEvidence: [],
    trace: { outcome: "pending" },
    createdAt: TEST_AT,
    updatedAt: TEST_AT,
    ...overrides
  };
  value.authoritySnapshot = createBoundTaskAuthority(value);
  return value;
}

async function captureBaseline(cwd, currentTask) {
  await captureTaskBaselineManifest({
    projectRoot: cwd,
    taskId: currentTask.taskId,
    taskRunId: currentTask.taskRunId,
    sessionId: currentTask.sessionId,
    capturedAt: TEST_AT,
    baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd))
  });
}

function events() {
  const common = { sessionId: "inspect-session", taskRunId: "inspect-101-run-1" };
  return [
    { ...common, activityId: "call:1", event: "tool_call", toolCallId: "1", toolName: "bash", command: "npm test", recordedAt: "2026-08-08T01:00:00.000Z" },
    { ...common, activityId: "decision:1", event: "tool_decision", toolCallId: "1", toolName: "bash", decision: "allowed", recordedAt: "2026-08-08T01:00:00.010Z" },
    { ...common, activityId: "result:1", event: "tool_result", toolCallId: "1", toolName: "bash", isError: true, exitCode: 1, exitCodeExact: true, recordedAt: "2026-08-08T01:00:01.000Z" },
    { ...common, activityId: "call:2", event: "tool_call", toolCallId: "2", toolName: "bash", command: "git push", recordedAt: "2026-08-08T01:00:02.000Z" },
    { ...common, activityId: "decision:2", event: "tool_decision", toolCallId: "2", toolName: "bash", decision: "blocked", reason: "operator denied external action", recordedAt: "2026-08-08T01:00:02.010Z" },
    { ...common, activityId: "call:3", event: "tool_call", toolCallId: "3", toolName: "edit", targetPath: "src/checkout.ts", recordedAt: "2026-08-08T01:00:03.000Z" },
    { ...common, activityId: "result:3", event: "tool_result", toolCallId: "3", toolName: "edit", isError: false, sensitiveValuesRedacted: 1, recordedAt: "2026-08-08T01:00:04.000Z" }
  ];
}

describe("Piagent activity inspector", () => {
  it("projects task diff, tests, command failures, safety, and context without inventing per-tool tokens", async () => {
    const cwd = workspace();
    const baseline = workingTreeSnapshot(cwd);
    const currentTask = task(baseline);
    await captureBaseline(cwd, currentTask);
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 1;\nexport const ready = true;\n");
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "tests", "checkout.test.ts"), "import assert from 'node:assert';\nassert.ok(true);\n");
    const view = await buildActivityInspector({
      cwd,
      sessionId: "inspect-session",
      task: currentTask,
      events: events(),
      contextUsage: { tokens: 52_000, contextWindow: 100_000, percent: 52 },
      sessionEntries: [{
        type: "message",
        message: { role: "assistant", usage: { input: 4_000, output: 700, cacheRead: 10_000, cacheWrite: 500, cost: { total: 0.04 } } }
      }]
    });

    assert.equal(view.files.count, 2);
    assert.equal(view.files.evidence, "exact-task-baseline");
    assert.deepEqual(view.files.testFiles, ["tests/checkout.test.ts"]);
    assert.ok(view.files.additions >= 3);
    assert.equal(view.commands.executed, 1);
    assert.equal(view.commands.failed, 1);
    assert.equal(view.commands.blocked, 1);
    assert.equal(view.safety.blocked, 1);
    assert.equal(view.safety.redactions, 1);
    assert.equal(view.context.current.percent, 52);
    assert.equal(view.context.latestTurn.input, 4_000);
    assert.equal(view.tools.perToolTokens, null);
    assert.match(view.tools.perToolTokensReason, /by response\/turn/);
    assert.match(formatActivityInspector(view, "summary"), /files: 2 \(1 tests\)/);
    assert.match(formatActivityInspector(view, "commands"), /git push/);
    assert.match(formatActivityInspector(view, "context"), /perToolTokens: unavailable/);
    assert.match(formatActivityFooter(view), /◆ Piagent/);
    const colored = formatActivityFooter(view, { color: true });
    assert.match(colored, /\u001b\[1;36m◆ Piagent\u001b\[0m/);
    assert.match(colored, /\u001b\[31m1\u001b\[0m✗/);
    assert.match(colored, /\u001b\[33m1\u001b\[0m⊘/);
    assert.match(colored, /\u001b\[31m2\u001b\[0m/);
    assert.match(colored, /\u001b\[32m52%\u001b\[0m/);
    const panel = formatActivityPanel(view);
    assert.equal(panel.length, 4);
    assert.match(panel[0], /^▲ PIAGENT    PENDING/);
    assert.match(panel[1], /^Δ CHANGES   TASK · 2 files · 1 tests · \+/);
    assert.match(panel[2], /^× COMMANDS  0 passed · 1 failed · 1 blocked/);
    assert.match(panel[3], /^! HEALTH    2 security warnings · context 52%/);
    assert.doesNotMatch(panel.join("\n"), /✓.*✗.*⊘/);

    const pressured = structuredClone(view);
    pressured.context.current.percent = 75;
    assert.match(formatActivityFooter(pressured, { color: true }), /\u001b\[33m75%\u001b\[0m/);
    pressured.context.current.percent = 85;
    assert.match(formatActivityFooter(pressured, { color: true }), /\u001b\[31m85%\u001b\[0m/);
  });

  it("uses exact task-baseline line counts when a task edits a pre-existing dirty file", async () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 2;\n");
    const baseline = workingTreeSnapshot(cwd);
    const currentTask = task(baseline);
    await captureBaseline(cwd, currentTask);
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 3;\nexport const taskEdit = true;\n");
    const view = await buildActivityInspector({ cwd, sessionId: "inspect-session", task: currentTask, events: [] });
    assert.equal(view.files.lineStatsScope, "task-baseline");
    assert.deepEqual(view.files.baselineOverlap, ["src/checkout.ts"]);
  });

  it("keeps a file in the task delta when the task restores a pre-existing dirty file", async () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 2;\n");
    const baseline = workingTreeSnapshot(cwd);
    const currentTask = task(baseline);
    await captureBaseline(cwd, currentTask);
    fs.writeFileSync(path.join(cwd, "src", "checkout.ts"), "export const checkout = 1;\n");
    const view = await buildActivityInspector({ cwd, sessionId: "inspect-session", task: currentTask, events: [] });
    assert.deepEqual(view.files.taskChanged, ["src/checkout.ts"]);
    assert.equal(view.files.lineStatsScope, "task-baseline");
  });

  it("reports untracked test files with additions from the canonical working-tree view", async () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "tests", "new.test.ts"), "one\ntwo\n");
    const view = await buildActivityInspector({ cwd, sessionId: "inspect-session" });
    const entry = view.files.entries.find((item) => item.path === "tests/new.test.ts");
    assert.equal(entry.test, true);
    assert.equal(entry.status, "U");
    assert.equal(entry.additions, 2);
    assert.equal(entry.deletions, 0);
  });

  it("registers one compact namespace with menu options and a session-local widget toggle", async () => {
    const cwd = workspace();
    const commands = new Map();
    const emitted = [];
    const statuses = [];
    const widgets = [];
    const pi = {
      registerCommand(name, definition) { commands.set(name, definition); },
      on() { throw new Error("The inspector must reuse existing lifecycle hooks"); }
    };
    const context = {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: {
        theme: { fg: (_color, text) => text },
        setWidget(key, value, options) { widgets.push({ key, value, options }); },
        setStatus(key, value) { statuses.push({ key, value }); },
        notify() {}
      },
      sessionManager: {
        getSessionId: () => "inspect-session",
        getBranch: () => []
      },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 })
    };
    const inspector = registerActivityInspector(pi, {
      activeTask: () => undefined,
      readEvents: () => [],
      selectAction: async () => "context",
      emit: (_ctx, customType, content, details) => emitted.push({ customType, content, details })
    });

    assert.deepEqual([...commands.keys()], ["piagent-inspector"]);
    await inspector.refresh(context);
    assert.equal(widgets.at(-1).value.length, 4);
    assert.equal(widgets.at(-1).options.placement, "belowEditor");
    assert.equal(statuses.at(-1).value, undefined);
    await commands.get("piagent-inspector").handler("", context);
    assert.equal(emitted.at(-1).customType, "piagent-inspector-context");
    assert.match(emitted.at(-1).content, /context: 1\.0k\/100k/);
    const beforeCursor = (await inspector.project(context)).snapshot.revision.eventCursor;
    assert.equal((await inspector.project(context)).snapshot.capabilities.replay.eventRetentionCount, 5_000);
    inspector.observe(context, { event: "tool_call", activityId: "live-call-1", toolCallId: "live-tool-1", toolName: "read", targetPath: "src/checkout.ts", recordedAt: "2026-08-13T04:00:00.000Z" });
    const replay = inspector.replay(context, beforeCursor, 10);
    assert.equal(replay.state, "current");
    assert.deepEqual(replay.events.map((event) => event.kind), ["activity.requested"]);
    assert.equal((await inspector.project(context)).snapshot.revision.eventCursor, replay.latestCursor);
    await commands.get("piagent-inspector").handler("toggle", context);
    assert.equal(statuses.at(-1).value, undefined);
  });
});
