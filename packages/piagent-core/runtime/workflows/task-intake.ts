import { classifyContextTask } from "../../extensions/context-engine.js";
import { acceptanceContractConjuncts } from "../../extensions/acceptance-contract-conjunction.js";
import { matchesProtectedPath, normalizePathCandidate } from "../../extensions/policy-core.js";
import type { ReviewLens } from "../../extensions/guard-types.js";
import { LONG_INPUT_CHARS } from "../runtime-limits.ts";
import { classifyConditionalRepairIntent } from "./task-repair-intent.ts";
import {
  foldChangeIntent,
  hasChangeIntent,
  isExplicitChangeRequest,
  isLightweightNonAuthorizingChangeLanguage,
  isNonAuthorizingChangeLanguage
} from "./change-clarification.ts";
import {
  completedFollowupScope,
  hasConditionalRepairIntent,
  type PriorTaskScopeEvidence
} from "./task-followup-policy.ts";
export { boundedRuntimeIntakeMessage } from "./runtime-intake-compaction.ts";
export { resolveTaskScopePatterns } from "./task-scope-resolution.ts";
export type { TaskScopeResolution } from "./task-scope-resolution.ts";

const AUTO_INTAKE_MAX_PROMPT_CHARS = LONG_INPUT_CHARS;
const AUTO_TASK_SUMMARY_CHARS = 700;
const AUTO_ACCEPTANCE_CRITERION_CHARS = 600;
const AUTO_ACCEPTANCE_CRITERIA_MAX = 12;
const AUTO_INTAKE_READ_ONLY_LEAD = /^\s*\/?(?:analy[sz]e|audit|check|discuss|explain|inspect|plan|research|review|scout|summari[sz]e|why|how|can\s+(?:you|we)|kiem tra|nghien cuu|giai thich|danh gia)\b/i;
const AUTO_INTAKE_MANUAL_RISK = /\b(?:credential|database|deploy|destructive|encryption|external provider|payment|permission|production|publish|secret|token rotation)\b/i;
const AUTO_READ_ONLY_INTENT = /\b(?:analy[sz]e|audit|check|diagnos(?:e|is)|explain|inspect|investigate|plan|research|review|scout|summari[sz]e|triage|kiem tra|nghien cuu|giai thich|danh gia)\b/i;
// Candidate wording is separated from the following qualifier. This keeps a
// durable zero-delta instruction distinct from local path authority and from a
// temporary "inspect first, edit later" instruction.
const AUTO_NO_MUTATION_CANDIDATES = [
  /\b(?:do not|don't|must not|never)\s+(?:edit|change|modify|mutate|touch|write(?:\s+to)?)(?:\s+(?:or|and)\s+create)?\s+(?:(?:any|all|the|this|entire)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?|anything)\b/i,
  /\b(?:do not|don't|must not|never)\s+create\s+(?:or|and)\s+(?:edit|change|modify|mutate|touch|write(?:\s+to)?)\s+(?:(?:any|all|the|this|entire)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?|anything)\b/i,
  /\b(?:do not|don't|must not|never)\s+make\s+(?:any\s+)?(?:changes?|edits?|mutations?)(?:\s+to\s+(?:(?:any|all|the)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?))?\b/i,
  /\b(?:make\s+)?no\s+(?:(?:code|source|project|file|workspace|repo(?:sitory)?)\s+)?(?:changes?|edits?|mutations?)(?:\s+to\s+(?:(?:any|all|the)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?))?\b/i,
  /\bno\s+(?:project|source)\s+files?\s+(?:are\s+)?(?:changed|edited|modified|mutated)\b/i,
  /\bwithout\s+(?:editing|changing|modifying|mutating|touching|writing(?:\s+to)?)\s+(?:(?:any|all|the)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?)\b/i,
  /\bleave\s+(?:(?:all|the|this|entire)\s+)?(?:files?|code|source|project|workspace|repo(?:sitory)?)\s+(?:fully\s+)?(?:unchanged|unmodified)\b/i,
  /\b(?:zero\s+task\s+delta|mutation[- ]free)\b/i,
  /\bkh(?:o|ô)ng\s+(?:s(?:u|ử)a|edit|thay\s+(?:d|đ)(?:o|ổ)i)\s+(?:b(?:a|ấ)t\s+k(?:y|ỳ)\s+)?(?:file|source|project|workspace|repo)\b/i
];
const AUTO_BOUNDARY_TAIL_PREFIX = "^(?:\\s|[,.;:!?()\\[\\]{}—–-])*(?:but\\s+)?";
const AUTO_LOCAL_BOUNDARY_TAIL = new RegExp(`${AUTO_BOUNDARY_TAIL_PREFIX}(?:outside|beyond|under|within|inside|in|on|for(?!\\s+now\\b)|except(?:\\s+for)?|other\\s+than|apart\\s+from|to\\b|only\\s+(?:(?:edit|change|modify|mutate|touch|write)\\b|(?:in|under|within|outside)\\b|(?:[a-z0-9_.@*?-]+\\/))|ngo(?:a|à)i\\b|tr(?:u|ừ)\\b)`, "i");
const AUTO_TEMPORARY_BOUNDARY_TAIL = new RegExp(`${AUTO_BOUNDARY_TAIL_PREFIX}(?:(?:not\\s+)?yet\\b|right\\s+now\\b|for\\s+now\\b|at\\s+(?:(?:this|the\\s+current)\\s+(?:step|stage|phase|time)|the\\s+moment)\\b|during\\s+(?:(?:this|the\\s+current)\\s+)?(?:step|stage|phase|planning)\\b|while\\b|unless\\b|until\\b|before\\b|hi(?:e|ệ)n\\s+t(?:a|ạ)i\\b|b(?:a|â)y\\s+gi(?:o|ờ)\\b)`, "i");
const AUTO_GLOBAL_NO_ACCESS_BOUNDARY = /\b(?:do not|don't|must not|never)\s+(?:read|execute|write|delete|restore|hash|echo|compare)(?:\s*,\s*(?:read|execute|write|delete|restore|hash|echo|compare)){1,6}(?:\s*,?\s*or\s+(?:read|execute|write|delete|restore|hash|echo|compare))?\s+(?:any\s+|the\s+|this\s+)?(?:project|workspace|repository|repo|audit|environment)(?:\s+or\s+(?:project|workspace|repository|repo|audit|environment))?\s+(?:content|data|files?|records?|history)\b/i;
const AUTO_PROTECTED_ACCESS_DENIAL = /\b(?:do not|don't|must not|never)\s+(?:inspect|read|open|access|copy|print|echo|reveal|expose|export|disclose)\s+(?:(?:the|a|an|any|all|this|that|complete|raw)\s+){0,3}(?:protected(?:[- ](?:credentials?|files?|data|material|secrets?|tokens?))?|credentials?|secrets?|tokens?|passwords?|api[- ]?keys?|auth(?:entication)?(?:\s+(?:data|material|values?|tokens?))?)\b/i;
const AUTO_REFUSAL_INTENT = /\b(?:refuse|decline|reject)\b/i;
const AUTO_GLOBAL_READ_ONLY_PATTERNS = [
  /^\s*\/?read-only\s*(?:$|[.!?:;—–-])/im,
  /^\s*\/?read-only\s+(?:task|run|session)\s*(?:$|[.!?:;—–-]|\b(?:to|for)\b)/im,
  /^\s*\/?read-only\s+(?:assessment|review)\s*(?:$|[.!?:;—–-]|\b(?:of|for)\b)/im,
  /\b(?:as|in)\s+(?:a\s+)?read-only\s+(?:mode|task|run|session|assessment|review)\b/i,
  /\b(?:use|perform|conduct|run)\s+(?:a\s+)?read-only\s+(?:task|run|assessment|review)\b/i,
  /\b(?:keep\s+)?(?:this\s+|the\s+)?(?:task|run|session|workspace|project|repo|repository)\s+(?:(?:is|must|should)\s+(?:be\s+|remain\s+)?|remain\s+)?read-only\b/i,
  // A task-wide refusal may forbid every material operation without using the
  // literal phrase "read-only" or naming a file mutation. Keep this narrow:
  // require a compound operation list and a global project/audit data object.
  AUTO_GLOBAL_NO_ACCESS_BOUNDARY
];
const AUTO_EXECUTION_INTENT = /(?:\b(?:run|execute|execution|rerun|re-run|chay)\b.{0,80}\b(?:tests?|build|checks?|gates?|lint|typecheck|package|pack|verify|verification)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:test|pack|run\s+(?:build|check|lint|typecheck|verify))\b)/i;

function explicitSourceWorkflow(text: string): boolean {
  const signal = classifyContextTask(text);
  return Boolean(signal.workflowId && signal.changeMode === "source-change");
}

/** A question about whether to mutate is conversational context, not mutation authority. */
export function isNonAuthorizingChangeClarification(prompt: string): boolean {
  const text = String(prompt ?? "").trim();
  if (!text) return false;
  if (explicitSourceWorkflow(text)) return false;
  return isNonAuthorizingChangeLanguage(text);
}

/** Only a short yes/no-or-choice continuation may bypass repository retrieval. */
export function isLightweightNonAuthorizingChangeContinuation(prompt: string): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || explicitSourceWorkflow(text)) return false;
  return isLightweightNonAuthorizingChangeLanguage(text);
}

export const AUTO_INTAKE_SNAPSHOT_PATTERNS = [
  "src/**", "app/**", "lib/**", "packages/**", "test/**", "tests/**", "spec/**", "__tests__/**"
];

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function noMutationBoundarySignals(text: string): { taskWide: boolean; temporary: boolean } {
  let temporary = false;
  for (const pattern of AUTO_NO_MUTATION_CANDIDATES) {
    const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(matcher)) {
      const tail = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 160);
      if (AUTO_LOCAL_BOUNDARY_TAIL.test(tail)) continue;
      if (AUTO_TEMPORARY_BOUNDARY_TAIL.test(tail)) {
        temporary = true;
        continue;
      }
      return { taskWide: true, temporary };
    }
  }
  return { taskWide: false, temporary };
}

