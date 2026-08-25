import { classifyContextTask } from "../../extensions/context-engine.js";
import { matchesAnyPath, matchesProtectedPath, normalizePathCandidate } from "../../extensions/policy-core.js";
import type { ReviewLens } from "../../extensions/guard-types.js";
import { LONG_INPUT_CHARS } from "../runtime-limits.ts";
export { boundedRuntimeIntakeMessage } from "./runtime-intake-compaction.ts";

const AUTO_INTAKE_MAX_PROMPT_CHARS = LONG_INPUT_CHARS;
const AUTO_TASK_SUMMARY_CHARS = 700;
const AUTO_ACCEPTANCE_CRITERION_CHARS = 600;
const AUTO_ACCEPTANCE_CRITERIA_MAX = 12;
const AUTO_INTAKE_CHANGE_INTENT = /\b(?:add|build|change|correct|create|fix|implement|modify|mutate|refactor|remove|rename|repair|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b/i;
const AUTO_INTAKE_READ_ONLY_LEAD = /^\s*\/?(?:analy[sz]e|audit|check|discuss|explain|inspect|plan|research|review|scout|summari[sz]e|why|how|can\s+(?:you|we)|kiem tra|nghien cuu|giai thich|danh gia)\b/i;
const AUTO_INTAKE_MANUAL_RISK = /\b(?:credential|database|deploy|destructive|encryption|external provider|payment|permission|production|publish|secret|token rotation)\b/i;
const AUTO_READ_ONLY_INTENT = /\b(?:analy[sz]e|audit|check|diagnos(?:e|is)|explain|inspect|investigate|plan|research|review|scout|summari[sz]e|triage|kiem tra|nghien cuu|giai thich|danh gia)\b/i;
// Candidate wording is separated from the following qualifier. This keeps a
// durable zero-delta instruction distinct from local path authority and from a
// temporary "inspect first, edit later" instruction.
const AUTO_NO_MUTATION_CANDIDATES = [
  /\b(?:do not|don't|must not|never)\s+(?:edit|change|modify|mutate|touch|write(?:\s+to)?)\s+(?:(?:any|all|the|this|entire)\s+)?(?:files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|repo(?:sitory)?|anything)\b/i,
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
const AUTO_GLOBAL_READ_ONLY_PATTERNS = [
  /^\s*\/?read-only\s*(?:$|[.!?:;—–-])/im,
  /^\s*\/?read-only\s+(?:task|run|session)\s*(?:$|[.!?:;—–-]|\b(?:to|for)\b)/im,
  /^\s*\/?read-only\s+(?:assessment|review)\s*(?:$|[.!?:;—–-]|\b(?:of|for)\b)/im,
  /\b(?:as|in)\s+(?:a\s+)?read-only\s+(?:mode|task|run|session|assessment|review)\b/i,
  /\b(?:use|perform|conduct|run)\s+(?:a\s+)?read-only\s+(?:task|run|assessment|review)\b/i,
  /\b(?:keep\s+)?(?:this\s+|the\s+)?(?:task|run|session|workspace|project|repo|repository)\s+(?:(?:is|must|should)\s+(?:be\s+|remain\s+)?|remain\s+)?read-only\b/i
];
const AUTO_EXECUTION_INTENT = /(?:\b(?:run|execute|execution|rerun|re-run|chay)\b.{0,80}\b(?:tests?|build|checks?|gates?|lint|typecheck|package|pack|verify|verification)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:test|pack|run\s+(?:build|check|lint|typecheck|verify))\b)/i;

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
  return String(prompt ?? "").replace(/\s+/g, " ").trim().slice(0, AUTO_TASK_SUMMARY_CHARS);
}

export function automaticTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > AUTO_INTAKE_MAX_PROMPT_CHARS) return false;
  const noMutationBoundary = noMutationBoundarySignals(text);
  if (noMutationBoundary.temporary && !noMutationBoundary.taskWide) return false;
  const signal = classifyContextTask(text);
  if (AUTO_EXECUTION_INTENT.test(text)) {
    if (/\bpiagent_task_start\b/i.test(text)) return false;
    return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
  }
  if (signal.workflow !== "task" || !AUTO_INTAKE_CHANGE_INTENT.test(text)) return false;
  if (AUTO_INTAKE_READ_ONLY_LEAD.test(text) || AUTO_INTAKE_MANUAL_RISK.test(text)) return false;
  if (/\bpiagent_task_start\b/i.test(text)) return false;
  return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
}

