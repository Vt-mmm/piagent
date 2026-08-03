import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  assistantMessageHasToolCall,
  assistantMessageText,
  cleanSessionNameInput,
  hasOperatorSessionName,
  looksLikeCompletionClaim
} from "../packages/piagent-core/runtime/session/message-signals.ts";
import {
  buildContextPreflight,
  buildUsageSnapshot,
  formatUsageSnapshot
} from "../packages/piagent-core/runtime/session/usage.ts";
import {
  attachToolResultCompactionDetails,
  compactToolResultTextContent
} from "../packages/piagent-core/runtime/session/tool-result-compaction.ts";
import { RuntimeSessionState } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import {
  compactManagedProjectInstructions,
  rewriteLegacyProjectInstructions
} from "../packages/piagent-core/runtime/session/system-prompt.ts";
import {
  PIAGENT_TOOL_NAMES,
  activeTaskToolGroups,
  toolGroupsForPrompt
} from "../packages/piagent-core/runtime/tools/tool-groups.ts";
import {
  buildFreshCommand,
  chooseFreshWorkflow,
  extractTaskRequest,
  isFreshOrUtilityInput,
  trimTaskForInline
} from "../packages/piagent-core/runtime/workflows/input-routing.ts";
import {
  automaticReviewLenses,
  automaticTaskIntakeEligible,
  automaticTaskScope,
  validTaskScopePattern
} from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import {
  attachLocalImagesFromText,
  readChatImage
} from "../packages/piagent-core/runtime/input/chat-images.ts";
import { registerSessionHooks } from "../packages/piagent-core/runtime/hooks/session-hooks.ts";
import { registerInputHook } from "../packages/piagent-core/runtime/hooks/input-hook.ts";
import {
  filterGrepProtectedContent,
  filterProtectedPathListContent
} from "../packages/piagent-core/runtime/hooks/tool-result-hook.ts";

const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-"));
  temporaryRoots.add(root);
  return root;
}

function extensionContext(cwd = temporaryProject(), sessionId = "session-1") {
  return {
    cwd,
    mode: "interactive",
    model: { provider: "openai-codex", id: "gpt-test" },
    getContextUsage: () => ({ tokens: 52_000, contextWindow: 100_000, percent: 52 }),
    sessionManager: {
      getSessionFile: () => path.join(cwd, "session.jsonl"),
      getSessionId: () => sessionId,
      getSessionName: () => "TASK-123",
      getEntries: () => [{}, {}, {}],
      getBranch: () => [{}, {}]
    }
  };
}

