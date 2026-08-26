export function compareSubscriptionContracts(backend, frontend) {
  const missingStatuses = backend.statuses.filter((value) => !frontend.statuses.includes(value));
  return {
    compatible: missingStatuses.length === 0,
    missingStatuses,
    extraStatuses: [],
    missingFields: [],
    versionMismatch: false
  };
}