function hasGlobalReadOnlyBoundary(text: string): boolean {
  return AUTO_GLOBAL_READ_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

function hasGlobalNoAccessBoundary(text: string): boolean {
  return AUTO_GLOBAL_NO_ACCESS_BOUNDARY.test(text);
}

export function hasProtectedRefusalBoundary(text: string): boolean {
  return AUTO_REFUSAL_INTENT.test(text)
    && AUTO_PROTECTED_ACCESS_DENIAL.test(text)
    && noMutationBoundarySignals(text).taskWide;
}

const PLAUSIBLE_SCOPE_ROOT = /^(?:\.github|app|apps|bin|config|docs|examples|lib|logs|packages|pages|public|scripts|spec|src|test|tests|vendor|__tests__)(?:\/|$)/i;
const PLAUSIBLE_SCOPE_FILE = /(?:^|\/)(?:\.[^/]+|[^/]+\.(?:bash|c|cc|cjs|cpp|css|csv|env|go|graphql|gql|h|hpp|html|java|js|json|jsx|kt|kts|md|mdx|mjs|php|proto|py|rb|rs|scss|sh|sql|svg|swift|toml|ts|tsx|txt|xml|yaml|yml))$/i;

function plausibleTaskScopePath(value: string): boolean {
  const candidate = normalizePathCandidate(value);
  if (!candidate || candidate === "." || candidate.startsWith(".pi/")) return false;
  return PLAUSIBLE_SCOPE_ROOT.test(candidate)
    || PLAUSIBLE_SCOPE_FILE.test(candidate)
    || /[*?{}\[\]]/.test(candidate);
}

export function automaticTaskSummary(prompt: string): string {
  return String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, AUTO_TASK_SUMMARY_CHARS); }

