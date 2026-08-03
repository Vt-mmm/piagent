import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { redactForStorage, redactSensitiveText } from "../../extensions/redaction-core.js";
import { appendJsonlBounded, pruneCaptureFiles, readJsonlTail } from "../../extensions/state-retention.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import {
  CAPTURE_INDEX_MAX_BYTES,
  CAPTURE_RETENTION_MAX_AGE_MS,
  CAPTURE_RETENTION_MAX_BYTES,
  CAPTURE_RETENTION_MAX_FILES,
  TOOL_RESULT_CAPTURE_MAX_CHARS,
  TOOL_RESULT_COMPACT_CHAR_THRESHOLD,
  TOOL_RESULT_COMPACT_LINE_THRESHOLD,
  TOOL_RESULT_PREVIEW_HEAD_LINES,
  TOOL_RESULT_PREVIEW_INTERESTING_LINES,
  TOOL_RESULT_PREVIEW_MAX_CHARS,
  TOOL_RESULT_PREVIEW_TAIL_LINES
} from "../runtime-limits.ts";
import { formatCount } from "./usage.ts";

export type ToolResultCaptureSummary = {
  path?: string;
  error?: string;
  source: string;
  toolName: string;
  originalChars: number;
  originalLines: number;
  previewChars?: number;
  storedChars?: number;
  storedTruncated?: boolean;
  sha256: string;
};

const captureWritesSincePrune = new Map<string, number>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "tool";
}

function nowIso(): string {
  return new Date().toISOString();
}

function redactText(input: string): string {
  return redactSensitiveText(input).text;
}

export function toolResultCaptureRoot(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-state", "tool-results");
}

function toolResultCaptureIndexPath(cwd: string): string {
  return path.join(toolResultCaptureRoot(cwd), "index.jsonl");
}

function normalizeToolResultText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function toolResultLineCount(text: string): number {
  if (!text) return 0;
  return normalizeToolResultText(text).split("\n").length;
}

function shouldCompactToolResultText(text: string): boolean {
  return text.length > TOOL_RESULT_COMPACT_CHAR_THRESHOLD
    || toolResultLineCount(text) > TOOL_RESULT_COMPACT_LINE_THRESHOLD;
}

