// A helper's working name (what the main agent calls it) and its Harness role
// (Studio's grant). No imports: ledger.mjs and copies.mjs need these names
// without loading helper-roles.mjs, which imports workflow.mjs (a cycle).
export const ROLE_NAMES = Object.freeze({ explore: 'scout', scout: 'research', advisor: 'advisor', general: 'general', review: 'review' });
export const HELPER_ROLES = Object.freeze(Object.values(ROLE_NAMES));
export const callName = role => Object.keys(ROLE_NAMES).find(name => ROLE_NAMES[name] === role) ?? role;
