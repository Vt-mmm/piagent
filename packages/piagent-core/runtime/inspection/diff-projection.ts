import { createHash } from "node:crypto";
import os from "node:os";
import { collectGitStatus, runReadOnlyGit, type GitStatusRecord, type GitStatusSnapshot } from "./git-status-adapter.ts";
import {
  collectSourceChangeViews,
  collectSelectedSourceFileState,
  sourceFileRef,
  type SourceChangeDocument,
  type SourceProjectionOptions,
  type WebUiIdentity
} from "./source-change-projection.ts";
import { WorkspaceReadError, inspectWorkspaceEntry, readWorkspaceFile } from "./workspace-file-reader.ts";
import { readTaskFileContents } from "./task-source-projection.ts";
import { diffTextBuffers } from "./text-diff.ts";
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_HUNKS = 128;
const DEFAULT_MAX_LINES = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_LENGTH = 16_384;
export type DiffPrecondition = {
  expectedViewRevision: string;
  expectedFileRevision: string;
  expectedBaseDigest: string | null;
  expectedCurrentDigest: string | null;
};
export type FileDiffOptions = {
  cwd: string;
  identity: WebUiIdentity;
  sourceView: SourceChangeDocument;
  fileRef: string;
  precondition: DiffPrecondition;
  generatedAt?: string;
  contextLines?: number;
  maxHunks?: number;
  maxLines?: number;
  maxBytes?: number;
  maxSourceBytes?: number;
  timeoutMs?: number;
  taskRevision?: string | null;
  isProtectedPath?: SourceProjectionOptions["isProtectedPath"];
  redactLine?: (text: string) => { text: string; redacted: boolean };
  revalidationMode?: "full-view" | "selected-file";
  selectedRepoPaths?: string[];
};

export type DiffDocument = Record<string, unknown> & {
  availability: { state: "current" | "stale" | "unavailable"; reasonCode: string | null; message: string | null; retryable: boolean };
  fallback: { kind: string; reasonCode: string | null; message: string | null };
  hunks: Array<Record<string, unknown>>;
};

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(prefix: string, value: string | Buffer): string {
  return `${prefix}.${hash(value)}`;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}

function sourceForView(views: Awaited<ReturnType<typeof collectSourceChangeViews>>, view: SourceChangeDocument["view"]): SourceChangeDocument | null {
  if (view === "working-tree") return views.workingTree;
  if (view === "staged") return views.staged;
  return views.task;
}

function findFile(source: SourceChangeDocument | null, fileRef: string): Record<string, any> | null {
  return source?.files.find((file) => file.fileRef === fileRef) as Record<string, any> | undefined ?? null;
}

function observed(source: SourceChangeDocument, file: Record<string, any> | null, fallback: Record<string, any>) {
  return {
    viewRevision: source.viewRevision,
    fileRevision: file?.fileRevision ?? token("file-missing", `${source.viewRevision}:${fallback.fileRef}`),
    baseDigest: file?.baseDigest ?? null,
    currentDigest: file?.currentDigest ?? null
  };
}

function samePrecondition(precondition: DiffPrecondition, current: ReturnType<typeof observed>): boolean {
  return precondition.expectedViewRevision === current.viewRevision
    && precondition.expectedFileRevision === current.fileRevision
    && precondition.expectedBaseDigest === current.baseDigest
    && precondition.expectedCurrentDigest === current.currentDigest;
}

function baseDocument(
  options: FileDiffOptions,
  source: SourceChangeDocument,
  file: Record<string, any>,
  currentObserved: ReturnType<typeof observed>
): DiffDocument {
  return {
    schemaVersion: 1,
    version: "piagent-webui-diff-v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    identity: options.identity,
    view: source.view,
    basis: (source.bases as Array<Record<string, unknown>>)[0],
    precondition: options.precondition,
    observed: currentObserved,
    file,
    availability: { state: "current", reasonCode: null, message: null, retryable: false },
    fallback: { kind: "none", reasonCode: null, message: null },
    hunks: [],
    unchangedRegions: [],
    truncation: { truncated: false, reasonCode: null, omittedHunks: 0, omittedLines: 0, nextCursor: null },
    redaction: { applied: false, valuesRemoved: 0, truncated: false },
    health: { state: "ok", reasonCode: null, message: null },
    issues: []
  };
}

