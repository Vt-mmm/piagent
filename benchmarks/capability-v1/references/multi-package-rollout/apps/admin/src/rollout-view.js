import { normalizeRollout } from "../../../packages/policy/src/rollout.js";

export function rolloutSummary(rollout) {
  const value = normalizeRollout(rollout);
  return `enabled=${value.enabled}; percentage=${value.percentage}; tenants=${value.tenants.join(",")}`;
}
