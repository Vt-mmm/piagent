import type { TaskContract } from "../../extensions/guard-types.ts";
import { acceptanceBoundaryProofGuidance } from "../../extensions/acceptance-boundary-guidance.js";
import { normalizePathCandidate } from "../../extensions/policy-core.js";
import { acceptanceLanguageAdapterStatus } from "../../extensions/acceptance-language-adapters.js";
import {
  MAX_PERFORMANCE_MUTATIONS_PER_REVISION,
  MAX_PERFORMANCE_REPAIR_PATHS,
  MAX_PERFORMANCE_REPAIR_REVISIONS
} from "../session/runtime-state.ts";
import type { PerformanceReviewCheckpoint, PerformanceReviewToolKind } from "../session/runtime-state.ts";

export type PerformanceAssuranceTier = "fast" | "balanced" | "rigorous";

export type PerformanceAssurancePlan = {
  tier: PerformanceAssuranceTier;
  requiresReview: boolean;
  reasonCodes: string[];
  reviewChecks: string[];
};

type AssuranceInput = { request: string; changeMode?: TaskContract["changeMode"]; paths?: string[] };

type PerformanceReviewToolInput = {
  toolName: string;
  input?: unknown;
  checkpoint?: PerformanceReviewCheckpoint;
  task?: Pick<TaskContract, "verifyCommands">;
  currentWorkingTreeDigest?: string;
  currentPhase?: string | null;
  targetPaths?: string[];
};

export type BoundedGitDiffReview = {
  command: string;
  reviewedPaths: string[];
};

type ParsedBoundedGitDiff = {
  command: string;
  pathspecs: string[];
  noIndexPaths: string[];
};

type BoundedGitDiffReviewInput = {
  toolName: string;
  input?: unknown;
  changedFiles: string[];
  outputText: string;
  authoredFileDigests?: Record<string, string>;
  currentFileDigests?: Record<string, string>;
};

