import path from "node:path";

const MAXIMUM_AGGREGATE = 1_000_000_000;
const adaptiveContextEvents = new Set([
  "context_governor_projection",
  "context_governor_projection_noop",
  "context_governor_compaction_cancelled",
  "context_governor_deterministic_compaction",
  "context_governor_deterministic_compaction_skipped"
]);

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_AGGREGATE;
}

function normalizePath(value) {
  if (typeof value !== "string" || !value || value.length > 4_096) return null;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/"));
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized)
    || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function section(coverageStatus, observedEvents, aggregate, evidenceSource = "context-telemetry") {
  return { coverageStatus, observedEvents, evidenceSource, aggregate };
}

function unavailableWebUiSection() {
  return section("not-observed", 0, null, "provider-free-runtime-conformance");
}

function savingsAccounting(event) {
  const accounting = event?.accounting;
  if (!accounting || typeof accounting !== "object" || Array.isArray(accounting)
    || !boundedInteger(accounting.estimatedSavingsTokens)
    || !boundedInteger(accounting.minimumSavingsTokens)
    || typeof accounting.minimumSavingsMet !== "boolean") return null;
  return {
    estimated: accounting.estimatedSavingsTokens,
    minimum: accounting.minimumSavingsTokens,
    met: accounting.minimumSavingsMet
  };
}

function projectionAccounting(event) {
  if (!boundedInteger(event?.estimatedSavingsTokens)
    || !boundedInteger(event?.minimumSavingsTokens)
    || !boundedInteger(event?.accounting?.billedTraffic?.governorProviderCalls)) return null;
  return {
    estimated: event.estimatedSavingsTokens,
    minimum: event.minimumSavingsTokens,
    met: event.estimatedSavingsTokens >= event.minimumSavingsTokens,
    providerCalls: event.accounting.billedTraffic.governorProviderCalls
  };
}

function protocolFailure(event) {
  const protocol = event?.protocol;
  if (protocol && typeof protocol === "object" && !Array.isArray(protocol)
    && protocol.intact === false && Array.isArray(protocol.orphanCallIds) && Array.isArray(protocol.orphanResultIds)
    && protocol.orphanCallIds.length <= MAXIMUM_AGGREGATE
    && protocol.orphanResultIds.length <= MAXIMUM_AGGREGATE) {
    return { calls: protocol.orphanCallIds.length, results: protocol.orphanResultIds.length };
  }
  const codes = Array.isArray(event?.reasonCodes) ? event.reasonCodes : [];
  const count = (prefix) => {
    const match = codes.find((code) => typeof code === "string" && code.startsWith(prefix));
    const value = match ? Number.parseInt(match.slice(prefix.length), 10) : 0;
    return boundedInteger(value) ? value : null;
  };
  const calls = count("orphan-calls:"), results = count("orphan-results:");
  return calls === null || results === null ? null : { calls, results };
}

function adaptiveContextSection(visible) {
  const events = visible.filter((event) => adaptiveContextEvents.has(event.event));
  if (events.length === 0) return section("not-observed", 0, null);
  const aggregate = {
    projected: 0,
    noOp: 0,
    cancelled: 0,
    deterministicCompactions: 0,
    hostSummaryFallbacks: 0,
    estimatedSavingsTokens: 0,
    minimumSavingsTokens: 0,
    minimumSavingsMet: 0,
    minimumSavingsNotMet: 0,
    governorProviderCalls: 0,
    deterministicCompactionProviderCalls: 0,
    protocolIntegrity: { checks: 0, intact: 0, failed: 0, orphanCalls: 0, orphanResults: 0 },
    definition: "adaptive-context-runtime-receipt-v1"
  };
  let complete = true;
  const add = (key, value) => {
    const next = aggregate[key] + value;
    if (!boundedInteger(value) || !boundedInteger(next)) complete = false;
    else aggregate[key] = next;
  };
  const addProtocol = (intact, failure = { calls: 0, results: 0 }, checks = 1) => {
    const protocol = aggregate.protocolIntegrity;
    for (const [key, value] of Object.entries({
      checks,
      intact: intact ? checks : 0,
      failed: intact ? 0 : checks,
      orphanCalls: failure.calls,
      orphanResults: failure.results
    })) {
      const next = protocol[key] + value;
      if (!boundedInteger(value) || !boundedInteger(next)) complete = false;
      else protocol[key] = next;
    }
  };
  const addSavings = (accounting) => {
    add("estimatedSavingsTokens", accounting.estimated);
    add("minimumSavingsTokens", accounting.minimum);
    add(accounting.met ? "minimumSavingsMet" : "minimumSavingsNotMet", 1);
  };

  for (const event of events) {
    if (event.event === "context_governor_projection") {
      const accounting = projectionAccounting(event);
      if (!accounting || event.action !== "project" || !accounting.met) { complete = false; continue; }
      aggregate.projected += 1;
      addSavings(accounting);
      add("governorProviderCalls", accounting.providerCalls);
      addProtocol(true, undefined, 2);
      continue;
    }
    if (event.event === "context_governor_projection_noop") {
      const accounting = projectionAccounting(event);
      if (!accounting || event.action !== "passthrough"
        || !["no-safe-boundary", "insufficient-savings", "unsafe-tool-protocol"].includes(event.fallback)) {
        complete = false; continue;
      }
      aggregate.noOp += 1;
      addSavings(accounting);
      add("governorProviderCalls", accounting.providerCalls);
      if (event.fallback === "unsafe-tool-protocol") {
        const failure = protocolFailure(event);
        if (!failure) complete = false;
        else addProtocol(false, failure);
      } else addProtocol(true, undefined, event.fallback === "insufficient-savings" ? 2 : 1);
      continue;
    }
    if (event.event === "context_governor_compaction_cancelled") {
      aggregate.cancelled += 1;
      if (event.fallback === "no-op-unsafe-tool-boundary") {
        const failure = protocolFailure(event);
        if (!failure) complete = false;
        else addProtocol(false, failure);
      } else if (event.fallback === "no-op-insufficient-savings") {
        const accounting = savingsAccounting(event);
        if (!accounting || accounting.met) complete = false;
        else addSavings(accounting);
        addProtocol(true);
      } else complete = false;
      continue;
    }
    if (event.event === "context_governor_deterministic_compaction") {
      const accounting = savingsAccounting(event), billed = event?.accounting?.billedTraffic;
      const zeroBilled = billed?.measured === true && billed?.inputTokens === 0 && billed?.outputTokens === 0
        && billed?.cacheReadTokens === 0 && billed?.scope === "local-deterministic-summary-generation";
      if (!accounting || (!accounting.met && event.minimumSavingsOverride !== "overflow-recovery") || !zeroBilled) {
        complete = false; continue;
      }
      aggregate.deterministicCompactions += 1;
      addSavings(accounting);
      addProtocol(true);
      continue;
    }
    if (event.event === "context_governor_deterministic_compaction_skipped") {
      if (!["host-model-directed-summary", "host-model-overflow-recovery"].includes(event.fallback)) complete = false;
      else aggregate.hostSummaryFallbacks += 1;
    }
  }
  return section(complete ? "complete" : "partial", events.length, complete ? aggregate : null);
}