describe("runtime session modules", () => {
  it("classifies assistant completion without treating blocked handoffs as done", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "Da hoan thanh va tests passed." }] };
    assert.equal(assistantMessageText(message), "Da hoan thanh va tests passed.");
    assert.equal(assistantMessageHasToolCall(message), false);
    assert.equal(looksLikeCompletionClaim(assistantMessageText(message)), true);
    assert.equal(looksLikeCompletionClaim("Chua hoan thanh, test failed."), false);

    const withTool = { role: "assistant", content: [{ type: "toolCall", name: "read" }] };
    assert.equal(assistantMessageHasToolCall(withTool), true);
  });

  it("owns session naming rules independently from the extension entrypoint", () => {
    assert.equal(cleanSessionNameInput("  'TASK-123'  "), "TASK-123");
    assert.equal(hasOperatorSessionName("TASK-123"), true);
    assert.equal(hasOperatorSessionName("session"), false);
  });

  it("rewrites legacy instructions and compacts the managed prompt region", () => {
    const legacy = [
      "Before implementation:",
      "",
      "1. Load `.pi/piagent-profile.json` with `piagent_context`.",
      "legacy steps",
      "18. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns, review loops, native supervisor coordination, and safety boundaries."
    ].join("\n");
    const rewritten = rewriteLegacyProjectInstructions(legacy);
    assert.equal(rewritten.rewritten, true);
    assert.match(rewritten.systemPrompt, /Piagent runtime-managed task flow/);
    assert.doesNotMatch(rewritten.systemPrompt, /legacy steps/);

    const compacted = compactManagedProjectInstructions(
      `prefix\n<!-- piagent-managed:start -->\nlong text\n<!-- piagent-managed:end -->\nsuffix`,
      "automatic"
    );
    assert.equal(compacted.compacted, true);
    assert.match(compacted.systemPrompt, /Root project instructions are already loaded/);
    assert.doesNotMatch(compacted.systemPrompt, /long text/);
  });

  it("builds usage and preflight decisions from one shared threshold policy", () => {
    const snapshot = buildUsageSnapshot(extensionContext(), "high");
    assert.equal(snapshot.model, "openai-codex/gpt-test");
    assert.equal(snapshot.thinkingLevel, "high");
    assert.equal(buildContextPreflight(snapshot, "task", 100).recommendation, "watch");
    assert.match(formatUsageSnapshot(snapshot), /TASK-123/);

    const large = buildContextPreflight(snapshot, "task", 8_100);
    assert.equal(large.recommendation, "fresh-session");
  });

  it("routes workflow input without asking the model to rediscover commands", () => {
    assert.equal(extractTaskRequest("/workflow scout inspect auth"), "inspect auth");
    assert.equal(chooseFreshWorkflow("/workflow scout inspect auth", "inspect auth"), "scout");
    assert.equal(chooseFreshWorkflow("Map backend then fix frontend", "Map backend then fix frontend"), "be-to-fe");
    assert.equal(isFreshOrUtilityInput("/usage"), true);
    assert.match(trimTaskForInline("x".repeat(3_000)), /Input truncated by piagent preflight/);
  });

  it("isolates mutable runtime state by project session", () => {
    const cwd = temporaryProject();
    const first = extensionContext(cwd, "session-1");
    const second = extensionContext(cwd, "session-2");
    const state = new RuntimeSessionState({ maxObservedContext: 2 });

    state.cacheTaskIdentity(first, { taskId: "TASK-1", taskRunId: "run-1" });
    state.rememberObservedContext(first, { path: "src/a.ts", reason: "read" });
    state.rememberObservedContext(first, { path: "src/b.ts", reason: "read" });
    state.rememberObservedContext(first, { path: "src/c.ts", reason: "read" });
    state.rememberAdvisedTool(first, "bash");
    state.rememberToolResult(first, "same-call", { outputHash: "hash-1", recordedAt: "now" });
    state.rememberInjectedContextPack(first, "same-query", {
      queryHash: "query-1",
      confidence: "high",
      estimatedTokens: 10,
      paths: ["src/a.ts"]
    });

    assert.deepEqual(state.taskIdentity(first), { taskId: "TASK-1", taskRunId: "run-1" });
    assert.deepEqual(state.observedContext(first).map((item) => item.path), ["src/b.ts", "src/c.ts"]);
    assert.deepEqual(state.observedContext(second), []);
    assert.equal(state.hasAdvisedTool(first, "bash"), true);
    assert.equal(state.hasAdvisedTool(second, "bash"), false);
    assert.equal(state.previousToolResult(second, "same-call"), undefined);
    assert.equal(state.injectedContextPack(second, "same-query"), undefined);
    assert.equal(state.injectedContextPack(first, "same-query")?.queryHash, "query-1");

    state.clearSession(first);
    assert.equal(state.taskIdentity(first), undefined);
    assert.deepEqual(state.observedContext(first), []);
    assert.equal(state.hasAdvisedTool(first, "bash"), false);
    assert.equal(state.injectedContextPack(first, "same-query"), undefined);
  });

  it("registers session lifecycle hooks around one shared state owner", async () => {
    const handlers = new Map();
    const pi = { on: (name, handler) => handlers.set(name, handler) };
    const cwd = temporaryProject();
    const ctx = { ...extensionContext(cwd), isIdle: () => true };
    const state = new RuntimeSessionState({ maxObservedContext: 4 });
    const task = { taskId: "TASK-1", taskRunId: "run-1", sessionName: "old", trace: { outcome: "pending" } };
    const traces = [];
    const telemetry = [];
    const bindings = [];
    const flushed = [];

    state.cacheTaskIdentity(ctx, task);
    state.rememberObservedContext(ctx, { path: "src/a.ts", reason: "read" });
    registerSessionHooks(pi, {
      state,
      maxManifestFiles: 4,
      telemetry: (_ctx, payload) => telemetry.push(payload),
      activeTask: () => task,
      writeTask: (_cwd, value) => value,
      bindTask: (...args) => bindings.push(args),
      appendTrace: (_cwd, payload) => traces.push(payload),
      flushObservedTaskContext: (_pi, _ctx, pending, maximum, event) => {
        flushed.push({ pending, maximum, event });
        return task;
      }
    });

    assert.deepEqual([...handlers.keys()], [
      "session_info_changed",
      "turn_end",
      "agent_settled",
      "session_compact",
      "session_shutdown"
    ]);
    await handlers.get("session_info_changed")({ name: "TASK-2" }, ctx);
    assert.equal(task.sessionName, "TASK-2");
    assert.equal(bindings.length, 1);
    assert.equal(traces[0].event, "task_session_renamed");

    await handlers.get("turn_end")({ message: { role: "assistant" }, turnIndex: 2, toolResults: [] }, ctx);
    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("session_compact")({ reason: "threshold", willRetry: false, fromExtension: false }, ctx);
    await handlers.get("session_shutdown")({ reason: "quit", targetSessionFile: "/tmp/session.jsonl" }, ctx);
    assert.deepEqual(telemetry.map((entry) => entry.event), ["turn_end", "agent_settled", "session_compact", "session_shutdown"]);
    assert.equal(telemetry.at(-1).targetSessionFile, "session.jsonl");
    assert.deepEqual(flushed[0].pending, [{ path: "src/a.ts", reason: "read" }]);
    assert.equal(state.taskIdentity(ctx), undefined);
  });

  it("handles input aliases and automatic intake without model-side command discovery", async () => {
    const handlers = new Map();
    const pi = {
      on: (name, handler) => handlers.set(name, handler),
      getThinkingLevel: () => "high"
    };
    const activated = [];
    const telemetry = [];
    registerInputHook(pi, {
      boilerplateCollapseChars: 300,
      activeTask: () => undefined,
      readProtectedPaths: () => [],
      imageAccess: () => assert.fail("image policy should be lazy when input contains no image path"),
      activateToolGroups: (_ctx, groups) => activated.push(groups),
      telemetry: (_ctx, payload) => telemetry.push(payload)
    });
    const ctx = extensionContext();

    assert.deepEqual(
      await handlers.get("input")({ text: "/piagent-workflow scout auth", source: "interactive" }, ctx),
      { action: "transform", text: "/workflow scout auth" }
    );
    assert.deepEqual(
      await handlers.get("input")({ text: "Fix src/cart.ts quantity calculation", source: "interactive", images: [] }, ctx),
      { action: "continue" }
    );
    assert.deepEqual(activated, [[]]);
    assert.equal(telemetry[0].event, "user_input");
    assert.equal(telemetry[0].intakeMode, "runtime");
  });

  it("keeps tool activation and task intake policy deterministic", () => {
    assert.deepEqual(toolGroupsForPrompt("/usage"), ["usage"]);
    assert.deepEqual(
      toolGroupsForPrompt("/onboard"),
      ["governance", "policy", "retrieval", "knowledge", "onboarding"]
    );
    assert.equal(PIAGENT_TOOL_NAMES.has("piagent_task_start"), true);
    assert.deepEqual(activeTaskToolGroups({
      changeMode: "source-change",
      riskLane: "tiny",
      workPlan: [
        { id: "implement", role: "parent", mode: "single-writer" },
        { id: "verify", role: "parent", mode: "review", dependsOn: ["implement"] }
      ]
    }), []);

    assert.equal(automaticTaskIntakeEligible("Fix src/cart.ts quantity calculation", []), true);
    assert.equal(automaticTaskIntakeEligible("Review src/cart.ts quantity calculation", []), false);
    assert.deepEqual(
      automaticTaskScope("Fix src/cart.ts and tests", [{ path: "src/helper.ts" }]),
      ["src/cart.ts", "src/helper.ts", "test/**", "tests/**", "spec/**", "__tests__/**"]
    );
    assert.deepEqual(automaticReviewLenses("Fix auth session validation"), ["correctness", "tests", "scope", "security"]);
    assert.equal(validTaskScopePattern("src/**"), true);
    assert.equal(validTaskScopePattern("../outside/**"), false);
  });

  it("attaches only permitted files whose bytes are real images", () => {
    const cwd = temporaryProject();
    const imagePath = path.join(cwd, "screen.png");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4h8AAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(imagePath, png);
    const access = {
      roots: [{ path: fs.realpathSync(cwd), source: "project" }],
      readProtectedPaths: [],
      enforceFilesystemRead: false
    };

    const inspected = readChatImage(imagePath, cwd, access);
    assert.equal(inspected.status, "ok");
    if (inspected.status === "ok") assert.equal(inspected.mimeType, "image/png");

    const attached = attachLocalImagesFromText(`Inspect ${imagePath}`, [], cwd, () => access);
    assert.equal(attached?.images.length, 1);
    assert.match(attached?.text ?? "", /\[image1\]/);

    const blocked = readChatImage(imagePath, cwd, { ...access, readProtectedPaths: ["screen.png"] });
    assert.equal(blocked.status, "error");
    if (blocked.status === "error") assert.match(blocked.reason, /protected path/);
  });

  it("filters protected paths from broad grep, find, and ls output", () => {
    const grep = filterGrepProtectedContent(
      [{ type: "text", text: "src/app.ts:1:ok\n.env:1:SECRET" }],
      [".env"]
    );
    assert.equal(grep.redactedLines, 1);
    assert.match(grep.content[0].text, /src\/app\.ts/);
    assert.doesNotMatch(grep.content[0].text, /SECRET/);

    const listed = filterProtectedPathListContent(
      "/workspace",
      [{ type: "text", text: "app.ts\nprivate\nREADME.md" }],
      ["src/private/**"],
      "src",
      "ls"
    );
    assert.equal(listed.redactedLines, 1);
    assert.doesNotMatch(listed.content[0].text, /^private$/m);
  });

  it("stores long intake and compacted tool output under private project state", () => {
    const cwd = temporaryProject();
    const command = buildFreshCommand(cwd, "task", "A".repeat(8_100), "Start clean.");
    const intake = command.match(/from (\.pi\/task-inbox\/[^.]+\.md)/)?.[1];
    assert.ok(intake, command);
    assert.equal(fs.existsSync(path.join(cwd, intake)), true);

    const ctx = extensionContext(cwd);
    const event = { toolName: "bash", input: { command: "npm test" }, details: { exitCode: 0 } };
    const result = compactToolResultTextContent(
      cwd,
      event,
      ctx,
      [{ type: "text", text: `${"line\n".repeat(2_000)}ERROR final line` }],
      new Map()
    );
    assert.equal(result.captures.length, 1);
    assert.match(result.content[0].text, /Piagent compacted large bash output/);
    const capture = result.captures[0];
    assert.ok(capture.path);
    assert.equal(fs.statSync(path.join(cwd, capture.path)).mode & 0o777, 0o600);
    assert.deepEqual(
      attachToolResultCompactionDetails(undefined, result.captures).piagentCompactedToolResults[0].path,
      capture.path
    );
  });
});
