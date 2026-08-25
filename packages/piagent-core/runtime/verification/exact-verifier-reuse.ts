import crypto from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { extractShellCommandInput, normalizeShellCommandForPolicy } from "../../extensions/guard-shell-analysis.ts";
import { commandMatchesVerifyPlan } from "../../extensions/runtime-evidence.js";
import { passingVerifyCommandsForDigest } from "../../extensions/task-contract-view.js";
import {
  workingTreeSnapshot,
  workingTreeSnapshotHasUnavailableEvidence
} from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";

const SHELL_TOOLS = new Set(["bash", "shell", "exec"]);
const REUSE_COMMAND = "printf '%s\\n' 'Piagent reused exact verifier evidence for the unchanged working tree; the verifier was not rerun.'";

export type ExactVerifierReuseDecision = {
  reused: boolean;
  reasonCode: string;
  commandDigest: string | null;
  workingTreeDigest: string | null;
};

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, any>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
}

function latestOperatorText(entries: unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, any> | undefined;
    if (entry?.type === "message" && entry.message?.role === "user") return messageText(entry.message);
  }
  return "";
}

export function operatorExplicitlyRequestedVerifierExecution(entries: unknown[]): boolean {
  const value = latestOperatorText(entries).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(rerun|run again|test again|verify again|one more run|final run|last run)\b/.test(value)
    || /\b(run|execute)\b[^\n]{0,80}\b(test|tests|verify|verifier|lint|typecheck|build)\b/.test(value)
    || /\b(chay lai|test lai|verify lai|kiem tra lai|kiem thu lai|lan cuoi|chay (?:mot|1) lan nua)\b/.test(value)
    || /\b(chay|thuc hien)\b[^\n]{0,80}\b(test|kiem thu|verify|verifier|lint|typecheck|build)\b/.test(value);
}

export function evaluateExactVerifierReuse(input: {
  task?: TaskContract;
  toolName: string;
  toolInput: Record<string, unknown>;
  workingTreeDigest: string | null;
  sessionEntries?: unknown[];
}): ExactVerifierReuseDecision {
  const no = (reasonCode: string): ExactVerifierReuseDecision => ({ reused: false, reasonCode, commandDigest: null, workingTreeDigest: input.workingTreeDigest });
  const task = input.task;
  if (!task || task.trace.outcome !== "pending" || task.changeMode !== "source-change") return no("no-pending-source-task");
  if (!SHELL_TOOLS.has(input.toolName)) return no("not-shell-tool");
  if (operatorExplicitlyRequestedVerifierExecution(input.sessionEntries ?? [])) return no("operator-requested-execution");
  if (Object.hasOwn(input.toolInput, "args") && Array.isArray(input.toolInput.args) && input.toolInput.args.length > 0) return no("shell-args-present");
  const extracted = extractShellCommandInput(input.toolInput);
  if (!extracted.command || extracted.reason) return no("shell-command-unavailable");
  const command = normalizeShellCommandForPolicy(extracted.command);
  if (!commandMatchesVerifyPlan(command, task.verifyCommands)) return no("not-exact-verifier");
  const passing = passingVerifyCommandsForDigest(task, input.workingTreeDigest);
  const exactVerifier = task.verifyCommands.find((candidate) => (
    passing.has(candidate.trim())
    && commandMatchesVerifyPlan(command, [candidate])
  ));
  if (!exactVerifier) return no("current-tree-pass-missing");
  const field = typeof input.toolInput.command === "string" ? "command" : typeof input.toolInput.cmd === "string" ? "cmd" : null;
  if (!field) return no("mutable-command-field-missing");
  input.toolInput[field] = REUSE_COMMAND;
  return {
    reused: true,
    reasonCode: "current-tree-exact-verifier-reused",
    commandDigest: crypto.createHash("sha256").update(exactVerifier.trim()).digest("hex"),
    workingTreeDigest: input.workingTreeDigest
  };
}

export function reuseCurrentTreeExactVerifier(input: {
  cwd: string;
  task?: TaskContract;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionEntries?: unknown[];
}): ExactVerifierReuseDecision {
  if (!input.task || !SHELL_TOOLS.has(input.toolName)) {
    return { reused: false, reasonCode: "not-applicable", commandDigest: null, workingTreeDigest: null };
  }
  const extracted = extractShellCommandInput(input.toolInput);
  const command = extracted.command ? normalizeShellCommandForPolicy(extracted.command) : "";
  if (!command || !commandMatchesVerifyPlan(command, input.task.verifyCommands)) {
    return { reused: false, reasonCode: "not-exact-verifier", commandDigest: null, workingTreeDigest: null };
  }
  const snapshot = workingTreeSnapshot(input.cwd) as Record<string, string>;
  const workingTreeDigest = workingTreeSnapshotHasUnavailableEvidence(snapshot)
    ? null
    : workingTreeEvidenceDigest(snapshot);
  return evaluateExactVerifierReuse({ ...input, workingTreeDigest });
}