function fallbackDocument(
  options: FileDiffOptions,
  source: SourceChangeDocument,
  file: Record<string, any>,
  currentObserved: ReturnType<typeof observed>,
  state: "current" | "stale" | "unavailable",
  kind: "binary" | "symlink" | "submodule" | "protected" | "oversized" | "conflict" | "unavailable" | "stale",
  reasonCode: string,
  message: string,
  retryable = false
): DiffDocument {
  const document = baseDocument(options, source, file, currentObserved);
  document.availability = { state, reasonCode: state === "current" ? null : reasonCode, message, retryable };
  document.fallback = { kind, reasonCode, message };
  document.health = state === "unavailable"
    ? { state: "unavailable", reasonCode, message }
    : { state: "degraded", reasonCode, message };
  return document;
}

function sanitizeLine(value: string): string {
  return value.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "�");
}

type ParsedPatch = {
  hunks: Array<Record<string, any>>;
  unchangedRegions: Array<Record<string, any>>;
  omittedHunks: number;
  omittedLines: number;
  redactedLines: number;
};

function parsePatch(
  raw: Buffer,
  fileRef: string,
  maxHunks: number,
  maxLines: number,
  redactLine?: FileDiffOptions["redactLine"]
): ParsedPatch {
  const input = raw.toString("utf8").split("\n");
  const hunks: Array<Record<string, any>> = [];
  let current: Record<string, any> | null = null;
  let oldLine = 0;
  let newLine = 0;
  let totalLines = 0;
  let omittedHunks = 0;
  let omittedLines = 0;
  let redactedLines = 0;

  for (const rawLine of input) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      if (hunks.length >= maxHunks) {
        omittedHunks += 1;
        current = null;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = {
        hunkRef: token("hunk", `${fileRef}:${line}`),
        oldStart: oldLine,
        oldLineCount: Number(match[2] ?? 1),
        newStart: newLine,
        newLineCount: Number(match[4] ?? 1),
        header: sanitizeLine(line).slice(0, 4_000),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current || !(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) continue;
    if (totalLines >= maxLines || current.lines.length >= 512) {
      omittedLines += 1;
      continue;
    }
    const marker = line[0];
    const sourceText = sanitizeLine(line.slice(marker === "\\" ? 2 : 1));
    const redaction = redactLine?.(sourceText) ?? { text: sourceText, redacted: false };
    let text = sanitizeLine(redaction.text);
    if (text.length > MAX_LINE_LENGTH) {
      text = text.slice(0, MAX_LINE_LENGTH);
      omittedLines += 1;
    }
    if (redaction.redacted) redactedLines += 1;
    const lineRef = token("line", `${current.hunkRef}:${current.lines.length}:${marker}:${oldLine}:${newLine}`);
    if (marker === " ") {
      current.lines.push({ lineRef, kind: "context", marker: " ", oldLineNumber: oldLine++, newLineNumber: newLine++, text, redacted: redaction.redacted });
    } else if (marker === "+") {
      current.lines.push({ lineRef, kind: "added", marker: "+", oldLineNumber: null, newLineNumber: newLine++, text, redacted: redaction.redacted });
    } else if (marker === "-") {
      current.lines.push({ lineRef, kind: "deleted", marker: "-", oldLineNumber: oldLine++, newLineNumber: null, text, redacted: redaction.redacted });
    } else {
      current.lines.push({ lineRef, kind: "no-newline-marker", marker: "\\", oldLineNumber: null, newLineNumber: null, text, redacted: false });
    }
    totalLines += 1;
  }

  const unchangedRegions: Array<Record<string, any>> = [];
  for (let index = 0; index < hunks.length; index += 1) {
    const after = hunks[index];
    const before = hunks[index - 1] ?? null;
    const oldStart = before ? before.oldStart + before.oldLineCount : 1;
    const newStart = before ? before.newStart + before.newLineCount : 1;
    const count = Math.min(after.oldStart - oldStart, after.newStart - newStart);
    if (count <= 0) continue;
    unchangedRegions.push({
      regionRef: token("region", `${fileRef}:${oldStart}:${newStart}:${count}`),
      oldStart,
      newStart,
      lineCount: count,
      beforeHunkRef: before?.hunkRef ?? null,
      afterHunkRef: after.hunkRef,
      contentState: "unavailable",
      expansionRef: null,
      reasonCode: "lazy-expansion-unavailable"
    });
  }
  return { hunks, unchangedRegions, omittedHunks, omittedLines, redactedLines };
}

function parseTaskPatch(
  base: Buffer | null,
  current: Buffer | null,
  fileRef: string,
  contextLines: number,
  maxHunks: number,
  maxLines: number,
  redactLine?: FileDiffOptions["redactLine"]
): ParsedPatch | null {
  const result = diffTextBuffers(base ?? Buffer.alloc(0), current ?? Buffer.alloc(0));
  if (!result.exact) return null;
  const changed = result.operations.flatMap((operation, index) => operation.kind === "context" ? [] : [index]);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(result.operations.length, index + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const hunks: Array<Record<string, any>> = [];
  let omittedHunks = 0;
  let omittedLines = 0;
  let emittedLines = 0;
  let redactedLines = 0;
  for (const range of ranges.flatMap(({ start, end }) => {
    const chunks = [];
    for (let offset = start; offset < end; offset += 512) chunks.push({ start: offset, end: Math.min(end, offset + 512) });
    return chunks;
  })) {
    if (hunks.length >= maxHunks) { omittedHunks += 1; continue; }
    let oldStart = 1;
    let newStart = 1;
    for (const operation of result.operations.slice(0, range.start)) {
      if (operation.kind !== "added") oldStart += 1;
      if (operation.kind !== "deleted") newStart += 1;
    }
    const selected = result.operations.slice(range.start, range.end);
    const oldCount = selected.filter((operation) => operation.kind !== "added").length;
    const newCount = selected.filter((operation) => operation.kind !== "deleted").length;
    const hunkRef = token("hunk", `${fileRef}:${range.start}:${range.end}`);
    const lines: Array<Record<string, any>> = [];
    let oldLine = oldStart;
    let newLine = newStart;
    for (const operation of selected) {
      if (emittedLines >= maxLines) { omittedLines += 1; continue; }
      const redaction = redactLine?.(operation.text) ?? { text: operation.text, redacted: false };
      const text = sanitizeLine(redaction.text).slice(0, MAX_LINE_LENGTH);
      if (redaction.redacted) redactedLines += 1;
      const lineRef = token("line", `${hunkRef}:${lines.length}:${oldLine}:${newLine}`);
      if (operation.kind === "context") lines.push({ lineRef, kind: "context", marker: " ", oldLineNumber: oldLine++, newLineNumber: newLine++, text, redacted: redaction.redacted });
      else if (operation.kind === "added") lines.push({ lineRef, kind: "added", marker: "+", oldLineNumber: null, newLineNumber: newLine++, text, redacted: redaction.redacted });
      else lines.push({ lineRef, kind: "deleted", marker: "-", oldLineNumber: oldLine++, newLineNumber: null, text, redacted: redaction.redacted });
      emittedLines += 1;
    }
    hunks.push({ hunkRef, oldStart, oldLineCount: oldCount, newStart, newLineCount: newCount, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines });
  }
  const unchangedRegions: Array<Record<string, any>> = [];
  for (let index = 1; index < hunks.length; index += 1) {
    const before = hunks[index - 1];
    const after = hunks[index];
    const oldStart = before.oldStart + before.oldLineCount;
    const newStart = before.newStart + before.newLineCount;
    const count = Math.min(after.oldStart - oldStart, after.newStart - newStart);
    if (count > 0) unchangedRegions.push({ regionRef: token("region", `${fileRef}:${oldStart}:${newStart}:${count}`), oldStart, newStart, lineCount: count,
      beforeHunkRef: before.hunkRef, afterHunkRef: after.hunkRef, contentState: "unavailable", expansionRef: null, reasonCode: "lazy-expansion-unavailable" });
  }
  return { hunks, unchangedRegions, omittedHunks, omittedLines, redactedLines };
}

function allAddedPatch(content: Buffer): Buffer {
  if (content.length === 0) return Buffer.alloc(0);
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const marker = !hasTrailingNewline && text.length > 0 ? "\n\\ No newline at end of file" : "";
  return Buffer.from(`@@ -0,0 +1,${lines.length} @@\n${body}${marker}\n`);
}

async function emptyTree(snapshot: GitStatusSnapshot, timeoutMs: number, maxBytes: number): Promise<string> {
  if (snapshot.headOid) return snapshot.headOid;
  const output = await runReadOnlyGit(snapshot.repoRoot, ["hash-object", "-t", "tree", os.devNull], { timeoutMs, maxBytes });
  return output.toString("ascii").trim();
}

async function patchForRecord(
  snapshot: GitStatusSnapshot,
  record: GitStatusRecord,
  view: "working-tree" | "staged",
  contextLines: number,
  timeoutMs: number,
  maxBytes: number
): Promise<Buffer> {
  const repoPath = record.path.value;
  if (!repoPath) throw new Error("Selected Git path is not addressable");
  if (record.kind === "untracked") {
    const stat = inspectWorkspaceEntry(snapshot.repoRoot, repoPath);
    if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error("Diff exceeds the byte cap"), { code: "output-limit" });
    return allAddedPatch(readWorkspaceFile(snapshot.repoRoot, repoPath, maxBytes));
  }
  const base = await emptyTree(snapshot, timeoutMs, maxBytes);
  const paths = [...new Set([record.oldPath?.value, repoPath].filter((value): value is string => Boolean(value)))];
  return await runReadOnlyGit(snapshot.repoRoot, [
    "diff",
    ...(view === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    `--unified=${contextLines}`,
    base,
    "--",
    ...paths
  ], { timeoutMs, maxBytes });
}

async function patchForUnstagedRecord(snapshot: GitStatusSnapshot, record: GitStatusRecord, contextLines: number,
  timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const repoPath = record.path.value;
  if (!repoPath) throw new Error("Selected Git path is not addressable");
  if (record.kind === "untracked") return allAddedPatch(readWorkspaceFile(snapshot.repoRoot, repoPath, maxBytes));
  const paths = [...new Set([record.oldPath?.value, repoPath].filter((value): value is string => Boolean(value)))];
  return runReadOnlyGit(snapshot.repoRoot, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames",
    `--unified=${contextLines}`, "--", ...paths], { timeoutMs, maxBytes });
}

export type ExactGitPatchAuthority = { header: Buffer; hunks: Array<{ hunkRef: string; bytes: Buffer }> };
type ExactGitPatchOptions = {
  snapshot: GitStatusSnapshot; record: GitStatusRecord; view: "unstaged" | "staged"; fileRef: string;
  contextLines?: number; timeoutMs?: number; maxBytes?: number; maxHunks?: number;
};
export async function collectExactGitPatchAuthority(input: ExactGitPatchOptions): Promise<ExactGitPatchAuthority | null> {
  const contextLines = integer(input.contextLines, DEFAULT_CONTEXT, 0, 100), timeoutMs = integer(input.timeoutMs, 5_000, 100, 60_000);
  const maxBytes = integer(input.maxBytes, DEFAULT_MAX_BYTES, 1_024, 16 * 1024 * 1024), maxHunks = integer(input.maxHunks, DEFAULT_MAX_HUNKS, 1, 128);
  const raw = input.view === "unstaged" ? await patchForUnstagedRecord(input.snapshot, input.record, contextLines, timeoutMs, maxBytes)
    : await patchForRecord(input.snapshot, input.record, "staged", contextLines, timeoutMs, maxBytes);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) return null;
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const header: string[] = [], hunks: Array<{ hunkRef: string; bytes: Buffer }> = [];
  let current: { hunkRef: string; lines: string[] } | null = null;
  for (const item of lines) {
    const line = item.replace(/\n$/, "").replace(/\r$/, "");
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (current) hunks.push({ hunkRef: current.hunkRef, bytes: Buffer.from(current.lines.join("")) });
      current = { hunkRef: token("hunk", `${input.fileRef}:${line}`), lines: [item] };
    } else if (current) current.lines.push(item);
    else header.push(item);
  }
  if (current) hunks.push({ hunkRef: current.hunkRef, bytes: Buffer.from(current.lines.join("")) });
  if (!hunks.length || hunks.length > maxHunks || !header.some((line) => line.startsWith("diff --git "))) return null;
  return { header: Buffer.from(header.join("")), hunks };
}

