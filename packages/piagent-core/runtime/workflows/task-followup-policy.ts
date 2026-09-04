import { normalizePathCandidate } from "../../extensions/policy-core.js";
import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";
import { foldChangeIntent } from "./change-clarification.ts";
import { classifyConditionalRepairIntent } from "./task-repair-intent.ts";

export type PriorTaskScopeEvidence = {
  trace?: { outcome?: string };
  changedFiles?: unknown;
  observedChangedFiles?: unknown;
  contextManifest?: unknown;
};

type FollowupAcceptanceTask = PriorTaskScopeEvidence & {
  taskRunId?: unknown;
  sessionId?: unknown;
  createdAt?: unknown;
  changeMode?: unknown;
  mutationPolicy?: unknown;
  intakeMode?: unknown;
  operatorRequest?: unknown;
  summary?: unknown;
  scope?: unknown;
  baselineFileDigests?: unknown;
  finalFileDigests?: unknown;
};

type FileDigestRecord = Record<string, string>;

export function hasConditionalRepairIntent(text: string): boolean {
  return classifyConditionalRepairIntent(text) !== "none";
}

function refersToEarlierImplementation(prompt: string): boolean {
  const folded = foldChangeIntent(prompt);
  const negatesPriorTurnReview = /\b(?:do not|don't|without|ignore|skip)\s+(?:review|verify|inspect|test|check|fix|continue|complete|apply|address)\b[\s\S]{0,200}\b(?:implementation|requirements?|obligations?|changes?|fix|logic|work)\s+(?:from|in)\s+(?:the\s+)?(?:earlier|previous|prior)\s+(?:turn|message)\b/i
    .test(folded);
  if (negatesPriorTurnReview) return false;
  return [
    /\b(?:current|existing|earlier|previous|prior|above)\s+(?:changes?|fix|implementation|logic|work)\b/i,
    /\b(?:earlier|previous|prior|original|above)\s+(?:instructions?|obligations?|request|requirements?|task)\b/i,
    /\b(?:changes?|fix|implementation|logic|work)\s+(?:above|earlier|previously|just\s+(?:completed|made|implemented))\b/i,
    /\bwhat\s+(?:you|we)\s+just\s+(?:changed|fixed|implemented)\b/i,
    /\b(?:review|verify|inspect|test|check|fix|continue|complete|apply|address)\b[\s\S]{0,200}\b(?:implementation|requirements?|obligations?|changes?|fix|logic|work)\s+(?:from|in)\s+(?:the\s+)?(?:earlier|previous|prior)\s+(?:turn|message)\b/i,
    /\b(?:implementation|phan|logic|thay doi|yeu cau)\s+(?:hien tai|truoc do|vua roi|vua sua|vua lam|vua trien khai)\b/i,
    /\b(?:vua sua|vua lam|vua trien khai|thay doi vua roi|thay doi truoc do)\b/i
  ].some((pattern) => pattern.test(folded));
}

function fileDigestRecord(value: unknown): FileDigestRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  const normalized = entries.map(([file, digest]) => [normalizePathCandidate(file), digest] as const);
  if (normalized.some(([file, digest]) => !file || !isCurrentWorkingTreeDigest(digest))) return undefined;
  if (new Set(normalized.map(([file]) => file)).size !== normalized.length) return undefined;
  return Object.fromEntries(normalized);
}

function sameFileDigestRecord(left: FileDigestRecord, right: FileDigestRecord): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([file, digest], index) => file === rightEntries[index]?.[0] && digest === rightEntries[index]?.[1]);
}

function changedDigestFiles(baseline: FileDigestRecord, final: FileDigestRecord): string[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(final)])]
    .filter((file) => baseline[file] !== final[file])
    .sort();
}

function normalizedFiles(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((file): file is string => typeof file === "string")
    .map((file) => normalizePathCandidate(file))
    .filter(Boolean))]
    .sort();
}

