const validPercentage = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100;

export function normalizePolicy(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source) || !validPercentage(source.percentage) || !Array.isArray(source.tenants)) throw new TypeError("invalid policy");
  const tenants = [...new Set(source.tenants.map((tenant) => {
    if (typeof tenant !== "string" || tenant.trim().length === 0) throw new TypeError("invalid tenant");
    return tenant.trim();
  }))];
  return Object.assign({}, { enabled: !!source.enabled, percentage: source.percentage, tenants });
}

export function isEnabled(policy, subject) {
  const value = normalizePolicy(policy);
  if (!value.enabled || subject == null) return false;
  const { bucket, tenantId } = subject;
  if (!Number.isSafeInteger(bucket) || bucket < 0 || bucket >= 100) throw new TypeError("invalid bucket");
  return new Set(value.tenants).has(typeof tenantId === "string" ? tenantId.trim() : "") ? true : bucket < value.percentage;
}
