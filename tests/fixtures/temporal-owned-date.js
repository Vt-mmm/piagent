function expiration(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) throw new TypeError("Invalid date");
    return timestamp;
  }
  if (typeof value !== "string") throw new TypeError("Invalid date");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError("Invalid date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? "" : match[7];
  const milliseconds = Number((fraction + "000").slice(0, 3));
  const zone = match[8];
  const offset = zone === "Z" ? 0 : Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(milliseconds)
    || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) throw new TypeError("Invalid date");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Math.trunc(milliseconds));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new TypeError("Invalid date");
  const timestamp = date.getTime() - (zone[0] === "+" ? offset : -offset) * 60_000;
  if (!Number.isFinite(timestamp)) throw new TypeError("Invalid date");
  return timestamp;
}
function current(value) {
  if (value instanceof Date) return expiration(value);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Invalid date");
  return value;
}
export function isExpired(expiresAt, now) {
  const end = expiration(expiresAt);
  const start = arguments.length === 1 ? Date.now() : current(now);
  return start >= end;
}