export function automaticTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > AUTO_INTAKE_MAX_PROMPT_CHARS) return false;
  const folded = foldChangeIntent(text);
  const explicitChange = isExplicitChangeRequest(folded);
  if (isNonAuthorizingChangeClarification(text)) return false;
  const noMutationBoundary = noMutationBoundarySignals(text);
  // Verification-only execution keeps the source-task lane so the configured
  // verifier is available, with mutation forbidden by its separate policy.
  // For every non-execution task, a durable zero-delta boundary wins over
  // incidental mutation verbs inside the prohibition itself.
  if (noMutationBoundary.taskWide && !AUTO_EXECUTION_INTENT.test(folded)) return false;
  if (noMutationBoundary.temporary && !noMutationBoundary.taskWide) return false;
  if (hasGlobalReadOnlyBoundary(text)) return false;
  const signal = classifyContextTask(text);
  const conditionalRepair = hasConditionalRepairIntent(text);
  // Explicit non-execution workflows own their operation semantics; an implementation verb inside
  // /plan, /discuss, or a git workflow must not create a source-change task early.
  // A review that explicitly makes repair conditional on observed evidence is
  // different: it needs verifier authority and may legitimately finish with
  // either zero delta or a scoped repair.
  if (signal.workflow !== "task" && !(signal.workflow === "review" && conditionalRepair)) return false;
  if (AUTO_EXECUTION_INTENT.test(folded)) {
    if (/\bpiagent_task_start\b/i.test(text)) return false;
    return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
  }
  if (conditionalRepair) {
    if (/\bpiagent_task_start\b/i.test(text)) return false;
    return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
  }
  if (!hasChangeIntent(folded) && !explicitChange) return false;
  if ((AUTO_INTAKE_READ_ONLY_LEAD.test(folded) && !explicitChange) || AUTO_INTAKE_MANUAL_RISK.test(folded)) return false;
  if (/\bpiagent_task_start\b/i.test(text)) return false;
  return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
}