function sourceOptions(options: FileDiffOptions): SourceProjectionOptions {
  return {
    cwd: options.cwd,
    identity: options.identity,
    generatedAt: options.generatedAt,
    taskRevision: options.taskRevision,
    isProtectedPath: options.isProtectedPath,
    timeoutMs: options.timeoutMs,
    maxGitBytes: options.maxSourceBytes
  };
}

export async function collectFileDiff(options: FileDiffOptions): Promise<DiffDocument> {
  const originalFile = findFile(options.sourceView, options.fileRef);
  if (!originalFile) throw new Error("fileRef is not present in the canonical source view");
  const timeoutMs = integer(options.timeoutMs, 5_000, 100, 60_000);
  const maxBytes = integer(options.maxBytes, DEFAULT_MAX_BYTES, 1_024, 16 * 1024 * 1024);
  const maxSourceBytes = integer(options.maxSourceBytes, 16 * 1024 * 1024, 1_024, 64 * 1024 * 1024);
  const maxHunks = integer(options.maxHunks, DEFAULT_MAX_HUNKS, 1, 128);
  const maxLines = integer(options.maxLines, DEFAULT_MAX_LINES, 1, 65_536);
  const contextLines = integer(options.contextLines, DEFAULT_CONTEXT, 0, 100);

  const selectedMode = options.revalidationMode === "selected-file" && options.sourceView.view !== "task";
  const selectedState = selectedMode
    ? await collectSelectedSourceFileState(sourceOptions(options), options.sourceView.view as "working-tree" | "staged", options.fileRef, String(originalFile.basisRef), options.selectedRepoPaths)
    : null;
  const currentViews = selectedMode ? null : await collectSourceChangeViews(sourceOptions(options));
  const currentSource = selectedMode ? options.sourceView : sourceForView(currentViews as Awaited<ReturnType<typeof collectSourceChangeViews>>, options.sourceView.view);
  if (!currentSource) {
    return fallbackDocument(options, options.sourceView, originalFile, observed(options.sourceView, originalFile, originalFile), "unavailable", "unavailable", "source-view-unavailable", "The source view is unavailable");
  }
  const currentFile = selectedMode ? selectedState?.file as Record<string, any> | undefined ?? null : findFile(currentSource, options.fileRef);
  const currentObserved = observed(currentSource, currentFile, originalFile);
  if (currentSource.availability.state !== "current" || !currentFile || !samePrecondition(options.precondition, currentObserved)) {
    return fallbackDocument(options, currentSource, currentFile ?? originalFile, currentObserved, "stale", "stale", "stale-retry", "Source revisions changed; refresh and retry", true);
  }
  const content = currentFile.content as Record<string, unknown>;
  if (content.access === "protected") {
    return fallbackDocument(options, currentSource, currentFile, currentObserved, "unavailable", "protected", "protected-path", "Diff content is protected");
  }
  if (currentFile.status === "C") {
    return fallbackDocument(options, currentSource, currentFile, currentObserved, "current", "conflict", "git-conflict", "Resolve the Git conflict before rendering a canonical diff");
  }
  if (["binary", "symlink", "submodule"].includes(String(content.kind))) {
    const kind = content.kind as "binary" | "symlink" | "submodule";
    return fallbackDocument(options, currentSource, currentFile, currentObserved, "current", kind, `${kind}-content`, `A textual diff is not available for ${kind} content`);
  }
  if (content.access !== "available") {
    return fallbackDocument(options, currentSource, currentFile, currentObserved, "unavailable", "unavailable", "content-unavailable", "Diff content is unavailable");
  }

  let parsed: ParsedPatch;
  try {
    if (currentSource.view === "task") {
      const contentPair = await readTaskFileContents(sourceOptions(options), options.fileRef);
      const taskPatch = contentPair ? parseTaskPatch(contentPair.base, contentPair.current, options.fileRef, contextLines, maxHunks, maxLines, options.redactLine) : null;
      if (!taskPatch) return fallbackDocument(options, currentSource, currentFile, currentObserved, "unavailable", "oversized", "diff-complexity-limit", "Exact task diff exceeds its complexity or content cap");
      parsed = taskPatch;
    } else {
      const snapshot = selectedState?.snapshot ?? await collectGitStatus(options.cwd, { timeoutMs, maxBytes: maxSourceBytes });
      const record = selectedState?.record ?? snapshot.records.find((candidate) => sourceFileRef(snapshot, candidate) === options.fileRef) ?? null;
      if (!record) return fallbackDocument(options, currentSource, currentFile, currentObserved, "stale", "stale", "stale-retry", "The selected file changed during lookup", true);
      const rawPatch = await patchForRecord(snapshot, record, currentSource.view, contextLines, timeoutMs, maxBytes);
      parsed = parsePatch(rawPatch, options.fileRef, maxHunks, maxLines, options.redactLine);
    }
  } catch (error) {
    if ((error as any)?.code === "output-limit" || (error instanceof WorkspaceReadError && error.code === "oversized")) {
      return fallbackDocument(options, currentSource, currentFile, currentObserved, "unavailable", "oversized", "diff-output-limit", "Diff exceeds the configured byte cap");
    }
    if (error instanceof WorkspaceReadError && error.code === "changed-during-read") {
      return fallbackDocument(options, currentSource, currentFile, currentObserved, "stale", "stale", "stale-retry", "The selected file changed while rendering the diff", true);
    }
    if (error instanceof WorkspaceReadError) {
      return fallbackDocument(options, currentSource, currentFile, currentObserved, "unavailable", "unavailable", "unsafe-workspace-path", "The selected file could not be read safely");
    }
    throw error;
  }

  const finalSelected = selectedMode
    ? await collectSelectedSourceFileState(sourceOptions(options), currentSource.view as "working-tree" | "staged", options.fileRef, String(currentFile.basisRef), options.selectedRepoPaths)
    : null;
  const finalViews = selectedMode ? null : await collectSourceChangeViews(sourceOptions(options));
  const finalSource = selectedMode ? currentSource : sourceForView(finalViews as Awaited<ReturnType<typeof collectSourceChangeViews>>, currentSource.view);
  const finalFile = selectedMode ? finalSelected?.file as Record<string, any> | undefined ?? null : findFile(finalSource, options.fileRef);
  if (!finalSource || !finalFile || finalSource.viewRevision !== currentSource.viewRevision || finalFile.fileRevision !== currentFile.fileRevision) {
    const latestObserved = finalSource ? observed(finalSource, finalFile, currentFile) : currentObserved;
    return fallbackDocument(options, finalSource ?? currentSource, finalFile ?? currentFile, latestObserved, "stale", "stale", "stale-retry", "Source revisions changed while rendering the diff", true);
  }

  const document = baseDocument(options, currentSource, currentFile, currentObserved);
  document.hunks = parsed.hunks;
  document.unchangedRegions = parsed.unchangedRegions;
  const truncated = parsed.omittedHunks > 0 || parsed.omittedLines > 0;
  document.truncation = truncated
    ? {
        truncated: true,
        reasonCode: "diff-line-limit",
        omittedHunks: parsed.omittedHunks,
        omittedLines: parsed.omittedLines,
        nextCursor: token("diff-page", `${currentObserved.fileRevision}:${parsed.hunks.length}:${parsed.omittedLines}`)
      }
    : { truncated: false, reasonCode: null, omittedHunks: 0, omittedLines: 0, nextCursor: null };
  document.redaction = { applied: parsed.redactedLines > 0, valuesRemoved: parsed.redactedLines, truncated: false };
  if (truncated) document.health = { state: "degraded", reasonCode: "diff-line-limit", message: "Diff output was truncated by its line or hunk cap" };
  return document;
}
