function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeRelative(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function taskBindings(events) {
  return new Map(events
    .filter((event) => event.event === "turn_task_bound" && typeof event.sessionId === "string" && typeof event.turnId === "string" && typeof event.taskRunId === "string")
    .map((event) => [`${event.sessionId}\0${event.turnId}`, event.taskRunId]));
}

function evidenceCoverage(comparable, observed) {
  return ratio(comparable, observed);
}

const MAX_CONTEXT_METRIC_AGGREGATE = 1_000_000_000;

function boundedContextMetricInteger(value, { positive = false } = {}) {
  return Number.isSafeInteger(value)
    && value >= (positive ? 1 : 0)
    && value <= MAX_CONTEXT_METRIC_AGGREGATE;
}

export function editRecoveryContextMetrics(events) {
  const sessionStarts = new Map();
  for (const [index, event] of events.entries()) {
    if (event.event !== "session_start" || typeof event.sessionId !== "string" || !event.sessionId) continue;
    const existing = sessionStarts.get(event.sessionId) ?? { firstIndex: index, valid: true };
    existing.valid &&= event.editRecoveryContextTelemetryVersion === 1;
    sessionStarts.set(event.sessionId, existing);
  }
  const receipts = new Map(), results = new Map();
  let invalidReceipts = 0, invalidResults = 0;
  let recoveryFailures = 0, comparableRecoveryFailures = 0, suppressedRecoveryFailures = 0;
  const recoveryKey = (event) => typeof event.sessionId === "string" && event.sessionId
    && typeof event.toolCallId === "string" && event.toolCallId && event.toolCallId.length <= 200
    ? `${event.sessionId}\0${event.toolCallId}` : "";
  const recoveryPath = (value) => {
    const normalized = normalizeRelative(value);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")
      || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return "";
    return normalized;
  };
  for (const [index, event] of events.entries()) {
    if (event.event === "edit_recovery_context") {
      const key = recoveryKey(event), targetPath = recoveryPath(event.targetPath);
      const valid = key && targetPath && /^[a-f0-9]{64}$/.test(String(event.contentHash ?? ""))
        && boundedContextMetricInteger(event.originalChars)
        && boundedContextMetricInteger(event.injectedChars, { positive: true })
        && event.injectedChars > event.originalChars
        && boundedContextMetricInteger(event.injectedEstimatedTokens, { positive: true })
        && event.sensitiveContentRedacted === false;
      if (!valid) {
        invalidReceipts += 1;
        continue;
      }
      const values = receipts.get(key) ?? [];
      values.push({ ...event, index, targetPath });
      receipts.set(key, values);
      continue;
    }
    if (event.event !== "tool_result") continue;
    const recoveryFailure = ["edit-anchor-not-unique", "edit-anchor-stale"].includes(event.reasonCode);
    if (!recoveryFailure) {
      if (event.editRecoveryContext !== undefined) invalidResults += 1;
      continue;
    }
    recoveryFailures += 1;
    const key = recoveryKey(event), targetPath = recoveryPath(event.targetPath);
    const valid = key && targetPath && String(event.toolName ?? "").toLowerCase() === "edit"
      && event.isError === true && typeof event.editRecoveryContext === "boolean"
      && (event.editRecoveryContext === true
        ? boundedContextMetricInteger(event.editRecoveryInjectedChars, { positive: true })
          && boundedContextMetricInteger(event.editRecoveryEstimatedTokens, { positive: true })
        : event.editRecoveryInjectedChars === undefined && event.editRecoveryEstimatedTokens === undefined);
    if (!valid) {
      continue;
    }
    const capability = sessionStarts.get(event.sessionId);
    if (capability?.valid === true && capability.firstIndex < index) {
      comparableRecoveryFailures += 1;
      if (event.editRecoveryContext === false) suppressedRecoveryFailures += 1;
    }
    if (event.editRecoveryContext === false) continue;
    const values = results.get(key) ?? [];
    values.push({ ...event, index, targetPath });
    results.set(key, values);
  }
  const recoveryKeys = new Set([...receipts.keys(), ...results.keys()]);
  let recoveryEvents = invalidReceipts + invalidResults;
  let comparableEvents = 0;
  let injectedChars = 0;
  let injectedEstimatedTokens = 0;
  for (const key of recoveryKeys) {
    const receiptGroup = receipts.get(key) ?? [], resultGroup = results.get(key) ?? [];
    recoveryEvents += Math.max(receiptGroup.length, resultGroup.length);
    if (receiptGroup.length !== 1 || resultGroup.length !== 1) continue;
    const receipt = receiptGroup[0], result = resultGroup[0];
    const capability = sessionStarts.get(receipt.sessionId);
    if (capability?.valid !== true || capability.firstIndex >= receipt.index
      || receipt.index >= result.index || receipt.targetPath !== result.targetPath
      || String(receipt.taskRunId ?? "") !== String(result.taskRunId ?? "")
      || receipt.injectedChars !== result.editRecoveryInjectedChars
      || receipt.injectedEstimatedTokens !== result.editRecoveryEstimatedTokens
      || injectedChars + receipt.injectedChars > MAX_CONTEXT_METRIC_AGGREGATE
      || injectedEstimatedTokens + receipt.injectedEstimatedTokens > MAX_CONTEXT_METRIC_AGGREGATE) continue;
    comparableEvents += 1;
    injectedChars += receipt.injectedChars;
    injectedEstimatedTokens += receipt.injectedEstimatedTokens;
  }
  return {
    editRecoveryContextEvents: recoveryEvents,
    comparableEditRecoveryContextEvents: comparableEvents,
    uncomparableEditRecoveryContextEvents: recoveryEvents - comparableEvents,
    editRecoveryContextEvidenceCoverage: evidenceCoverage(comparableEvents, recoveryEvents),
    editRecoveryContextCount: comparableEvents,
    editRecoveryInjectedChars: injectedChars,
    editRecoveryEstimatedTokens: injectedEstimatedTokens,
    editRecoveryFailures: recoveryFailures,
    comparableEditRecoveryFailures: comparableRecoveryFailures,
    uncomparableEditRecoveryFailures: recoveryFailures - comparableRecoveryFailures,
    editRecoveryFailureEvidenceCoverage: evidenceCoverage(comparableRecoveryFailures, recoveryFailures),
    editRecoverySuppressedFailures: suppressedRecoveryFailures
  };
}

export function contextMetricPartition(event, taskByTurn = new Map()) {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  const taskRunId = typeof event.taskRunId === "string" ? event.taskRunId : taskByTurn.get(`${sessionId}\0${turnId}`) ?? "";
  if (!sessionId || !taskRunId) return "";
  return [sessionId, taskRunId, event.model ?? "unknown", event.thinkingLevel ?? "unknown"].join("\0");
}

export function prefixEfficiencyMetrics(events) {
  const taskByTurn = taskBindings(events), partitions = new Map();
  const prefixPrompts = events.filter((event) => event.event === "agent_prompt").length;
  for (const event of events) {
    if (event.event !== "agent_prompt" || typeof event.prefixSurfaceHash !== "string") continue;
    const partition = contextMetricPartition(event, taskByTurn);
    if (!partition) continue;
    const values = partitions.get(partition) ?? [];
    values.push(event.prefixSurfaceHash);
    partitions.set(partition, values);
  }
  let prompts = 0, transitions = 0, changes = 0;
  const rates = [], turnsPerEpoch = [];
  for (const hashes of partitions.values()) {
    const partitionTransitions = Math.max(0, hashes.length - 1);
    let partitionChanges = 0;
    for (let index = 1; index < hashes.length; index += 1) if (hashes[index] !== hashes[index - 1]) partitionChanges += 1;
    prompts += hashes.length; transitions += partitionTransitions; changes += partitionChanges;
    if (partitionTransitions > 0) rates.push(ratio(partitionChanges, partitionTransitions));
    turnsPerEpoch.push(ratio(hashes.length, 1 + partitionChanges));
  }
  return {
    prefixPrompts,
    comparablePrefixPrompts: prompts,
    prefixEvidenceCoverage: evidenceCoverage(prompts, prefixPrompts),
    prefixTransitions: transitions,
    prefixChanges: changes,
    prefixChangeRate: ratio(changes, transitions),
    macroPrefixChangeRate: ratio(rates.reduce((sum, value) => sum + value, 0), rates.length),
    averageTurnsPerPrefixEpoch: ratio(prompts, partitions.size + changes),
    macroTurnsPerPrefixEpoch: ratio(turnsPerEpoch.reduce((sum, value) => sum + value, 0), turnsPerEpoch.length)
  };
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", "patch"]);

function normalizedPaths(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(normalizeRelative)
    .filter(Boolean))];
}

