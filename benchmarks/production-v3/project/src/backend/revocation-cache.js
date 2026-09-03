export function isCachedAccessUsable(entry, request) {
  return entry?.userId === request?.userId && Number(request?.now) <= Number(entry?.expiresAt);
}
