import * as policyEngine from "../../policy/src/rollout.js";

export function evaluateFeature(input, subject) {
  const policy = policyEngine.normalizePolicy(input);
  if (!policy.enabled) return { allowed: false, reason: "disabled" };
  if (subject == null) return { allowed: false, reason: "not-eligible" };
  const tenant = typeof subject.tenantId === "string" ? subject.tenantId.trim() : "";
  if (policy.tenants.indexOf(tenant) !== -1) {
    policyEngine.isEnabled(policy, subject);
    return { allowed: true, reason: "tenant-override" };
  }
  const allowed = policyEngine.isEnabled(policy, subject);
  return { allowed, reason: allowed ? "percentage" : "not-eligible" };
}