function successfulMutationPaths(event) {
  if (event.event !== "tool_result") return null;
  const explicit = [event.changedPaths, event.mutationPaths, event.targetPaths]
    .find((value) => Array.isArray(value));
  if (explicit) {
    const paths = normalizedPaths(explicit);
    if (paths.length > 0) return paths;
  }
  if (event.isError === true) return null;
  if (!MUTATION_TOOLS.has(String(event.toolName ?? "").toLowerCase())) return null;
  const target = normalizeRelative(event.targetPath);
  return target ? [target] : [];
}

function pathAffected(readPath, mutationPaths) {
  if (!readPath || mutationPaths.length === 0) return true;
  return mutationPaths.some((mutationPath) => readPath === mutationPath
    || readPath === "."
    || mutationPath.startsWith(`${readPath}/`)
    || readPath.startsWith(`${mutationPath}/`));
}

export function readEfficiencyMetrics(events) {
  const taskByTurn = taskBindings(events), seenByPartition = new Map(), partitionTotals = new Map();
  let readCalls = 0, comparableReadCalls = 0, duplicateReads = 0;
  for (const event of events) {
    const mutationPaths = successfulMutationPaths(event);
    if (mutationPaths) {
      const mutationPartition = contextMetricPartition(event, taskByTurn);
      if (!mutationPartition) continue;
      const [sessionId, taskRunId] = mutationPartition.split("\0");
      const taskPrefix = `${sessionId}\0${taskRunId}\0`;
      for (const [partition, seen] of seenByPartition) {
        if (!partition.startsWith(taskPrefix)) continue;
        for (const [key, readPath] of seen) {
          if (pathAffected(readPath, mutationPaths)) seen.delete(key);
        }
      }
      continue;
    }
    if (event.event !== "tool_call" || !READ_TOOLS.has(event.toolName)) continue;
    readCalls += 1;
    const partition = contextMetricPartition(event, taskByTurn);
    const inputHash = typeof event.inputHash === "string" ? event.inputHash : "";
    if (!partition || !inputHash) continue;
    comparableReadCalls += 1;
    const seen = seenByPartition.get(partition) ?? new Map();
    const totals = partitionTotals.get(partition) ?? { calls: 0, duplicates: 0 };
    totals.calls += 1;
    // targetHash deliberately does not participate here. Two reads of one path
    // with different ranges or queries are different calls; only the exact
    // canonical input may be classified as a repeated read.
    const key = `${event.toolName}\0${inputHash}`;
    if (seen.has(key)) {
      duplicateReads += 1;
      totals.duplicates += 1;
    } else {
      seen.set(key, normalizeRelative(event.targetPath));
    }
    seenByPartition.set(partition, seen);
    partitionTotals.set(partition, totals);
  }
  const macroRates = [...partitionTotals.values()].map((item) => ratio(item.duplicates, item.calls));
  return {
    readCalls,
    comparableReadCalls,
    uncomparableReadCalls: Math.max(0, readCalls - comparableReadCalls),
    readEvidenceCoverage: evidenceCoverage(comparableReadCalls, readCalls),
    duplicateReads,
    duplicateReadRate: ratio(duplicateReads, comparableReadCalls),
    macroDuplicateReadRate: ratio(macroRates.reduce((sum, value) => sum + value, 0), macroRates.length)
  };
}

