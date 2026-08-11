import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  FAILURE_PARSER_VERSION,
  FAILURE_POLICY_VERSION,
  FAILURE_SCHEMA_VERSION,
  failureEvidenceDigest,
  failureOutputRef,
  validateFailureClassification,
  validateFailureEvidence
} from "./failure-types.ts";
import { isCurrentWorkingTreeDigest } from "./working-tree-digest.js";

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

export function meaningfulVerificationCommands(commands = []) {
  return commands.filter((command) => {
    const normalized = String(command ?? "").trim().toLowerCase();
    if (!normalized) return false;
    if (/no (?:project|backend|data|frontend|runtime|docs|mobile) verify command configured/.test(normalized) && !/\b(?:if|elif)\b/.test(normalized)) return false;
    if (/^(?:true|:|echo\b|printf\b)/.test(normalized)) return false;
    return true;
  });
}

/** Return the last durably recorded observed execution for each exact command. */
export function latestObservedVerificationEvidence(evidence = []) {
  const latest = new Map();
  const ordered = new Map();
  for (const [index, entry] of (Array.isArray(evidence) ? evidence : []).entries()) {
    if (entry?.observed !== true) continue;
    const command = String(entry.command ?? "").trim();
    if (!command) continue;
    const observedAt = entry.observedAt ?? entry.recordedAt;
    const parsed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    const time = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    const previous = ordered.get(command);
    if (!previous || time > previous.time || (time === previous.time && index > previous.index)) {
      ordered.set(command, { time, index });
      latest.set(command, Number.isFinite(parsed) ? entry : null);
    }
  }
  return latest;
}

export function latestObservedVerification(evidence = []) {
  let latest, latestTime = Number.NEGATIVE_INFINITY, latestIndex = -1;
  for (const [index, entry] of (Array.isArray(evidence) ? evidence : []).entries()) {
    if (entry?.observed !== true) continue;
    const observedAt = entry.observedAt ?? entry.recordedAt;
    const parsed = typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
    const time = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    if (time > latestTime || (time === latestTime && index > latestIndex)) {
      latest = Number.isFinite(parsed) ? entry : null;
      latestTime = time;
      latestIndex = index;
    }
  }
  return latest;
}

export function verificationEvidenceProvesStableTree(entry, digest) {
  return isCurrentWorkingTreeDigest(digest)
    && entry?.observed === true
    && entry.matchedProfileCommand === true
    && entry.exitCode === 0
    && entry.preWorkingTreeDigest === digest
    && entry.workingTreeDigest === digest;
}

export function verificationRunIdentity(cwd, command, changedFiles = []) {
  const normalizedFiles = [...new Set(changedFiles.map((file) => String(file ?? "").replaceAll("\\", "/")).filter(Boolean))].sort();
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      cwd: path.resolve(cwd),
      command: String(command ?? "").trim(),
      changedFiles: normalizedFiles
    }))
    .digest("hex");
}

const STRUCTURED_SIGNALS = {
  "scope-violation": "structured-scope",
  "protected-path": "structured-protected-path",
  "permission-denied": "structured-permission",
  "policy-block": "structured-policy",
  "provider-network": "structured-provider",
  environment: "structured-environment",
  "flaky-infrastructure": "structured-flaky-infrastructure",
  "stale-verifier": "structured-stale-verifier",
  "missing-verifier": "structured-missing-verifier"
};

