import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  collectBenchmarkCandidate,
  materializeBenchmarkCandidate,
  verifyMaterializedBenchmarkCandidate,
  validBenchmarkCandidateProvenance
} from "./benchmark-candidate.js";
import { assertBenchmarkLedgerBinding, inspectBenchmarkLedger } from "./benchmark-ledger.js";
import { benchmarkPhaseAttribution } from "./benchmark-phase-attribution.js";
import { causalRuntimeEvidence } from "./benchmark-runtime-causal.js";

export { materializeBenchmarkCandidate } from "./benchmark-candidate.js";

const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);
function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

/**
 * Freeze tracked working-tree state plus non-ignored untracked content. The
 * canonical encoder also binds entry type and executable mode and can represent
 * tracked deletions without reading a missing path.
 */
export function benchmarkCandidateProvenance(root) {
  return collectBenchmarkCandidate(root).provenance;
}

function provenanceError(stage, expected, observed, mismatches, message) {
  const error = new Error(message);
  error.code = "BENCHMARK_CANDIDATE_PROVENANCE_MISMATCH";
  error.candidateProvenance = { stage, expected: expected ?? null, observed: observed ?? null, mismatches };
  error.exitCode = 1;
  return error;
}

function verifyCandidateValues(expected, observed, stage) {
  if (!validBenchmarkCandidateProvenance(expected)) {
    throw provenanceError(stage, expected, observed, ["manifest"], `Benchmark candidate provenance is missing or unsupported at ${stage}`);
  }
  if (!validBenchmarkCandidateProvenance(observed)) {
    throw provenanceError(stage, expected, observed, ["snapshot"], `Benchmark candidate snapshot provenance is missing or unsupported at ${stage}`);
  }
  const mismatches = [
    ...(observed.schemaVersion === expected.schemaVersion ? [] : ["schemaVersion"]),
    ...(observed.algorithm === expected.algorithm ? [] : ["algorithm"]),
    ...(observed.selection === expected.selection ? [] : ["selection"]),
    ...(observed.contentDigest === expected.contentDigest ? [] : ["contentDigest"]),
    ...(observed.fileCount === expected.fileCount ? [] : ["fileCount"])
  ];
  if (mismatches.length > 0) {
    throw provenanceError(stage, expected, observed, mismatches, `Benchmark candidate provenance changed at ${stage}: ${mismatches.join(", ")}`);
  }
  return observed;
}

export function verifyBenchmarkCandidateProvenance(root, expected, stage) {
  let observed;
  try {
    observed = benchmarkCandidateProvenance(root);
  } catch (cause) {
    throw provenanceError(stage, expected, null, ["workingTreeReadable"], `Benchmark candidate provenance could not be verified at ${stage}: ${cause.message}`);
  }
  return verifyCandidateValues(expected, observed, stage);
}

export function candidateProvenanceMismatch(error) {
  return error?.code === "BENCHMARK_CANDIDATE_PROVENANCE_MISMATCH"
    ? error.candidateProvenance ?? null
    : null;
}

export function createBenchmarkCandidateGuard(root, initialProvenance, options = {}) {
  let expected = initialProvenance;
  const immutableObserved = options.immutableSnapshot === true ? options.observedProvenance : undefined;
  const snapshotIndex = options.immutableSnapshot === true ? options.snapshotIndex : undefined;
  const freeze = () => {
    expected = expected ?? immutableObserved ?? benchmarkCandidateProvenance(root);
    return expected;
  };
  const observe = (stage) => {
    if (!immutableObserved) return verifyBenchmarkCandidateProvenance(root, expected, stage);
    let observed;
    try { observed = verifyMaterializedBenchmarkCandidate(root, snapshotIndex); }
    catch (cause) {
      throw provenanceError(stage, expected, null, ["snapshotReadable"], `Benchmark candidate snapshot could not be verified at ${stage}: ${cause.message}`);
    }
    return verifyCandidateValues(expected, observed, stage);
  };
  const check = (stage) => {
    return receipt(stage).error;
  };
  const receipt = (stage) => {
    try {
      const observed = observe(stage);
      return {
        error: undefined,
        stamp: { stage, mode: immutableObserved ? "immutable-snapshot" : "working-tree", matched: true, expected, observed }
      };
    } catch (error) {
      const mismatch = candidateProvenanceMismatch(error);
      return {
        error,
        stamp: { stage, mode: immutableObserved ? "immutable-snapshot" : "working-tree", matched: false, expected, observed: mismatch?.observed ?? null, mismatches: mismatch?.mismatches ?? ["unknown"] }
      };
    }
  };
  const stamp = (stage) => receipt(stage).stamp;
  return {
    freeze,
    check,
    stamp,
    receipt,
    get provenance() { return expected; },
    report() { return { ...expected, finalization: immutableObserved ? "immutable-snapshot-rehashed-and-matched" : "matched" }; }
  };
}

