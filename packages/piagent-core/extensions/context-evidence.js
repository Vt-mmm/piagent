const PLANNED_CONTEXT_REASON = /^criterion-[a-z0-9_-]+(?:\s|$)/i;
const RUNTIME_OBSERVED_READ_REASONS = new Set([
  "Runtime observed successful source read.",
  "Runtime observed successful document read."
]);
const RUNTIME_CONFIRMED_DELIVERY_REASONS = new Set([
  "Runtime confirmed delivery of a bounded Context Engine navigation pack.",
  "Runtime confirmed delivery of criterion-selected context.",
  "Runtime confirmed delivery of a /context pack message.",
  "Runtime confirmed delivery of an explicit Context Engine tool pack."
]);

export function isPlannedContextEntry(entry) {
  return Boolean(
    entry
    && typeof entry.path === "string"
    && typeof entry.reason === "string"
    && PLANNED_CONTEXT_REASON.test(entry.reason.trim())
  );
}

export function isRuntimeOwnedContextEvidenceEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  return RUNTIME_OBSERVED_READ_REASONS.has(reason) || RUNTIME_CONFIRMED_DELIVERY_REASONS.has(reason);
}

export function isDurableContextEvidenceEntry(entry) {
  return Boolean(
    entry
    && typeof entry.path === "string"
    && entry.path.trim().length > 0
    && isRuntimeOwnedContextEvidenceEntry(entry)
  );
}

export function durableContextEvidenceEntries(taskOrEntries) {
  const entries = Array.isArray(taskOrEntries)
    ? taskOrEntries
    : Array.isArray(taskOrEntries?.contextManifest)
      ? taskOrEntries.contextManifest
      : [];
  return entries.filter(isDurableContextEvidenceEntry);
}

export function hasDurableContextEvidence(taskOrEntries) {
  return durableContextEvidenceEntries(taskOrEntries).length > 0;
}