function parsedSignals(text, exitCode, structuredEvents) {
  if (Number(exitCode) === 0) return ["exit-zero"];
  const lower = text.toLowerCase();
  const signals = structuredEvents.map((event) => STRUCTURED_SIGNALS[event]).filter(Boolean);
  const add = (signal, pattern) => { if (pattern.test(lower)) signals.push(signal); };
  add("scope-diagnostic", /\b(outside (?:its |the )?declared scope|scope violation|protected path|symlink escape)\b/);
  add("policy-diagnostic", /\b(policy (?:blocked|denied|violation)|capability lock|guard blocked)\b/);
  add("permission-diagnostic", /\b(eacces|eperm|permission denied|not authorized|unauthorized|forbidden)\b/);
  add("provider-rate-limit", /\b(?:http\s*)?429\b|\brate[ -]?limit(?:ed|ing)?\b/);
  add("provider-transport", /\b(openai|anthropic|provider|oauth|api gateway|api request)\b[\s\S]{0,120}\b(timeout|timed out|econnreset|econnrefused|unavailable|disconnect)/);
  add("environment-diagnostic", /\b(command not found|executable file not found|no space left on device|out of memory|docker daemon|missing environment variable|browser executable .* not found|enoent[^\n]{0,80}(?:spawn|executable))\b/);
  add("local-port-conflict", /\b(eaddrinuse|address already in use|port \d+ is already in use)\b/);
  add("transient-infrastructure", /\b(etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|temporarily unavailable|timed out waiting for (?:server|localhost|port)|flaky)\b/);
  add("dependency-config-diagnostic", /\b(cannot find module|module not found|package .* not found|eresolve|dependency conflict|lockfile.*(?:invalid|out of date)|could not resolve dependenc|no matching package)\b/);
  add("typescript-diagnostic", /\bts\d{4}\b|\b(?:typescript|tsc|typecheck|type check)\b[^\n]{0,100}\b(?:error|failed)|\btype .* is not assignable\b/);
  add("python-type-diagnostic", /\b(mypy|pyright)\b[^\n]{0,100}\b(?:error|failed)|\bincompatible types? in assignment\b/);
  add("go-compile-diagnostic", /\b(?:go build|go test)\b[^\n]{0,100}\b(?:build failed|undefined|cannot use)|\bundefined: [a-z_][\w.]*\b/);
  add("rust-compile-diagnostic", /\berror\[e\d{4}\]|\bmismatched types\b|\bcould not compile\b/);
  add("test-assertion-diagnostic", /\b(assertionerror|assertion failed|expected .{0,80} received|snapshot .* failed|test failed|failing tests?|panicked at .*assert)\b/);
  add("lint-format-diagnostic", /\b(eslint|prettier|gofmt|rustfmt|ruff|black|lint(?:er|ing)?|format check)\b[^\n]{0,100}\b(error|failed|would reformat|violation)/);
  add("generic-compile-diagnostic", /\b(compile error|compilation failed|build failed)\b/);
  return [...new Set(signals)].slice(0, 16);
}

export function parseVerificationFailureEvidence(output, exitCode = 1, options = {}) {
  const structuredEvents = [...new Set((Array.isArray(options.structuredEvents) ? options.structuredEvents : []).filter((event) => Object.hasOwn(STRUCTURED_SIGNALS, event)))].slice(0, 16);
  return validateFailureEvidence({
    schemaVersion: FAILURE_SCHEMA_VERSION,
    parserVersion: FAILURE_PARSER_VERSION,
    exitCode: Number.isInteger(Number(exitCode)) && Number(exitCode) >= 0 && Number(exitCode) <= 255 ? Number(exitCode) : 1,
    signals: parsedSignals(String(output ?? ""), exitCode, structuredEvents),
    structuredEvents,
    outputRef: failureOutputRef(output, { captureRef: options.captureRef, truncated: options.truncated })
  });
}

const FAILURE_POLICY = {
  passed: ["none", false, "forbidden", "high"],
  "compile-typecheck": ["source", false, "eligible-in-scope", "high"],
  "test-assertion": ["test-expectation", false, "eligible-in-scope", "high"],
  "lint-format": ["source", false, "eligible-in-scope", "high"],
  "dependency-config": ["dependency", false, "conditional", "medium"],
  environment: ["environment", false, "forbidden", "high"],
  "provider-network": ["provider", true, "forbidden", "high"],
  "permission-policy": ["permission", false, "forbidden", "high"],
  "scope-protected-path": ["scope", false, "forbidden", "high"],
  "flaky-infrastructure": ["infrastructure", true, "forbidden", "medium"],
  unknown: ["unknown", false, "forbidden", "low"]
};

