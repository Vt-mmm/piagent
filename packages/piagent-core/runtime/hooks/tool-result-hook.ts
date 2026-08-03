import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { redactForStorage, redactSensitiveText } from "../../extensions/redaction-core.js";
import {
  appendObservedBashResult,
  observedBashResultFromToolResultEvent
} from "../../extensions/runtime-evidence.js";
import {
  attachToolResultCompactionDetails,
  compactToolResultDetails,
  compactToolResultTextContent
} from "../session/tool-result-compaction.ts";
import type { ToolResultCaptureSummary } from "../session/tool-result-compaction.ts";
import { RuntimeSessionState } from "../session/runtime-state.ts";
import type { ObservedTaskContext } from "../session/runtime-state.ts";

type ToolResultEvent = {
  toolName: string;
  input?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  usage?: unknown;
};

type ObservedBashResult = NonNullable<ReturnType<typeof observedBashResultFromToolResultEvent>>;

type ToolResultHookDependencies = {
  state: RuntimeSessionState;
  maxManifestFiles: number;
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  recordObservedBash: (observed: ObservedBashResult) => void;
  observedBashLedgerPath: (cwd: string) => string;
  redactText: (input: string) => string;
  observedTaskContext: (
    cwd: string,
    event: ToolResultEvent,
    readProtectedPaths: string[]
  ) => ObservedTaskContext | undefined;
  recordObservedTaskChanges: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    event: ToolResultEvent,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number,
    shellSnapshotBefore?: Record<string, string>
  ) => unknown;
  recordObservedTaskVerification: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    observed: ObservedBashResult,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number
  ) => unknown;
  extractLikelyPath: (cwd: string, input: Record<string, unknown>) => string | undefined;
  isShellTool: (toolName: string) => boolean;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  now: () => string;
};

function normalizeRelative(cwd: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return undefined;
  let raw = candidate.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    if (!raw.toLowerCase().startsWith("file://")) return undefined;
    try {
      raw = fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function countChangedStringLeaves(before: unknown, after: unknown): number {
  if (typeof before === "string" && typeof after === "string") return before === after ? 0 : 1;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.reduce((total, item, index) => total + countChangedStringLeaves(item, after[index]), 0);
  }
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return 0;
  return Object.entries(before as Record<string, unknown>).reduce(
    (total, [key, value]) => total + countChangedStringLeaves(value, (after as Record<string, unknown>)[key]),
    0
  );
}

function redactToolResultTextContent(content: unknown): { content: unknown; redacted: number } {
  if (!Array.isArray(content)) return { content, redacted: 0 };
  let redacted = 0;
  const safeContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") return block;
    const safeText = redactSensitiveText(typed.text);
    if (!safeText.redacted) return block;
    redacted += 1;
    return { ...block, text: safeText.text };
  });
  return { content: safeContent, redacted };
}

function filterTextBlocks(
  content: unknown,
  blocked: (line: string) => boolean,
  emptyText: string,
  noticeText: (count: number) => string
): { changed: boolean; content?: unknown; redactedLines: number } {
  if (!Array.isArray(content)) return { changed: false, redactedLines: 0 };
  let changed = false;
  let redactedLines = 0;
  const filtered = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if ((block as { type?: unknown }).type !== "text" || typeof text !== "string") return block;
    const kept: string[] = [];
    let blockRedactedLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (blocked(line)) {
        changed = true;
        redactedLines += 1;
        blockRedactedLines += 1;
      } else {
        kept.push(line);
      }
    }
    if (blockRedactedLines === 0) return block;
    const notice = noticeText(blockRedactedLines);
    const nextText = kept.join("\n").trim().length > 0
      ? `${kept.join("\n")}\n${notice}`
      : `${emptyText}\n${notice}`;
    return { ...block, text: nextText };
  });
  return { changed, content: filtered, redactedLines };
}

export function filterGrepProtectedContent(content: unknown, protectedPatterns: string[]) {
  return filterTextBlocks(
    content,
    (line) => {
      const linePath = line.match(/^(.+?)(?::\d+:|-\d+-)/)?.[1];
      return Boolean(linePath && matchesProtectedPath(linePath, protectedPatterns));
    },
    "No matches found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected grep line${count === 1 ? "" : "s"}.]`
  );
}

export function filterProtectedPathListContent(
  cwd: string,
  content: unknown,
  protectedPatterns: string[],
  basePath: string,
  toolName: string
) {
  return filterTextBlocks(
    content,
    (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("No ") || trimmed === "(empty directory)") return false;
      const entry = trimmed.replace(/[\\/]+$/, "");
      const candidates = new Set<string>();
      const direct = normalizeRelative(cwd, entry);
      const underBase = normalizeRelative(cwd, path.posix.join(basePath || ".", entry));
      if (direct !== undefined) candidates.add(direct);
      if (underBase !== undefined) candidates.add(underBase);
      return [...candidates].some((candidate) => matchesProtectedPath(candidate, protectedPatterns));
    },
    "No entries found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected ${toolName} line${count === 1 ? "" : "s"}.]`
  );
}