export function automaticReadOnlyTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > AUTO_INTAKE_MAX_PROMPT_CHARS) return false;
  const folded = foldChangeIntent(text);
  if (isNonAuthorizingChangeClarification(text)) return false;
  const signal = classifyContextTask(text);
  if (["usage", "permission", "context", "discuss", "plan", "release", "onboard"].includes(signal.workflow)) return false;
  const protectedRefusalBoundary = hasProtectedRefusalBoundary(text);
  const readOnlyBoundary = noMutationBoundarySignals(text).taskWide || hasGlobalReadOnlyBoundary(text) || protectedRefusalBoundary;
  if (!AUTO_READ_ONLY_INTENT.test(folded) && !readOnlyBoundary) return false;
  if (hasChangeIntent(folded) && !readOnlyBoundary) return false;
  if (/\bpiagent_task_start\b/i.test(text)) return false;
  const protectedTarget = signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
  return !protectedTarget || hasGlobalNoAccessBoundary(text) || protectedRefusalBoundary;
}

export function automaticTaskIntakeMode(prompt: string, readProtectedPaths: string[]): "source-change" | "read-only" | undefined {
  if (automaticTaskIntakeEligible(prompt, readProtectedPaths)) return "source-change";
  return automaticReadOnlyTaskIntakeEligible(prompt, readProtectedPaths) ? "read-only" : undefined;
}

export function automaticTaskMutationPolicy(
  prompt: string,
  changeMode: "source-change" | "read-only"
): "required" | "allowed" | "forbidden" {
  const text = String(prompt ?? "");
  // A feature can intentionally become read-only while the implementation
  // still requires source changes. Only a task-wide boundary may suppress
  // mutation; incidental domain wording such as "list/detail read-only" must
  // never convert a delegated implementation into a zero-delta task.
  if (changeMode === "read-only" || noMutationBoundarySignals(text).taskWide || hasGlobalReadOnlyBoundary(text)) {
    return "forbidden";
  }
  return classifyConditionalRepairIntent(text) === "conditional-only" ? "allowed" : "required";
}

export function automaticTaskRiskLane(prompt: string): "tiny" | "normal" {
  return classifyContextTask(prompt).lane === "tiny" ? "tiny" : "normal";
}

