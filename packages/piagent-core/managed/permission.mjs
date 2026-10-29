// A company conversation's access, chosen by the member and kept with the
// conversation (runtime/policy/handoff-policy.mjs has both lists):
// "workspace-write" (Ask first) asks before every command that leaves the
// sandbox; "trusted-full-access" (Full access) asks only about the handoff and
// what is destructive (mustConfirm); "bypass" runs the work and asks only about
// the handoff (handoffReason: push, PR, publish, deploy, remote and cloud
// tools, uploads), where the team's Harness allows it
// (harness.configuration.bypass_mode, an administrator's switch in Studio).
// The sandbox itself stays: bypass removes questions, not the boundary.
import { handoffReason, mustConfirm } from '../runtime/policy/handoff-policy.mjs';

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
// Whether this conversation skips the questions Full access still asks
// (everything but the handoff).
export const asksOnlyHandoff = owner => effectivePermission(owner) === 'bypass';
export const broadAccess = owner => ['trusted-full-access', 'bypass'].includes(effectivePermission(owner));
// Why a command that leaves the sandbox must be asked about: the reason, or
// 'ask' in Ask first, or null to run it. Every mode asks about the handoff.
export const networkConfirmation = async (owner, command) => {
  const mode = effectivePermission(owner);
  if (mode === 'bypass') return handoffReason(command);
  if (mode === 'trusted-full-access') return mustConfirm(command);
  return 'ask';
};
