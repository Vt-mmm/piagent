import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../security/sensitive-data.js";
import { appendJsonlBounded, readJsonlTail } from "./state-retention.js";
import { resolveLocalStatePath } from "./local-state-path.js";

const MAX_OBSERVED_BASH_BYTES = 8 * 1024 * 1024;

export function normalizeEvidenceCommand(command) {
  return String(command ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

// A command that carries a secret gets no digest at all, and cannot be evidence.
//
// Neither text is safe to hash. Hashing the raw command published a template:
// the ledger stored `export TOKEN= [REDACTED_SECRET] && npm test` beside a
// SHA-256 of the real line, so the only unknown left was the secret, and SHA-256
// is fast enough to walk a candidate list offline. Hashing the redacted text
// instead gives every secret the same digest, which is worse in a different
// direction: the gate promises the observed command matches `verifyCommands`
// exactly, and two runs differing only in a credential would satisfy each
// other's claim. Verifying against database A and recording it as proof for
// database B is exactly what the exact-match rule exists to prevent.
//
// So the digest covers the raw command and is withheld when there is anything to
// redact. Withholding it costs nothing real: a verify command in a task plan has
// no business carrying an inline credential, and a command that does gets refused
// rather than matched loosely.
export function hashEvidenceCommand(command) {
  const normalized = normalizeEvidenceCommand(command);
  if (!normalized) return "";
  if (redactSensitiveText(normalized).redacted) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
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
  if (!rawNormalizedCommand) return undefined;
  // `??`, not `||`: an entry read back from the ledger carries an empty digest
  // when its command held a secret, and that emptiness has to survive. Recomputing
  // it here would hash the stored text, which is redacted, and hand the entry the
  // one digest this module refuses to produce.
  const commandHash = typeof entry?.commandHash === "string"
    ? entry.commandHash
    : hashEvidenceCommand(rawNormalizedCommand);
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

// Identity is the digest and nothing else. Falling back to comparing the stored
// text would compare redacted text, which is the collision this module refuses.
function observedCommandsMatch(entry, commandHash) {
  if (!commandHash || !entry.commandHash) return false;
  return entry.commandHash === commandHash;
}

export function findMatchingObservedBashResult(entries, { cwd, command, notBefore, exitCode }) {
  const normalizedCommand = normalizeEvidenceCommand(command);
  const commandHash = hashEvidenceCommand(normalizedCommand);
  const normalizedCwd = normalizeCwd(cwd);
  const notBeforeMs = notBefore ? parseTimeMs(notBefore, 0) : 0;
  if (!normalizedCommand) {
    return { ok: false, reason: "Verify command is empty after normalization." };
  }
  if (!commandHash) {
    return {
      ok: false,
      reason: "Verify command carries a secret, so it cannot be matched against observed evidence. "
        + "Move the credential into the environment and keep it out of the command."
    };
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = canonicalObservedEntry(entries[index]);
    if (!entry) continue;
    if (entry.cwd !== normalizedCwd) continue;
    if (!observedCommandsMatch(entry, commandHash)) continue;
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
  if (!filePath) return [];
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 5000;
  const entries = [];
  for (const parsed of readJsonlTail(filePath, {
    maxEntries,
    limit: maxEntries,
    maxBytes: MAX_OBSERVED_BASH_BYTES,
    projectRoot: options.projectRoot
  })) {
    const entry = canonicalObservedEntry(parsed);
    if (entry) entries.push(entry);
  }
  return entries.slice(-maxEntries);
}

function pruneObservedBashFile(filePath, maxPersistedEntries, projectRoot) {
  if (!Number.isInteger(maxPersistedEntries) || maxPersistedEntries <= 0) return;
  const entries = readObservedBashResults(filePath, { maxEntries: maxPersistedEntries, projectRoot });
  const lines = entries.map((entry) => JSON.stringify(persistedObservedEntry(entry))).filter(Boolean);
  const safePath = projectRoot
    ? resolveLocalStatePath(projectRoot, filePath, { label: "Observed bash ledger", kind: "file" })
    : filePath;
  const descriptor = fs.openSync(
    safePath,
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    fs.writeSync(descriptor, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function appendObservedBashResult(filePath, entry, options = {}) {
  if (!filePath) return undefined;
  const persisted = persistedObservedEntry(entry);
  if (!persisted) return undefined;
  appendJsonlBounded(filePath, persisted, {
    maxBytes: MAX_OBSERVED_BASH_BYTES,
    mode: 0o600,
    projectRoot: options.projectRoot
  });
  if (Number.isInteger(options.maxPersistedEntries)) {
    pruneObservedBashFile(filePath, options.maxPersistedEntries, options.projectRoot);
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
