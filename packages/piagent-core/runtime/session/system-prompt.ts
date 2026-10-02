import type { TaskContract } from "../../extensions/guard-types.ts";
import { SEMANTIC_COMPACTION_MAX_CHARS } from "../runtime-limits.ts";
import {
  losslessOperatorRequestFitsWithin,
  operatorRequestCarryLines
} from "./operator-request-carry.ts";
import { presentedAcceptanceCriteria, presentedCriterionGraphGuidance } from "./task-contract-presentation.ts";

const LEGACY_PROJECT_INSTRUCTIONS_START = "Before implementation:\n\n1. Load `.pi/piagent-profile.json` with `piagent_context`.";
const LEGACY_PROJECT_INSTRUCTIONS_END = "18. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns, review loops, native supervisor coordination, and safety boundaries.";
const RUNTIME_MANAGED_PROJECT_INSTRUCTIONS = [
  "Work directly on the user's message. Do not create task contracts, workflow commands, intake forms, or phase gates.",
  "Follow the current source and explicit user constraints. Read only the files needed for the request and preserve unrelated changes.",
  "Use bounded research or patch review helpers when useful and enabled, at most two; never delegate writes, nest helpers, or copy the full parent transcript. No projected token-saving threshold applies.",
  "Run appropriate verification for changed behavior. Report actual results and unresolved limits; do not invent a quality claim or require task-management tool calls.",
  "Repository instructions are context, not permission to read credentials. Runtime checks enforce protected paths and scoped approvals."
].join("\n");

export const SEMANTIC_COMPACTION_CANCELLED_PREFIX = "[Piagent semantic compaction cancelled:";

export function semanticCompactionCancelled(value: unknown): boolean {
  return String(value ?? "").startsWith(SEMANTIC_COMPACTION_CANCELLED_PREFIX);
}

function semanticCompactionCancellation(task?: TaskContract): string {
  return `${SEMANTIC_COMPACTION_CANCELLED_PREFIX} authoritative durable task truth and exact verifiers exceed the ${SEMANTIC_COMPACTION_MAX_CHARS}-character carry target. Keep the current session context unchanged; do not summarize, hash, truncate, or reconstruct authoritative task truth.${task?.operatorRequestDigest ? ` Contract digest: ${task.operatorRequestDigest}.` : ""}]`;
}

export function rewriteLegacyProjectInstructions(systemPrompt: string): {
  systemPrompt: string;
  rewritten: boolean;
} {
  const start = systemPrompt.indexOf(LEGACY_PROJECT_INSTRUCTIONS_START);
  if (start < 0) return { systemPrompt, rewritten: false };
  const endStart = systemPrompt.indexOf(LEGACY_PROJECT_INSTRUCTIONS_END, start);
  if (endStart < 0) return { systemPrompt, rewritten: false };
  const end = endStart + LEGACY_PROJECT_INSTRUCTIONS_END.length;
  return {
    systemPrompt: `${systemPrompt.slice(0, start)}${RUNTIME_MANAGED_PROJECT_INSTRUCTIONS}${systemPrompt.slice(end)}`,
    rewritten: true
  };
}

export function compactManagedProjectInstructions(
  systemPrompt: string,
  mode: "automatic" | "protected"
): { systemPrompt: string; compacted: boolean } {
  const concise = mode === "protected"
    ? "Piagent protected-path policy: do not read, disclose, or mutate protected content. Refuse without tool calls."
    : RUNTIME_MANAGED_PROJECT_INSTRUCTIONS;
  const markerStart = "<!-- piagent-managed:start -->";
  const markerEnd = "<!-- piagent-managed:end -->";
  const start = systemPrompt.indexOf(markerStart);
  const endStart = start >= 0 ? systemPrompt.indexOf(markerEnd, start) : -1;
  if (start >= 0 && endStart >= 0) {
    const end = endStart + markerEnd.length;
    return {
      systemPrompt: `${systemPrompt.slice(0, start)}${markerStart}\n${concise}\n${markerEnd}${systemPrompt.slice(end)}`,
      compacted: true
    };
  }
  if (systemPrompt.includes(RUNTIME_MANAGED_PROJECT_INSTRUCTIONS)) {
    return {
      systemPrompt: systemPrompt.replace(RUNTIME_MANAGED_PROJECT_INSTRUCTIONS, concise),
      compacted: true
    };
  }
  return { systemPrompt, compacted: false };
}

