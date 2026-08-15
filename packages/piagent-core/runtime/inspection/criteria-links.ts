import { createHash } from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { hashEvidenceCommand } from "../../extensions/runtime-evidence.js";
import { matchesAnyPath, normalizePathCandidate } from "../../extensions/policy-core.js";
import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { isCurrentWorkingTreeDigest, workingTreeEvidenceDigest, workingTreeSnapshotUsesCurrentAlgorithm } from "../../extensions/working-tree-digest.js";
import type { ActivityInspectorEvent } from "../product/activity-inspector.ts";
import type { SourceChangeViews } from "./source-change-projection.ts";
import {
  decodeVerifierSnapshotPath,
  type VerifierFileSnapshot
} from "./verifier-snapshot-contract.ts";
import {
  findVerifierFileSnapshot,
  inspectVerifierStaleness,
  readVerifierFileSnapshots
} from "./verifier-snapshot-store.ts";

export type CriterionRelationSource = "target-hint" | "explicit-evidence" | "verifier-declaration";
export type CriterionRelation = {
  criterionId: string;
  fileRef: string | null;
  verifierAttemptRef: string | null;
  source: CriterionRelationSource;
};
export type CriterionProjection = {
  criterionId: string;
  obligation: string;
  priority: "normal" | "critical";
  state: "pending" | "satisfied" | "blocked" | "unknown";
  evidence: "observed" | "derived" | "unavailable";
  relatedFileRefs: string[];
  verifierAttemptRefs: string[];
  reasonCode: string | null;
};
export type VerifierAttemptProjection = {
  attemptRef: string;
  command: string;
  commandDigest: string;
  exact: boolean;
  state: "passed" | "failed" | "stale" | "unknown";
  exitCode: number;
  exitCodeExact: boolean;
  treeDigest: string | null;
  startedAt: string;
  finishedAt: string;
  staleByFileRefs: string[];
  staleByPaths: string[];
  staleFilesKnown: boolean;
};
export type CriteriaLinkProjection = {
  criteria: CriterionProjection[];
  sourceViews: SourceChangeViews;
  verifierAttempts: VerifierAttemptProjection[];
  verification: {
    state: "not-run" | "current" | "failed" | "stale" | "unavailable";
    latest: VerifierAttemptProjection | null;
    requiredCommands: string[];
    reasonCode: string | null;
    health: { state: "ok" | "degraded" | "unavailable"; reasonCode: string | null; message: string | null };
  };
  relations: CriterionRelation[];
};

type FileLink = { path: string; fileRef: string; criterionIds: Set<string>; verifierAttemptIds: Set<string> };
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function strings(values: unknown[], maximum = 300): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort().slice(0, maximum);
}
function safeTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && TIMESTAMP.test(value) ? value : fallback;
}
function commandDigest(command: string): string {
  const exact = hashEvidenceCommand(command);
  return `sha256:${exact || hash(`redacted-verifier-command\0${command}`)}`;
}
function safeCommand(command: string): string {
  return redactSensitiveText(command).text.replace(/\u0000/g, " ").slice(0, 4000) || "[verifier command unavailable]";
}
function evidenceObservedAt(evidence: TaskContract["verifyEvidence"][number]): string {
  return safeTimestamp(evidence.observedAt, safeTimestamp(evidence.recordedAt, "1970-01-01T00:00:00.000Z"));
}

function cloneViews(views: SourceChangeViews): SourceChangeViews {
  return structuredClone(views);
}

