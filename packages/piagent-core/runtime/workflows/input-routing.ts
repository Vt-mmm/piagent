import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { LONG_INPUT_CHARS, MAX_INLINE_COLLAPSED_TASK_CHARS } from "../runtime-limits.ts";

export type FreshWorkflow = "task" | "scout" | "be-to-fe";

export function looksLikeGovernedBoilerplate(text: string): boolean {
  const lower = text.toLowerCase();
  const markers = [
    "mandatory flow",
    "piagent_context",
    "piagent_task_start",
    "piagent_context_record",
    "piagent_verify_record",
    "piagent_task_gate_check",
    "output format"
  ];
  return markers.filter((marker) => lower.includes(marker)).length >= 3;
}

function extractFencedBlockAfter(label: RegExp, text: string): string | undefined {
  const labelMatch = label.exec(text);
  if (!labelMatch || labelMatch.index === undefined) return undefined;
  const rest = text.slice(labelMatch.index + labelMatch[0].length);
  const fenced = /```(?:text|md|markdown)?\s*([\s\S]*?)```/i.exec(rest);
  return fenced?.[1]?.trim();
}

export function stripLeadingWorkflowCommand(input: string): string {
  return input
    .replace(/^\/(?:piagent-workflow|workflow)\s+(?:task|scout|be-to-fe|review|plan|platform-improve|discuss|commit|pr)\b\s*/i, "")
    .replace(/^\/(?:task|scout|be-to-fe|review|plan|platform-improve|discuss|commit|pr)\b\s*/i, "")
    .trim();
}

export function extractTaskRequest(text: string): string {
  const labeled =
    extractFencedBlockAfter(/(?:implement|scout|review|plan)\s+(?:this\s+)?task\s*:?\s*/i, text) ??
    extractFencedBlockAfter(/request\s*:?\s*/i, text);
  if (labeled) return stripLeadingWorkflowCommand(labeled);

  const firstFence = /```(?:text|md|markdown)?\s*([\s\S]*?)```/i.exec(text);
  if (firstFence?.[1]?.trim()) return stripLeadingWorkflowCommand(firstFence[1].trim());

  return stripLeadingWorkflowCommand(text.trim());
}

export function trimTaskForInline(input: string): string {
  const normalized = stripLeadingWorkflowCommand(input).trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= MAX_INLINE_COLLAPSED_TASK_CHARS) return normalized;
  return `${normalized.slice(0, MAX_INLINE_COLLAPSED_TASK_CHARS).trim()}\n\n[Input truncated by piagent preflight. Put the full spec in a project file and reference that file.]`;
}

export function chooseFreshWorkflow(original: string, task: string): FreshWorkflow {
  const semantic = stripLeadingWorkflowCommand(task || original).toLowerCase();
  const starts = original.trim().toLowerCase();
  const workflowStart = starts.match(/^\/(?:piagent-workflow|workflow)\s+(task|scout|be-to-fe)\b/);
  if (workflowStart?.[1] === "be-to-fe") return "be-to-fe";
  if (workflowStart?.[1] === "scout") return "scout";
  if (workflowStart?.[1] === "task") return "task";
  if (starts.startsWith("/be-to-fe")) return "be-to-fe";
  if (starts.startsWith("/scout")) return "scout";
  const asksForWrite = /\b(implement|support|surface|consume|write|change|fix)\b/.test(semantic);
  if (/\b(scout|read-only|read only|audit|mapping|mapping matrix|map contract)\b/.test(semantic) && !asksForWrite) {
    return "scout";
  }
  if (/\b(be|backend)\b/.test(semantic) && /\b(fe|frontend)\b/.test(semantic) && asksForWrite) {
    return "be-to-fe";
  }
  return "task";
}

export function isPiagentWorkflowInput(text: string): boolean {
  return /^\/(?:piagent-workflow|workflow|task|be-to-fe|scout|review|plan|platform-improve)\b/i.test(text.trim());
}

export function isFreshOrUtilityInput(text: string): boolean {
  return /^\/(?:usage|logs|context|commands|permission|memory|onboard|name|fresh|fresh-task|fresh-scout|fresh-be-to-fe|task-preflight|piagent-usage|piagent-logs|piagent-session|piagent-context|piagent-commands|piagent-permission|model-options|memory-policy|onboard-project|setname|session|compact)\b/i.test(text.trim());
}

function taskInboxDir(cwd: string): string {
  return path.join(cwd, ".pi", "task-inbox");
}

function writeTaskInbox(cwd: string, workflow: string, text: string): string {
  fs.mkdirSync(taskInboxDir(cwd), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeWorkflow = workflow.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "task";
  const fileName = `${stamp}-${safeWorkflow}.md`;
  const absolute = path.join(taskInboxDir(cwd), fileName);
  fs.writeFileSync(absolute, `${redactSensitiveText(text).text}\n`);
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

export function buildFreshCommand(cwd: string, workflow: FreshWorkflow, originalText: string, reason: string): string {
  const task = extractTaskRequest(originalText);
  if (originalText.length >= LONG_INPUT_CHARS) {
    const intakePath = writeTaskInbox(cwd, workflow, originalText);
    return `/fresh ${workflow} Read task intake from ${intakePath}. ${reason}`;
  }
  return `/fresh ${workflow} ${trimTaskForInline(task)}`;
}

export function shortTaskLabel(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^A-Za-z0-9\u00C0-\u1EF9_-]+/g, " ")
    .trim()
    .slice(0, 64);
  return compact || "piagent task";
}