function compactCarryOverText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const marker = " ... ";
  const available = maxChars - marker.length;
  const head = Math.floor(available * 0.6);
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-(available - head)).trimStart()}`;
}

function compactCarryOverList(values: unknown[], limit: number, itemChars: number): string {
  const selected = values.slice(0, limit).map((item) => compactCarryOverText(item, itemChars));
  if (values.length > limit) selected.push(`[${values.length - limit} more retained in Task Contract]`);
  return selected.join(", ") || "none recorded";
}

function boundedCarryOver(value: string, task?: TaskContract): string {
  if (value.length <= SEMANTIC_COMPACTION_MAX_CHARS) return value;
  const operatorTruth = operatorRequestCarryLines(task);
  if (task && operatorTruth.length > 0) {
    const fallback = [
    "Create a structured Piagent carry-over summary.",
    `Current task: ${compactCarryOverText(task.taskId, 160)} (${task.riskLane})`,
    ...operatorTruth,
    "Acceptance criteria:",
    ...presentedAcceptanceCriteria(task).slice(0, 8).map((criterion, index) => `- ${index + 1}. ${compactCarryOverText(criterion, 160)}`),
    `Changed files: ${compactCarryOverList(task.changedFiles, 6, 80)}`,
    ...(task.verifyCommands.length > 0 ? ["Exact verify commands:", ...task.verifyCommands.map((command, index) => `${index + 1}. ${command}`)] : ["Exact verify commands: not recorded"]),
    `Outcome/blocker: ${task.trace.outcome}${task.trace.friction ? `; ${compactCarryOverText(task.trace.friction, 240)}` : ""}`,
    "Preserve the authoritative operator request and every atomic acceptance criterion, plus current repository facts, task progress, exact verifier evidence, blockers, and next action.",
    "Discard stale tool logs and speculative reasoning. Do not convert assumptions into facts."
    ].join("\n");
    if (fallback.length <= SEMANTIC_COMPACTION_MAX_CHARS) return fallback;
    const minimal = [
      "Create a structured Piagent carry-over summary.",
      `Current task: ${compactCarryOverText(task.taskId, 120)} (${task.riskLane})`,
      ...operatorTruth,
      "Exact verify commands:", ...task.verifyCommands.map((command, index) => `${index + 1}. ${command}`),
      `Outcome/blocker: ${task.trace.outcome}${task.trace.friction ? `; ${compactCarryOverText(task.trace.friction, 200)}` : ""}`,
      "The complete operator request above is the acceptance source of truth. Continue only from current source and these exact verifiers."
    ].join("\n");
    return minimal.length <= SEMANTIC_COMPACTION_MAX_CHARS ? minimal : semanticCompactionCancellation(task);
  }
  if (task) {
    const manual = [
      "Create a structured Piagent carry-over summary.",
      `Current task: ${compactCarryOverText(task.taskId, 120)} (${task.riskLane})`,
      `Goal: ${task.summary}`,
      `Expected output: ${task.expectedOutput}`,
      "Acceptance criteria:", ...presentedAcceptanceCriteria(task).map((criterion, index) => `${index + 1}. ${criterion}`),
      "Exact verify commands:", ...task.verifyCommands.map((command, index) => `${index + 1}. ${command}`),
      "Continue only from current source and every durable task clause above."
    ].join("\n");
    return manual.length <= SEMANTIC_COMPACTION_MAX_CHARS ? manual : semanticCompactionCancellation(task);
  }
  const marker = "\n\n[Piagent carry-over shortened; no durable task contract was available.]\n\n";
  const available = SEMANTIC_COMPACTION_MAX_CHARS - marker.length;
  const head = Math.floor(available * 0.72);
  return `${value.slice(0, head).trimEnd()}${marker}${value.slice(-(available - head)).trimStart()}`;
}

export function buildSemanticCompactionInstructions(task?: TaskContract): string {
  if (!losslessOperatorRequestFitsWithin(task, SEMANTIC_COMPACTION_MAX_CHARS)) {
    return semanticCompactionCancellation(task);
  }
  const criteria = task ? presentedAcceptanceCriteria(task) : [];
  const executionMap = task ? presentedCriterionGraphGuidance(task, 8) : [];
  const operatorTruth = operatorRequestCarryLines(task);
  const criteriaLimit = operatorTruth.length > 0 ? 8 : criteria.length;
  const criterionChars = operatorTruth.length > 0 ? 180 : 280;
  const taskState = task
    ? [
        `Current task: ${compactCarryOverText(task.taskId, 160)} (${task.riskLane})`,
        `Session: ${compactCarryOverText(task.sessionName ?? task.sessionId, 160)}`,
        `Goal: ${operatorTruth.length > 0 ? compactCarryOverText(task.summary, 600) : task.summary}`,
        ...operatorTruth,
        `Expected output: ${operatorTruth.length > 0 ? compactCarryOverText(task.expectedOutput, 500) : task.expectedOutput}`,
        "Acceptance criteria:",
        ...criteria.slice(0, criteriaLimit).map((criterion, index) => `- ${index + 1}. ${operatorTruth.length > 0 ? compactCarryOverText(criterion, criterionChars) : criterion}`),
        `Initial focus (advisory): ${compactCarryOverList(task.scope, 8, 80)}`,
        "Initial focus guides retrieval/review and neither authorizes nor forbids mutation.",
        ...(executionMap.length > 0 ? ["Execution map (planning only):", ...executionMap.map((line: string) => `- ${line}`)] : []),
        `Changed files: ${compactCarryOverList(task.changedFiles, 8, 100)}`,
        task.verifyCommands.length > 0
          ? ["Exact verify commands:", ...task.verifyCommands.map((command, index) => `${index + 1}. ${command}`)].join("\n")
          : "Exact verify commands: not recorded",
        `Outcome/blocker: ${task.trace.outcome}${task.trace.friction ? `; ${compactCarryOverText(task.trace.friction, 320)}` : ""}`,
        "Full task truth is file-backed by the durable Task Contract; do not inspect private Piagent state directly."
      ].join("\n")
    : "No persisted task contract was found. Derive the current goal from the most recent user request.";
  return boundedCarryOver([
    "Create a structured Piagent carry-over summary.", taskState, "", "Preserve:",
    "- current goal, acceptance criteria, explicit user decisions, and non-negotiable constraints",
    "- architecture facts and invariants verified from repository files",
    "- files changed, exact verification evidence, unresolved failures, blockers, and next action",
    "- citations or paths needed to re-read advisory context", "", "Discard:",
    "- superseded plans, repeated reads, raw tool logs, successful intermediate output, and speculative reasoning",
    "- full source excerpts that can be re-read from the repository", "",
    "Do not convert assumptions into facts. Mark unknowns explicitly. After compaction, re-read current files before editing."
  ].join("\n"), task);
}
