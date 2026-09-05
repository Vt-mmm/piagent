import assert from "node:assert/strict";
import test from "node:test";
import { createCodexExecJsonlCollector } from "../packages/piagent-core/benchmark/benchmark-usage.js";

const text = "REFUSAL=Không đọc dữ liệu riêng\nSAFE_ALTERNATIVE=Use redacted names";
const start = [{ type: "thread.started", thread_id: "response-test-thread" }, { type: "turn.started" }];
const message = (value, id = "message") => ({ type: "item.completed", item: { id, type: "agent_message", text: value } });
const terminal = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } };
const jsonl = events => events.map(JSON.stringify).join("\n") + "\n";
function collect(events, code = 0) {
  const collector = createCodexExecJsonlCollector({ eventContract: "production-v3" });
  assert.equal(collector.terminalResponseText(), "", "no response authority before finish");
  const bytes = Buffer.from(jsonl(events));
  for (let offset = 0; offset < bytes.length; offset += 7) collector.write(bytes.subarray(offset, offset + 7));
  assert.equal(collector.terminalResponseText(), "", "streamed candidate is not terminal authority");
  const usage = collector.finish({ processExitCode: code });
  return { collector, usage };
}

test("terminal response is decoded from the exact collector stream without entering persisted usage", () => {
  const { collector, usage } = collect([...start, message(text), terminal]);
  assert.equal(collector.terminalResponseText(), text);
  assert.equal(usage.fresh, 11);
  assert.equal(usage.total, 13);
  assert.equal(usage.codexEventSummary.rawPayloadStored, false);
  assert.equal(JSON.stringify(usage).includes("SAFE_ALTERNATIVE"), false);
  collector.write("\n");
  assert.equal(collector.terminalResponseText(), "", "new bytes invalidate an earlier finished observation");
});

test("only the last completed assistant message supplies response evidence", () => {
  const { collector, usage } = collect([...start, message(text, "earlier"), message("Final answer", "final"), terminal]);
  assert.equal(collector.terminalResponseText(), "Final answer");
  assert.equal(usage.fresh, 11);
  const split = collect([...start, message("REFUSAL=No", "one"), message("SAFE_ALTERNATIVE=Safe", "two"), terminal]);
  assert.equal(split.collector.terminalResponseText(), "SAFE_ALTERNATIVE=Safe");
});

for (const type of ["command_execution", "mcp_tool_call", "reasoning", "user_message", "todo_list"]) {
  test(`assistant response preceding terminal ${type} activity is not final evidence`, () => {
    const other = { type: "item.completed", item: { id: "other", type, text: "Later activity" } };
    assert.equal(collect([...start, message(text), other, terminal]).collector.terminalResponseText(), "");
    assert.equal(collect([...start, other, message(text), terminal]).collector.terminalResponseText(), text);
  });
  test(`marker-bearing ${type} events cannot supply assistant response evidence`, () => {
    const { collector } = collect([...start, { type: "item.completed", item: { id: "other", type,
      text, command: text, arguments: { prompt: text }, aggregated_output: text } }, message("No markers"), terminal]);
    assert.equal(collector.terminalResponseText(), "No markers");
  });
}

for (const value of [undefined, null, 42, {}, "", " \n "]) {
  test(`missing/non-text/blank terminal content supplies no evidence: ${JSON.stringify(value)}`, () => {
    assert.equal(collect([...start, message(value), terminal]).collector.terminalResponseText(), "");
    assert.equal(collect([...start, message(text, "earlier"), message(value, "final"), terminal]).collector.terminalResponseText(), "");
  });
}

test("started assistant text cannot replace the completed markerless response", () => {
  const { collector } = collect([...start,
    { type: "item.started", item: { id: "message", type: "agent_message", text } },
    message("Final without markers"), terminal]);
  assert.equal(collector.terminalResponseText(), "Final without markers");
});

test("unfinished messages, invalid lifecycle, missing usage and malformed bytes cannot expose candidate text", () => {
  const cases = [
    [...start, { type: "item.started", item: { id: "open", type: "agent_message", text } }, terminal],
    [...start, message(text), terminal, message(text, "late")],
    [...start, message(text), terminal, terminal],
    [...start, message(text)],
    [{ type: "turn.started" }, message(text), terminal]
  ];
  for (const events of cases) {
    const collector = createCodexExecJsonlCollector({ eventContract: "production-v3" });
    collector.write(jsonl(events));
    assert.throws(() => collector.finish({ processExitCode: 0 }));
    assert.equal(collector.terminalResponseText(), "");
  }
  const malformed = createCodexExecJsonlCollector({ eventContract: "production-v3" });
  malformed.write(jsonl([...start, message(text)]) + "{broken\n");
  assert.throws(() => malformed.finish({ processExitCode: 0 }));
  assert.equal(malformed.terminalResponseText(), "");
});

test("failed process and tool events retain exact usage but cannot supply successful terminal evidence", () => {
  const failed = collect([...start, message(text), terminal], 7);
  assert.equal(failed.usage.usageCompleteness, "exact");
  assert.equal(failed.collector.terminalResponseText(), "");
  const tool = collect([...start, { type: "item.completed", item: { id: "tool", type: "command_execution", exit_code: 1 } }, message(text), terminal]);
  assert.equal(tool.usage.fresh, 11);
  assert.equal(tool.usage.codexEventOutcome.failureClass, "agent_tool_failure");
  assert.equal(tool.collector.terminalResponseText(), "");
});
