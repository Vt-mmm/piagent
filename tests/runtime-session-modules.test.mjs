import assert from "node:assert/strict";
import { redactSensitiveText } from "../packages/piagent-core/extensions/redaction-core.js";
import { execFileSync } from "node:child_process";
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
  compactToolResultDetails,
  compactToolResultTextContent
} from "../packages/piagent-core/runtime/session/tool-result-compaction.ts";
import { currentFileContentDigests, expectedModelMutationProof } from "../packages/piagent-core/runtime/quality/model-mutation-proof.ts";
import { RuntimeSessionState } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import {
  buildSemanticCompactionInstructions,
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
  freshRequestParts,
  isFreshOrUtilityInput,
  trimTaskForInline
} from "../packages/piagent-core/runtime/workflows/input-routing.ts";
import {
  automaticAcceptanceCriteria,
  automaticReviewLenses,
  automaticTaskSummary,
  automaticTaskIntakeEligible,
  automaticTaskIntakeMode,
  automaticTaskScope,
  boundedRuntimeIntakeMessage,
  resolveTaskScopePatterns,
  validTaskScopePattern
} from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import {
  RUNTIME_INTAKE_MESSAGE_MAX_CHARS,
  SEMANTIC_COMPACTION_MAX_CHARS,
  TOOL_RESULT_PREVIEW_MAX_CHARS
} from "../packages/piagent-core/runtime/runtime-limits.ts";
import {
  analyzePerformanceAssurance,
  boundedGitDiffReview,
  performanceReviewGuidance,
  performanceReviewToolDecision
} from "../packages/piagent-core/runtime/quality/performance-assurance.ts";
import {
  attachLocalImagesFromText,
  readChatImage
} from "../packages/piagent-core/runtime/input/chat-images.ts";
import { registerSessionHooks } from "../packages/piagent-core/runtime/hooks/session-hooks.ts";
import { registerInputHook } from "../packages/piagent-core/runtime/hooks/input-hook.ts";
import { taskDeltaFilesFromSnapshot } from "../packages/piagent-core/extensions/task-contract-view.js";
import { filterGrepProtectedContent, filterProtectedPathListContent, registerToolResultHook } from "../packages/piagent-core/runtime/hooks/tool-result-hook.ts";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { boundedPerformanceReviewResultText } from "../packages/piagent-core/runtime/quality/performance-review-evidence.ts";
import {
  prefixCompletions,
  piagentToolBatchMode,
  piagentToolExecutionMode,
  registerRuntimeCommand,
  registerRuntimeTool
} from "../packages/piagent-core/runtime/registration/extension-registration.ts";
import {
  FRESH_COMMAND_ACTIONS,
  ONBOARDING_COMMAND_ACTIONS,
  WORKFLOW_COMMAND_EXCLUSIONS
} from "../packages/piagent-core/runtime/registration/operator-catalogs.ts";

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
  it("registers tools and commands through the bounded composition adapter", () => {
    const registered = { commands: [], tools: [] };
    const pi = {
      registerCommand: (name, definition) => registered.commands.push({ name, definition }),
      registerTool: (definition) => registered.tools.push(definition)
    };
    const command = { description: "status", handler: async () => undefined };
    const tool = { name: "status" };

    registerRuntimeCommand(pi, "status", command);
    registerRuntimeTool(pi, tool);

    assert.deepEqual(registered.commands, [{ name: "status", definition: command }]);
    assert.deepEqual(registered.tools, [{ ...tool, executionMode: "parallel" }]);
    assert.equal(piagentToolExecutionMode("piagent_context_index_search"), "parallel");
    assert.equal(piagentToolExecutionMode("piagent_context_index_record"), "sequential");
    assert.equal(piagentToolBatchMode(["piagent_context_index_search", "piagent_memory_search"]), "parallel");
    assert.equal(piagentToolBatchMode(["piagent_memory_search", "piagent_memory_note"]), "sequential");
    assert.deepEqual(prefixCompletions(ONBOARDING_COMMAND_ACTIONS, "se"), [{ value: "setup", label: "setup" }]);
    assert.deepEqual(prefixCompletions(FRESH_COMMAND_ACTIONS, "be"), [{ value: "be-to-fe", label: "be-to-fe" }]);
    assert.equal(WORKFLOW_COMMAND_EXCLUSIONS.includes("platform"), true);
  });

  it("converts legacy Piagent error results into host-visible tool failures", async () => {
    const registered = [];
    const pi = { registerTool: (definition) => registered.push(definition) };
    registerRuntimeTool(pi, {
      name: "piagent_refused_fixture",
      async execute() {
        return {
          content: [{ type: "text", text: "Task start refused: choose an exact scope." }],
          details: { candidates: ["packages/a/src/plan.js"] },
          isError: true
        };
      }
    });

    await assert.rejects(
      registered[0].execute("call-1", {}, undefined, undefined, extensionContext()),
      (error) => {
        assert.match(error.message, /Task start refused/);
        assert.deepEqual(error.details, { candidates: ["packages/a/src/plan.js"] });
        return true;
      }
    );
  });

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

  it("bounds runtime intake and semantic carry-over while preserving contract edges", () => {
    const intake = boundedRuntimeIntakeMessage(`HEAD:${"a".repeat(8_000)}:TAIL`);
    assert.equal(intake.length, RUNTIME_INTAKE_MESSAGE_MAX_CHARS);
    assert.match(intake, /^HEAD:/);
    assert.match(intake, /complete operator request and durable Task Contract remain authoritative/);
    assert.match(intake, /:TAIL$/);

    const criteria = Array.from({ length: 12 }, (_item, index) => (
      `[C${index + 1}] preserve obligation head ${"x".repeat(420)} obligation-tail-${index + 1}`
    ));
    const carryOver = buildSemanticCompactionInstructions({
      taskId: "BOUNDED-RESUME",
      taskRunId: "bounded-resume-run",
      sessionId: "session-1",
      sessionName: "BOUNDED-RESUME",
      riskLane: "normal",
      summary: `Goal head ${"g".repeat(900)} goal tail`,
      acceptanceCriteria: criteria,
      scope: Array.from({ length: 40 }, (_item, index) => `packages/service-${index}/src/**`),
      changedFiles: Array.from({ length: 40 }, (_item, index) => `packages/service-${index}/src/file.ts`),
      verifyCommands: ["npm test", `node --test ${"test/fixture.mjs ".repeat(40)}`],
      trace: { outcome: "pending", friction: `blocker ${"b".repeat(600)} blocker-tail` }
    });
    assert.ok(carryOver.length <= SEMANTIC_COMPACTION_MAX_CHARS, carryOver.length);
    for (let index = 1; index <= 12; index += 1) assert.match(carryOver, new RegExp(`\\[C${index}\\]`));
    assert.match(carryOver, /obligation-tail-12/);
    assert.match(carryOver, /Exact verify commands:\n1\. npm test/);
    assert.match(carryOver, /Full task truth is file-backed by the durable Task Contract/);
    assert.match(carryOver, /Do not convert assumptions into facts/);
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
    const mutationIdentity = { taskId: "TASK-1", taskRunId: "run-1", sessionId: "session-1" };

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
    state.rememberPerformanceReviewCheckpoint("run-1", "a".repeat(64), 1);
    state.rememberPerformanceReviewCredit("run-1", {
      workingTreeDigest: "b".repeat(64),
      commandHash: "c".repeat(64),
      reviewedPaths: ["src/a.ts"],
      recordedAt: "2026-08-09T00:00:00.000Z"
    });

    assert.deepEqual(state.taskIdentity(first), { taskId: "TASK-1", taskRunId: "run-1" });
    assert.deepEqual(state.observedContext(first).map((item) => item.path), ["src/b.ts", "src/c.ts"]);
    assert.deepEqual(state.observedContext(second), []);
    assert.equal(state.hasAdvisedTool(first, "bash"), true);
    assert.equal(state.hasAdvisedTool(second, "bash"), false);
    assert.equal(state.previousToolResult(second, "same-call"), undefined);
    assert.equal(state.injectedContextPack(second, "same-query"), undefined);
    assert.equal(state.injectedContextPack(first, "same-query")?.queryHash, "query-1");
    assert.deepEqual(state.performanceReviewCheckpoint("run-1"), {
      workingTreeDigest: "a".repeat(64),
      attempt: 1,
      activityObserved: false,
      reviewSatisfied: false,
      inspectionCalls: 0,
      shellInspectionCalls: 0,
      expectedPaths: [],
      reviewedPaths: [],
      mutationObserved: false,
      revision: 0,
      successfulMutationCalls: 0,
      successfulMutationsInRevision: 0,
      mutatedPaths: [],
      verifierCalls: 0,
      verifierCallsInRevision: 0,
      verifierState: "not-required",
      transientRetryUsed: false,
      invalidated: false
    });
    assert.deepEqual(state.performanceReviewCredit("run-1", "b".repeat(64)), {
      workingTreeDigest: "b".repeat(64),
      commandHash: "c".repeat(64),
      reviewedPaths: ["src/a.ts"],
      recordedAt: "2026-08-09T00:00:00.000Z"
    });
    assert.equal(state.performanceReviewCredit("run-1", "d".repeat(64)), undefined, "a changed tree invalidates review credit");
    state.rememberPerformanceReviewCredit("run-1", {
      workingTreeDigest: "b".repeat(64),
      commandHash: "c".repeat(64),
      reviewedPaths: ["src/a.ts"],
      recordedAt: "2026-08-09T00:00:00.000Z"
    });
    assert.equal(state.invalidatePerformanceReviewCredit("run-1"), true);
    assert.equal(state.performanceReviewCredit("run-1"), undefined);
    state.rememberPerformanceReviewCheckpoint(
      "run-1",
      "b".repeat(64),
      2,
      ["src/a.ts", "test/a.test.ts"],
      ["src/a.ts", "test/a.test.ts"]
    );
    state.rememberPerformanceReviewCredit("run-1", {
      workingTreeDigest: "b".repeat(64),
      commandHash: "c".repeat(64),
      reviewedPaths: ["src/a.ts", "test/a.test.ts"],
      recordedAt: "2026-08-09T00:00:00.000Z"
    });
    const beforeSource = { "src/a.ts": "source-1", "test/a.test.ts": "test-1" };
    assert.equal(state.reservePerformanceReviewTool("run-1", {
      toolCallId: "source-edit",
      kind: "mutation",
      toolName: "edit",
      workingTreeDigest: "b".repeat(64),
      workingTreeSnapshot: beforeSource,
      targetPaths: ["src/a.ts"]
    }), true);
    assert.equal(state.completePerformanceReviewTool("run-1", "source-edit", {
      success: true,
      postWorkingTreeDigest: "e".repeat(64),
      postWorkingTreeSnapshot: { ...beforeSource, "src/a.ts": "source-2" }
    }), "recorded");
    assert.equal(state.reservePerformanceReviewTool("run-1", {
      toolCallId: "test-edit",
      kind: "mutation",
      toolName: "edit",
      workingTreeDigest: "e".repeat(64),
      workingTreeSnapshot: { ...beforeSource, "src/a.ts": "source-2" },
      targetPaths: ["test/a.test.ts"]
    }), true);
    assert.equal(state.completePerformanceReviewTool("run-1", "test-edit", {
      success: true,
      postWorkingTreeDigest: "f".repeat(64),
      postWorkingTreeSnapshot: { "src/a.ts": "source-2", "test/a.test.ts": "test-2" }
    }), "recorded");
    assert.match(JSON.stringify(state.performanceReviewCheckpoint("run-1")), /"successfulMutationsInRevision":2/);
    assert.equal(state.reservePerformanceReviewTool("run-1", {
      toolCallId: "verify-1",
      kind: "verifier",
      toolName: "bash",
      workingTreeDigest: "f".repeat(64),
      workingTreeSnapshot: { "src/a.ts": "source-2", "test/a.test.ts": "test-2" },
      targetPaths: []
    }), true);
    assert.equal(state.completePerformanceReviewTool("run-1", "verify-1", {
      success: false,
      exitCode: 1,
      failure: { retryable: false, sourceMutationPermission: "eligible-in-scope", confidence: "high" },
      postWorkingTreeDigest: "f".repeat(64),
      postWorkingTreeSnapshot: { "src/a.ts": "source-2", "test/a.test.ts": "test-2" }
    }), "correction-opened");
    assert.deepEqual(state.performanceReviewCheckpoint("run-1"), {
      workingTreeDigest: "f".repeat(64),
      attempt: 2,
      activityObserved: true,
      reviewSatisfied: false,
      inspectionCalls: 0,
      shellInspectionCalls: 1,
      expectedPaths: ["src/a.ts", "test/a.test.ts"],
      reviewedPaths: ["src/a.ts", "test/a.test.ts"],
      mutationObserved: true,
      revision: 2,
      successfulMutationCalls: 2,
      successfulMutationsInRevision: 0,
      mutatedPaths: ["src/a.ts", "test/a.test.ts"],
      verifierCalls: 1,
      verifierCallsInRevision: 0,
      verifierState: "correction-required",
      transientRetryUsed: false,
      invalidated: false
    });
    assert.equal(state.reserveAuthorizedModelMutation(
      mutationIdentity,
      "new-test-write",
      {},
      ["test/new.test.ts"],
      { expectedContentDigests: { "test/new.test.ts": ["content-digest"] }, preContentDigests: {}, fullContentPaths: ["test/new.test.ts"], replacePaths: [] }
    ), true);
    assert.deepEqual(state.completeAuthorizedModelMutation(
      mutationIdentity,
      "new-test-write",
      true,
      { "test/new.test.ts": "digest-1" },
      { "test/new.test.ts": "content-digest" }
    ), {
      changedPaths: ["test/new.test.ts"],
      recordedDigests: { "test/new.test.ts": "digest-1" }
    });
    assert.deepEqual(state.successfulModelMutationDigests(mutationIdentity, { "test/new.test.ts": "digest-1" }), {
      "test/new.test.ts": "digest-1"
    });
    assert.deepEqual(state.successfulModelMutationDigests(mutationIdentity, { "test/new.test.ts": "out-of-band-digest" }), {}, "later out-of-band mutation invalidates authored evidence");
    assert.equal(state.reserveAuthorizedModelMutation(
      mutationIdentity,
      "racing-write",
      {},
      ["test/race.test.ts"],
      { expectedContentDigests: { "test/race.test.ts": ["model-content"] }, preContentDigests: {}, fullContentPaths: ["test/race.test.ts"], replacePaths: [] }
    ), true);
    assert.deepEqual(state.completeAuthorizedModelMutation(
      mutationIdentity,
      "racing-write",
      true,
      { "test/race.test.ts": "working-tree-digest" },
      { "test/race.test.ts": "out-of-band-content" }
    ).recordedDigests, {}, "a same-target race cannot forge model-authored provenance");

    state.rememberRecoveryHistory({ taskId: "TASK-1", taskRunId: "run-1", action: "retry", reason: "legacy", recordedAt: "2026-08-09T00:00:00.000Z" });
    state.rememberResumeState({ taskId: "TASK-1", taskRunId: "run-1", enforcementSafe: true, decision: "retry", reason: "legacy" });
    assert.equal(state.takeResumeContextState(first, "run-1")?.decision, "retry");
    assert.equal(state.takeResumeContextState(first, "run-1"), undefined, "resume context is delivered once per process/session/task");
    state.rememberShellMutationSnapshot(first, "bash", { command: "printf x" });
    assert.equal(state.reserveAuthorizedModelMutation(mutationIdentity, "stale-reservation", {}, ["src/stale.ts"], { expectedContentDigests: {}, preContentDigests: {}, fullContentPaths: [], replacePaths: [] }), true);
    state.clearDigestMigrationState(first, "run-1", "TASK-1");
    assert.deepEqual(state.recoveryHistory("TASK-1"), []);
    assert.equal(state.resumeState("run-1"), undefined);
    assert.equal(state.performanceReviewCheckpoint("run-1"), undefined);
    assert.equal(state.performanceReviewCredit("run-1"), undefined);
    assert.deepEqual(state.completeAuthorizedModelMutation(mutationIdentity, "stale-reservation", true, { "src/stale.ts": "digest" }), { changedPaths: [], recordedDigests: {} });
    assert.equal(state.consumeShellMutationSnapshot(first, "bash", { command: "printf x" }), undefined);

    state.clearSession(first);
    assert.equal(state.taskIdentity(first), undefined);
    assert.deepEqual(state.observedContext(first), []);
    assert.equal(state.hasAdvisedTool(first, "bash"), false);
    assert.equal(state.injectedContextPack(first, "same-query"), undefined);
    assert.equal(state.performanceReviewCheckpoint("run-1"), undefined);
    assert.equal(state.performanceReviewCredit("run-1"), undefined);
  });

  it("predicts only byte-exact edit and apply-patch update post-images", () => {
    const cwd = temporaryProject();
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    const file = "test/authored.test.js";
    fs.writeFileSync(path.join(cwd, file), "alpha\nbeta\n");
    const edit = expectedModelMutationProof(cwd, "edit", {
      path: file,
      edits: [{ oldText: "beta", newText: "gamma" }]
    }, [file]);
    assert.deepEqual(edit.replacePaths, [file]);
    assert.ok(edit.preContentDigests[file]);
    fs.writeFileSync(path.join(cwd, file), "alpha\ngamma\n");
    assert.ok(edit.expectedContentDigests[file].includes(currentFileContentDigests(cwd, [file])[file]));

    fs.writeFileSync(path.join(cwd, file), "alpha\nbeta\n");
    const update = expectedModelMutationProof(cwd, "apply_patch", {
      patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n alpha\n-beta\n+gamma\n*** End Patch`
    }, [file]);
    fs.writeFileSync(path.join(cwd, file), "alpha\ngamma\n");
    assert.deepEqual(update.replacePaths, [file]);
    assert.ok(update.expectedContentDigests[file].includes(currentFileContentDigests(cwd, [file])[file]));

    fs.writeFileSync(path.join(cwd, file), "same\nsame\n");
    const ambiguous = expectedModelMutationProof(cwd, "edit", {
      path: file,
      edits: [{ oldText: "same", newText: "changed" }]
    }, [file]);
    assert.deepEqual(ambiguous.expectedContentDigests, {});
    assert.deepEqual(ambiguous.replacePaths, [file], "an ambiguous replacement remains an invalidating transaction");
    const contextMismatch = expectedModelMutationProof(cwd, "apply_patch", {
      patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-missing\n+changed\n*** End Patch`
    }, [file]);
    assert.deepEqual(contextMismatch.expectedContentDigests, {});
    assert.deepEqual(contextMismatch.replacePaths, [file]);
  });

  it("rolls model authorship forward only across the bound exact replacement transaction", () => {
    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    const identity = { taskId: "AUTHORED-1", taskRunId: "authored-run", sessionId: "session-a" };
    const fullProof = (file, content) => ({
      expectedContentDigests: { [file]: [content] }, preContentDigests: {}, fullContentPaths: [file], replacePaths: []
    });
    const replaceProof = (file, before, after) => ({
      expectedContentDigests: { [file]: [after] }, preContentDigests: { [file]: before }, fullContentPaths: [], replacePaths: [file]
    });
    const establish = (file, tree, content) => {
      assert.equal(state.reserveAuthorizedModelMutation(identity, `write-${file}`, {}, [file], fullProof(file, content)), true);
      assert.deepEqual(state.completeAuthorizedModelMutation(identity, `write-${file}`, true, { [file]: tree }, { [file]: content }).recordedDigests, { [file]: tree });
    };

    establish("test/exact.js", "tree-1", "content-1");
    assert.equal(state.reserveAuthorizedModelMutation(identity, "exact-edit", { "test/exact.js": "tree-1" }, ["test/exact.js"], replaceProof("test/exact.js", "content-1", "content-2")), true);
    assert.deepEqual(state.completeAuthorizedModelMutation(identity, "wrong-call", true, { "test/exact.js": "tree-2" }, { "test/exact.js": "content-2" }), { changedPaths: [], recordedDigests: {} });
    assert.deepEqual(state.completeAuthorizedModelMutation(identity, "exact-edit", true, { "test/exact.js": "tree-2" }, { "test/exact.js": "content-2" }).recordedDigests, { "test/exact.js": "tree-2" });

    establish("test/cross-session.js", "session-tree-1", "session-content-1");
    assert.equal(state.reserveAuthorizedModelMutation(identity, "cross-session", { "test/cross-session.js": "session-tree-1" }, ["test/cross-session.js"], replaceProof("test/cross-session.js", "session-content-1", "session-content-2")), true);
    const otherSession = { ...identity, sessionId: "session-b" };
    assert.deepEqual(state.completeAuthorizedModelMutation(otherSession, "cross-session", true, { "test/cross-session.js": "session-tree-2" }, { "test/cross-session.js": "session-content-2" }).recordedDigests, {});
    assert.deepEqual(state.successfulModelMutationDigests(identity, { "test/cross-session.js": "session-tree-2" }), {});

    for (const [suffix, success, postTree, postContent, proof] of [
      ["failed", false, "failed-tree-1", "failed-content-1", replaceProof("test/failed.js", "failed-content-1", "failed-content-2")],
      ["noop", true, "noop-tree-1", "noop-content-1", replaceProof("test/noop.js", "noop-content-1", "noop-content-2")],
      ["ambiguous", true, "ambiguous-tree-2", "ambiguous-content-2", { expectedContentDigests: {}, preContentDigests: { "test/ambiguous.js": "ambiguous-content-1" }, fullContentPaths: [], replacePaths: ["test/ambiguous.js"] }],
      ["race", true, "race-tree-2", "external-content", replaceProof("test/race.js", "race-content-1", "race-content-2")]
    ]) {
      const file = `test/${suffix}.js`, beforeTree = `${suffix}-tree-1`, beforeContent = `${suffix}-content-1`;
      establish(file, beforeTree, beforeContent);
      assert.equal(state.reserveAuthorizedModelMutation(identity, `${suffix}-edit`, { [file]: beforeTree }, [file], proof), true);
      state.completeAuthorizedModelMutation(identity, `${suffix}-edit`, success, { [file]: postTree }, { [file]: postContent });
      assert.deepEqual(state.successfulModelMutationDigests(identity, { [file]: postTree }), {}, `${suffix} must clear authorship`);
    }
  });

  it("hands off failed or no-op review mutations and charges only successful tree changes", () => {
    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const before = { "src/order.js": "source-1", "test/order.test.js": "test-1" };
    for (const [toolCallId, success] of [["refused-edit", false], ["no-op-edit", true]]) {
      const taskRunId = `${toolCallId}-run`;
      state.rememberPerformanceReviewCheckpoint(taskRunId, digestA, 1, ["src/order.js"], ["src/order.js"]);
      state.rememberPerformanceReviewCredit(taskRunId, {
        workingTreeDigest: digestA, commandHash: "c".repeat(64), reviewedPaths: ["src/order.js"], recordedAt: "2026-08-11T00:00:00.000Z"
      });
      assert.equal(state.reservePerformanceReviewTool(taskRunId, {
        toolCallId,
        kind: "mutation",
        toolName: "edit",
        workingTreeDigest: digestA,
        workingTreeSnapshot: before,
        targetPaths: ["src/order.js"]
      }), true);
      assert.equal(state.completePerformanceReviewTool(taskRunId, toolCallId, {
        success,
        postWorkingTreeDigest: digestA,
        postWorkingTreeSnapshot: before
      }), "locked");
      assert.equal(state.performanceReviewCheckpoint(taskRunId).reviewSatisfied, false);
      assert.equal(state.performanceReviewCheckpoint(taskRunId).verifierState, "locked");
      assert.equal(state.performanceReviewCredit(taskRunId), undefined, "failed/no-op review mutation must not retain completion credit");
    }

    state.rememberPerformanceReviewCheckpoint("denied-run", digestA, 1, ["src/order.js"], ["src/order.js"]);
    state.rememberPerformanceReviewCredit("denied-run", {
      workingTreeDigest: digestA, commandHash: "d".repeat(64), reviewedPaths: ["src/order.js"], recordedAt: "2026-08-11T00:00:00.000Z"
    });
    state.denyPerformanceReviewTool("denied-run");
    assert.equal(state.performanceReviewCheckpoint("denied-run").activityObserved, true);
    assert.equal(state.performanceReviewCheckpoint("denied-run").invalidated, true);
    assert.equal(state.performanceReviewCheckpoint("denied-run").verifierState, "locked");
    assert.equal(state.performanceReviewCredit("denied-run"), undefined);

    state.rememberPerformanceReviewCheckpoint(
      "repair-run",
      digestA,
      1,
      ["src/order.js", "test/order.test.js"],
      ["src/order.js", "test/order.test.js"]
    );
    assert.equal(state.performanceReviewCheckpoint("repair-run").successfulMutationCalls, 0);
    assert.equal(state.performanceReviewCheckpoint("repair-run").revision, 0);

    assert.equal(state.reservePerformanceReviewTool("repair-run", {
      toolCallId: "real-edit",
      kind: "mutation",
      toolName: "edit",
      workingTreeDigest: digestA,
      workingTreeSnapshot: before,
      targetPaths: ["src/order.js"]
    }), true);
    assert.equal(state.completePerformanceReviewTool("repair-run", "real-edit", {
      success: true,
      postWorkingTreeDigest: digestB,
      postWorkingTreeSnapshot: { ...before, "src/order.js": "source-2" }
    }), "recorded");
    assert.equal(state.performanceReviewCheckpoint("repair-run").successfulMutationCalls, 1);

    state.rememberPerformanceReviewCheckpoint("race-run", digestA, 1, ["src/order.js"], ["src/order.js"]);
    assert.equal(state.reservePerformanceReviewTool("race-run", {
      toolCallId: "review-read",
      kind: "inspection",
      toolName: "read",
      workingTreeDigest: digestA,
      workingTreeSnapshot: before,
      targetPaths: []
    }), true);
    assert.equal(state.completePerformanceReviewTool("race-run", "review-read", {
      success: true,
      postWorkingTreeDigest: digestB,
      postWorkingTreeSnapshot: { ...before, "src/order.js": "out-of-band" }
    }), "invalidated");
    assert.equal(state.performanceReviewCheckpoint("race-run").invalidated, true);
  });

  it("binds semantic credit to the exact current baseline delta", () => {
    assert.deepEqual(taskDeltaFilesFromSnapshot(
      { baselineFileDigests: { "src/restored.js": "dirty-at-start", "src/same.js": "same" } },
      { "src/new.js": "new", "src/same.js": "same" }
    ), ["src/new.js", "src/restored.js"]);

    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    const digest = "a".repeat(64);
    state.rememberPerformanceReviewCheckpoint("exact-run", digest, 1, ["src/a.js", "src/b.js"]);
    state.rememberPerformanceReviewCredit("exact-run", {
      workingTreeDigest: digest,
      commandHash: "b".repeat(64),
      reviewedPaths: ["src/a.js"],
      recordedAt: "2026-08-10T00:00:00.000Z"
    });
    assert.equal(state.performanceReviewCheckpoint("exact-run").reviewSatisfied, false);
  });

  it("passes one immutable post-event tree observation to every tool-result consumer", async () => {
    const cwd = temporaryProject();
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "event.ts"), "export const value = 0;\n");
    execFileSync("git", ["-C", cwd, "add", "."]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
    fs.writeFileSync(path.join(cwd, "src", "event.ts"), "export const value = 1;\n");
    const preSnapshot = workingTreeSnapshot(cwd);
    const handlers = new Map();
    const observations = [];
    const semanticDigests = [];
    const downstreamSnapshots = [];
    const task = {
      taskId: "TREE-EVENT", taskRunId: "tree-event-run", sessionId: "session-1",
      trace: { outcome: "pending" }, baselineFileDigests: preSnapshot
    };
    const state = {
      taskIdentity: () => ({ taskId: task.taskId, taskRunId: task.taskRunId }),
      observedContext: () => [], consumeShellMutationSnapshot: () => preSnapshot,
      completeAuthorizedModelMutationEvidence: (_identity, _call, _success, snapshot) => {
        downstreamSnapshots.push(snapshot); return { changedPaths: [], recordedDigests: {}, beforeSnapshot: null,
          targetPaths: [], recordedContentDigests: {}, proofModes: {} };
      },
      invalidateSuccessfulModelMutationPaths() {},
      completePerformanceReviewTool: (_run, _call, result) => {
        downstreamSnapshots.push(result.postWorkingTreeSnapshot); return "unmatched";
      },
      performanceReviewCheckpoint: () => undefined, performanceReviewCredit: () => undefined,
      successfulModelMutationDigests: () => ({}), invalidatePerformanceReviewCredit() {}, rememberPerformanceReviewCredit() {},
      previousToolResult: () => undefined, rememberToolResult() {}
    };
    const pi = { on: (name, handler) => handlers.set(name, handler) };
    const ctx = { ...extensionContext(cwd), ui: { notify() {} } };
    registerToolResultHook(pi, {
      state, activeTask: () => task, maxManifestFiles: 10, readProtectedPaths: () => [],
      recordObservedBash() {}, observedBashLedgerPath: () => "", redactText: (value) => value,
      observedTaskContext: () => undefined,
      recordObservedTaskChanges: (_pi, _ctx, _event, _pending, _maximum, _before, eventTree) => {
        observations.push(eventTree);
        fs.writeFileSync(path.join(cwd, "src", "event.ts"), "export const value = 2;\n");
      },
      recordObservedTaskVerification: (_pi, _ctx, _event, _pending, _maximum, _before, eventTree) => observations.push(eventTree),
      extractLikelyPath: () => undefined, mutationTargets: () => [], isShellTool: () => true,
      telemetry() {}, now: () => "2026-08-10T00:00:00.000Z",
      completeSemanticRepair: (_ctx, _event, metadata) => { semanticDigests.push(metadata.currentWorkingTreeDigest); }
    });

    await handlers.get("tool_result")({
      toolName: "bash", input: { command: "npm test" }, content: [], details: { exitCode: 0 },
      isError: false, timestamp: Date.parse("2026-08-10T00:00:00.000Z")
    }, ctx);

    assert.equal(observations.length, 2);
    assert.equal(observations[0], observations[1], "mutation and verifier consumers receive the same observation object");
    assert.equal(observations[0].digest, workingTreeEvidenceDigest(observations[0].snapshot));
    assert.deepEqual(downstreamSnapshots, [observations[0].snapshot, observations[0].snapshot], "authorship and review reuse the same post-event snapshot");
    assert.deepEqual(semanticDigests, [observations[0].digest]);
    assert.notEqual(workingTreeEvidenceDigest(workingTreeSnapshot(cwd)), observations[0].digest, "a later mutation belongs to the next event, not this one");
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
    assert.equal(
      automaticTaskIntakeMode("Repair src/data/migration.js. Do not mutate input or change the exported API.", []),
      "source-change"
    );
    assert.equal(
      automaticTaskIntakeMode("Investigate logs/incident.log as a read-only task. Do not edit any file.", []),
      "read-only"
    );
    assert.equal(
      automaticTaskIntakeMode("Run all tests, typecheck, and npm pack --dry-run. Do not edit source files.", []),
      "source-change"
    );
    assert.equal(
      automaticTaskIntakeMode("Create an execution task limited to test/build/package dry-run. Do not edit source.", []),
      "source-change"
    );
    assert.equal(
      automaticTaskIntakeMode("Chay release gate va package dry-run tren working tree hien tai. Khong sua source.", []),
      "source-change"
    );
    assert.deepEqual(
      automaticTaskScope("Fix src/cart.ts and tests", [{ path: "src/helper.ts" }]),
      ["src/cart.ts", "src/helper.ts", "test/**", "tests/**", "spec/**", "__tests__/**"]
    );
    assert.deepEqual(
      automaticTaskScope("Fix src/cart.ts quantity calculation", []),
      ["src/cart.ts", "test/**", "tests/**", "spec/**", "__tests__/**"]
    );
    assert.deepEqual(
      automaticTaskScope("Repair src/backend/invoice.js and reject negative/non-integer inputs", []),
      ["src/backend/invoice.js", "test/**", "tests/**", "spec/**", "__tests__/**"]
    );
    const longContract = `${"Repair src/backend/invoice.js. ".repeat(16)}Reject invalid inputs with TypeError.`;
    assert.ok(automaticTaskSummary(longContract).length > 320);
    assert.ok(automaticTaskSummary(longContract).length <= 700);
    assert.match(automaticTaskSummary(longContract), /TypeError\.$/);
    assert.deepEqual(automaticReviewLenses("Fix auth session validation"), ["correctness", "tests", "scope", "security"]);
    assert.equal(validTaskScopePattern("src/**"), true);
    assert.equal(validTaskScopePattern("../outside/**"), false);
  });

  it("preserves final capability obligations from the full prompt beyond the display summary", () => {
    const cases = [
      ["concurrent-lease-lifecycle.md", /cleanup must not delete a lease that changed owner after expiry/],
      ["fullstack-search-contract.md", /Empty results return `<ul aria-label="Search results"><\/ul>`/],
      ["multi-package-rollout.md", /`rolloutSummary`.*`enabled=<true\|false>; percentage=<n>; tenants=<comma-separated tenants>`/],
      ["resumable-migration-runner.md", /does not rerun earlier completed steps/]
    ];
    for (const [file, finalObligation] of cases) {
      const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts", file), "utf8");
      const summary = automaticTaskSummary(prompt);
      const criteria = automaticAcceptanceCriteria(prompt);
      assert.ok(prompt.length > summary.length, file);
      assert.equal(summary.length, 700, file);
      assert.match(criteria.join("\n"), finalObligation, file);
      assert.ok(criteria.length <= 12, file);
    }
    const migrationPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts/resumable-migration-runner.md"), "utf8");
    const migrationCriteria = automaticAcceptanceCriteria(migrationPrompt);
    const expectedM3 = migrationPrompt.match(/^- \[M3\][\s\S]*?(?=\n- \[M4\])/m)[0]
      .replace(/^- /, "").replace(/\s+/g, " ").trim();
    const m3Fragments = migrationCriteria.filter((criterion) => criterion.startsWith("[M3] "));
    const reconstructedM3 = `[M3] ${m3Fragments.map((criterion) => criterion.replace(/^\[M3\]\s+/, "")).join(" ")}`;
    assert.equal(reconstructedM3, expectedM3);
    assert.deepEqual(
      migrationCriteria.flatMap((criterion) => criterion.match(/^\[M\d+\]/) ?? []),
      ["[M1]", "[M2]", "[M3]", "[M3]", "[M4]"]
    );
    assert.ok(migrationCriteria.every((criterion) => criterion.length <= 600));
    assert.match(reconstructedM3, /Do not require array, object, or function identity.*same loaded module instance\.$/);
    const rolloutPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts/multi-package-rollout.md"), "utf8");
    assert.doesNotMatch(automaticTaskSummary(rolloutPrompt), /rolloutSummary/);
  });

  it("joins wrapped prose obligations before deriving acceptance criteria", () => {
    const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/production-v1/prompts/tenant-role-authorization.md"), "utf8");
    const criteria = automaticAcceptanceCriteria(prompt);
    const authorization = criteria.find((criterion) => criterion.includes("canManage(user, resource)"));
    assert.equal(authorization, "`canManage(user, resource)` may return true only when the user is active, has role `owner` or `admin`, and `user.tenantId` and `resource.tenantId` are the same non-empty string. Missing input must be denied. Keep the change focused and run the project verification commands.");
    assert.equal(criteria.some((criterion) => criterion === "resource. Missing input must be denied. Keep the change focused and run the"), false);
    const built = buildAcceptanceReceipt({
      summary: automaticTaskSummary(prompt),
      expectedOutput: "The requested bounded change is implemented and passes the configured verification.",
      acceptanceCriteria: criteria,
      changeMode: "source-change",
      source: "runtime"
    });
    assert.equal(built.acceptanceCriteria.some((criterion) => criterion.startsWith("Focused tests prove same-identity allow")), false);
  });

  it("derives exact capability source scope and resolves basename ambiguity deterministically", () => {
    const manifest = [
      "packages/migration/src/plan.js",
      "packages/migration/src/runner.js",
      "packages/lease/src/store.js",
      "packages/lease/src/with-lease.js",
      "packages/shared/src/search-contract.js",
      "services/catalog/src/search.js",
      "apps/web/src/search-view.js",
      "packages/policy/src/rollout.js",
      "packages/api/src/feature-access.js",
      "apps/admin/src/rollout-view.js",
      "test/smoke.test.js",
      "README.md"
    ];
    const cases = [
      ["resumable-migration-runner.md", [
        "packages/migration/src/plan.js",
        "packages/migration/src/runner.js"
      ]],
      ["concurrent-lease-lifecycle.md", [
        "packages/lease/src/store.js",
        "packages/lease/src/with-lease.js"
      ]],
      ["fullstack-search-contract.md", [
        "packages/shared/src/search-contract.js",
        "services/catalog/src/search.js",
        "apps/web/src/search-view.js"
      ]],
      ["multi-package-rollout.md", [
        "packages/policy/src/rollout.js",
        "packages/api/src/feature-access.js",
        "apps/admin/src/rollout-view.js"
      ]]
    ];
    const testScope = ["test/**", "tests/**", "spec/**", "__tests__/**"];
    for (const [file, expectedSource] of cases) {
      const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts", file), "utf8");
      const scope = automaticTaskScope(prompt, [], manifest);
      assert.deepEqual(scope, [...expectedSource, ...testScope], file);
    }

    const rolloutPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts/multi-package-rollout.md"), "utf8");
    const rolloutScope = automaticTaskScope(rolloutPrompt, [], manifest);
    assert.equal(rolloutScope.includes("subject.tenantId"), false);
    assert.equal(rolloutScope.includes("subject.bucket"), false);

    const unique = resolveTaskScopePatterns(["plan.js", "test/**"], manifest);
    assert.deepEqual(unique.scope, ["packages/migration/src/plan.js", "test/**"]);
    assert.deepEqual(unique.mappings, [{ from: "plan.js", to: "packages/migration/src/plan.js" }]);
    assert.deepEqual(unique.ambiguous, []);
    assert.deepEqual(unique.unmatched, []);

    const ambiguous = resolveTaskScopePatterns(["plan.js"], [...manifest, "apps/admin/src/plan.js"]);
    assert.deepEqual(ambiguous.scope, []);
    assert.deepEqual(ambiguous.mappings, []);
    assert.deepEqual(ambiguous.unmatched, []);
    assert.deepEqual(ambiguous.ambiguous, [{
      input: "plan.js",
      candidates: ["packages/migration/src/plan.js", "apps/admin/src/plan.js"]
    }]);

    const unmatched = resolveTaskScopePatterns(["catalog-service/**", "new-file.js", "src/new-file.js"], manifest);
    assert.deepEqual(unmatched.scope, ["src/new-file.js"]);
    assert.deepEqual(unmatched.unmatched, ["catalog-service/**", "new-file.js"]);
  });

  it("reserves semantic continuation for contracts not covered by deterministic acceptance evidence", () => {
    const plan = analyzePerformanceAssurance({
      request: "Repair `invoiceTotalCents(lines, taxBps)`. Round each line and tax once. Reject invalid integer inputs with TypeError and preserve the exported API.",
      changeMode: "source-change"
    });
    assert.equal(plan.tier, "rigorous");
    assert.equal(plan.requiresReview, false);
    assert.ok(plan.reasonCodes.includes("exact-error-contract"));
    assert.ok(plan.reviewChecks.some((item) => /RangeError and TypeError/.test(item)));

    const graphPlan = analyzePerformanceAssurance({
      request: "Fix dependency order, preserve stable input order, reject cycles, and do not mutate input.",
      changeMode: "source-change"
    });
    assert.equal(graphPlan.requiresReview, true);

    const guidance = performanceReviewGuidance({
      summary: "Fix dependency order, preserve stable input order, reject cycles, and do not mutate input.",
      expectedOutput: "Return the existing public representation.",
      acceptanceCriteria: [],
      changeMode: "source-change",
      changedFiles: ["src/platform/workspace.js"],
      observedChangedFiles: ["test/workspace.test.js"]
    });
    assert.ok(guidance.some((item) => /returned element representation/.test(item)));
    assert.ok(guidance.some((item) => /src\/platform\/workspace\.js/.test(item)));
    assert.ok(guidance.some((item) => /one bounded git diff/.test(item)));

    const changedFiles = ["packages/migration/src/plan.js", "packages/migration/src/runner.js", "test/migration.test.js"];
    const completeDiffOutput = changedFiles
      .map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}`)
      .join("\n");
    assert.deepEqual(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js test/migration.test.js && git status --short" },
      changedFiles,
      outputText: completeDiffOutput
    }), {
      command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js test/migration.test.js && git status --short",
      reviewedPaths: changedFiles
    });
    assert.deepEqual(boundedGitDiffReview({
      toolName: "shell",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src test/migration.test.js && git status --short" },
      changedFiles,
      outputText: completeDiffOutput
    })?.reviewedPaths, changedFiles, "broad pathspecs are narrowed to the exact evidenced task delta");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js && npm test" },
      changedFiles,
      outputText: completeDiffOutput
    }), undefined, "an arbitrary chained command cannot earn review credit");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js && git status --short" },
      changedFiles,
      outputText: completeDiffOutput
    }), undefined, "the diff must cover every observed change");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff -- ." },
      changedFiles,
      outputText: completeDiffOutput
    }), undefined, "working-tree-only diff cannot hide staged hunks");
    const statusOnlyUntrackedOutput = completeDiffOutput.replace(
      "diff --git a/test/migration.test.js b/test/migration.test.js\n--- a/test/migration.test.js\n+++ b/test/migration.test.js",
      "?? test/migration.test.js"
    );
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js test/migration.test.js && git status --short --untracked-files=all" },
      changedFiles,
      outputText: statusOnlyUntrackedOutput
    }), undefined, "unknown status-only untracked evidence stays fail-closed");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js test/migration.test.js && git status --short --untracked-files=all" },
      changedFiles,
      outputText: statusOnlyUntrackedOutput,
      authoredFileDigests: { "test/migration.test.js": "model-write-digest" },
      currentFileDigests: { "test/migration.test.js": "model-write-digest" }
    }), undefined, "a current authored digest cannot turn status-only inventory into semantic review");
    const noIndexCommand = "git diff --no-ext-diff HEAD -- packages/migration/src/plan.js packages/migration/src/runner.js test/migration.test.js && git status --short --untracked-files=all && ! git diff --no-index -- /dev/null test/migration.test.js";
    const noIndexOutput = `${statusOnlyUntrackedOutput}\ndiff --git a/test/migration.test.js b/test/migration.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/test/migration.test.js\n@@ -0,0 +1 @@\n+test`;
    assert.deepEqual(boundedGitDiffReview({
      toolName: "bash",
      input: { command: noIndexCommand },
      changedFiles,
      outputText: noIndexOutput,
      authoredFileDigests: { "test/migration.test.js": "model-write-digest" },
      currentFileDigests: { "test/migration.test.js": "model-write-digest" }
    })?.reviewedPaths, changedFiles, "an exact current no-index content proof completes untracked evidence");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: noIndexCommand },
      changedFiles,
      outputText: noIndexOutput,
      authoredFileDigests: { "test/migration.test.js": "model-write-digest" },
      currentFileDigests: { "test/migration.test.js": "later-out-of-band-digest" }
    }), undefined, "later mutation invalidates no-index authored evidence");
    assert.equal(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- packages/migration/src test/migration.test.js && git status --short" },
      changedFiles,
      outputText: `${completeDiffOutput}\ndiff --git a/packages/migration/src/unexpected.js b/packages/migration/src/unexpected.js`
    }), undefined, "patch evidence for a task-delta outsider is rejected");
    const largeTwoFileDiff = [
      "diff --git a/src/a.js b/src/a.js",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      `+${"a".repeat(21_000)}`,
      "diff --git a/src/b.js b/src/b.js",
      "--- a/src/b.js",
      "+++ b/src/b.js"
    ].join("\n");
    const capturedLargeDiff = boundedPerformanceReviewResultText([{ type: "text", text: largeTwoFileDiff }]);
    assert.ok(capturedLargeDiff && capturedLargeDiff.length > 20_000);
    assert.deepEqual(boundedGitDiffReview({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- src/a.js src/b.js && git status --short" },
      changedFiles: ["src/a.js", "src/b.js"],
      outputText: capturedLargeDiff
    })?.reviewedPaths, ["src/a.js", "src/b.js"], "a valid multi-file diff beyond the old output tail keeps every header");
    assert.equal(
      boundedPerformanceReviewResultText([{ type: "text", text: "x".repeat(2 * 1024 * 1024 + 1) }]),
      undefined,
      "unbounded review output remains fail-closed"
    );

    const pendingReview = {
      workingTreeDigest: "a".repeat(64),
      attempt: 1,
      activityObserved: false,
      reviewSatisfied: false,
      inspectionCalls: 0,
      shellInspectionCalls: 0,
      expectedPaths: ["src/platform/workspace.js", "test/workspace.test.js"],
      reviewedPaths: [],
      mutationObserved: false,
      revision: 0,
      successfulMutationCalls: 0,
      successfulMutationsInRevision: 0,
      mutatedPaths: [],
      verifierCalls: 0,
      verifierCallsInRevision: 0,
      verifierState: "not-required",
      transientRetryUsed: false,
      invalidated: false
    };
    assert.equal(performanceReviewToolDecision({
      toolName: "bash",
      input: { command: "git diff --no-ext-diff HEAD -- src/platform/workspace.js test/workspace.test.js && git status --short" },
      checkpoint: pendingReview,
      task: { verifyCommands: ["npm test"] }
    }), undefined);
    assert.match(performanceReviewToolDecision({
      toolName: "bash",
      input: { command: "npm test" },
      checkpoint: pendingReview,
      task: { verifyCommands: ["npm test"] }
    }).reason, /no verifier or ad-hoc probe/);
    assert.match(performanceReviewToolDecision({
      toolName: "read",
      checkpoint: { ...pendingReview, inspectionCalls: 2 },
      task: { verifyCommands: ["npm test"] }
    }).reason, /read budget is complete/);
    assert.equal(performanceReviewToolDecision({
      toolName: "read",
      checkpoint: { ...pendingReview, inspectionCalls: 1 },
      task: { verifyCommands: ["npm test"] }
    }), undefined, "the second and final targeted read remains available");

    const reviewed = {
      ...pendingReview,
      activityObserved: true,
      reviewSatisfied: true,
      shellInspectionCalls: 1,
      expectedPaths: ["src/platform/workspace.js", "test/workspace.test.js"],
      reviewedPaths: ["src/platform/workspace.js", "test/workspace.test.js"]
    };
    assert.equal(performanceReviewToolDecision({
      toolName: "write",
      input: { path: "src/platform/workspace.js" },
      checkpoint: reviewed,
      currentPhase: "repair",
      targetPaths: ["src/platform/workspace.js"],
      task: { verifyCommands: ["npm test"] }
    }), undefined);
    assert.match(performanceReviewToolDecision({
      toolName: "write",
      input: { path: "src/platform/unreviewed.js" },
      checkpoint: reviewed,
      currentPhase: "repair",
      targetPaths: ["src/platform/unreviewed.js"],
      task: { verifyCommands: ["npm test"] }
    }).reason, /exact paths/, "a reviewed directory sibling cannot be mutated");

    const afterSourceMutation = {
      ...reviewed,
      workingTreeDigest: "b".repeat(64),
      reviewSatisfied: false,
      mutationObserved: true,
      revision: 1,
      successfulMutationCalls: 1,
      successfulMutationsInRevision: 1,
      mutatedPaths: ["src/platform/workspace.js"],
      verifierState: "required"
    };
    assert.equal(performanceReviewToolDecision({
      toolName: "write",
      input: { path: "test/workspace.test.js" },
      checkpoint: afterSourceMutation,
      currentPhase: "repair",
      targetPaths: ["test/workspace.test.js"],
      task: { verifyCommands: ["npm test"] }
    }), undefined, "one semantic revision may coordinate a source edit and its matching test edit");
    assert.equal(performanceReviewToolDecision({
      toolName: "bash",
      input: { command: "npm test" },
      checkpoint: afterSourceMutation,
      currentPhase: "repair",
      task: { verifyCommands: ["npm test"] }
    }), undefined);
    assert.match(performanceReviewToolDecision({
      toolName: "bash",
      input: { command: "npm test" },
      checkpoint: { ...afterSourceMutation, verifierCallsInRevision: 1 },
      currentPhase: "repair",
      task: { verifyCommands: ["npm test"] }
    }).reason, /repeated verification is not permitted/);
    assert.equal(performanceReviewToolDecision({
      toolName: "write",
      input: { path: "test/workspace.test.js" },
      checkpoint: {
        ...afterSourceMutation,
        revision: 2,
        successfulMutationsInRevision: 0,
        verifierCallsInRevision: 0,
        verifierState: "correction-required"
      },
      currentPhase: "repair",
      targetPaths: ["test/workspace.test.js"],
      task: { verifyCommands: ["npm test"] }
    }), undefined, "a high-confidence failed verifier may open one evidence-backed correction");
    assert.match(performanceReviewToolDecision({
      toolName: "write",
      input: { path: "test/workspace.test.js" },
      checkpoint: { ...afterSourceMutation, verifierState: "passed" },
      currentPhase: "repair",
      targetPaths: ["test/workspace.test.js"],
      task: { verifyCommands: ["npm test"] }
    }).reason, /closed for this revision/);
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

  it("redacts a tool result before it is compacted, so no secret reaches the capture file", () => {
    // The hook redacts and then compacts, and that order is the only thing
    // keeping a secret out of the capture written to disk: compaction copies the
    // text it is given. Nothing pinned the order, so reversing the two calls
    // would have written credentials into project state and passed every test.
    const cwd = temporaryProject();
    const ctx = extensionContext(cwd);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const raw = [{ type: "text", text: `header\n${secret}\n${"z".repeat(20_000)}` }];
    const redacted = raw.map((block) => {
      const safe = redactSensitiveText(block.text);
      return safe.redacted ? { ...block, text: safe.text } : block;
    });
    assert.equal(JSON.stringify(redacted).includes(secret), false, "redaction must remove the credential first");

    const result = compactToolResultTextContent(cwd, { toolName: "bash", input: {} }, ctx, redacted, new Map());
    assert.equal(result.captures.length, 1);
    assert.equal(JSON.stringify(result.content).includes(secret), false, "the preview must not carry the credential");
    const capture = fs.readFileSync(path.join(cwd, result.captures[0].path), "utf8");
    assert.equal(capture.includes(secret), false, "the capture written to project state must not carry the credential");
    // The capture is still the real output, not an empty file.
    assert.ok(capture.length > 1_000);
  });

  it("stores long intake and compacted tool output under private project state", () => {
    const cwd = temporaryProject();
    const command = buildFreshCommand(cwd, "task", "A".repeat(8_100), "Start clean.");
    const intake = command.match(/from (\.pi\/task-inbox\/[^.]+\.md)/)?.[1];
    assert.ok(intake, command);
    assert.match(command, /^\/fresh task --session-title "A{64}" Read task intake from /);
    assert.deepEqual(freshRequestParts(command.replace(/^\/fresh task /, "")), {
      request: `Read task intake from ${intake}. Start clean.`, sessionTitle: "A".repeat(64)
    });
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

  it("compacts aggregate many-block content and details into one bounded file-backed preview", () => {
    const cwd = temporaryProject();
    const ctx = extensionContext(cwd);
    const event = { toolName: "bash", input: { command: "diagnostic" }, details: { exitCode: 0 } };
    const content = Array.from({ length: 400 }, (_item, index) => ({
      type: "text",
      text: `block-${index} ${"x".repeat(80)}`
    }));
    const compactedContent = compactToolResultTextContent(cwd, event, ctx, content, new Map());
    assert.equal(compactedContent.captures.length, 1);
    assert.equal(compactedContent.content.length, 1);
    assert.ok(compactedContent.content[0].text.length <= TOOL_RESULT_PREVIEW_MAX_CHARS);
    assert.match(compactedContent.content[0].text, /400 blocks/);
    assert.match(fs.readFileSync(path.join(cwd, compactedContent.captures[0].path), "utf8"), /block-399/);

    const captures = [];
    const details = Array.from({ length: 2_000 }, (_item, index) => ({ sequence: index, text: `detail-${index}-${"y".repeat(20)}` }));
    const compactedDetails = compactToolResultDetails(cwd, event, ctx, details, new Map(), captures);
    assert.equal(captures.length, 1);
    assert.equal(Array.isArray(compactedDetails), true);
    assert.ok(compactedDetails[0].piagentCompactedDetails.length <= TOOL_RESULT_PREVIEW_MAX_CHARS);
    assert.match(fs.readFileSync(path.join(cwd, captures[0].path), "utf8"), /detail-1999/);

    const mixedCaptures = [];
    const mixed = compactToolResultDetails(cwd, event, ctx, {
      stdout: "z".repeat(20_000),
      rows: Array.from({ length: 20_000 }, (_item, index) => index)
    }, new Map(), mixedCaptures);
    assert.equal(mixedCaptures.length, 1);
    assert.equal(typeof mixed.piagentCompactedDetails, "string");
    assert.ok(JSON.stringify(mixed).length < 7_500);
  });
});
