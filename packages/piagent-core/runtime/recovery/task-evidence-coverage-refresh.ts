import fs from "node:fs";
import path from "node:path";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { readTaskJournal } from "../../extensions/task-journal.js";
import {
  directChildGitEvidenceRoots,
  normalizedGitPath
} from "../../extensions/workspace-evidence-roots.js";
import {
  workingTreeSnapshot,
  workingTreeSnapshotHasUnavailableEvidence
} from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../extensions/working-tree-digest.js";
import { readMutationProvenance } from "../inspection/mutation-provenance-store.ts";
import { readTaskBaselineManifest } from "../inspection/source-evidence-store.ts";

// Some filesystems expose timestamps at coarse granularity. Requiring a clear
// pre-task gap prevents a file created in the same timestamp bucket as task
// startup from being mistaken for legacy baseline state.
const LEGACY_EVIDENCE_TIMESTAMP_SAFETY_MS = 2_000;

export type TaskEvidenceCoverageRefresh = {
  task: TaskContract;
  refreshed: boolean;
  reason: string;
  addedPaths: string[];
  retainedMutationPaths: string[];
  ambiguousPaths: string[];
  previousBaselineDigest: string;
  nextBaselineDigest: string;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => normalizedGitPath(item).replace(/\/$/, "")))]
    : [];
}

function decodedMutationPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || !/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const normalized = normalizedGitPath(decoded);
    return normalized && normalized !== "." && normalized !== ".." && !normalized.startsWith("../")
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function journalMutationPaths(cwd: string, taskRunId: string): { paths: string[]; corruptions: string[] } {
  const journal = readTaskJournal(cwd, { taskRunId });
  const paths: string[] = [];
  for (const event of journal.events) {
    if (event.eventType !== "checkpoint" || event.taskRunId !== taskRunId) continue;
    const evidence = event.data?.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) continue;
    paths.push(...strings((evidence as Record<string, unknown>).files));
    paths.push(...strings((evidence as Record<string, unknown>).targetPaths));
  }
  return { paths: [...new Set(paths)].sort(), corruptions: journal.corruptions };
}

function provenanceMutationPaths(cwd: string, taskRunId: string): { paths: string[]; corruptions: string[] } {
  const provenance = readMutationProvenance(cwd, taskRunId);
  const paths = provenance.records.flatMap((record) => record.changes
    .map((change) => decodedMutationPath(change.repoPathBase64))
    .filter((item): item is string => Boolean(item)));
  return { paths: [...new Set(paths)].sort(), corruptions: provenance.corruptions };
}