export function automaticReadOnlyTaskIntakeEligible(prompt: string, readProtectedPaths: string[]): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > AUTO_INTAKE_MAX_PROMPT_CHARS) return false;
  const signal = classifyContextTask(text);
  if (signal.workflow === "usage" || signal.workflow === "permission" || signal.workflow === "context") return false;
  const readOnlyBoundary = noMutationBoundarySignals(text).taskWide || hasGlobalReadOnlyBoundary(text);
  if (!AUTO_READ_ONLY_INTENT.test(text) && !readOnlyBoundary) return false;
  if (AUTO_INTAKE_CHANGE_INTENT.test(text) && !readOnlyBoundary) return false;
  if (/\bpiagent_task_start\b/i.test(text)) return false;
  return !signal.paths.some((candidate) => matchesProtectedPath(candidate, readProtectedPaths));
}

export function automaticTaskIntakeMode(prompt: string, readProtectedPaths: string[]): "source-change" | "read-only" | undefined {
  if (automaticTaskIntakeEligible(prompt, readProtectedPaths)) return "source-change";
  if (automaticReadOnlyTaskIntakeEligible(prompt, readProtectedPaths)) return "read-only";
  return undefined;
}

export function automaticTaskMutationPolicy(
  prompt: string,
  changeMode: "source-change" | "read-only"
): "required" | "forbidden" {
  const text = String(prompt ?? "");
  // A feature can intentionally become read-only while the implementation
  // still requires source changes. Only a task-wide boundary may suppress
  // mutation; incidental domain wording such as "list/detail read-only" must
  // never convert a delegated implementation into a zero-delta task.
  return changeMode === "read-only"
    || noMutationBoundarySignals(text).taskWide
    || hasGlobalReadOnlyBoundary(text)
    ? "forbidden"
    : "required";
}

export function automaticTaskRiskLane(prompt: string): "tiny" | "normal" {
  return classifyContextTask(prompt).lane === "tiny" ? "tiny" : "normal";
}

const ATOMIC_CLAUSE_LEAD = /^(?:accept|add|build|change|correct|create|do not|emit|ensure|fail|fix|handle|implement|invalid|missing|modify|must|never|parse|preserve|reject|repair|return|support|throw|treat|update|verify|without)\b/i;

