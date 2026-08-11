export function normalizePolicy(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new TypeError("policy must be an object");
  if (!Number.isSafeInteger(input.percentage) || input.percentage < 0 || input.percentage > 100) throw new TypeError("invalid percentage");
  if (!Array.isArray(input.tenants)) throw new TypeError("tenants must be an array");
  const tenants = [];
  for (const tenant of input.tenants) {
    if (typeof tenant !== "string" || !tenant.trim()) throw new TypeError("invalid tenant");
    const value = tenant.trim();
    if (!tenants.includes(value)) tenants.push(value);
  }
  return { enabled: Boolean(input.enabled), percentage: input.percentage, tenants };
}

export function isEnabled(policy, subject) {
  const normalized = normalizePolicy(policy);
  if (!normalized.enabled || !subject) return false;
  if (!Number.isSafeInteger(subject.bucket) || subject.bucket < 0 || subject.bucket > 99) throw new TypeError("invalid bucket");
  const tenantId = typeof subject.tenantId === "string" ? subject.tenantId.trim() : "";
  return normalized.tenants.includes(tenantId) || subject.bucket < normalized.percentage;
}
