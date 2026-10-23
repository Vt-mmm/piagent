// A company conversation's access, chosen by the member and kept with the
// conversation: "workspace-write" asks before every command that needs the
// internet; "trusted-full-access" (Full access) asks only for what must be
// confirmed (runtime/policy/bypass-policy.mjs); "bypass" asks nothing, as
// Codex's bypass mode, where the team's Harness allows it
// (harness.configuration.bypass_mode, an administrator's switch in Studio).
// The sandbox itself stays: bypass removes the questions, not the boundary.
import { mustConfirm } from '../runtime/policy/bypass-policy.mjs';

export const PERMISSIONS = ['workspace-write', 'trusted-full-access', 'bypass'];
const ENTRY = 'agent-watch-permission';

// Only an explicit yes from Studio: an Agent Watch that does not carry the
// field, or a Harness an administrator switched off, gives no bypass.
export const bypassAllowed = manifest => manifest?.harness?.configuration?.bypass_mode === true;
// What applies now: a conversation left in bypass after the administrator
// switched it off falls back to Full access.
export const effectivePermission = owner => owner.permission === 'bypass' && !bypassAllowed(owner.manifest) ? 'trusted-full-access' : owner.permission;

export function restorePermission(manager) {
  const chosen = manager.getEntries().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data?.mode;
  return PERMISSIONS.includes(chosen) ? chosen : 'workspace-write';
}
export function permissionSetter(owner, manager) {
  return mode => {
    if (!PERMISSIONS.includes(mode)) throw Error('managed-permission-unavailable');
    if (mode === 'bypass' && !bypassAllowed(owner.manifest)) throw Error('managed-bypass-unavailable');
    manager.appendCustomEntry(ENTRY, { mode, at: new Date().toISOString() }); owner.permission = mode;
  };
}
// The conversation records whether its Harness allows Bypass, so the
// dashboard offers it (or not) without the runtime.
const ALLOWANCE = 'agent-watch-bypass';
export function recordBypass(owner, manager) {
  const allowed = bypassAllowed(owner.manifest);
  const last = manager.getEntries().filter(e => e.type === 'custom' && e.customType === ALLOWANCE).at(-1)?.data;
  if ((last?.allowed === true) !== allowed) manager.appendCustomEntry(ALLOWANCE, { allowed, at: new Date().toISOString() });
}
// Whether this conversation may skip the questions Full access still asks.
export const asksNothing = owner => effectivePermission(owner) === 'bypass';
export const broadAccess = owner => ['trusted-full-access', 'bypass'].includes(effectivePermission(owner));
// Why a network command must still be asked about: null runs it in Full
// access or Bypass, 'ask' when the member asks first.
export const networkConfirmation = async (owner, command) => asksNothing(owner) ? null
  : effectivePermission(owner) === 'trusted-full-access' ? mustConfirm(command) : 'ask';
