import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactForStorage } from "./redaction-core.js";
import { appendJsonlBounded, readJsonlTail } from "./state-retention.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";
import { matchesProtectedPath } from "./policy-core.js";
import { isCurrentWorkingTreeDigest } from "./working-tree-digest.js";

const MEMORY_SCHEMA_VERSION = 1;
const MAX_FACT_CHARS = 1_000;
const MAX_REASON_CHARS = 400;
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const RESTRICTED_MEMORY_MATERIAL = /\b(raw prompt|raw output|transcript|oauth(?: token)?|api[ _-]?key|access token|refresh token|secret)\b/i;
const SEARCH_STOP_WORDS = new Set(["about", "after", "before", "change", "check", "from", "into", "please", "task", "that", "the", "this", "with"]);

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function factIdentity(normalized) {
  const { expiresAt: _expiresAt, ...durableFact } = normalized;
  return sha256(JSON.stringify(durableFact)).slice(0, 16);
}

function memoryPaths(cwd) {
  const root = path.join(cwd, ".pi", "piagent-state", "repository-memory");
  return {
    root,
    facts: path.join(root, "facts.jsonl")
  };
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function validCitation(citation) {
  const sourcePath = normalizePath(citation?.path);
  return sourcePath
    && !sourcePath.startsWith("../")
    && !path.isAbsolute(sourcePath)
    && typeof citation?.reason === "string"
    && citation.reason.trim().length > 0;
}

function assertSafeMemoryText(label, value) {
  if (RESTRICTED_MEMORY_MATERIAL.test(String(value ?? ""))) {
    throw new Error(`Repository memory ${label} must not store raw prompts, outputs, OAuth material, or secrets`);
  }
}

function normalizeFact(input) {
  const fact = String(input?.fact ?? "").trim();
  const reason = String(input?.reason ?? "").trim();
  const citations = Array.isArray(input?.citations) ? input.citations.filter(validCitation).slice(0, 8).map((citation) => ({
    path: normalizePath(citation.path),
    reason: String(citation.reason).trim().slice(0, MAX_REASON_CHARS),
    digest: isCurrentWorkingTreeDigest(citation.digest)
      ? citation.digest
      : undefined
  })) : [];
  if (fact.length < 8 || fact.length > MAX_FACT_CHARS) throw new Error(`Repository memory fact must be 8-${MAX_FACT_CHARS} chars`);
  if (!["fact", "decision", "retrieval-feedback"].includes(input?.kind)) throw new Error("Repository memory kind is invalid");
  if (!reason || reason.length > MAX_REASON_CHARS) throw new Error(`Repository memory reason must be 1-${MAX_REASON_CHARS} chars`);
  if (citations.length === 0) throw new Error("Repository memory requires at least one path citation");
  assertSafeMemoryText("fact", fact);
  assertSafeMemoryText("reason", reason);
  for (const citation of citations) assertSafeMemoryText("citation reason", citation.reason);
  const expiresAt = typeof input?.expiresAt === "string" && Number.isFinite(Date.parse(input.expiresAt))
    ? input.expiresAt
    : undefined;
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: input.kind,
    fact,
    reason,
    confidence: ["low", "medium", "high"].includes(input.confidence) ? input.confidence : "medium",
    citations,
    expiresAt
  };
}

export function appendRepositoryMemoryFact(cwd, input, options = {}) {
  const normalized = normalizeFact(input);
  const paths = memoryPaths(cwd);
  ensurePrivateStateDirectory(cwd, paths.root, "Repository memory root");
  const record = {
    ...normalized,
    id: factIdentity(normalized),
    recordedAt: typeof options.recordedAt === "string" && Number.isFinite(Date.parse(options.recordedAt))
      ? options.recordedAt
      : nowIso()
  };
  appendJsonlBounded(paths.facts, redactForStorage(record), {
    maxBytes: MAX_EVENTS_BYTES,
    mode: 0o600,
    projectRoot: cwd
  });
  return record;
}

export function recordCompletedTaskMemory(cwd, task, options = {}) {
  const citations = (Array.isArray(task?.changedFiles) ? task.changedFiles : []).slice(0, 8).map((file) => ({
    path: file,
    reason: "Changed file verified by the task completion gate.",
    digest: task?.finalFileDigests?.[file]
  }));
  if (citations.length === 0) return undefined;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return appendRepositoryMemoryFact(cwd, {
    kind: "retrieval-feedback",
    fact: `Verified source changes completed for ${citations.length} cited file(s).`,
    reason: "Derived from a completed task contract and current-tree verification evidence.",
    confidence: "high",
    citations,
    expiresAt: new Date(nowMs + 90 * 24 * 60 * 60 * 1000).toISOString()
  }, { recordedAt: options.recordedAt });
}

export function readRepositoryMemoryFacts(cwd, options = {}) {
  const paths = memoryPaths(cwd);
  let safePath;
  try {
    safePath = resolveLocalStatePath(cwd, paths.facts, { label: "Repository memory facts" });
  } catch {
    return [];
  }
  if (options.limit === 0) return [];
  const parsedNow = options.now ? Date.parse(options.now) : Date.now();
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const rows = readJsonlTail(safePath, {
    limit: Number.isInteger(options.limit) ? Math.max(1, options.limit) : 200,
    maxBytes: MAX_EVENTS_BYTES,
    projectRoot: cwd
  });
  const byId = new Map();
  for (const row of rows) {
    try {
      const normalized = normalizeFact(row);
      if (row.expiresAt && Date.parse(row.expiresAt) <= now) continue;
      byId.set(row.id ?? factIdentity(normalized), {
        ...normalized,
        id: row.id,
        recordedAt: row.recordedAt
      });
    } catch {
      // Ignore malformed rows; the source of truth remains repository files.
    }
  }
  return [...byId.values()].sort((left, right) => Date.parse(right.recordedAt ?? 0) - Date.parse(left.recordedAt ?? 0));
}

function memorySearchTerms(value) {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9_.:/-]{2,63}/g) ?? [])]
    .filter((term) => !SEARCH_STOP_WORDS.has(term));
}

export function selectRepositoryMemoryFacts(cwd, query, options = {}) {
  if (!Array.isArray(options.excludePatterns)) {
    throw new Error("selectRepositoryMemoryFacts requires an explicit excludePatterns array");
  }
  const terms = memorySearchTerms(query);
  if (terms.length === 0) return [];
  const limit = Number.isInteger(options.limit) ? Math.max(0, Math.min(8, options.limit)) : 3;
  if (limit === 0) return [];
  return readRepositoryMemoryFacts(cwd, { limit: 200, now: options.now })
    .filter((record) => record.citations.every((citation) => !matchesProtectedPath(citation.path, options.excludePatterns)))
    .map((record) => {
      const searchable = [
        record.fact,
        record.reason,
        ...record.citations.flatMap((citation) => [citation.path, citation.reason])
      ].join(" ").toLowerCase();
      const matchedTerms = terms.filter((term) => searchable.includes(term));
      const confidenceWeight = record.confidence === "high" ? 2 : record.confidence === "medium" ? 1 : 0;
      return { record, score: matchedTerms.length * 10 + confidenceWeight, matchedTerms };
    })
    .filter((candidate) => candidate.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || Date.parse(right.record.recordedAt ?? 0) - Date.parse(left.record.recordedAt ?? 0))
    .slice(0, limit);
}