function clipPreviewLine(line: string, maxChars = 260): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars).trimEnd()} ... [line clipped]`;
}

function boundedPreview(text: string): string {
  if (text.length <= TOOL_RESULT_PREVIEW_MAX_CHARS) return text;
  const marker = "\n[Piagent preview shortened further to stay light.]\n";
  const edge = Math.floor((TOOL_RESULT_PREVIEW_MAX_CHARS - marker.length) / 2);
  return `${text.slice(0, edge).trimEnd()}${marker}${text.slice(-edge).trimStart()}`;
}

function interestingToolResultLines(lines: string[]): string[] {
  const interesting = /\b(?:error|errors|err!|failed?|failure|warning|warn|exception|traceback|assert(?:ion)?|panic|fatal|timeout|timed out|denied|not found|cannot|eacces|enoent|ts\d{3,5}|err_[a-z0-9_]+)\b/i;
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!interesting.test(line)) continue;
    const rendered = `${index + 1}: ${clipPreviewLine(line)}`;
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    result.push(rendered);
    if (result.length >= TOOL_RESULT_PREVIEW_INTERESTING_LINES) break;
  }
  return result;
}

function storedToolResultText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_RESULT_CAPTURE_MAX_CHARS) return { text, truncated: false };
  const marker = `\n\n[Piagent capture truncated: omitted ${formatCount(text.length - TOOL_RESULT_CAPTURE_MAX_CHARS)} chars from the middle.]\n\n`;
  const edge = Math.floor((TOOL_RESULT_CAPTURE_MAX_CHARS - marker.length) / 2);
  return {
    text: `${text.slice(0, edge).trimEnd()}${marker}${text.slice(-edge).trimStart()}`,
    truncated: true
  };
}

function compactToolResultPreview(toolName: string, source: string, text: string, capture: ToolResultCaptureSummary): string {
  const normalized = normalizeToolResultText(text);
  const lines = normalized.split("\n");
  const head = lines.slice(0, TOOL_RESULT_PREVIEW_HEAD_LINES).map((line) => clipPreviewLine(line));
  const tailStart = Math.max(TOOL_RESULT_PREVIEW_HEAD_LINES, lines.length - TOOL_RESULT_PREVIEW_TAIL_LINES);
  const tail = lines.slice(tailStart).map((line) => clipPreviewLine(line));
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  const interesting = interestingToolResultLines(lines);
  const captureLine = capture.path
    ? `capture: ${capture.path}${capture.storedTruncated ? " (stored head/tail sample; original too large)" : ""}`
    : `capture: unavailable (${capture.error ?? "write failed"})`;
  const sections = [
    `[Piagent compacted large ${toolName} output from ${source}: ${formatCount(capture.originalChars)} chars / ${formatCount(capture.originalLines)} lines.]`,
    `[${captureLine}]`,
    "[Preview keeps head, notable lines, and tail.]",
    "",
    "head:",
    ...head
  ];
  if (interesting.length > 0) sections.push("", "notable:", ...interesting);
  if (omitted > 0) sections.push("", `... ${formatCount(omitted)} middle line${omitted === 1 ? "" : "s"} omitted ...`);
  sections.push("", "tail:", ...tail);
  return boundedPreview(sections.join("\n"));
}

function maybeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function currentSessionField(ctx: ExtensionContext, field: "getSessionFile" | "getSessionId" | "getSessionName"): string | undefined {
  try {
    const value = ctx.sessionManager[field]?.();
    return value === undefined || value === null ? undefined : redactText(String(value));
  } catch {
    return undefined;
  }
}

function writeToolResultCapture(
  cwd: string,
  event: any,
  ctx: ExtensionContext,
  source: string,
  text: string,
  cache: Map<string, ToolResultCaptureSummary>
): ToolResultCaptureSummary {
  const normalized = normalizeToolResultText(text);
  const sha256 = crypto.createHash("sha256").update(normalized).digest("hex");
  const originalLines = toolResultLineCount(normalized);
  const cached = cache.get(sha256);
  if (cached?.path) return { ...cached, source };

  const toolName = String(event?.toolName ?? "tool");
  const recordedAt = nowIso();
  const date = recordedAt.slice(0, 10);
  const filename = `${recordedAt.replace(/[:.]/g, "-")}-${slugify(toolName)}-${sha256.slice(0, 12)}.log`;
  const relativePath = [".pi", "piagent-state", "tool-results", date, filename].join("/");
  const absolutePath = path.join(cwd, ".pi", "piagent-state", "tool-results", date, filename);
  const capture = storedToolResultText(normalized);
  const details = event?.details && typeof event.details === "object" ? event.details : {};
  const exitCode = maybeNumber(details.exitCode ?? details.status ?? event?.exitCode);
  const metadata = {
    schemaVersion: 1,
    recordedAt,
    cwd: redactText(cwd),
    sessionId: currentSessionField(ctx, "getSessionId"),
    sessionName: currentSessionField(ctx, "getSessionName"),
    sessionFile: currentSessionField(ctx, "getSessionFile"),
    toolName,
    source,
    isError: event?.isError === true,
    exitCode,
    input: redactForStorage(event?.input),
    path: relativePath,
    originalChars: normalized.length,
    originalLines,
    storedChars: capture.text.length,
    storedTruncated: capture.truncated,
    sha256
  };

  try {
    ensurePrivateStateDirectory(cwd, path.dirname(absolutePath), "Tool-result capture directory");
    const capturePath = resolveLocalStatePath(cwd, absolutePath, { label: "Tool-result capture" });
    fs.writeFileSync(capturePath, [
      "# Piagent compacted tool result capture",
      JSON.stringify(metadata),
      "---",
      capture.text
    ].join("\n"), { mode: 0o600 });
    appendJsonlBounded(toolResultCaptureIndexPath(cwd), metadata, { maxBytes: CAPTURE_INDEX_MAX_BYTES, mode: 0o600, projectRoot: cwd });
    const writes = (captureWritesSincePrune.get(cwd) ?? 0) + 1;
    if (writes >= 25) {
      pruneCaptureFiles(toolResultCaptureRoot(cwd), {
        maxFiles: CAPTURE_RETENTION_MAX_FILES,
        maxBytes: CAPTURE_RETENTION_MAX_BYTES,
        maxAgeMs: CAPTURE_RETENTION_MAX_AGE_MS,
        projectRoot: cwd
      });
      captureWritesSincePrune.set(cwd, 0);
    } else {
      captureWritesSincePrune.set(cwd, writes);
    }
    const summary = {
      path: relativePath,
      source,
      toolName,
      originalChars: normalized.length,
      originalLines,
      storedChars: capture.text.length,
      storedTruncated: capture.truncated,
      sha256
    };
    cache.set(sha256, summary);
    return summary;
  } catch (error) {
    const summary = {
      error: error instanceof Error ? error.message : String(error),
      source,
      toolName,
      originalChars: normalized.length,
      originalLines,
      sha256
    };
    cache.set(sha256, summary);
    return summary;
  }
}

export function compactToolResultTextContent(
  cwd: string,
  event: any,
  ctx: ExtensionContext,
  content: unknown,
  cache: Map<string, ToolResultCaptureSummary>
): { content: unknown; captures: ToolResultCaptureSummary[] } {
  if (!Array.isArray(content)) return { content, captures: [] };
  const captures: ToolResultCaptureSummary[] = [];
  const compacted = content.map((block, index) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string" || !shouldCompactToolResultText(typed.text)) return block;
    const source = `content[${index}].text`;
    const capture = writeToolResultCapture(cwd, event, ctx, source, typed.text, cache);
    captures.push(capture);
    return {
      ...block,
      text: compactToolResultPreview(String(event?.toolName ?? "tool"), source, typed.text, capture)
    };
  });
  return { content: compacted, captures };
}

export function compactToolResultDetails(
  cwd: string,
  event: any,
  ctx: ExtensionContext,
  value: unknown,
  cache: Map<string, ToolResultCaptureSummary>,
  captures: ToolResultCaptureSummary[],
  source = "details",
  depth = 0
): unknown {
  if (typeof value === "string") {
    if (!shouldCompactToolResultText(value)) return value;
    const capture = writeToolResultCapture(cwd, event, ctx, source, value, cache);
    captures.push(capture);
    return compactToolResultPreview(String(event?.toolName ?? "tool"), source, value, capture);
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return value;
    return value.map((item, index) => compactToolResultDetails(cwd, event, ctx, item, cache, captures, `${source}[${index}]`, depth + 1));
  }
  if (isPlainRecord(value)) {
    if (depth >= 6) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactToolResultDetails(cwd, event, ctx, item, cache, captures, `${source}.${key}`, depth + 1)
      ])
    );
  }
  return value;
}

export function attachToolResultCompactionDetails(details: unknown, captures: ToolResultCaptureSummary[]): unknown {
  if (captures.length === 0) return details;
  const compacted = captures.map((capture) => ({
    path: capture.path,
    error: capture.error,
    source: capture.source,
    toolName: capture.toolName,
    originalChars: capture.originalChars,
    originalLines: capture.originalLines,
    storedChars: capture.storedChars,
    storedTruncated: capture.storedTruncated,
    sha256: capture.sha256
  }));
  if (isPlainRecord(details)) return { ...details, piagentCompactedToolResults: compacted };
  if (details === undefined) return { piagentCompactedToolResults: compacted };
  return { value: details, piagentCompactedToolResults: compacted };
}

export function readRecentToolResultCaptures(cwd: string, limit = 5): Record<string, unknown>[] {
  const captures: Record<string, unknown>[] = [];
  for (const parsed of readJsonlTail(toolResultCaptureIndexPath(cwd), {
    limit: Math.max(limit * 3, limit),
    maxBytes: CAPTURE_INDEX_MAX_BYTES,
    projectRoot: cwd
  })) {
    if (isPlainRecord(parsed)) captures.push(redactForStorage(parsed) as Record<string, unknown>);
  }
  return captures.slice(-limit);
}

export function formatToolResultCaptureStatus(cwd: string, captures: Record<string, unknown>[]): string {
  const root = path.relative(cwd, toolResultCaptureRoot(cwd)).split(path.sep).join("/") || ".pi/piagent-state/tool-results";
  const lines = [
    `logPolicy: compact above ${formatCount(TOOL_RESULT_COMPACT_CHAR_THRESHOLD)} chars or ${formatCount(TOOL_RESULT_COMPACT_LINE_THRESHOLD)} lines`,
    `captureRoot: ${root}`,
    `recent: ${captures.length || "none"}`
  ];
  for (const capture of captures) {
    const originalLines = typeof capture.originalLines === "number" ? formatCount(capture.originalLines) : "unknown";
    const originalChars = typeof capture.originalChars === "number" ? formatCount(capture.originalChars) : "unknown";
    const exit = capture.exitCode === undefined ? "" : ` exit=${capture.exitCode}`;
    lines.push(`- ${capture.recordedAt ?? "unknown"} ${capture.toolName ?? "tool"}${exit}: ${originalLines} lines / ${originalChars} chars -> ${capture.path ?? "no capture path"}`);
  }
  return lines.join("\n");
}
