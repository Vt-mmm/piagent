import { normalizePolicy } from "../../../packages/policy/src/rollout.js";

export function renderPolicySummary(policy) {
  const value = normalizePolicy(policy);
  return `enabled=${value.enabled}; percentage=${value.percentage}; tenants=${value.tenants.join(",")}`;
}