function splitAcceptanceCriterion(value: string, grouped = false): string[] {
  const normalized = value.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const label = grouped ? "" : normalized.match(/^(\[[^\]\n]{1,40}\])\s+/)?.[1] ?? "";
  const body = label ? normalized.slice(label.length).trim() : normalized;
  const prefix = label ? `${label} ` : "";
  const available = AUTO_ACCEPTANCE_CRITERION_CHARS - prefix.length;
  const fragments: string[] = [];
  const units = acceptanceContractConjuncts(body, { preserveSeparators: true })
    .flatMap((clause) => clause.split(/(?<=[.!?])\s+(?=(?:[`"'([{]|[\p{Lu}\p{N}]|(?:do|must|never|verify)\b))/u))
    .filter((item) => item.trim());
  for (const unit of units) {
    const remaining = unit.trim();
    if (remaining.length > available) throw acceptanceCriteriaOverflow();
    if (remaining) fragments.push(`${prefix}${remaining}`);
  }
  return fragments;
}

function isPathOnlyCriterion(value: string): boolean {
  const normalized = value
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, "")
    .replace(/^`|`$/g, "")
    .trim();
  return /^(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+$/.test(normalized);
}

function acceptanceCriteriaOverflow(): RangeError {
  return new RangeError(`Automatic intake cannot retain every requirement within ${AUTO_ACCEPTANCE_CRITERIA_MAX} criteria of ${AUTO_ACCEPTANCE_CRITERION_CHARS} characters. No task was created by this intake. Use explicit bounded tasks without omitting requirements.`);
}

function groupedAcceptanceCriteria(values: string[], limit: number): string[] {
  // Repack the source text, not a ranked sample of its obligations. Keep generic
  // verification/safety criteria separate so they cannot stand in for user clauses.
  // Preserve clause boundaries as line breaks: receipts require independent
  // evidence for the whole multiline criterion, including unpunctuated bullets.
  const groups: string[] = [];
  let current = "";
  for (const value of values) {
    if (current && current.length + 1 + value.length > AUTO_ACCEPTANCE_CRITERION_CHARS) {
      groups.push(current);
      current = "";
    }
    current = current ? `${current}\n${value}` : value;
  }
  if (current) groups.push(current);
  if (groups.length > limit) throw acceptanceCriteriaOverflow();
  return groups;
}

function isStandaloneOpaqueMetadata(line: string, current: string): boolean {
  // Preserve JSON, code, Markdown separators and punctuated exact tokens. A
  // lone identifier-like token after a closed sentence is metadata/padding,
  // not a criterion; the lossless operatorRequest remains the authority for it.
  return /^[A-Za-z0-9_]+$/.test(line) && !/[.!?;:]$/.test(line)
    && (!current || /[.!?;:]$/.test(current));
}

function isStandaloneAcceptanceLabel(value: string): boolean {
  const normalized = value.trim();
  return /^(?:acceptance criteria|behavior|contract|constraints|expected behavior|expected output|requirements|rules|validation):$/i.test(normalized);
}

export function automaticAcceptanceCriteria(
  prompt: string,
  changeMode: "source-change" | "read-only" = "source-change",
  mutationPolicy: "required" | "allowed" | "forbidden" = changeMode === "read-only" ? "forbidden" : "required"
): string[] {
  const lines = String(prompt ?? "").split(/\r?\n/);
  const criterionGroups: Array<{ source: string; criteria: string[] }> = [];
  let current = "";
  const push = (value: string) => {
    if (isPathOnlyCriterion(value)) return;
    const source = value.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
    criterionGroups.push({ source, criteria: splitAcceptanceCriterion(source) });
  };
  const flush = () => {
    if (current) push(current);
    current = "";
  };
  const listItem = /^(?:[-*+] |\d+[.)]\s+)/;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (listItem.test(trimmed)) {
      if (isStandaloneAcceptanceLabel(current)) {
        current = `${current} ${trimmed.replace(listItem, "")}`;
        continue;
      }
      flush();
      current = trimmed;
      continue;
    }
    if (!trimmed) {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim())?.trim() ?? "";
      if (isStandaloneAcceptanceLabel(current) && listItem.test(next)) continue;
      flush();
      continue;
    }
    if (isStandaloneOpaqueMetadata(trimmed, current)) continue;
    current = current ? `${current} ${trimmed}` : trimmed;
  }
  flush();
  const generic = changeMode === "read-only" || mutationPolicy === "forbidden"
    ? ["No project files are changed.", "The final response addresses the requested diagnostic result."]
    : mutationPolicy === "allowed"
      ? ["Every configured verification command passes against the final working tree."]
      : ["The configured verification command passes after the final mutation."];
  const limit = AUTO_ACCEPTANCE_CRITERIA_MAX - generic.length;
  const atomic = criterionGroups.flatMap((group) => group.criteria);
  const selected = atomic.length <= limit
    ? atomic
    : groupedAcceptanceCriteria(criterionGroups.flatMap((group) => splitAcceptanceCriterion(group.source, true)), AUTO_ACCEPTANCE_CRITERIA_MAX);
  if (new Set(selected).size !== selected.length) throw acceptanceCriteriaOverflow();
  const available = AUTO_ACCEPTANCE_CRITERIA_MAX - selected.length;
  return [...selected, ...generic.filter((criterion) => !selected.includes(criterion)).slice(0, available)];
}

export function manualTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > LONG_INPUT_CHARS) return false;
  const folded = foldChangeIntent(text);
  const explicitChange = isExplicitChangeRequest(folded);
  if (isNonAuthorizingChangeClarification(text)) return false;
  const signal = classifyContextTask(text);
  if (signal.workflow !== "task" || (!hasChangeIntent(folded) && !explicitChange)) return false;
  if ((AUTO_INTAKE_READ_ONLY_LEAD.test(folded) && !explicitChange) || /\bpiagent_task_start\b/i.test(text)) return false;
  if (signal.paths.length === 0) return true;
  return signal.paths.some((candidate) => !matchesProtectedPath(candidate, readProtectedPaths));
}

function foldedPathTerms(value: string): Set<string> {
  return new Set(String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3));
}

function inferredProjectScope(prompt: string, projectFiles: string[]): string[] {
  const ignoredTerms = new Set(["code", "contract", "file", "files", "function", "implement", "package", "packages", "preserve", "source", "test", "tests"]);
  const promptTerms = new Set(classifyContextTask(prompt).terms
    .flatMap((term) => [...foldedPathTerms(term)])
    .filter((term) => !ignoredTerms.has(term)));
  if (promptTerms.size === 0 || projectFiles.length === 0) return [];
  const candidates = projectFiles.map((file) => {
    const normalized = normalizePathCandidate(file);
    if (
      !normalized
      || !/^(?:app|apps|lib|packages|services|src)\//.test(normalized)
      || /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|$)/.test(normalized)
      || /(?:^|\/)(?:README|AGENTS|REVIEW_GUIDELINES)(?:\.|$)/i.test(normalized)
    ) return undefined;
    const parts = normalized.split("/");
    const basenameTerms = foldedPathTerms(parts.at(-1) ?? "");
    const directoryTerms = foldedPathTerms(parts.slice(0, -1).join("/"));
    let score = 0;
    for (const term of promptTerms) {
      if (basenameTerms.has(term)) score += 3;
      else if (directoryTerms.has(term)) score += 1;
    }
    return score >= 3 ? { path: normalized, score } : undefined;
  }).filter((item): item is { path: string; score: number } => Boolean(item));
  return candidates
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8)
    .map((item) => item.path);
}

export function automaticTaskScope(
  prompt: string,
  context: Array<{ path: string }>,
  projectFiles: string[] = [],
  priorTask?: PriorTaskScopeEvidence
): string[] {
  const signal = classifyContextTask(prompt);
  const explicit = signal.paths.filter(plausibleTaskScopePath);
  const completedTaskScope = completedFollowupScope(prompt, priorTask, plausibleTaskScopePath);
  const navigated = completedTaskScope.length > 0
    ? completedTaskScope
    : context
      .map((item) => normalizePathCandidate(item.path))
      .filter((candidate): candidate is string => Boolean(
        candidate
        && candidate !== "."
        && !candidate.startsWith(".pi/")
        && !["AGENTS.md", "README.md", "REVIEW_GUIDELINES.md"].includes(candidate)
        && /^(?:app|apps|lib|packages|services|spec|src|test|tests|__tests__)\//.test(candidate)
      ))
      .slice(0, 8);
  const inferred = explicit.length === 0 && navigated.length === 0
    ? inferredProjectScope(prompt, projectFiles)
    : [];
  const scope = uniqueStrings([...explicit, ...navigated, ...inferred]);
  if (scope.length === 0) scope.push("src/**", "app/**", "lib/**");
  // Critical acceptance obligations are proven with focused executable tests.
  // Keep test roots in scope even when the operator says only "fix" and relies
  // on the runtime to derive the verification work.
  scope.push("test/**", "tests/**", "spec/**", "__tests__/**");
  return uniqueStrings(scope);
}

export function automaticReadOnlyTaskScope(prompt: string, context: Array<{ path: string }>): string[] {
  const signal = classifyContextTask(prompt);
  const explicit = signal.paths.filter(plausibleTaskScopePath);
  const navigated = context
    .map((item) => normalizePathCandidate(item.path))
    .filter((candidate): candidate is string => Boolean(
      candidate
      && candidate !== "."
      && !candidate.startsWith(".pi/")
      && !["AGENTS.md", "README.md", "REVIEW_GUIDELINES.md"].includes(candidate)
    ))
    .slice(0, 8);
  const scope = uniqueStrings([...explicit, ...navigated]);
  if (scope.length === 0) scope.push("src/**", "docs/**", "logs/**", "config/**");
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
