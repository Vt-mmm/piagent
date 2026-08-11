import { isEnabled, normalizePolicy } from "../../policy/src/rollout.js";

export function evaluateFeature(policy, subject) {
  const normalized = normalizePolicy(policy);
  if (!normalized.enabled) return { allowed: false, reason: "disabled" };
  if (!subject) return { allowed: false, reason: "not-eligible" };
  const allowed = isEnabled(normalized, subject);
  if (normalized.tenants.includes(typeof subject.tenantId === "string" ? subject.tenantId.trim() : "")) return { allowed: true, reason: "tenant-override" };
  return { allowed, reason: allowed ? "percentage" : "not-eligible" };
}
