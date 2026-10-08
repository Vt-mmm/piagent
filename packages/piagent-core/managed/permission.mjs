// A company conversation's access, chosen by the member and kept with the
// conversation: "workspace-write" asks before every command that needs the
// internet; "trusted-full-access" (Bypass) asks only for what must be
// confirmed (runtime/policy/bypass-policy.mjs).
import { mustConfirm } from '../runtime/policy/bypass-policy.mjs';

export const PERMISSIONS = ['workspace-write', 'trusted-full-access'];
const ENTRY = 'agent-watch-permission';

export function restorePermission(manager) {
  const chosen = manager.getEntries().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data?.mode;
  return PERMISSIONS.includes(chosen) ? chosen : 'workspace-write';
}
export function permissionSetter(owner, manager) {
  return mode => {
    if (!PERMISSIONS.includes(mode)) throw Error('managed-permission-unavailable');
    manager.appendCustomEntry(ENTRY, { mode, at: new Date().toISOString() }); owner.permission = mode;
  };
}
// Why a network command must still be asked about: null runs it in Bypass,
// 'ask' when the member asks first.
export const networkConfirmation = (owner, command) => owner.permission === 'trusted-full-access' ? mustConfirm(command) : 'ask';
