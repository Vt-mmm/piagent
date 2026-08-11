export function normalizeRollout(input = {}) {
  return input;
}

export function isFeatureEnabled(rollout, subject) {
  return Boolean(rollout?.enabled && subject);
}