function categoryForEvidence(evidence) {
  const signals = new Set(evidence.signals);
  if (evidence.exitCode === 0) return "passed";
  if (signals.has("structured-scope") || signals.has("structured-protected-path") || signals.has("scope-diagnostic")) return "scope-protected-path";
  if (signals.has("structured-permission") || signals.has("structured-policy") || signals.has("permission-diagnostic") || signals.has("policy-diagnostic")) return "permission-policy";
  if (signals.has("structured-provider") || signals.has("provider-rate-limit") || signals.has("provider-transport")) return "provider-network";
  if (signals.has("structured-environment") || signals.has("environment-diagnostic")) return "environment";
  if (signals.has("structured-flaky-infrastructure") || signals.has("local-port-conflict") || signals.has("transient-infrastructure")) return "flaky-infrastructure";
  if (signals.has("structured-stale-verifier") || signals.has("structured-missing-verifier") || signals.has("dependency-config-diagnostic")) return "dependency-config";
  if (["typescript-diagnostic", "python-type-diagnostic", "go-compile-diagnostic", "rust-compile-diagnostic", "generic-compile-diagnostic"].some((signal) => signals.has(signal))) return "compile-typecheck";
  if (signals.has("test-assertion-diagnostic")) return "test-assertion";
  if (signals.has("lint-format-diagnostic")) return "lint-format";
  return "unknown";
}

export function classifyFailureEvidence(evidenceInput) {
  const evidence = validateFailureEvidence(evidenceInput);
  const category = categoryForEvidence(evidence);
  const [ownership, retryable, sourceMutationPermission, confidence] = FAILURE_POLICY[category];
  return validateFailureClassification({
    schemaVersion: FAILURE_SCHEMA_VERSION,
    policyVersion: FAILURE_POLICY_VERSION,
    evidenceDigest: failureEvidenceDigest(evidence),
    category,
    ownership,
    retryable,
    sourceMutationPermission,
    confidence,
    reasonCodes: evidence.signals.length > 0 ? evidence.signals : ["unknown-diagnostic"],
    authorizesSourceMutation: false,
    outputRef: evidence.outputRef
  });
}

export function classifyVerificationFailure(output, exitCode = 1, options = {}) {
  return classifyFailureEvidence(parseVerificationFailureEvidence(output, exitCode, options));
}

const RECORDED_CATEGORY_HINTS = Object.freeze({
  "compile-typecheck": "TS2322: type string is not assignable",
  "test-assertion": "AssertionError: expected value received another value",
  "lint-format": "eslint error: format check failed",
  "dependency-config": "Cannot find module from configured dependency",
  environment: "command not found in runtime environment",
  "provider-network": "provider API request timed out",
  "permission-policy": "permission denied by policy",
  "scope-protected-path": "outside declared scope",
  "flaky-infrastructure": "EADDRINUSE: port is already in use"
});

export function classifyRecordedVerificationFailure(summary, exitCode = 1) {
  const text = String(summary ?? "");
  const recorded = text.match(/^Runtime observed configured verifier exit \d+ \(([a-z-]+)(?:, retryable)?\)\.$/);
  const hint = recorded ? RECORDED_CATEGORY_HINTS[recorded[1]] : undefined;
  return classifyVerificationFailure(hint ? `${text}\n${hint}` : text, exitCode);
}

const COMPLETION_SCOPE_BOUNDARY = /(?:^changes within task scope\b|^read-only task has observed changes\b|\boutside (?:(?:its|the|task) )?(?:declared )?scope\b|\bscope violation\b|\bprotected(?:\/read-only| or read-only)? paths?\b|\bread-only path\b)/i;

export function classifyCompletionGateFailure(missing = [], summary = "", exitCode = 1) {
  const missingItems = Array.isArray(missing) ? missing.map((item) => String(item)) : [];
  // Scope, protected-path, and read-only mutation boundaries are structural
  // completion failures. They must outrank verifier/acceptance diagnostics and
  // remain non-retryable even when the latest exact verifier exited zero.
  if (missingItems.some((item) => COMPLETION_SCOPE_BOUNDARY.test(item))) {
    return classifyVerificationFailure("Completion gate rejected a scope or protected-path boundary.", 1, {
      structuredEvents: ["scope-violation"]
    });
  }
  if (missingItems.some((item) => /^critical acceptance evidence\b/i.test(item))) {
    return classifyVerificationFailure("AssertionError: critical acceptance behavioral proof is missing", 1);
  }
  return classifyRecordedVerificationFailure(summary, exitCode);
}

export function selectCompletionRecoveryClassification(recordedClassification, missing = [], summary = "", exitCode = 1) {
  const gateClassification = classifyCompletionGateFailure(missing, summary, exitCode);
  return gateClassification.category === "scope-protected-path"
    ? gateClassification
    : recordedClassification ?? gateClassification;
}

