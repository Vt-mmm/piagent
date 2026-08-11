import * as rollout from "../../../packages/policy/src/rollout.js";

export const renderPolicySummary = (input) => {
  const { enabled, percentage, tenants } = rollout.normalizePolicy(input);
  return ["enabled=" + enabled, "percentage=" + percentage, "tenants=" + tenants.join(",")].join("; ");
};
