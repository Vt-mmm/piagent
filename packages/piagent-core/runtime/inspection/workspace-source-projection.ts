import { createHash } from "node:crypto";

import {
  collectSourceChangeViews,
  type SourceChangeDocument,
  type SourceChangeViews,
  type SourceProjectionOptions
} from "./source-change-projection.ts";

export type WorkspaceSourceProjectionOptions = Omit<SourceProjectionOptions, "cwd" | "pageLimit"> & {
  roots: string[];
  pageLimit?: number;
};

function token(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(value).digest("hex")}`;
}

function combineDocuments(
  documents: SourceChangeDocument[],
  view: SourceChangeDocument["view"],
  pageLimit: number
): SourceChangeDocument {
  const template = structuredClone(documents[0]);
  const viewRevision = token("workspace-view", JSON.stringify(documents.map((document) => document.viewRevision)));
  const bases = documents.flatMap((document) => document.bases as Array<Record<string, unknown>>);
  const states = documents.map((document) => document.availability.state);
  const anyUnavailable = states.includes("unavailable");
  const anyStale = states.includes("stale");
  const exact = !anyUnavailable && !anyStale;
  const allFiles = exact
    ? documents.flatMap((document) => document.files).sort((left, right) => {
        const repo = String(left.repoRef).localeCompare(String(right.repoRef), "en");
        return repo || String(left.path).localeCompare(String(right.path), "en");
      })
    : [];
  const files = allFiles.slice(0, pageLimit);
  const childTruncated = documents.some((document) => (document.page as any).truncated === true);
  const rawTotal = exact ? documents.reduce((total, document) => total + Number((document.page as any).total ?? 0), 0) : 0;
  const total = Math.min(1_000_000, rawTotal);
  const truncated = exact && (childTruncated || files.length < allFiles.length || rawTotal > total);
  const reasonCode = anyUnavailable ? "repository-view-unavailable" : anyStale ? "git-race" : null;
  const rawRemoved = documents.reduce((sum, document) => sum + Number((document.redaction as any).valuesRemoved ?? 0), 0);
  const valuesRemoved = Math.min(10_000, rawRemoved);
  return {
    ...template,
    view,
    viewRevision,
    bases,
    availability: exact
      ? { state: "current", reasonCode: null, message: null }
      : anyUnavailable
        ? { state: "unavailable", reasonCode, message: "At least one repository view is unavailable" }
        : { state: "stale", reasonCode, message: "At least one repository changed during collection" },
    files,
    page: {
      cursor: null,
      nextCursor: truncated ? token("workspace-page", `${viewRevision}:${pageLimit}`) : null,
      total,
      returned: files.length,
      truncated
    },
    truncationReason: truncated ? "page-limit" : null,
    redaction: {
      applied: documents.some((document) => (document.redaction as any).applied === true),
      valuesRemoved,
      truncated: rawRemoved > valuesRemoved || documents.some((document) => (document.redaction as any).truncated === true)
    },
    health: exact
      ? documents.some((document) => (document.health as any).state !== "ok")
        ? { state: "degraded", reasonCode: "repository-view-degraded", message: "At least one repository view is degraded" }
        : { state: "ok", reasonCode: null, message: null }
      : anyUnavailable
        ? { state: "unavailable", reasonCode, message: "At least one repository view is unavailable" }
        : { state: "degraded", reasonCode, message: "At least one repository view is stale" },
    issues: documents.flatMap((document) => document.issues as Array<Record<string, unknown>>).slice(0, 64)
  };
}

export async function collectWorkspaceSourceChangeViews(options: WorkspaceSourceProjectionOptions): Promise<SourceChangeViews> {
  const roots = [...new Set(options.roots)];
  if (roots.length === 0) throw new Error("At least one workspace Git root is required");
  if (roots.length > 32) throw new Error("Workspace source projection supports at most 32 Git roots");
  const pageLimit = Number.isInteger(options.pageLimit) ? Math.max(1, Math.min(2_000, options.pageLimit as number)) : 300;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const raw = await Promise.all(roots.map((cwd) => collectSourceChangeViews({ ...options, cwd, pageLimit: 2_000, generatedAt })));
  const collected = [...new Map(raw.map((views) => [String((views.workingTree.bases as any[])[0]?.repoRef), views])).values()];
  const working = collected.map((views) => views.workingTree);
  const staged = collected.map((views) => views.staged);
  const task = collected.map((views) => views.task).filter((document): document is SourceChangeDocument => document !== null);
  return {
    workingTree: combineDocuments(working, "working-tree", pageLimit),
    staged: combineDocuments(staged, "staged", pageLimit),
    task: task.length === collected.length ? combineDocuments(task, "task", pageLimit) : null
  };
}
