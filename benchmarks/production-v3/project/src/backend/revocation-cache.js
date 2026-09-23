/**
 * Public input contract (required field names):
 * entry: { tenantId, userId, capability, permissionRevision, evaluatedAt, expiresAt }
 * request: { tenantId, userId, capability, currentPermissionRevision, now, revokedAt }
 * Both inputs are non-null, non-array objects. Identifiers are non-empty strings;
 * times and revisions are finite integers. revokedAt is null or a finite integer.
 * All identity fields and revisions must match; evaluatedAt <= now < expiresAt;
 * revokedAt <= now denies access. Malformed inputs throw TypeError, without mutation.
 */
export function isCachedAccessUsable(entry, request) {
  return entry?.userId === request?.userId && Number(request?.now) <= Number(entry?.expiresAt);
}