export function chooseVerificationScope(profileVerifyCommands = {}, changedFiles = []) {
  const files = changedFiles.map((file) => String(file ?? "").replaceAll("\\", "/")).filter(Boolean);
  const groups = profileVerifyCommands && typeof profileVerifyCommands === "object" ? profileVerifyCommands : {};
  const isDocumentationFile = (file) => /\.(?:md|mdx|txt|rst)$/i.test(file)
    || /^(?:docs|docs-site)\//.test(file)
    || /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY)(?:\.|$)/i.test(file);
  const hasDocs = files.some(isDocumentationFile);
  const hasDocsOnly = files.length > 0 && files.every(isDocumentationFile);
  const hasFrontend = files.some((file) => /(^|\/)(?:app|pages|components|frontend|web|client)(\/|$)|\.(?:tsx|jsx|css|scss|vue|svelte)$/i.test(file));
  const hasBackend = files.some((file) => /(^|\/)(?:api|server|backend|services)(\/|$)|\.(?:go|py|rs|java|kt|cs|rb|php|sql)$/i.test(file));
  const selectedGroups = [];
  if (hasDocsOnly && groups.docs) {
    selectedGroups.push("docs");
  } else {
    if (hasDocs && groups.docs) selectedGroups.push("docs");
    if (hasFrontend && hasBackend && groups.source) selectedGroups.push("source");
    else {
      if (hasFrontend && groups.frontendSource) selectedGroups.push("frontendSource");
      if (hasBackend && groups.backendSource) selectedGroups.push("backendSource");
    }
    if (!hasFrontend && !hasBackend && groups.source) selectedGroups.push("source");
  }
  if (selectedGroups.length === 0 && groups.source) selectedGroups.push("source");
  const candidates = [...selectedGroups];
  for (const [name, commands] of Object.entries(groups)) {
    if (!candidates.includes(name) && Array.isArray(commands) && commands.length > 0) candidates.push(name);
  }
  const selected = selectedGroups.length > 0 ? selectedGroups.join("+") : candidates[0];
  const selectedCommands = selectedGroups.length > 0
    ? uniqueStrings(selectedGroups.flatMap((name) => groups[name] ?? []))
    : selected ? uniqueStrings(groups[selected] ?? []) : [];
  return {
    group: selected,
    groups: selectedGroups,
    commands: selectedCommands,
    reason: selected
      ? `selected ${selected} from ${files.length} changed file(s)`
      : "no configured verification group matched the changed files",
    candidates
  };
}

export function selectVerificationPlan(profile, requestedGroup, changeMode, cwd, scope = []) {
  if (changeMode === "read-only") return { commands: [] };
  const groups = profile?.verifyCommands ?? {};
  const names = Object.keys(groups);
  const requested = requestedGroup?.trim();
  if (requested && !Object.hasOwn(groups, requested)) {
    return { commands: [], error: `Unknown verify group ${requested}. Available groups: ${names.join(", ") || "none"}.` };
  }
  const inferred = requested ? undefined : chooseVerificationScope(groups, scope);
  const group = requested
    ?? inferred?.group
    ?? (Object.hasOwn(groups, "source") ? "source" : undefined)
    ?? (Object.hasOwn(groups, "frontendSource") ? "frontendSource" : undefined)
    ?? names.find((name) => !/docs|runtime/i.test(name));
  let commands = requested
    ? uniqueStrings(groups[requested] ?? [])
    : inferred?.group === group
      ? inferred.commands
      : group ? uniqueStrings(groups[group] ?? []) : [];
  if (cwd && commands.length === 1 && commands[0].includes("No Node source verifier is configured")) {
    try {
      const manifestPath = path.join(cwd, "package.json");
      if (!fs.lstatSync(manifestPath).isSymbolicLink()) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
        const selected = ["type-check", "typecheck", "lint", "test"].filter((name) => typeof scripts[name] === "string");
        if (selected.length > 0) commands = selected.map((name) => name === "test" ? "npm test" : `npm run ${name}`);
      }
    } catch {
      // Preserve the profile's fail-closed verifier when package metadata is absent or invalid.
    }
  }
  if (meaningfulVerificationCommands(commands).length === 0) {
    return {
      group,
      commands,
      error: `Verify group ${group ?? "(none)"} has no meaningful command. Configure .pi/piagent-profile.json before source changes.`
    };
  }
  return { group, commands };
}
