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

export function contextMetricPartition(event, taskByTurn = new Map()) {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  const taskRunId = typeof event.taskRunId === "string" ? event.taskRunId : taskByTurn.get(`${sessionId}\0${turnId}`) ?? "";
  if (!sessionId || !taskRunId) return "";
  return [sessionId, taskRunId, event.model ?? "unknown", event.thinkingLevel ?? "unknown"].join("\0");
}

export function prefixEfficiencyMetrics(events) {
  const taskByTurn = taskBindings(events), partitions = new Map();
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
    comparablePrefixPrompts: prompts,
    prefixTransitions: transitions,
    prefixChanges: changes,
    prefixChangeRate: ratio(changes, transitions),
    macroPrefixChangeRate: ratio(rates.reduce((sum, value) => sum + value, 0), rates.length),
    averageTurnsPerPrefixEpoch: ratio(prompts, partitions.size + changes),
    macroTurnsPerPrefixEpoch: ratio(turnsPerEpoch.reduce((sum, value) => sum + value, 0), turnsPerEpoch.length)
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
  let occurrences = 0, comparable = 0, duplicates = 0, tokens = 0, duplicateTokens = 0;
  for (const event of events) {
    if (event.event !== "context_pack_injected") continue;
    const partition = contextMetricPartition(event, taskByTurn);
    if (!partition || !Array.isArray(event.selectedItems)) continue;
    const partitionSeen = seen.get(partition) ?? new Set(), totals = partitionTotals.get(partition) ?? { occurrences: 0, duplicates: 0 };
    for (const item of event.selectedItems) {
      const estimatedTokens = Math.max(0, Number(item?.estimatedTokens ?? 0));
      occurrences += 1; tokens += estimatedTokens; totals.occurrences += 1;
      const key = injectionEquivalenceKey(item);
      if (!key || event.rehydration === true || event.source === "compaction-rehydrate") continue;
      comparable += 1;
      if (partitionSeen.has(key)) {
        duplicates += 1; duplicateTokens += estimatedTokens; totals.duplicates += 1;
      } else partitionSeen.add(key);
    }
    seen.set(partition, partitionSeen); partitionTotals.set(partition, totals);
  }
  const macroRates = [...partitionTotals.values()].filter((item) => item.occurrences > 0).map((item) => ratio(item.duplicates, item.occurrences));
  return {
    injectedPathOccurrences: occurrences,
    comparableInjectionItems: comparable,
    duplicateInjections: duplicates,
    duplicateInjectionRate: ratio(duplicates, occurrences),
    macroDuplicateInjectionRate: ratio(macroRates.reduce((sum, value) => sum + value, 0), macroRates.length),
    injectedPathTokens: tokens,
    duplicateInjectionTokens: duplicateTokens,
    duplicateInjectionTokenRate: ratio(duplicateTokens, tokens)
  };
}
