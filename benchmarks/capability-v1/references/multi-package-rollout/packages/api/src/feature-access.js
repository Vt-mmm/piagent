import { isFeatureEnabled, normalizeRollout } from "../../policy/src/rollout.js";

export function featureAccess(rollout, request) {
  const normalized = normalizeRollout(rollout);
  if (!normalized.enabled) return { allowed: false, reason: "disabled" };
  if (request && typeof request.tenantId === "string" && normalized.tenants.includes(request.tenantId)) return { allowed: true, reason: "tenant-override" };
  const allowed = isFeatureEnabled(normalized, request);
  return { allowed, reason: allowed ? "percentage" : "not-eligible" };
}