function injectionEquivalenceKey(item) {
  if (!item || typeof item !== "object" || typeof item.path !== "string" || typeof item.payloadHash !== "string"
    || typeof item.fileContentHash !== "string" || typeof item.representation !== "string") return "";
  return JSON.stringify([normalizeRelative(item.path), item.fileContentHash, item.payloadHash, item.representation,
    Array.isArray(item.ranges) ? item.ranges : [], Number.isInteger(item.generation) ? item.generation : 0]);
}

export function injectionEfficiencyMetrics(events) {
  const taskByTurn = taskBindings(events), seen = new Map(), partitionTotals = new Map();
  let receipts = 0, comparableReceipts = 0, occurrences = 0, comparable = 0, duplicates = 0, tokens = 0, comparableTokens = 0, duplicateTokens = 0;
  for (const event of events) {
    if (event.event !== "context_pack_injected") continue;
    receipts += 1;
    const partition = contextMetricPartition(event, taskByTurn);
    if (!Array.isArray(event.selectedItems)) continue;
    if (partition) comparableReceipts += 1;
    const partitionSeen = seen.get(partition) ?? new Set(), totals = partitionTotals.get(partition) ?? { occurrences: 0, duplicates: 0 };
    for (const item of event.selectedItems) {
      const estimatedTokens = Math.max(0, Number(item?.estimatedTokens ?? 0));
      occurrences += 1; tokens += estimatedTokens;
      const key = injectionEquivalenceKey(item);
      if (!partition || !key || event.rehydration === true || event.source === "compaction-rehydrate") continue;
      comparable += 1; comparableTokens += estimatedTokens; totals.occurrences += 1;
      if (partitionSeen.has(key)) {
        duplicates += 1; duplicateTokens += estimatedTokens; totals.duplicates += 1;
      } else partitionSeen.add(key);
    }
    seen.set(partition, partitionSeen); partitionTotals.set(partition, totals);
  }
  const macroRates = [...partitionTotals.values()].filter((item) => item.occurrences > 0).map((item) => ratio(item.duplicates, item.occurrences));
  return {
    injectionReceipts: receipts,
    comparableInjectionReceipts: comparableReceipts,
    injectionReceiptCoverage: evidenceCoverage(comparableReceipts, receipts),
    injectedPathOccurrences: occurrences,
    comparableInjectionItems: comparable,
    injectionItemCoverage: evidenceCoverage(comparable, occurrences),
    duplicateInjections: duplicates,
    duplicateInjectionRate: ratio(duplicates, comparable),
    duplicateInjectionOccurrenceRate: ratio(duplicates, occurrences),
    macroDuplicateInjectionRate: ratio(macroRates.reduce((sum, value) => sum + value, 0), macroRates.length),
    injectedPathTokens: tokens,
    comparableInjectionTokens: comparableTokens,
    duplicateInjectionTokens: duplicateTokens,
    duplicateInjectionTokenRate: ratio(duplicateTokens, comparableTokens),
    duplicateInjectionObservedTokenRate: ratio(duplicateTokens, tokens)
  };
}