const SIGNALS: Array<{ code: string; pattern: RegExp }> = [
  { code: "exact-error-contract", pattern: /\b(?:typeerror|syntaxerror|rangeerror|error (?:class|containing))\b/i },
  { code: "boundary-contract", pattern: /\b(?:backpressure|boundary|budget|capacity|ceil(?:ing)?|clamp|inclusive|minimum|maximum|maxchars|overflow|round(?:ing)?|safe[-\s]+integer|basis points?|positive integer|non-negative|falsey|falsy|nullish)\b/i },
  { code: "return-shape-contract", pattern: /\b(?:return shape|returned? (?:element|object|value|representation)s?|preserve (?:the )?return)\b/i },
  { code: "public-api-contract", pattern: /\b(?:exported api|public api|do not change (?:the )?(?:api|signature)|preserve (?:the )?(?:api|input|output|return)|without changing unrelated behavior)\b/i },
  { code: "graph-order-contract", pattern: /\b(?:dependency|topolog|cycle|stable order|input order|first[-\s]+(?:observed|seen|encountered)[-\s]+order|replay order|deduplicat(?:e|ion).*order|exactly once|before its dependent)\b/i },
  { code: "identity-isolation-contract", pattern: /\b(?:auth(?:orization)?|unauthoriz(?:ed|ation)|permission|cache[- ]?key|collision|same tuple|cross[- ]tenant|same[- ]tenant|tenant boundary|tenant[- ]scoped (?:cache|storage))\b/i },
  { code: "concurrency-contract", pattern: /\b(?:concurren|race condition|stale response|bounded retry|idempot(?:ent|ency)?|lock)\b/i },
  { code: "data-migration-contract", pattern: /\b(?:migration|schema|money|invoice|ledger|transaction|data loss)\b/i },
  { code: "non-mutation-contract", pattern: /\b(?:do not mutate|must not mutate|without mutating|input unchanged|preserve input)\b/i }
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function namedEntrypoints(request: string): number {
  return new Set([...String(request ?? "").matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((match) => match[1])).size;
}

function assuranceText(task: TaskContract): string {
  return [
    task.summary,
    task.expectedOutput,
    ...(Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [])
  ].filter(Boolean).join("\n");
}

/**
 * Classify how much harness-side review a task needs without selecting a model.
 * The classifier intentionally uses auditable semantic signals rather than
 * benchmark scenario IDs or hidden expected answers.
 */
export function analyzePerformanceAssurance(input: AssuranceInput): PerformanceAssurancePlan {
  const request = String(input.request ?? "").trim();
  if (input.changeMode === "read-only") {
    return { tier: "fast", requiresReview: false, reasonCodes: ["read-only"], reviewChecks: [] };
  }
  if (Array.isArray(input.paths)) {
    const adapter = acceptanceLanguageAdapterStatus(input.paths);
    if (!adapter.proofCapable) return {
      tier: "fast", requiresReview: false,
      reasonCodes: [`${adapter.status}-language-abstain`], reviewChecks: []
    };
  }

  const reasonCodes = SIGNALS.filter((signal) => signal.pattern.test(request)).map((signal) => signal.code);
  if (/\b(?:tenants?|tenantid)\b/i.test(request) && /\bisolat(?:e|ed|es|ing|ion)\b/i.test(request)) {
    reasonCodes.push("identity-isolation-contract");
  }
  if (request.length >= 320) reasonCodes.push("long-contract");
  if (namedEntrypoints(request) > 1) reasonCodes.push("multiple-entrypoints");
  const exactnessSignals = reasonCodes.filter((code) => [
    "exact-error-contract",
    "boundary-contract",
    "return-shape-contract",
    "public-api-contract",
    "graph-order-contract",
    "identity-isolation-contract",
    "concurrency-contract",
    "data-migration-contract",
    "non-mutation-contract"
  ].includes(code)).length;
  const reviewRequired = reasonCodes.some((code) => [
    "concurrency-contract",
    "graph-order-contract",
    "return-shape-contract"
  ].includes(code));
  const tier: PerformanceAssuranceTier = reviewRequired || exactnessSignals >= 2 || reasonCodes.includes("long-contract")
    ? "rigorous"
    : exactnessSignals === 1 || namedEntrypoints(request) > 0
      ? "balanced"
      : "fast";

  const reviewChecks = [
    "Compare the final diff with the complete operator request; do not review from a truncated summary.",
    "Inspect removed and added lines to preserve the pre-change public input/output representation unless the request explicitly changes it.",
    "Reject tests that merely ratify an accidental new behavior; focused tests must prove the requested observable contract."
  ];
  if (reasonCodes.includes("exact-error-contract")) {
    reviewChecks.push(/\btypeerror\b/i.test(request)
      ? "Check every invalid partition against the exact requested error class; RangeError and TypeError are not interchangeable."
      : "Check every failure partition against the exact requested error class and message contract.");
  }
  if (reasonCodes.includes("boundary-contract")) {
    reviewChecks.push("Check zero, fractional, negative, exact, partial, minimum, maximum, and nearest-outside boundaries where applicable.");
  }
  if (reasonCodes.includes("graph-order-contract")) {
    reviewChecks.push("Check dependency direction, stable ordering, cycle handling, external references, uniqueness, non-mutation, and the returned element representation.");
  }
  if (reasonCodes.includes("identity-isolation-contract")) {
    reviewChecks.push("Check allow/deny or storage isolation across distinct identities, including delimiter-like values that could collide when concatenated.");
  }
  if (reasonCodes.includes("data-migration-contract")) {
    reviewChecks.push("Check operation order, rounding/defaulting points, falsey values, and validation before declaring data behavior complete.");
  }
  reviewChecks.push(...acceptanceBoundaryProofGuidance(request));

  return {
    tier,
    requiresReview: reviewRequired,
    reasonCodes: unique(reasonCodes.length > 0 ? reasonCodes : ["bounded-source-change"]),
    reviewChecks: unique(reviewChecks).slice(0, 10)
  };
}

export function taskPerformanceAssurance(task: TaskContract): PerformanceAssurancePlan {
  const observed = [...new Set([...(task.changedFiles ?? []), ...(task.observedChangedFiles ?? [])])];
  const paths = observed.length > 0
    ? observed
    : (task.scope ?? []).filter((file) => typeof file === "string" && !/[?*\[\]{}]/.test(file));
  return analyzePerformanceAssurance({ request: assuranceText(task), changeMode: task.changeMode, paths });
}

export function performanceReviewGuidance(task: TaskContract): string[] {
  const plan = taskPerformanceAssurance(task);
  const changedFiles = [...new Set([
    ...(Array.isArray(task.changedFiles) ? task.changedFiles : []),
    ...(Array.isArray(task.observedChangedFiles) ? task.observedChangedFiles : [])
  ])].sort();
  return [
    `Run one ${plan.tier} semantic diff-review before completion.`,
    "Review budget: at most one bounded git diff command and two targeted read/search calls.",
    "Use `git diff --no-ext-diff HEAD -- <bounded paths> && git status --short --untracked-files=all`; append `&& ! git diff --no-index -- /dev/null <exact untracked file>` for each untracked delta file so its content is reviewable.",
    "Do not run a verifier or ad-hoc probe unless the review identifies a concrete contract contradiction.",
    ...(changedFiles.length > 0
      ? [`Review the pre-change and current behavior for: ${changedFiles.slice(0, 12).join(", ")}.`]
      : []),
    ...plan.reviewChecks,
    "If no contradiction is found, stop reviewing and complete immediately. If one is found, name it, make the coordinated in-scope source/test edits required for one bounded revision, then run the exact configured verifier. A high-confidence in-scope verifier failure may open one final corrective revision."
  ];
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellCommand(value: unknown): string {
  const input = inputRecord(value);
  return typeof input.command === "string"
    ? input.command.trim()
    : typeof input.cmd === "string"
      ? input.cmd.trim()
      : "";
}

const SAFE_DIFF_OPTIONS = new Set([
  "--no-ext-diff",
  "--minimal",
  "--patience",
  "--histogram",
  "--no-color",
  "--color=never"
]);

function pathCoveredByReview(file: string, reviewedPaths: string[]): boolean {
  return reviewedPaths.some((candidate) => file === candidate || file.startsWith(`${candidate}/`));
}

function changedPathsWithPatchEvidence(outputText: string): { paths: Set<string>; hunks: Set<string> } {
  const paths = new Set<string>();
  const hunks = new Set<string>();
  let current: string[] = [];
  for (const line of String(outputText ?? "").split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/([^\s]+) b\/([^\s]+)$/);
    if (!header) {
      if (line.startsWith("@@ ")) for (const file of current) hunks.add(file);
      continue;
    }
    current = [];
    for (const rawPath of header.slice(1)) {
      const candidate = normalizePathCandidate(rawPath);
      if (candidate && candidate !== "/dev/null" && !candidate.startsWith("../") && !candidate.startsWith("/")) {
        paths.add(candidate);
        current.push(candidate);
      }
    }
  }
  return { paths, hunks };
}

function untrackedPathsWithStatusEvidence(outputText: string): Set<string> {
  const paths = new Set<string>();
  for (const line of String(outputText ?? "").split(/\r?\n/)) {
    const status = line.match(/^\?\? ([^\r\n]+)$/);
    if (!status) continue;
    const candidate = normalizePathCandidate(status[1]);
    if (candidate && candidate !== "." && candidate !== ".." && !candidate.startsWith("../") && !candidate.startsWith("/")) {
      paths.add(candidate);
    }
  }
  return paths;
}

/**
 * Recognize one deliberately small, non-mutating review transaction. `HEAD` is
 * mandatory so staged and unstaged hunks are reviewed together. Untracked
 * content may be appended only as an exact `/dev/null` no-index diff; `!` turns
 * git-diff's expected exit 1 into shell success, while patch validation below
 * still rejects fatal/no-output executions.
 */
function parseBoundedDiffCommand(command: string): ParsedBoundedGitDiff | undefined {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized || /[\n\r;|`'"\\]|\$\(|\$\{|[<>]/.test(command)) return undefined;
  const segments = normalized.split(/\s+&&\s+/);
  if (segments.length < 2 || segments.length > MAX_PERFORMANCE_REPAIR_PATHS + 2) return undefined;

  const trackedTokens = segments[0].split(" ").filter(Boolean);
  if (trackedTokens[0] !== "git" || trackedTokens[1] !== "diff") return undefined;
  const headIndex = trackedTokens.indexOf("HEAD", 2);
  if (headIndex < 2 || trackedTokens.indexOf("HEAD", headIndex + 1) >= 0) return undefined;
  if (trackedTokens.slice(2, headIndex).some((option) => !SAFE_DIFF_OPTIONS.has(option) && !/^--unified=\d{1,3}$/.test(option))) {
    return undefined;
  }
  if (trackedTokens[headIndex + 1] !== "--") return undefined;
  const rawPaths = trackedTokens.slice(headIndex + 2);
  if (rawPaths.length === 0 || rawPaths.length > MAX_PERFORMANCE_REPAIR_PATHS) return undefined;

  const statusTokens = segments[1].split(" ").filter(Boolean);
  if (
    ![3, 4].includes(statusTokens.length)
    || new Set(statusTokens).size !== statusTokens.length
    || statusTokens[0] !== "git"
    || statusTokens[1] !== "status"
    || !statusTokens.includes("--short")
    || statusTokens.some((token, index) => index > 1 && !["--short", "--untracked-files=all"].includes(token))
  ) return undefined;

  const pathspecs: string[] = [];
  const noIndexPaths: string[] = [];
  const normalizeReviewPath = (rawPath: string): string | undefined => {
    if (!/^[A-Za-z0-9._@%+=:,/-]+$/.test(rawPath)) return undefined;
    const candidate = normalizePathCandidate(rawPath);
    if (
      !candidate
      || candidate === "."
      || candidate === ".."
      || candidate.startsWith("../")
      || candidate.startsWith("/")
      || candidate.startsWith("-")
      || /(?:^|\/)\.git(?:\/|$)/.test(candidate)
    ) return undefined;
    return candidate;
  };
  for (const rawPath of rawPaths) {
    const candidate = normalizeReviewPath(rawPath);
    if (!candidate) return undefined;
    if (!pathspecs.includes(candidate)) pathspecs.push(candidate);
  }
  for (const segment of segments.slice(2)) {
    const tokens = segment.split(" ").filter(Boolean);
    if (
      tokens.length !== 7
      || tokens[0] !== "!"
      || tokens[1] !== "git"
      || tokens[2] !== "diff"
      || tokens[3] !== "--no-index"
      || tokens[4] !== "--"
      || tokens[5] !== "/dev/null"
    ) return undefined;
    const candidate = normalizeReviewPath(tokens[6]);
    if (!candidate || noIndexPaths.includes(candidate)) return undefined;
    noIndexPaths.push(candidate);
  }
  return { command: normalized, pathspecs, noIndexPaths };
}

/**
 * Return reusable pre-handoff review evidence only when an explicit diff
 * covers every currently observed task change, nothing outside that set, and
 * the host result carries a real patch header for every tracked changed file.
 * Status is inventory only: an untracked file also needs an exact no-index
 * content diff and a successful model-authored digest that is still current.
 * Success and current-tree identity are enforced by the tool-result/runtime
 * state boundary, where the host result and working tree are observable.
 */
export function boundedGitDiffReview(input: BoundedGitDiffReviewInput): BoundedGitDiffReview | undefined {
  if (!["bash", "shell", "exec", "exec_command"].includes(String(input.toolName ?? "").toLowerCase())) return undefined;
  const parsed = parseBoundedDiffCommand(shellCommand(input.input));
  if (!parsed) return undefined;
  const changedFiles = [...new Set((input.changedFiles ?? [])
    .map((file) => normalizePathCandidate(file))
    .filter((file) => file && file !== "." && file !== ".." && !file.startsWith("../") && !file.startsWith("/"))
  )].sort();
  if (changedFiles.length === 0) return undefined;
  if (changedFiles.length > MAX_PERFORMANCE_REPAIR_PATHS) return undefined;
  if (!changedFiles.every((file) => pathCoveredByReview(file, parsed.pathspecs))) return undefined;
  if (!parsed.pathspecs.every((candidate) => changedFiles.some((file) => pathCoveredByReview(file, [candidate])))) {
    return undefined;
  }
  const patchEvidence = changedPathsWithPatchEvidence(input.outputText);
  const patchedPaths = patchEvidence.paths;
  const untrackedPaths = untrackedPathsWithStatusEvidence(input.outputText);
  if ([...patchedPaths].some((file) => !changedFiles.includes(file))) return undefined;
  if (parsed.noIndexPaths.some((file) => !changedFiles.includes(file))) return undefined;
  const safeModelAuthoredUntracked = (file: string) => {
    const authoredDigest = input.authoredFileDigests?.[file];
    const currentDigest = input.currentFileDigests?.[file];
    return untrackedPaths.has(file)
      && parsed.noIndexPaths.includes(file)
      && patchedPaths.has(file)
      && patchEvidence.hunks.has(file)
      && typeof authoredDigest === "string"
      && authoredDigest.length > 0
      && authoredDigest === currentDigest;
  };
  if (!changedFiles.every((file) => untrackedPaths.has(file) ? safeModelAuthoredUntracked(file) : patchedPaths.has(file))) return undefined;
  return { command: parsed.command, reviewedPaths: changedFiles };
}

function boundedDiffCommand(command: string): boolean {
  return Boolean(parseBoundedDiffCommand(command));
}

function exactVerifierCommand(command: string, task?: Pick<TaskContract, "verifyCommands">): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (task?.verifyCommands ?? []).some((candidate) => String(candidate).replace(/\s+/g, " ").trim() === normalized);
}

function normalizedPaths(values: string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => normalizePathCandidate(value))
    .filter((value) => value && value !== "." && value !== ".." && !value.startsWith("../") && !value.startsWith("/"))
  )].sort();
}

export function performanceReviewToolKind(input: PerformanceReviewToolInput): PerformanceReviewToolKind | undefined {
  if (!input.checkpoint) return undefined;
  const toolName = String(input.toolName ?? "").toLowerCase();
  if (["edit", "write", "apply_patch"].includes(toolName)) return "mutation";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "inspection";
  if (["bash", "shell", "exec", "exec_command"].includes(toolName)) {
    return input.checkpoint.verifierState === "required" || input.checkpoint.verifierState === "retry-ready"
      ? "verifier"
      : "inspection";
  }
  return undefined;
}

/**
 * Enforce a small, auditable tool budget during the hidden semantic-review
 * continuation. Ordinary implementation remains unrestricted by this budget.
 */
export function performanceReviewToolDecision(input: PerformanceReviewToolInput): { block: true; reason: string } | undefined {
  const { checkpoint } = input;
  if (!checkpoint) return undefined;
  const toolName = String(input.toolName ?? "").toLowerCase();
  if (checkpoint.invalidated) {
    return {
      block: true,
      reason: "Semantic review evidence no longer matches the current working tree. Finish the turn so Piagent can schedule a fresh bounded review."
    };
  }
  if (checkpoint.pendingToolCallId) {
    return {
      block: true,
      reason: "A semantic-review tool call is still pending. Wait for its audited result before starting another review, mutation, or verifier."
    };
  }
  if (input.currentWorkingTreeDigest && checkpoint.workingTreeDigest !== input.currentWorkingTreeDigest) {
    return {
      block: true,
      reason: "Semantic review evidence is stale for the current working-tree digest. Finish the turn and obtain a fresh bounded diff review before mutation."
    };
  }
  if (["edit", "write", "apply_patch"].includes(toolName)) {
    if (input.currentPhase !== undefined && input.currentPhase !== "repair") {
      return { block: true, reason: "Semantic repair mutations are permitted only after Piagent enters the audited repair phase." };
    }
    if (["passed", "retry-ready", "locked"].includes(checkpoint.verifierState)) {
      return { block: true, reason: "Semantic repair is closed for this revision. Use the permitted exact verifier retry or finish with the current bounded handoff." };
    }
    if (checkpoint.revision === 0 && !checkpoint.reviewSatisfied) {
      return { block: true, reason: "Semantic repair requires a successful current-tree bounded diff review before mutation." };
    }
    if (checkpoint.successfulMutationsInRevision >= MAX_PERFORMANCE_MUTATIONS_PER_REVISION) {
      return { block: true, reason: `Semantic repair reached ${MAX_PERFORMANCE_MUTATIONS_PER_REVISION} successful mutations in this revision. Run the exact verifier or hand off.` };
    }
    const reviewedPaths = normalizedPaths(checkpoint.reviewedPaths);
    const targets = normalizedPaths(input.targetPaths);
    if (reviewedPaths.length === 0 || reviewedPaths.length > MAX_PERFORMANCE_REPAIR_PATHS) {
      return { block: true, reason: `Semantic repair requires 1-${MAX_PERFORMANCE_REPAIR_PATHS} explicitly reviewed paths; this change set needs operator-visible decomposition.` };
    }
    if (targets.length === 0 || targets.some((file) => !reviewedPaths.includes(file))) {
      return { block: true, reason: "Semantic repair mutation targets must stay inside the exact paths covered by the successful bounded diff review." };
    }
    return undefined;
  }
  if (["read", "grep", "find", "ls"].includes(toolName)) {
    if (["passed", "retry-ready", "locked"].includes(checkpoint.verifierState)) {
      return { block: true, reason: "Semantic review is closed; finish or run only the explicitly permitted exact verifier retry." };
    }
    if (checkpoint.inspectionCalls < 2) return undefined;
    return {
      block: true,
      reason: "Semantic review read budget is complete. Finish the current bounded revision or hand off the remaining uncertainty."
    };
  }
  if (["bash", "shell", "exec", "exec_command"].includes(toolName)) {
    const command = shellCommand(input.input);
    if (checkpoint.verifierState === "passed" || checkpoint.verifierState === "locked") {
      return { block: true, reason: "Semantic review is closed; repeated verification or ad-hoc shell probing is not permitted." };
    }
    if (checkpoint.verifierState === "retry-ready") {
      if (input.currentPhase !== undefined && input.currentPhase !== "repair") {
        return { block: true, reason: "The exact verifier retry is permitted only from the audited repair phase." };
      }
      if (!checkpoint.transientRetryUsed && exactVerifierCommand(command, input.task)) return undefined;
      return { block: true, reason: "A retryable infrastructure failure permits one same-digest exact verifier retry and no mutation or ad-hoc command." };
    }
    if (checkpoint.verifierState === "required") {
      if (input.currentPhase !== undefined && input.currentPhase !== "repair") {
        return { block: true, reason: "The exact semantic-repair verifier is permitted only from the audited repair phase." };
      }
      if (
        checkpoint.successfulMutationsInRevision > 0
        && checkpoint.verifierCallsInRevision === 0
        && exactVerifierCommand(command, input.task)
      ) return undefined;
      return {
        block: true,
        reason: "Finish the coordinated semantic repair revision, then run its exact configured verifier once; ad-hoc or repeated verification is not permitted."
      };
    }
    if (!checkpoint.mutationObserved) {
      if (input.currentPhase !== undefined && !["verify", "review"].includes(String(input.currentPhase))) {
        return { block: true, reason: "A bounded semantic diff review is permitted only from the audited verify/review phase." };
      }
      if (checkpoint.shellInspectionCalls === 0 && boundedDiffCommand(command)) return undefined;
      return {
        block: true,
        reason: "Semantic review permits one bounded git diff command and no verifier or ad-hoc probe before a concrete contradiction is found."
      };
    }
    return {
      block: true,
      reason: "The failed verifier opened a bounded corrective revision. Apply only the evidence-backed in-scope correction before re-running the exact verifier."
    };
  }
  return {
    block: true,
    reason: "This semantic-review continuation is limited to bounded diff/read inspection, reviewed in-scope edits, and one exact verifier per bounded revision."
  };
}