function fileLinks(views: SourceChangeViews): { links: FileLink[]; byPath: Map<string, FileLink[]>; byRef: Map<string, FileLink[]> } {
  const links: FileLink[] = [];
  for (const view of [views.task, views.workingTree, views.staged]) {
    for (const file of view?.files ?? []) {
      const path = normalizePathCandidate(String(file.path ?? ""));
      const fileRef = String(file.fileRef ?? "");
      if (!path || !fileRef) continue;
      const link = {
        path,
        fileRef,
        criterionIds: new Set(Array.isArray(file.criterionIds) ? file.criterionIds as string[] : []),
        verifierAttemptIds: new Set(Array.isArray(file.verifierAttemptIds) ? file.verifierAttemptIds as string[] : [])
      };
      links.push(link);
    }
  }
  const byPath = new Map<string, FileLink[]>(), byRef = new Map<string, FileLink[]>();
  for (const link of links) {
    byPath.set(link.path, [...(byPath.get(link.path) ?? []), link]);
    byRef.set(link.fileRef, [...(byRef.get(link.fileRef) ?? []), link]);
  }
  return { links, byPath, byRef };
}

function applyFileLinks(views: SourceChangeViews, links: FileLink[]): void {
  const values = new Map(links.map((link) => [`${link.fileRef}\0${link.path}`, link]));
  for (const view of [views.task, views.workingTree, views.staged]) {
    for (const file of view?.files ?? []) {
      const link = values.get(`${String(file.fileRef)}\0${normalizePathCandidate(String(file.path ?? ""))}`);
      if (!link) continue;
      file.criterionIds = strings([...link.criterionIds], 128);
      file.verifierAttemptIds = strings([...link.verifierAttemptIds], 128);
    }
  }
}

function matchRecord(evidence: TaskContract["verifyEvidence"][number], records: VerifierFileSnapshot[]) {
  const digest = commandDigest(evidence.command);
  return findVerifierFileSnapshot(records, {
    commandDigest: digest,
    observedAt: evidenceObservedAt(evidence),
    treeDigest: String(evidence.workingTreeDigest ?? ""),
    exitCode: evidence.exitCode
  });
}

function startedAtFor(evidence: TaskContract["verifyEvidence"][number], events: ActivityInspectorEvent[]): string {
  const observedAt = evidenceObservedAt(evidence);
  const digest = commandDigest(evidence.command);
  const candidates = events.filter((event) => event.event === "tool_call"
    && typeof event.command === "string" && commandDigest(event.command) === digest
    && safeTimestamp(event.recordedAt, observedAt) <= observedAt);
  return safeTimestamp(candidates.at(-1)?.recordedAt, observedAt);
}

function verifierProjection(input: {
  task: TaskContract;
  records: VerifierFileSnapshot[];
  currentSnapshot: Record<string, string>;
  protectedPaths: string[];
  filesByPath: Map<string, FileLink[]>;
  events: ActivityInspectorEvent[];
  at: Date;
}): VerifierAttemptProjection[] {
  const currentCapable = workingTreeSnapshotUsesCurrentAlgorithm(input.currentSnapshot);
  const currentDigest = currentCapable ? workingTreeEvidenceDigest(input.currentSnapshot) : null;
  return input.task.verifyEvidence.slice(-64).map((evidence) => {
    const record = matchRecord(evidence, input.records);
    const observedAt = evidenceObservedAt(evidence);
    const treeDigest = isCurrentWorkingTreeDigest(evidence.workingTreeDigest) ? evidence.workingTreeDigest : null;
    const exact = evidence.observed === true && treeDigest !== null
      && input.task.verifyCommands.some((command) => commandDigest(command) === commandDigest(evidence.command));
    const staleness = evidence.exitCode === 0 && record
      ? inspectVerifierStaleness(record, input.currentSnapshot, input.protectedPaths, input.at)
      : undefined;
    const stalePaths = staleness?.invalidatedByFiles ?? [];
    const staleRefs = strings(stalePaths.flatMap((file) => (input.filesByPath.get(file) ?? []).map((link) => link.fileRef)));
    const state = evidence.exitCode !== 0
      ? "failed"
      : exact && currentDigest && treeDigest === currentDigest
        ? "passed"
        : exact && currentDigest && treeDigest
          ? "stale"
          : "unknown";
    return {
      attemptRef: record?.attemptRef ?? `verifier-evidence.${hash(JSON.stringify([input.task.taskRunId, commandDigest(evidence.command), observedAt, treeDigest, evidence.exitCode]))}`,
      command: safeCommand(evidence.command),
      commandDigest: record?.commandDigest ?? commandDigest(evidence.command),
      exact,
      state,
      exitCode: evidence.exitCode,
      exitCodeExact: evidence.observed === true,
      treeDigest,
      startedAt: startedAtFor(evidence, input.events),
      finishedAt: observedAt,
      staleByFileRefs: staleRefs,
      staleByPaths: strings(stalePaths),
      staleFilesKnown: state === "stale" ? staleness?.filesKnown === true : state === "passed"
    };
  });
}

