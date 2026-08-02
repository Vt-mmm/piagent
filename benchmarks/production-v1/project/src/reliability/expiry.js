export function isExpired(expiresAt, now = Date.now()) {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return false;
  return Number(now) > timestamp;
}
