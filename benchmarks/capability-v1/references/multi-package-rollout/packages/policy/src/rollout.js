function normalizedPercentage(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new TypeError("percentage must be an integer from 0 through 100");
  return value;
}

function normalizedTenants(value) {
  if (!Array.isArray(value)) throw new TypeError("tenants must be an array");
  const result = [];
  const seen = new Set();
  for (const tenant of value) {
    if (typeof tenant !== "string" || !tenant.trim()) throw new TypeError("tenant must be non-empty");
    const normalized = tenant.trim();
    if (!seen.has(normalized)) { seen.add(normalized); result.push(normalized); }
  }
  return result;
}

export function normalizeRollout(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("rollout must be an object");
  return { enabled: Boolean(input.enabled), percentage: normalizedPercentage(input.percentage), tenants: normalizedTenants(input.tenants) };
}

export function isFeatureEnabled(rollout, subject) {
  if (!rollout?.enabled || !subject) return false;
  const normalized = normalizeRollout(rollout);
  if (typeof subject.tenantId === "string" && normalized.tenants.includes(subject.tenantId)) return true;
  if (!Number.isSafeInteger(subject.bucket) || subject.bucket < 0 || subject.bucket > 99) throw new TypeError("bucket must be an integer from 0 through 99");
  return subject.bucket < normalized.percentage;
}