function recordPaths(record: VerifierFileSnapshot): string[] {
  return record.files.map(decodeVerifierSnapshotPath).filter((value): value is string => Boolean(value));
}

function criterionGraphNode(task: TaskContract, receiptIndex: number, criterionHash: string) {
  const criterionIndex = task.acceptanceCriteria.findIndex((text) => hash(text) === criterionHash);
  return task.criterionGraph?.nodes.find((node) => node.criterionIndex === (criterionIndex >= 0 ? criterionIndex : receiptIndex));
}

export function projectCriteriaFileVerifier(input: {
  cwd: string;
  task?: TaskContract;
  sourceViews: SourceChangeViews;
  currentSnapshot: Record<string, string>;
  protectedPaths?: string[];
  events?: ActivityInspectorEvent[];
  at?: Date;
}): CriteriaLinkProjection {
  const views = cloneViews(input.sourceViews);
  const indexed = fileLinks(views);
  if (!input.task) {
    return {
      criteria: [], sourceViews: views, verifierAttempts: [], relations: [],
      verification: { state: "unavailable", latest: null, requiredCommands: [], reasonCode: "no-active-task", health: { state: "ok", reasonCode: null, message: null } }
    };
  }
  const read = readVerifierFileSnapshots(input.cwd, input.task.taskRunId);
  const attempts = verifierProjection({ task: input.task, records: read.records, currentSnapshot: input.currentSnapshot,
    protectedPaths: input.protectedPaths ?? input.task.protectedPaths, filesByPath: indexed.byPath,
    events: input.events ?? [], at: input.at ?? new Date() });
  const attemptByEvidence = new Map<string, VerifierAttemptProjection>();
  input.task.verifyEvidence.slice(-64).forEach((evidence, index) => attemptByEvidence.set(`${commandDigest(evidence.command)}\0${evidenceObservedAt(evidence)}`, attempts[index]));
  for (const record of read.records) {
    const attempt = attempts.find((candidate) => candidate.attemptRef === record.attemptRef);
    if (!attempt) continue;
    for (const file of recordPaths(record)) for (const link of indexed.byPath.get(file) ?? []) link.verifierAttemptIds.add(attempt.attemptRef);
    for (const file of attempt.staleByPaths) for (const link of indexed.byPath.get(file) ?? []) link.verifierAttemptIds.add(attempt.attemptRef);
  }

  const relations: CriterionRelation[] = [];
  const receipt = input.task.acceptanceReceipt;
  const criteria = (receipt?.criteria ?? []).slice(0, 64).map((criterion, index): CriterionProjection => {
    const node = criterionGraphNode(input.task as TaskContract, index, criterion.hash);
    const related = new Set<string>(), verifierRefs = new Set<string>();
    const addFile = (link: FileLink, source: CriterionRelationSource) => {
      link.criterionIds.add(criterion.id); related.add(link.fileRef);
      relations.push({ criterionId: criterion.id, fileRef: link.fileRef, verifierAttemptRef: null, source });
    };
    for (const hint of node?.targetHints ?? []) {
      for (const link of indexed.links) if (matchesAnyPath(link.path, [hint])) addFile(link, "target-hint");
    }
    for (const evidence of criterion.evidence ?? []) {
      for (const evidencePath of evidence.paths ?? []) {
        for (const link of indexed.links) if (matchesAnyPath(link.path, [evidencePath])) addFile(link, "explicit-evidence");
      }
      if (evidence.command) {
        const attempt = [...attemptByEvidence.entries()].reverse().find(([key]) => key.startsWith(`${commandDigest(evidence.command)}\0`))?.[1];
        if (attempt) {
          verifierRefs.add(attempt.attemptRef);
          relations.push({ criterionId: criterion.id, fileRef: null, verifierAttemptRef: attempt.attemptRef, source: "explicit-evidence" });
        }
      }
    }
    if (node?.proofKinds.includes("exact-verifier")) {
      for (const attempt of attempts) {
        if (!input.task?.verifyCommands.some((command) => commandDigest(command) === attempt.commandDigest)) continue;
        verifierRefs.add(attempt.attemptRef);
        relations.push({ criterionId: criterion.id, fileRef: null, verifierAttemptRef: attempt.attemptRef, source: "verifier-declaration" });
      }
    }
    return {
      criterionId: criterion.id,
      obligation: node?.obligation ?? input.task?.acceptanceCriteria.find((text) => hash(text) === criterion.hash) ?? criterion.obligation,
      priority: criterion.priority,
      state: criterion.status,
      evidence: receipt?.source === "runtime" ? "observed" : "derived",
      relatedFileRefs: strings([...related]),
      verifierAttemptRefs: strings([...verifierRefs], 64),
      reasonCode: null
    };
  });
  if (!receipt) {
    for (const node of input.task.criterionGraph?.nodes ?? []) criteria.push({ criterionId: node.id, obligation: node.obligation,
      priority: "normal", state: "unknown", evidence: "unavailable", relatedFileRefs: [], verifierAttemptRefs: [], reasonCode: "acceptance-receipt-unavailable" });
  }
  applyFileLinks(views, indexed.links);
  const latest = attempts.at(-1) ?? null;
  const requiredDigests = strings(input.task.verifyCommands, 64).map(commandDigest);
  const allRequiredCurrent = requiredDigests.length > 0 && requiredDigests.every((digest) =>
    [...attempts].reverse().find((attempt) => attempt.commandDigest === digest)?.state === "passed");
  const verification = !latest
    ? { state: "not-run" as const, latest: null, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: null, health: { state: read.corruptions.length ? "degraded" as const : "ok" as const, reasonCode: read.corruptions.length ? "verifier-snapshot-corrupt" : null, message: read.corruptions.length ? "Verifier file evidence is corrupt or unavailable" : null } }
    : latest.state === "passed" && allRequiredCurrent
      ? { state: "current" as const, latest, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: null, health: { state: read.corruptions.length ? "degraded" as const : "ok" as const, reasonCode: read.corruptions.length ? "verifier-snapshot-corrupt" : null, message: read.corruptions.length ? "Verifier file evidence is corrupt or unavailable" : null } }
      : latest.state === "passed"
        ? { state: "unavailable" as const, latest: null, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: "required-verifier-incomplete", health: { state: "degraded" as const, reasonCode: "required-verifier-incomplete", message: "Not every configured verifier has a current exact pass" } }
      : latest.state === "failed"
        ? { state: "failed" as const, latest, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: "verifier-exit-nonzero", health: { state: "ok" as const, reasonCode: null, message: null } }
        : latest.state === "stale"
          ? { state: "stale" as const, latest, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: "working-tree-changed-after-verifier", health: { state: read.corruptions.length ? "degraded" as const : "ok" as const, reasonCode: read.corruptions.length ? "verifier-snapshot-corrupt" : null, message: read.corruptions.length ? "Stale files cannot be identified from corrupt verifier evidence" : null } }
          : { state: "unavailable" as const, latest: null, requiredCommands: strings(input.task.verifyCommands, 64), reasonCode: "current-tree-unavailable", health: { state: "unavailable" as const, reasonCode: "current-tree-unavailable", message: "Current tree evidence is unavailable" } };
  return { criteria, sourceViews: views, verifierAttempts: attempts, verification, relations };
}