export function registerToolResultHook(pi: ExtensionAPI, dependencies: ToolResultHookDependencies): void {
  pi.on("tool_result", async (event, ctx) => {
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const observed = observedBashResultFromToolResultEvent(event, ctx.cwd);
    if (observed) {
      dependencies.recordObservedBash(observed);
      try {
        appendObservedBashResult(dependencies.observedBashLedgerPath(ctx.cwd), {
          ...observed,
          redactedCommand: dependencies.redactText(observed.command)
        }, { projectRoot: ctx.cwd });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Piagent Pi guard could not persist bash evidence ledger: ${message}`, "warn");
      }
    }

    const observedContextEntry = dependencies.observedTaskContext(ctx.cwd, event, readProtectedPaths);
    if (observedContextEntry) dependencies.state.rememberObservedContext(ctx, observedContextEntry);
    const pendingContext = dependencies.state.observedContext(ctx);
    const shellSnapshotBefore = dependencies.isShellTool(event.toolName)
      ? dependencies.state.consumeShellMutationSnapshot(ctx, event.toolName, event.input)
      : undefined;
    dependencies.recordObservedTaskChanges(pi, ctx, event, pendingContext, dependencies.maxManifestFiles, shellSnapshotBefore);
    if (observed) {
      dependencies.recordObservedTaskVerification(pi, ctx, observed, pendingContext, dependencies.maxManifestFiles);
    }

    let resultContent: unknown = event.content;
    let resultDetails: unknown = event.details;
    let resultChanged = false;
    if (event.toolName === "grep") {
      const filtered = filterGrepProtectedContent(resultContent, readProtectedPaths);
      if (filtered.changed) {
        resultContent = filtered.content;
        resultDetails = isPlainRecord(resultDetails)
          ? { ...resultDetails, protectedMatchesRedacted: filtered.redactedLines }
          : { protectedMatchesRedacted: filtered.redactedLines };
        resultChanged = true;
      }
    }
    if (event.toolName === "find" || event.toolName === "ls") {
      const input = isPlainRecord(event.input) ? event.input : {};
      const basePath = dependencies.extractLikelyPath(ctx.cwd, input) || ".";
      const filtered = filterProtectedPathListContent(ctx.cwd, resultContent, readProtectedPaths, basePath, event.toolName);
      if (filtered.changed) {
        resultContent = filtered.content;
        resultDetails = isPlainRecord(resultDetails)
          ? { ...resultDetails, protectedPathsRedacted: filtered.redactedLines }
          : { protectedPathsRedacted: filtered.redactedLines };
        resultChanged = true;
      }
    }

    const safeContent = redactToolResultTextContent(resultContent);
    const safeDetails = redactForStorage(resultDetails);
    const sensitiveValuesRedacted = safeContent.redacted + countChangedStringLeaves(resultDetails, safeDetails);
    if (sensitiveValuesRedacted > 0) {
      resultContent = safeContent.content;
      resultDetails = isPlainRecord(safeDetails) ? { ...safeDetails, sensitiveValuesRedacted } : safeDetails;
      resultChanged = true;
    }

    const fingerprint = toolResultFingerprint(event.toolName, event.input, resultContent);
    const previousFingerprint = dependencies.state.previousToolResult(ctx, fingerprint.key);
    const repeated = previousFingerprint?.outputHash === fingerprint.outputHash;
    dependencies.state.rememberToolResult(ctx, fingerprint.key, {
      outputHash: fingerprint.outputHash,
      recordedAt: dependencies.now()
    });
    if (repeated && ["read", "grep", "find", "ls"].includes(event.toolName) && fingerprint.outputChars > 0) {
      resultContent = [{
        type: "text",
        text: `[Piagent delta: unchanged ${event.toolName} result; ${fingerprint.outputChars} chars / ${fingerprint.outputLines} lines match the previous identical call.]`
      }];
      const delta = {
        unchanged: true,
        previousRecordedAt: previousFingerprint?.recordedAt,
        outputHash: fingerprint.outputHash,
        originalChars: fingerprint.outputChars,
        originalLines: fingerprint.outputLines
      };
      resultDetails = isPlainRecord(resultDetails)
        ? { ...resultDetails, piagentDelta: delta }
        : { value: resultDetails, piagentDelta: delta };
      resultChanged = true;
    }

    const captureCache = new Map<string, ToolResultCaptureSummary>();
    const compactedContent = compactToolResultTextContent(ctx.cwd, event, ctx, resultContent, captureCache);
    const compactionCaptures = [...compactedContent.captures];
    if (compactedContent.captures.length > 0) {
      resultContent = compactedContent.content;
      resultChanged = true;
    }
    if (resultDetails !== undefined) {
      const compactedDetails = compactToolResultDetails(ctx.cwd, event, ctx, resultDetails, captureCache, compactionCaptures);
      if (compactionCaptures.length > compactedContent.captures.length) {
        resultDetails = compactedDetails;
        resultChanged = true;
      }
    }
    if (compactionCaptures.length > 0) {
      resultDetails = attachToolResultCompactionDetails(resultDetails, compactionCaptures);
    }

    dependencies.telemetry(ctx, {
      event: "tool_result",
      toolName: event.toolName,
      inputHash: fingerprint.inputHash,
      outputHash: fingerprint.outputHash,
      outputChars: fingerprint.outputChars,
      outputLines: fingerprint.outputLines,
      repeated,
      compacted: compactionCaptures.length > 0,
      compactedCaptures: compactionCaptures.length,
      sensitiveValuesRedacted,
      isError: event.isError,
      usage: event.usage
    });

    if (resultChanged) {
      return resultDetails === undefined
        ? { content: resultContent }
        : { content: resultContent, details: resultDetails };
    }
  });
}
