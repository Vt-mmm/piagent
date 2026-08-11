import { isFeatureEnabled } from "../../policy/src/rollout.js";

export function featureAccess(rollout, request) {
  return { allowed: isFeatureEnabled(rollout, request), reason: "default" };
}