export function writeBenchmarkRunManifest(runRoot, manifest) {
  writePrivateAtomic(path.join(runRoot, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function writeBenchmarkAbort(runRoot, { runId, completedRuns, expectedRuns }, error, evidence = {}) {
  const provenance = candidateProvenanceMismatch(error);
  writePrivateAtomic(path.join(runRoot, "aborted.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    reason: error.message,
    completedRuns,
    expectedRuns,
    abortedAt: new Date().toISOString(),
    ...(provenance ? { candidateProvenance: provenance } : {}),
    ...evidence
  }, null, 2)}\n`);
  return provenance;
}

export async function benchmarkSourceIdentity(root, run) {
  const top = await run("git", ["-C", root, "rev-parse", "--show-toplevel"], { cwd: root, timeoutMs: 15_000 });
  if (top.code !== 0) return { kind: "package", commit: null, dirty: null };
  let repositoryRoot;
  try { repositoryRoot = fs.realpathSync(top.stdout.trim()); } catch { return { kind: "package", commit: null, dirty: null }; }
  if (repositoryRoot !== fs.realpathSync(root)) return { kind: "package", commit: null, dirty: null };
  const commit = await run("git", ["-C", root, "rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const status = await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { cwd: root, timeoutMs: 15_000 });
  return {
    kind: "git-working-tree",
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    dirty: status.code === 0 ? Boolean(status.stdout.trim()) : null
  };
}

export function writePrivate(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Non-POSIX filesystem. */ }
}

export function appendPrivateJsonl(file, value) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writePrivateAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch { /* Directory fsync is unavailable on some filesystems. */ }
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    try { fs.unlinkSync(temporary); } catch { /* Best effort. */ }
    throw error;
  }
}

function hardenPrivateSubtree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    try {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.chmodSync(current, 0o700);
        for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      } else if (stat.isFile()) fs.chmodSync(current, 0o600);
    } catch { /* Best effort for retained session evidence. */ }
  }
}

export function hardenPrivateRetentionRoot(root) {
  try {
    if (fs.lstatSync(root).isDirectory()) fs.chmodSync(root, 0o700);
  } catch {
    // Best effort for forensics only; the private marker remains authoritative.
  }
  hardenPrivateSubtree(path.join(root, "sessions"));
}

export function retainedWorkspaceMarker(workspaceRoot) {
  return path.join(workspaceRoot, ".piagent-retain.json");
}

export function retainWorkspaceForensics({ runRoot, workspaceRoot, key, record }) {
  hardenPrivateRetentionRoot(workspaceRoot);
  const relativeWorkspaceRoot = path.relative(runRoot, workspaceRoot).split(path.sep).join("/");
  const workflowGaps = (record.workflow?.checks ?? []).filter((check) => check?.passed === false).map((check) => check.id);
  const marker = {
    schemaVersion: 1,
    retainedAt: new Date().toISOString(),
    reason: record.failure ?? record.infrastructureFailure ?? (workflowGaps.length ? `workflow-gaps:${workflowGaps.join(",")}` : "unresolved-run"),
    scenarioId: record.scenarioId,
    surface: record.surface,
    repeat: record.repeat,
    infrastructureAttempt: record.infrastructureAttempt,
    workflowGaps
  };
  writePrivate(retainedWorkspaceMarker(workspaceRoot), `${JSON.stringify(marker, null, 2)}\n`);
  record.forensics = {
    workspaceRetained: true,
    key,
    workspaceRoot: relativeWorkspaceRoot,
    project: `${relativeWorkspaceRoot}/project`,
    sessions: `${relativeWorkspaceRoot}/sessions`
  };
}

export function cleanupUnretainedWorkspaces(runRoot, keepWorkspaces) {
  if (keepWorkspaces) return;
  const root = path.join(runRoot, "workspaces");
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const target = path.join(root, entry);
    if (fs.existsSync(retainedWorkspaceMarker(target))) continue;
    fs.rmSync(target, { recursive: true, force: true });
  }
  try {
    if (fs.readdirSync(root).length === 0) fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // The directory may have already been removed.
  }
}

export function acceptedTaskStartTraceCount(sessionFiles, sessionId) {
  const taskRuns = new Set();
  for (const file of sessionFiles) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const trace = entry?.type === "custom" && entry.customType === "piagent-task-trace"
        ? entry.data
        : undefined;
      if (
        trace?.event !== "task_start"
        || trace.sessionId !== sessionId
        || typeof trace.taskRunId !== "string"
        || !trace.taskRunId
      ) continue;
      taskRuns.add(trace.taskRunId);
    }
  }
  return taskRuns.size;
}

function blockedDecisionClass(reason) {
  const text = String(reason ?? "").toLowerCase();
  if (/\b(?:outside|beyond) (?:the )?(?:(?:allowed|declared) )?(?:task )?scope\b|\bnot (?:in|within) (?:the )?(?:(?:allowed|declared) )?(?:task )?scope\b/.test(text)) return "scope-invalid";
  if (/\bprotected (?:path|file)|\bpermission expansion|\bexplicit operator (?:approval|confirmation)|\bexternal confirmation/.test(text)) return "authority-invalid";
  if (/\bdestructive|\bblocked command pattern|\bdangerous command/.test(text)) return "destructive-invalid";
  if (/\btool registry blocked|\bpermission profile .+ blocked|\bundeclared (?:tool|capability)/.test(text)) return "registry-invalid";
  return "unclassified";
}

export function benchmarkOperationalEvidence(events) {
  const visible = Array.isArray(events) ? events.filter((event) => event && typeof event === "object") : [];
  const calls = new Set();
  const decisions = new Set();
  const blocked = new Map();
  const continuations = new Set();
  const advisoryContinuations = new Set();
  for (const event of visible) {
    if (event.event === "tool_call" && typeof event.toolCallId === "string" && event.toolCallId) calls.add(event.toolCallId);
    if (event.event === "tool_decision" && typeof event.toolCallId === "string" && event.toolCallId) {
      decisions.add(event.toolCallId);
      if (event.decision === "blocked") blocked.set(event.toolCallId, blockedDecisionClass(event.reason));
    }
    if (event.event === "performance_review_scheduled" || event.event === "completion_recovery_scheduled") {
      const key = `${event.event}:${event.taskRunId ?? ""}:${event.attempt ?? ""}:${event.progressSignature ?? event.recordedAt ?? ""}`;
      continuations.add(key);
      if (event.event === "performance_review_scheduled") advisoryContinuations.add(key);
    }
  }
  const available = calls.size > 0 && calls.size === decisions.size && [...calls].every((id) => decisions.has(id));
  const blockedDecisionClasses = {};
  for (const classification of blocked.values()) blockedDecisionClasses[classification] = (blockedDecisionClasses[classification] ?? 0) + 1;
  const confirmedInvalid = [...blocked.values()].filter((classification) => classification !== "unclassified").length;
  const phaseAttribution = benchmarkPhaseAttribution(visible, available);
  return {
    evidenceSource: "context-telemetry",
    available,
    toolCallsObserved: calls.size,
    toolDecisionsObserved: decisions.size,
    systemContinuations: available ? continuations.size : null,
    shadowAdvisoryAddedContinuations: available ? advisoryContinuations.size : null,
    blockedToolCalls: available ? blocked.size : null,
    blockedInvalidCallsConfirmed: available ? confirmedInvalid : null,
    blockedDecisionClasses: available ? blockedDecisionClasses : null,
    blockedValidCallsUpperBound: available ? blocked.size - confirmedInvalid : null,
    phaseAttributionAvailable: phaseAttribution.available,
    phaseAttribution
  };
}

const causalContextReadTools = new Set(["read", "grep", "find", "ls"]);
const causalContextShellTools = new Set(["bash", "shell", "exec"]);
const causalContextCoverageLanesV1 = Object.freeze([
  "telemetry-window",
  "session-lifecycle",
  "criterion-initial-pack",
  "pack-lifecycle",
  "direct-fallback-rereads",
  "managed-prefix"
]);
const causalContextCoverageLanes = Object.freeze([
  ...causalContextCoverageLanesV1,
  "edit-recovery-context"
]);
const causalContextCriterionReasons = new Set([
  "selected",
  "auto-context-disabled",
  "criterion-graph-unavailable",
  "no-candidates",
  "no-readable-selection"
]);
const causalContextMaximumAggregate = 1_000_000_000;

function boundedCausalInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= causalContextMaximumAggregate;
}

function boundedCausalSum(values) {
  let total = 0;
  for (const value of values) {
    if (!boundedCausalInteger(value) || total + value > causalContextMaximumAggregate) return null;
    total += value;
  }
  return total;
}

function normalizeCausalPath(value) {
  if (typeof value !== "string" || !value || value.length > 4_096) return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/"));
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized)
    || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function causalContextPackEvent(event, idField) {
  const id = event?.[idField];
  if (typeof id !== "string" || !id || id.length > 200 || !Array.isArray(event.selectedItems)
    || event.selectedItems.length > 10_000 || !boundedCausalInteger(event.estimatedTokens)
    || typeof event.source !== "string" || !event.source || event.source.length > 100) return null;
  const paths = event.selectedItems.map((item) => normalizeCausalPath(item?.path));
  if (paths.some((item) => item === null)) return null;
  const selectedItemEstimatedTokens = boundedCausalSum(event.selectedItems.map((item) => item?.estimatedTokens));
  if (selectedItemEstimatedTokens === null) return null;
  let binding;
  try {
    binding = JSON.stringify([event.source, event.queryHash ?? null, event.confidence ?? null,
      event.estimatedTokens, event.selectedItems]);
  } catch {
    return null;
  }
  return {
    id,
    estimatedTokens: event.estimatedTokens,
    selectedItems: event.selectedItems.length,
    selectedItemEstimatedTokens,
    criterion: event.source === "criterion-pack",
    paths,
    binding
  };
}

function causalContextTask(event, taskByTurn) {
  if (typeof event?.taskRunId === "string" && event.taskRunId) return event.taskRunId;
  if (typeof event?.turnId !== "string" || !event.turnId) return "";
  return taskByTurn.get(event.turnId) ?? "";
}

function causalEditRecoveryEvent(event) {
  const toolCallId = event?.toolCallId;
  const targetPath = normalizeCausalPath(event.targetPath);
  if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 200
    || targetPath === null
    || !/^[a-f0-9]{64}$/.test(String(event.contentHash ?? ""))
    || !boundedCausalInteger(event.originalChars)
    || !boundedCausalInteger(event.injectedChars) || event.injectedChars === 0
    || event.injectedChars <= event.originalChars
    || !boundedCausalInteger(event.injectedEstimatedTokens) || event.injectedEstimatedTokens === 0
    || event.sensitiveContentRedacted !== false) return null;
  return {
    toolCallId,
    targetPath,
    taskRunId: typeof event.taskRunId === "string" ? event.taskRunId : "",
    injectedChars: event.injectedChars,
    injectedEstimatedTokens: event.injectedEstimatedTokens
  };
}

/**
 * Persistable causal context evidence for one benchmark session. The projection
 * deliberately drops every path, prompt, hash, identifier and timestamp. Any
 * incomplete lane nulls the aggregate payload so missing telemetry cannot be
 * interpreted as zero context work.
 */
export function benchmarkCausalContextReceipt(events, {
  surface,
  sessionId,
  criterionExpected = true,
  telemetryTruncated = false,
  telemetryExists = true,
  telemetryIntegrityFailures = 0,
  recoverableTailBytes = 0
} = {}) {
  if (surface !== "piagent") return {
    schemaVersion: 1,
    evidenceSource: "not-applicable",
    applicability: "not-applicable",
    available: false,
    coverage: {
      status: "not-applicable",
      telemetryTruncated: false,
      telemetryIntegrityFailures: 0,
      recoverableTailBytes: 0,
      criterionExpected: false,
      sessionEventsObserved: 0,
      observedLanes: 0,
      requiredLanes: 0,
      missingLanes: []
    },
    aggregates: null
  };

  const visible = Array.isArray(events) && typeof sessionId === "string" && sessionId
    ? events.filter((event) => event && typeof event === "object" && event.sessionId === sessionId)
    : [];
  const envelopeFailures = visible.filter((event) => event.schemaVersion !== 2 || event.telemetrySource !== "piagent").length;
  const suppliedIntegrityFailures = boundedCausalInteger(telemetryIntegrityFailures)
    ? telemetryIntegrityFailures
    : causalContextMaximumAggregate;
  const totalIntegrityFailures = boundedCausalSum([suppliedIntegrityFailures, envelopeFailures])
    ?? causalContextMaximumAggregate;
  const promptIndexByTurn = new Map();
  for (const [index, event] of visible.entries()) {
    if (event.event !== "agent_prompt" || typeof event.turnId !== "string" || !event.turnId) continue;
    if (promptIndexByTurn.has(event.turnId)) promptIndexByTurn.set(event.turnId, null);
    else promptIndexByTurn.set(event.turnId, index);
  }
  const offered = new Map(), delivered = new Map(), injected = new Map();
  const criterion = {
    attempts: 0,
    selectedAttempts: 0,
    candidates: 0,
    selectedItems: 0,
    estimatedTokens: 0,
    zeroSelectionReasonCounts: {
      autoContextDisabled: 0,
      criterionGraphUnavailable: 0,
      noCandidates: 0,
      noReadableSelection: 0
    }
  };
  let criterionEvidenceComplete = true, packLifecycleComplete = true;
  for (const [index, event] of visible.entries()) {
    if (event.event === "criterion_context_pack") {
      const promptIndex = promptIndexByTurn.get(event.turnId);
      const valid = boundedCausalInteger(event.selected) && boundedCausalInteger(event.candidates)
        && boundedCausalInteger(event.estimatedTokens) && causalContextCriterionReasons.has(event.reasonCode)
        && event.candidates >= event.selected
        && Number.isInteger(promptIndex) && promptIndex < index
        && ((event.selected > 0 && event.reasonCode === "selected") || (event.selected === 0 && event.reasonCode !== "selected"));
      if (!valid) {
        criterionEvidenceComplete = false;
        continue;
      }
      criterion.attempts += 1;
      criterion.selectedAttempts += event.selected > 0 ? 1 : 0;
      criterion.candidates += event.candidates;
      criterion.selectedItems += event.selected;
      criterion.estimatedTokens += event.estimatedTokens;
      if (event.selected === 0) {
        const key = {
          "auto-context-disabled": "autoContextDisabled",
          "criterion-graph-unavailable": "criterionGraphUnavailable",
          "no-candidates": "noCandidates",
          "no-readable-selection": "noReadableSelection"
        }[event.reasonCode];
        criterion.zeroSelectionReasonCounts[key] += 1;
      }
      if (![criterion.attempts, criterion.selectedAttempts, criterion.candidates, criterion.selectedItems, criterion.estimatedTokens]
        .every(boundedCausalInteger)) criterionEvidenceComplete = false;
    } else if (event.event === "context_pack_offered") {
      const value = causalContextPackEvent(event, "deliveryId");
      if (!value || offered.has(value.id)) packLifecycleComplete = false;
      else offered.set(value.id, { ...value, index });
    } else if (event.event === "context_delivery_confirmed") {
      const id = event.deliveryId;
      if (typeof id !== "string" || !id || id.length > 200 || !boundedCausalInteger(event.selected) || delivered.has(id)) {
        packLifecycleComplete = false;
      } else delivered.set(id, { id, selectedItems: event.selected, index });
    } else if (event.event === "context_pack_injected") {
      const value = causalContextPackEvent(event, "injectionId");
      if (!value || injected.has(value.id)) packLifecycleComplete = false;
      else injected.set(value.id, { ...value, index });
    }
  }
  for (const [id, delivery] of delivered) {
    const offer = offered.get(id), injection = injected.get(id);
    if (!offer || !injection || offer.index >= delivery.index || delivery.index >= injection.index
      || offer.selectedItems !== delivery.selectedItems || delivery.selectedItems !== injection.selectedItems
      || offer.estimatedTokens !== injection.estimatedTokens
      || offer.selectedItemEstimatedTokens !== injection.selectedItemEstimatedTokens
      || offer.binding !== injection.binding) packLifecycleComplete = false;
  }
  for (const id of offered.keys()) if (!delivered.has(id) || !injected.has(id)) packLifecycleComplete = false;
  for (const id of delivered.keys()) if (!offered.has(id) || !injected.has(id)) packLifecycleComplete = false;
  for (const id of injected.keys()) if (!delivered.has(id)) packLifecycleComplete = false;
  const criterionOffered = [...offered.values()].filter((item) => item.criterion);
  const criterionDelivered = [...delivered.keys()].filter((id) => offered.get(id)?.criterion);
  const criterionInjected = [...injected.values()].filter((item) => item.criterion);
  if (criterionExpected === true && criterion.attempts === 0) criterionEvidenceComplete = false;
  if (criterion.selectedAttempts !== criterionOffered.length
    || criterion.selectedItems !== boundedCausalSum(criterionOffered.map((item) => item.selectedItems))
    || criterion.estimatedTokens !== boundedCausalSum(criterionOffered.map((item) => item.estimatedTokens))
    || criterionOffered.length !== criterionDelivered.length
    || criterionDelivered.length !== criterionInjected.length) criterionEvidenceComplete = false;

  const taskByTurn = new Map(visible
    .filter((event) => event.event === "turn_task_bound" && typeof event.turnId === "string"
      && event.turnId && typeof event.taskRunId === "string" && event.taskRunId)
    .map((event) => [event.turnId, event.taskRunId]));
  const activePackByTask = new Map();
  const pendingDirectReads = new Map(), seenDirectReadIds = new Set();
  let directFallbackRereadCalls = 0, shellToolCallsObserved = 0;
  let fallbackEvidenceComplete = packLifecycleComplete;
  for (const event of visible) {
    if (event.event === "context_pack_injected") {
      const taskRunId = causalContextTask(event, taskByTurn);
      const paths = injected.get(event.injectionId)?.paths;
      if (!taskRunId || !paths) {
        fallbackEvidenceComplete = false;
        continue;
      }
      const selected = activePackByTask.get(taskRunId) ?? new Set();
      for (const selectedPath of paths) selected.add(selectedPath);
      activePackByTask.set(taskRunId, selected);
      continue;
    }
    if (event.event === "tool_call") {
      const toolName = String(event.toolName ?? "").toLowerCase();
      const taskRunId = causalContextTask(event, taskByTurn);
      const selected = activePackByTask.get(taskRunId);
      if (selected && causalContextShellTools.has(toolName)) shellToolCallsObserved += 1;
      if (!selected || !causalContextReadTools.has(toolName)) continue;
      const target = normalizeCausalPath(event.targetPath);
      if (!target || typeof event.toolCallId !== "string" || !event.toolCallId || event.toolCallId.length > 200) {
        fallbackEvidenceComplete = false;
        continue;
      }
      if (!selected.has(target)) continue;
      if (seenDirectReadIds.has(event.toolCallId)) fallbackEvidenceComplete = false;
      else {
        seenDirectReadIds.add(event.toolCallId);
        pendingDirectReads.set(event.toolCallId, target);
      }
      continue;
    }
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!toolCallId || !pendingDirectReads.has(toolCallId)) continue;
    if (event.event === "tool_decision" && event.decision === "blocked") {
      pendingDirectReads.delete(toolCallId);
      continue;
    }
    if (event.event === "tool_result") {
      if (event.isError !== true) directFallbackRereadCalls += 1;
      pendingDirectReads.delete(toolCallId);
    }
  }
  if (pendingDirectReads.size > 0) fallbackEvidenceComplete = false;

  const recoverySessionStarts = visible.filter((event) => event.event === "session_start");
  const firstRecoverySessionStart = visible.findIndex((event) => event.event === "session_start");
  const recoveryCapabilityComplete = recoverySessionStarts.length > 0
    && recoverySessionStarts.every((event) => event.editRecoveryContextTelemetryVersion === 1);
  const editRecoveryReceipts = new Map(), editRecoveryResults = new Map();
  let editRecoveryEvidenceComplete = recoveryCapabilityComplete;
  for (const [index, event] of visible.entries()) {
    if (event.event === "edit_recovery_context") {
      const value = causalEditRecoveryEvent(event);
      if (!value || index <= firstRecoverySessionStart || editRecoveryReceipts.has(value.toolCallId)) editRecoveryEvidenceComplete = false;
      else editRecoveryReceipts.set(value.toolCallId, { ...value, index });
      continue;
    }
    if (event.event !== "tool_result") continue;
    const recoveryFailure = ["edit-anchor-not-unique", "edit-anchor-stale"].includes(event.reasonCode);
    if (!recoveryFailure) {
      if (event.editRecoveryContext !== undefined) editRecoveryEvidenceComplete = false;
      continue;
    }
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 200
      || editRecoveryResults.has(toolCallId)
      || index <= firstRecoverySessionStart
      || String(event.toolName ?? "").toLowerCase() !== "edit"
      || event.isError !== true
      || typeof event.editRecoveryContext !== "boolean"
      || normalizeCausalPath(event.targetPath) === null
      || (event.editRecoveryContext === true
        && (!boundedCausalInteger(event.editRecoveryInjectedChars) || event.editRecoveryInjectedChars === 0
          || !boundedCausalInteger(event.editRecoveryEstimatedTokens) || event.editRecoveryEstimatedTokens === 0))
      || (event.editRecoveryContext === false
        && (event.editRecoveryInjectedChars !== undefined || event.editRecoveryEstimatedTokens !== undefined))) {
      editRecoveryEvidenceComplete = false;
      continue;
    }
    editRecoveryResults.set(toolCallId, {
      index,
      injected: event.editRecoveryContext,
      targetPath: normalizeCausalPath(event.targetPath),
      taskRunId: typeof event.taskRunId === "string" ? event.taskRunId : "",
      injectedChars: event.editRecoveryInjectedChars,
      injectedEstimatedTokens: event.editRecoveryEstimatedTokens
    });
  }
  for (const [toolCallId, receipt] of editRecoveryReceipts) {
    const result = editRecoveryResults.get(toolCallId);
    if (!result || result.injected !== true || receipt.index >= result.index
      || receipt.targetPath !== result.targetPath
      || receipt.taskRunId !== result.taskRunId
      || receipt.injectedChars !== result.injectedChars
      || receipt.injectedEstimatedTokens !== result.injectedEstimatedTokens) editRecoveryEvidenceComplete = false;
  }
  for (const [toolCallId, result] of editRecoveryResults) {
    if (result.injected !== editRecoveryReceipts.has(toolCallId)) editRecoveryEvidenceComplete = false;
  }
  const editRecoveryInjectedChars = boundedCausalSum([...editRecoveryReceipts.values()].map((item) => item.injectedChars));
  const editRecoveryEstimatedTokens = boundedCausalSum([...editRecoveryReceipts.values()].map((item) => item.injectedEstimatedTokens));
  editRecoveryEvidenceComplete &&= editRecoveryInjectedChars !== null && editRecoveryEstimatedTokens !== null;

  const prompts = visible.map((event, index) => ({ event, index }))
    .filter((item) => item.event.event === "agent_prompt");
  const managedPrefixComplete = prompts.length > 0
    && prompts.every((item) => typeof item.event.managedInstructionsCompacted === "boolean");
  const compactedPrompts = prompts.filter((item) => item.event.managedInstructionsCompacted === true).length;
  const lastPromptIndex = prompts.at(-1)?.index ?? -1;
  const lifecycleComplete = prompts.length > 0
    && visible.some((event, index) => index > lastPromptIndex
      && (event.event === "agent_settled" || event.event === "session_shutdown"));
  const offeredTokens = boundedCausalSum([...offered.values()].map((item) => item.estimatedTokens));
  const deliveredTokens = boundedCausalSum([...delivered.keys()].map((id) => offered.get(id)?.estimatedTokens));
  const injectedTokens = boundedCausalSum([...injected.values()].map((item) => item.estimatedTokens));
  const offeredItemTokens = boundedCausalSum([...offered.values()].map((item) => item.selectedItemEstimatedTokens));
  const deliveredItemTokens = boundedCausalSum([...delivered.keys()].map((id) => offered.get(id)?.selectedItemEstimatedTokens));
  const injectedItemTokens = boundedCausalSum([...injected.values()].map((item) => item.selectedItemEstimatedTokens));
  const offeredItems = boundedCausalSum([...offered.values()].map((item) => item.selectedItems));
  const deliveredItems = boundedCausalSum([...delivered.values()].map((item) => item.selectedItems));
  const injectedItems = boundedCausalSum([...injected.values()].map((item) => item.selectedItems));
  const aggregateBoundsComplete = [offeredTokens, deliveredTokens, injectedTokens, offeredItemTokens, deliveredItemTokens,
    injectedItemTokens, offeredItems, deliveredItems, injectedItems]
    .every((value) => value !== null) && boundedCausalInteger(directFallbackRereadCalls)
    && boundedCausalInteger(shellToolCallsObserved);
  packLifecycleComplete &&= aggregateBoundsComplete;
  fallbackEvidenceComplete &&= aggregateBoundsComplete;

  const lanes = {
    "telemetry-window": telemetryExists === true && telemetryTruncated !== true
      && totalIntegrityFailures === 0 && recoverableTailBytes === 0,
    "session-lifecycle": lifecycleComplete,
    "criterion-initial-pack": criterionEvidenceComplete,
    "pack-lifecycle": packLifecycleComplete,
    "direct-fallback-rereads": fallbackEvidenceComplete,
    "managed-prefix": managedPrefixComplete,
    "edit-recovery-context": editRecoveryEvidenceComplete
  };
  const missingLanes = causalContextCoverageLanes.filter((lane) => lanes[lane] !== true);
  const observedLanes = causalContextCoverageLanes.length - missingLanes.length;
  const available = missingLanes.length === 0;
  const compactions = visible.filter((event) => event.event === "session_compact").length;
  const managedPrefixState = compactedPrompts === 0
    ? "uncompacted"
    : compactedPrompts === prompts.length ? "compacted" : "mixed";
  return {
    schemaVersion: 3,
    evidenceSource: "context-telemetry-closed-aggregate-v3",
    applicability: "piagent",
    available,
    coverage: {
      status: available ? "complete" : visible.length === 0 || !lifecycleComplete ? "unavailable" : "partial",
      telemetryTruncated: telemetryTruncated === true,
      telemetryIntegrityFailures: totalIntegrityFailures,
      recoverableTailBytes: boundedCausalInteger(recoverableTailBytes) ? recoverableTailBytes : causalContextMaximumAggregate,
      criterionExpected: criterionExpected === true,
      sessionEventsObserved: visible.length,
      observedLanes,
      requiredLanes: causalContextCoverageLanes.length,
      missingLanes
    },
    aggregates: available ? {
      packCounts: { offered: offered.size, delivered: delivered.size, injected: injected.size },
      estimatedTokens: { offered: offeredTokens, delivered: deliveredTokens, injected: injectedTokens },
      selectedItemEstimatedTokens: { offered: offeredItemTokens, delivered: deliveredItemTokens, injected: injectedItemTokens },
      selectedItemCounts: { offered: offeredItems, delivered: deliveredItems, injected: injectedItems },
      criterionInitialPack: {
        ...criterion,
        offered: criterionOffered.length,
        delivered: criterionDelivered.length,
        injected: criterionInjected.length
      },
      directFallbackRereads: {
        successfulCalls: directFallbackRereadCalls,
        shellToolCallsObserved,
        definition: "successful-direct-path-tool-call-v1"
      },
      editRecoveryContext: {
        count: editRecoveryReceipts.size,
        failuresObserved: editRecoveryResults.size,
        suppressedFailures: [...editRecoveryResults.values()].filter((item) => item.injected === false).length,
        injectedChars: editRecoveryInjectedChars,
        injectedEstimatedTokens: editRecoveryEstimatedTokens,
        evidenceCoverage: {
          status: "complete",
          observed: editRecoveryReceipts.size,
          comparable: editRecoveryReceipts.size,
          rate: 1
        },
        definition: "matched-edit-recovery-context-receipt-v1"
      },
      runtimeCausal: causalRuntimeEvidence(visible),
      compaction: { eventsObserved: compactions, state: compactions > 0 ? "observed" : "not-observed" },
      managedPrefix: { promptsObserved: prompts.length, compactedPrompts, state: managedPrefixState }
    } : null
  };
}

export function loadReplayFailurePlan(reportPath) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    fail(`Cannot read replay report ${reportPath}: ${error.message}`, 1);
  }
  const seed = report?.environment?.variantRootSeed;
  if (typeof seed !== "string" || !seed.trim()) fail("Replay report does not contain environment.variantRootSeed", 1);
  const surfaces = Array.isArray(report?.environment?.surfaces)
    ? report.environment.surfaces.filter((surface) => benchmarkSurfaces.has(surface))
    : [];
  if (surfaces.length !== 2 || !surfaces.includes("piagent")) fail("Replay report must contain the two original benchmark surfaces", 1);
  const failedKeys = new Set((report.runs ?? [])
    .filter((run) => run?.surface === "piagent" && run.resolved !== true)
    .map((run) => `${run.scenarioId}:${run.repeat}`));
  if (failedKeys.size === 0) fail("Replay report has no failed Piagent runs", 1);
  const replayRuns = [];
  for (const key of failedKeys) {
    const pair = (report.runs ?? []).filter((run) => `${run.scenarioId}:${run.repeat}` === key && surfaces.includes(run.surface));
    if (pair.length !== surfaces.length || new Set(pair.map((run) => run.surface)).size !== surfaces.length) {
      fail(`Replay report must contain exactly one record for both original surfaces at failed pair ${key}`, 1);
    }
    for (const surface of surfaces) {
      const run = pair.find((item) => item.surface === surface);
      replayRuns.push({ scenarioId: run.scenarioId, surface: run.surface, repeat: run.repeat });
    }
  }
  if (replayRuns.length === 0) fail("Replay report did not yield runnable failed pairs", 1);
  const manifestPath = path.join(path.dirname(reportPath), "run-manifest.json");
  const ledgerPath = path.join(path.dirname(reportPath), "runs.jsonl");
  let evidenceComplete = false;
  let manifest;
  if (fs.existsSync(manifestPath) && fs.existsSync(ledgerPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const ledger = inspectBenchmarkLedger(ledgerPath);
    assertBenchmarkLedgerBinding(manifest.ledger, ledger.binding, "replay manifest ledger");
    assertBenchmarkLedgerBinding(report.ledger, ledger.binding, "replay report ledger");
    if (manifest.runId !== report.runId) fail("Replay report runId does not match its manifest", 1);
    if (JSON.stringify(ledger.records) !== JSON.stringify(report.runs)) fail("Replay report runs do not match its bound ledger", 1);
    if (manifest.suiteDigest !== report.environment?.suiteDigest) fail("Replay report suite digest does not match its manifest", 1);
    if (manifest.candidateProvenance?.contentDigest !== report.environment?.candidateProvenance?.contentDigest) {
      fail("Replay report candidate provenance does not match its manifest", 1);
    }
    evidenceComplete = true;
  }
  return {
    suite: manifest?.suite?.source ?? report?.suite?.source ?? report?.suite?.id ?? "production-v1",
    seed,
    surfaces,
    model: report?.environment?.requestedModel ?? undefined,
    thinking: report?.environment?.requestedThinking ?? undefined,
    piagentTreatment: report?.environment?.piagentTreatment?.id ?? "release-defaults",
    replayRuns,
    source: {
      reportPath,
      reportDigest: crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex"),
      evidenceComplete,
      runId: report?.runId ?? null,
      failedPairs: [...failedKeys].sort()
    }
  };
}

export function failureReason({ agent, grade, graderIntegrity, outsideScope, forbiddenHits, missingRequired }) {
  const failures = [];
  if (agent.timedOut) failures.push("agent-timeout");
  else if (agent.code !== 0) failures.push(`agent-exit-${agent.code}`);
  if (!grade.passed) failures.push(grade.error ?? "hidden-grader-failed");
  if (!graderIntegrity.passed) failures.push("grader-mutated-workspace");
  if (outsideScope.length) failures.push(`outside-scope:${outsideScope.join(",")}`);
  if (forbiddenHits.length) failures.push("forbidden-output");
  if (missingRequired.length) failures.push("required-output-missing");
  return failures.join("; ") || undefined;
}

export function safeInfrastructureDiagnostic(value, forbiddenValues) {
  let diagnostic = String(value ?? "");
  for (const forbidden of forbiddenValues) {
    if (forbidden) diagnostic = diagnostic.replaceAll(forbidden, "[REDACTED]");
  }
  diagnostic = diagnostic
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(-4_000);
  return `redacted-diagnostic-sha256:${crypto.createHash("sha256").update(diagnostic).digest("hex")}`;
}

export function terminalPiSessionError(sessionFiles, sessionId) {
  for (const file of sessionFiles) {
    const entries = fs.readFileSync(file, "utf8").split(/\n/).flatMap((line) => {
      if (!line) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (!entries.some((entry) => entry?.type === "session" && entry.id === sessionId)) continue;
    const assistants = entries.filter((entry) => entry?.type === "message" && entry.message?.role === "assistant");
    const terminal = assistants.at(-1)?.message;
    if (terminal?.stopReason === "error" && typeof terminal.errorMessage === "string" && terminal.errorMessage.trim()) {
      return terminal.errorMessage.trim();
    }
  }
  return undefined;
}

export function classifyPreUsageFailure(agent, usage, diagnosticInput, { terminalProviderError = false } = {}) {
  if (agent.timedOut) return undefined;
  const diagnostic = String(diagnosticInput ?? "").toLowerCase();
  const measuredUsage = Number.isInteger(usage?.sessions) && usage.sessions > 0
    && ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total", "fresh"]
      .every((field) => Number.isFinite(usage?.[field]) && Number(usage[field]) >= 0)
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const measuredZeroUsage = measuredUsage
    && ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total", "fresh"]
      .every((field) => Number(usage[field]) === 0);
  const providerUnavailable = /\b(?:server(?:s)? (?:are )?(?:currently )?overloaded|temporarily unavailable|service unavailable|try again later)\b/.test(diagnostic);
  if ((terminalProviderError || agent.code !== 0) && measuredUsage && providerUnavailable) {
    const afterUsage = Number(usage.fresh) > 0;
    return {
      failure: afterUsage
        ? "provider-temporarily-unavailable-after-measured-usage"
        : "provider-temporarily-unavailable-with-zero-measured-usage",
      class: "provider-infrastructure",
      usageStatus: "measured-but-unaccepted",
      retryable: !afterUsage
    };
  }
  if (agent.code === 0 && measuredZeroUsage
    && /\b(?:server(?:s)? (?:are )?(?:currently )?overloaded|temporarily unavailable|service unavailable|try again later)\b/.test(diagnostic)) {
    return {
      failure: "provider-temporarily-unavailable-with-zero-measured-usage",
      class: "provider-infrastructure",
      usageStatus: "measured-but-unaccepted",
      retryable: true
    };
  }
  if (agent.code === 0) return undefined;
  if (/\b(?:provider|safety|policy|refus(?:al|ed|e)|disallowed|not allowed|cannot assist|can't assist|cyber safety)\b/.test(diagnostic)) {
    return measuredUsage
      ? { failure: "provider-policy-refusal-after-measured-usage", class: "provider-policy", usageStatus: "measured-but-unaccepted", retryable: false }
      : { failure: "provider-policy-refusal-with-usage-unavailable", class: "provider-policy", usageStatus: "unknown-after-provider-start", retryable: false };
  }
  if (measuredUsage) return { failure: `agent-exit-${agent.code}-after-measured-usage`, class: "agent-process", usageStatus: "measured-but-unaccepted", retryable: false };
  return { failure: `agent-exit-${agent.code}-with-usage-unavailable`, class: "unknown-cost", usageStatus: "unknown-after-provider-start", retryable: true };
}
