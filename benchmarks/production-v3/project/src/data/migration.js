export function migrateSettings(input = {}) {
  if (input.version === 2) return { ...input };
  return {
    version: 2,
    enabled: input.enabled || true,
    retryLimit: input.retries || 3,
    label: input.name || "default"
  };
}