function sameFiles(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

/**
 * A zero-delta verification follow-up may prove the immediately preceding
 * implementation without claiming those files as its own mutation. The
 * lineage is intentionally strict: same session, adjacent completed source
 * task, exact snapshot continuity, exact child focus, and an explicit
 * reference to earlier work. Ambiguity returns only the task-local delta.
 */
export function completedFollowupAcceptanceEvidenceFiles(
  task: FollowupAcceptanceTask,
  tasks: FollowupAcceptanceTask[],
  taskLocalDelta: string[],
  currentFileDigests: unknown
): string[] {
  const local = normalizedFiles(taskLocalDelta);
  const prompt = typeof task.operatorRequest === "string" && task.operatorRequest.trim()
    ? task.operatorRequest
    : typeof task.summary === "string" ? task.summary : "";
  const current = fileDigestRecord(currentFileDigests);
  const childBaseline = fileDigestRecord(task.baselineFileDigests);
  const createdAt = typeof task.createdAt === "string" ? Date.parse(task.createdAt) : Number.NaN;
  if (
    task.intakeMode !== "runtime"
    || task.changeMode !== "source-change"
    || task.mutationPolicy !== "allowed"
    || typeof task.taskRunId !== "string"
    || typeof task.sessionId !== "string"
    || !Number.isFinite(createdAt)
    || !refersToEarlierImplementation(prompt)
    || !current
    || !childBaseline
  ) return local;

  const prior = tasks
    .filter((candidate) => candidate.taskRunId !== task.taskRunId
      && candidate.sessionId === task.sessionId
      && typeof candidate.createdAt === "string"
      && Number.isFinite(Date.parse(candidate.createdAt))
      && Date.parse(candidate.createdAt) < createdAt)
    .sort((left, right) => Date.parse(String(right.createdAt)) - Date.parse(String(left.createdAt)));
  if (tasks.some((candidate) => candidate.taskRunId !== task.taskRunId
    && candidate.sessionId === task.sessionId
    && typeof candidate.createdAt === "string"
    && Date.parse(candidate.createdAt) === createdAt)) return local;
  const parent = prior[0];
  if (!parent || (prior[1] && Date.parse(String(prior[1].createdAt)) === Date.parse(String(parent.createdAt)))) return local;
  if (parent.trace?.outcome !== "completed" || parent.changeMode !== "source-change" || parent.mutationPolicy === "forbidden") return local;

  const parentBaseline = fileDigestRecord(parent.baselineFileDigests);
  const parentFinal = fileDigestRecord(parent.finalFileDigests);
  if (!parentBaseline || !parentFinal || !sameFileDigestRecord(parentFinal, childBaseline)) return local;
  const parentChanged = normalizedFiles(parent.changedFiles);
  if (parentChanged.length === 0 || !sameFiles(parentChanged, changedDigestFiles(parentBaseline, parentFinal))) return local;

  const exactFocus = new Set(normalizedFiles(task.scope).filter((file) => !/[?*\[\]{}]/.test(file)));
  const inherited = parentChanged.filter((file) => exactFocus.has(file) && Object.hasOwn(current, file));
  return [...new Set([...local, ...inherited])].sort();
}

export function completedFollowupScope(
  prompt: string,
  task: PriorTaskScopeEvidence | undefined,
  plausiblePath: (value: string) => boolean
): string[] {
  if (!refersToEarlierImplementation(prompt) || task?.trace?.outcome !== "completed") return [];
  const changed = [task.changedFiles, task.observedChangedFiles]
    .flatMap((value) => Array.isArray(value) ? value : []);
  const context = Array.isArray(task.contextManifest)
    ? task.contextManifest.map((item) => item && typeof item === "object" ? (item as { path?: unknown }).path : undefined)
    : [];
  return [...new Set([...changed, ...context]
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizePathCandidate(value))
    .filter((candidate): candidate is string => Boolean(
      candidate
      && candidate !== "."
      && !candidate.startsWith(".pi/")
      && !["AGENTS.md", "README.md", "REVIEW_GUIDELINES.md"].includes(candidate)
      && plausiblePath(candidate)
    )))]
    .slice(0, 8);
}