function isLegacyLooseHiddenPath(file: string, childGitPrefixes: string[]): boolean {
  const normalized = normalizedGitPath(file);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return false;
  if (childGitPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return false;
  return normalized.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
}

function fileStatePredatesTask(cwd: string, file: string, createdAt: string): boolean {
  const taskStartedAt = Date.parse(createdAt);
  if (!Number.isFinite(taskStartedAt)) return false;
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;

  // The legacy inventory has no content digest for this path. Metadata that is
  // older than the task is the only local positive evidence that the exact file
  // state existed before task execution. A symlink, unreadable component, zero
  // timestamp, or any task-time ctime/mtime remains an ordinary task delta.
  let current = cwd;
  try {
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const component = fs.lstatSync(current);
      if (component.isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const timestamps = [stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs];
    const latestSafeTimestamp = taskStartedAt - LEGACY_EVIDENCE_TIMESTAMP_SAFETY_MS;
    return timestamps.every((value) => Number.isFinite(value) && value > 0 && value <= latestSafeTimestamp);
  } catch {
    return false;
  }
}

function manifestProvenBaselinePaths(
  cwd: string,
  task: TaskContract,
  previousBaseline: Record<string, string>,
  current: Record<string, string>,
  candidates: string[]
): string[] {
  if (candidates.length === 0) return [];
  try {
    const manifest = readTaskBaselineManifest(cwd, task.taskRunId);
    if (!manifest || manifest.taskId !== task.taskId || manifest.taskRunId !== task.taskRunId) return [];
    const expanded = { ...previousBaseline };
    for (const file of candidates) expanded[file] = current[file];
    return workingTreeEvidenceDigest(expanded) === manifest.baselineTreeDigest ? candidates : [];
  } catch {
    return [];
  }
}

/**
 * Reconcile the one coverage gap introduced when parent-workspace evidence
 * began including hidden project source. Only paths the legacy collector could
 * not see are adopted, and any path with durable mutation evidence remains a
 * real task delta. Existing baseline entries are never rewritten.
 */
export function refreshLegacyHiddenWorkspaceEvidenceCoverage(
  cwd: string,
  task: TaskContract
): TaskEvidenceCoverageRefresh {
  const previousBaseline = task.baselineFileDigests ?? {};
  const previousBaselineDigest = workingTreeEvidenceDigest(previousBaseline);
  const unchanged = (
    reason: string,
    retainedMutationPaths: string[] = [],
    ambiguousPaths: string[] = []
  ): TaskEvidenceCoverageRefresh => ({
    task,
    refreshed: false,
    reason,
    addedPaths: [],
    retainedMutationPaths,
    ambiguousPaths,
    previousBaselineDigest,
    nextBaselineDigest: previousBaselineDigest
  });

  if (task.trace.outcome !== "pending" || task.changeMode !== "source-change") return unchanged("task-not-refreshable");
  if (!previousBaseline || typeof previousBaseline !== "object" || Array.isArray(previousBaseline)) return unchanged("baseline-unavailable");
  const childGitPrefixes = directChildGitEvidenceRoots(cwd).map((root) => normalizedGitPath(root.prefix)).filter(Boolean);
  if (childGitPrefixes.length === 0) return unchanged("not-parent-multi-repo-workspace");

  const current = workingTreeSnapshot(cwd) as Record<string, string>;
  if (workingTreeSnapshotHasUnavailableEvidence(current)) return unchanged("current-evidence-unavailable");
  const candidates = Object.keys(current)
    .filter((file) => previousBaseline[file] === undefined && isLegacyLooseHiddenPath(file, childGitPrefixes))
    .sort();
  if (candidates.length === 0) return unchanged("coverage-current");

  const journal = journalMutationPaths(cwd, task.taskRunId);
  const provenance = provenanceMutationPaths(cwd, task.taskRunId);
  if (journal.corruptions.length > 0 || provenance.corruptions.length > 0) {
    return unchanged("mutation-evidence-unavailable");
  }
  const mutated = new Set([
    ...strings(task.observedChangedFiles),
    ...strings(task.changedFiles),
    ...journal.paths,
    ...provenance.paths
  ]);
  const retainedMutationPaths = candidates.filter((file) => mutated.has(file));
  const unclaimedCandidates = candidates.filter((file) => !mutated.has(file));
  // A current, integrity-validated baseline manifest is stronger than file
  // timestamps: if adding the currently observed missing paths reconstructs
  // its exact task-start tree digest, none of those paths changed after start.
  // Legacy manifests that did not cover the paths simply fail this equality
  // and retain the conservative timestamp fallback.
  const manifestProven = new Set(manifestProvenBaselinePaths(cwd, task, previousBaseline, current, unclaimedCandidates));
  const addedPaths = unclaimedCandidates.filter((file) => manifestProven.has(file) || fileStatePredatesTask(cwd, file, task.createdAt));
  const added = new Set(addedPaths);
  const ambiguousPaths = unclaimedCandidates.filter((file) => !added.has(file));
  if (addedPaths.length === 0) {
    return unchanged(
      ambiguousPaths.length > 0 ? "coverage-candidates-ambiguous" : "coverage-candidates-have-mutation-evidence",
      retainedMutationPaths,
      ambiguousPaths
    );
  }

  const baselineFileDigests = { ...previousBaseline };
  for (const file of addedPaths) baselineFileDigests[file] = current[file];
  const refreshed: TaskContract = {
    ...task,
    baselineChangedFiles: Object.keys(baselineFileDigests).sort(),
    baselineFileDigests
  };
  return {
    task: refreshed,
    refreshed: true,
    reason: ambiguousPaths.length > 0
      ? "legacy-hidden-workspace-coverage-partially-expanded"
      : "legacy-hidden-workspace-coverage-expanded",
    addedPaths,
    retainedMutationPaths,
    ambiguousPaths,
    previousBaselineDigest,
    nextBaselineDigest: workingTreeEvidenceDigest(baselineFileDigests)
  };
}