function freshnessPaths(event) {
  if (!Array.isArray(event?.paths) || event.paths.length === 0 || event.paths.length > 10_000) return null;
  const paths = event.paths.map(normalizePath);
  return paths.some((item) => item === null) ? null : [...new Set(paths)];
}

function editFreshnessSection(visible) {
  const observations = visible.map((event, index) => ({ event, index }))
    .filter(({ event }) => ["edit_freshness_snapshot_observed", "edit_freshness_stale"].includes(event.event));
  if (observations.length === 0) return section("not-observed", 0, null);
  const snapshots = [], stale = [];
  let complete = true;
  for (const item of observations) {
    const paths = freshnessPaths(item.event);
    const taskRunId = typeof item.event.taskRunId === "string" && item.event.taskRunId ? item.event.taskRunId : null;
    if (!paths || !taskRunId) { complete = false; continue; }
    if (item.event.event === "edit_freshness_snapshot_observed") {
      if (!["read", "mutation"].includes(item.event.source)) { complete = false; continue; }
      snapshots.push({ ...item, paths, taskRunId, source: item.event.source });
    } else {
      if (typeof item.event.toolCallId !== "string" || !item.event.toolCallId
        || typeof item.event.enforce !== "boolean") { complete = false; continue; }
      stale.push({ ...item, paths, taskRunId, toolCallId: item.event.toolCallId, enforce: item.event.enforce });
    }
  }
  let staleBlocks = 0, rereadRecoveries = 0, mutationRecoveries = 0;
  const enforced = stale.filter((item) => item.enforce);
  for (const item of enforced) {
    const initialSnapshot = item.paths.every((target) => snapshots.some((snapshot) => snapshot.index < item.index
      && snapshot.taskRunId === item.taskRunId && snapshot.source === "read" && snapshot.paths.includes(target)));
    if (!initialSnapshot) complete = false;
    const decisionIndex = visible.findIndex((event, index) => index > item.index && event.event === "tool_decision"
      && event.toolCallId === item.toolCallId && event.decision === "blocked");
    if (decisionIndex >= 0) staleBlocks += 1;
    const reread = decisionIndex >= 0 && item.paths.every((target) => snapshots.some((snapshot) => snapshot.index > decisionIndex
      && snapshot.taskRunId === item.taskRunId && snapshot.source === "read" && snapshot.paths.includes(target)));
    if (reread) rereadRecoveries += 1;
    const mutation = reread && item.paths.every((target) => snapshots.some((snapshot) => snapshot.index > decisionIndex
      && snapshot.taskRunId === item.taskRunId && snapshot.source === "mutation" && snapshot.paths.includes(target)));
    if (mutation) mutationRecoveries += 1;
  }
  const incompleteRecoveries = enforced.length - rereadRecoveries;
  if (incompleteRecoveries > 0 || staleBlocks !== enforced.length) complete = false;
  const aggregate = {
    snapshotObservations: snapshots.length,
    readSnapshots: snapshots.filter((item) => item.source === "read").length,
    mutationSnapshots: snapshots.filter((item) => item.source === "mutation").length,
    staleDetections: stale.length,
    enforcedStaleDetections: enforced.length,
    staleBlocks,
    rereadRecoveries,
    mutationRecoveries,
    incompleteRecoveries,
    definition: "edit-freshness-runtime-receipt-v1"
  };
  return section(complete ? "complete" : "partial", observations.length, complete ? aggregate : null);
}

export function causalRuntimeEvidence(visible) {
  return {
    adaptiveContext: adaptiveContextSection(visible),
    operationLifecycle: unavailableWebUiSection(),
    boundedEmission: unavailableWebUiSection(),
    editFreshness: editFreshnessSection(visible)
  };
}
