import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../security/sensitive-data.js";

export function normalizeEvidenceCommand(command) {
  return String(command ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function hashEvidenceCommand(command) {
  return crypto
    .createHash("sha256")
    .update(normalizeEvidenceCommand(command))
    .digest("hex");
}

export function commandMatchesVerifyPlan(command, verifyCommands) {
  const normalized = normalizeEvidenceCommand(command);
  if (!normalized || !Array.isArray(verifyCommands)) return false;
  return verifyCommands.some((verifyCommand) => normalizeEvidenceCommand(verifyCommand) === normalized);
}

function normalizeCwd(cwd) {
  return String(cwd ?? "").trim();
}

function parseTimeMs(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numericExitCode(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

export function claimedExitMatchesObserved(exitCode, observed) {
  const claimed = numericExitCode(exitCode);
  if (claimed === undefined) return false;
  if (typeof observed?.exitCode === "number") return observed.exitCode === claimed;
  return observed?.isError === true ? claimed !== 0 : claimed === 0;
}

export function extractBashCommandFromToolResultEvent(event) {
  if (!event || event.toolName !== "bash") return "";
  const input = event.input;
  if (input && typeof input.command === "string") return input.command;
  if (input && typeof input === "object" && input.args && typeof input.args.command === "string") return input.args.command;
  return "";
}

export function observedBashResultFromToolResultEvent(event, cwd, nowMs = Date.now()) {
  const command = extractBashCommandFromToolResultEvent(event);
  const normalizedCommand = normalizeEvidenceCommand(command);
  if (!normalizedCommand) return undefined;
  const commandHash = hashEvidenceCommand(normalizedCommand);
  const exitCode = numericExitCode(event?.details?.exitCode ?? event?.details?.status ?? event?.exitCode);
  const recordedAtMs = parseTimeMs(event?.timestamp, nowMs);
  return {
    cwd: normalizeCwd(cwd),
    command: redactSensitiveText(command).text,
    normalizedCommand: redactSensitiveText(normalizedCommand).text,
    commandHash,
    isError: event?.isError === true,
    exitCode,
    recordedAt: new Date(recordedAtMs).toISOString(),
    recordedAtMs,
    toolCallId: event?.toolCallId ?? event?.id
  };
}

function canonicalObservedEntry(entry) {
  const rawNormalizedCommand = normalizeEvidenceCommand(entry?.normalizedCommand ?? entry?.command);
  const commandHash = entry?.commandHash || (rawNormalizedCommand ? hashEvidenceCommand(rawNormalizedCommand) : "");
  if (!commandHash) return undefined;
  const command = typeof entry?.command === "string" ? redactSensitiveText(entry.command).text : "";
  const normalizedCommand = redactSensitiveText(rawNormalizedCommand).text;
  const recordedAtMs = parseTimeMs(entry?.recordedAtMs ?? entry?.recordedAt);
  return {
    cwd: normalizeCwd(entry?.cwd),
    command,
    normalizedCommand,
    commandHash,
    isError: entry?.isError === true,
    exitCode: numericExitCode(entry?.exitCode),
    recordedAt: entry?.recordedAt ?? new Date(recordedAtMs).toISOString(),
    recordedAtMs,
    toolCallId: entry?.toolCallId
  };
}

function observedCommandsMatch(entry, normalizedCommand, commandHash) {
  if (entry.commandHash) return entry.commandHash === commandHash;
  return normalizeEvidenceCommand(entry.normalizedCommand ?? entry.command) === normalizedCommand;
}

export function findMatchingObservedBashResult(entries, { cwd, command, notBefore, exitCode }) {
  const normalizedCommand = normalizeEvidenceCommand(command);
  const commandHash = hashEvidenceCommand(normalizedCommand);
  const normalizedCwd = normalizeCwd(cwd);
  const notBeforeMs = notBefore ? parseTimeMs(notBefore, 0) : 0;
  if (!normalizedCommand) {
    return { ok: false, reason: "Verify command is empty after normalization." };
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = canonicalObservedEntry(entries[index]);
    if (!entry) continue;
    if (entry.cwd !== normalizedCwd) continue;
    if (!observedCommandsMatch(entry, normalizedCommand, commandHash)) continue;
    if (entry.recordedAtMs < notBeforeMs) continue;
    if (!claimedExitMatchesObserved(exitCode, entry)) {
      return {
        ok: false,
        reason: `Observed command status does not match claimed exitCode ${exitCode}.`,
        entry
      };
    }
    return { ok: true, entry };
  }

  return {
    ok: false,
    reason: "No matching bash tool_result observed for this command after task start."
  };
}

function persistedObservedEntry(entry) {
  const observed = canonicalObservedEntry(entry);
  if (!observed) return undefined;
  const command = typeof entry?.redactedCommand === "string"
    ? redactSensitiveText(entry.redactedCommand).text
    : observed.command;
  return {
    schemaVersion: 1,
    cwd: observed.cwd,
    commandHash: observed.commandHash,
    command,
    isError: observed.isError,
    exitCode: observed.exitCode,
    recordedAt: observed.recordedAt,
    recordedAtMs: observed.recordedAtMs,
    toolCallId: observed.toolCallId
  };
}

export function readObservedBashResults(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 5000;
  const text = fs.readFileSync(filePath, "utf8");
  const entries = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const entry = canonicalObservedEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      // Ignore a partially written/corrupt JSONL line. The ledger is advisory evidence,
      // and the final gate remains fail-closed when no valid observation is available.
    }
  }
  return entries.slice(-maxEntries);
}

function pruneObservedBashFile(filePath, maxPersistedEntries) {
  if (!Number.isInteger(maxPersistedEntries) || maxPersistedEntries <= 0) return;
  const entries = readObservedBashResults(filePath, { maxEntries: maxPersistedEntries });
  const lines = entries.map((entry) => JSON.stringify(persistedObservedEntry(entry))).filter(Boolean);
  fs.writeFileSync(filePath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
}

export function appendObservedBashResult(filePath, entry, options = {}) {
  if (!filePath) return undefined;
  const persisted = persistedObservedEntry(entry);
  if (!persisted) return undefined;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(persisted)}\n`);
  if (Number.isInteger(options.maxPersistedEntries)) {
    pruneObservedBashFile(filePath, options.maxPersistedEntries);
  }
  return persisted;
}

export function createBashResultLedger(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 300;
  const entries = [];

  function prune() {
    while (entries.length > maxEntries) entries.shift();
  }

  return {
    record(entry) {
      const observed = canonicalObservedEntry(entry);
      if (!observed) return undefined;
      entries.push(observed);
      prune();
      return observed;
    },

    findMatching({ cwd, command, notBefore, exitCode }) {
      return findMatchingObservedBashResult(entries, { cwd, command, notBefore, exitCode });
    },

    list() {
      return entries.map((entry) => ({ ...entry }));
    }
  };
}
