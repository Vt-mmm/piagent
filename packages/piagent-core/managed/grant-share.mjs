// Every renew replaces the role's token. Searches of one role running side
// by side, and a delegate refreshing main beside main's search, share one
// renew, so none voids a sibling's token before Studio admits its request.
// The share lasts while one of them still runs, at most a minute (the lease
// is two). `owner` is the ManagedSession.
export function shareGrant(owner, role) {
  owner.sharedGrants ??= new Map();
  const shared = owner.sharedGrants.get(role);
  if (shared && Date.now() - shared.at < 60_000) { shared.users++; return shared; }
  const entry = { at: Date.now(), users: 1, grant: owner.broker.request('renew', slotArgs(role)) };
  entry.grant.catch(() => { if (owner.sharedGrants.get(role) === entry) owner.sharedGrants.delete(role); });
  owner.sharedGrants.set(role, entry);
  return entry;
}

export function releaseGrant(owner, role, entry) {
  if (--entry.users <= 0 && owner.sharedGrants?.get(role) === entry) owner.sharedGrants.delete(role);
}

// A helper the member asked for beside another of its role holds a grant of
// its own: its key is role#slot (slot 2 or 3), the broker's {role, slot}.
export const baseRole = key => String(key).split('#')[0];
export function slotArgs(key) {
  const [role, slot] = String(key).split('#');
  return slot ? { role, slot: Number(slot) } : { role };
}
