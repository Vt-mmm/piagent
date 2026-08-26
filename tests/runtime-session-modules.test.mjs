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
  looksLikeCompletionClaim,
  looksLikeIncompleteHandoff
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
import { buildAdaptiveContextLedger } from "../packages/piagent-core/runtime/session/adaptive-context-ledger.ts";
import {
  buildSemanticCompactionInstructions,
  compactManagedProjectInstructions,
  rewriteLegacyProjectInstructions,
  semanticCompactionCancelled
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
  automaticTaskMutationPolicy,
  automaticTaskScope,
  boundedRuntimeIntakeMessage,
  resolveTaskScopePatterns,
  validTaskScopePattern
} from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import {
  CONTEXT_GOVERNOR_LEDGER_MAX_CHARS,
  RUNTIME_INTAKE_COMPACT_CHARS,
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
import { stageContextDelivery } from "../packages/piagent-core/runtime/context/context-delivery.ts";
import { registerInputHook } from "../packages/piagent-core/runtime/hooks/input-hook.ts";
import { taskDeltaFilesFromSnapshot } from "../packages/piagent-core/extensions/task-contract-view.js";
import { filterGrepProtectedContent, filterProtectedPathListContent, registerToolResultHook } from "../packages/piagent-core/runtime/hooks/tool-result-hook.ts";
import { operatorRequestDigest, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { estimateContextTokens } from "../packages/piagent-core/extensions/context-engine.js";
import { boundedPerformanceReviewResultText } from "../packages/piagent-core/runtime/quality/performance-review-evidence.ts";
import {
  prefixCompletions,
  piagentToolBatchMode,
  piagentToolExecutionMode,
  registerRuntimeCommand,
  registerRuntimeTool
} from "../packages/piagent-core/runtime/registration/extension-registration.ts";
import { resolveTaskStartRepositoryManifestProvider } from "../packages/piagent-core/runtime/registration/task-start-manifest.ts";
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

function utf8BoundaryCommand(prefix, glyph, maximum = 900) {
  const remaining = maximum - Buffer.byteLength(prefix, "utf8");
  const glyphBytes = Buffer.byteLength(glyph, "utf8");
  const repeated = glyph.repeat(Math.floor(remaining / glyphBytes));
  return `${prefix}${repeated}${"x".repeat(remaining - Buffer.byteLength(repeated, "utf8"))}`;
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
  it("keeps external source checkout grants canonical, bounded, and session-scoped", () => {
    const project = temporaryProject();
    const checkout = temporaryProject();
    fs.mkdirSync(path.join(checkout, ".git"));
    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    const first = extensionContext(project, "source-session-1");
    const second = extensionContext(project, "source-session-2");

    assert.equal(state.grantSourceCheckoutReadRoot(first, checkout), fs.realpathSync.native(checkout));
    assert.deepEqual(state.sourceCheckoutReadRoots(first), [fs.realpathSync.native(checkout)]);
    assert.deepEqual(state.sourceCheckoutReadRoots(second), []);
    state.clearSession(first);
    assert.deepEqual(state.sourceCheckoutReadRoots(first), []);
  });

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
    assert.equal(piagentToolExecutionMode("piagent_source_checkout"), "sequential");
    assert.equal(piagentToolExecutionMode("piagent_context_index_record"), "sequential");
    assert.equal(piagentToolBatchMode(["piagent_context_index_search", "piagent_memory_search"]), "parallel");
    assert.equal(piagentToolBatchMode(["piagent_memory_search", "piagent_memory_note"]), "sequential");
    assert.deepEqual(prefixCompletions(ONBOARDING_COMMAND_ACTIONS, "se"), [{ value: "setup", label: "setup" }]);
    assert.deepEqual(prefixCompletions(FRESH_COMMAND_ACTIONS, "be"), [{ value: "be-to-fe", label: "be-to-fe" }]);
    assert.equal(WORKFLOW_COMMAND_EXCLUSIONS.includes("platform"), true);
  });

  it("uses an auditable fail-safe manifest fallback across task-start registration version skew", () => {
    const legacyCalls = [];
    const repositoryFileManifest = (cwd, maximum) => {
      legacyCalls.push({ cwd, maximum });
      return ["src/b.ts", "src/a.ts", "src/a.ts", null];
    };
    for (const [repositoryFileManifestDetails, compatibilityReason] of [
      [undefined, "missing-details-provider"],
      ["stale-runtime-export", "nonfunction-details-provider"]
    ]) {
      const provider = resolveTaskStartRepositoryManifestProvider({ repositoryFileManifest, repositoryFileManifestDetails });
      assert.deepEqual(provider.read("/workspace", 12), {
        files: ["src/b.ts", "src/a.ts"],
        complete: false,
        candidateCount: 2,
        provider: "legacy-array-fallback",
        compatibilityReason
      });
    }
    assert.deepEqual(legacyCalls, [
      { cwd: "/workspace", maximum: 12 },
      { cwd: "/workspace", maximum: 12 }
    ]);

    const native = resolveTaskStartRepositoryManifestProvider({
      repositoryFileManifest,
      repositoryFileManifestDetails: () => ({ files: ["src/a.ts"], complete: true, candidateCount: 4 })
    }).read("/workspace");
    assert.deepEqual(native, {
      files: ["src/a.ts"], complete: true, candidateCount: 4, provider: "details"
    });
    assert.throws(
      () => resolveTaskStartRepositoryManifestProvider({ repositoryFileManifest: null }),
      /requires repositoryFileManifest to be a function/
    );
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
    assert.equal(looksLikeIncompleteHandoff("Piagent vẫn đang làm và chưa hoàn tất."), true);
    assert.equal(looksLikeIncompleteHandoff("Piagent dang lam."), true);
    assert.equal(looksLikeIncompleteHandoff("Van dang xu ly."), true);
    assert.equal(looksLikeIncompleteHandoff("Các ứng dụng đáng làm cho Piagent"), false);
    assert.equal(looksLikeIncompleteHandoff("Cac ung dung dang lam cho Piagent"), false);
    assert.equal(looksLikeCompletionClaim("Đã hoàn tất đánh giá. Các ứng dụng đáng làm được liệt kê bên dưới."), true);

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
    assert.match(rewritten.systemPrompt, /do not probe that destination with read first/);
    assert.match(rewritten.systemPrompt, /parent model reasons and implements directly/);
    assert.match(rewritten.systemPrompt, /at least 30% projected net token saving/);
    assert.match(rewritten.systemPrompt, /report unresolved risk/);
    assert.doesNotMatch(rewritten.systemPrompt, /legacy steps/);

    const compacted = compactManagedProjectInstructions(
      `prefix\n<!-- piagent-managed:start -->\nlong text\n<!-- piagent-managed:end -->\nsuffix`,
      "automatic"
    );
    assert.equal(compacted.compacted, true);
    assert.match(compacted.systemPrompt, /Root project instructions are already loaded/);
    assert.match(compacted.systemPrompt, /create it without a speculative read/);
    assert.match(compacted.systemPrompt, /Treat current source, the operator request, and the durable Task Contract as authoritative/);
    assert.match(compacted.systemPrompt, /parent reasons and implements directly/);
    assert.match(compacted.systemPrompt, /never delegate writes, inherit parent history, fan out, or retry a deterministic helper failure/);
    assert.match(compacted.systemPrompt, /scope is an initial retrieval\/review focus, not a mutation boundary/);
    assert.doesNotMatch(compacted.systemPrompt, /long text/);
  });

  it("bounds runtime intake and semantic carry-over while preserving contract edges", () => {
    const intake = boundedRuntimeIntakeMessage(`HEAD:${"a".repeat(8_000)}:TAIL`);
    assert.equal(intake.length, RUNTIME_INTAKE_COMPACT_CHARS);
    assert.match(intake, /^HEAD:/);
    assert.match(intake, /complete operator request and durable Task Contract remain authoritative/);
    assert.match(intake, /:TAIL$/);

    const structured = boundedRuntimeIntakeMessage([
      "Piagent runtime task: CONTROL; initial focus (advisory): packages/session/src/runtime-route.js.",
      "The complete operator request above is the authoritative acceptance contract.",
      "Assurance: rigorous (exact-behavior).",
      "Critical behavioral proof:",
      `- [criterion-01:fallback] ${"prove-observable ".repeat(90)}`,
      "Candidate tags require durable live assertions before completion.",
      "Existing public contract:",
      `- ${"optional-baseline ".repeat(180)}`,
      "Exact verifier commands:",
      "Verifier 1 (run as an exact standalone shell command): npm test",
      "Execution map (planning only):",
      ...Array.from({ length: 12 }, (_item, index) => `- criterion-${String(index + 1).padStart(2, "0")} behavior @packages/session/src/runtime-route.js proof=behavioral-check`),
      "Use runtime-delivered source; do not reread it. On edit drift, reread the affected region once.",
      "Root project instructions are loaded.",
      "Follow the execution map and implement dependency-ready criteria."
    ].join("\n"));
    assert.ok(structured.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS, structured.length);
    assert.match(structured, /Critical behavioral proof:/);
    assert.match(structured, /\[criterion-01:fallback\]/);
    assert.match(structured, /Exact verifier commands:\nVerifier 1 .*: npm test/);
    assert.match(structured, /Execution map \(planning only\):/);
    for (let index = 1; index <= 12; index += 1) assert.match(structured, new RegExp(`criterion-${String(index).padStart(2, "0")}`));
    assert.match(structured, /Use runtime-delivered source; do not reread it/);
    assert.match(structured, /Follow the execution map and implement dependency-ready criteria/);

    const withoutCriticalProof = boundedRuntimeIntakeMessage([
      "Piagent runtime task: BASIC.",
      `Optional navigation: ${"src/optional.js ".repeat(300)}`,
      "Exact final-output contract: make BUILD_SHA=<sha> the last non-empty response line. Copy the complete value verbatim from observed project evidence.",
      "Exact verifier commands:",
      "Verifier 1 (run as an exact standalone shell command): npm test",
      "Execution map (planning only):",
      "- criterion-01 verification after=criterion-00",
      "Use runtime-delivered source; do not reread it.",
      "Follow the execution map and implement dependency-ready criteria."
    ].join("\n"));
    assert.ok(withoutCriticalProof.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS, withoutCriticalProof.length);
    assert.match(withoutCriticalProof, /Exact final-output contract: make BUILD_SHA=<sha>/);
    assert.match(withoutCriticalProof, /Exact verifier commands:\nVerifier 1 .*: npm test/);
    assert.match(withoutCriticalProof, /Execution map \(planning only\):\n- criterion-01 verification/);
    assert.match(withoutCriticalProof, /Use runtime-delivered source; do not reread it/);
    assert.match(withoutCriticalProof, /Follow the execution map and implement dependency-ready criteria/);

    const overlongVerifier = boundedRuntimeIntakeMessage([
      "Piagent runtime task: INVALID-VERIFY.",
      "The complete operator request above remains authoritative.",
      "Exact verifier commands:",
      `Verifier 1 (run as an exact standalone shell command): node --test ${"test/fixture.mjs ".repeat(300)}`,
      "Execution map (planning only):",
      "- criterion-01 verification",
      "Use runtime-delivered source; do not reread it.",
      "Follow the execution map and implement dependency-ready criteria."
    ].join("\n"));
    assert.ok(overlongVerifier.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS, overlongVerifier.length);
    assert.match(overlongVerifier, /Runtime intake refused: An exact verify command exceeds 900 characters/);
    assert.match(overlongVerifier, /move verifier logic into a checked-in script/);
    assert.match(overlongVerifier, /No verifier was truncated or accepted as evidence/);
    assert.doesNotMatch(overlongVerifier, /test\/fixture\.mjs test\/fixture\.mjs/);

    const verifierPrefix = "node -e 'process.exit(0)' # ";
    const byteExactVerifierPrefix = `  ${verifierPrefix}`;
    const longestValidVerifier = `${byteExactVerifierPrefix}${"v".repeat(900 - byteExactVerifierPrefix.length - 2)}  `;
    const secondLongestValidVerifier = `${verifierPrefix}${"w".repeat(900 - verifierPrefix.length)}`;
    const exactOutputLine = `Exact final-output contract: make ${"K".repeat(64)}=<${"p".repeat(32)}> the last non-empty response line. Copy the complete value verbatim from observed project evidence and self-check every character before handoff.`;
    assert.equal(longestValidVerifier.length, 900);
    assert.equal(secondLongestValidVerifier.length, 900);
    const worstValidStructured = boundedRuntimeIntakeMessage([
      `Piagent runtime task: VALID-BOUNDARY; ${"initial-focus ".repeat(250)}`,
      "Critical behavioral proof:",
      ...Array.from({ length: 12 }, (_item, index) => (
        `- [criterion-${String(index + 1).padStart(2, "0")}:candidate=${"packages/very/long/path/".repeat(20)}test-${index}.mjs] ${"durable proof ".repeat(80)}`
      )),
      exactOutputLine,
      "Exact verifier commands:",
      `Verifier 1 (run as an exact standalone shell command): ${longestValidVerifier}`,
      `Verifier 2 (run as an exact standalone shell command): ${secondLongestValidVerifier}`,
      "Execution map (planning only):",
      ...Array.from({ length: 12 }, (_item, index) => (
        `- criterion-${String(index + 1).padStart(2, "0")} ${"packages/very/long/path/".repeat(20)}target-${index}.ts proof=${"behavioral-check".repeat(20)} after=criterion-${String(index).padStart(2, "0")}`
      )),
      `Use runtime-delivered source; ${"do-not-reread ".repeat(100)}`,
      `Follow the execution map and implement dependency-ready criteria. ${"final-guidance ".repeat(100)}`
    ].join("\n"));
    assert.ok(worstValidStructured.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS, worstValidStructured.length);
    assert.match(worstValidStructured, /Critical behavioral proof:/);
    assert.equal(worstValidStructured.includes(exactOutputLine), true, "the exact final-output contract is preserved byte-for-byte");
    assert.equal(worstValidStructured.includes(longestValidVerifier), true, "the exact executable verifier is preserved byte-for-byte");
    assert.equal(worstValidStructured.includes(secondLongestValidVerifier), true, "the second exact executable verifier is preserved byte-for-byte");
    assert.match(worstValidStructured, /Execution map \(planning only\):/);
    assert.match(worstValidStructured, /Use runtime-delivered source;/);
    assert.match(worstValidStructured, /Follow the execution map and implement dependency-ready criteria/);

    const emojiVerifierOne = utf8BoundaryCommand("node -e '0' # ", "🧪");
    const emojiVerifierTwo = utf8BoundaryCommand("npm test -- # ", "🚀");
    const astralStructured = boundedRuntimeIntakeMessage([
      `Piagent runtime task: ASTRAL-BOUNDARY; ${"large-navigation ".repeat(600)}`,
      "Critical behavioral proof:",
      "- [criterion-01:fallback] Prove the observable Unicode boundary with a focused live assertion.",
      "Exact verifier commands:",
      `Verifier 1 (run as an exact standalone shell command): ${emojiVerifierOne}`,
      `Verifier 2 (run as an exact standalone shell command): ${emojiVerifierTwo}`,
      "Execution map (planning only):",
      "- criterion-01 test/astral.test.mjs proof=behavioral-check",
      "Use runtime-delivered source; do not reread it.",
      "Follow the execution map and implement dependency-ready criteria."
    ].join("\n"));
    assert.ok(astralStructured.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS, astralStructured.length);
    assert.equal(astralStructured.includes(emojiVerifierOne), true, "provider intake must expose exact verifier one literally");
    assert.equal(astralStructured.includes(emojiVerifierTwo), true, "provider intake must expose exact verifier two literally");
    assert.equal(Buffer.byteLength(emojiVerifierOne, "utf8"), 900);
    assert.equal(Buffer.byteLength(emojiVerifierTwo, "utf8"), 900);

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

    const authoritativeCases = [
      ["concurrent-lease-lifecycle.md", "calls `operation(renew)` with a bare `renew(now)` callback"],
      ["durable-session-control-plane.md", "The stored receipt contains exactly `idempotencyKey`"]
    ];
    for (const [file, omittedClause] of authoritativeCases) {
      const operatorRequest = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts", file), "utf8");
      const summary = automaticTaskSummary(operatorRequest), acceptanceCriteria = automaticAcceptanceCriteria(operatorRequest);
      assert.doesNotMatch([summary, ...acceptanceCriteria].join("\n"), new RegExp(omittedClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const durableTask = {
        taskId: file.replace(/\.md$/, ""), taskRunId: `${file}-run`, sessionId: "session-authoritative", riskLane: "normal",
        summary, operatorRequest, operatorRequestDigest: operatorRequestDigest(operatorRequest), acceptanceCriteria,
        scope: ["packages/**", "apps/**", "test/**"], outOfScope: [], changedFiles: [], verifyCommands: ["npm test"],
        trace: { outcome: "pending" }
      };
      const semantic = buildSemanticCompactionInstructions(durableTask);
      assert.ok(semantic.length <= SEMANTIC_COMPACTION_MAX_CHARS, `${file}: ${semantic.length}`);
      assert.match(semantic, /Authoritative operator request \(redacted, lossless\): operator-request-v1:/);
      assert.match(semantic, new RegExp(omittedClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const ledger = buildAdaptiveContextLedger([{ role: "user", content: operatorRequest }], durableTask);
      assert.ok(ledger.length <= CONTEXT_GOVERNOR_LEDGER_MAX_CHARS, `${file}: ${ledger.length}`);
      assert.match(ledger, new RegExp(omittedClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const criticalMiddle = "CRITICAL_MIDDLE_CLAUSE must survive every compaction and resume boundary.";
    const criticalTail = "FINAL_CRITICAL_CLAUSE must remain authoritative.";
    const operatorRequest = `${"🧠".repeat(3_900)}${criticalMiddle}${"🧩".repeat(4_100 - Array.from(criticalMiddle + criticalTail).length)}${criticalTail}`;
    assert.equal(Array.from(operatorRequest).length, 8_000);
    const unicodeTask = {
      taskId: "unicode-max", taskRunId: "unicode-max-run", sessionId: "unicode-session", riskLane: "normal",
      summary: "Preserve the maximum Unicode operator request without losing critical clauses.",
      operatorRequest, operatorRequestDigest: operatorRequestDigest(operatorRequest),
      acceptanceCriteria: [criticalMiddle, criticalTail], scope: ["src/**"], outOfScope: [], changedFiles: [],
      verifyCommands: [emojiVerifierOne, emojiVerifierTwo], trace: { outcome: "pending" }
    };
    const unicodeSemantic = buildSemanticCompactionInstructions(unicodeTask);
    assert.ok(unicodeSemantic.length <= SEMANTIC_COMPACTION_MAX_CHARS, unicodeSemantic.length);
    assert.equal(semanticCompactionCancelled(unicodeSemantic), true);
    assert.match(unicodeSemantic, /Keep the current session context unchanged/);
    assert.equal(unicodeSemantic.includes(operatorRequest), false, "a cancellation notice must not expose private operator truth");
    const unicodeLedger = buildAdaptiveContextLedger([{ role: "user", content: operatorRequest }], unicodeTask);
    assert.ok(unicodeLedger.length <= CONTEXT_GOVERNOR_LEDGER_MAX_CHARS, unicodeLedger.length);
    assert.match(unicodeLedger, /Piagent adaptive compaction cancelled/);
    assert.match(unicodeLedger, /Keep the source transcript unchanged/);
    assert.equal(unicodeLedger.includes(operatorRequest), false, "a cancellation notice must not expose private operator truth");

    const manualTask = {
      taskId: "manual-max", taskRunId: "manual-max-run", sessionId: "manual-session", riskLane: "normal",
      summary: `${"s".repeat(1_970)}MANUAL_SUMMARY_TAIL`,
      expectedOutput: `${"e".repeat(1_970)}MANUAL_OUTPUT_TAIL`,
      acceptanceCriteria: Array.from({ length: 12 }, (_item, index) => `${`criterion-${index + 1} `.padEnd(970, "c")}MANUAL_CRITERION_TAIL_${index + 1}`),
      scope: ["src/**"], outOfScope: [], changedFiles: [], verifyCommands: [emojiVerifierOne, emojiVerifierTwo], trace: { outcome: "pending" }
    };
    const manualSemantic = buildSemanticCompactionInstructions(manualTask);
    assert.ok(manualSemantic.length <= SEMANTIC_COMPACTION_MAX_CHARS, manualSemantic.length);
    assert.equal(semanticCompactionCancelled(manualSemantic), true);
    const manualLedger = buildAdaptiveContextLedger([{ role: "user", content: "manual task" }], manualTask);
    assert.ok(manualLedger.length <= CONTEXT_GOVERNOR_LEDGER_MAX_CHARS, manualLedger.length);
    assert.match(manualLedger, /Piagent adaptive compaction cancelled/);

    const maximumOperatorRequest = `${"o".repeat(8_000 - "MAX_OPERATOR_TAIL".length)}MAX_OPERATOR_TAIL`;
    assert.equal(maximumOperatorRequest.length, 8_000);
    const maximumTask = {
      ...manualTask,
      taskId: "maximum-valid", taskRunId: "maximum-valid-run",
      operatorRequest: maximumOperatorRequest,
      operatorRequestDigest: operatorRequestDigest(maximumOperatorRequest),
      verifyCommands: [longestValidVerifier, secondLongestValidVerifier]
    };
    const maximumSemantic = buildSemanticCompactionInstructions(maximumTask);
    assert.ok(maximumSemantic.length <= SEMANTIC_COMPACTION_MAX_CHARS, maximumSemantic.length);
    assert.equal(semanticCompactionCancelled(maximumSemantic), false);
    assert.equal(maximumSemantic.includes(maximumOperatorRequest), true);
    assert.equal(maximumSemantic.includes(longestValidVerifier), true);
    assert.equal(maximumSemantic.includes(secondLongestValidVerifier), true);
    const maximumLedger = buildAdaptiveContextLedger([{ role: "user", content: maximumOperatorRequest }], maximumTask);
    assert.ok(maximumLedger.length <= CONTEXT_GOVERNOR_LEDGER_MAX_CHARS, maximumLedger.length);
    assert.equal(maximumLedger.includes(maximumOperatorRequest), true);
    assert.equal(maximumLedger.includes(longestValidVerifier), true);
    assert.equal(maximumLedger.includes(secondLongestValidVerifier), true);
  });

  it("omits the legacy runtime-scope criterion from semantic carry-over without mutating the contract", () => {
    const legacyCriterion = "Changes stay within the runtime-derived task scope.";
    const acceptanceCriteria = [
      legacyCriterion,
      "Frontend implementation matches the approved backend contract.",
      "Run the configured verification commands."
    ];
    const scope = ["v-nexus-frontend/src/**", "v-nexus-frontend/e2e/**"];
    const verifyCommands = ["npm test"];
    const criterionGraph = compileCriterionGraph({
      acceptanceCriteria,
      scope,
      verifyCommands,
      changeMode: "source-change",
      mode: "criterion-graph",
      createdAt: "2026-08-24T00:00:00.000Z"
    });
    const durableCriteria = structuredClone(acceptanceCriteria);
    const durableGraph = structuredClone(criterionGraph);
    const carryOver = buildSemanticCompactionInstructions({
      taskId: "LEGACY-SCOPE",
      taskRunId: "legacy-scope-run",
      sessionId: "session-1",
      sessionName: "LEGACY-SCOPE",
      riskLane: "normal",
      summary: "Implement the frontend from the approved backend contract.",
      acceptanceCriteria,
      criterionGraph,
      scope,
      changedFiles: [],
      verifyCommands,
      trace: { outcome: "pending" }
    });

    assert.doesNotMatch(carryOver, /Changes stay within the runtime-derived task scope/);
    assert.doesNotMatch(carryOver, /criterion-01/);
    assert.match(carryOver, /criterion-02 behavior/);
    assert.match(carryOver, /criterion-03 verification .*after=criterion-02/);
    assert.match(carryOver, /Initial focus \(advisory\): v-nexus-frontend\/src\/\*\*/);
    assert.match(carryOver, /neither authorizes nor forbids mutation/);
    assert.doesNotMatch(carryOver, /\nScope:/);
    assert.deepEqual(acceptanceCriteria, durableCriteria);
    assert.deepEqual(criterionGraph, durableGraph);
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
    state.rememberQualifiedContextEvidence(first, "run-1", {
      path: "src/c.ts", reason: "Runtime observed successful source read."
    });
    state.rememberAdvisedTool(first, "bash");
    state.rememberToolResult(first, "same-call", { outputHash: "hash-1", recordedAt: "now" });
    state.rememberInjectedContextPack(first, "same-query", {
      queryHash: "query-1",
      confidence: "high",
      estimatedTokens: 10,
      paths: ["src/a.ts"]
    });
    state.stageContextDelivery(first, {
      deliveryId: "delivery-1",
      taskRunId: "run-1",
      entries: [{ path: "src/a.ts", reason: "confirmed delivery" }]
    });
    const firstTurn = state.beginTurn(first, "prompt-1");
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
    assert.deepEqual(state.qualifiedContextEvidence(first, "run-1"), [{
      path: "src/c.ts", reason: "Runtime observed successful source read."
    }]);
    assert.deepEqual(state.qualifiedContextEvidence(first, "run-2"), []);
    assert.deepEqual(state.qualifiedContextEvidence(second, "run-1"), []);
    assert.equal(state.hasAdvisedTool(first, "bash"), true);
    assert.equal(state.hasAdvisedTool(second, "bash"), false);
    assert.equal(state.previousToolResult(second, "same-call"), undefined);
    assert.equal(state.injectedContextPack(second, "same-query"), undefined);
    assert.equal(state.injectedContextPack(first, "same-query")?.queryHash, "query-1");
    assert.equal(state.takeContextDelivery(second, "delivery-1"), undefined);
    assert.deepEqual(state.takeContextDelivery(first, "delivery-1"), {
      deliveryId: "delivery-1",
      taskRunId: "run-1",
      entries: [{ path: "src/a.ts", reason: "confirmed delivery" }]
    });
    assert.equal(state.takeContextDelivery(first, "delivery-1"), undefined, "delivery confirmation is one-shot");
    assert.equal(state.currentTurn(first, "prompt-1")?.turnId, firstTurn.turnId);
    assert.equal(state.currentTurn(first, "different"), undefined);
    assert.equal(state.currentTurn(second), undefined);
    state.rememberPreTaskContext(first, { path: "src/model-claim.ts", reason: "model says it read this" });
    assert.deepEqual(state.preTaskContext(first), [], "non-runtime evidence cannot enter the intake epoch");
    state.rememberPreTaskContext(first, {
      path: "src/turn-1.ts", reason: "Runtime observed successful source read."
    });
    assert.deepEqual(state.preTaskContext(first).map((item) => item.path), ["src/turn-1.ts"]);
    assert.deepEqual(state.preTaskContext(second), [], "pre-task evidence is session-bound");
    const secondTurn = state.beginTurn(first, "prompt-2");
    assert.notEqual(secondTurn.turnId, firstTurn.turnId);
    assert.deepEqual(state.preTaskContext(first), [], "a new intake turn drops stale pre-task evidence");
    state.rememberPreTaskContext(first, {
      path: "src/turn-2.ts", reason: "Runtime observed successful source read."
    });
    state.promotePreTaskContext(first, "run-turn-2", [{
      path: "src/turn-2.ts", reason: "Runtime observed successful source read."
    }, {
      path: "src/not-observed.ts", reason: "Runtime observed successful source read."
    }]);
    assert.deepEqual(state.qualifiedContextEvidence(first, "run-turn-2"), [{
      path: "src/turn-2.ts", reason: "Runtime observed successful source read."
    }]);
    assert.deepEqual(state.preTaskContext(first), [], "promotion consumes the current intake epoch");
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
    assert.deepEqual(state.qualifiedContextEvidence(first, "run-1"), []);
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

  it("clears volatile task state at a terminal boundary without poisoning a successor task", () => {
    const cwd = temporaryProject();
    const first = extensionContext(cwd, "session-boundary");
    const second = extensionContext(cwd, "session-other");
    const state = new RuntimeSessionState({ maxObservedContext: 4 });
    const packedKey = `${cwd}\u0000session-boundary\u0000prompt-a`;

    state.cacheTaskIdentity(first, { taskId: "TASK-A", taskRunId: "run-a" });
    state.beginTurn(first, "prompt-a");
    state.rememberObservedContext(first, { path: "src/a.ts", reason: "read" });
    state.rememberQualifiedContextEvidence(first, "run-a", { path: "src/a.ts", reason: "read" });
    state.rememberToolResult(first, "same-read", { outputHash: "old-output", recordedAt: "now" });
    state.rememberInjectedContextPack(first, "same-query", {
      queryHash: "old-query", confidence: "high", estimatedTokens: 20, paths: ["src/a.ts"]
    });
    state.stageContextDelivery(first, {
      deliveryId: "old-delivery", taskRunId: "run-a", entries: [{ path: "src/a.ts", reason: "old" }]
    });
    state.rememberAutoPackedPrompt(packedKey);
    state.rememberAdvisedTool(first, "bash");
    state.rememberToolResult(second, "same-read", { outputHash: "other-session", recordedAt: "now" });

    state.clearTaskBoundary(first, "run-a");

    assert.equal(state.taskIdentity(first), undefined);
    assert.deepEqual(state.observedContext(first), []);
    assert.deepEqual(state.qualifiedContextEvidence(first, "run-a"), []);
    assert.equal(state.previousToolResult(first, "same-read"), undefined);
    assert.equal(state.injectedContextPack(first, "same-query"), undefined);
    assert.equal(state.takeContextDelivery(first, "old-delivery"), undefined);
    assert.equal(state.hasAutoPackedPrompt(packedKey), false);
    assert.equal(state.hasAdvisedTool(first, "bash"), true, "session-level policy advice is not task context");
    assert.equal(state.previousToolResult(second, "same-read")?.outputHash, "other-session");
    assert.equal(state.currentTurn(first)?.promptHash, "prompt-a", "the host may still settle the terminal turn");

    state.cacheTaskIdentity(first, { taskId: "TASK-B", taskRunId: "run-b" });
    state.rememberToolResult(first, "new-read", { outputHash: "new-output", recordedAt: "later" });
    state.clearTaskBoundary(first, "run-a");
    assert.deepEqual(state.taskIdentity(first), { taskId: "TASK-B", taskRunId: "run-b" });
    assert.equal(state.previousToolResult(first, "new-read")?.outputHash, "new-output", "a late old-task settlement cannot clear successor state");
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
    const shellSnapshotBefore = workingTreeSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, "src", "event.ts"), "export const value = 1;\n");
    const preSnapshot = workingTreeSnapshot(cwd);
    const handlers = new Map();
    const observations = [];
    const semanticDigests = [];
    const downstreamSnapshots = [];
    const telemetry = [];
    const task = {
      taskId: "TREE-EVENT", taskRunId: "tree-event-run", sessionId: "session-1",
      trace: { outcome: "pending" }, baselineFileDigests: preSnapshot
    };
    const state = {
      taskIdentity: () => ({ taskId: task.taskId, taskRunId: task.taskRunId }),
      observedContext: () => [], qualifiedTaskContext: () => [], consumeShellMutationSnapshot: () => shellSnapshotBefore,
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
      state, activeTask: () => task, maxManifestFiles: 10, flushObservedTaskContext: () => undefined, readProtectedPaths: () => [],
      recordObservedBash() {}, observedBashLedgerPath: () => "", redactText: (value) => value,
      observedTaskContext: () => undefined,
      recordObservedTaskChanges: (_pi, _ctx, _event, _pending, _maximum, _before, eventTree) => {
        observations.push(eventTree);
        fs.writeFileSync(path.join(cwd, "src", "event.ts"), "export const value = 2;\n");
      },
      recordObservedTaskVerification: (_pi, _ctx, _event, _pending, _maximum, _before, eventTree) => observations.push(eventTree),
      extractLikelyPath: () => undefined, mutationTargets: () => [], isShellTool: () => true,
      telemetry: (_ctx, payload) => telemetry.push(payload), now: () => "2026-08-10T00:00:00.000Z",
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
    assert.deepEqual(telemetry.find((entry) => entry.event === "tool_result")?.changedPaths, ["src/event.ts"]);
    assert.notEqual(workingTreeEvidenceDigest(workingTreeSnapshot(cwd)), observations[0].digest, "a later mutation belongs to the next event, not this one");
  });

  it("delivers a small current-file recovery snapshot once after an edit anchor mismatch", async () => {
    const cwd = temporaryProject();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    const currentSource = Array.from({ length: 220 }, (_, index) => index === 0
      ? 'export const greeting = "Xin chào Việt Nam — kiểm tra Unicode 🚀";'
      : `export const line${String(index).padStart(3, "0")} = ${index};`).join("\n") + "\n";
    fs.writeFileSync(path.join(cwd, "src", "small.js"), currentSource);
    const handlers = new Map();
    const telemetry = [];
    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    const pi = { on: (name, handler) => handlers.set(name, handler) };
    const ctx = { ...extensionContext(cwd), ui: { notify() {} } };
    registerToolResultHook(pi, {
      state,
      activeTask: () => undefined,
      maxManifestFiles: 2,
      flushObservedTaskContext: () => undefined,
      readProtectedPaths: () => [],
      recordObservedBash() {},
      observedBashLedgerPath: () => "",
      redactText: (value) => value,
      observedTaskContext: () => undefined,
      recordObservedTaskChanges() {},
      recordObservedTaskVerification() {},
      extractLikelyPath: (_cwd, input) => input.path,
      mutationTargets: () => [],
      isShellTool: () => false,
      telemetry: (_ctx, payload) => telemetry.push(payload),
      now: () => "2026-08-10T00:00:00.000Z"
    });
    const event = {
      toolCallId: "edit-mismatch-1",
      toolName: "edit",
      input: { path: "src/small.js", edits: [{ oldText: "missing", newText: "replacement" }] },
      content: [{ type: "text", text: "Could not find the exact text. The old text must match exactly." }],
      isError: true
    };

    const first = await handlers.get("tool_result")(event, ctx);
    const firstText = first.content.map((block) => block.text ?? "").join("\n");
    assert.match(firstText, /export const line100 = 100/, "a line-dense recovery snapshot must not be compacted into a partial preview");
    assert.match(firstText, /replaces a separate reread/);
    assert.equal(first.details.piagentEditRecovery.targetPath, "src/small.js");
    assert.ok(first.details.piagentEditRecovery.injectedChars > first.details.piagentEditRecovery.originalChars);
    assert.ok(firstText.length >= first.details.piagentEditRecovery.injectedChars);
    const recoveryText = first.content.at(-1).text;
    const exactRecoveryEstimate = estimateContextTokens(recoveryText);
    assert.equal(first.details.piagentEditRecovery.injectedEstimatedTokens, exactRecoveryEstimate);
    assert.notEqual(exactRecoveryEstimate, Math.ceil(recoveryText.length / 4), "non-ASCII recovery must not use the legacy chars/4 estimate");
    assert.equal(telemetry.filter((entry) => entry.event === "edit_recovery_context").length, 1);
    assert.equal(telemetry.find((entry) => entry.event === "edit_recovery_context")?.injectedEstimatedTokens, exactRecoveryEstimate);
    assert.equal(telemetry.find((entry) => entry.event === "tool_result")?.editRecoveryEstimatedTokens, exactRecoveryEstimate);
    assert.equal(telemetry.find((entry) => entry.event === "tool_result")?.reasonCode, "edit-anchor-stale");

    const second = await handlers.get("tool_result")({ ...event, toolCallId: "edit-mismatch-2" }, ctx);
    assert.equal(second, undefined, "the same current file snapshot is not injected twice in one session");
    assert.equal(telemetry.filter((entry) => entry.event === "edit_recovery_context").length, 1);
    assert.equal(telemetry.find((entry) => entry.event === "tool_result" && entry.toolCallId === "edit-mismatch-2")?.editRecoveryContext, false,
      "a suppressed duplicate remains an explicit recovery-policy decision");

    await handlers.get("session_compact")({}, ctx);
    const afterCompaction = await handlers.get("tool_result")({ ...event, toolCallId: "edit-mismatch-3" }, ctx);
    assert.match(afterCompaction.content.at(-1).text, /export const line100 = 100/);
    assert.equal(telemetry.filter((entry) => entry.event === "edit_recovery_context").length, 2,
      "a compacted-away snapshot may be delivered once in the new context epoch");

    fs.writeFileSync(path.join(cwd, ".netrc"), "machine api.example login alice password hunter2\n");
    const credentialResult = await handlers.get("tool_result")({
      ...event,
      toolCallId: "edit-credential-1",
      input: { path: ".netrc", edits: [{ oldText: "missing", newText: "replacement" }] }
    }, ctx);
    assert.equal(credentialResult, undefined, "credential dotfiles never enter edit recovery through the real hook");
    assert.equal(telemetry.filter((entry) => entry.event === "edit_recovery_context").length, 2);
    assert.equal(telemetry.find((entry) => entry.event === "tool_result" && entry.toolCallId === "edit-credential-1")?.editRecoveryContext, false,
      "an ineligible private target is explicit rather than indistinguishable from missing instrumentation");
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
    const writeTelemetry = (_ctx, payload) => telemetry.push(payload);
    registerSessionHooks(pi, {
      state,
      maxManifestFiles: 4,
      telemetry: writeTelemetry,
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
      "message_start",
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

    stageContextDelivery(ctx, {
      deliveryId: "delivery-1",
      taskRunId: "run-1",
      turnId: "turn-1",
      entries: [{ path: "src/delivered.ts", reason: "confirmed delivery" }],
      pack: { retrievalKey: "query-key", queryHash: "query-hash", confidence: "high", estimatedTokens: 10, paths: ["src/delivered.ts"] },
      injection: { source: "test", queryHash: "query-hash", confidence: "high", estimatedTokens: 10, selectedItems: [{ path: "src/delivered.ts", estimatedTokens: 10 }] }
    }, { state, telemetry: writeTelemetry });
    assert.equal(flushed.length, 0, "offered context is not durable evidence before host confirmation");
    await handlers.get("message_start")({ message: {
      role: "custom",
      details: { contextDelivery: { schemaVersion: 1, deliveryId: "delivery-1" } }
    } }, ctx);
    assert.equal(state.injectedContextPack(ctx, "query-key")?.queryHash, "query-hash");
    assert.equal(flushed[0].event, "context_delivery_confirmed");

    task.trace = { outcome: "completed" };
    await handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2 } }, turnIndex: 2, toolResults: [] }, ctx);
    const terminalTurn = telemetry.find((entry) => entry.event === "turn_end");
    assert.equal(terminalTurn.taskRunId, "run-1", "terminal usage remains attributed before volatile state is cleared");
    assert.equal(terminalTurn.taskOutcome, "completed");
    assert.equal(state.taskIdentity(ctx), undefined, "terminal cleanup happens after turn-end telemetry");
    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("session_compact")({ reason: "threshold", willRetry: false, fromExtension: false }, ctx);
    await handlers.get("session_shutdown")({ reason: "quit", targetSessionFile: "/tmp/session.jsonl" }, ctx);
    assert.deepEqual(telemetry.map((entry) => entry.event), ["context_pack_offered", "context_delivery_confirmed", "context_pack_injected", "turn_end", "agent_settled", "session_compact", "session_shutdown"]);
    assert.equal(telemetry.at(-1).targetSessionFile, "session.jsonl");
    assert.deepEqual(flushed[0].pending, [
      { path: "src/delivered.ts", reason: "confirmed delivery" }
    ]);
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
    const state = new RuntimeSessionState({ maxObservedContext: 2 });
    registerInputHook(pi, {
      state,
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
    state.cacheTaskIdentity(ctx, { taskId: "STALE", taskRunId: "stale-run" });
    state.rememberToolResult(ctx, "stale-read", { outputHash: "old-output", recordedAt: "earlier" });
    assert.deepEqual(
      await handlers.get("input")({ text: "Fix src/cart.ts quantity calculation", source: "interactive", images: [] }, ctx),
      { action: "continue" }
    );
    assert.deepEqual(activated, [[]]);
    assert.equal(telemetry[0].event, "user_input");
    assert.equal(typeof telemetry[0].turnId, "string");
    assert.equal(telemetry[0].intakeMode, "runtime");
    assert.equal(telemetry[0].taskRunId, undefined, "a missing durable task cannot inherit cached task attribution");
    assert.equal(state.taskIdentity(ctx), undefined);
    assert.equal(state.previousToolResult(ctx, "stale-read"), undefined, "stale task tool-result state is cleared before intake");
  });

  it("keeps tool activation and task intake policy deterministic", () => {
    assert.deepEqual(toolGroupsForPrompt("/usage"), ["usage"]);
    assert.deepEqual(
      toolGroupsForPrompt("/onboard"),
      ["governance", "policy", "retrieval", "knowledge", "onboarding"]
    );
    assert.deepEqual(
      toolGroupsForPrompt("/platform-improve Review https://github.com/can1357/oh-my-pi for reusable ideas"),
      ["intake", "task", "source"]
    );
    assert.ok(toolGroupsForPrompt("Review [source](https://gitlab.com/acme/reference.git)").includes("source"));
    assert.ok(toolGroupsForPrompt("Review git@bitbucket.org:acme/reference.git").includes("source"));
    assert.equal(toolGroupsForPrompt("Review https://github.com.evil.example/acme/reference").includes("source"), false);
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
      automaticTaskIntakeMode(
        "Inspect src/greeting.js and prepare a governed source task, but do not modify the project yet.",
        []
      ),
      undefined,
      "a temporary pre-task mutation pause must not become a task-wide read-only contract"
    );
    assert.equal(
      automaticTaskMutationPolicy(
        "Inspect src/greeting.js and prepare a governed source task, but do not modify the project yet.",
        "source-change"
      ),
      "required"
    );
    assert.equal(
      automaticTaskIntakeMode("Run all tests, typecheck, and npm pack --dry-run. Do not edit source files.", []),
      "source-change"
    );
    assert.equal(
      automaticTaskMutationPolicy("Run all tests, typecheck, and npm pack --dry-run. Do not edit source files.", "source-change"),
      "forbidden"
    );
    assert.equal(
      automaticTaskMutationPolicy(
        "Implement the frontend update: admin ingestion sources become list/detail read-only, add redirects and E2E. Do not mutate anything outside v-nexus-frontend/src/** and v-nexus-frontend/e2e/**.",
        "source-change"
      ),
      "required"
    );
    for (const prompt of [
      "Implement frontend; do not edit backend files.",
      "Do not edit backend; update frontend and tests.",
      "Mutate only v-nexus-frontend/src/**; all other paths read-only.",
      "Do not edit files outside src/**; update src/app.ts."
    ]) {
      assert.equal(automaticTaskIntakeMode(prompt, []), "source-change", prompt);
      assert.equal(automaticTaskMutationPolicy(prompt, "source-change"), "required", prompt);
    }
    for (const prompt of [
      "Run tests; do not edit source files.",
      "Run the configured verifier in read-only mode.",
      "This task must remain read-only.",
      "No project files are changed."
    ]) {
      assert.equal(automaticTaskMutationPolicy(prompt, automaticTaskIntakeMode(prompt, []) ?? "source-change"), "forbidden", prompt);
    }
    assert.equal(
      automaticTaskMutationPolicy("Run the configured verifier in read-only mode and report the result.", "source-change"),
      "forbidden"
    );
    assert.equal(automaticTaskMutationPolicy("Fix src/cart.ts and run the tests.", "source-change"), "required");
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
    for (const label of ["M1", "M2", "M3", "M4"]) assert.equal(migrationCriteria.some((criterion) => criterion.startsWith(`[${label}] `)), true, label);
    assert.equal(
      migrationCriteria.some((criterion) => /Do not require array, object, or function identity.*same loaded module instance\.$/.test(criterion)),
      true
    );
    assert.match(migrationCriteria.join("\n"), /does not rerun earlier completed steps/);
    assert.ok(migrationCriteria.every((criterion) => criterion.length <= 600));
    const rolloutPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts/multi-package-rollout.md"), "utf8");
    assert.doesNotMatch(automaticTaskSummary(rolloutPrompt), /rolloutSummary/);
  });

  it("keeps deterministic atomic coverage across long labeled capability contracts", () => {
    const capability = (file) => automaticAcceptanceCriteria(fs.readFileSync(
      path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts", file), "utf8"
    ));
    const lease = capability("concurrent-lease-lifecycle.md");
    for (const label of ["L1", "L2", "L3", "L4"]) assert.equal(lease.some((criterion) => criterion.startsWith(`[${label}] `)), true, label);
    assert.equal(lease.includes("[L1] Invalid input throws `TypeError`."), true);
    assert.equal(lease.includes("[L2] It succeeds when the key is absent, when the prior lease is expired at the inclusive boundary (`now >= expiresAt`), or when the same owner reacquires it."), true);
    assert.equal(lease.includes("[L4] Its cleanup must not delete a lease that changed owner after expiry."), true);

    const control = capability("durable-session-control-plane.md");
    for (const label of ["D1", "D2", "D3", "D4", "D5", "D6"]) assert.equal(control.some((criterion) => criterion.startsWith(`[${label}] `)), true, label);
    assert.equal(control.includes("[D3] Check a prior idempotency receipt before revision matching: an identical replay succeeds even with a stale expected revision, returns the identical state object, and marks only the returned receipt `replayed: true`."), true);
    assert.equal(control.includes("[D4] Canonicalization must reject non-finite or non-JSON values."), true);
    assert.equal(control.includes("[D5] Do not mutate caller state/input, and do not share the separately returned receipt object with the stored receipt."), true);
    assert.equal(control.length, 12);
  });

  it("joins wrapped prose obligations before deriving acceptance criteria", () => {
    const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/production-v1/prompts/tenant-role-authorization.md"), "utf8");
    const criteria = automaticAcceptanceCriteria(prompt);
    const authorization = criteria.find((criterion) => criterion.includes("canManage(user, resource)"));
    assert.equal(authorization, "`canManage(user, resource)` may return true only when the user is active, has role `owner` or `admin`, and `user.tenantId` and `resource.tenantId` are the same non-empty string.");
    assert.equal(criteria.includes("Missing input must be denied."), true);
    assert.equal(criteria.includes("Keep the change focused and run the project verification commands."), true);
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

  it("decomposes a wrapped multi-clause CLI contract into atomic acceptance criteria", () => {
    const prompt = [
      "Repair `parseArgs(argv)` in `src/platform/args.js`.",
      "",
      "Support `--name value`, `--name=value`, and boolean `--flag`. The first standalone",
      "`--` ends flag parsing and every later token is positional even if it starts",
      "with dashes. A flag followed by another flag is boolean true. Repeated flags",
      "use the last value. Do not mutate argv or change the return shape. Verify the",
      "project."
    ].join("\n");
    const criteria = automaticAcceptanceCriteria(prompt);

    for (const expected of [
      "Repair `parseArgs(argv)` in `src/platform/args.js`.",
      "Support `--name value`, `--name=value`, and boolean `--flag`.",
      "The first standalone `--` ends flag parsing and every later token is positional even if it starts with dashes.",
      "A flag followed by another flag is boolean true.",
      "Repeated flags use the last value.",
      "Do not mutate argv or change the return shape.",
      "Verify the project."
    ]) assert.equal(criteria.includes(expected), true, expected);
    assert.equal(criteria.some((criterion) => criterion.includes("boolean `--flag`. The first standalone")), false);
  });

  it("decomposes a bounded labeled bullet without discarding its label or clauses", () => {
    const criteria = automaticAcceptanceCriteria([
      "Implement src/lease.js.",
      "- [L1] Accept a valid lease object. Reject an expired lease with TypeError.",
      "- [L2] Preserve the public return shape."
    ].join("\n"));

    assert.equal(criteria.includes("[L1] Accept a valid lease object."), true);
    assert.equal(criteria.includes("[L1] Reject an expired lease with TypeError."), true);
    assert.equal(criteria.includes("[L2] Preserve the public return shape."), true);
    assert.equal(criteria.some((criterion) => criterion.includes("object. Reject")), false);
  });

  it("decomposes top-level semicolon obligations while preserving quoted and code literals", () => {
    const criteria = automaticAcceptanceCriteria([
      "Implement src/mode.js.",
      "- [C1] Support mode A; reject invalid mode B; preserve caller state unchanged.",
      "- [C2] Preserve literals `a;b` and \"c;d\"; reject malformed input."
    ].join("\n"));
    const atomic = [
      "[C1] Support mode A",
      "[C1] reject invalid mode B",
      "[C1] preserve caller state unchanged.",
      "[C2] Preserve literals `a;b` and \"c;d\"",
      "[C2] reject malformed input."
    ];
    for (const expected of atomic) assert.equal(criteria.includes(expected), true, expected);
    assert.equal(criteria.some((criterion) => criterion.includes("mode A; reject")), false);

    const built = buildAcceptanceReceipt({
      summary: "Implement atomic mode handling.",
      expectedOutput: "The mode contract is implemented.",
      acceptanceCriteria: criteria,
      changeMode: "source-change",
      source: "runtime"
    });
    for (const expected of atomic.slice(0, 3)) {
      const index = built.acceptanceCriteria.indexOf(expected);
      assert.ok(index >= 0, expected);
      assert.equal(built.receipt.criteria[index].status, "pending", expected);
    }
    assert.equal(new Set(built.receipt.criteria.slice(0, 3).map((criterion) => criterion.hash)).size, 3);
  });

  it("does not reinterpret tenant fairness as an access-control boundary", () => {
    const prompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/deep-logic-v1/prompts/fair-dependency-scheduler.md"), "utf8");
    const built = buildAcceptanceReceipt({
      summary: automaticTaskSummary(prompt),
      expectedOutput: "The scheduler satisfies the requested dependency, capacity, and fairness contract.",
      acceptanceCriteria: automaticAcceptanceCriteria(prompt),
      changeMode: "source-change",
      source: "runtime"
    });
    assert.equal(built.receipt.criteria.some((criterion) => criterion.obligation === "tenant-boundary"), false);
    assert.equal(built.receipt.criteria.some((criterion) => criterion.obligation === "tenant-storage-isolation"), false);

    const crossTenantAccess = buildAcceptanceReceipt({
      summary: "Block cross-tenant access and allow an active administrator only when tenantId values match.",
      expectedOutput: "Unauthorized access is denied.",
      changeMode: "source-change"
    });
    assert.equal(crossTenantAccess.receipt.criteria.some((criterion) => criterion.obligation === "tenant-boundary"), true);

    const tenantCache = buildAcceptanceReceipt({
      summary: "Keep TenantCache entries isolated by tenantId and entity without composite-key collisions.",
      expectedOutput: "Distinct tenant storage identities never collide.",
      changeMode: "source-change"
    });
    assert.equal(tenantCache.receipt.criteria.some((criterion) => criterion.obligation === "tenant-storage-isolation"), true);

    const billingPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/deep-logic-v1/prompts/temporal-usage-billing-close.md"), "utf8");
    const billing = buildAcceptanceReceipt({
      summary: automaticTaskSummary(billingPrompt),
      expectedOutput: "The temporal close and admin summary satisfy the billing contract.",
      acceptanceCriteria: automaticAcceptanceCriteria(billingPrompt),
      changeMode: "source-change",
      source: "runtime"
    });
    assert.equal(billing.receipt.criteria.some((criterion) => criterion.obligation === "tenant-boundary"), false);

    const rolloutPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts/multi-package-rollout.md"), "utf8");
    const rollout = buildAcceptanceReceipt({
      summary: automaticTaskSummary(rolloutPrompt),
      expectedOutput: "The feature rollout contract is implemented and verified.",
      acceptanceCriteria: automaticAcceptanceCriteria(rolloutPrompt),
      changeMode: "source-change",
      source: "runtime"
    });
    assert.equal(rollout.receipt.criteria.some((criterion) => criterion.obligation === "authorization-deny-case"), false);
    assert.equal(rollout.receipt.criteria.some((criterion) => criterion.obligation === "tenant-boundary"), false);
  });

  it("caps automatic acceptance criteria with deterministic whole-prompt coverage", () => {
    const earlyAndMiddle = Array.from({ length: 20 }, (_entry, index) => (
      `- [C${String(index + 1).padStart(2, "0")}] The implementation must preserve obligation ${index + 1}.`
    ));
    const prompt = [
      "Implement the bounded billing change.",
      "",
      ...earlyAndMiddle,
      "",
      "Missing plans or meters fail closed."
    ].join("\n");

    const first = automaticAcceptanceCriteria(prompt);
    const second = automaticAcceptanceCriteria(prompt);

    assert.deepEqual(second, first);
    assert.equal(first.length, 12);
    assert.equal(first[0].startsWith("[C01] "), true);
    assert.equal(first.some((criterion) => criterion.startsWith("[C20] ")), false, "the cap is not a first-criteria prefix");
    assert.equal(first.includes("Missing plans or meters fail closed."), true);
    const selectedNumbers = first.slice(0, -1).map((criterion) => Number(criterion.match(/^\[C(\d+)\]/)?.[1]));
    assert.deepEqual([...selectedNumbers].sort((left, right) => left - right), selectedNumbers);
  });

  it("recognizes an unbulleted missing plan or meter fail-closed obligation", () => {
    const criteria = automaticAcceptanceCriteria([
      "Implement closeUsagePeriod in src/billing.js.",
      "",
      "Resolve reversals before rating.",
      "",
      "Missing plans or meters fail closed."
    ].join("\n"));

    assert.equal(criteria.includes("Missing plans or meters fail closed."), true);
  });

  it("recognizes exact output obligations expressed as returns and emits", () => {
    const criteria = automaticAcceptanceCriteria([
      "billingSummary(result) returns an exact Terminal/WebUI summary.",
      "Then emit one line per invoice."
    ].join("\n"));

    assert.equal(criteria.includes("billingSummary(result) returns an exact Terminal/WebUI summary."), true);
    assert.equal(criteria.includes("Then emit one line per invoice."), true);
  });

  it("keeps high-signal safety and exact-output obligations stable when the prompt grows", () => {
    const filler = Array.from({ length: 18 }, (_entry, index) => (
      `- The implementation emits diagnostic field ${index + 1}.`
    ));
    const missing = "A missing active plan is invalid input: throw TypeError; never skip it.";
    const lineFeed = "The summary must join lines with an actual LF and never a literal backslash-n.";
    const criteria = automaticAcceptanceCriteria([
      "Implement the complete contract.",
      ...filler.slice(0, 9),
      missing,
      ...filler.slice(9),
      lineFeed
    ].join("\n\n"));

    assert.equal(criteria.length, 12);
    assert.equal(criteria.includes("A missing active plan is invalid input: throw TypeError"), true);
    assert.equal(criteria.includes("never skip it."), true);
    assert.equal(criteria.includes(lineFeed), true);
  });

  it("does not spend the acceptance cap on path-only scope bullets", () => {
    const criteria = automaticAcceptanceCriteria([
      "Implement the billing close across:",
      "- `packages/billing/src/plan-timeline.js`",
      "- `packages/billing/src/close-period.js`",
      "",
      "The implementation must reject an unavailable meter."
    ].join("\n"));

    assert.equal(criteria.some((criterion) => criterion.includes("packages/billing/")), false);
    assert.equal(criteria.includes("The implementation must reject an unavailable meter."), true);
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

    for (const request of [
      "Update dependency version for the CSV parser.",
      "Use dependency injection for the CSV parser service.",
      "Remove the unused dependency from the CSV parser package.",
      "Keep the CSV parser dependency-free.",
      "Send each invoice exactly once.",
      "Update the monthly billing cycle.",
      "Run scheduled jobs during each billing cycle.",
      "Refresh the network topology diagram.",
      "Run tests after the dependency installation completes",
      "Preserve input order for CSV records"
    ]) {
      const benignDependencyPlan = analyzePerformanceAssurance({ request, changeMode: "source-change" });
      assert.equal(benignDependencyPlan.reasonCodes.includes("graph-order-contract"), false, request);
      assert.equal(benignDependencyPlan.requiresReview, false, request);
    }

    const dependencyFreeErrorPlan = analyzePerformanceAssurance({
      request: "Build a dependency-free CSV parser that rejects malformed quoted fields with SyntaxError and run configured verification.",
      changeMode: "source-change"
    });
    assert.ok(dependencyFreeErrorPlan.reasonCodes.includes("exact-error-contract"));
    assert.equal(dependencyFreeErrorPlan.reasonCodes.includes("graph-order-contract"), false);
    assert.equal(dependencyFreeErrorPlan.requiresReview, false);

    for (const request of [
      "Preserve dependency order when scheduling jobs.",
      "Validate the dependency graph before scheduling jobs.",
      "Emit each prerequisite before its dependent.",
      "A job may run only after all dependencies complete.",
      "Execute each dependency first.",
      "Each prerequisite must precede the job.",
      "A job cannot begin until its dependencies have finished.",
      "Start a task only once every prerequisite is complete.",
      "Jobs wait for their dependencies to finish.",
      "Do not schedule a dependent before its dependencies.",
      "Reject cycles in the job graph.",
      "Return jobs in topological order.",
      "The scheduler must remain a DAG.",
      "Dependencies must complete before dependent jobs start",
      "B depends on A and must be scheduled afterward",
      "Wait for all dependencies before running a job",
      "Dependency A must run before job B",
      "Prerequisites need to finish prior to starting the task.",
      "A job is eligible when every dependency is done.",
      "B depends on A; schedule A first.",
      "Run dependencies, followed by the dependent job.",
      "Schedule A before B because B depends on A.",
      "Preserve stable input order when ranks tie",
      "Preserve stable order for rank ties"
    ]) {
      const dependencyRelationPlan = analyzePerformanceAssurance({ request, changeMode: "source-change" });
      assert.equal(dependencyRelationPlan.reasonCodes.includes("graph-order-contract"), true, request);
      assert.equal(dependencyRelationPlan.requiresReview, true, request);
    }

    const fairSchedulerPrompt = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/deep-logic-v1/prompts/fair-dependency-scheduler.md"), "utf8");
    const fairSchedulerPlan = analyzePerformanceAssurance({ request: fairSchedulerPrompt, changeMode: "source-change" });
    assert.equal(fairSchedulerPlan.tier, "rigorous");
    assert.equal(fairSchedulerPlan.requiresReview, true);
    assert.ok(fairSchedulerPlan.reasonCodes.includes("graph-order-contract"));
    assert.equal(fairSchedulerPlan.reasonCodes.includes("identity-isolation-contract"), false);
    assert.equal(fairSchedulerPlan.reviewChecks.some((item) => /same-, cross-, and missing-identity|allow\/deny or storage isolation/.test(item)), false);

    const tenantIsolationPlan = analyzePerformanceAssurance({
      request: "Keep usage counters isolated between tenants and meters without changing the public return shape.",
      changeMode: "source-change"
    });
    assert.ok(tenantIsolationPlan.reasonCodes.includes("identity-isolation-contract"));

    const statefulPlan = analyzePerformanceAssurance({
      request: [
        "Revision is a non-negative safe integer and each fresh command increments it exactly once.",
        "An idempotent replay is checked before revision matching and accepts a stale revision.",
        "Report replay ids once in first-observed order."
      ].join(" "),
      changeMode: "source-change"
    });
    assert.equal(statefulPlan.tier, "rigorous");
    assert.equal(statefulPlan.requiresReview, true);
    assert.ok(statefulPlan.reasonCodes.includes("boundary-contract"));
    assert.ok(statefulPlan.reasonCodes.includes("graph-order-contract"));
    assert.ok(statefulPlan.reasonCodes.includes("concurrency-contract"));
    assert.ok(statefulPlan.reviewChecks.some((item) => /Number\.MAX_SAFE_INTEGER/.test(item)));
    assert.ok(statefulPlan.reviewChecks.some((item) => /A, B, B, A/.test(item)));
    assert.ok(statefulPlan.reviewChecks.some((item) => /stale revision/.test(item)));

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
