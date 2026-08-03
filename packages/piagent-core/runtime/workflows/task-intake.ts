import { classifyContextTask } from "../../extensions/context-engine.js";
import { matchesProtectedPath, normalizePathCandidate } from "../../extensions/policy-core.js";
import type { ReviewLens } from "../../extensions/guard-types.js";
import { LONG_INPUT_CHARS } from "../runtime-limits.ts";

const AUTO_INTAKE_MAX_PROMPT_CHARS = 700;
const AUTO_INTAKE_CHANGE_INTENT = /\b(?:add|build|change|correct|create|fix|implement|modify|refactor|remove|rename|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b/i;
const AUTO_INTAKE_READ_ONLY_LEAD = /^\s*\/?(?:analy[sz]e|audit|check|discuss|explain|inspect|plan|research|review|scout|summari[sz]e|why|how|can\s+(?:you|we)|kiem tra|nghien cuu|giai thich|danh gia)\b/i;
const AUTO_INTAKE_MANUAL_RISK = /\b(?:credential|database|deploy|destructive|encryption|external provider|migration|payment|permission|production|publish|release|secret|schema migration|token rotation)\b/i;

export const AUTO_INTAKE_SNAPSHOT_PATTERNS = [
  "src/**", "app/**", "lib/**", "packages/**", "test/**", "tests/**", "spec/**", "__tests__/**"
];

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function automaticTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > AUTO_INTAKE_MAX_PROMPT_CHARS) return false;
  const signal = classifyContextTask(text);
  if (signal.workflow !== "task" || !AUTO_INTAKE_CHANGE_INTENT.test(text)) return false;
  if (AUTO_INTAKE_READ_ONLY_LEAD.test(text) || AUTO_INTAKE_MANUAL_RISK.test(text)) return false;
  if (/\bpiagent_task_start\b/i.test(text)) return false;
  return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
}

export function manualTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > LONG_INPUT_CHARS) return false;
  const signal = classifyContextTask(text);
  if (signal.workflow !== "task" || !AUTO_INTAKE_CHANGE_INTENT.test(text)) return false;
  if (AUTO_INTAKE_READ_ONLY_LEAD.test(text) || /\bpiagent_task_start\b/i.test(text)) return false;
  if (signal.paths.length === 0) return true;
  return signal.paths.some((candidate) => !matchesProtectedPath(candidate, readProtectedPaths));
}

export function automaticTaskScope(prompt: string, context: Array<{ path: string }>): string[] {
  const signal = classifyContextTask(prompt);
  const explicit = signal.paths.filter((candidate) => candidate && candidate !== "." && !candidate.startsWith(".pi/"));
  const navigated = context
    .map((item) => normalizePathCandidate(item.path))
    .filter((candidate): candidate is string => Boolean(
      candidate
      && candidate !== "."
      && !candidate.startsWith(".pi/")
      && !["AGENTS.md", "README.md", "REVIEW_GUIDELINES.md"].includes(candidate)
      && /^(?:app|lib|packages|spec|src|test|tests|__tests__)\//.test(candidate)
    ))
    .slice(0, 8);
  const scope = uniqueStrings([...explicit, ...navigated]);
  if (scope.length === 0) scope.push("src/**", "app/**", "lib/**");
  if (/\b(?:test|tests|verification|verify|kiem thu)\b/i.test(prompt)) {
    scope.push("test/**", "tests/**", "spec/**", "__tests__/**");
  }
  return uniqueStrings(scope);
}

export function automaticReviewLenses(prompt: string): ReviewLens[] {
  const lenses: ReviewLens[] = ["correctness", "tests", "scope"];
  if (/\b(?:auth|authorization|credential|permission|security|session|secret|xac thuc|phan quyen|bao mat)\b/i.test(prompt)) {
    lenses.push("security");
  }
  return lenses;
}

export function validTaskScopePattern(value: string): boolean {
  const candidate = String(value ?? "").trim().replaceAll("\\", "/");
  if (!candidate || /\s|\0/.test(candidate)) return false;
  if (candidate.startsWith("/") || candidate.startsWith("~/") || /^[A-Za-z]:\//.test(candidate)) return false;
  return !candidate.split("/").includes("..");
}