function topLevelImperativeClauses(value: string): string[] {
  const clauses: string[] = [];
  let current = "", quote = "", round = 0, square = 0, curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index], previous = value[index - 1] ?? "", next = value[index + 1] ?? "";
    if (quote) {
      current += character;
      if (character === quote && previous !== "\\") quote = "";
      continue;
    }
    const apostropheInsideWord = character === "'" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
    if ((character === "`" || character === '"' || character === "'") && !apostropheInsideWord) {
      quote = character; current += character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    if (character === ";" && round === 0 && square === 0 && curly === 0 && ATOMIC_CLAUSE_LEAD.test(value.slice(index + 1).trimStart())) {
      if (current.trim().length >= 8) clauses.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

function splitAcceptanceCriterion(value: string): string[] {
  const normalized = value.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 8) return [];
  const label = normalized.match(/^(\[[^\]\n]{1,40}\])\s+/)?.[1] ?? "";
  const body = label ? normalized.slice(label.length).trim() : normalized;
  const prefix = label ? `${label} ` : "";
  const available = AUTO_ACCEPTANCE_CRITERION_CHARS - prefix.length;
  const fragments: string[] = [];
  const units = topLevelImperativeClauses(body)
    .flatMap((clause) => clause.split(/(?<=[.!?])\s+(?=(?:[`"'([{]|[\p{Lu}\p{N}]|(?:do|must|never|verify)\b))/u))
    .filter((item) => item.trim().length >= 8);
  for (const unit of units) {
    let remaining = unit.trim();
    while (remaining.length > available) {
      const window = remaining.slice(0, available + 1);
      const sentence = [...window.matchAll(/[.!?;:]\s+/g)].at(-1);
      const clause = [...window.matchAll(/,\s+/g)].at(-1);
      const whitespace = window.lastIndexOf(" ");
      const preferred = sentence && sentence.index! + sentence[0].trimEnd().length >= Math.floor(available / 3)
        ? sentence.index! + sentence[0].trimEnd().length
        : clause && clause.index! + 1 >= Math.floor(available / 2)
          ? clause.index! + 1
          : whitespace;
      const cut = preferred > 0 ? preferred : available;
      fragments.push(`${prefix}${remaining.slice(0, cut).trim()}`);
      remaining = remaining.slice(cut).trim();
    }
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

function evenlySpacedCriteria(values: string[], limit: number): string[] {
  if (limit <= 0) return [];
  if (values.length <= limit) return values;
  if (limit === 1) return [values[values.length - 1]];
  return Array.from({ length: limit }, (_entry, index) => (
    values[Math.round((index * (values.length - 1)) / (limit - 1))]
  ));
}

function boundedAcceptanceCriteria(values: string[], limit: number): string[] {
  if (limit <= 0 || values.length === 0) return [];
  if (values.length <= limit) return values;
  const highSignal = /\b(?:do not|fail(?:s|ed)?(?:[-\s]+)closed|invalid|missing|must|never|reject(?:s|ed|ion)?|throws?|typeerror|without mutat(?:e|ing)|unchanged)\b/i;
  const required = values.filter((criterion) => highSignal.test(criterion));
  const selectedRequired = evenlySpacedCriteria(required, Math.min(limit, required.length));
  const selected = new Set(selectedRequired);
  const remaining = values.filter((criterion) => !selected.has(criterion));
  for (const criterion of evenlySpacedCriteria(remaining, limit - selected.size)) selected.add(criterion);
  return values.filter((criterion) => selected.has(criterion));
}

type AtomicCriterionGroup = { criteria: string[]; index: number };

function atomicCriterionScore(value: string): number {
  const weighted = [
    [/(?:\bdo not\b|\bdoes not\b|\bcannot\b|\bnever\b|\binvalid\b|\breject|\bthrow|\bfail(?:s|ed)?[- ]closed\b)/i, 8],
    [/(?:\bidentical\b|\breplay|\bcanonical|\bidempoten)/i, 6],
    [/(?:\bstale\b|changed owner|inclusive boundary)/i, 5],
    [/\bexact(?:ly)?\b/i, 4],
    [/(?:\bnon-finite\b|\bnon-json\b|\bmutat|\bdigest\b|\breturn|\boutput\b)/i, 3]
  ] as const;
  return weighted.reduce((score, [pattern, weight]) => score + (pattern.test(value) ? weight : 0), 0);
}

function atomicCoverageCriteria(groups: AtomicCriterionGroup[], limit: number): string[] {
  const candidates = groups.flatMap((group) => group.criteria.map((criterion, clause) => ({ criterion, group: group.index, clause })));
  if (candidates.length <= limit) return uniqueStrings(candidates.map((item) => item.criterion));
  const representatives = groups.filter((group) => group.criteria.length > 0).map((group) => group.criteria.at(-1)!);
  const selected = new Set(boundedAcceptanceCriteria(representatives, Math.min(limit, representatives.length)));
  const ranked = candidates.filter((item) => !selected.has(item.criterion)).sort((left, right) => (
    atomicCriterionScore(right.criterion) - atomicCriterionScore(left.criterion)
    || left.group - right.group
    || left.clause - right.clause
  ));
  for (const item of ranked) {
    if (selected.size < limit) { selected.add(item.criterion); continue; }
    if (groups.length <= limit || atomicCriterionScore(item.criterion) === 0) continue;
    const sameGroupAlreadyCovered = candidates.some((candidate) => candidate.group === item.group && selected.has(candidate.criterion));
    if (!sameGroupAlreadyCovered) continue;
    const removable = candidates
      .filter((candidate) => selected.has(candidate.criterion) && candidate.group !== item.group)
      .sort((left, right) => (
        Number(/^\[/.test(left.criterion)) - Number(/^\[/.test(right.criterion))
        || atomicCriterionScore(left.criterion) - atomicCriterionScore(right.criterion)
        || right.group - left.group
      ))
      .find((candidate) => atomicCriterionScore(candidate.criterion) < atomicCriterionScore(item.criterion));
    if (removable) { selected.delete(removable.criterion); selected.add(item.criterion); }
  }
  return uniqueStrings(candidates.filter((item) => selected.has(item.criterion)).map((item) => item.criterion)).slice(0, limit);
}

export function automaticAcceptanceCriteria(prompt: string, changeMode: "source-change" | "read-only" = "source-change"): string[] {
  const lines = String(prompt ?? "").split(/\r?\n/);
  const criterionGroups: AtomicCriterionGroup[] = [];
  const obligation = /\b(?:accept|add|build|change|change only|correct|create|do not|emits?|ensure|exactly|fail(?:s|ed)?(?:[-\s]+)closed|fix|handle|implement|invalid|missing|modify|must|never|parse|preserve|reject|repair|returns?|support|throw|treat|update|without)\b/i;
  let current = "";
  let currentIsBullet = false;
  const push = (value: string) => {
    if (isPathOnlyCriterion(value)) return;
    criterionGroups.push({ criteria: splitAcceptanceCriterion(value), index: criterionGroups.length });
  };
  const flush = () => {
    if (current && (currentIsBullet || obligation.test(current))) push(current);
    current = "";
    currentIsBullet = false;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:[-*+] |\d+[.)]\s+)/.test(trimmed)) {
      flush();
      current = trimmed;
      currentIsBullet = true;
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    current = current ? `${current} ${trimmed}` : trimmed;
  }
  flush();
  const generic = changeMode === "read-only"
    ? ["No project files are changed.", "The final response addresses the requested diagnostic result."]
    : ["The configured verification command passes after the final mutation."];
  const groupCount = criterionGroups.filter((group) => group.criteria.length > 0).length;
  const reservedGeneric = Math.min(generic.length, Math.max(0, AUTO_ACCEPTANCE_CRITERIA_MAX - groupCount));
  const uniqueCriteria = atomicCoverageCriteria(criterionGroups, AUTO_ACCEPTANCE_CRITERIA_MAX - reservedGeneric);
  const selected = boundedAcceptanceCriteria(uniqueCriteria, AUTO_ACCEPTANCE_CRITERIA_MAX);
  if (selected.length === AUTO_ACCEPTANCE_CRITERIA_MAX) return selected;
  const missingGeneric = generic.filter((criterion) => !selected.includes(criterion));
  return [...selected, ...missingGeneric].slice(0, AUTO_ACCEPTANCE_CRITERIA_MAX);
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

export type TaskScopeResolution = {
  scope: string[];
  mappings: Array<{ from: string; to: string }>;
  ambiguous: Array<{ input: string; candidates: string[] }>;
  unmatched: string[];
};

const STANDARD_SCOPE_ROOT = /^(?:\.github|app|apps|bin|config|docs|examples|lib|logs|packages|pages|plans|public|scripts|services|spec|src|test|tests|vendor|__tests__)(?:\/|$)/i;

function wildcardPrefix(value: string): string {
  const index = value.search(/[*?{}\[\]]/);
  return (index < 0 ? value : value.slice(0, index)).replace(/\/+$/, "");
}

function nestedDirectoryMatches(prefix: string, projectFiles: string[]): string[] {
  if (!prefix) return [];
  const segments = prefix.split("/").filter(Boolean);
  const matches = new Set<string>();
  for (const file of projectFiles) {
    const parts = normalizePathCandidate(file).split("/");
    for (let index = 0; index <= parts.length - 1 - segments.length; index += 1) {
      if (segments.every((segment, offset) => parts[index + offset] === segment)) {
        matches.add(parts.slice(0, index + segments.length).join("/"));
      }
    }
  }
  return [...matches].sort();
}

export function resolveTaskScopePatterns(scope: string[], projectFiles: string[]): TaskScopeResolution {
  const files = uniqueStrings(projectFiles.map(normalizePathCandidate).filter(Boolean));
  const resolved: string[] = [];
  const mappings: Array<{ from: string; to: string }> = [];
  const ambiguous: Array<{ input: string; candidates: string[] }> = [];
  const unmatched: string[] = [];
  for (const raw of scope) {
    const candidate = normalizePathCandidate(raw);
    if (!candidate) continue;
    if (files.includes(candidate) || files.some((file) => matchesAnyPath(file, [candidate]))) {
      resolved.push(candidate);
      continue;
    }
    const hasWildcard = /[*?{}\[\]]/.test(candidate);
    if (hasWildcard) {
      const prefix = wildcardPrefix(candidate);
      const directories = nestedDirectoryMatches(prefix, files);
      if (directories.length === 1) {
        const suffix = candidate.slice(prefix.length).replace(/^\/+/, "");
        const canonical = suffix ? `${directories[0]}/${suffix}` : directories[0];
        resolved.push(canonical);
        mappings.push({ from: candidate, to: canonical });
      } else if (directories.length > 1 && prefix && !STANDARD_SCOPE_ROOT.test(prefix)) {
        ambiguous.push({ input: candidate, candidates: directories.slice(0, 12).map((directory) => {
          const suffix = candidate.slice(prefix.length).replace(/^\/+/, "");
          return suffix ? `${directory}/${suffix}` : directory;
        }) });
      } else if (directories.length === 0 && prefix && !prefix.includes("/") && !STANDARD_SCOPE_ROOT.test(prefix) && !raw.startsWith("./")) {
        unmatched.push(candidate);
      } else {
        resolved.push(candidate);
      }
      continue;
    }
    const suffixMatches = files.filter((file) => file === candidate || file.endsWith(`/${candidate}`));
    if (suffixMatches.length === 1) {
      resolved.push(suffixMatches[0]);
      mappings.push({ from: candidate, to: suffixMatches[0] });
    } else if (suffixMatches.length > 1) {
      ambiguous.push({ input: candidate, candidates: suffixMatches.slice(0, 12) });
    } else if (!candidate.includes("/") && !raw.startsWith("./")) {
      unmatched.push(candidate);
    } else {
      resolved.push(candidate);
    }
  }
  return { scope: uniqueStrings(resolved), mappings, ambiguous, unmatched: uniqueStrings(unmatched) };
}

export function automaticTaskScope(prompt: string, context: Array<{ path: string }>, projectFiles: string[] = []): string[] {
  const signal = classifyContextTask(prompt);
  const explicit = signal.paths.filter(plausibleTaskScopePath);
  const navigated = context
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
