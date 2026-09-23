import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCodexTurnUsage, createCodexExecJsonlCollector } from "../packages/piagent-core/benchmark/benchmark-usage.js";
import { buildProductionV3SessionGraderInput, finalizeProductionV3SessionOutcome } from "../scripts/benchmark-session-evaluator.mjs";

const start = [{ type: "thread.started", thread_id: "offline-command-recovery" }, { type: "turn.started" }];
const command = (id, exit_code, status = exit_code === 0 ? "completed" : "failed") => ({
  type: "item.completed", item: { id, type: "command_execution", exit_code, status }
});
const answer = { type: "item.completed", item: { id: "answer", type: "agent_message", text: "Implemented and verified." } };
const terminal = { type: "turn.completed", usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 8 } };
function collect(items, processExitCode = 0) {
  const collector = createCodexExecJsonlCollector({ eventContract: "production-v3" });
  collector.write([...start, ...items].map(JSON.stringify).join("\n") + "\n");
  return { usage: collector.finish({ processExitCode }), text: collector.terminalResponseText() };
}
const recovery = [command("failed-test", 1), command("passing-test", 0), answer, terminal];

test("command error followed by successful execution preserves telemetry without poisoning terminal completion", () => {
  const { usage, text } = collect(recovery);
  assert.equal(usage.codexEventOutcome.terminalStatus, "completed");
  assert.equal(usage.codexEventOutcome.failureClass, null);
  assert.deepEqual(usage.codexEventOutcome.reasonCodes, []);
  assert.deepEqual(usage.codexEventSummary.failureSignals, ["command-exit-nonzero", "command_execution-failed"]);
  assert.deepEqual(usage.codexEventSummary.terminalFailureSignals, []);
  assert.equal(usage.codexEventSummary.commandFailureEvents, 1);
  assert.equal(usage.codexEventSummary.continuedCommandFailureEvents, 1);
  assert.equal(usage.usageCompleteness, "exact");
  assert.equal(usage.fresh, 58);
  assert.equal(usage.total, 68);
  assert.equal(text, answer.item.text);
  assert.equal(JSON.stringify(usage).includes(answer.item.text), false);
});

for (const [name, items, exitCode] of [
  ["unresolved command", [command("failed", 1), answer, terminal], 0],
  ["later command fails again", [command("first", 1), command("success", 0), command("last", 2), answer, terminal], 0],
  ["blocked command", [command("blocked", null, "blocked"), command("success", 0), answer, terminal], 0],
  ["non-command item failure", [{ type: "item.completed", item: { id: "mcp", type: "mcp_tool_call", status: "failed" } }, command("success", 0), answer, terminal], 0],
  ["top-level error", [...recovery.slice(0, -1), { type: "error", message: "offline error" }, terminal], 0],
  ["failed turn", [...recovery.slice(0, -1), { type: "turn.failed", error: { message: "failed" } }, terminal], 0],
  ["failed process", recovery, 7],
  ["missing response", [command("failed", 1), command("success", 0), terminal], 0],
  ["only earlier response", [answer, command("failed", 1), command("success", 0), terminal], 0],
  ["blank response", [command("failed", 1), command("success", 0), { ...answer, item: { ...answer.item, text: " " } }, terminal], 0]
]) {
  test(`command continuation does not mask ${name}`, () => {
    const result = collect(items, exitCode);
    assert.notEqual(result.usage.codexEventOutcome.terminalStatus, "completed");
    assert.equal(result.text, "");
    assert.equal(result.usage.fresh, 58);
  });
}

test("cancelled or unfinished execution remains unknown even after a successful command", () => {
  assert.throws(() => collect(recovery.slice(0, -2), 130), error =>
    error.failureClass === "unknown_terminal" && error.codexEventOutcome.usageStatus === "unknown_post_provider");
});

function graderInput(usage) {
  return buildProductionV3SessionGraderInput({ suiteId: "production-v3",
    oracleSerialized: JSON.stringify({ schemaVersion: 1, graderData: {} }),
    scenario: { kind: "source-change", userJourney: { turns: [{ id: "request" }] } },
    surface: "codex-cli", sessionId: "offline-command-recovery", usage,
    agent: { code: 0, timedOut: false, responseText: answer.item.text },
    journeyReceipt: { completed: true, turns: [{ index: 1 }] }, changedFiles: ["src/fix.js"] });
}

for (const aggregate of [false, true]) {
  test(`functional grading still decides quality after command recovery (aggregate=${aggregate})`, () => {
    const parsed = collect(recovery).usage;
    const usage = aggregate ? aggregateCodexTurnUsage([parsed]) : parsed;
    const input = graderInput(usage);
    assert.equal(input.transport.failedCommandEvents, 0, "terminal evidence excludes continued command failures");
    for (const passed of [false, true]) {
      const outcome = finalizeProductionV3SessionOutcome({ attemptId: "offline", input, grade: { passed }, usage });
      assert.equal(outcome.gradeStatus, passed ? "pass" : "fail");
      assert.equal(outcome.failureClass, passed ? "none" : "agent_task_failure");
      assert.equal(outcome.usage.fresh, 58);
    }
    const legacy = structuredClone(parsed);
    legacy.codexEventSummary.schemaVersion = 1;
    delete legacy.codexEventSummary.terminalFailureSignals;
    assert.equal(graderInput(legacy).transport.failedCommandEvents, 2, "legacy evidence retains its original classification");
  });
}
