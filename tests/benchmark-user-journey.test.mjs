import assert from "node:assert/strict";
import test from "node:test";

import { runCodexUserJourney } from "../scripts/benchmark-session.mjs";

function codexTurn(threadId, inputTokens, outputTokens) {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "item.completed", item: { id: `message-${inputTokens}`, type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 1
    } }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

test("Codex production journey preserves one thread and sums every turn exactly", async () => {
  const calls = [];
  const threadId = "019abcde-1234-7000-8000-0123456789ab";
  const outputs = [codexTurn(threadId, 10, 3), codexTurn(threadId, 12, 4), codexTurn(threadId, 14, 5)];
  const result = await runCodexUserJourney({
    runCommand: async (command, args, options) => {
      const index = calls.length;
      calls.push({ command, args, input: options.input });
      options.onStdoutChunk(outputs[index], { observedAtSeconds: 0.1 });
      return { code: 0, signal: null, timedOut: false, stdout: outputs[index], stderr: "", durationSeconds: 0.2,
        forbiddenHits: [] };
    },
    codexCommand: "/usr/local/bin/codex",
    workspace: "/tmp/production-fixture",
    turns: [
      { id: "scout", message: "Scout" },
      { id: "implement", message: "Implement" },
      { id: "verify", message: "Verify" }
    ],
    options: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled" },
    disabledFeatures: ["multi_agent"],
    environment: { NO_COLOR: "1" },
    timeoutMs: 10_000,
    forbiddenOutputSubstrings: []
  });

  assert.equal(result.agent.code, 0);
  assert.equal(result.journeyReceipt.completed, true);
  assert.equal(result.journeyReceipt.threadId, threadId);
  assert.equal(result.usage.sessions, 1);
  assert.equal(result.usage.turns, 3);
  assert.equal(result.usage.input, (10 - 2) + (12 - 2) + (14 - 2));
  assert.equal(result.usage.cacheRead, 6);
  assert.equal(result.usage.output, 12);
  assert.equal(result.usage.fresh, 42);
  assert.deepEqual(calls.map((call) => call.input), ["Scout", "Implement", "Verify"]);
  assert.equal(calls[0].args.includes("--ephemeral"), false);
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.args.slice(0, 3), ["exec", "resume", "--json"]);
    assert.ok(call.args.includes(threadId));
  }
});

test("Codex journey fails closed when a resumed turn changes thread identity", async () => {
  const outputs = [
    codexTurn("019abcde-1234-7000-8000-0123456789ab", 10, 3),
    codexTurn("019fffff-1234-7000-8000-0123456789ab", 12, 4)
  ];
  let index = 0;
  const result = await runCodexUserJourney({
    runCommand: async (_command, _args, options) => {
      const stdout = outputs[index++];
      options.onStdoutChunk(stdout, { observedAtSeconds: 0.1 });
      return { code: 0, signal: null, timedOut: false, stdout, stderr: "", durationSeconds: 0.2, forbiddenHits: [] };
    },
    codexCommand: "codex",
    workspace: "/tmp/production-fixture",
    turns: [{ id: "one", message: "One" }, { id: "two", message: "Two" }],
    options: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled" },
    disabledFeatures: [],
    environment: {},
    timeoutMs: 10_000,
    forbiddenOutputSubstrings: []
  });
  assert.equal(result.agent.code, 1);
  assert.equal(result.journeyReceipt.completed, false);
  assert.equal(result.usage.usageCompleteness, "unverified");
  assert.match(result.diagnostics.map((item) => item.message).join("\n"), /changed thread identity|incomplete/i);
});

test("Codex journey retains exact token usage from a failed started turn", async () => {
  const threadId = "019abcde-1234-7000-8000-0123456789ab";
  const outputs = [codexTurn(threadId, 10, 3), codexTurn(threadId, 12, 4)];
  let index = 0;
  const result = await runCodexUserJourney({
    runCommand: async (_command, _args, options) => {
      const current = index++;
      const stdout = outputs[current];
      options.onStdoutChunk(stdout, { observedAtSeconds: 0.1 });
      return { code: current === 1 ? 7 : 0, signal: null, timedOut: false, stdout, stderr: "", durationSeconds: 0.2,
        forbiddenHits: [] };
    },
    codexCommand: "codex",
    workspace: "/tmp/production-fixture",
    turns: [{ id: "one", message: "One" }, { id: "two", message: "Two" }, { id: "three", message: "Three" }],
    options: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled" },
    disabledFeatures: [],
    environment: {},
    timeoutMs: 10_000,
    forbiddenOutputSubstrings: []
  });
  assert.equal(result.agent.code, 7);
  assert.equal(result.journeyReceipt.completed, false);
  assert.equal(result.usage.usageCompleteness, "exact");
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.fresh, (10 - 2 + 3) + (12 - 2 + 4));
  assert.match(result.diagnostics.map((item) => item.message).join("\n"), /stopped before every requested turn started/);
});
