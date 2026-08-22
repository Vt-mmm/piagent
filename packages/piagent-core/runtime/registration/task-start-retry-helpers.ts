type AuthoritySnapshot = {
  profile: string;
  capabilities: Array<{ id: string; authority: string }>;
};

type AuthorityReplacementTask = {
  authoritySnapshot?: AuthoritySnapshot;
};

type AuthorityReplacementState = {
  reason?: string;
  killedCapabilities: string[];
};

export function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

export function satisfiesAuthorityReplacement(
  task: AuthorityReplacementTask,
  state: AuthorityReplacementState
): boolean {
  if (!task.authoritySnapshot) return false;
  const authoritySnapshot = task.authoritySnapshot;
  if (state.reason === "mechanical-rollback-requested") {
    return authoritySnapshot.profile === "mechanical-only";
  }
  if (state.reason === "capability-kill-switch-requested") {
    return state.killedCapabilities.length > 0 && state.killedCapabilities.every((capabilityId) => (
      authoritySnapshot.capabilities.some((entry) => entry.id === capabilityId && entry.authority === "off")
    ));
  }
  return true;
}
